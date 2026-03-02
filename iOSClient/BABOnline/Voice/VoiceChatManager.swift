import Foundation
import AVFoundation
import Combine
import WebRTC

/// Manages WebRTC peer-to-peer voice chat.
/// Full-mesh topology: one RTCPeerConnection per human peer.
/// Server only relays signaling messages (SDP offers/answers, ICE candidates).
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
    }

    // MARK: - Private State

    private static let iceConfig: RTCConfiguration = {
        let config = RTCConfiguration()
        config.iceServers = [
            RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"]),
            RTCIceServer(urlStrings: ["stun:stun1.l.google.com:19302"])
        ]
        config.sdpSemantics = .unifiedPlan
        return config
    }()

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

    private init() {}

    // MARK: - Lifecycle

    /// Initialize voice chat: request mic, configure audio session, start capture.
    func initialize() async throws {
        guard !isActive else { return }

        // Request mic permission
        let granted = await AVAudioSession.sharedInstance().requestRecordPermission()
        guard granted else {
            await MainActor.run { micPermissionDenied = true }
            throw VoiceError.micPermissionDenied
        }

        // Configure audio session
        try configureAudioSession()

        // Create local audio track
        let audioSource = factory.audioSource(with: mediaConstraints)
        let audioTrack = factory.audioTrack(with: audioSource, trackId: "audio0")
        audioTrack.isEnabled = true
        localAudioTrack = audioTrack

        localUsername = await MainActor.run { SocketService.shared.authState?.username }

        await MainActor.run {
            isActive = true
            isSelfMuted = false
            micPermissionDenied = false
        }

        // Start speaking detection
        startSpeakingDetection()

        // Flush buffered events
        await flushPendingEvents()

        print("[Voice] Initialized, username: \(localUsername ?? "nil")")
    }

    /// Shut down all voice connections and clean up.
    func shutdown() {
        guard isActive else { return }
        isActive = false

        // Stop speaking detection
        speakingTimer?.invalidate()
        speakingTimer = nil

        // Close all peer connections
        for (socketId, peer) in peers {
            peer.connection.close()
            print("[Voice] Closed peer: \(socketId)")
        }
        peers.removeAll()

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

        DispatchQueue.main.async { [weak self] in
            self?.isSelfMuted = false
            self?.isSelfSpeaking = false
            self?.speakingPeers.removeAll()
            self?.peerInfos.removeAll()
        }

        print("[Voice] Shutdown complete")
    }

    // MARK: - Peer Connection Management

    /// Create a peer connection and send an offer (initiator side).
    /// Called when we receive voicePeerList — we initiate to existing peers.
    func connectToPeer(_ socketId: String, username: String) {
        guard isActive, localAudioTrack != nil else {
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
            guard let self, let sdp = sdp else {
                print("[Voice] Failed to create offer: \(error?.localizedDescription ?? "unknown")")
                return
            }

            pc.setLocalDescription(sdp) { error in
                if let error {
                    print("[Voice] Failed to set local description: \(error.localizedDescription)")
                    return
                }

                VoiceEmitter.sendOffer(
                    targetSocketId: socketId,
                    offer: sdp,
                    username: self.localUsername
                )
            }
        }
    }

    /// Handle an incoming offer from a peer (responder side).
    func handleOffer(fromSocketId: String, offer: RTCSessionDescription, username: String) {
        guard isActive, localAudioTrack != nil else {
            print("[Voice] Buffering handleOffer \(fromSocketId) \(username)")
            pendingOffers.append((fromSocketId: fromSocketId, offer: offer, username: username))
            return
        }

        print("[Voice] handleOffer from \(fromSocketId) \(username)")

        // If we already have a connection, close it and recreate
        if peers[fromSocketId] != nil {
            closePeer(fromSocketId)
        }

        let pc = createPeerConnection(socketId: fromSocketId, username: username)

        // Add local audio track
        if let track = localAudioTrack {
            pc.add(track, streamIds: ["stream0"])
        }

        pc.setRemoteDescription(offer) { [weak self] error in
            guard let self else { return }
            if let error {
                print("[Voice] Failed to set remote description: \(error.localizedDescription)")
                return
            }

            pc.answer(for: self.offerAnswerConstraints) { sdp, error in
                guard let sdp = sdp else {
                    print("[Voice] Failed to create answer: \(error?.localizedDescription ?? "unknown")")
                    return
                }

                pc.setLocalDescription(sdp) { error in
                    if let error {
                        print("[Voice] Failed to set local answer: \(error.localizedDescription)")
                        return
                    }

                    VoiceEmitter.sendAnswer(targetSocketId: fromSocketId, answer: sdp)
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
        let pc = factory.peerConnection(with: Self.iceConfig, constraints: mediaConstraints, delegate: nil)!

        let delegate = PeerConnectionDelegate(manager: self, socketId: socketId)
        pc.delegate = delegate
        // Store delegate to keep it alive (stored on the peer state, referenced via associated object)
        objc_setAssociatedObject(pc, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)

        peers[socketId] = PeerState(connection: pc, username: username)
        DispatchQueue.main.async { [weak self] in
            self?.peerInfos[socketId] = PeerInfo(username: username)
        }

        return pc
    }

    private func closePeer(_ socketId: String) {
        guard let peer = peers.removeValue(forKey: socketId) else { return }
        peer.connection.close()
        speakingLastActive.removeValue(forKey: socketId)
        speakingStates.removeValue(forKey: socketId)

        DispatchQueue.main.async { [weak self] in
            self?.peerInfos.removeValue(forKey: socketId)
            self?.speakingPeers.remove(socketId)
            self?.speakingChangedSubject.send((socketId, false))
        }

        print("[Voice] Closed peer: \(socketId)")
    }

    private func flushPendingEvents() async {
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
            self?.pollSpeakingLevels()
        }
    }

    private func pollSpeakingLevels() {
        // Poll audio levels for all peers using WebRTC stats
        for (socketId, peer) in peers {
            peer.connection.statistics { [weak self] report in
                guard let self else { return }
                var maxLevel: Float = 0

                for (_, stats) in report.statistics {
                    // Look for inbound RTP audio stats with audioLevel
                    if stats.type == "inbound-rtp",
                       let kind = stats.values["kind"] as? String, kind == "audio",
                       let level = stats.values["audioLevel"] as? Double {
                        maxLevel = max(maxLevel, Float(level))
                    }
                }

                self.updateSpeakingState(id: socketId, level: maxLevel)
            }
        }

        // For local mic, check if track is enabled and use outbound stats
        if let track = localAudioTrack, track.isEnabled {
            // Use a simple approach: check all peer connections for outbound audio stats
            if let firstPeer = peers.values.first {
                firstPeer.connection.statistics { [weak self] report in
                    guard let self else { return }
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

                    self.updateSpeakingState(id: "self", level: maxLevel)
                }
            }
        } else {
            // Muted — not speaking
            updateSpeakingState(id: "self", level: 0)
        }
    }

    private func updateSpeakingState(id: String, level: Float) {
        let now = Date()
        if level > Self.speakingThreshold {
            speakingLastActive[id] = now
        }

        let wasSpeaking = speakingStates[id] ?? false
        let lastActive = speakingLastActive[id] ?? .distantPast
        let isSpeaking = now.timeIntervalSince(lastActive) < Self.speakingHoldMs

        if isSpeaking != wasSpeaking {
            speakingStates[id] = isSpeaking

            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if id == "self" {
                    self.isSelfSpeaking = isSpeaking
                } else {
                    if isSpeaking {
                        self.speakingPeers.insert(id)
                    } else {
                        self.speakingPeers.remove(id)
                    }
                }
                self.speakingChangedSubject.send((id, isSpeaking))
            }
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
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        VoiceEmitter.sendIceCandidate(targetSocketId: socketId, candidate: candidate)
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
