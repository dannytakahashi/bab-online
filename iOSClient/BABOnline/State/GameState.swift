import Foundation
import Combine

/// The table's renderer (GameSKScene), called synchronously after every commit.
@MainActor
protocol TableRenderer: AnyObject {
    func apply(model: TableRenderModel, animations: [TableAnimation])
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

    weak var renderer: TableRenderer?
    /// Non-animation effects (requestSnapshot / cancelAck / haptic) for ActionCoordinator.
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

        effectObserver?(effects)
        let animations = effects.animations
        if animations.contains(.sceneReset) { sceneResets += 1 }
        renderer?.apply(model: TableRenderModel(s), animations: animations)
        for fx in effects {
            switch fx {
            case .animate: break
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
            apply(.local(.resyncNeeded))
        }
        return decoded
    }

    func reset() {
        chatDraft = ""
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
    var hsiValues: [Int: Double] { table.hsi }

    var disconnectedPlayers: [Int: String] { players.disconnected }
    /// The "Replace with Bot" offer, only while its seat is still resignable (the reducer
    /// clears it on playerReconnected / playerActiveMode / playerResigned / a moved offer /
    /// every snapshot; this guard keeps a stale one off screen whatever the order).
    var resignationAvailable: (position: Int, username: String)? {
        guard let offer = players.resignationOffer, players.seats[offer.position]?.presence == .resignable else { return nil }
        return (position: offer.position, username: offer.username)
    }
    /// Who is watching (the spectator badge).
    var watching: WatchingList { players.watching }

    var gameLog: [ChatMessage] { log.entries }
    var unreadChatCount: Int { log.unread }
    var gameEndData: GameEndData? { if case .ended(let d) = table.phase { return d } else { return nil } }

    func getPlayerName(position pos: Int) -> String { players.name(pos) }
}
