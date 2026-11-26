import Foundation
import Combine
import SwiftUI

/// The table's renderer (GameSKScene), called synchronously after every commit.
@MainActor
protocol TableRenderer: AnyObject {
    func apply(model: TableRenderModel, animations: [TableAnimation])
}

/// A short, non-blocking line over the table.
struct TableNotice: Equatable, Identifiable {
    let id: Int
    let text: String
    /// `.info`: news (the bid clock's timeout), not a refusal.
    var info = false
}

/// The table store: four published slices over the pure TableReducer.
/// Every change goes through `apply`; views read the slices or the read-only
/// accessors below, the scene gets `TableRenderModel` + animations.
@MainActor
final class GameState: ObservableObject {
    @Published private(set) var table = TableSlice()
    @Published private(set) var scores = ScoreSlice()
    @Published private(set) var players = PlayersSlice()
    @Published private(set) var log = LogSlice()

    private(set) var state = TableState()
    /// The game log's unsent chat line: outside the reducer slices (TableState
    /// is untouched) and not @Published, so typing never re-renders the table.
    var chatDraft = ""
    /// +1 per applied snapshot or reset (the coordinator's resync debounce).
    private(set) var sceneResets = 0
    /// +1 per seat's badge pop (`TableAnimation.helpBadge`: a live /help notice that turned the
    /// lightbulb on, or a live tutorial tag that turned the cap on; never a snapshot or catch-up), by position: the watching pill's chip pops with it, as
    /// the felt's SeatBadgeNode does from the same animation.
    @Published private(set) var badgePops: [Int: Int] = [:]
    /// The latest table notice (why a bid or play was refused, or why a dimmed card cannot be
    /// played); GameContainerView shows it in the server-error toast for a few seconds.
    /// `id` tells two equal lines apart.
    @Published private(set) var notice: TableNotice?
    private var noticeCount = 0

    /// Said to VoiceOver (my /help answer); tests replace it.
    var announce: (String) -> Void = { AccessibilityNotification.Announcement($0).post() }

    /// A notice from the table itself (a tap on a dimmed card: TableRenderModel.Hand.blocked).
    func postNotice(_ text: String, info: Bool = false) {
        noticeCount += 1
        notice = TableNotice(id: noticeCount, text: text, info: info)
    }

    /// The idle-seat offer I answered with Wait: hidden until the server asks again (a new
    /// offer has the next `round`) or the offer moves.
    @Published private(set) var waitedOffer: ResignationOffer?
    func waitOnOffer() { waitedOffer = players.resignationOffer }
    /// The presence banner has something to show: an absent player, or an offer.
    var showsPresenceBanner: Bool { !players.disconnected.isEmpty || resignationOffer != nil }

    /// The running bid clock on this store's monotonic clock (`clockNow`): its deadline is
    /// set when the reducer's `.bidClock(.sync)` lands (receipt + inMs), nil whenever the
    /// reducer has no clock. The bidder's countdown and the tune read it.
    @Published private(set) var bidCountdown: BidCountdown?
    /// The bid clock's time source (tests and fixtures replace it).
    var clockNow: () -> TimeInterval = BidClockTime.now

    weak var renderer: TableRenderer?
    /// Non-animation effects (requestSnapshot / cancelAck / haptic / sound) for ActionCoordinator.
    let ioRequests = PassthroughSubject<TableEffect, Never>()

    private var applying = false
    /// Sees every effect list (tests: drops, gaps).
    var effectObserver: (([TableEffect]) -> Void)?

    init() {}

    @discardableResult
    func apply(_ e: TableEvent) -> [TableEffect] {
        #if DEBUG
        precondition(!applying, "GameState.apply re-entered")
        #endif
        applying = true
        defer { applying = false }

        var s = state
        let effects = TableReducer.reduce(&s, e)
        state = s
        if table != s.table { table = s.table }
        if scores != s.scores { scores = s.scores }
        if players != s.players { players = s.players }
        if log != s.log { log = s.log }
        // the offer I waited on is gone (withdrawn, resigned, a snapshot, a reset): forget it
        if waitedOffer != nil, s.players.resignationOffer == nil { waitedOffer = nil }
        // the bid clock's deadline, measured from now (receipt), before the tune reads it
        if let c = s.table.bidClock {
            if effects.contains(.bidClock(.sync)) || bidCountdown == nil {
                bidCountdown = BidCountdown(position: c.position, deadline: clockNow() + TimeInterval(c.inMs) / 1000, durationMs: c.durationMs)
            }
        } else if bidCountdown != nil {
            bidCountdown = nil
        }

        effectObserver?(effects)
        let animations = effects.animations
        if animations.contains(.sceneReset) { sceneResets += 1 }
        renderer?.apply(model: TableRenderModel(s), animations: animations)
        for fx in effects {
            // a missed broadcast, once per launch (the web reports its SeqGate gaps the same way)
            if case .gap(let expected, let got) = fx { ErrorReporter.shared.report(kind: "seqGap", message: "expected \(expected), got \(got)") }
            switch fx {
            case .animate(.helpBadge(let pos)): badgePops[pos, default: 0] += 1
            case .animate: break
            case .notice(let text):
                postNotice(text)
            case .infoNotice(let text):
                postNotice(text, info: true)
            case .announce(let text):
                announce(text)
            #if DEBUG
            case .dropped(let event, let seq): print("[Table] dropped \(event) seq \(seq)")
            case .gap(let expected, let got): print("[Table] seq gap: expected \(expected), got \(got)")
            #endif
            default: ioRequests.send(fx)
            }
        }
        return effects
    }

    /// Decode and apply a raw server event (handlers and tests).
    @discardableResult
    func apply(serverEvent name: String, payload: [Any], chatBlocked: Bool = false, chatMine: Bool = false) -> Result<SequencedEvent, WireError> {
        let decoded = ServerEvent.decode(name: name, payload: payload, chatBlocked: chatBlocked, chatMine: chatMine)
        switch decoded {
        case .success(let ev):
            apply(.server(ev))
        case .failure(let err):
            #if DEBUG
            print("[Table] could not decode \(name): \(err)")
            #endif
            TableLog.decodeFailed(err)
            if case .snapshot(_, let requestId, let problem) = err {
                // not a delta: the same request would get the same snapshot (snapshotFailed)
                let was = table.snapshotTrouble
                apply(.local(.snapshotFailed(requestId: requestId, problem)))
                if was != .unreadable, table.snapshotTrouble == .unreadable { TableLog.unreadable(failures: state.sync.snapshotFailures) }
            } else {
                apply(.local(.resyncNeeded))
            }
        }
        return decoded
    }

    func reset() {
        chatDraft = ""
        notice = nil
        apply(.local(.reset))
    }

    // MARK: - Read-only compatibility accessors (views)

    struct PlayerInfo: Equatable {
        let username: String
        var pic: String?
    }

    var playerId: String? { table.me.playerId }
    var username: String? { table.me.username }
    var position: Int? { table.viewer.position }
    var viewPosition: Int { table.viewer.viewPosition }
    var gameId: String? { table.gameId }
    var tournamentId: String? { table.tournamentId }
    var phase: PhaseKind { table.phase.kind }
    var myTurn: MyTurnState { table.myTurn }
    var myCards: [Card] { table.hand }
    var sortedHand: [Card] { CardUtils.sortHand(table.hand, trump: table.deal?.trump) }
    var currentTurn: Int? { table.phase.turn }
    var isMyTurn: Bool { currentTurn != nil && currentTurn == position }
    var trump: Card? { table.deal?.trump }
    var trumpBroken: Bool { table.deal?.trumpBroken ?? false }
    var currentHand: Int { table.deal?.handSize ?? 0 }
    var leadPosition: Int? { table.phase.lead }
    var playedCards: [PlayedCard] { table.phase.trick }
    var isBidding: Bool { table.phase.isBidding }

    var bidBook: BidBook? { table.phase.bids }

    // MARK: Get Your Bid (State/Table/GetYourBid.swift)

    /// A Get Your Bid table: three seats, no teams, no HSI / /help / tutorial.
    var isGyb: Bool { table.isGyb }
    /// Seats at the table (3 at a Get Your Bid table).
    var seatCount: Int { table.seats }
    /// This deal's Forbidden Bid (the server's, else derived while bidding); nil in the base game.
    var gybForbidden: GybForbidden? { table.gybForbidden }
    /// My own Forbidden Bid while I bid (the bid sheet strikes it), nil otherwise.
    var myForbiddenBid: Int? {
        guard let f = gybForbidden, f.position == position, table.viewer.role == .seat else { return nil }
        return f.bid
    }
    /// The seat this table is read from (the score bar, the bid chips): a seat's own, the
    /// watched seat, a plain spectator's seat 1.
    var readingSeat: Int { isPlainSpectator ? 1 : (watchedSeat ?? position ?? 1) }
    var bids: [Int: String] {
        var out: [Int: String] = [:]
        for pos in 1...4 { if let b = bidBook?.bid(at: pos) { out[pos] = b } }
        return out
    }
    var tempBids: [String] { bidBook?.tempBids ?? [] }
    /// "my/partner" bids ("-" until bid) once a seat is known.
    var teamBids: String? {
        guard let me = position, let book = bidBook else { return nil }
        return "\(book.bid(at: me) ?? "-")/\(book.bid(at: Positions.team(me)) ?? "-")"
    }
    var oppBids: String? {
        guard let me = position, let book = bidBook else { return nil }
        let opp = me % 2 == 1 ? [2, 4] : [1, 3]
        return "\(book.bid(at: opp[0]) ?? "-")/\(book.bid(at: opp[1]) ?? "-")"
    }
    /// (my team's, theirs) bid totals once the bidding is over (a bore counts as the whole
    /// hand, each capped at it: BidTotals); nil while bidding.
    var bidTotals: (mine: Int, theirs: Int)? {
        switch table.phase {
        case .playing(let p): return BidTotals.totals(p.bids, handSize: table.deal?.handSize).relative(to: viewPosition)
        case .handResolving(let h): return BidTotals.totals(h.bids, handSize: table.deal?.handSize).relative(to: viewPosition)
        default: return nil
        }
    }
    var team1Mult: Int { bidBook?.mults.team1 ?? 1 }
    var team2Mult: Int { bidBook?.mults.team2 ?? 1 }

    var teamTricks: Int { scores.tricks.relative(to: viewPosition).mine }
    var oppTricks: Int { scores.tricks.relative(to: viewPosition).theirs }
    var teamScore: Int { scores.score.relative(to: viewPosition).mine }
    var oppScore: Int { scores.score.relative(to: viewPosition).theirs }
    var teamRainbows: Int { scores.rainbows.relative(to: viewPosition).mine }
    var oppRainbows: Int { scores.rainbows.relative(to: viewPosition).theirs }

    var playerInfos: [Int: PlayerInfo] {
        var out: [Int: PlayerInfo] = [:]
        for (pos, seat) in players.seats { out[pos] = PlayerInfo(username: seat.username ?? "P\(pos)", pic: seat.pic.string) }
        return out
    }
    /// Socket id per seat (voice speaking indicators).
    var playerSockets: [Int: String] { players.socketBySeat }

    var isSpectator: Bool { table.viewer.role == .spectator }
    var isLazy: Bool { table.viewer.role == .lazyWatcher }
    var isReadOnly: Bool { state.isReadOnly }
    var hasPlayedCard: Bool { if case .submitted(.play, _) = table.myTurn { return true } else { return false } }

    var hasDrawn: Bool { table.phase.draw?.hasDrawn ?? false }
    var drawnCard: Card? { table.phase.draw?.drawnCard }
    var drawResults: [DrawResult] { table.phase.draw?.results ?? [] }
    var teamsAnnounced: TeamsAnnounced? { table.phase.draw?.teams }
    /// A tournament table's planned teams (the draw for first deal), nil at a casual table.
    var drawPlannedTeams: [[TableSnapshot.PlannedTeamPlayer]]? { table.phase.draw?.plannedTeams }
    var hsiValues: [Int: Double] { table.hsi }
    /// My seat's HSI (my seat's row, the bid panel); nil for a pure spectator (no seat) or
    /// before the deal's values arrive.
    var myHSI: Double? { isSpectator ? nil : position.flatMap { hsiValues[$0] } }
    /// What my seat's row and the bid panel show for HSI: `.pending` ("HSI --") from a live
    /// deal until its reveal (TableSlice.hsiHeld), then my value; nil with no seat (a pure
    /// spectator) or no value for this deal.
    var myHSIReading: HSIBadge.Reading? {
        // a watcher's row is the watched seat's: its HSI (none while paused)
        // Get Your Bid shows no HSI (the server sends none)
        if isGyb { return nil }
        if let w = watchedSeat {
            guard !watchPaused else { return nil }
            if table.hsiHeld { return .pending }
            return hsiValues[w].map { .value($0) }
        }
        guard !isSpectator, position != nil else { return nil }
        if table.hsiHeld { return .pending }
        return myHSI.map { .value($0) }
    }

    // MARK: the over-the-shoulder view (State/Table/Shoulder.swift)

    /// The seat this pure spectator watches over the shoulder (the table is drawn from it), nil
    /// in the plain table view and for anyone else.
    var watchedSeat: Int? { table.viewer.watchedSeat }
    /// The watched seat is held while the table is paused (no cards shown).
    var watchPaused: Bool { table.viewer.shoulder?.paused == true && watchedSeat != nil }
    /// The watched seat's player's name (the pill, the headings).
    var watchedName: String? { watchedSeat.map { players.name($0) } }
    /// A pure spectator in the plain table view (no seat watched).
    var isPlainSpectator: Bool { isSpectator && watchedSeat == nil }
    /// The watched seat's mirrored advice, while it is still that seat's turn's.
    var watchedAdvice: AssistHint? { table.watchedAssist.flatMap { AssistRules.isLiveWatched($0, state) ? $0 : nil } }
    /// The watched seat's mirrored rule tip.
    var watchedTip: AssistHint? { watchedSeat != nil && !watchPaused ? table.watchedTip : nil }
    /// The watched seat's bid clock while it is still to bid (the read-only clock pill).
    var watchedBidCountdown: BidCountdown? {
        guard let w = watchedSeat, !watchPaused, let c = bidCountdown, c.position == w, isBidding,
              bidBook?.bid(at: w) == nil else { return nil }
        return c
    }

    /// What Leave does from my seat now: a bot finishes, or the game (or tournament table) ends.
    var leaveOutcome: LeaveOutcome {
        LeaveOutcome.of(seats: players.seats, myPosition: position, inTournament: tournamentId != nil,
                        verified: players.leaveCheck == .verified, tableSeats: table.seats)
    }

    var disconnectedPlayers: [Int: String] { players.disconnected }
    /// The "Replace with Bot" offer, only while its seat is still resignable (the reducer
    /// clears it on playerReconnected / playerActiveMode / playerResigned / a moved offer /
    /// every snapshot; this guard keeps a stale one off screen whatever the order).
    var resignationAvailable: (position: Int, username: String)? {
        guard let offer = resignationOffer else { return nil }
        return (position: offer.position, username: offer.username)
    }
    /// The same offer with its wording (`idle`: the tournament table's idle-seat offer, whose
    /// seat stays connected; any other offer shows only while its seat is resignable).
    var resignationOffer: ResignationOffer? {
        // only a seat owner (at its seat, or watching its bot) may replace a player: the server
        // refuses anyone else's forceResign ("Not a player in this game"), so a spectator (a
        // watcher too) is never offered it; the absent player's row still shows
        guard table.viewer.holdsSeat, let offer = players.resignationOffer else { return nil }
        let seat = players.seats[offer.position]
        let presence = seat?.presence
        if offer.idle, waitedOffer == offer { return nil }
        // (.none: a presence value this build does not know; the seat is still a human's)
        if offer.idle { return (presence == .connected || presence == SeatPresence.none) && seat?.controller == .human && offer.position != position ? offer : nil }
        return presence == .resignable ? offer : nil
    }
    /// Who is watching (the spectator badge).
    var watching: WatchingList { players.watching }

    /// My /help answer on screen (AssistCardView), nil when none is up.
    var assistHint: AssistHint? { table.assist.flatMap { AssistRules.isLive($0, state) ? $0 : nil } }
    /// The suggested bid's ring on the bid panel (an answer of kind bid, still live).
    var suggestedBid: String? { assistHint?.kind == .bid ? assistHint?.bid : nil }
    /// The lightbulb by my hand shows (my own turn at my seat, no answer up or on its way).
    var showsAssistAsk: Bool { AssistRules.showsAsk(state) }
    /// The chat command list's /help line ("Ask a bot for advice", with no count in a game with
    /// a native bot seat or while my tutorial is on: /help is never counted then).
    var helpDescription: String {
        AssistRules.helpDescription(table.assistUses, free: AssistRules.isFreeHelpGame(state), tutorial: table.tutorial.on)
    }

    // MARK: the tutorial (State/Table/Tutorial.swift)

    /// My seat's tutorial is on (the server's word; the switch, the command list).
    var tutorialOn: Bool { table.tutorial.on }
    /// The tutorial is on at my own seat (never a spectator or a lazy watcher), at the table (not
    /// the game-end screen): the switch shows "Tutorial on" (the switch itself is there whenever
    /// `showsAssistBarItem`).
    var showsTutorialChip: Bool {
        table.tutorial.on && table.viewer.role == .seat && table.phase.kind != .ended && table.phase.kind != .none
    }
    /// /help's lightbulb as the iPhone Duo's vertical bar item and the tutorial's switch (the bar's
    /// item, else the corner button): there for the whole game at my own seat (never a spectator
    /// or a lazy watcher); the lightbulb enabled only while `showsAssistAsk`.
    var showsAssistBarItem: Bool {
        // Get Your Bid has no /help and no tutorial
        table.viewer.role == .seat && table.phase.kind != .ended && table.phase.kind != .none && !table.isGyb
    }
    /// The switch sent /tutorial off and waits for the server.
    var tutorialOffSent: Bool { table.tutorialOffSent }
    /// The rule tip shown over the table (my seat only), nil when none (one at a time; the
    /// welcome is never a card on iOS: TableReducer.tutorialTip).
    var tutorialTip: AssistHint? { table.viewer.role == .seat ? table.tip : nil }
    /// The switch sent /tutorial on and waits for the server.
    var tutorialOnSent: Bool { table.tutorialOnSent }
    /// The chat command list's /tutorial line.
    var tutorialDescription: String { TutorialRules.commandDescription(on: table.tutorial.on) }

    var gameLog: [ChatMessage] { log.entries }
    var unreadChatCount: Int { log.unread }
    var gameEndData: GameEndData? { if case .ended(let d) = table.phase { return d } else { return nil } }

    func getPlayerName(position pos: Int) -> String { players.name(pos) }
}
