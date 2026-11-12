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
/// credentials or the public STUN pair) in parallel with the microphone
/// prompt and awaited before the first peer connection, at most 4 s, else
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
    @Published var isSelfMuted = false
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
    }

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
    let iceStore = IceServerStore(emit: { VoiceEmitter.getIceServers($0) })
    private var recovery = VoiceRecovery()
    private var connectTimers: [String: DispatchWorkItem] = [:]
    private var restartTimers: [String: DispatchWorkItem] = [:]
    private var iceRefresh: DispatchWorkItem?

    private static let speakingThreshold: Float = 0.005
    private static let speakingPollInterval: TimeInterval = 0.1
    private static let speakingHoldMs: TimeInterval = 0.4

    private let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        return RTCPeerConnectionFactory(encoderFactory: encoderFactory, decoderFactory: decoderFactory)
    }()

    private var localAudioTrack: RTCAudioTrack?
    private var peers: [String: PeerState] = [:]  // socketId → connection state
    private var localUsername: String?

    // Speaking detection
    private var speakingTimer: Timer?
    private var speakingLastActive: [String: Date] = [:]  // socketId|"self" → last above-threshold time
    private var speakingStates: [String: Bool] = [:]

    // Buffered events (arrive before init completes)
    private var pendingPeers: [(socketId: String, username: String)] = []
    private var pendingOffers: [(fromSocketId: String, offer: RTCSessionDescription, username: String)] = []

    // Background handling
    private var wasMutedBeforeBackground = false

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

    private init() {
        iceStore.onChange = { [weak self] config in self?.applyIce(config) }
    }

    // MARK: - Lifecycle

    /// Initialize voice chat: request mic, configure audio session, start capture.
    func initialize() async throws {
        guard !isActive, !Self.voiceDisabled else { return }
        let generation = startGeneration

        // ICE servers in parallel with the permission prompt (re-asked on every start unless TURN is reusable)
        let username = SocketService.shared.authState?.username
        let iceReady = Task { @MainActor in await self.iceStore.ensure(username: username) }

        // Request mic permission
        let granted = await AVAudioSession.sharedInstance().requestRecordPermission()
        guard granted else {
            micPermissionDenied = true
            throw VoiceError.micPermissionDenied
        }
        // Another initialize() may have finished while we awaited the permission
        // prompt, or shutdown() ran meanwhile (the player left the game): no mic then
        guard !isActive, generation == startGeneration else { return }

        // Configure audio session
        try configureAudioSession()

        // Create local audio track
        let audioSource = factory.audioSource(with: mediaConstraints)
        let audioTrack = factory.audioTrack(with: audioSource, trackId: "audio0")
        audioTrack.isEnabled = true
        localAudioTrack = audioTrack

        localUsername = SocketService.shared.authState?.username

        isActive = true
        isSelfMuted = false
        micPermissionDenied = false

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

        print("[Voice] Initialized, username: \(localUsername ?? "nil")")
    }

    /// Start voice if it is not running (idempotent): game entry as a seat and
    /// rejoin (21.14). Peers that arrive during the permission prompt are
    /// buffered in `pendingPeers` and connected once active. Never under XCTest.
    func ensureStarted() {
        guard !isActive, ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        Task { try? await initialize() }
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

    /// Shut down all voice connections and clean up.
    func shutdown() {
        startGeneration &+= 1  // an initialize() still awaiting the permission prompt gives up
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
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        // Clear state
        speakingLastActive.removeAll()
        speakingStates.removeAll()
        pendingPeers.removeAll()
        pendingOffers.removeAll()
        localUsername = nil
        wasMutedBeforeBackground = false

        isSelfMuted = false
        isSelfSpeaking = false
        speakingPeers.removeAll()
        peerInfos.removeAll()

        print("[Voice] Shutdown complete")
    }

    // MARK: - Peer Connection Management

    /// Create a peer connection and send an offer (initiator side).
    /// Called when we receive voicePeerList — we initiate to existing peers.
    func connectToPeer(_ socketId: String, username: String) {
        guard isActive, localAudioTrack != nil, !awaitingIce else {
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

        // Add local audio track
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
                    VoiceEmitter.sendOffer(
                        targetSocketId: socketId,
                        offer: sdp,
                        username: self.localUsername
                    )
                }
            }
        }
    }

    /// Handle an incoming offer from a peer (responder side).
    func handleOffer(fromSocketId: String, offer: RTCSessionDescription, username: String) {
        guard isActive, localAudioTrack != nil, !awaitingIce else {
            print("[Voice] Buffering handleOffer \(fromSocketId) \(username)")
            pendingOffers.append((fromSocketId: fromSocketId, offer: offer, username: username))
            return
        }

        print("[Voice] handleOffer from \(fromSocketId) \(username)")

        // If we already have a connection, close it and recreate (a restart keeps its count;
        // the peer is trying again, so it is no longer "unavailable")
        if peers[fromSocketId] != nil {
            closePeer(fromSocketId, keepRecovery: true)
        }
        recovery.offered(fromSocketId)
        restartTimers.removeValue(forKey: fromSocketId)?.cancel()

        let pc = createPeerConnection(socketId: fromSocketId, username: username)

        // Add local audio track
        if let track = localAudioTrack {
            pc.add(track, streamIds: ["stream0"])
        }

        let answerConstraints = offerAnswerConstraints
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
                        VoiceEmitter.sendAnswer(targetSocketId: fromSocketId, answer: sdp)
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
        peer.connection.setRemoteDescription(answer) { error in
            if let error {
                print("[Voice] Failed to set remote answer: \(error.localizedDescription)")
            }
        }
    }

    /// Handle an incoming ICE candidate.
    func handleIceCandidate(fromSocketId: String, candidate: RTCIceCandidate) {
        guard let peer = peers[fromSocketId] else { return }

        peer.connection.add(candidate) { error in
            if let error {
                print("[Voice] Failed to add ICE candidate: \(error.localizedDescription)")
            }
        }
    }

    /// Remove a peer connection (peer left).
    func removePeer(_ socketId: String) {
        closePeer(socketId)
    }

    // MARK: - Mute Controls

    /// Toggle self-mute (disable/enable local audio track).
    func toggleSelfMute() {
        isSelfMuted.toggle()
        localAudioTrack?.isEnabled = !isSelfMuted
    }

    /// Mute a specific peer's remote audio.
    func mutePeer(_ socketId: String) {
        peerInfos[socketId]?.isMuted = true
        peers[socketId]?.remoteTrack?.isEnabled = false
    }

    /// Unmute a specific peer's remote audio.
    func unmutePeer(_ socketId: String) {
        peerInfos[socketId]?.isMuted = false
        peers[socketId]?.remoteTrack?.isEnabled = true
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
        guard isActive else { return }
        wasMutedBeforeBackground = isSelfMuted
        if !isSelfMuted {
            localAudioTrack?.isEnabled = false
        }
    }

    /// Call when app returns to foreground — restore mic state.
    func handleForeground() {
        guard isActive else { return }
        if !wasMutedBeforeBackground {
            localAudioTrack?.isEnabled = true
        }
    }

    // MARK: - Private Helpers

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
    }

    private func createPeerConnection(socketId: String, username: String) -> RTCPeerConnection {
        let pc = factory.peerConnection(with: Self.rtcConfiguration(iceStore.current), constraints: mediaConstraints, delegate: nil)!

        let delegate = PeerConnectionDelegate(manager: self, socketId: socketId)
        pc.delegate = delegate
        // Store delegate to keep it alive (stored on the peer state, referenced via associated object)
        objc_setAssociatedObject(pc, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)

        peers[socketId] = PeerState(connection: pc, username: username)
        let muted = peerInfos[socketId]?.isMuted ?? false
        peerInfos[socketId] = PeerInfo(username: username, isMuted: muted)
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
        pendingPeers.removeAll()
        pendingOffers.removeAll()

        print("[Voice] Flushing \(bufferedOffers.count) offers, \(bufferedPeers.count) peers")

        for offer in bufferedOffers {
            handleOffer(fromSocketId: offer.fromSocketId, offer: offer.offer, username: offer.username)
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
    }

    // MARK: - Errors

    enum VoiceError: Error {
        case micPermissionDenied
    }
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
