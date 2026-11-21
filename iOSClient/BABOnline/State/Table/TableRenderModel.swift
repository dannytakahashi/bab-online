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
        /// Cards left in the seat's hand (its card backs: TableLayout+Fans).
        var cards: Int = 0

        /// What the seat's avatar loads first: the URL, else the stock number or inline picture.
        var pictureKey: String? { avatarUrl ?? pic.string }
        /// What it falls back to when the URL cannot be loaded (docs/avatars.md I6).
        var fallbackPicture: String? { avatarUrl == nil ? nil : pic.string }
    }

    struct Hand: Equatable {
        var cards: [Card]          // sorted for display, minus a pending play
        var legalIds: Set<String>  // shown as playable (all of them on my bid turn, as today)
        var interactive: Bool      // taps may play
        /// Why each card outside `legalIds` cannot be played now, in the web's words
        /// (GameScene.illegalReason): the toast a tap on a dimmed card shows, its VoiceOver hint.
        var blocked: [String: String] = [:]
        /// My /help answer's card (AssistHint): its glow (CardSpriteNode.isSuggested), only while
        /// the answer is up and live.
        var suggestedId: String? = nil
        /// The watched seat's hand (the over-the-shoulder view): shown bright, never touchable
        /// (no lift, no play, no VoiceOver activation: HandNode).
        var readOnly = false
    }

    /// The web's illegalReason sentences (client/src/phaser/scenes/GameScene.js).
    enum Blocked {
        static let bidFirst = "Bid first."
        static let notYourTurn = "Not your turn."
        static let onItsWay = "Your card is on its way."
        static let trickClearing = "Wait for the trick to clear."
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
    /// The history's bid totals once bidding is over (team1 = my team's; a bore = the hand): nil while bidding.
    var pileTotals: TeamPair?
    /// Every seat's trick pips by absolute position (SeatPips), my own seat's included.
    var pips: [Int: SeatPips]
    /// What VoiceOver reads per seat: `pips` plus a 0 bid without tricks (no slots, still a count).
    var spokenPips: [Int: SeatPips]
    var bidBubbles: [Int: String]
    /// Who is watching (the badge itself is SwiftUI; the scene places the spectator chat bubble by it).
    var watching: WatchingList
    /// The seat that dealt this hand (gameStart `dealer`, the snapshot's deal): its dealer marker.
    var dealer: Int?
    /// I dealt, from a seat of my own (no avatar: the marker sits by my hand).
    var iDeal: Bool { hand != nil && dealer == viewPosition }
    /// The colour of every card back the table shows (the opponents' fans): the hand's, as the
    /// web's tableBackFrame (backFrameForHand of the hand number); off the table (the draw,
    /// before hand 1) the draw's red.
    var back: CardBackColour
    /// The seat this spectator watches over the shoulder (the bottom seat, drawn as the seated
    /// layout with its hand read-only), nil otherwise.
    var watchedSeat: Int?

    init(_ s: TableState) {
        let viewer = s.table.viewer
        let view = viewer.viewPosition
        gameId = s.table.gameId
        viewPosition = view
        watchedSeat = viewer.watchedSeat
        // the plain spectator view (all four seats round the table); a watcher has the seated layout
        isSpectator = viewer.role == .spectator && viewer.watchedSeat == nil
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
                            ownerName: seat?.ownerUsername ?? seat?.username,
                            cards: s.table.phase.showsTable ? max(0, seat?.cardsInHand ?? 0) : 0)
        }
        dealer = s.table.phase.showsTable ? s.table.deal?.dealer : nil
        back = s.table.phase.showsTable ? CardBackColour.forHand(s.table.deal?.handNo) : .draw
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
            var blocked: [String: String] = [:]
            let myTurn = s.myTurn
            if myTurn == .choosing(.play), let me = viewer.position {
                let played = s.table.phase.trick
                legal = Set(CardLegality.getLegalCards(hand: cards, lead: played.first?.card, isLeading: played.isEmpty,
                                                       trump: s.table.deal?.trump, trumpBroken: s.table.deal?.trumpBroken ?? false,
                                                       myPosition: me, leadPosition: s.table.phase.lead ?? 0).map(\.id))
                for c in cards where !legal.contains(c.id) {
                    let r = CardLegality.isLegalMove(card: c, hand: cards, lead: played.first?.card, isLeading: played.isEmpty,
                                                     trump: s.table.deal?.trump, trumpBroken: s.table.deal?.trumpBroken ?? false,
                                                     myPosition: me, leadPosition: s.table.phase.lead ?? 0)
                    blocked[c.id] = r.reason.map { "\($0)." } ?? Blocked.trickClearing
                }
            } else if myTurn == .choosing(.bid) {
                legal = Set(cards.map(\.id))
            } else {
                // every card is dimmed: one reason for all (the web's order)
                let why: String
                if s.table.phase.kind == .bidding { why = Blocked.bidFirst }
                else if myTurn.isSubmitted || pendingCard != nil { why = Blocked.onItsWay }
                else if s.table.phase.kind == .playing, let turn = s.table.phase.turn, turn != viewer.position { why = Blocked.notYourTurn }
                else { why = Blocked.trickClearing }
                for c in cards { blocked[c.id] = why }
            }
            var suggested: String?
            if let h = s.table.assist, h.kind == .card, let c = h.card, cards.contains(c), AssistRules.isLive(h, s) { suggested = c.id }
            hand = Hand(cards: cards, legalIds: legal, interactive: myTurn == .choosing(.play), blocked: blocked, suggestedId: suggested)
        } else if viewer.watchedSeat != nil {
            // the watched seat's hand (none while paused): bright, read-only; a live mirrored
            // card hint rings its card
            let cards = viewer.watchesHand ? CardUtils.sortHand(s.table.hand, trump: s.table.deal?.trump) : []
            var suggested: String?
            if let h = s.table.watchedAssist, h.kind == .card, let c = h.card, cards.contains(c), AssistRules.isLiveWatched(h, s) { suggested = c.id }
            hand = Hand(cards: cards, legalIds: Set(cards.map(\.id)), interactive: false, blocked: [:], suggestedId: suggested, readOnly: true)
        } else {
            hand = nil
        }

        let rel = s.scores.tricks.relative(to: view)
        history = TeamPair(team1: rel.mine, team2: rel.theirs)
        let doneBidding: BidBook?
        switch s.table.phase {
        case .playing(let p): doneBidding = p.bids
        case .handResolving(let h): doneBidding = h.bids
        default: doneBidding = nil
        }
        pileTotals = doneBidding.map { book in
            let t = BidTotals.totals(book, handSize: s.table.deal?.handSize).relative(to: view)
            return TeamPair(team1: t.mine, team2: t.theirs)
        }
        pips = SeatPips.all(s)
        spokenPips = SeatPips.all(s, spoken: true)

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

    /// My own seat's pips (seated or a lazy owner), shown once my bid bubble is gone
    /// (its spot is where they go: TableLayout.myPips).
    var myPips: SeatPips? {
        guard hand != nil, bidBubbles[viewPosition] == nil else { return nil }
        return pips[viewPosition]
    }

    /// What VoiceOver reads for my own seat (over my pips' box), shown when `myPips` would be.
    var mySpokenPips: SeatPips? {
        guard hand != nil, bidBubbles[viewPosition] == nil else { return nil }
        return spokenPips[viewPosition]
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
