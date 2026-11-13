/// What Leave (`/leave` from my seat) will do, told before I confirm it (owner, 2026-11-12:
/// a solo game with bots said a bot would finish my hand, but the game ended).
///
/// The server (seatLifecycle.leaveSeat, then maybeAbort): a bot keeps my seat for good, and
/// the game goes on while another seat's owner is connected or may still come back (grace,
/// resignable, or a lazy / resigned owner who is away; that owner only keeps it alive for the
/// 60 s abandon timer if nobody returns). When no other owner can return, the game is aborted
/// at once ("All players left"). Native bots (lobby, tournament filler) are no one. At a
/// tournament table the abort ends that table's game with no round score for anyone at it
/// (an aborted tournament game records none), and I stay in the tournament.
///
/// Read from the seats iOS already has (snapshot `seats`, then the presence events). A seat a
/// bot plays for its owner (lazyBot, resignBot) can go `gone` with no event: /leave from a
/// human seat only broadcasts `playerLazyMode` (seen here as lazyBot, connected), and /leave
/// from an owner already lazy or resigned broadcasts nothing; only a snapshot shows `gone`.
/// So when such seats are the only other owners, the outcome is `.unsure` (a hedged message)
/// until a snapshot asked for on Leave (`LocalAction.leaveAsked`) lands (`verified`).
enum LeaveOutcome: Equatable {
    /// Another owner is here or may come back: a bot plays my seat and the game goes on.
    case botFinishes
    /// No other owner: leaving ends the game.
    case endsGame
    /// No other owner at my tournament table: leaving ends this table's game, unscored.
    case endsTournamentTable
    /// The only other owners have a bot at their seat and may have left with no event saying
    /// so (not verified by a fresh snapshot): either a bot finishes or the game ends.
    case unsure(inTournament: Bool)

    /// The presences of a seat whose owner is here or may still return (the server's
    /// `CONNECTED` plus `isReturnable`: GRACE, RESIGNABLE, AWAY).
    static let ownerCanReturn: Set<SeatPresence> = [.connected, .grace, .resignable, .away]

    /// Controllers whose owner can leave for good (-> gone) with no event to the room.
    static let mayLeaveUnannounced: Set<SeatController> = [.lazyBot, .resignBot]

    /// `seats` the table's seats, `myPosition` my seat (excluded), `inTournament` a tournament
    /// table, `verified` the seats come from a snapshot taken since Leave was tapped.
    /// A table not fully known yet (fewer than 4 seats) keeps the bot message.
    static func of(seats: [Int: SeatState], myPosition: Int?, inTournament: Bool, verified: Bool = false) -> LeaveOutcome {
        guard seats.count >= 4 else { return .botFinishes }
        let owners = seats.values.filter { seat in
            seat.position != myPosition && seat.controller != .bot && ownerCanReturn.contains(seat.presence)
        }
        if owners.isEmpty { return inTournament ? .endsTournamentTable : .endsGame }
        if verified || owners.contains(where: { !mayLeaveUnannounced.contains($0.controller) }) { return .botFinishes }
        return .unsure(inTournament: inTournament)
    }

    /// The Leave confirmation's message.
    var alertMessage: String {
        switch self {
        case .botFinishes:
            return "A bot will finish your hand for you."
        case .endsGame:
            return "You're the only player here, so leaving ends the game."
        case .endsTournamentTable:
            return "You're the only player at this table, so leaving ends its game with no score for this round. You stay in the tournament."
        case .unsure(false):
            return "A bot will finish your hand for you, unless everyone else has left too: then leaving ends the game."
        case .unsure(true):
            return "A bot will finish your hand for you, unless everyone else at this table has left too: then leaving ends its game with no score for this round. You stay in the tournament."
        }
    }

    /// The `/leave` line in the game log's command list (at a seat; a pure spectator's says "Exit spectating").
    var commandHelp: String {
        switch self {
        case .botFinishes: return "Leave the game (bot finishes for you)"
        case .endsGame: return "Leave and end the game (you're the only player)"
        case .endsTournamentTable: return "Leave and end this table's game (no score)"
        case .unsure: return "Leave the game (a bot takes over; ends it if you're the only player)"
        }
    }
}

/// Leave's check while its confirmation is up (`LocalAction.leaveAsked` .. `leaveClosed`).
/// `.idle` means no Leave is up (closed, or the table was reset); every other case means it
/// is up, so another owner's lazy mode or resignation checks it again (TableReducer.checkLeave)
/// whatever the outcome was when it opened.
enum LeaveCheck: Equatable {
    case idle
    /// Up with a definite outcome: nothing to ask the server.
    case settled
    /// Up and `.unsure`: asked for a snapshot.
    case pending(requestId: String)
    /// Up, and a snapshot landed since (LeaveOutcome `verified`).
    case verified

    var isPending: Bool { if case .pending = self { return true } else { return false } }
}

/// When the Leave confirmation shows (GameContainerView runs the steps with
/// LeaveAlertPresenter). An open alert keeps the message it opened with (a live run with the
/// SwiftUI alert: the snapshot landed, the open alert still hedged), so the alert waits for
/// Leave's snapshot check before it opens (`.wait`, then `.present` once settled or after
/// `timeout`). An open alert whose words change closes and reopens with the new ones; the
/// reopen runs from the close's real dismissal (`dismissed`, called from UIKit's completion).
/// When the change is a check in flight (another owner went lazy, so may have left), the open
/// alert holds for the reply (at most `timeout`) and closes only if the settled words differ:
/// one reopen, straight to the settled words, and none at all when the other owner is still there.
struct LeaveAlertFlow: Equatable {
    enum Step: Equatable {
        case none
        /// Open the alert now (call `presented`).
        case present
        /// Wait for the check, or until `timeout` passes (then call `timedOut(wait:)` with this wait's number).
        case wait(Int)
        /// Dismiss the open alert; `dismissed` says what follows.
        case close
    }

    /// The longest Leave waits for its snapshot before the alert opens (or reopens) hedged.
    static let timeout: Double = 1.5

    /// The outcome the open alert shows (nil: none open).
    private(set) var shown: LeaveOutcome?
    /// Leave tapped, the alert not open yet: waiting for the check.
    private(set) var waiting = false
    /// The alert is open and a check is in flight: it holds until the check settles.
    private(set) var holding = false
    private(set) var reopening = false
    /// The reopen follows a hold that timed out: open at once (hedged), no second wait.
    private(set) var reopenNow = false
    /// Numbers each wait, so a stale timeout does nothing.
    private(set) var waits = 0

    /// Leave tapped, after `LocalAction.leaveAsked` (`check` its result).
    mutating func tapped(check: LeaveCheck) -> Step {
        guard shown == nil else { return .none }
        if check.isPending { return startWait() }
        return .present
    }

    private mutating func startWait() -> Step {
        waiting = true
        waits += 1
        return .wait(waits)
    }

    /// The outcome or the check changed.
    mutating func changed(outcome: LeaveOutcome, check: LeaveCheck) -> Step {
        if waiting {
            switch check {
            case .pending: return .none
            case .verified, .settled: return .present
            case .idle:  // the table was reset (game over, a new game): Leave is moot
                waiting = false
                return .none
            }
        }
        guard let shown, !reopening else { return .none }
        if check.isPending {
            // a check in flight: hold the open alert for its reply instead of flashing the hedge
            guard shown != outcome, !holding else { return .none }
            holding = true
            waits += 1
            return .wait(waits)
        }
        holding = false
        guard shown != outcome else { return .none }
        reopening = true
        return .close
    }

    mutating func timedOut(wait: Int) -> Step {
        guard wait == waits else { return .none }
        if waiting { return .present }
        if holding, shown != nil, !reopening {
            // no reply in time: reopen at once with the hedged words
            holding = false
            reopening = true
            reopenNow = true
            return .close
        }
        return .none
    }

    /// The alert opened showing `outcome`.
    mutating func presented(_ outcome: LeaveOutcome) {
        shown = outcome
        waiting = false
        holding = false
    }

    /// The alert went away. A reopen waits for a pending check (unless that wait already timed
    /// out), else opens again; otherwise Leave is over (`ends`: send `LocalAction.leaveClosed`).
    mutating func dismissed(check: LeaveCheck) -> (next: Step, ends: Bool) {
        shown = nil
        holding = false
        guard reopening else { return (.none, true) }
        reopening = false
        let now = reopenNow
        reopenNow = false
        if check.isPending, !now { return (startWait(), false) }
        return (.present, false)
    }
}
