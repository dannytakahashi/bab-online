import Foundation

/// What the SpriteKit table shows, as a pure projection of TableState (no
/// SpriteKit). GameSKScene.render(model) is idempotent over it.
struct TableRenderModel: Equatable {
    struct Opponent: Equatable {
        var rel: Positions.RelativePosition
        var position: Int
        var name: String
        var pic: Pic
        var isBot: Bool
        var lazy: Bool
        var presence: SeatPresence
        var isTurn: Bool
        var socketId: String?
        /// The custom picture's URL (`/avatar/<name>?v=`), preferred over `pic` (clientHello avatarUrl cap).
        var avatarUrl: String? = nil
        /// The seat's human owner (a lazy / resigned seat shows its bot's name): voice peers are matched by it.
        var ownerName: String? = nil

        /// What the seat's avatar loads first: the URL, else the stock number or inline picture.
        var pictureKey: String? { avatarUrl ?? pic.string }
        /// What it falls back to when the URL cannot be loaded (docs/avatars.md I6).
        var fallbackPicture: String? { avatarUrl == nil ? nil : pic.string }
    }

    struct Hand: Equatable {
        var cards: [Card]          // sorted for display, minus a pending play
        var legalIds: Set<String>  // shown as playable (all of them on my bid turn, as today)
        var interactive: Bool      // taps may play
    }

    struct TrickCard: Equatable {
        var card: Card
        var position: Int
        var playIndex: Int
        var provisional: Bool      // my submitted card, not confirmed yet
    }

    var gameId: String?
    var viewPosition: Int
    var isSpectator: Bool
    var showsTable: Bool
    var keepsLastTable: Bool       // game over: the scene leaves its last table up behind GameEndView
    var dealSeq: Int
    var trickKey: TrickKey?
    var opponents: [Opponent]
    var hand: Hand?
    var trick: [TrickCard]
    var turn: Int?
    var history: TeamPair          // team1 = my team's tricks, team2 = theirs
    var bidBubbles: [Int: String]
    /// Who is watching (the badge itself is SwiftUI; the scene places the spectator chat bubble by it).
    var watching: WatchingList

    init(_ s: TableState) {
        let viewer = s.table.viewer
        let view = viewer.viewPosition
        gameId = s.table.gameId
        viewPosition = view
        isSpectator = viewer.role == .spectator
        showsTable = s.table.phase.showsTable
        keepsLastTable = s.table.phase.kind == .ended
        dealSeq = s.table.deal?.dealSeq ?? 0
        turn = s.table.phase.turn
        trickKey = s.table.phase.kind == .playing ? TableReducer.currentKey(s) : nil

        let positions: [Int] = isSpectator ? [1, 2, 3, 4] : [Positions.team(view), Positions.rotate(view), Positions.rotate(Positions.rotate(Positions.rotate(view)))]
        opponents = positions.compactMap { pos in
            guard (1...4).contains(pos) else { return nil }
            let seat = s.players.seats[pos]
            return Opponent(rel: Positions.getRelative(target: pos, from: view), position: pos,
                            name: seat?.username ?? "P\(pos)", pic: seat?.pic ?? .none, isBot: seat?.isBot ?? false,
                            lazy: seat?.lazy ?? false, presence: seat?.presence ?? .none, isTurn: s.table.phase.turn == pos,
                            socketId: s.players.socketBySeat[pos], avatarUrl: seat?.avatarUrl,
                            ownerName: seat?.ownerUsername ?? seat?.username)
        }
        watching = s.players.watching

        // my submitted card leaves the hand and sits in my trick slot until confirmed
        var pendingCard: Card?
        if let p = s.pending, case .play(let c) = p.submission { pendingCard = c }

        var trick: [TrickCard] = s.table.phase.trick.enumerated().map {
            TrickCard(card: $0.element.card, position: $0.element.position, playIndex: $0.offset, provisional: false)
        }
        if let c = pendingCard, let me = viewer.position, !trick.contains(where: { $0.position == me }) {
            trick.append(TrickCard(card: c, position: me, playIndex: trick.count, provisional: true))
        }
        self.trick = s.table.phase.kind == .playing ? trick : []

        if viewer.holdsSeat {
            var cards = CardUtils.sortHand(s.table.hand, trump: s.table.deal?.trump)
            if let c = pendingCard, let i = cards.firstIndex(of: c) { cards.remove(at: i) }
            var legal: Set<String> = []
            let myTurn = s.myTurn
            if myTurn == .choosing(.play), let me = viewer.position {
                let played = s.table.phase.trick
                legal = Set(CardLegality.getLegalCards(hand: cards, lead: played.first?.card, isLeading: played.isEmpty,
                                                       trump: s.table.deal?.trump, trumpBroken: s.table.deal?.trumpBroken ?? false,
                                                       myPosition: me, leadPosition: s.table.phase.lead ?? 0).map(\.id))
            } else if myTurn == .choosing(.bid) {
                legal = Set(cards.map(\.id))
            }
            hand = Hand(cards: cards, legalIds: legal, interactive: myTurn == .choosing(.play))
        } else {
            hand = nil
        }

        let rel = s.scores.tricks.relative(to: view)
        history = TeamPair(team1: rel.mine, team2: rel.theirs)

        // bid bubbles: from the first bid until the hand's first card is down
        var bubbles: [Int: String] = [:]
        let showBids: Bool
        switch s.table.phase {
        case .bidding: showBids = true
        case .playing(let p): showBids = s.table.trickNo == 1 && p.trick.isEmpty
        default: showBids = false
        }
        if showBids, let bids = s.table.phase.bids {
            for pos in 1...4 { if let b = bids.bid(at: pos) { bubbles[pos] = b } }
        }
        bidBubbles = bubbles
    }
}

extension TableRenderModel {
    /// The seat a voice peer speaks from (speaking glows): by the peer's username, which
    /// voicePeerList / voiceOffer carry, so no seat socket id is needed (V1_REMOVALS #9 / #14);
    /// the seat socket id (positionUpdate.sockets, players[].socketId) only as the fallback.
    func seat(forVoicePeer socketId: String, username: String?) -> Int? {
        // (a native bot's ownerName is its 🤖 name, which no human username can be)
        if let name = username, !name.isEmpty, let o = opponents.first(where: { $0.ownerName == name }) {
            return o.position
        }
        return opponents.first(where: { $0.socketId == socketId })?.position
    }
}
