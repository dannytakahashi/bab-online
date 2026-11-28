#if DEBUG
import CoreGraphics
import Foundation

/// The scorecard in fixture mode (ScorecardUITests; owner 2026-11-27). `-uiScorecard YES`:
///
///   - a table fixture whose snapshot is at hand 1 (`trick-mid-lead3`, `bidding-mid`,
///     `spectator-mid-hand`, ...) moves on to hand `-uiScorecardHands <n>` + 1 (default 3: the
///     6-card hand), its hand and the seats' card counts cut to that size, the score the rows'
///     totals, and the snapshot's `scorecard` the first n rows below (the approved mockup's
///     table: ivy & hal vs kim & jon);
///   - `game-end` / `game-end-spectator` / `game-end-tournament`: gameEnd carries all 13 rows
///     and the score is their total;
///   - `gyb-bidding` / `gyb-playing` / `gyb-spectator`: the snapshot carries the 3 hands before
///     the 6 (totals 26, 13, 11 as the carrier's gyb); `gyb-end`: gameEnd carries 13 rows and its
///     scores are their totals.
///
/// Every row is computed by the server's rules (calculateScore, handFaults, gybHandScore), so
/// each delta is what its total changed by. Cases on the card: extra tricks, a fault, a made
/// bore (hand 5), a set 2B (hand 9), a rainbow (hand 5), a joker hand (hand 7), the Forbidden Bid.
/// `-uiScorecardNone YES`: no `scorecard` key anywhere (an older server).
/// `-uiScorecardWidth <pt>`: the table no wider than that (the narrowest game-end card, the
/// closed Duo's ~350 pt, on any phone: review of PR #455, "Dea…" there).
extension UIFixture {
    static let scorecardMode: Bool = isActive && UserDefaults.standard.bool(forKey: "uiScorecard")
    static let scorecardNone: Bool = isActive && UserDefaults.standard.bool(forKey: "uiScorecardNone")
    static let scorecardWidth: CGFloat? = isActive
        ? Double(UserDefaults.standard.string(forKey: "uiScorecardWidth") ?? "").map { CGFloat($0) } : nil
    static var scorecardHands: Int { min(12, max(0, Int(UserDefaults.standard.string(forKey: "uiScorecardHands") ?? "") ?? 3)) }

    private static func card(_ suit: String, _ rank: String) -> [String: Any] { ["suit": suit, "rank": rank] }

    /// (size, trump, dealer, bids by position, took by position, rainbows [team1, team2])
    private static let classicHands: [(Int, [String: Any], Int, [String], [Int], [Int])] = [
        (12, card("hearts", "9"), 2, ["3", "2", "2", "1"], [3, 3, 3, 3], [0, 0]),
        (10, card("spades", "4"), 3, ["2", "3", "2", "2"], [4, 1, 3, 2], [0, 0]),
        (8, card("diamonds", "J"), 4, ["1", "2", "1", "2"], [1, 3, 1, 3], [0, 0]),
        (6, card("clubs", "7"), 1, ["2", "2", "1", "0"], [1, 2, 1, 2], [0, 0]),
        (4, card("hearts", "Q"), 2, ["B", "0", "0", "0"], [4, 0, 0, 0], [0, 1]),
        (2, card("spades", "10"), 3, ["1", "0", "0", "1"], [1, 1, 0, 0], [0, 0]),
        (1, card("joker", "LO"), 4, ["0", "1", "0", "0"], [0, 1, 0, 0], [0, 0]),
        (3, card("diamonds", "5"), 1, ["1", "1", "0", "1"], [2, 0, 0, 1], [0, 0]),
        (5, card("diamonds", "8"), 2, ["1", "2B", "0", "0"], [1, 4, 0, 0], [0, 0]),
        (7, card("spades", "K"), 3, ["2", "2", "2", "1"], [2, 2, 2, 1], [0, 0]),
        (9, card("hearts", "3"), 4, ["3", "2", "2", "2"], [4, 2, 1, 2], [0, 0]),
        (11, card("clubs", "A"), 1, ["3", "3", "2", "3"], [3, 4, 1, 3], [0, 0]),
        (13, card("spades", "6"), 2, ["4", "3", "3", "3"], [5, 3, 3, 2], [0, 0]),
    ]

    private static func rank(_ b: String) -> Int { b.contains("B") ? 13 : (Int(b) ?? 0) }
    private static func mult(_ a: String, _ b: String) -> Int {
        for (level, m) in [("4B", 16), ("3B", 8), ("2B", 4), ("B", 2)] where a == level || b == level { return m }
        return 1
    }

    /// The base game's rows, as server/game/scorecard.js builds them (calculateScore, handFaults).
    static func classicScorecard(_ count: Int = 13) -> [[String: Any]] {
        var totals = [0, 0]
        var out: [[String: Any]] = []
        for (i, h) in classicHands.prefix(count).enumerated() {
            let (size, trump, dealer, bids, took, rainbows) = h
            var points = [0, 0], set = [false, false], faults: [Int] = []
            for team in 0..<2 {
                let seats = team == 0 ? [1, 3] : [2, 4]
                let bid = min(size, rank(bids[seats[0] - 1]) + rank(bids[seats[1] - 1]))
                let m = mult(bids[seats[0] - 1], bids[seats[1] - 1])
                let won = took[seats[0] - 1] + took[seats[1] - 1]
                points[team] = (won >= bid ? bid * 10 * m + (won - bid) : -(bid * 10 * m)) + rainbows[team] * 10
                set[team] = won < bid
                if set[team] {
                    for p in seats where (bids[p - 1].contains("B") ? 0 : (Int(bids[p - 1]) ?? 0)) > took[p - 1] { faults.append(p) }
                }
            }
            totals = [totals[0] + points[0], totals[1] + points[1]]
            out.append(["handNo": i + 1, "handSize": size, "trump": trump, "dealer": dealer, "bids": bids, "took": took,
                        "points": points, "scores": totals, "faults": faults.sorted { [1, 3, 2, 4].firstIndex(of: $0)! < [1, 3, 2, 4].firstIndex(of: $1)! },
                        "set": set])
        }
        return out
    }

    /// Get Your Bid's rows (gybHandScore and the Forbidden Bid): `first` three as the gyb
    /// fixtures' scores (26, 13, 11), the rest made up the same way.
    static func gybScorecard(_ count: Int = 13) -> [[String: Any]] {
        let sizes = [12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13]
        let suits = ["hearts", "spades", "diamonds", "clubs"]
        let first: [([Int], [Int])] = [([3, 3, 1], [3, 3, 6]), ([2, 1, 1], [4, 5, 1]), ([3, 2, 4], [3, 3, 2])]
        var totals = [0, 0, 0]
        var out: [[String: Any]] = []
        for i in 0..<count {
            let size = sizes[i], dealer = i % 3 + 1
            var bids: [Int], took: [Int]
            if i < first.count {
                (bids, took) = first[i]
            } else {
                took = [size / 3 + (size % 3 > 0 ? 1 : 0), size / 3 + (size % 3 > 1 ? 1 : 0), size / 3]
                bids = [took[0], took[1] + (i % 2), i % 3 == 0 ? max(0, took[2] - 1) : took[2]]
            }
            // the last bidder (the dealer) may not make the bids add up on 5+ cards
            var forbidden: [String: Any]? = nil
            if size >= 5 {
                let others = (1...3).filter { $0 != dealer }.reduce(0) { $0 + bids[$1 - 1] }
                let f = size - others
                if (0...size).contains(f) {
                    if bids[dealer - 1] == f { bids[dealer - 1] = f < size ? f + 1 : f - 1 }
                    forbidden = ["position": dealer, "bid": f]
                }
            }
            let points = (0..<3).map { k -> Int in
                if took[k] == bids[k] { return bids[k] == 0 ? 5 : 10 + bids[k] }
                if let f = forbidden, f["position"] as? Int == k + 1, f["bid"] as? Int == took[k] { return 1 }
                return 0
            }
            totals = zip(totals, points).map(+)
            out.append(["handNo": i + 1, "handSize": size, "trump": card(suits[i % 4], "7"), "dealer": dealer,
                        "bids": bids.map(String.init), "took": took, "points": points, "scores": totals, "faults": [Int](),
                        "forbidden": forbidden as Any? ?? NSNull()])
        }
        return out
    }

    /// The table snapshot moved on to the hand after `scorecardHands` rows, with those rows.
    static func editScorecard(_ snap: inout [String: Any]) {
        if scorecardNone { snap.removeValue(forKey: "scorecard"); return }
        guard scorecardMode, var deal = snap["deal"] as? [String: Any], deal["handNo"] as? Int == 1 else { return }
        let n = scorecardHands
        let rows = classicScorecard(n)
        snap["scorecard"] = rows
        guard n > 0, let last = rows.last?["scores"] as? [Int] else { return }
        let size = [12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13][n]
        let old = deal["handSize"] as? Int ?? 12
        deal["handNo"] = n + 1
        deal["handSize"] = size
        deal["dealer"] = classicHands[n].2
        deal["dealSeq"] = n + 1
        snap["deal"] = deal
        if let hand = snap["hand"] as? [[String: Any]] { snap["hand"] = Array(hand.prefix(max(0, size - (old - hand.count)))) }
        if var seats = snap["seats"] as? [[String: Any]] {
            for i in seats.indices { seats[i]["cardsInHand"] = max(0, size - (old - (seats[i]["cardsInHand"] as? Int ?? old))) }
            snap["seats"] = seats
        }
        snap["score"] = ["team1": last[0], "team2": last[1]]
    }

    /// gameEnd's `scorecard` and its score for a game-end fixture (nil: as before).
    static func scorecardEnd() -> (rows: [[String: Any]], team1: Int, team2: Int)? {
        guard scorecardMode, !scorecardNone else { return nil }
        let rows = classicScorecard()
        let last = rows.last?["scores"] as? [Int] ?? [0, 0]
        return (rows, last[0], last[1])
    }

    /// A Get Your Bid fixture's snapshot rows (the three hands before its 6).
    static func editGybScorecard(_ snap: inout [String: Any]) {
        if scorecardNone { snap.removeValue(forKey: "scorecard"); return }
        snap["scorecard"] = scorecardMode ? gybScorecard(3) : [[String: Any]]()
    }
}
#endif
