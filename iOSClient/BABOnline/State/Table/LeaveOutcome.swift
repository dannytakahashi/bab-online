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
/// Read from the seats iOS already has (snapshot `seats`, then the presence events). One
/// gap: a seat whose owner /leave'd earlier is `gone` on the server, but no event says so
/// (only `playerLazyMode`, or nothing for an already-lazy owner), so until the next snapshot
/// it still counts here as an owner who may return and the alert says a bot finishes.
enum LeaveOutcome: Equatable {
    /// Another owner is here or may come back: a bot plays my seat and the game goes on.
    case botFinishes
    /// No other owner: leaving ends the game.
    case endsGame
    /// No other owner at my tournament table: leaving ends this table's game, unscored.
    case endsTournamentTable

    /// The presences of a seat whose owner is here or may still return (the server's
    /// `CONNECTED` plus `isReturnable`: GRACE, RESIGNABLE, AWAY).
    static let ownerCanReturn: Set<SeatPresence> = [.connected, .grace, .resignable, .away]

    /// `seats` the table's seats, `myPosition` my seat (excluded), `inTournament` a tournament table.
    /// A table not fully known yet (fewer than 4 seats) keeps the bot message.
    static func of(seats: [Int: SeatState], myPosition: Int?, inTournament: Bool) -> LeaveOutcome {
        guard seats.count >= 4 else { return .botFinishes }
        let anotherOwner = seats.values.contains { seat in
            seat.position != myPosition && seat.controller != .bot && ownerCanReturn.contains(seat.presence)
        }
        if anotherOwner { return .botFinishes }
        return inTournament ? .endsTournamentTable : .endsGame
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
        }
    }

    /// The `/leave` line in the game log's command list (at a seat; a pure spectator's says "Exit spectating").
    var commandHelp: String {
        switch self {
        case .botFinishes: return "Leave the game (bot finishes for you)"
        case .endsGame: return "Leave and end the game (you're the only player)"
        case .endsTournamentTable: return "Leave and end this table's game (no score)"
        }
    }
}
