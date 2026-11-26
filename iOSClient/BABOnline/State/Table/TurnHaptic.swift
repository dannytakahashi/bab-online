import Foundation
import Combine

/// "Vibrate on my turn" (player request, owner 2026-11-26): the Account sheet's switch, kept in
/// UserDefaults like the sound's ("vibrateOnTurn", default on).
@MainActor
final class HapticSettings: ObservableObject {
    static let turnKey = "vibrateOnTurn"
    static let shared = HapticSettings()

    @Published var vibratesOnTurn: Bool {
        didSet { defaults.set(vibratesOnTurn, forKey: Self.turnKey) }
    }

    /// The switch is offered on a phone only (review of PR #430): an iPad has no haptic engine,
    /// so there it would do nothing.
    nonisolated static func isOffered(on device: DeviceClass) -> Bool { device == .phone }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        vibratesOnTurn = defaults.object(forKey: Self.turnKey) as? Bool ?? true
    }
}

/// The one tap when my seat's bid or play turn opens. The reducer emits `.haptic(.myTurn(cue))`
/// on the live edge into my choice only (never a snapshot, a resync's replay, a re-render, a
/// lazy seat, a watcher or a spectator); this plays it:
/// - once per turn (`TurnCue`): the same turn seen open again never taps again;
/// - `delay` after the turn opened, and only if that turn is still mine then: when I win a
///   trick the server opens my lead with the trick's end, and the collect's own `success`
///   haptic would merge with this one; a deal's turn lands mid-deal instead of under it;
/// - only with the setting on and the app active when it plays (a turn that opened in the
///   background, or under Control Center, never taps later at the foreground).
///
/// The kind: a medium impact (`HapticManager.mediumImpact`), one firm tap, noticeable in a
/// hand or a pocket without reading as an alert. `success` is already the trick collect's
/// (and its double pulse would say "done", not "you're up"); warning / error are alarms.
@MainActor
final class TurnHaptic {
    /// After the trick collect's flight (0.4 s) has started and its haptic played.
    static let delay: TimeInterval = 0.45

    private let clock: AckClock
    private let isEnabled: @MainActor () -> Bool
    private let isAppActive: @MainActor () -> Bool
    private let isStillOpen: @MainActor (TurnCue) -> Bool
    private let play: @MainActor (TurnCue) -> Void
    private var lastCue: TurnCue?
    private var pending: AckCancellable?

    init(clock: AckClock,
         isEnabled: @escaping @MainActor () -> Bool,
         isAppActive: @escaping @MainActor () -> Bool,
         isStillOpen: @escaping @MainActor (TurnCue) -> Bool,
         play: @escaping @MainActor (TurnCue) -> Void) {
        self.clock = clock
        self.isEnabled = isEnabled
        self.isAppActive = isAppActive
        self.isStillOpen = isStillOpen
        self.play = play
    }

    /// The reducer's `.haptic(.myTurn(cue))`.
    func turnOpened(_ cue: TurnCue) {
        guard cue != lastCue else { return }
        lastCue = cue
        pending?.cancel()
        pending = clock.after(Self.delay) { [weak self] in
            guard let self else { return }
            self.pending = nil
            guard self.isStillOpen(cue), self.isEnabled(), self.isAppActive() else { return }
            self.play(cue)
        }
    }
}
