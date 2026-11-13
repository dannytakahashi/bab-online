import Foundation

/// Who I am and what game I am in, the phase, my hand and my turn.
struct TableSlice: Equatable {
    var me = Identity()
    var gameId: String?
    var tournamentId: String?
    var viewer = ViewerState()
    var phase: GamePhase = .none
    var deal: DealState?
    var hand: [Card] = []
    var hsi: [Int: Double] = [:]
    var trickNo = 1
    /// Mirror of TableState.myTurn, refreshed after every reduce.
    var myTurn: MyTurnState = .waiting
}

/// Absolute (team1/team2) counts; views make them relative.
struct ScoreSlice: Equatable {
    var tricks = TeamPair()
    /// Tricks each seat won this deal (index = position - 1): trickComplete winners and the
    /// snapshot's tricksByPosition (else its trickHistory winners); nil for both seats of a
    /// team whose winners are not known, so the seat pips show that team's count (SeatPips).
    var tricksByPosition: [Int?] = [0, 0, 0, 0]
    var score = TeamPair()
    var rainbows = TeamPair()
}

struct PlayersSlice: Equatable {
    var seats: [Int: SeatState] = [:]
    /// Voice only (speaking glows): from positionUpdate and the legacy players[].socketId; kept across snapshots.
    var socketBySeat: [Int: String] = [:]
    var resignationOffer: ResignationOffer?
    /// The spectator SOCKET count (cc865b4's meaning, from the notices); the badge reads `watching.count`.
    var spectatorCount = 0
    /// Who is watching (spectatorsUpdated, every snapshot's `watching`); a new game starts empty.
    var watching = WatchingList()
    /// Leave's snapshot check while its confirmation is up (`.idle` when it is not; LeaveCheck).
    var leaveCheck: LeaveCheck = .idle

    /// Seats whose human owner is away (21.6: derived from presence, so a restore rebuilds it).
    var disconnected: [Int: String] {
        var out: [Int: String] = [:]
        for (pos, seat) in seats where seat.controller == .human && [.grace, .resignable, .away].contains(seat.presence) {
            out[pos] = seat.ownerUsername ?? seat.username ?? "P\(pos)"
        }
        return out
    }

    func name(_ pos: Int) -> String { seats[pos]?.username ?? "P\(pos)" }
}

struct LogSlice: Equatable {
    var entries: [ChatMessage] = []
    var unread = 0
}

struct SyncState: Equatable {
    var lastSeq: Int?
    var buffered: [SequencedEvent] = []
    var resyncId: String?
    var nextRequestNo = 1
}

struct TableState: Equatable {
    var table = TableSlice()
    var scores = ScoreSlice()
    var players = PlayersSlice()
    var log = LogSlice()
    var sync = SyncState()
    var pending: PendingAction?

    var isReadOnly: Bool { table.viewer.role != .seat }

    /// Derived, never stored: what I may do now.
    var myTurn: MyTurnState {
        guard table.viewer.role == .seat, let me = table.viewer.position else { return .waiting }
        if let p = pending { return .submitted(p.submission, reqId: p.reqId) }
        switch table.phase {
        case .bidding(let b) where b.turn == me && b.bids.bid(at: me) == nil:
            return .choosing(.bid)
        case .playing(let p) where p.turn == me && !p.trick.contains(where: { $0.position == me }):
            return .choosing(.play)
        default:
            return .waiting
        }
    }

    static func fresh(keeping me: Identity) -> TableState {
        var s = TableState()
        s.table.me = me
        return s
    }
}
