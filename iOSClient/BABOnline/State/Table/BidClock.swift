import Foundation

// The bid clock (owner 2026-11-18; contract/README.md "Bid clock", docs/ios-table-store.md
// "Bid clock"): a human seat idle 10 s into its bid turn gets a 30 s clock; the table plays
// the tune (bidclock.m4a, END-aligned with the deadline) and the bidder sees a countdown;
// when it runs out the server bids 0 for the seat. Shipped builds (<= 1.2.3 (14)) never
// register the event: they only see "<name> ran out of time." and the bid.

/// The running clock as the reducer keeps it: relative, as the wire says it (the reducer has
/// no clock). The store turns it into a deadline on its own monotonic clock the moment it
/// lands (`GameState.bidCountdown`).
struct BidClockState: Equatable {
    var position: Int
    /// ms left at receipt (the running event's, or the snapshot's own `inMs`).
    var inMs: Int
    /// The clock's full length (the countdown's scale; never assumed to be 30 s).
    var durationMs: Int
}

/// What the tune does (`TableEffect.bidClock`), played by `BidClockTune`.
enum BidClockCue: Equatable {
    /// A clock started, resumed or was restated (a running event, a snapshot carrying one):
    /// play the tune END-aligned with the store's deadline (keep it if it is already there).
    case sync
    /// The clock is gone.
    case stop(BidTuneStop)
}

enum BidTuneStop: Equatable {
    /// The clock that is playing is over (a bid, the turn moved, a deal, a snapshot without
    /// it): a short fade. Never cuts a timeout's ringing tail (critic C3).
    case fade
    /// The server's timeout: the tune is within its last moments, let its end cue ring
    /// (cut only if more than `BidClockTune.ringMax` would still be left locally).
    case ring
    /// The table is over for this clock (gameEnd, abortGame, leftGame, a reset, another game's
    /// snapshot, my socket dropped): stop everything, a ringing tail included.
    case hard
}

/// The running clock against the store's monotonic clock (`BidClockTime`).
struct BidCountdown: Equatable {
    var position: Int
    /// When the server bids 0 (store clock seconds): receipt + inMs.
    var deadline: TimeInterval
    var durationMs: Int
}

/// The monotonic clock the bid clock is measured on: ContinuousClock (keeps counting while the
/// device sleeps; not a required-reason API, unlike systemUptime), never the wall clock.
enum BidClockTime {
    private static let origin = ContinuousClock.now

    static func now() -> TimeInterval {
        let d = origin.duration(to: .now)
        return TimeInterval(d.components.seconds) + TimeInterval(d.components.attoseconds) / 1e18
    }
}

/// The bidder's countdown (BidClockPill), pure: what to show at `now`.
enum BidCountdownModel {
    /// Shown this much ahead of the server's deadline (critic C2): the deadline the client
    /// measures from receipt is late by the one-way delay, so a tap with "1" showing must still
    /// reach the server in time. The tune stays aligned with the real deadline.
    static let uiMargin: TimeInterval = 0.75
    /// The last seconds show in the warning colour.
    static let lowAt = 10
    /// After the countdown's 0, bidding stays closed this long waiting for the server's bid 0;
    /// if nothing came, it opens again (as the web).
    static let expiredGrace: TimeInterval = 5

    enum Display: Equatable {
        /// No countdown (not my clock, not my choice, or the expired grace is over).
        case hidden
        case seconds(Int, low: Bool)
        /// The countdown reached 0: no number, the bid buttons refuse until the bid 0 lands.
        case expired
    }

    /// `mine`: the clock is my seat's, I hold it (`.seat`) and the bid choice is mine now (not
    /// submitted).
    static func display(_ c: BidCountdown?, mine: Bool, now: TimeInterval) -> Display {
        guard let c, mine else { return .hidden }
        let left = c.deadline - uiMargin - now
        if left > 0 {
            let full = max(1, Int((Double(c.durationMs) / 1000).rounded(.up)))
            let n = min(Int(left.rounded(.up)), full)
            return .seconds(n, low: n <= lowAt)
        }
        return left > -expiredGrace ? .expired : .hidden
    }

    /// How often the countdown is redrawn while it shows.
    static let tick: TimeInterval = 0.25

    /// VoiceOver: "Time to bid: 27 seconds".
    static func label(_ n: Int) -> String { "Time to bid: \(n) \(n == 1 ? "second" : "seconds")" }
    /// The two announcements: when it appears and at `lowAt`.
    static func announcement(_ n: Int) -> String { "\(n) \(n == 1 ? "second" : "seconds") to bid" }
}
