import XCTest
import AVFoundation
@preconcurrency import WebRTC
@testable import BAB_Online

/// Voice's audio session values and the loudspeaker safety net (owner 2026-11-17, iPhone Air:
/// voice only from the earpiece). Pure: nothing here touches AVAudioSession or RTCAudioSession;
/// the real route is only heard on a device (the simulator has no earpiece).
final class VoiceAudioSessionTests: XCTestCase {
    func testTheSessionValues() {
        XCTAssertEqual(VoiceAudioPolicy.category, .playAndRecord)
        XCTAssertEqual(VoiceAudioPolicy.mode, .voiceChat, "the VoiceProcessingIO unit: echo cancellation stays on")
        XCTAssertTrue(VoiceAudioPolicy.options.contains(.defaultToSpeaker), "the loudspeaker, not the earpiece")
        XCTAssertTrue(VoiceAudioPolicy.options.contains(.allowBluetoothHFP), "AirPods / headsets with their mic")
        XCTAssertFalse(VoiceAudioPolicy.options.contains(.allowBluetoothA2DP))
        XCTAssertFalse(VoiceAudioPolicy.options.contains(.mixWithOthers))
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
}
