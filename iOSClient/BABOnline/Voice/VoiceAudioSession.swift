#if os(iOS)
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

/// The safety net's pacing (owner 2026-11-18: an iPhone Air on build 14, spectating with
/// listen-only voice, ran hot and stuttered; the net reacted to every route change, its own
/// override's included, so a route WebRTC keeps putting back could ping-pong with it). Pure.
struct SpeakerForceGate {
    /// At most one forced speaker per this many seconds.
    static let minInterval: TimeInterval = 5
    /// This many forces within `loopWindow` is a fight over the route: the net stops for the call.
    static let loopThreshold = 3
    static let loopWindow: TimeInterval = 30

    private(set) var forces: [TimeInterval] = []
    private(set) var gaveUp = false

    /// A route change the app's own override caused never runs the net again.
    static func reacts(to reason: AVAudioSession.RouteChangeReason?) -> Bool { reason != .override }

    /// May the net force the speaker at `now` (seconds, any monotonic clock)? Records it if so.
    mutating func allow(at now: TimeInterval) -> Bool {
        if gaveUp { return false }
        forces = forces.filter { now - $0 < Self.loopWindow }
        if let last = forces.last, now - last < Self.minInterval { return false }
        if forces.count >= Self.loopThreshold {
            gaveUp = true
            return false
        }
        forces.append(now)
        return true
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
    /// Route changes and media services resets, watched while active.
    private var observers: [NSObjectProtocol] = []
    /// The safety net's pacing for this call (reset by `deactivate`).
    private var gate = SpeakerForceGate()
    private var churn = RouteChurnMeter()
    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

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
        if observers.isEmpty {
            // Posted on AVAudioSession's own thread, possibly while WebRTC holds the session
            // lock; handled later on main, never inside a lock.
            let center = NotificationCenter.default
            observers = [
                center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { note in
                    let raw = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
                    DispatchQueue.main.async { VoiceAudioSession.shared.routeChanged(rawReason: raw) }
                },
                center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { _ in
                    DispatchQueue.main.async { VoiceAudioSession.shared.restoreAfterMediaServicesReset() }
                },
            ]
        }
        forceSpeakerIfNeeded(rtc)
    }

    /// Drops our activation (WebRTC deactivates with `.notifyOthersOnDeactivation` once its
    /// audio unit has stopped too); the category is kept.
    func deactivate() {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        gate = SpeakerForceGate()
        churn = RouteChurnMeter()
        guard activated else { return }
        activated = false
        let rtc = RTCAudioSession.sharedInstance()
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        try? rtc.setActive(false)
    }

    /// Every route change: counted (churn telemetry), then the net, except for the app's own
    /// override, checked without the session lock (WebRTC's worker holds it through its whole
    /// audio unit set-up, when route changes cluster), locked only to force.
    private func routeChanged(rawReason: UInt?) {
        guard activated else { return }
        if churn.record(reason: rawReason ?? 0, at: now) {
            let message = "over \(RouteChurnMeter.limit) audio route changes in \(Int(RouteChurnMeter.window)) s while voice runs; \(churn.summary); speaker forced \(gate.forces.count)x"
            print("[Voice] \(message)")
            ErrorReporter.shared.report(kind: "voiceRouteChurn", message: message)
        }
        guard SpeakerForceGate.reacts(to: rawReason.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))) else { return }
        keepSpeaker()
    }

    private func keepSpeaker() {
        guard activated, Self.receiverAlone(RTCAudioSession.sharedInstance().session) else { return }
        let rtc = RTCAudioSession.sharedInstance()
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        forceSpeakerIfNeeded(rtc)
    }

    /// A media services reset puts the session back to iOS's default category and WebRTC only
    /// re-activates it (`updateAudioSessionAfterEvent`, no `configureWebRTCSession`), so the
    /// category, mode and options go back on.
    private func restoreAfterMediaServicesReset() {
        guard activated else { return }
        let rtc = RTCAudioSession.sharedInstance()
        rtc.lockForConfiguration()
        defer { rtc.unlockForConfiguration() }
        do {
            try rtc.setCategory(VoiceAudioPolicy.category, mode: VoiceAudioPolicy.mode, options: VoiceAudioPolicy.options)
            print("[Voice] media services were reset, voice's category set again")
        } catch {
            print("[Voice] could not set voice's category after a media services reset: \(error)")
        }
        forceSpeakerIfNeeded(rtc)
    }

    /// Voice's category on the receiver alone with nothing plugged in or paired (reads only:
    /// AVAudioSession's getters need no RTCAudioSession lock).
    private static func receiverAlone(_ session: AVAudioSession) -> Bool {
        guard session.category == VoiceAudioPolicy.category else { return false }
        let outputs = session.currentRoute.outputs.map(\.portType)
        let inputs = (session.availableInputs ?? []).map(\.portType)
        return VoiceAudioPolicy.shouldForceSpeaker(outputs: outputs, availableInputs: inputs)
    }

    /// Call with the lock held (checks again under it).
    private func forceSpeakerIfNeeded(_ rtc: RTCAudioSession) {
        guard Self.receiverAlone(rtc.session) else { return }
        let wasGivenUp = gate.gaveUp
        guard gate.allow(at: now) else {
            if gate.gaveUp && !wasGivenUp {
                let message = "speaker forced \(SpeakerForceGate.loopThreshold)x in \(Int(SpeakerForceGate.loopWindow)) s and the receiver came back: safety net off for this call"
                print("[Voice] \(message)")
                ErrorReporter.shared.report(kind: "voiceRoute", message: message)
            }
            return
        }
        do {
            try rtc.overrideOutputAudioPort(.speaker)
            print("[Voice] route was the receiver, forced the speaker")
        } catch {
            print("[Voice] could not force the speaker: \(error)")
        }
    }
}

/// iOS's voice routing (VoiceAudio.routing).
extension VoiceAudioSession: VoiceAudioRouting {}

typealias PlatformVoiceAudio = VoiceAudioSession
#endif
