import AVFoundation
import Combine
import UIKit

/// Table sounds (owner 2026-11-15: tasteful, on by default at a quiet volume, easy to mute).
/// The reducer says WHAT happened (`TableEffect.sound`, live delta events only); this says
/// whether and how it plays: muted, the app not active, the same sound within `throttle`.
///
/// Audio session (docs/claude/voice.md, "iOS sounds and voice"): voice chat (`VoiceChatManager`) owns the
/// session while it runs (playAndRecord / voiceChat, set before `isActive`), so a sound then
/// just plays through it and the session is never touched. Otherwise, right before a sound,
/// the category is made `.ambient` (the silent switch silences it, the user's music keeps
/// playing) if it is anything else: the launch default soloAmbient (would stop their music)
/// or the playAndRecord voice left behind when it shut down. Nothing touches the session
/// until the first sound, so a muted player never does.
@MainActor
protocol SoundPlaying: AnyObject {
    func play(_ kind: SoundKind)
}

/// The bid clock's tune (BidClockTune): one long file, END-aligned with the clock's deadline.
@MainActor
protocol TunePlaying: AnyObject {
    /// Time until the playing tune ends (s); nil when it is not playing (stopped, fading out,
    /// interrupted, never started).
    var tuneTimeLeft: TimeInterval? { get }
    /// The tune file's decoded length (s; C11: AAC priming makes it differ from 30.000 by tens
    /// of ms), nil until it is loaded.
    var tuneDuration: TimeInterval? { get }
    /// Plays the tune from `duration - remaining` so that it ends in `remaining` s. False when
    /// refused (sound off, volume 0, the app not active, the session) or the file is missing.
    @discardableResult
    func startTune(endingIn remaining: TimeInterval) -> Bool
    func stopTune(fade: TimeInterval)
}

/// The tune's own player (the app: AVAudioPlayer; tests: a recorder).
@MainActor
protocol TuneOutput: AnyObject {
    var timeLeft: TimeInterval? { get }
    var duration: TimeInterval? { get }
    func start(endingIn remaining: TimeInterval, volume: Float) -> Bool
    func setVolume(_ volume: Float)
    func stop(fade: TimeInterval)
}

/// Plays bundle files (the app: AVAudioPlayer; tests: a recorder).
@MainActor
protocol SoundOutput: AnyObject {
    func play(file: String, volume: Float)
}

/// The shared audio session as the player needs it (tests inject a fake).
@MainActor
protocol SoundSession: AnyObject {
    var category: AVAudioSession.Category { get }
    func useAmbient() throws
}

enum SoundSessionPolicy {
    enum Action: Equatable { case leave, setAmbient }

    static func action(voiceActive: Bool, category: AVAudioSession.Category) -> Action {
        if voiceActive { return .leave }
        return category == .ambient ? .leave : .setAmbient
    }
}

@MainActor
final class SoundPlayer: ObservableObject, SoundPlaying, TunePlaying {
    static let enabledKey = "soundEnabled"
    static let volumeKey = "soundVolume"
    /// Quiet: the files sit at -24 dBFS (cues -26), so this is well under the voice chat.
    static let defaultVolume: Float = 0.35
    /// The same sound again within this is dropped (a burst never stacks).
    static let throttle: TimeInterval = 0.08

    static let shared: SoundPlayer = {
        #if DEBUG
        let silent = UIFixture.isActive
        #else
        let silent = false
        #endif
        // hosted unit tests and UI fixtures never play or touch the session
        if silent || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
            return SoundPlayer(output: SilentSoundOutput(), session: InertSoundSession(), tune: SilentTuneOutput())
        }
        return SoundPlayer(output: AudioPlayerPool(), session: SystemSoundSession(), tune: AudioTuneOutput())
    }()

    @Published var isEnabled: Bool {
        didSet {
            defaults.set(isEnabled, forKey: Self.enabledKey)
            // the tune follows at once: off stops it, on lets BidClockTune pick it up where it is
            if isEnabled != oldValue {
                if isEnabled { tuneResync.send() } else { tune.stop(fade: BidClockTune.fade) }
            }
        }
    }
    @Published var volume: Float {
        didSet {
            let v = min(max(volume, 0), 1)
            if v != volume { volume = v; return }
            defaults.set(v, forKey: Self.volumeKey)
            if v == 0 { tune.stop(fade: BidClockTune.fade) } else { tune.setVolume(v * Self.tuneGain) }
            if v > 0 && oldValue <= 0 { tuneResync.send() }
        }
    }
    /// The tune's level against the player's volume (its file sits at -30 dBFS, under the cues).
    static let tuneGain: Float = 1
    /// Sound turned back on (or the volume up from 0): BidClockTune restarts a running clock's
    /// tune at its place.
    let tuneResync = PassthroughSubject<Void, Never>()

    private let output: SoundOutput
    private let tune: TuneOutput
    private let session: SoundSession
    private let defaults: UserDefaults
    private let isAppActive: @MainActor () -> Bool
    private let isVoiceActive: @MainActor () -> Bool
    private let now: () -> TimeInterval
    private var lastPlayed: [SoundKind: TimeInterval] = [:]
    private var takes: [SoundKind: Int] = [:]

    init(output: SoundOutput, session: SoundSession, tune: TuneOutput? = nil, defaults: UserDefaults = .standard,
         isAppActive: (@MainActor () -> Bool)? = nil, isVoiceActive: (@MainActor () -> Bool)? = nil,
         // the wall clock, not systemUptime (a required-reason API): a jump forward costs one
         // throttled sound at most, and a jump back counts as outside the window
         now: @escaping () -> TimeInterval = { Date().timeIntervalSinceReferenceDate }) {
        self.output = output
        self.tune = tune ?? SilentTuneOutput()
        self.session = session
        self.defaults = defaults
        self.isAppActive = isAppActive ?? { UIApplication.shared.applicationState == .active }
        self.isVoiceActive = isVoiceActive ?? { VoiceChatManager.shared.isActive }
        self.now = now
        isEnabled = defaults.object(forKey: Self.enabledKey) as? Bool ?? true
        volume = (defaults.object(forKey: Self.volumeKey) as? NSNumber).map { min(max($0.floatValue, 0), 1) } ?? Self.defaultVolume
    }

    func play(_ kind: SoundKind) { _ = playIfAllowed(kind) }

    /// The file played, or nil when skipped (tests).
    @discardableResult
    func playIfAllowed(_ kind: SoundKind) -> String? {
        // in the background (or under Control Center) a sound would be a surprise
        guard isEnabled, volume > 0, isAppActive() else { return nil }
        let t = now()
        if let last = lastPlayed[kind], t >= last, t - last < Self.throttle { return nil }
        lastPlayed[kind] = t
        guard prepareSession() else { return nil }
        let files = kind.files
        let take = takes[kind, default: 0]
        takes[kind] = (take + 1) % files.count
        let file = files[take]
        output.play(file: file, volume: volume * kind.gain)
        return file
    }

    // MARK: - The bid clock's tune

    var tuneTimeLeft: TimeInterval? { tune.timeLeft }
    var tuneDuration: TimeInterval? { tune.duration }

    /// As a sound: never muted, at volume 0, with the app not active (a background tune would be
    /// a surprise) or without the ambient session.
    @discardableResult
    func startTune(endingIn remaining: TimeInterval) -> Bool {
        guard isEnabled, volume > 0, isAppActive(), prepareSession() else { return false }
        return tune.start(endingIn: remaining, volume: volume * Self.tuneGain)
    }

    func stopTune(fade: TimeInterval) { tune.stop(fade: fade) }

    /// The session policy above, applied before every sound (cheap: a category read).
    /// False when the session could not be made ambient: a sound in the launch default
    /// (soloAmbient) would stop the user's music, so it is skipped.
    @discardableResult
    func prepareSession() -> Bool {
        // Voice owns the session: no AVAudioSession read at all (owner 2026-11-18, build 15 on an
        // iPhone Air: every sound froze the table ~1 s with voice on; a session getter is a
        // synchronous call into the audio server, which is busy while WebRTC runs).
        if isVoiceActive() { return true }
        let started = ProcessInfo.processInfo.systemUptime
        let category = session.category
        SoundStall.check("category read", seconds: ProcessInfo.processInfo.systemUptime - started, voiceActive: false)
        guard SoundSessionPolicy.action(voiceActive: false, category: category) == .setAmbient else { return true }
        do {
            try session.useAmbient()
            return true
        } catch {
            #if DEBUG
            print("[Sound] could not set the ambient category, sound skipped: \(error)")
            #endif
            return false
        }
    }
}

// MARK: - The app's output and session

/// A sound that took long on the audio path is reported once per launch per step (clientError
/// `soundStall`), so a device shows where the time went (owner 2026-11-18: table sounds froze
/// the table on an iPhone Air with voice on). Thread-safe.
enum SoundStall {
    static let threshold: TimeInterval = 0.1
    private static let lock = NSLock()
    nonisolated(unsafe) private static var reported: Set<String> = []

    static func check(_ step: String, seconds: TimeInterval, voiceActive: Bool) {
        guard seconds >= threshold else { return }
        lock.lock()
        let first = reported.insert(step).inserted
        lock.unlock()
        guard first else { return }
        let message = "\(step) took \(Int(seconds * 1000)) ms (voice \(voiceActive ? "on" : "off"))"
        print("[Sound] \(message)")
        ErrorReporter.shared.report(kind: "soundStall", message: message)
    }
}

/// The serial queue every AVAudioPlayer call runs on: starting a player can block for a long time
/// while voice holds the audio hardware, and on the main thread that froze the table at each
/// sound (owner 2026-11-18). A slow start now only delays its own sound.
enum SoundQueue {
    static let queue = DispatchQueue(label: "bab.sound", qos: .userInitiated)
}

/// Two players per file, created on the first sound (after the session is ambient: an
/// AVAudioPlayer prepared at launch would take the hardware in the default soloAmbient).
/// Every player call runs on `SoundQueue`; the main thread only hands the request over.
@MainActor
final class AudioPlayerPool: SoundOutput {
    private let engine = PoolEngine()

    func play(file: String, volume: Float) {
        let voiceActive = VoiceChatManager.shared.isActive
        let engine = self.engine
        SoundQueue.queue.async { engine.play(file: file, volume: volume, voiceActive: voiceActive) }
    }
}

/// The pool's players, touched only on `SoundQueue`.
private final class PoolEngine: @unchecked Sendable {
    private var players: [String: [AVAudioPlayer]] = [:]
    private static let perFile = 2

    func play(file: String, volume: Float, voiceActive: Bool) {
        if players.isEmpty {
            let started = ProcessInfo.processInfo.systemUptime
            preloadAll()
            SoundStall.check("preload", seconds: ProcessInfo.processInfo.systemUptime - started, voiceActive: voiceActive)
        }
        guard let pool = players[file], !pool.isEmpty else { return }
        // a free player, else restart the oldest one (never a third copy)
        let player = pool.first { !$0.isPlaying } ?? pool[0]
        let started = ProcessInfo.processInfo.systemUptime
        player.currentTime = 0
        player.volume = volume
        player.play()
        SoundStall.check("play", seconds: ProcessInfo.processInfo.systemUptime - started, voiceActive: voiceActive)
    }

    private func preloadAll() {
        for file in Set(SoundKind.allCases.flatMap(\.files)) {
            guard let url = Bundle.main.url(forResource: file, withExtension: "m4a") else { continue }
            players[file] = (0..<Self.perFile).compactMap { _ in
                let p = try? AVAudioPlayer(contentsOf: url)
                p?.prepareToPlay()
                return p
            }
        }
    }
}

/// The tune's own AVAudioPlayer, outside the two-per-file pool (a 30 s file, made on the first
/// start, after the session is ambient). A stop fades the volume out, then stops; a start
/// meanwhile cancels that stop.
@MainActor
final class AudioTuneOutput: TuneOutput {
    static let file = "bidclock"
    private var player: AVAudioPlayer?
    private var stopping: DispatchWorkItem?

    private func loaded() -> AVAudioPlayer? {
        if player == nil, let url = Bundle.main.url(forResource: Self.file, withExtension: "m4a") {
            player = try? AVAudioPlayer(contentsOf: url)
            player?.prepareToPlay()
        }
        return player
    }

    var duration: TimeInterval? { player?.duration }

    /// When the playing tune ends (systemUptime), kept on main: the player itself is started on
    /// `SoundQueue` and may not have begun yet when the clock asks.
    private var endsAt: TimeInterval?
    private var nowUptime: TimeInterval { ProcessInfo.processInfo.systemUptime }

    var timeLeft: TimeInterval? {
        guard let end = endsAt, stopping == nil else { return nil }
        let left = end - nowUptime
        return left > 0 ? left : nil
    }

    func start(endingIn remaining: TimeInterval, volume: Float) -> Bool {
        guard let p = loaded() else { return false }
        stopping?.cancel()
        stopping = nil
        // on the sound queue, as the pool's players (a start can block while voice holds the
        // hardware); the clock reads timeLeft from the player afterwards
        let box = PlayerBox(p)
        let voiceActive = VoiceChatManager.shared.isActive
        endsAt = nowUptime + min(remaining, p.duration)
        SoundQueue.queue.async {
            let started = ProcessInfo.processInfo.systemUptime
            box.player.stop()
            box.player.currentTime = max(0, box.player.duration - remaining)
            box.player.setVolume(volume, fadeDuration: 0)
            box.player.play()
            SoundStall.check("tune play", seconds: ProcessInfo.processInfo.systemUptime - started, voiceActive: voiceActive)
        }
        return true
    }

    func setVolume(_ volume: Float) {
        guard stopping == nil, let p = player else { return }
        let box = PlayerBox(p)
        SoundQueue.queue.async { box.player.setVolume(volume, fadeDuration: 0) }
    }

    func stop(fade: TimeInterval) {
        guard let p = player, endsAt != nil, stopping == nil else { return }
        endsAt = nil
        let box = PlayerBox(p)
        guard fade > 0 else {
            SoundQueue.queue.async { box.player.stop() }
            return
        }
        SoundQueue.queue.async { box.player.setVolume(0, fadeDuration: fade) }
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.stopping = nil }
            SoundQueue.queue.async { box.player.stop() }
        }
        stopping = work
        DispatchQueue.main.asyncAfter(deadline: .now() + fade, execute: work)
    }
}

/// Hands an AVAudioPlayer to `SoundQueue` (AVAudioPlayer is not Sendable).
private final class PlayerBox: @unchecked Sendable {
    let player: AVAudioPlayer
    init(_ player: AVAudioPlayer) { self.player = player }
}

@MainActor
final class SilentTuneOutput: TuneOutput {
    var timeLeft: TimeInterval? { nil }
    var duration: TimeInterval? { nil }
    func start(endingIn remaining: TimeInterval, volume: Float) -> Bool { false }
    func setVolume(_ volume: Float) {}
    func stop(fade: TimeInterval) {}
}

@MainActor
final class SystemSoundSession: SoundSession {
    var category: AVAudioSession.Category { AVAudioSession.sharedInstance().category }
    func useAmbient() throws {
        // ambient mixes with other audio, so activating it never interrupts the user's music
        try AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default, options: [])
    }
}

@MainActor
final class SilentSoundOutput: SoundOutput {
    func play(file: String, volume: Float) {}
}

@MainActor
final class InertSoundSession: SoundSession {
    var category: AVAudioSession.Category { .ambient }
    func useAmbient() throws {}
}
