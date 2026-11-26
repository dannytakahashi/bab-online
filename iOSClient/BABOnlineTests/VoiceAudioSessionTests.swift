import XCTest
import AVFoundation
@preconcurrency import WebRTC
@testable import BAB_Online

/// Voice's audio session values and the loudspeaker safety net (owner 2026-11-17, iPhone Air:
/// voice only from the earpiece). Pure: nothing here touches AVAudioSession or RTCAudioSession
/// (but `testHapticsStayOnWhileVoiceRecords`, which sets one flag and the category, never
/// activating the session); the real route is only heard on a device (the simulator has no
/// earpiece).
final class VoiceAudioSessionTests: XCTestCase {
    func testTheSessionValues() {
        XCTAssertEqual(VoiceAudioPolicy.category, .playAndRecord)
        XCTAssertEqual(VoiceAudioPolicy.mode, .voiceChat, "the VoiceProcessingIO unit: echo cancellation stays on")
        XCTAssertTrue(VoiceAudioPolicy.options.contains(.defaultToSpeaker), "the loudspeaker, not the earpiece")
        XCTAssertTrue(VoiceAudioPolicy.options.contains(.allowBluetoothHFP), "AirPods / headsets with their mic")
        XCTAssertFalse(VoiceAudioPolicy.options.contains(.allowBluetoothA2DP))
        XCTAssertFalse(VoiceAudioPolicy.options.contains(.mixWithOthers))
        XCTAssertTrue(VoiceAudioPolicy.allowsHapticsWhileRecording, "the turn haptic during voice chat")
    }

    /// iOS mutes haptics while the session records unless the app opts out (review of PR #430):
    /// the opt-out sets the flag and survives voice's category being set again (WebRTC's
    /// configureWebRTCSession when a call starts playout). The haptic itself is only felt on a
    /// device.
    func testHapticsStayOnWhileVoiceRecords() throws {
        let session = AVAudioSession.sharedInstance()
        let before = (session.category, session.mode, session.categoryOptions, session.allowHapticsAndSystemSoundsDuringRecording)
        defer {
            try? session.setCategory(before.0, mode: before.1, options: before.2)
            try? session.setAllowHapticsAndSystemSoundsDuringRecording(before.3)
        }
        try session.setAllowHapticsAndSystemSoundsDuringRecording(false)
        VoiceAudioSession.allowHapticsWhileRecording(session)
        XCTAssertTrue(session.allowHapticsAndSystemSoundsDuringRecording)
        try session.setCategory(VoiceAudioPolicy.category, mode: VoiceAudioPolicy.mode, options: VoiceAudioPolicy.options)
        XCTAssertTrue(session.allowHapticsAndSystemSoundsDuringRecording, "kept across the category")
    }

    /// The bug: WebRTC's default configuration (applied when a call starts playout) has no
    /// .defaultToSpeaker. Ours carries the app's options and keeps WebRTC's other defaults.
    func testWebRTCsConfigurationKeepsTheSpeaker() {
        let stock = RTCAudioSessionConfiguration()
        XCTAssertFalse(stock.categoryOptions.contains(.defaultToSpeaker), "WebRTC's own default (the earpiece)")

        let config = VoiceAudioPolicy.webRTCConfiguration()
        XCTAssertEqual(config.category, AVAudioSession.Category.playAndRecord.rawValue)
        XCTAssertEqual(config.mode, AVAudioSession.Mode.voiceChat.rawValue)
        XCTAssertEqual(config.categoryOptions, VoiceAudioPolicy.options)
        XCTAssertEqual(config.sampleRate, stock.sampleRate)
        XCTAssertEqual(config.ioBufferDuration, stock.ioBufferDuration)
        XCTAssertEqual(config.inputNumberOfChannels, stock.inputNumberOfChannels)
        XCTAssertEqual(config.outputNumberOfChannels, stock.outputNumberOfChannels)
    }

    /// The app's factory installs it as WebRTC's configuration (a global value; no session).
    func testInstalledAsWebRTCsConfiguration() {
        VoiceAudioSession.installWebRTCConfiguration()
        let installed = RTCAudioSessionConfiguration.webRTC()
        XCTAssertEqual(installed.categoryOptions, VoiceAudioPolicy.options)
        XCTAssertEqual(installed.category, AVAudioSession.Category.playAndRecord.rawValue)
        XCTAssertEqual(installed.mode, AVAudioSession.Mode.voiceChat.rawValue)
    }

    func testForceTheSpeakerOnlyFromTheReceiverAlone() {
        func force(_ outputs: [AVAudioSession.Port], _ inputs: [AVAudioSession.Port] = [.builtInMic]) -> Bool {
            VoiceAudioPolicy.shouldForceSpeaker(outputs: outputs, availableInputs: inputs)
        }
        // the bug's route: the earpiece, nothing connected
        XCTAssertTrue(force([.builtInReceiver]))
        XCTAssertTrue(force([.builtInReceiver], []))
        // already the loudspeaker, or no route at all
        XCTAssertFalse(force([.builtInSpeaker]))
        XCTAssertFalse(force([]))
        // a person's own route always wins
        XCTAssertFalse(force([.headphones]))
        XCTAssertFalse(force([.headphones], [.builtInMic, .headsetMic]))
        XCTAssertFalse(force([.bluetoothHFP], [.builtInMic, .bluetoothHFP]))
        XCTAssertFalse(force([.bluetoothA2DP]))
        XCTAssertFalse(force([.bluetoothLE]))
        XCTAssertFalse(force([.carAudio], [.carAudio]))
        XCTAssertFalse(force([.usbAudio], [.usbAudio]))
        XCTAssertFalse(force([.airPlay]))
        // "iPhone" picked in the route picker while AirPods / a headset / the car are there
        XCTAssertFalse(force([.builtInReceiver], [.builtInMic, .bluetoothHFP]))
        XCTAssertFalse(force([.builtInReceiver], [.builtInMic, .headsetMic]))
        XCTAssertFalse(force([.builtInReceiver], [.builtInMic, .carAudio]))
        XCTAssertFalse(force([.builtInReceiver, .bluetoothHFP]))
    }

    /// Owner 2026-11-18 (iPhone Air, build 14, spectating with listen-only voice: hot, stuttering):
    /// the net never answers its own override, forces at most once per 5 s, and gives up for the
    /// call after 3 forces in 30 s (a route WebRTC keeps putting back).
    func testTheSafetyNetIsPacedAndGivesUp() {
        XCTAssertFalse(SpeakerForceGate.reacts(to: .override), "its own override never re-runs it")
        XCTAssertTrue(SpeakerForceGate.reacts(to: .categoryChange))
        XCTAssertTrue(SpeakerForceGate.reacts(to: .oldDeviceUnavailable))
        XCTAssertTrue(SpeakerForceGate.reacts(to: nil))

        var gate = SpeakerForceGate()
        XCTAssertTrue(gate.allow(at: 100))
        XCTAssertFalse(gate.allow(at: 101), "within 5 s of the last force")
        XCTAssertFalse(gate.allow(at: 104.9))
        XCTAssertTrue(gate.allow(at: 105))
        XCTAssertTrue(gate.allow(at: 110))
        XCTAssertFalse(gate.gaveUp)
        XCTAssertFalse(gate.allow(at: 115), "a 4th force within 30 s: a fight over the route")
        XCTAssertTrue(gate.gaveUp)
        XCTAssertFalse(gate.allow(at: 1000), "off for the rest of the call")

        var spaced = SpeakerForceGate()
        for t in stride(from: 0.0, through: 300, by: 31) { XCTAssertTrue(spaced.allow(at: t), "one force every 31 s is never a loop (\(t))") }
        XCTAssertFalse(spaced.gaveUp)
    }

    /// Churn telemetry: reported once, the first time more than 20 route changes land within 10 s.
    func testRouteChurnIsReportedOnce() {
        var meter = RouteChurnMeter()
        for k in 0..<20 { XCTAssertFalse(meter.record(reason: 8, at: Double(k) * 0.4)) }
        XCTAssertTrue(meter.record(reason: 3, at: 8.1), "the 21st within 10 s")
        XCTAssertFalse(meter.record(reason: 8, at: 8.2), "once")
        XCTAssertEqual(meter.summary, "reasons 8:21, 3:1")

        var calm = RouteChurnMeter()
        for k in 0..<100 { XCTAssertFalse(calm.record(reason: 8, at: Double(k)), "one a second") }
    }
}
