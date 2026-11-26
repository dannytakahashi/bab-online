import Foundation

// Get Your Bid (owner 2026-11-24; Danny's second game mode; iOS 1.2.7 (42)). Server and wire:
// server/CLAUDE.md "Get Your Bid", contract/CLAUDE.md "Get Your Bid"; rules for players:
// docs/RULES.md "Get Your Bid"; the web's words and projections: client/src/state/gyb.js.
//
// Three seats, no teams. Each seat scores only for taking exactly its bid (10 + the bid, an
// exact 0 scores 5, anything else 0); no bores; on hands of 5 or more cards the dealer (the
// last bidder) may not make the bids add up to the hand (the Forbidden Bid; taking exactly
// that many anyway scores 1); all zeros is played, led by the first bidder; no rainbow, no
// HSI, no /help, no tutorial, no stats. The app computes no score: it shows what
// handComplete.gyb / gameEnd.gyb / the carriers' `gyb` say. The Forbidden Bid on my own bid
// sheet is derived from the bids (the server's rule, `GybRules.forbidden`), as the web does.

/// The game a lobby or table plays (the wire's `mode`: 'gyb', absent for the base game).
enum GameMode: String, Equatable {
    case classic, gyb

    /// A wire value: only 'gyb' is Get Your Bid; anything else (absent, 'classic') the base game.
    static func from(_ raw: Any?) -> GameMode { (raw as? String) == GybRules.wireMode ? .gyb : .classic }

    /// Seats at the table.
    var seats: Int { self == .gyb ? GybRules.seats : 4 }
    var isGyb: Bool { self == .gyb }
}

/// The mode's words and pure rules (the web's state/gyb.js and rules/bids.js gybForbidden).
enum GybRules {
    /// clientHello cap: this build can show a Get Your Bid lobby and table (ServerConfig
    /// `ClientHello.caps`). Without it the server never lists, seats or shows one.
    static let cap = "getYourBid"
    static let wireMode = "gyb"
    static let seats = 3
    /// The mode's name, as every screen shows it.
    static let name = "Get Your Bid"
    /// One line for the create choice and the lobby.
    static let blurb = "3 players, no teams. Score only by taking exactly what you bid."
    /// The base game, as the create choice names it (the web's create dialog).
    static let classicName = "Back Alley Bridge"
    static let classicBlurb = "4 players in two teams."
    /// The draw's rule line (the web's DRAW_TEXT_SOLO).
    static let drawRules = "Highest card deals. Everyone plays for themselves."
    /// The smallest hand with a Forbidden Bid (server rules.GYB_FORBIDDEN_MIN_HAND).
    static let forbiddenMinHand = 5

    /// The dealer's Forbidden Bid once the other two have bid (server rules.gybForbiddenBid,
    /// GameState.gybForbidden): the number that would make the three bids add up to the hand.
    /// nil on hands under 5 cards, before both others bid, when a bid is not a number, or when
    /// the two bids already pass the hand.
    static func forbidden(bids: BidBook, dealer: Int, handSize: Int) -> GybForbidden? {
        guard (1...seats).contains(dealer), handSize >= forbiddenMinHand else { return nil }
        var sum = 0
        for pos in 1...seats where pos != dealer {
            guard let raw = bids.bid(at: pos), !raw.isEmpty, raw.allSatisfy(\.isNumber), let n = Int(raw) else { return nil }
            sum += n
        }
        let left = handSize - sum
        return left >= 0 ? GybForbidden(position: dealer, bid: left) : nil
    }

    /// One seat's points for a hand (server rules.gybHandScore; the app shows the server's,
    /// this is for the tests and the fixtures): exactly the bid 10 + the bid, an exact 0 5,
    /// exactly the Forbidden Bid 1, anything else 0.
    static func handScore(bid: Int, took: Int, forbidden: Int? = nil) -> Int {
        if took == bid { return bid == 0 ? 5 : 10 + bid }
        return forbidden != nil && took == forbidden ? 1 : 0
    }

    /// The three seats as the screens list them: the viewer's own first, then the next in
    /// turn (drawn on the left) and the one after (on the right). A pure spectator: 1, 2, 3.
    static func order(viewer: Int?) -> [Int] {
        let me = viewer.flatMap { (1...seats).contains($0) ? $0 : nil } ?? 1
        let opp1 = Positions.rotate(me, seats: seats)
        return [me, opp1, Positions.rotate(opp1, seats: seats)]
    }

    /// The hand's log lines (the server's words, the web's formatSoloHandMessages), seats 1 to 3.
    static func handLines(_ hand: GybHand, name: (Int) -> String) -> [String] {
        ["--- HAND COMPLETE ---"] + hand.seats.sorted { $0.position < $1.position }.map { s in
            let total = hand.score(s.position)
            return "\(name(s.position)): Bid \(s.bid), Won \(s.took)\(s.forbiddenHit ? " (Forbidden Bid)" : ""), +\(s.points) → \(total)"
        }
    }

    /// How the game ended for the viewer (`me`: my seat; nil for a spectator).
    enum Outcome: Equatable { case victory, defeat, tie, neutral }

    static func outcome(_ end: GybEnd, me: Int?) -> Outcome {
        guard let me else { return .neutral }
        guard end.winners.contains(me) else { return .defeat }
        return end.winners.count > 1 ? .tie : .victory
    }

    /// "ann", "ann and bob", "ann, bob and cat".
    static func listNames(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
    }

    /// The result in words: "ann wins!", "ann and bob tie!" (nil without winners).
    static func winnerLine(_ end: GybEnd, name: (Int) -> String) -> String? {
        guard !end.winners.isEmpty else { return nil }
        let names = end.winners.sorted().map(name)
        return end.winners.count > 1 ? "\(listNames(names)) tie!" : "\(names[0]) wins!"
    }

    /// The score card's rows, best score first (ties in seat order).
    struct ResultRow: Equatable, Identifiable {
        let position: Int
        let name: String
        let score: Int
        let made: Int
        let hands: Int
        let winner: Bool
        let mine: Bool
        var id: Int { position }

        /// "Bids made 5 of 13".
        var madeText: String { "Bids made \(made) of \(hands)" }
        /// VoiceOver: "ann, 83 points, bids made 5 of 13, winner".
        var spoken: String { "\(name), \(score) \(score == 1 ? "point" : "points"), bids made \(made) of \(hands)\(winner ? ", winner" : "")" }
    }

    static func resultRows(_ end: GybEnd, name: (Int) -> String, me: Int?) -> [ResultRow] {
        (1...seats).map { pos in
            ResultRow(position: pos, name: name(pos), score: end.score(pos), made: end.made.indices.contains(pos - 1) ? end.made[pos - 1] : 0,
                      hands: end.hands, winner: end.winners.contains(pos), mine: me == pos)
        }
        .sorted { $0.score != $1.score ? $0.score > $1.score : $0.position < $1.position }
    }

    /// The bid sheet's line for the Forbidden Bid ("Forbidden Bid: 3").
    static func forbiddenLine(_ bid: Int) -> String { "Forbidden Bid: \(bid)" }
    /// The struck bid's VoiceOver label ("3, the Forbidden Bid").
    static func forbiddenButtonLabel(_ bid: Int) -> String { "\(bid), the Forbidden Bid" }
}

/// `{position, bid}`: the last bidder's Forbidden Bid this deal.
struct GybForbidden: Equatable, Decodable {
    var position: Int
    var bid: Int
}

/// One seat's hand in handComplete.gyb.
struct GybSeatHand: Equatable, Decodable {
    var position: Int
    var bid: Int
    var took: Int
    var points: Int
    var forbiddenHit: Bool

    init(position: Int, bid: Int, took: Int, points: Int, forbiddenHit: Bool = false) {
        self.position = position; self.bid = bid; self.took = took; self.points = points; self.forbiddenHit = forbiddenHit
    }

    private enum CodingKeys: String, CodingKey { case position, bid, took, points, forbiddenHit }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        position = try c.decode(Int.self, forKey: .position)
        bid = (try? c.decode(Int.self, forKey: .bid)) ?? 0
        took = (try? c.decode(Int.self, forKey: .took)) ?? 0
        points = (try? c.decode(Int.self, forKey: .points)) ?? 0
        forbiddenHit = (try? c.decode(Bool.self, forKey: .forbiddenHit)) ?? false
    }
}

/// handComplete.gyb (contract $defs.gybHand): each seat's bid / took / points, the scores
/// before and after (by position - 1), this deal's Forbidden Bid.
struct GybHand: Equatable, Decodable {
    var scores: [Int]
    var oldScores: [Int]
    var seats: [GybSeatHand]
    var forbidden: GybForbidden?

    init(scores: [Int], oldScores: [Int] = [0, 0, 0], seats: [GybSeatHand], forbidden: GybForbidden? = nil) {
        self.scores = scores; self.oldScores = oldScores; self.seats = seats; self.forbidden = forbidden
    }

    private enum CodingKeys: String, CodingKey { case scores, oldScores, seats, forbidden }
    /// Lenient: a field of the wrong shape is empty (never a failed handComplete).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scores = GybWire.bySeat(try? c.decode([Int].self, forKey: .scores))
        oldScores = GybWire.bySeat(try? c.decode([Int].self, forKey: .oldScores))
        seats = ((try? c.decode([LenientSeat].self, forKey: .seats)) ?? []).compactMap(\.value)
            .filter { (1...GybRules.seats).contains($0.position) }
        forbidden = (try? c.decodeIfPresent(GybForbidden.self, forKey: .forbidden)) ?? nil
    }

    func score(_ pos: Int) -> Int { scores.indices.contains(pos - 1) ? scores[pos - 1] : 0 }
    func seat(_ pos: Int) -> GybSeatHand? { seats.first { $0.position == pos } }

    private struct LenientSeat: Decodable {
        var value: GybSeatHand?
        init(from decoder: Decoder) throws { value = try? GybSeatHand(from: decoder) }
    }
}

/// gameEnd.gyb (and lobbyReturn.lastGame.gyb; contract $defs.gybEnd): the final scores, the
/// winners (equal top scores share the win), each seat's exact bids, the hands played.
struct GybEnd: Equatable {
    var scores: [Int]
    var winners: [Int]
    var made: [Int]
    var hands: Int

    init(scores: [Int], winners: [Int], made: [Int], hands: Int) {
        self.scores = GybWire.bySeat(scores); self.winners = winners; self.made = GybWire.bySeat(made); self.hands = hands
    }

    /// From the raw payload's `gyb` (GameEndData.from); nil when it is not a Get Your Bid end.
    static func from(_ raw: Any?) -> GybEnd? {
        guard let d = raw as? [String: Any] else { return nil }
        let ints = { (v: Any?) -> [Int] in (v as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue } ?? [] }
        let scores = GybWire.bySeat(ints(d["scores"]))
        var winners = ints(d["winners"]).filter { (1...GybRules.seats).contains($0) }
        // a payload without winners: the top score's seats (the server's rule)
        if winners.isEmpty, let top = scores.max() { winners = (1...GybRules.seats).filter { scores[$0 - 1] == top } }
        return GybEnd(scores: scores, winners: winners, made: ints(d["made"]), hands: (d["hands"] as? NSNumber)?.intValue ?? 13)
    }

    func score(_ pos: Int) -> Int { scores.indices.contains(pos - 1) ? scores[pos - 1] : 0 }
}

/// One trick in the carriers' gyb.trickHistory (three cards, play order from the lead).
struct GybTrick: Equatable, Decodable {
    var winner: Int
    var lead: Int
    var cards: [Card]
}

/// The carriers' `gyb` (contract $defs.gybSnapshot): beside the frozen four-seat snapshot v2,
/// the real three-seat state: scores and exact bids so far, the hands counted, this deal's
/// Forbidden Bid, this deal's won tricks.
struct GybSnapshot: Equatable, Decodable {
    var scores: [Int] = [0, 0, 0]
    var made: [Int] = [0, 0, 0]
    var hands: Int = 0
    var forbidden: GybForbidden?
    var trickHistory: [GybTrick] = []

    init(scores: [Int] = [0, 0, 0], made: [Int] = [0, 0, 0], hands: Int = 0, forbidden: GybForbidden? = nil, trickHistory: [GybTrick] = []) {
        self.scores = scores; self.made = made; self.hands = hands; self.forbidden = forbidden; self.trickHistory = trickHistory
    }

    private enum CodingKeys: String, CodingKey { case scores, made, hands, forbidden, trickHistory }
    /// Lenient field by field: the key's presence is what makes the table a Get Your Bid one.
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        scores = GybWire.bySeat(c.flatMap { try? $0.decode([Int].self, forKey: .scores) })
        made = GybWire.bySeat(c.flatMap { try? $0.decode([Int].self, forKey: .made) })
        hands = c.flatMap { try? $0.decode(Int.self, forKey: .hands) } ?? 0
        forbidden = c.flatMap { try? $0.decodeIfPresent(GybForbidden.self, forKey: .forbidden) } ?? nil
        trickHistory = c.flatMap { try? $0.decode([GybTrick].self, forKey: .trickHistory) } ?? []
    }
}

/// gameStart.gyb `{scores}`.
struct GybStart: Equatable, Decodable {
    var scores: [Int]
    private enum CodingKeys: String, CodingKey { case scores }
    init(scores: [Int]) { self.scores = GybWire.bySeat(scores) }
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        scores = GybWire.bySeat(c.flatMap { try? $0.decode([Int].self, forKey: .scores) })
    }
}

/// doneBidding.gyb `{forbidden}`.
struct GybDoneBidding: Equatable, Decodable {
    var forbidden: GybForbidden?
    private enum CodingKeys: String, CodingKey { case forbidden }
    init(forbidden: GybForbidden?) { self.forbidden = forbidden }
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        forbidden = c.flatMap { try? $0.decodeIfPresent(GybForbidden.self, forKey: .forbidden) } ?? nil
    }
}

enum GybWire {
    /// Exactly one value per seat (by position - 1), missing ones 0.
    static func bySeat(_ a: [Int]?) -> [Int] {
        let a = a ?? []
        return (0..<GybRules.seats).map { a.indices.contains($0) ? a[$0] : 0 }
    }
}

/// What a Get Your Bid table holds besides the classic slices (TableSlice.gyb; empty in the
/// base game). The team fields keep their shape there and mean nothing.
struct GybTable: Equatable {
    /// Each seat's score (by position - 1): gameStart.gyb, handComplete.gyb, the carriers' gyb.
    var scores = [0, 0, 0]
    /// Each seat's exact bids so far (the carriers' gyb, counted on at each handComplete).
    var made = [0, 0, 0]
    /// Hands scored so far.
    var hands = 0
    /// This deal's Forbidden Bid as the server said it (doneBidding, a carrier); while the dealer
    /// still bids, `TableReducer` / the bid sheet derive it (`GybRules.forbidden`).
    var forbidden: GybForbidden?
    /// The last hand (handComplete.gyb), until the next deal.
    var last: GybHand?

    func score(_ pos: Int) -> Int { scores.indices.contains(pos - 1) ? scores[pos - 1] : 0 }
}

// MARK: - The reducer's Get Your Bid parts

extension TableReducer {
    /// The table's mode (allPlayersReady, a deal, a carrier): fixed for a game, so only a table
    /// that has not been dealt yet, or the same mode again, changes it.
    static func setMode(_ s: inout TableState, _ mode: GameMode) {
        guard s.table.mode != mode else { return }
        s.table.mode = mode
        s.table.gyb = GybTable()
        if mode == .gyb {
            // the bid order of a deal already started has three seats
            if case .bidding(var b) = s.table.phase, b.bids.order.count == 4, let bidder = b.bids.order.first {
                b.bids.order = BidBook.fresh(bidder: bidder, seats: GybRules.seats).order
                s.table.phase = .bidding(b)
            }
        }
    }

    /// handComplete.gyb: the scores, the exact bids, the hand's lines (the server's words), and
    /// made / set for my own seat (exactly my bid), the neutral hand end for a spectator.
    static func gybHandComplete(_ s: inout TableState, _ hand: GybHand, _ fx: inout [TableEffect]) {
        s.table.gyb.scores = hand.scores
        for seat in hand.seats where seat.took == seat.bid && (1...GybRules.seats).contains(seat.position) {
            s.table.gyb.made[seat.position - 1] += 1
        }
        s.table.gyb.hands += 1
        s.table.gyb.last = hand
        if let f = hand.forbidden { s.table.gyb.forbidden = f }
        if s.table.viewer.holdsSeat, let me = s.table.viewer.position, let mine = hand.seat(me) {
            fx.append(.sound(mine.took == mine.bid ? .made : .set))
        } else {
            fx.append(.sound(.handEnd))
        }
        let players = s.players
        for line in GybRules.handLines(hand, name: { players.name($0) }) { addLog(&s, line) }
    }

    /// A carrier's `gyb` over the state built from its snapshot (applySnapshot): the mode, the
    /// scores and exact bids, this deal's Forbidden Bid, and the bid order of three seats.
    static func applyGybSnapshot(_ s: inout TableState, _ g: GybSnapshot) {
        s.table.mode = .gyb
        s.table.gyb.scores = g.scores
        s.table.gyb.made = g.made
        s.table.gyb.hands = g.hands
        s.table.gyb.forbidden = g.forbidden
        // the padded snapshot's order ends with the absent fourth seat
        func three(_ b: BidBook) -> BidBook {
            var b = b
            let order = b.order.filter { (1...GybRules.seats).contains($0) }
            b.order = order.count == GybRules.seats ? order : BidBook.fresh(bidder: s.table.deal?.bidder ?? 1, seats: GybRules.seats).order
            return b
        }
        switch s.table.phase {
        case .bidding(var b): b.bids = three(b.bids); s.table.phase = .bidding(b)
        case .playing(var p): p.bids = three(p.bids); s.table.phase = .playing(p)
        case .handResolving(var h): h.bids = three(h.bids); s.table.phase = .handResolving(h)
        default: break
        }
        // each seat's tricks this deal from the carrier's own history when the padded snapshot's
        // count does not say (its tricksByPosition is per seat already; this is the fallback)
        if s.scores.tricksByPosition.prefix(GybRules.seats).contains(where: { $0 == nil }) {
            for pos in 1...GybRules.seats { s.scores.tricksByPosition[pos - 1] = g.trickHistory.filter { $0.winner == pos }.count }
        }
    }
}
