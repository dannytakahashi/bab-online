import Foundation

// Domain types of the table store (Foundation only). The reducer
// (TableReducer) is the only writer; views and the scene read projections.

enum PhaseKind: String { case none, waiting, draw, bidding, playing, handResolving, ended }

/// Draw result for the draw phase (`position` is the draw order, as playerDrew sends it).
struct DrawResult: Equatable {
    let username: String
    let position: Int
    let cardIndex: Int
    let card: Card?
    var drawOrder: Int { position }
}

enum DrawStage: Equatable { case drawing, resolving, teamsAnnounced, dealing }

struct TeamsAnnounced: Equatable {
    var team1: [String]
    var team2: [String]
}

struct DrawState: Equatable {
    var stage: DrawStage
    var results: [DrawResult] = []
    var drawnCard: Card?
    var hasDrawn = false
    var teams: TeamsAnnounced?
}

struct TeamPair: Equatable {
    var team1 = 0
    var team2 = 0

    subscript(team team: Int) -> Int {
        get { team == 1 ? team1 : team2 }
        set { if team == 1 { team1 = newValue } else { team2 = newValue } }
    }

    /// (my team's, the other team's) value as seen from `pos`.
    func relative(to pos: Int) -> (mine: Int, theirs: Int) {
        Positions.getTeamNumber(pos) == 1 ? (team1, team2) : (team2, team1)
    }
}

struct BidBook: Equatable {
    var byPosition: [String?] = [nil, nil, nil, nil]  // uppercase bid strings, index = position - 1
    var order: [Int] = [1, 2, 3, 4]                   // bidding order from the bidder
    var teamBids: TeamPair?                           // once bidding is over
    var mults = TeamPair(team1: 1, team2: 1)

    static func fresh(bidder: Int) -> BidBook {
        BidBook(order: (0..<4).map { (bidder - 1 + $0) % 4 + 1 })
    }

    /// The bids so far in bidding order (bore availability in BidOverlay).
    var tempBids: [String] { order.compactMap { byPosition[$0 - 1] } }

    func bid(at pos: Int) -> String? { (1...4).contains(pos) ? byPosition[pos - 1] : nil }

    mutating func recomputeMults() {
        mults = TeamPair(team1: BidRules.calculateMultiplier(byPosition[0], byPosition[2]),
                         team2: BidRules.calculateMultiplier(byPosition[1], byPosition[3]))
    }
}

struct DealState: Equatable {
    var handNo: Int
    var handSize: Int
    var dealer: Int
    var bidder: Int
    var dealSeq: Int
    var trump: Card?
    var trumpBroken: Bool
}

/// Generation of a trick: animations tagged with an older key are no-ops.
struct TrickKey: Hashable {
    let dealSeq: Int
    let trick: Int
}

struct BiddingState: Equatable {
    var turn: Int?          // nil until updateTurn
    var bids: BidBook
}

struct PlayingState: Equatable {
    var trick: [PlayedCard] = []   // play order
    var lead: Int?
    var turn: Int?                 // 4 cards + nil turn = TRICK_RESOLVING
    var bids: BidBook
}

struct HandOutcome: Equatable {
    var team1Tricks: Int
    var team2Tricks: Int
    var team1OldScore: Int
    var team2OldScore: Int
}

struct HandResolvingState: Equatable {
    var bids: BidBook
    var outcome: HandOutcome?
}

enum GamePhase: Equatable {
    case none                               // no game context
    case waiting                            // CREATED: after allPlayersReady, before startDraw
    case draw(DrawState)                    // DRAWING / DRAW_RESOLVING / TEAMS_ANNOUNCED / DEALING
    case bidding(BiddingState)
    case playing(PlayingState)
    case handResolving(HandResolvingState)  // after the last trick; outcome set by handComplete
    case ended(GameEndData)

    var kind: PhaseKind {
        switch self {
        case .none: return .none
        case .waiting: return .waiting
        case .draw: return .draw
        case .bidding: return .bidding
        case .playing: return .playing
        case .handResolving: return .handResolving
        case .ended: return .ended
        }
    }

    var isBidding: Bool { kind == .bidding }
    var showsTable: Bool { [.bidding, .playing, .handResolving].contains(kind) }

    var turn: Int? {
        switch self {
        case .bidding(let b): return b.turn
        case .playing(let p): return p.turn
        default: return nil
        }
    }

    var trick: [PlayedCard] { if case .playing(let p) = self { return p.trick } else { return [] } }
    var lead: Int? { if case .playing(let p) = self { return p.lead } else { return nil } }

    var bids: BidBook? {
        switch self {
        case .bidding(let b): return b.bids
        case .playing(let p): return p.bids
        case .handResolving(let h): return h.bids
        default: return nil
        }
    }

    var draw: DrawState? { if case .draw(let d) = self { return d } else { return nil } }
}

enum TurnAction: String, Equatable { case bid, play }

enum Submission: Equatable {
    case play(Card)
    case bid(String)
    var action: TurnAction { if case .play = self { return .play } else { return .bid } }
}

struct PendingAction: Equatable {
    let submission: Submission
    let reqId: UInt32
    let key: TrickKey
}

enum MyTurnState: Equatable {
    case waiting
    case choosing(TurnAction)
    case submitted(Submission, reqId: UInt32)

    var isChoosing: Bool { if case .choosing = self { return true } else { return false } }
    var isSubmitted: Bool { if case .submitted = self { return true } else { return false } }
}

enum ViewerRole: String, Equatable { case none, entrant, seat, lazyWatcher, spectator }

struct ViewerState: Equatable {
    var role: ViewerRole = .none
    var position: Int?
    var ownerView: String?
    /// The seat the table is drawn from (spectators: seat 1).
    var viewPosition: Int { position ?? 1 }
    /// Holds a hand (a seat, or its lazy owner watching the bot).
    var holdsSeat: Bool { role == .seat || role == .lazyWatcher }
}

enum SeatController: String, Equatable { case human, lazyBot, resignBot, bot, unknown }
enum SeatPresence: String, Equatable { case connected, grace, resignable, away, gone, none }

struct SeatState: Equatable {
    var position: Int
    var username: String?
    var pic: Pic = .none
    var avatarUrl: String?
    var ownerUsername: String?
    var controller: SeatController = .human
    var presence: SeatPresence = .connected
    var isBot = false
    var lazy = false
    var cardsInHand = 0
}

/// Who is watching the table (spectatorsUpdated / snapshot v2 `watching`):
/// the server's whole list, at most 50 names, `count` the true total.
struct WatchingList: Equatable {
    struct Watcher: Equatable, Identifiable {
        var username: String
        var pic: Int?
        var avatarUrl: String?
        var id: String { username }
        /// What AvatarTextureCache / AvatarImage load: the URL when the server sent one, else the stock number.
        var pictureKey: String? { avatarUrl ?? pic.map(String.init) }
    }
    var spectators: [Watcher] = []
    var count = 0

    init() {}
    init(spectators: [TableSnapshot.Spectator], count: Int) {
        self.spectators = spectators.map { Watcher(username: $0.username, pic: $0.pic, avatarUrl: $0.avatarUrl) }
        self.count = max(count, 0)
    }
    init(_ list: TableSnapshot.SpectatorList) { self.init(spectators: list.spectators, count: list.count) }

    /// The badge's count: "99+" past 99, so the badge keeps its rect (VoiceOver reads the real count).
    var badgeText: String { count > 99 ? "99+" : "\(count)" }

    /// "1 person watching" / "2 people watching" (the badge's VoiceOver label).
    var accessibilityLabel: String { count == 1 ? "1 person watching" : "\(count) people watching" }
}

struct ResignationOffer: Equatable {
    var position: Int
    var username: String
}

struct Identity: Equatable {
    var username: String?
    var playerId: String?
}

enum HapticKind: Equatable { case error }

/// Bid multipliers (a port of server/game/rules.js calculateMultiplier).
enum BidRules {
    static let boreLevels = ["B", "2B", "3B", "4B"]

    static func calculateMultiplier(_ a: String?, _ b: String?) -> Int {
        let bids = [a, b].compactMap { $0?.uppercased() }
        if bids.contains("4B") { return 16 }
        if bids.contains("3B") { return 8 }
        if bids.contains("2B") { return 4 }
        if bids.contains("B") { return 2 }
        return 1
    }

    static func isBore(_ bid: String) -> Bool { boreLevels.contains(bid.uppercased()) }

    /// The bore buttons the bid sheet shows (BidOverlayView; the web sheet
    /// enables the same set): B until someone bid B, then each level once the
    /// one below is on the table and it is not. Whose bid it was (an
    /// opponent, the partner) and the bidding order do not matter.
    static func availableBores(bids: [String]) -> [String] {
        let bids = bids.map { $0.uppercased() }
        var levels: [String] = []
        if !bids.contains("B")                          { levels.append("B") }
        if bids.contains("B") && !bids.contains("2B")   { levels.append("2B") }
        if bids.contains("2B") && !bids.contains("3B")  { levels.append("3B") }
        if bids.contains("3B") && !bids.contains("4B")  { levels.append("4B") }
        return levels
    }
}

/// The over-trump ("OT") rule (owner 2026-11-11; web mirror
/// client/src/rules/overTrump.js): the card just played is a trump or a
/// joker, the trick's lead is not trump (a joker lead is), and it takes the
/// trick from an OPPONENT (team A seats 1 and 3, team B 2 and 4) whose
/// winning card was a trump or a joker. Beating a partner's trump, or an
/// under-trump while the partner's trump still wins, is not an over-trump.
/// The winner is the server's rules.determineWinner.
enum TrickRules {
    static func isTrump(_ card: Card, trump: Card) -> Bool { card.suit == trump.suit || card.suit == .joker }

    /// Index (play order) of the card winning `trick` so far; nil when empty.
    static func winnerIndex(trick: [PlayedCard], trump: Card) -> Int? {
        guard let lead = trick.first?.card else { return nil }
        let suitOf = { (c: Card) in c.suit == .joker ? trump.suit : c.suit }
        let value = { (c: Card) in CardConstants.rankValues[c.rank] ?? 0 }
        let leadSuit = suitOf(lead)
        var winner = 0
        for i in trick.indices.dropFirst() {
            let current = trick[i].card
            let winning = trick[winner].card
            let currentIsTrump = isTrump(current, trump: trump)
            let winningIsTrump = isTrump(winning, trump: trump)
            if currentIsTrump && !winningIsTrump {
                winner = i
            } else if currentIsTrump && winningIsTrump {
                if value(current) > value(winning) { winner = i }
            } else if suitOf(current) == leadSuit && suitOf(winning) == leadSuit {
                if value(current) > value(winning) { winner = i }
            }
        }
        return winner
    }

    /// Is the LAST card of `trick` (play order) an over-trump?
    static func isOverTrump(trick: [PlayedCard], trump: Card?) -> Bool {
        guard trick.count >= 3, let trump, let lead = trick.first?.card, !isTrump(lead, trump: trump) else { return false }
        let last = trick[trick.count - 1]
        guard isTrump(last.card, trump: trump),
              let b = winnerIndex(trick: Array(trick.dropLast()), trump: trump) else { return false }
        let before = trick[b]
        guard isTrump(before.card, trump: trump), before.position % 2 != last.position % 2 else { return false }
        return winnerIndex(trick: trick, trump: trump) == trick.count - 1
    }
}

/// Hand sizes in deal order (server/game/snapshotV2.js HAND_SEQUENCE).
enum HandSequence {
    static let sizes = [12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13]
    static func handNo(forSize size: Int) -> Int { (sizes.firstIndex(of: size) ?? -1) + 1 }
}
