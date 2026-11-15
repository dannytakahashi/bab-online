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
final class SoundPlayer: ObservableObject, SoundPlaying {
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
            return SoundPlayer(output: SilentSoundOutput(), session: InertSoundSession())
        }
        return SoundPlayer(output: AudioPlayerPool(), session: SystemSoundSession())
    }()

    @Published var isEnabled: Bool {
        didSet { defaults.set(isEnabled, forKey: Self.enabledKey) }
    }
    @Published var volume: Float {
        didSet {
            let v = min(max(volume, 0), 1)
            if v != volume { volume = v }
            defaults.set(v, forKey: Self.volumeKey)
        }
    }

    private let output: SoundOutput
    private let session: SoundSession
    private let defaults: UserDefaults
    private let isAppActive: @MainActor () -> Bool
    private let isVoiceActive: @MainActor () -> Bool
    private let now: () -> TimeInterval
    private var lastPlayed: [SoundKind: TimeInterval] = [:]
    private var takes: [SoundKind: Int] = [:]

    init(output: SoundOutput, session: SoundSession, defaults: UserDefaults = .standard,
         isAppActive: (@MainActor () -> Bool)? = nil, isVoiceActive: (@MainActor () -> Bool)? = nil,
         // the wall clock, not systemUptime (a required-reason API): a jump costs one throttled sound at most
         now: @escaping () -> TimeInterval = { Date().timeIntervalSinceReferenceDate }) {
        self.output = output
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
        if let last = lastPlayed[kind], t - last < Self.throttle { return nil }
        lastPlayed[kind] = t
        prepareSession()
        let files = kind.files
        let take = takes[kind, default: 0]
        takes[kind] = (take + 1) % files.count
        let file = files[take]
        output.play(file: file, volume: volume)
        return file
    }

    /// The session policy above, applied before every sound (cheap: a category read).
    func prepareSession() {
        guard SoundSessionPolicy.action(voiceActive: isVoiceActive(), category: session.category) == .setAmbient else { return }
        do { try session.useAmbient() } catch {
            #if DEBUG
            print("[Sound] could not set the ambient category: \(error)")
            #endif
        }
    }
}

// MARK: - The app's output and session

/// Two players per file, created on the first sound (after the session is ambient: an
/// AVAudioPlayer prepared at launch would take the hardware in the default soloAmbient).
@MainActor
final class AudioPlayerPool: SoundOutput {
    private var players: [String: [AVAudioPlayer]] = [:]
    private static let perFile = 2

    func play(file: String, volume: Float) {
        if players.isEmpty { preloadAll() }
        guard let pool = players[file], !pool.isEmpty else { return }
        // a free player, else restart the oldest one (never a third copy)
        let player = pool.first { !$0.isPlaying } ?? pool[0]
        player.currentTime = 0
        player.volume = volume
        player.play()
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
