import Foundation

// The scorecard (owner 2026-11-27): the table people keep with real cards, one row per completed
// hand. The server builds every row (server/game/scorecard.js) and the app computes no score: it
// keeps the rows it is sent (handComplete.scorecardRow, appended; the snapshot's and gameEnd's
// `scorecard`, whole; gameStart.scorecardRows says the server keeps one) and lays them out here
// for ScorecardView. The web's twin is client/src/state/scorecard.js; the rules below are its.

/// One completed hand (contract $defs.scorecardHand). Seat arrays by position - 1: four seats in
/// the base game, three in Get Your Bid; points / scores [team1, team2] or per seat.
struct ScorecardRow: Equatable, Codable, Identifiable {
    var handNo: Int
    var handSize: Int
    var trump: Card?
    var dealer: Int
    var bids: [String]
    var took: [Int]
    var points: [Int]
    var scores: [Int]
    var faults: [Int] = []
    /// The base game's [team1 set, team2 set].
    var set: [Bool]?
    /// Get Your Bid's Forbidden Bid of the deal.
    var forbidden: Forbidden?

    struct Forbidden: Equatable, Codable { var position: Int; var bid: Int }

    var id: Int { handNo }

    /// '0'...'13', 'B', '2B', '3B', '4B' (the wire's bid strings).
    static func isBid(_ b: String) -> Bool {
        if let n = Int(b) { return (0...13).contains(n) && String(n) == b }
        return ["B", "2B", "3B", "4B"].contains(b)
    }

    /// What the table can draw (a row that is not is dropped, never a failed event).
    var isValid: Bool {
        (1...13).contains(handNo) && (1...13).contains(handSize) && (3...4).contains(bids.count)
            && bids.allSatisfy(Self.isBid)
            && took.count == bids.count && (2...3).contains(points.count) && scores.count == points.count
    }

    /// The generated snapshot type's row.
    init(_ h: TableSnapshot.ScorecardHand) {
        self.init(handNo: h.handNo, handSize: h.handSize, trump: h.trump, dealer: h.dealer, bids: h.bids, took: h.took,
                  points: h.points, scores: h.scores, faults: h.faults, set: h.set,
                  forbidden: h.forbidden.map { Forbidden(position: $0.position, bid: $0.bid) })
    }

    init(handNo: Int, handSize: Int, trump: Card?, dealer: Int, bids: [String], took: [Int], points: [Int], scores: [Int],
         faults: [Int] = [], set: [Bool]? = nil, forbidden: Forbidden? = nil) {
        self.handNo = handNo; self.handSize = handSize; self.trump = trump; self.dealer = dealer; self.bids = bids
        self.took = took; self.points = points; self.scores = scores; self.faults = faults; self.set = set
        self.forbidden = forbidden
    }

    enum CodingKeys: String, CodingKey { case handNo, handSize, trump, dealer, bids, took, points, scores, faults, set, forbidden }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handNo = try c.decode(Int.self, forKey: .handNo)
        handSize = try c.decode(Int.self, forKey: .handSize)
        trump = try? c.decodeIfPresent(Card.self, forKey: .trump)
        dealer = try c.decode(Int.self, forKey: .dealer)
        bids = try c.decode([String].self, forKey: .bids)
        took = try c.decode([Int].self, forKey: .took)
        points = try c.decode([Int].self, forKey: .points)
        scores = try c.decode([Int].self, forKey: .scores)
        faults = (try? c.decodeIfPresent([Int].self, forKey: .faults)) ?? []
        set = try? c.decodeIfPresent([Bool].self, forKey: .set)
        forbidden = try? c.decodeIfPresent(Forbidden.self, forKey: .forbidden)
    }
}

/// handComplete.scorecardRow, decoded with `try?`: a malformed row is nil, never a failed event.
struct LenientScorecardRow: Decodable, Equatable {
    var value: ScorecardRow?
    init(_ value: ScorecardRow?) { self.value = value }
    init(from decoder: Decoder) throws {
        let row = try? ScorecardRow(from: decoder)
        value = (row?.isValid ?? false) ? row : nil
    }
}

enum Scorecard {
    /// `rows` with `row` in its place (one row per hand, by handNo).
    static func merge(_ rows: [ScorecardRow], _ row: ScorecardRow) -> [ScorecardRow] {
        (rows.filter { $0.handNo != row.handNo } + [row]).sorted { $0.handNo < $1.handNo }
    }

    /// The valid rows of a wire list (gameEnd's `scorecard` from its dictionary), or nil when the
    /// key is missing or not a list (an older server).
    static func rows(fromJSON raw: Any?) -> [ScorecardRow]? {
        guard let list = raw as? [Any], let data = try? JSONSerialization.data(withJSONObject: list),
              let decoded = try? JSONDecoder().decode([LenientScorecardRow].self, from: data) else { return nil }
        return decoded.compactMap(\.value).reduce(into: [ScorecardRow]()) { $0 = merge($0, $1) }
    }

    /// "+41", "−50" (a true minus, as the mockup), "0".
    static func signed(_ n: Int) -> String { n > 0 ? "+\(n)" : n < 0 ? "\u{2212}\(-n)" : "0" }

    // MARK: the model ScorecardView draws

    /// What a cell is drawn as (the colours mean only these).
    enum Role: Equatable {
        case plain
        /// a red pill: the player at fault (the server's fault list)
        case fault
        /// a green outline: a bore (B..4B)
        case bore
        /// red pill and red outline: a bore whose team was set
        case boreSet
    }

    struct Cell: Equatable {
        let position: Int
        let bid: String?
        let took: Int?
        /// took > the numeric bid: the took number in gold (the over-trick pip's colour)
        let extra: Bool
        let role: Role
        /// Get Your Bid: the seat's Forbidden Bid this deal (struck)
        let forbidden: Int?

        /// "2 → 3" ("2 → –" for the hand in play; "–" before the seat bids).
        var text: String {
            guard let bid else { return "\u{2013}" }
            return "\(bid) \u{2192} \(took.map(String.init) ?? "\u{2013}")"
        }
    }

    struct ScoreCell: Equatable {
        let total: Int
        let delta: Int
        /// The first hand's change is its total: no delta line (owner 2026-11-27).
        let showDelta: Bool
        /// The pair's (or the player's) colour: Theme.team(n).
        let colour: Int
    }

    struct Player: Equatable { let position: Int; let name: String; let colour: Int; let mine: Bool }
    /// A pair over its two players and its Score column (never "Team 1": the names are the label).
    struct Pair: Equatable { let positions: [Int]; let label: String; let spoken: String; let colour: Int; let teamIndex: Int }
    struct ScoreColumn: Equatable { let index: Int; let label: String; let spoken: String; let colour: Int }

    struct HandLabel: Equatable {
        let size: Int
        /// ♥ ♠ ♦ ♣, or the turned joker's own index (HI / LO: the no-trump hand), or ""
        let symbol: String
        let red: Bool
        let joker: Bool
        let spoken: String
    }

    struct Row: Equatable, Identifiable {
        let handNo: Int
        let hand: HandLabel
        let dealer: String
        let cells: [Cell]
        /// nil for the hand in play (no score yet)
        let scores: [ScoreCell]?
        let current: Bool
        let spoken: String
        var id: Int { current ? 100 + handNo : handNo }
    }

    struct Model: Equatable {
        let solo: Bool
        let players: [Player]
        let pairs: [Pair]
        let scoreColumns: [ScoreColumn]
        let rows: [Row]
    }

    /// The hand in play: its size, trump, dealer and the bids so far (by position - 1).
    struct Current: Equatable {
        var handNo: Int
        var handSize: Int
        var trump: Card?
        var dealer: Int
        var bids: [String?]
    }

    static func handLabel(_ size: Int, _ trump: Card?) -> HandLabel {
        guard let trump else { return HandLabel(size: size, symbol: "", red: false, joker: false, spoken: "Hand \(size)") }
        switch trump.suit {
        case .joker:
            let hi = trump.rank == .hi
            return HandLabel(size: size, symbol: hi ? "HI" : "LO", red: hi, joker: true,
                             spoken: "Hand \(size), no trump, \(hi ? "high" : "low") joker")
        case .spades: return HandLabel(size: size, symbol: "\u{2660}", red: false, joker: false, spoken: "Hand \(size), spades")
        case .hearts: return HandLabel(size: size, symbol: "\u{2665}", red: true, joker: false, spoken: "Hand \(size), hearts")
        case .diamonds: return HandLabel(size: size, symbol: "\u{2666}", red: true, joker: false, spoken: "Hand \(size), diamonds")
        case .clubs: return HandLabel(size: size, symbol: "\u{2663}", red: false, joker: false, spoken: "Hand \(size), clubs")
        }
    }

    /// The columns for a viewer: the base game's pairs, mine first (me and my partner, then the
    /// next seat in turn and its partner; a spectator's seats 1 and 3, then 2 and 4), each in its
    /// team's colour (seats 1 and 3 team 1, the score bar's); Get Your Bid's three players, mine
    /// first, each its own colour (`Positions.colour`).
    static func columns(solo: Bool, me: Int?, name: (Int) -> String) -> (players: [Player], pairs: [Pair], scores: [ScoreColumn]) {
        func n(_ p: Int) -> String { let s = name(p); return s.isEmpty ? "P\(p)" : s }
        if solo {
            let order = GybRules.order(viewer: me)
            let players = order.map { Player(position: $0, name: n($0), colour: Positions.colour($0, seats: GybRules.seats), mine: $0 == me) }
            return (players, [], order.map { ScoreColumn(index: $0 - 1, label: n($0), spoken: n($0), colour: Positions.colour($0, seats: GybRules.seats)) })
        }
        let viewer = me.flatMap { (1...4).contains($0) ? $0 : nil } ?? 1
        let r = Positions.getRelativePositions(myPos: viewer)
        let pairs = [[viewer, r.partner], [r.opp1, r.opp2]].map { pair -> Pair in
            let team = Positions.getTeamNumber(pair[0])
            return Pair(positions: pair, label: "\(n(pair[0])) & \(n(pair[1]))", spoken: "\(n(pair[0])) and \(n(pair[1]))",
                        colour: team, teamIndex: team - 1)
        }
        let players = pairs.flatMap { p in p.positions.map { Player(position: $0, name: n($0), colour: p.colour, mine: $0 == me) } }
        return (players, pairs, pairs.map { ScoreColumn(index: $0.teamIndex, label: $0.label, spoken: $0.spoken, colour: $0.colour) })
    }

    /// One seat's cell (the web's cellOf).
    static func cell(_ row: ScorecardRow, _ pos: Int, current: Bool = false) -> Cell {
        let i = pos - 1
        let bid = row.bids.indices.contains(i) ? row.bids[i] : nil
        return cell(bid: bid, took: current ? nil : (row.took.indices.contains(i) ? row.took[i] : nil), pos: pos,
                    faults: current ? [] : row.faults, set: current ? nil : row.set,
                    forbidden: row.forbidden?.position == pos ? row.forbidden?.bid : nil)
    }

    static func cell(bid: String?, took: Int?, pos: Int, faults: [Int], set: [Bool]?, forbidden: Int?) -> Cell {
        let bore = bid?.contains("B") ?? false
        let teamIndex = pos % 2 == 1 ? 0 : 1
        let extra = !bore && bid != nil && took != nil && took! > (Int(bid!) ?? 0)
        let boreSet = bore && (set.map { $0.indices.contains(teamIndex) && $0[teamIndex] } ?? false)
        let role: Role = boreSet ? .boreSet : bore ? .bore : faults.contains(pos) ? .fault : .plain
        return Cell(position: pos, bid: bid, took: took, extra: extra, role: role, forbidden: forbidden)
    }

    private static func words(_ name: String, _ c: Cell) -> String {
        guard let bid = c.bid else { return "\(name) not bid yet" }
        let bidWord = bid.contains("B") ? (bid == "B" ? "bid a bore" : "bid bore \(bid)") : "bid \(bid)"
        guard let took = c.took else { return "\(name) \(bidWord)" }
        var s = "\(name) \(bidWord), took \(took)"
        if c.extra {
            let n = took - (Int(bid) ?? 0)
            s += n == 1 ? ", one extra" : ", \(n) extra"
        }
        if c.role == .boreSet { s += ", set" } else if c.role == .fault { s += ", at fault" }
        if let f = c.forbidden { s += ", forbidden bid \(f)" }
        return s
    }

    private static func spokenNumber(_ n: Int) -> String { n < 0 ? "minus \(-n)" : "\(n)" }
    private static func spokenDelta(_ n: Int) -> String { n > 0 ? "plus \(n)" : n < 0 ? "minus \(-n)" : "no change" }

    /// The whole card: the columns, one row per completed hand, then the hand in play (bids only)
    /// unless its row has come.
    static func model(rows: [ScorecardRow], solo: Bool, me: Int?, name: (Int) -> String, current: Current? = nil) -> Model {
        let cols = columns(solo: solo, me: me, name: name)
        var out = rows.map { row(for: $0, cols, name: name, current: false) }
        if let current, current.handSize >= 1, !rows.contains(where: { $0.handNo == current.handNo }) {
            let r = ScorecardRow(handNo: current.handNo, handSize: current.handSize, trump: current.trump, dealer: current.dealer,
                                 bids: current.bids.map { $0 ?? "" }, took: [], points: [], scores: [])
            out.append(row(for: r, cols, name: name, current: true, rawBids: current.bids))
        }
        return Model(solo: solo, players: cols.players, pairs: cols.pairs, scoreColumns: cols.scores, rows: out)
    }

    private static func row(for r: ScorecardRow, _ cols: (players: [Player], pairs: [Pair], scores: [ScoreColumn]),
                            name: (Int) -> String, current: Bool, rawBids: [String?]? = nil) -> Row {
        let hand = handLabel(r.handSize, r.trump)
        let cells = cols.players.map { p -> Cell in
            if let rawBids {
                let i = p.position - 1
                return cell(bid: rawBids.indices.contains(i) ? rawBids[i] : nil, took: nil, pos: p.position, faults: [], set: nil, forbidden: nil)
            }
            return cell(r, p.position, current: current)
        }
        let dealerName = (1...4).contains(r.dealer) ? { let s = name(r.dealer); return s.isEmpty ? "P\(r.dealer)" : s }() : ""
        let scores: [ScoreCell]? = current ? nil : cols.scores.map {
            ScoreCell(total: r.scores.indices.contains($0.index) ? r.scores[$0.index] : 0,
                      delta: r.points.indices.contains($0.index) ? r.points[$0.index] : 0,
                      showDelta: r.handNo != 1, colour: $0.colour)
        }
        var parts = ["\(hand.spoken).", dealerName.isEmpty ? "" : "Dealer \(dealerName)."]
        for (i, c) in cells.enumerated() { parts.append(words(cols.players[i].name, c) + ".") }
        if let scores {
            for (i, sc) in scores.enumerated() {
                parts.append("\(cols.scores[i].spoken) \(spokenNumber(sc.total))\(sc.showDelta ? ", \(spokenDelta(sc.delta))" : "").")
            }
        } else {
            parts.append("Hand in play.")
        }
        return Row(handNo: r.handNo, hand: hand, dealer: dealerName, cells: cells, scores: scores, current: current,
                   spoken: parts.filter { !$0.isEmpty }.joined(separator: " "))
    }
}
