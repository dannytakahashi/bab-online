import AVFoundation
import XCTest
@preconcurrency import WebRTC
@testable import BAB_Online

/// Opt-in (`TEST_RUNNER_BAB_SOUND_PROBE=1`, as `SoundLevelProbeTests`; mute the Mac first): two
/// in-process calls on WebRTC's OWN audio device module, i.e. its real VoiceProcessingIO unit
/// on the simulator's audio HAL (the unit tests never touch it: docs/claude/voice.md, Tests),
/// to see that `VoiceDucking`'s hooks run when WebRTC initializes and starts that unit and that
/// the unit then reads back the least ducking.
@MainActor
final class VoiceDuckingProbeTests: XCTestCase {
    func testWebRTCsOwnUnitGetsTheLeastDucking() async throws {
        guard ProcessInfo.processInfo.environment["BAB_SOUND_PROBE"] == "1" else { throw XCTSkip("opt-in: TEST_RUNNER_BAB_SOUND_PROBE=1") }
        XCTAssertTrue(VoiceDucking.install())
        VoiceAudioSession.installWebRTCConfiguration()
        try VoiceAudioSession.shared.activate()
        defer { VoiceAudioSession.shared.deactivate() }
        RTCInitializeSSL()
        let factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let a = try XCTUnwrap(factory.peerConnection(with: config, constraints: constraints, delegate: nil))
        let b = try XCTUnwrap(factory.peerConnection(with: config, constraints: constraints, delegate: nil))
        defer { a.close(); b.close() }
        a.add(factory.audioTrack(with: factory.audioSource(with: nil), trackId: "a"), streamIds: ["s"])
        b.add(factory.audioTrack(with: factory.audioSource(with: nil), trackId: "b"), streamIds: ["s"])
        let before = VoiceDucking.configuredUnits
        let offer = try await a.offer(for: constraints)
        try await a.setLocalDescription(offer)
        try await b.setRemoteDescription(offer)
        let answer = try await b.answer(for: constraints)
        try await b.setLocalDescription(answer)
        try await a.setRemoteDescription(answer)
        let end = Date().addingTimeInterval(8)
        while VoiceDucking.configuredUnits == before, Date() < end { try await Task.sleep(nanoseconds: 100_000_000) }
        let s = AVAudioSession.sharedInstance()
        print("[VoiceDuckingProbe] configured \(VoiceDucking.configuredUnits - before) time(s); session \(s.category.rawValue) / \(s.mode.rawValue), route \(s.currentRoute.outputs.map(\.portType.rawValue))")
        XCTAssertGreaterThan(VoiceDucking.configuredUnits, before, "WebRTC's VoiceProcessingIO unit went through the hooks")
    }
}
