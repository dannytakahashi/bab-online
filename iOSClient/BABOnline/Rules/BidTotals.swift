import Foundation

/// Bids as trick counts: the ONE place the app turns a bid into a number of
/// tricks (the web's client/src/rules/bids.js, which mirrors the server).
///
/// A bore (B / 2B / 3B / 4B) is the team's bet to win every trick, so it
/// counts as the whole hand; a team's total is capped at the hand size
/// (server/game/rules.js: "bores count as 13 and are capped at the hand
/// size"; the server caps its own team totals at the hand). Used by the seat
/// pips (SeatPips), the score bar's "Tricks: won/total" and the trick
/// history's safe / danger border (TrickHistoryNode).
enum BidTotals {
    /// The largest hand (the last deal).
    static let maxHandSize = 13

    /// The deal's hand size, or 13 when it is not known.
    static func hand(_ handSize: Int?) -> Int {
        guard let n = handSize, n > 0 else { return maxHandSize }
        return min(n, maxHandSize)
    }

    /// Whether a bid is a bore (B, 2B, 3B, 4B).
    static func isBore(_ bid: String?) -> Bool { bid.map(BidRules.isBore) ?? false }

    /// The tricks one bid counts for: its number, the hand size for a bore, nil when
    /// it is not placed (or not a bid).
    static func tricks(_ bid: String?, handSize: Int?) -> Int? {
        guard let raw = bid?.uppercased(), !raw.isEmpty else { return nil }
        if BidRules.isBore(raw) { return hand(handSize) }
        guard raw.allSatisfy(\.isASCII), raw.allSatisfy(\.isNumber), let n = Int(raw) else { return nil }
        return min(n, hand(handSize))
    }

    /// A team's bid total: min(hand size, the two bids' tricks); a bid not placed yet counts 0.
    static func teamTotal(_ a: String?, _ b: String?, handSize: Int?) -> Int {
        min(hand(handSize), (tricks(a, handSize: handSize) ?? 0) + (tricks(b, handSize: handSize) ?? 0))
    }

    /// Both teams' totals, absolute (team 1 = seats 1 and 3).
    static func totals(_ bids: BidBook, handSize: Int?) -> TeamPair {
        TeamPair(team1: teamTotal(bids.bid(at: 1), bids.bid(at: 3), handSize: handSize),
                 team2: teamTotal(bids.bid(at: 2), bids.bid(at: 4), handSize: handSize))
    }

    /// A trick pile's border: safe once the team has its bid total, else danger.
    enum PileBorder: String, Equatable { case safe, danger }

    static func pileBorder(won: Int, total: Int) -> PileBorder { won >= total ? .safe : .danger }
}
