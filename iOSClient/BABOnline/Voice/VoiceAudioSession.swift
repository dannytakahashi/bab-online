import AVFoundation
// WebRTC's ObjC types aren't annotated Sendable; RTCAudioSession is thread-safe (its own lock).
@preconcurrency import WebRTC

/// The audio session voice chat runs on, as pure values (docs/claude/voice.md, "iOS sounds and
/// voice"): playAndRecord / voiceChat (WebRTC's VoiceProcessingIO unit, echo cancellation on),
/// loudspeaker by default, a Bluetooth headset (HFP) or wired headphones take over when
/// connected.
///
/// Why WebRTC gets the same values (owner 2026-11-17, iPhone Air: voice only from the
/// earpiece): when a call starts playout WebRTC's audio device module calls
/// `RTCAudioSession configureWebRTCSession`, which applies
/// `RTCAudioSessionConfiguration.webRTCConfiguration`. Its default options are only
/// `AllowBluetooth` (no `DefaultToSpeaker`), and `setConfiguration` sets the category again
/// whenever the options differ, so the app's `.defaultToSpeaker` was dropped and the route
/// fell back to the receiver.
enum VoiceAudioPolicy {
    static let category = AVAudioSession.Category.playAndRecord
    static let mode = AVAudioSession.Mode.voiceChat
    /// Not `.allowBluetoothA2DP`: with HFP also allowed, iOS picks HFP for a device that has
    /// both (AirPods and other headsets), so it would only add output-only Bluetooth speakers,
    /// which then take the voice off the phone while its mic records.
    static let options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .allowBluetoothHFP]

    /// WebRTC's own configuration with this category, mode and options; sample rate, I/O
    /// buffer and channel counts stay WebRTC's defaults. Builds an object, touches no session.
    static func webRTCConfiguration() -> RTCAudioSessionConfiguration {
        let config = RTCAudioSessionConfiguration()
        config.category = category.rawValue
        config.mode = mode.rawValue
        config.categoryOptions = options
        return config
    }

    /// Ports a person plugs in or pairs (a headset, Bluetooth, the car, USB, AirPlay...):
    /// voice is theirs whenever one of them is an output or an available input.
    static let externalPorts: Set<AVAudioSession.Port> = [
        .headphones, .headsetMic, .lineOut, .lineIn,
        .bluetoothHFP, .bluetoothA2DP, .bluetoothLE,
        .carAudio, .usbAudio, .HDMI, .airPlay, .AVB, .displayPort, .PCI, .fireWire, .thunderbolt,
    ]

    /// The safety net: voice plays through the receiver (earpiece) and nothing a person
    /// plugged in or paired is around, so the loudspeaker is forced. Never with a headset,
    /// Bluetooth or the car (as an output or an available input: someone who picked
    /// "iPhone" in the route picker keeps it).
    static func shouldForceSpeaker(outputs: [AVAudioSession.Port], availableInputs: [AVAudioSession.Port]) -> Bool {
        guard !outputs.isEmpty, outputs.allSatisfy({ $0 == .builtInReceiver }) else { return false }
        return !availableInputs.contains(where: externalPorts.contains)
    }
}

/// The live audio session for `VoiceChatManager.Hooks.live`, through `RTCAudioSession` so
/// WebRTC's activation count includes the app's (with raw AVAudioSession calls WebRTC held the
/// only count and deactivated the session whenever its audio unit stopped). Never used by the
/// unit tests (silent hooks and `SilentAudioDevice`).
@MainActor
final class VoiceAudioSession {
    static let shared = VoiceAudioSession()

    /// WebRTC's configuration replaced by the app's, before any audio unit can start (called
    /// where the app's factory with WebRTC's default audio device module is made).
    nonisolated static func installWebRTCConfiguration() {
        RTCAudioSessionConfiguration.setWebRTC(VoiceAudioPolicy.webRTCConfiguration())
    }

    /// One activation of ours is held (balanced by `deactivate`).
    private var activated = false
    private var routeObserver: NSObjectProtocol?

    /// Category, mode and options, then active; the route safety net watches while it runs.
    func activate() throws {
        Self.installWebRTCConfiguration()
        let rtc = RTCAudioSession.sharedInstance()
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        try rtc.setCategory(VoiceAudioPolicy.category, mode: VoiceAudioPolicy.mode, options: VoiceAudioPolicy.options)
        if !activated {
            try rtc.setActive(true)
            activated = true
        }
        if routeObserver == nil {
            // Posted on AVAudioSession's own thread, possibly while WebRTC holds the session
            // lock; the check runs later on main, never inside a lock.
            routeObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
            ) { _ in
                DispatchQueue.main.async { VoiceAudioSession.shared.keepSpeaker() }
            }
        }
        forceSpeakerIfNeeded(rtc)
    }

    /// Drops our activation (WebRTC deactivates with `.notifyOthersOnDeactivation` once its
    /// audio unit has stopped too); the category is kept.
    func deactivate() {
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
        routeObserver = nil
        guard activated else { return }
        activated = false
        let rtc = RTCAudioSession.sharedInstance()
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        try? rtc.setActive(false)
    }

    private func keepSpeaker() {
        guard activated else { return }
        let rtc = RTCAudioSession.sharedInstance()
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        forceSpeakerIfNeeded(rtc)
    }

    /// Call with the lock held.
    private func forceSpeakerIfNeeded(_ rtc: RTCAudioSession) {
        let session = rtc.session
        guard session.category == VoiceAudioPolicy.category else { return }
        let outputs = session.currentRoute.outputs.map(\.portType)
        let inputs = (session.availableInputs ?? []).map(\.portType)
        guard VoiceAudioPolicy.shouldForceSpeaker(outputs: outputs, availableInputs: inputs) else { return }
        do {
            try rtc.overrideOutputAudioPort(.speaker)
            print("[Voice] route was the receiver, forced the speaker")
        } catch {
            print("[Voice] could not force the speaker: \(error)")
        }
    }
}
