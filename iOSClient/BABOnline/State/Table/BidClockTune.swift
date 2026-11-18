import Foundation

/// The bid clock's tune at the table (contract/README.md "Bid clock", docs/ios-table-store.md
/// "Bid clock"): everyone at the table hears it (seat, lazy watcher, spectator), each with
/// their own sound setting and volume (SoundPlayer). The reducer says what happened
/// (`TableEffect.bidClock`); this keeps the tune where the store's clock says it should be:
/// - END-aligned: it plays from `duration - remaining`, so its "time's up" cue lands on the
///   server's bid 0 (the file's decoded length, never a constant: C11), and is not started
///   with less than `minStart` left
/// - a restated clock (a snapshot, a resync, a repeated running) whose end is within
///   `tolerance` of the playing tune's keeps it playing; otherwise it restarts at its place
/// - a timeout lets the last moments ring (`ringMax` at most), detached from any clock: the
///   bid 0 and the turn that follow do not cut it (C3); only a hard stop (game end, abort,
///   leaving, a reset, my socket dropping), the app leaving the foreground or a new clock do
/// - sound back on, the volume up from 0 and the app active again resync it
@MainActor
final class BidClockTune {
    static let fade: TimeInterval = 0.12
    static let tolerance: TimeInterval = 0.75
    static let minStart: TimeInterval = 1.0
    static let ringMax: TimeInterval = 1.5

    private let player: TunePlaying
    /// Seconds until the store's deadline; nil when no clock runs.
    private let remaining: @MainActor () -> TimeInterval?

    /// Playing for the clock that runs now.
    private(set) var playing = false
    /// A timeout's tail, left to ring out.
    private(set) var ringing = false

    init(player: TunePlaying, remaining: @escaping @MainActor () -> TimeInterval?) {
        self.player = player
        self.remaining = remaining
    }

    func handle(_ cue: BidClockCue) {
        switch cue {
        case .sync:
            sync()
        case .stop(.fade):
            guard playing else { return }
            playing = false
            player.stopTune(fade: Self.fade)
        case .stop(.ring):
            guard playing else { return }
            playing = false
            // within its last moments: let the end cue ring; otherwise (a device whose clock ran
            // slow, a tune restarted late) it would play on well past the bid
            if let left = player.tuneTimeLeft, left <= Self.ringMax {
                ringing = true
            } else {
                player.stopTune(fade: Self.fade)
            }
        case .stop(.hard):
            guard playing || ringing else { return }
            playing = false
            ringing = false
            player.stopTune(fade: Self.fade)
        }
    }

    /// Where the tune should be now: started, kept, moved or stopped.
    func sync() {
        guard let left = remaining(), left > 0 else {
            if playing { handle(.stop(.fade)) }
            return
        }
        if ringing {
            // a new clock: the old tail goes
            ringing = false
            player.stopTune(fade: 0)
        }
        // in place: it ends with the clock (within `tolerance`), or, for a clock longer than the
        // file (a test's override), it plays and ends before it
        if playing, let t = player.tuneTimeLeft {
            if abs(t - left) <= Self.tolerance { return }
            if let d = player.tuneDuration, left > d, t < left { return }
        }
        guard left >= Self.minStart else {
            if playing { handle(.stop(.fade)) }
            return
        }
        playing = player.startTune(endingIn: left)
    }

    /// The app left the foreground: nothing plays in the background (a later `sync` on
    /// becoming active again picks up a running clock at its place).
    func backgrounded() {
        guard playing || ringing else { return }
        playing = false
        ringing = false
        player.stopTune(fade: 0)
    }
}
