import Foundation

/// One seat's trick pips (owner, 2026-11-11: per player; the web's
/// ui/seatPlates.js `seatPips`), a pure projection of TableState:
/// - the seat's OWN bid as slots and its own tricks won (past the bid: over);
///   a 0 bid shows no slots (only over pips once it wins one);
/// - a bore seat (B to 4B): the whole hand as slots filled with the TEAM's
///   tricks (a bore is the team's bet to win every trick), outlined in the
///   bore chip's red; both rings when both partners bore;
/// - a seat whose own count is not known (`tricksByPosition` nil): its team's
///   tricks out of the team's total.
/// Nothing until both partners have bid, and nothing while bidding.
struct SeatPips: Equatable {
    /// Slots drawn: min(13, max(need, won)).
    var slots: Int
    /// Slots filled within the bid.
    var filled: Int
    /// Slots filled past the bid.
    var over: Int
    var isBore: Bool
    /// What the pips count: the seat's own tricks, or the team's (a bore, an unknown count).
    var countsTeam: Bool
    var need: Int
    var won: Int

    static let maxSlots = 13

    init(need: Int, won: Int, isBore: Bool, countsTeam: Bool) {
        self.need = need
        self.won = won
        self.isBore = isBore
        self.countsTeam = countsTeam
        let n = need + won > 0 ? min(Self.maxSlots, max(need, won)) : 0
        slots = n
        filled = min(won, need, n)
        over = max(0, min(won, n) - need)
    }

    /// "2 of 3 tricks" / "0 of 1 trick" / "Team 7 of 10, bore" / "Team 2 of 5 tricks" (VoiceOver;
    /// the web's title); a 0 bid, which has no slots: "Bid 0, no tricks" / "Bid 0, 2 tricks".
    var accessibilityLabel: String {
        if isBore { return "Team \(won) of \(need), bore" }
        if need == 0 && !countsTeam { return won == 0 ? "Bid 0, no tricks" : "Bid 0, \(Self.tricks(won))" }
        if countsTeam { return "Team \(won) of \(Self.tricks(need))" }
        return "\(won) of \(Self.tricks(need))"
    }

    /// "1 trick", "3 tricks".
    static func tricks(_ n: Int) -> String { n == 1 ? "1 trick" : "\(n) tricks" }

    /// Every seat's pips (1...4); a seat without pips is absent, unless `spoken`: then
    /// every seat whose bid counts (a 0 bid with no tricks too: VoiceOver says so).
    static func all(_ s: TableState, spoken: Bool = false) -> [Int: SeatPips] {
        let bids: BidBook
        switch s.table.phase {
        case .playing(let p): bids = p.bids
        case .handResolving(let h): bids = h.bids
        default: return [:]
        }
        let size = s.table.deal?.handSize
        var out: [Int: SeatPips] = [:]
        for pos in 1...4 {
            if let p = pips(pos, bids: bids, handSize: size, scores: s.scores), p.slots > 0 || spoken { out[pos] = p }
        }
        return out
    }

    static func pips(_ pos: Int, bids: BidBook, handSize: Int?, scores: ScoreSlice) -> SeatPips? {
        let bid = bids.bid(at: pos), partner = bids.bid(at: Positions.team(pos))
        guard BidTotals.tricks(bid, handSize: handSize) != nil, BidTotals.tricks(partner, handSize: handSize) != nil else { return nil }
        let teamWon = scores.tricks[team: Positions.getTeamNumber(pos)]
        if BidTotals.isBore(bid) {
            return SeatPips(need: BidTotals.hand(handSize), won: teamWon, isBore: true, countsTeam: true)
        }
        if let own = scores.tricksByPosition[pos - 1] {
            return SeatPips(need: BidTotals.tricks(bid, handSize: handSize) ?? 0, won: own, isBore: false, countsTeam: false)
        }
        return SeatPips(need: BidTotals.teamTotal(bid, partner, handSize: handSize), won: teamWon, isBore: false, countsTeam: true)
    }
}
