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
    /// A live deal's HSI is not shown yet ("HSI --", GameState.myHSIReading): from its gameStart
    /// until HSIScale.revealDelay later (`.hsiRevealed`), as the web shows it a beat after the
    /// cards go down. A snapshot (a reload, a relaunch, a resync) or a catch-up shows it at once.
    var hsiHeld = false
    var trickNo = 1
    /// Mirror of TableState.myTurn, refreshed after every reduce.
    var myTurn: MyTurnState = .waiting
    /// A snapshot this build cannot show (TableReducer.snapshotFailed); any applied snapshot clears it.
    var snapshotTrouble = SnapshotTrouble.none
    /// The running bid clock (bidClock running, a snapshot's `bidClock`), nil otherwise.
    var bidClock: BidClockState?
    /// The tune may be sounding (a `.bidClock(.sync)` went out; a timeout's tail may still
    /// ring after the clock itself is gone): the next hard stop is sent, then this is false.
    var bidTuneLive = false
    /// My /help answer on screen (AssistCardView, the suggested card's glow, the suggested bid's
    /// ring): TableReducer+Assist sets and clears it; nil when none is up.
    var assist: AssistHint?
    /// A bid or card answer that came while it was not (yet) my turn's by the table I hold (a
    /// seq gap, a held updateTurn): shown if the next turn change or snapshot makes it live, else
    /// given up with `AssistRules.lateLine`.
    var parkedAssist: AssistHint?
    /// This game's /help uses (the latest hint's; 0 from the game's createUI); nil: unknown.
    var assistUses: AssistUses?
    /// The lightbulb sent /help and waits for the answer (hidden meanwhile; `assistAskLapsed`
    /// after AssistRules.askWait shows it again).
    var assistAsking = false
    /// The tutorial (State/Table/Tutorial.swift): on / auto as the server last said (assistState,
    /// the snapshot's viewer.assist); off for a new game.
    var tutorial = TutorialStatus()
    /// The switch sent /tutorial off: it shows off and waits until the server's assistState (or
    /// its status reply) settles it.
    var tutorialOffSent = false
    /// The switch sent /tutorial on: it shows on and waits the same way (no second send, no
    /// second question).
    var tutorialOnSent = false
    /// The rule tip up (TutorialTipView, kind `tip`), nil when none.
    var tip: AssistHint?
    /// Tips already logged this game (TutorialRules.seenKey): each once.
    var tipsSeen: Set<String> = []
    /// The over-the-shoulder view's selection (what this spectator asks the server to show:
    /// State/Table/Shoulder.swift); the served seat itself is `viewer.shoulder`.
    var watch = HandWatch()
    /// The watched seat's mirrored /help or tutorial advice (assistHint `watched`), read-only;
    /// nil when none is up.
    var watchedAssist: AssistHint?
    /// The watched seat's mirrored rule tip (assistHint kind `tip` with `watched`), nil when none.
    var watchedTip: AssistHint?
    /// The game this table plays (allPlayersReady.mode, gameStart.gyb, a carrier's gyb): Get Your
    /// Bid has three seats and no teams (State/Table/GetYourBid.swift). Fixed for the game.
    var mode: GameMode = .classic
    /// A Get Your Bid table's scores, exact bids and last hand (unused in the base game).
    var gyb = GybTable()

    /// Seats at the table: 3 at a Get Your Bid table, else 4.
    var seats: Int { mode.seats }
    var isGyb: Bool { mode == .gyb }

    /// This deal's Forbidden Bid at a Get Your Bid table: the server's word once it said it
    /// (doneBidding, a carrier), else derived from the bids (GybRules.forbidden, the server's
    /// rule) while bidding; nil in the base game and where the rule does not apply.
    var gybForbidden: GybForbidden? {
        guard isGyb else { return nil }
        if let said = gyb.forbidden { return said }
        guard let deal, let bids = phase.bids else { return nil }
        return GybRules.forbidden(bids: bids, dealer: deal.dealer, handSize: deal.handSize)
    }
}

/// The over-the-shoulder view's selection (the web's ShoulderWatch, client/src/state/shoulder.js).
struct HandWatch: Equatable {
    /// The seat watched or wanted (the selection); nil: the plain table view.
    var selected: Int?
    /// The own-seat rule's seat, from an `own_seat` refusal (the seat records say it too).
    var ownSeat: Int?
    /// A `tournament` refusal: nothing more is offered for this game.
    var blocked = false
    /// The table is paused (an `unavailable` refusal, or the room's pause line): the selection
    /// stays and is sent again after "Game resumed." and after the next full state.
    var paused = false
    /// A `not_dealt` refusal or a full state before the first deal: sent at the first gameStart.
    var waitingDeal = false
}

/// What the table says about snapshots it could not show (UnreadableTableView).
enum SnapshotTrouble: Equatable {
    case none
    /// Asked again (`attempt` of SnapshotRetryPolicy.maxRetries), waiting for the answer.
    case retrying(attempt: Int)
    /// Retries spent: "update the app", with Leave. Nothing asks for a snapshot any more.
    case unreadable
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
    /// Before seating (a snapshot of the draw: no seats yet): the human entrants who have not
    /// left, for the voice rule (VoiceCompany); nil once seats are known or nothing said.
    var entrantHumans: [String]?
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
    /// This log has a tutorial row: later ones leave off "(only you see this)" (a new log, e.g.
    /// a snapshot's or the next table's, or a relaunch, has the note on its first again).
    var tutorialNoted = false
}

struct SyncState: Equatable {
    var lastSeq: Int?
    var buffered: [SequencedEvent] = []
    var resyncId: String?
    var nextRequestNo = 1
    /// Snapshots in a row this build could not show (reset by the next applied one).
    var snapshotFailures = 0
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
