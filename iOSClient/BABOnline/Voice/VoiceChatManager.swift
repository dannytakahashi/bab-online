import Foundation
import AVFoundation
import Combine
// WebRTC's ObjC types aren't annotated Sendable; its objects are thread-safe.
@preconcurrency import WebRTC

/// Manages WebRTC peer-to-peer voice chat.
/// Full-mesh topology: one RTCPeerConnection per human peer.
/// Server only relays signaling messages (SDP offers/answers, ICE candidates).
///
/// ICE servers (1.2, V1_REMOVALS "iOS TURN"): asked from the server
/// (`IceServerStore`: getVoiceIceServers -> voiceIceServers, Cloudflare TURN
/// credentials or the public STUN pair) at every voice start and awaited
/// before the first peer connection, at most 4 s, else
/// STUN. A TURN answer is reused for the session and refreshed 30 min before
/// it expires (`setConfiguration` on the open connections); a STUN answer is
/// asked again on every voice start and restart. A connection that fails (or
/// is not up within 20 s) gets ONE restart (`VoiceRecovery`: the lower socket
/// id offers again, the other waits 15 s), then the peer shows "voice
/// unavailable". Credentials are never logged or persisted.
///
/// All state lives on the main actor. WebRTC calls its completion handlers and
/// delegate methods on its own signaling thread, so every such callback hops back
/// to main (`DispatchQueue.main.async`) before touching manager state.
@MainActor
final class VoiceChatManager: ObservableObject {
    static let shared = VoiceChatManager()

    // MARK: - Published State

    @Published var isActive = false
    /// Every voice session starts muted (owner 2026-11-18: "by default the mic should be muted
    /// and you can click to unmute / activate mic"); the first unmute asks for the microphone.
    @Published var isSelfMuted = true
    /// The microphone was refused: voice listens only (headphones; a tap asks again).
    @Published var micPermissionDenied = false
    @Published var isSelfSpeaking = false
    @Published var speakingPeers = Set<String>()  // socket IDs currently speaking
    @Published var peerInfos: [String: PeerInfo] = [:]  // socketId → info

    /// Combine subject for SpriteKit to subscribe to speaking changes.
    /// Emits (socketId, isSpeaking) — socketId is "self" for local user.
    let speakingChangedSubject = PassthroughSubject<(String, Bool), Never>()

    // MARK: - Peer Info

    struct PeerInfo {
        let username: String
        var isMuted: Bool = false
        /// The connection failed after its one restart (a later offer from the peer retries).
        var isUnavailable: Bool = false
        /// My volume for this player (`VoiceVolume`: 0...2, 1 = as sent).
        var volume: Double = VoiceVolume.normal
    }

    /// The volumes set in the voice panel, by username: a player who comes back on a new
    /// socket (a reconnect, the next game) keeps theirs while the app runs.
    private var savedVolumes: [String: Double] = [:]
    /// The per-person mutes, by username (1.2.2 (12)): kept across any re-created call (a
    /// restart, a reconnect on a new socket) while the app runs.
    private var savedMutes: [String: Bool] = [:]

    // MARK: - Muted start (build 16; docs/claude/voice.md "Spectator voice", iOS client)

    /// Listening only: the microphone was refused (headphones; a tap asks again). Before the
    /// first unmute the mic is not allowed yet either, but that is muted, not listen-only.
    var isListenOnly: Bool { micPermissionDenied }
    /// This session's first unmute got the microphone (asked again in each session: iOS
    /// answers at once, with no prompt, once the person has answered it).
    private var micGranted = false
    /// The casual game's voice settings for this socket (voiceSettings), nil elsewhere. Only
    /// the role is acted on (spectators always may talk since 2026-11-18).
    @Published var settings: VoiceSettings?
    /// The casual game whose voice room this socket was told of (any voiceSettings for it).
    /// Only such a table admits spectators into voice (a lobby-born casual game,
    /// server/voice/gameVoice.js), so only there do its watchers count as company
    /// (`VoiceCompany.table(_:me:spectators:)`): a tournament table's watchers can never be a
    /// peer. Kept through a shutdown or suspend (unlike `settings`); the table compares it
    /// with its own gameId.
    @Published var casualVoiceGameId: String?
    /// The first unmute's microphone prompt is up.
    @Published private(set) var micRequestInFlight = false
    /// The unmute that asked for the mic still wants to talk when the prompt answers (a mute
    /// meanwhile wins).
    private var unmuteAfterPrompt = false

    /// What the manager talks to outside itself, replaced by the unit tests (two managers
    /// negotiating real WebRTC offers in-process, a permission prompt held open). The tests'
    /// hooks never touch AVAudioSession (`BABOnlineTests/Support/SilentVoice.swift`).
    struct Hooks {
        /// Asked on the first unmute only, never at a voice start.
        var requestRecordPermission: @MainActor () async -> Bool
        var configureAudioSession: @MainActor () throws -> Void
        /// shutdown(): drop our activation (WebRTC drops its own when its audio unit stops; the
        /// mic indicator goes; the category is kept).
        var deactivateAudioSession: @MainActor () -> Void
        var sendOffer: @MainActor (_ target: String, _ offer: RTCSessionDescription, _ username: String?) -> Void
        var sendAnswer: @MainActor (_ target: String, _ answer: RTCSessionDescription) -> Void
        /// An info toast (a refused microphone).
        var notify: @MainActor (_ message: String) -> Void = { _ in }

        static let live = Hooks(
            requestRecordPermission: { await AVAudioSession.sharedInstance().requestRecordPermission() },
            // VoiceAudioSession: through RTCAudioSession, loudspeaker by default (WebRTC's own
            // configuration carries the same options), with a route safety net while active
            configureAudioSession: { try VoiceAudioSession.shared.activate() },
            deactivateAudioSession: { VoiceAudioSession.shared.deactivate() },
            sendOffer: { VoiceEmitter.sendOffer(targetSocketId: $0, offer: $1, username: $2) },
            sendAnswer: { VoiceEmitter.sendAnswer(targetSocketId: $0, answer: $1) },
            notify: { SocketService.shared.serverError = ServerErrorNotice(message: $0, kind: .info) })
    }
    private let hooks: Hooks

    // MARK: - Private State

    /// The RTCConfiguration for `ice` (nil: the STUN pair).
    nonisolated static func rtcConfiguration(_ ice: IceConfig?) -> RTCConfiguration {
        let config = RTCConfiguration()
        config.iceServers = (ice?.servers ?? IcePolicy.stunServers).map {
            RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential)
        }
        config.sdpSemantics = .unifiedPlan
        return config
    }

    /// The session's ICE servers (asked from the server; never persisted).
    let iceStore: IceServerStore
    private var recovery = VoiceRecovery()
    private var connectTimers: [String: DispatchWorkItem] = [:]
    private var restartTimers: [String: DispatchWorkItem] = [:]
    private var iceRefresh: DispatchWorkItem?

    private static let speakingThreshold: Float = 0.005
    private static let speakingPollInterval: TimeInterval = 0.1
    private static let speakingHoldMs: TimeInterval = 0.4

    private let factory: RTCPeerConnectionFactory

    /// nil (the app): WebRTC's own audio device module (the VoiceProcessingIO audio unit on
    /// RTCAudioSession). The unit tests pass a silent `RTCAudioDevice`: under XCTest the real
    /// unit initialising against the simulator's audio HAL on a busy Mac aborted the whole
    /// run ("Initialize: RPC timeout. Apparently deadlocked."; docs/claude/voice.md, Tests).
    private static func makeFactory(audioDevice: RTCAudioDevice?) -> RTCPeerConnectionFactory {
        RTCInitializeSSL()
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        guard let audioDevice else {
            // Before the default module exists: its audio unit applies WebRTC's configuration
            // when a call starts playout (without this: no .defaultToSpeaker, the earpiece)
            VoiceAudioSession.installWebRTCConfiguration()
            return RTCPeerConnectionFactory(encoderFactory: encoderFactory, decoderFactory: decoderFactory)
        }
        return RTCPeerConnectionFactory(encoderFactory: encoderFactory, decoderFactory: decoderFactory, audioDevice: audioDevice)
    }

    private var localAudioTrack: RTCAudioTrack?
    private var peers: [String: PeerState] = [:]  // socketId → connection state
    private var localUsername: String?

    // Speaking detection
    private var speakingTimer: Timer?
    private var speakingLastActive: [String: Date] = [:]  // socketId|"self" → last above-threshold time
    private var speakingStates: [String: Bool] = [:]

    // Buffered events (arrive before init completes, or while voice is not running: no other
    // human was here yet, VoiceGate)
    private var pendingPeers: [(socketId: String, username: String)] = []
    private var pendingOffers: [(fromSocketId: String, offer: RTCSessionDescription, username: String)] = []
    /// The trickled ICE candidates of a buffered offer, by peer (at most
    /// `maxPendingCandidates` each), added right after that offer when voice starts: a
    /// newcomer's offer that beats our start connects with its candidates, not only by
    /// peer-reflexive ones or the 20 s restart.
    private var pendingCandidates: [String: [RTCIceCandidate]] = [:]
    static let maxPendingCandidates = 100

    // Background handling: the app is in the background (the mic stays off, also for a
    // track made then: a voiceSettings during the ~30 s keep-alive). App state, not the
    // session's, so shutdown() leaves it.
    private(set) var isBackgrounded = false

    private struct PeerState {
        let connection: RTCPeerConnection
        let username: String
        var remoteTrack: RTCAudioTrack?
    }

    // Constraints
    private let mediaConstraints = RTCMediaConstraints(
        mandatoryConstraints: nil,
        optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
    )

    private let offerAnswerConstraints = RTCMediaConstraints(
        mandatoryConstraints: [
            "OfferToReceiveAudio": "true",
            "OfferToReceiveVideo": "false"
        ],
        optionalConstraints: nil
    )

    /// Bumped by every shutdown(), so a start that was in flight does not finish after it.
    private var startGeneration = 0
    /// Between the mic being ready and the ICE servers answering: peers and offers are buffered.
    private var awaitingIce = false

    /// No voice alone (owner 2026-11-19; VoiceCompany.swift): the screens say they want voice
    /// (`ensureStarted`) and who is here (`setCompany`); the gate starts the session only while
    /// another human is here and suspends it `VoiceCompany.grace` after the last one left.
    private(set) var gate: VoiceGate!
    /// The `startGeneration` of a gate start still on its way through `initialize` (a Task):
    /// not started twice. A shutdown or suspend bumps the generation, so that start no longer
    /// counts (it gives up) and the next arrival starts afresh.
    private var pendingStart: Int?
    private var startPending: Bool { pendingStart == startGeneration }
    /// The app's manager (WebRTC's own audio module) never starts under XCTest; the tests'
    /// silent managers do.
    private let startsUnderXCTest: Bool

    /// `hooks` / `iceStore` / `audioDevice`: the unit tests' (the app has one manager,
    /// `shared`, with the defaults). `after`: the gate's grace timer (tests run it by hand).
    init(hooks: Hooks = .live, iceStore: IceServerStore? = nil, audioDevice: RTCAudioDevice? = nil,
         after: ((TimeInterval, @escaping @MainActor () -> Void) -> Void)? = nil) {
        self.hooks = hooks
        self.factory = Self.makeFactory(audioDevice: audioDevice)
        self.iceStore = iceStore ?? IceServerStore(emit: { VoiceEmitter.getIceServers($0) })
        self.startsUnderXCTest = audioDevice != nil
        self.iceStore.onChange = { [weak self] config in self?.applyIce(config) }
        let isRunning: @MainActor () -> Bool = { [weak self] in self.map { $0.isActive || $0.startPending } ?? false }
        let start: @MainActor () -> Void = { [weak self] in self?.startFromGate() }
        let suspend: @MainActor () -> Void = { [weak self] in self?.suspend() }
        if let after {
            gate = VoiceGate(isRunning: isRunning, start: start, suspend: suspend, after: after)
        } else {
            gate = VoiceGate(isRunning: isRunning, start: start, suspend: suspend)
        }
    }

    // MARK: - Lifecycle

    /// Start voice chat, muted, with no microphone prompt (owner 2026-11-18). The audio session
    /// and the calls play everyone else at once. Every call carries the local audio track from
    /// its first offer or answer, DISABLED (WebRTC sends silence for a disabled track, the mute
    /// muted players have always used), so the first unmute (`unmute()`) only asks for the mic
    /// and enables the track: no new offer, nothing re-created.
    ///
    /// Never a sending transceiver without a track: WebRTC starts an audio send stream with no
    /// source and feeds it the audio device's capture unmuted (seen 2026-11-18 on the simulator:
    /// a web peer's inbound audio energy rose while this side showed muted with no track), and
    /// never the old recvonly listen-only calls, which would need a re-offer at the unmute.
    func initialize() async throws {
        guard !isActive, !Self.voiceDisabled else { return }
        let generation = startGeneration

        // ICE servers (re-asked on every start unless TURN is reusable)
        let username = SocketService.shared.authState?.username
        let iceReady = Task { @MainActor in await self.iceStore.ensure(username: username) }

        // Configure audio session (.playAndRecord before any mic: WebRTC's one VoIP audio unit
        // plays and records together)
        try hooks.configureAudioSession()

        localUsername = SocketService.shared.authState?.username

        isActive = true
        // a new session starts muted, whatever the last one did (the same session carries its
        // choice on: lobby into its game, an extra into watching, play again's return)
        isSelfMuted = true
        micPermissionDenied = false
        micGranted = false
        unmuteAfterPrompt = false
        // the track every call carries, disabled until an unmute the microphone was allowed for
        createLocalTrack()

        // Start speaking detection (main run loop, since we're on the main actor)
        startSpeakingDetection()

        // The first peer connection waits for the ICE servers (<= IcePolicy.fetchTimeout, else STUN)
        awaitingIce = true
        let ice = await iceReady.value
        awaitingIce = false
        guard isActive, generation == startGeneration else { return }
        if iceRefresh == nil { applyIce(ice) }  // a reused TURN answer: arm its refresh

        // Flush buffered events
        flushPendingEvents()

        print("[Voice] Initialized (muted), username: \(localUsername ?? "nil")")
    }

    /// Made at the start, disabled: an allowed unmute enables it. Making it asks for nothing.
    private func createLocalTrack() {
        let audioSource = factory.audioSource(with: mediaConstraints)
        let audioTrack = factory.audioTrack(with: audioSource, trackId: "audio0")
        audioTrack.isEnabled = false
        localAudioTrack = audioTrack
    }

    /// Every live audio transceiver of a call (one per call: ours, or the offer's).
    private static func audioTransceivers(_ pc: RTCPeerConnection) -> [RTCRtpTransceiver] {
        pc.transceivers.filter { $0.mediaType == .audio && !$0.isStopped }
    }

    /// This screen wants voice (idempotent): the game lobby, game entry as a seat, rejoin
    /// (21.14), a voice spectator. It starts while another human is here (`setCompany`; owner
    /// 2026-11-19, no voice alone), else when one arrives. Peers and offers that arrive before
    /// it runs are buffered and connected once active. The app's manager never starts under XCTest.
    func ensureStarted() {
        gate.want()
    }

    /// The screen on show says who is here (VoiceCompany.lobby / .table; nil: not known yet).
    func setCompany(_ company: Bool?, from source: VoiceGate.Source) {
        gate.setCompany(company, from: source)
    }

    /// That screen went away.
    func clearCompany(from source: VoiceGate.Source) {
        gate.clearCompany(from: source)
    }

    /// The gate's start: muted, like every start.
    private func startFromGate() {
        guard !isActive, !startPending, !Self.voiceDisabled else { return }
        if !startsUnderXCTest, ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { return }
        let generation = startGeneration
        pendingStart = generation
        Task { @MainActor in
            defer { if self.pendingStart == generation { self.pendingStart = nil } }
            // a shutdown or suspend before this ran: no start
            guard self.startGeneration == generation else { return }
            do {
                try await self.initialize()
            } catch {
                print("[Voice] Start failed: \(error.localizedDescription)")
            }
        }
    }

    /// No microphone (no permission prompt, no audio session) in Debug fixture
    /// mode (`-uiFixture`, item 26) or in an Xcode preview, on every start path
    /// (game entry, rejoin, the game and tournament lobbies).
    static var voiceDisabled: Bool {
        #if DEBUG
        return UIFixture.isActive || ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1"
        #else
        return false
        #endif
    }

    /// Shut down all voice connections and clean up: the screen no longer wants voice.
    func shutdown() {
        gate.release()
        teardown(keepSettings: false)
    }

    /// The last other human left and the grace ran out (VoiceGate): the session ends (no audio
    /// session, no calls), still wanted, and this table's voice settings stay, so the next
    /// arrival starts it again (muted, as every start).
    func suspend() {
        print("[Voice] Alone: voice stops")
        teardown(keepSettings: true)
    }

    private func teardown(keepSettings: Bool) {
        startGeneration &+= 1  // an initialize() still awaiting the permission prompt gives up
        // buffered signals and the game's settings go whether or not voice ever started
        // (before 1.2.2 (12) an inactive shutdown returned first and the buffers grew forever)
        pendingPeers.removeAll()
        pendingOffers.removeAll()
        pendingCandidates.removeAll()
        micRequestInFlight = false
        unmuteAfterPrompt = false
        micGranted = false
        if !keepSettings { settings = nil }
        guard isActive else { return }
        isActive = false
        awaitingIce = false

        // Stop speaking detection
        speakingTimer?.invalidate()
        speakingTimer = nil

        // Close all peer connections
        for (socketId, peer) in peers {
            peer.connection.close()
            print("[Voice] Closed peer: \(socketId)")
        }
        peers.removeAll()
        connectTimers.values.forEach { $0.cancel() }
        connectTimers.removeAll()
        restartTimers.values.forEach { $0.cancel() }
        restartTimers.removeAll()
        iceRefresh?.cancel()
        iceRefresh = nil
        recovery.reset()
        iceStore.reset()

        // Stop local audio
        localAudioTrack?.isEnabled = false
        localAudioTrack = nil

        // Deactivate audio session to remove mic indicator
        hooks.deactivateAudioSession()

        // Clear state
        speakingLastActive.removeAll()
        speakingStates.removeAll()
        pendingPeers.removeAll()
        pendingOffers.removeAll()
        pendingCandidates.removeAll()
        localUsername = nil

        isSelfMuted = true
        micPermissionDenied = false
        isSelfSpeaking = false
        speakingPeers.removeAll()
        peerInfos.removeAll()

        print("[Voice] Shutdown complete")
    }

    // MARK: - Peer Connection Management

    /// Create a peer connection and send an offer (initiator side).
    /// Called when we receive voicePeerList — we initiate to existing peers.
    func connectToPeer(_ socketId: String, username: String) {
        guard isActive, !awaitingIce else {
            print("[Voice] Buffering connectToPeer \(socketId) \(username)")
            pendingPeers.append((socketId: socketId, username: username))
            return
        }

        if peers[socketId] != nil {
            print("[Voice] Already connected to \(socketId)")
            return
        }

        print("[Voice] connectToPeer \(socketId) \(username)")

        let pc = createPeerConnection(socketId: socketId, username: username)

        // The local track (made at the start, disabled while muted): an ordinary sendrecv offer
        if let track = localAudioTrack {
            pc.add(track, streamIds: ["stream0"])
        }

        // Create and send offer
        pc.offer(for: offerAnswerConstraints) { [weak self] sdp, error in
            guard let sdp = sdp else {
                print("[Voice] Failed to create offer: \(error?.localizedDescription ?? "unknown")")
                return
            }

            pc.setLocalDescription(sdp) { error in
                if let error {
                    print("[Voice] Failed to set local description: \(error.localizedDescription)")
                    return
                }

                DispatchQueue.main.async {
                    guard let self else { return }
                    self.hooks.sendOffer(socketId, sdp, self.localUsername)
                }
            }
        }
    }

    /// Handle an incoming offer from a peer (responder side).
    func handleOffer(fromSocketId: String, offer: RTCSessionDescription, username: String) {
        guard isActive, !awaitingIce else {
            print("[Voice] Buffering handleOffer \(fromSocketId) \(username)")
            // a newer offer from the same peer replaces the older one (and its candidates)
            if pendingOffers.contains(where: { $0.fromSocketId == fromSocketId }) {
                pendingOffers.removeAll { $0.fromSocketId == fromSocketId }
                pendingCandidates[fromSocketId] = nil
            }
            pendingOffers.append((fromSocketId: fromSocketId, offer: offer, username: username))
            return
        }

        print("[Voice] handleOffer from \(fromSocketId) \(username)")

        // If we already have a connection, close it and recreate (a restart keeps its count;
        // the peer is trying again, so it is no longer "unavailable"). An older build's
        // listen-only re-offer arrives this way too (a replacement offer): mute and volume are kept.
        if peers[fromSocketId] != nil {
            closePeer(fromSocketId, keepRecovery: true)
        }
        recovery.offered(fromSocketId)
        restartTimers.removeValue(forKey: fromSocketId)?.cancel()

        let pc = createPeerConnection(socketId: fromSocketId, username: username)

        // Add local audio track (matched to the offer's audio when it is set)
        if let track = localAudioTrack {
            pc.add(track, streamIds: ["stream0"])
        }

        let answerConstraints = offerAnswerConstraints
        let sendAnswer = hooks.sendAnswer
        pc.setRemoteDescription(offer) { error in
            if let error {
                print("[Voice] Failed to set remote description: \(error.localizedDescription)")
                return
            }
            pc.answer(for: answerConstraints) { sdp, error in
                guard let sdp = sdp else {
                    print("[Voice] Failed to create answer: \(error?.localizedDescription ?? "unknown")")
                    return
                }

                pc.setLocalDescription(sdp) { error in
                    if let error {
                        print("[Voice] Failed to set local answer: \(error.localizedDescription)")
                        return
                    }

                    DispatchQueue.main.async {
                        sendAnswer(fromSocketId, sdp)
                    }
                }
            }
        }
    }

    /// Handle an incoming answer from a peer.
    func handleAnswer(fromSocketId: String, answer: RTCSessionDescription) {
        guard let peer = peers[fromSocketId] else {
            print("[Voice] handleAnswer: no peer for \(fromSocketId)")
            return
        }

        print("[Voice] handleAnswer from \(fromSocketId)")
        let pc = peer.connection
        pc.setRemoteDescription(answer) { error in
            if let error {
                print("[Voice] Failed to set remote answer: \(error.localizedDescription)")
            }
        }
    }

    /// Handle an incoming ICE candidate.
    func handleIceCandidate(fromSocketId: String, candidate: RTCIceCandidate) {
        guard let peer = peers[fromSocketId] else {
            // a buffered offer's candidate: kept until that offer is answered at the start
            if pendingOffers.contains(where: { $0.fromSocketId == fromSocketId }),
               pendingCandidates[fromSocketId, default: []].count < Self.maxPendingCandidates {
                pendingCandidates[fromSocketId, default: []].append(candidate)
            }
            return
        }

        peer.connection.add(candidate) { error in
            if let error {
                print("[Voice] Failed to add ICE candidate: \(error.localizedDescription)")
            }
        }
    }

    /// Remove a peer connection (peer left), and whatever it sent that is still buffered.
    func removePeer(_ socketId: String) {
        pendingPeers.removeAll { $0.socketId == socketId }
        pendingOffers.removeAll { $0.fromSocketId == socketId }
        pendingCandidates[socketId] = nil
        closePeer(socketId)
    }

    // MARK: - Mute Controls

    /// The mic button, M-less: mute, or unmute (the first unmute asks for the microphone). A
    /// tap while that prompt is up is a mute, and it wins over the unmute that asked.
    func toggleSelfMute() {
        if isSelfMuted && !micRequestInFlight { unmute() } else { mute() }
    }

    func mute() {
        unmuteAfterPrompt = false
        isSelfMuted = true
        localAudioTrack?.isEnabled = false
    }

    /// Talk: with the mic already allowed this session, enable the track at once (off while in
    /// the background; the foreground turns it on). Otherwise ask for it first (the session's
    /// first unmute, or again after a refusal: the person may have allowed it in Settings
    /// since). Allowed: the track every call already carries is enabled, no renegotiation.
    /// Refused: muted and listen-only, with the toast.
    func unmute() {
        guard isActive else {
            isSelfMuted = false  // voice is not running (fixture buttons): nothing to send
            return
        }
        if micGranted {
            unmuteAfterPrompt = false
            isSelfMuted = false
            localAudioTrack?.isEnabled = !isBackgrounded
            return
        }
        unmuteAfterPrompt = true
        guard !micRequestInFlight else { return }
        micRequestInFlight = true
        let generation = startGeneration
        Task { @MainActor in
            let granted = await self.hooks.requestRecordPermission()
            self.micRequestInFlight = false
            // shutdown() meanwhile (the person left): no mic for a session that is gone
            guard self.isActive, generation == self.startGeneration else { return }
            guard granted else {
                self.unmuteAfterPrompt = false
                self.micPermissionDenied = true
                self.hooks.notify(VoiceCopy.micDenied)
                print("[Voice] Mic refused: listening only")
                return
            }
            self.micPermissionDenied = false
            self.micGranted = true
            print("[Voice] Mic allowed")
            if self.unmuteAfterPrompt {
                self.unmuteAfterPrompt = false
                self.isSelfMuted = false
                self.localAudioTrack?.isEnabled = !self.isBackgrounded
            }
        }
    }

    /// Mute a specific peer's remote audio.
    func mutePeer(_ socketId: String) {
        peerInfos[socketId]?.isMuted = true
        if let name = peerInfos[socketId]?.username { savedMutes[name] = true }
        peers[socketId]?.remoteTrack?.isEnabled = false
    }

    /// Unmute a specific peer's remote audio.
    func unmutePeer(_ socketId: String) {
        peerInfos[socketId]?.isMuted = false
        if let name = peerInfos[socketId]?.username { savedMutes[name] = false }
        peers[socketId]?.remoteTrack?.isEnabled = true
    }

    /// Sign-out: the next account on this device starts every player at 100%, unmuted.
    func forgetVolumes() {
        savedVolumes.removeAll()
        savedMutes.removeAll()
    }

    /// For tests: the volume a new track for this player would take.
    func savedVolume(for username: String) -> Double? { savedVolumes[username] }
    /// For tests: the mute a new call with this player would take.
    func savedMute(for username: String) -> Bool? { savedMutes[username] }
    /// For tests: peers and offers buffered until voice is up.
    var bufferedCount: Int { pendingPeers.count + pendingOffers.count }
    /// For tests: the ICE candidates buffered with this peer's offer.
    func bufferedCandidates(from socketId: String) -> Int { pendingCandidates[socketId]?.count ?? 0 }
    /// For tests: the signaling state of the call with this peer.
    func signalingState(of socketId: String) -> RTCSignalingState? { peers[socketId]?.connection.signalingState }
    /// For tests: the local track: nil (voice off), or whether it sends.
    var localTrackEnabled: Bool? { localAudioTrack?.isEnabled }
    /// For tests: the call with this peer carries the local track on its audio sender.
    func sendsMic(to socketId: String) -> Bool {
        guard let pc = peers[socketId]?.connection, let track = localAudioTrack else { return false }
        return Self.audioTransceivers(pc).contains { $0.sender.track?.trackId == track.trackId }
    }
    /// For tests: audio senders that may send with no track (WebRTC would feed such a send
    /// stream the capture, unmuted): must always be 0.
    func trackLessAudioSenders(_ socketId: String) -> Int {
        guard let pc = peers[socketId]?.connection else { return 0 }
        return Self.audioTransceivers(pc).filter {
            $0.sender.track == nil && ($0.direction == .sendRecv || $0.direction == .sendOnly)
        }.count
    }
    /// For tests: the call's audio transceivers' directions.
    func audioDirections(of socketId: String) -> [RTCRtpTransceiverDirection] {
        peers[socketId].map { Self.audioTransceivers($0.connection).map(\.direction) } ?? []
    }
    /// For tests: the peer's audio reached us as a track (didAdd stream).
    func hasRemoteTrack(_ socketId: String) -> Bool { peers[socketId]?.remoteTrack != nil }

    /// My volume for one player, 0 to 2 (200%), as the web's per-peer slider. The gain is the
    /// remote track's source volume (WebRTC: 0...10, 1 = unity), so above 1 boosts a quiet
    /// player; mute stays the track's `isEnabled`, so unmuting returns to this level.
    func setPeerVolume(_ socketId: String, _ volume: Double) {
        let level = VoiceVolume.clamp(volume)
        guard var info = peerInfos[socketId], info.volume != level else { return }
        info.volume = level
        peerInfos[socketId] = info
        savedVolumes[info.username] = level
        peers[socketId]?.remoteTrack?.source.volume = level
    }

    /// Toggle a peer's mute state.
    func togglePeerMute(_ socketId: String) {
        if peerInfos[socketId]?.isMuted == true {
            unmutePeer(socketId)
        } else {
            mutePeer(socketId)
        }
    }

    // MARK: - Background Handling

    /// Call when app enters background — mute mic for privacy.
    func handleBackground() {
        isBackgrounded = true
        guard isActive else { return }
        localAudioTrack?.isEnabled = false
    }

    /// Call when app returns to foreground — restore mic state (the self-mute, which cannot
    /// change in the background, also covers a track made there).
    func handleForeground() {
        isBackgrounded = false
        guard isActive else { return }
        localAudioTrack?.isEnabled = !isSelfMuted
    }

    // MARK: - Private Helpers

    private func createPeerConnection(socketId: String, username: String) -> RTCPeerConnection {
        let pc = factory.peerConnection(with: Self.rtcConfiguration(iceStore.current), constraints: mediaConstraints, delegate: nil)!

        let delegate = PeerConnectionDelegate(manager: self, socketId: socketId)
        pc.delegate = delegate
        // Store delegate to keep it alive (stored on the peer state, referenced via associated object)
        objc_setAssociatedObject(pc, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)

        peers[socketId] = PeerState(connection: pc, username: username)
        // this socket's row (a replaced call), else my mute of this person on any socket
        let muted = peerInfos[socketId]?.isMuted ?? savedMutes[username] ?? false
        let volume = peerInfos[socketId]?.volume ?? savedVolumes[username] ?? VoiceVolume.normal
        peerInfos[socketId] = PeerInfo(username: username, isMuted: muted, volume: volume)
        armConnectTimer(socketId, pc)

        return pc
    }

    /// keepRecovery: the connection is replaced by its restart (keeps the restart count and
    /// the peer's row); otherwise the peer left.
    private func closePeer(_ socketId: String, keepRecovery: Bool = false) {
        connectTimers.removeValue(forKey: socketId)?.cancel()
        restartTimers.removeValue(forKey: socketId)?.cancel()
        recovery.closed(socketId, keepRecovery: keepRecovery)
        guard let peer = peers.removeValue(forKey: socketId) else {
            if !keepRecovery { peerInfos.removeValue(forKey: socketId) }
            return
        }
        peer.connection.close()
        speakingLastActive.removeValue(forKey: socketId)
        speakingStates.removeValue(forKey: socketId)

        // the speaking glow goes off while the peer's username is still known (seat by username)
        speakingPeers.remove(socketId)
        speakingChangedSubject.send((socketId, false))
        if !keepRecovery { peerInfos.removeValue(forKey: socketId) }

        print("[Voice] Closed peer: \(socketId)")
    }

    // MARK: - ICE servers and recovery

    /// New ICE servers: onto the open connections (a TURN refresh needs it), then the next refresh.
    private func applyIce(_ config: IceConfig) {
        let rtc = Self.rtcConfiguration(config)
        for peer in peers.values where peer.connection.signalingState != .closed {
            if !peer.connection.setConfiguration(rtc) {
                print("[Voice] setConfiguration refused")
            }
        }
        iceRefresh?.cancel()
        iceRefresh = nil
        guard isActive, let delay = IcePolicy.refreshDelay(config, now: Date()) else { return }
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.isActive else { return }
                Task { @MainActor in _ = await self.iceStore.fetch(username: self.localUsername) }
            }
        }
        iceRefresh = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    /// No connection within IcePolicy.connectTimeout counts as a failure (it may never report one).
    private func armConnectTimer(_ socketId: String, _ pc: RTCPeerConnection) {
        connectTimers.removeValue(forKey: socketId)?.cancel()
        let item = DispatchWorkItem { [weak self, weak pc] in
            MainActor.assumeIsolated {
                guard let self, let pc, self.peers[socketId]?.connection === pc else { return }
                self.connectTimers[socketId] = nil
                guard pc.signalingState != .closed, !Self.isUp(pc.iceConnectionState) else { return }
                print("[Voice] connection to \(socketId) not up after \(Int(IcePolicy.connectTimeout)) s")
                self.peerFailed(socketId)
            }
        }
        connectTimers[socketId] = item
        DispatchQueue.main.asyncAfter(deadline: .now() + IcePolicy.connectTimeout, execute: item)
    }

    static func isUp(_ state: RTCIceConnectionState) -> Bool { state == .connected || state == .completed }

    /// From the delegate (on main): connected clears any failure, failed starts recovery.
    func iceStateChanged(_ socketId: String, _ pc: RTCPeerConnection, _ state: RTCIceConnectionState) {
        guard peers[socketId]?.connection === pc else { return }  // a replaced connection
        if Self.isUp(state) {
            connectTimers.removeValue(forKey: socketId)?.cancel()
            restartTimers.removeValue(forKey: socketId)?.cancel()
            recovery.connected(socketId)
            peerInfos[socketId]?.isUnavailable = false
        } else if state == .failed {
            peerFailed(socketId)
        }
    }

    private func peerFailed(_ socketId: String) {
        guard isActive, let peer = peers[socketId] else { return }
        switch recovery.failed(socketId, myId: SocketService.shared.socketId ?? "") {
        case .none:
            break
        case .restartAsOfferer:
            print("[Voice] connection to \(socketId) failed: restarting once")
            let username = peer.username
            Task { @MainActor in
                _ = await self.iceStore.ensure(username: self.localUsername)
                guard self.isActive, self.peers[socketId]?.connection === peer.connection else { return }
                self.closePeer(socketId, keepRecovery: true)
                self.connectToPeer(socketId, username: username)
            }
        case .waitForRestart:
            print("[Voice] connection to \(socketId) failed: waiting for its restart")
            Task { @MainActor in _ = await self.iceStore.ensure(username: self.localUsername) }
            let item = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.restartTimers[socketId] = nil
                    if self.recovery.waitExpired(socketId) == .markUnavailable { self.markUnavailable(socketId) }
                }
            }
            restartTimers[socketId] = item
            DispatchQueue.main.asyncAfter(deadline: .now() + IcePolicy.restartWait, execute: item)
        case .markUnavailable:
            markUnavailable(socketId)
        }
    }

    /// Voice unavailable for this peer: the connection closes, its row stays (marked).
    private func markUnavailable(_ socketId: String) {
        print("[Voice] voice unavailable for \(socketId)")
        connectTimers.removeValue(forKey: socketId)?.cancel()
        if let peer = peers[socketId], peer.connection.signalingState != .closed { peer.connection.close() }
        peerInfos[socketId]?.isUnavailable = true
        if speakingStates[socketId] == true {
            speakingStates[socketId] = false
            speakingPeers.remove(socketId)
            speakingChangedSubject.send((socketId, false))
        }
    }

    private func flushPendingEvents() {
        let offerPeerIds = Set(pendingOffers.map { $0.fromSocketId })
        let bufferedPeers = pendingPeers
        let bufferedOffers = pendingOffers
        let bufferedCandidates = pendingCandidates
        pendingPeers.removeAll()
        pendingOffers.removeAll()
        pendingCandidates.removeAll()

        print("[Voice] Flushing \(bufferedOffers.count) offers, \(bufferedPeers.count) peers")

        for offer in bufferedOffers {
            handleOffer(fromSocketId: offer.fromSocketId, offer: offer.offer, username: offer.username)
            // right after the offer: WebRTC chains each add behind the remote description
            for candidate in bufferedCandidates[offer.fromSocketId] ?? [] {
                handleIceCandidate(fromSocketId: offer.fromSocketId, candidate: candidate)
            }
        }
        for peer in bufferedPeers {
            if !offerPeerIds.contains(peer.socketId) {
                connectToPeer(peer.socketId, username: peer.username)
            }
        }
    }

    // MARK: - Speaking Detection

    private func startSpeakingDetection() {
        speakingTimer?.invalidate()
        speakingTimer = Timer.scheduledTimer(withTimeInterval: Self.speakingPollInterval, repeats: true) { [weak self] _ in
            // Scheduled from the main actor, so the timer fires on the main run loop
            MainActor.assumeIsolated {
                self?.pollSpeakingLevels()
            }
        }
    }

    private func pollSpeakingLevels() {
        // Poll audio levels for all peers using WebRTC stats
        for (socketId, peer) in peers {
            peer.connection.statistics { [weak self] report in
                var maxLevel: Float = 0

                for (_, stats) in report.statistics {
                    // Look for inbound RTP audio stats with audioLevel
                    if stats.type == "inbound-rtp",
                       let kind = stats.values["kind"] as? String, kind == "audio",
                       let level = stats.values["audioLevel"] as? Double {
                        maxLevel = max(maxLevel, Float(level))
                    }
                }

                DispatchQueue.main.async {
                    self?.updateSpeakingState(id: socketId, level: maxLevel)
                }
            }
        }

        // For local mic, check if track is enabled and use outbound stats
        if let track = localAudioTrack, track.isEnabled {
            // Use a simple approach: check all peer connections for outbound audio stats
            if let firstPeer = peers.values.first {
                firstPeer.connection.statistics { [weak self] report in
                    var maxLevel: Float = 0

                    for (_, stats) in report.statistics {
                        if stats.type == "outbound-rtp",
                           let kind = stats.values["kind"] as? String, kind == "audio",
                           let level = stats.values["audioLevel"] as? Double {
                            maxLevel = max(maxLevel, Float(level))
                        }
                        // Also check media-source stats
                        if stats.type == "media-source",
                           let kind = stats.values["kind"] as? String, kind == "audio",
                           let level = stats.values["audioLevel"] as? Double {
                            maxLevel = max(maxLevel, Float(level))
                        }
                    }

                    DispatchQueue.main.async {
                        self?.updateSpeakingState(id: "self", level: maxLevel)
                    }
                }
            }
        } else {
            // Muted — not speaking
            updateSpeakingState(id: "self", level: 0)
        }
    }

    private func updateSpeakingState(id: String, level: Float) {
        // Stats arrive asynchronously; drop results for a peer closed in the meantime
        guard id == "self" || peers[id] != nil else { return }
        let now = Date()
        if level > Self.speakingThreshold {
            speakingLastActive[id] = now
        }

        let wasSpeaking = speakingStates[id] ?? false
        let lastActive = speakingLastActive[id] ?? .distantPast
        let isSpeaking = now.timeIntervalSince(lastActive) < Self.speakingHoldMs

        if isSpeaking != wasSpeaking {
            speakingStates[id] = isSpeaking

            if id == "self" {
                isSelfSpeaking = isSpeaking
            } else {
                if isSpeaking {
                    speakingPeers.insert(id)
                } else {
                    speakingPeers.remove(id)
                }
            }
            speakingChangedSubject.send((id, isSpeaking))
        }
    }

    // MARK: - Internal (for PeerConnectionDelegate)

    func setRemoteTrack(_ track: RTCAudioTrack, for socketId: String) {
        peers[socketId]?.remoteTrack = track
        // a new track (first connect, a restart, a replacement offer) takes this player's
        // mute and volume
        if let info = peerInfos[socketId] {
            track.isEnabled = !info.isMuted
            track.source.volume = info.volume
        }
    }

    // MARK: - Errors

    enum VoiceError: Error {
        case micPermissionDenied
    }
}

/// The voice panel's per-player volume: 0 to 200% in 5% steps, 100% as sent (web
/// VoiceChatManager.setPeerVolume clamps to the same 0...2).
enum VoiceVolume {
    static let range: ClosedRange<Double> = 0...2
    static let normal: Double = 1
    static let step: Double = 0.05

    static func clamp(_ volume: Double) -> Double {
        guard volume.isFinite else { return normal }
        return min(range.upperBound, max(range.lowerBound, volume))
    }

    /// "100%"
    static func percentText(_ volume: Double) -> String { "\(Int((clamp(volume) * 100).rounded()))%" }
}

// MARK: - RTCPeerConnectionDelegate

private class PeerConnectionDelegate: NSObject, RTCPeerConnectionDelegate {
    weak var manager: VoiceChatManager?
    let socketId: String

    init(manager: VoiceChatManager, socketId: String) {
        self.manager = manager
        self.socketId = socketId
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        print("[Voice] Peer \(socketId) signaling: \(stateChanged.rawValue)")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        print("[Voice] Peer \(socketId) added stream with \(stream.audioTracks.count) audio tracks")
        if let audioTrack = stream.audioTracks.first {
            audioTrack.isEnabled = true
            DispatchQueue.main.async { [weak self] in
                guard let self, let manager = self.manager else { return }
                manager.setRemoteTrack(audioTrack, for: self.socketId)
            }
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        print("[Voice] Peer \(socketId) ICE: \(newState.rawValue)")
        let id = socketId
        DispatchQueue.main.async { [weak self, weak peerConnection] in
            guard let self, let pc = peerConnection else { return }
            self.manager?.iceStateChanged(id, pc, newState)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        // WebRTC calls this on its signaling thread: emit from main like every other voice emit
        let target = socketId
        Task { @MainActor in VoiceEmitter.sendIceCandidate(targetSocketId: target, candidate: candidate) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

// MARK: - AVAudioSession extension for async permission

extension AVAudioSession {
    func requestRecordPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
