import XCTest
@preconcurrency import WebRTC
@testable import BAB_Online

/// What a player's voice volume plays (owner 2026-11-24, "you still can't reduce the volume to
/// zero for talking (seems like 5% min?)"; docs/claude/voice.md "iOS per-player volume"). A real
/// in-process call between two managers whose audio devices carry samples (`ToneAudioDevice`:
/// a 440 Hz tone into the sender, WebRTC's mixed playout pulled out of the receiver), so the
/// level is the one WebRTC hands the speaker, measured, not read from the code.
///
/// Measured (iPhone 17 simulator, 2026-11-24; peak RMS of a 0.3 full-scale tone): 100% 0.206,
/// 5% 0.0103 (-26 dB: quiet, audible), 0% exactly 0 with the track still enabled. So the
/// per-player slider at 0% is silent on iOS, as it was in 1.2.5: WebRTC scales the decoded
/// audio by the source volume, as it zeroes it for a disabled track. The owner's "5% min" was
/// another control (see docs/claude/voice.md "iOS per-player volume").
@MainActor
final class VoiceVolumeSilenceTests: XCTestCase {
    final class Wire {
        var offers: [RTCSessionDescription] = []
        var answers: [RTCSessionDescription] = []
    }

    private var managers: [VoiceChatManager] = []

    override func tearDown() async throws {
        for m in managers { m.shutdown() }
        managers = []
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 15, _ condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > end { return XCTFail("timed out: \(what)") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    /// The loudest 10 ms the receiver played over `seconds` (after a settle for the gain to
    /// reach the decoded frames).
    private func level(_ device: ToneAudioDevice, seconds: Double = 0.6) async throws -> Double {
        try await Task.sleep(nanoseconds: 300_000_000)
        device.resetLevel()
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        return device.peakLevel
    }

    func testZeroVolumeIsSilentWithTheTrackStillEnabled() async throws {
        let wa = Wire(), wb = Wire()
        let da = ToneAudioDevice(), db = ToneAudioDevice()
        // the server's relay: amy's candidates wait until bob has her offer
        var amyRef: VoiceChatManager?, bobRef: VoiceChatManager?
        var amyCandidates: [RTCIceCandidate] = []
        var bobHasOffer = false
        let amy = VoiceChatManager.silent(sendOffer: { _, sdp, _ in wa.offers.append(sdp) },
                                          sendIceCandidate: { _, c in
                                              if bobHasOffer { bobRef?.handleIceCandidate(fromSocketId: "A", candidate: c) }
                                              else { amyCandidates.append(c) }
                                          },
                                          audioDevice: da)
        let bob = VoiceChatManager.silent(sendAnswer: { _, sdp in wb.answers.append(sdp) },
                                          sendIceCandidate: { _, c in amyRef?.handleIceCandidate(fromSocketId: "B", candidate: c) },
                                          audioDevice: db)
        amyRef = amy
        bobRef = bob
        managers = [amy, bob]
        try await amy.initialize()
        try await bob.initialize()
        amy.unmute()  // her microphone: the tone (the silent hooks grant it)
        try await waitUntil("amy unmuted") { !amy.isSelfMuted }
        amy.connectToPeer("B", username: "bob")
        try await waitUntil("amy's offer") { wa.offers.count == 1 }
        bob.handleOffer(fromSocketId: "A", offer: wa.offers[0], username: "amy")
        bobHasOffer = true
        for c in amyCandidates { bob.handleIceCandidate(fromSocketId: "A", candidate: c) }
        try await waitUntil("bob's answer") { wb.answers.count == 1 }
        amy.handleAnswer(fromSocketId: "B", answer: wb.answers[0])
        try await waitUntil("bob plays amy's tone") { db.peakLevel > 0.02 }
        let track = try XCTUnwrap(bob.remoteTrack("A"))

        let full = try await level(db)
        XCTAssertGreaterThan(full, 0.05, "100%: the tone plays")

        // the 1.2.5 path at 0%: the source gain at 0, the track left enabled
        track.isEnabled = true
        track.source.volume = 0
        let zeroEnabled = try await level(db)
        XCTAssertTrue(track.isEnabled)
        XCTAssertEqual(zeroEnabled, 0, accuracy: 0.0005, "0% with the track enabled is already silent")

        // the lowest step above 0: quiet, not silent
        track.source.volume = VoiceVolume.step
        let lowest = try await level(db)
        XCTAssertGreaterThan(lowest, 0.0005, "5% still plays")
        XCTAssertLessThan(lowest, full * 0.2, "5% is far below 100%")

        // the slider's 0% (setPeerVolume): the same, the track untouched
        track.source.volume = 1
        bob.setPeerVolume("A", 0)
        XCTAssertEqual(bob.remoteTrackEnabled("A"), true, "0% is the gain, not Mute")
        XCTAssertEqual(bob.remoteTrackVolume("A"), 0)
        let zeroApp = try await level(db)
        XCTAssertEqual(zeroApp, 0, accuracy: 0.0005, "the slider at 0% plays nothing")

        print("[VoiceVolumeSilence] peak RMS: 100% \(full), 0% enabled \(zeroEnabled), 5% \(lowest), app 0% \(zeroApp)")
    }
}
