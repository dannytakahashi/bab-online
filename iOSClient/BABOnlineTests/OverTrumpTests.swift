import XCTest
@testable import BAB_Online

/// The over-trump rule (owner 2026-11-11; TrickRules.isOverTrump, web mirror
/// client/src/rules/overTrump.test.js, both reading contract/rules/legality-cases.json): the card just played is
/// a trump or joker, the lead is not trump (a joker lead is), and it takes
/// the trick from an OPPONENT whose winning card was a trump or joker.
/// `legacy` is the pre-2026-11-11 detector (the last card vs the one before
/// it); the marked rows are the ones it got wrong.
final class OverTrumpTests: XCTestCase {
    private static let spades = Card(suit: .spades, rank: .seven)
    private static let noTrump = Card(suit: .joker, rank: .lo)  // a flipped joker: only the jokers are trump

    /// "1:Kh 2:5s 3:HIj" → play order
    private func trick(_ spec: String) -> [PlayedCard] {
        let suits: [Character: Suit] = ["s": .spades, "h": .hearts, "d": .diamonds, "c": .clubs, "j": .joker]
        return spec.split(separator: " ").map { tok in
            let parts = tok.split(separator: ":")
            let c = parts[1]
            return PlayedCard(card: Card(suit: suits[c.last!]!, rank: Rank(rawValue: String(c.dropLast()))!), position: Int(parts[0])!)
        }
    }

    /// The pre-2026-11-11 TrickRules.isOverTrump.
    private func legacy(_ trick: [PlayedCard], _ trump: Card) -> Bool {
        guard trick.count >= 2, let lead = trick.first?.card else { return false }
        let card = trick[trick.count - 1].card
        let previous = trick[trick.count - 2].card
        let isTrump = { (c: Card) in c.suit == trump.suit || c.suit == .joker }
        guard !isTrump(lead), isTrump(card), isTrump(previous) else { return false }
        return (CardConstants.rankValues[card.rank] ?? 0) > (CardConstants.rankValues[previous.rank] ?? 0)
    }

    /// The rows are the shared table's `tricks` (contract/rules/legality-cases.json,
    /// also run by Jest and Vitest; LegalityCaseTableTests checks their winners).
    func testCaseTable() throws {
        let rows = try LegalityCaseTableTests.caseTable().tricks
        for row in rows {
            let t = trick(row.trick)
            let trump = LegalityCaseTableTests.card(row.trump)
            XCTAssertEqual(TrickRules.isOverTrump(trick: t, trump: trump), row.overTrump, row.name)
            XCTAssertEqual(legacy(t, trump) != row.overTrump, row.oldDetectorWrong, "old detector on: \(row.name)")
        }
        XCTAssertGreaterThanOrEqual(rows.filter { $0.oldDetectorWrong }.count, 3)
        XCTAssertFalse(TrickRules.isOverTrump(trick: trick("1:Kh 2:5s 3:9s"), trump: nil))
        XCTAssertFalse(TrickRules.isOverTrump(trick: [], trump: Self.spades))
    }

    /// winnerIndex is server/game/rules.js determineWinner (the web test
    /// checks its mirror against the server itself on random tricks).
    func testWinnerIndex() {
        XCTAssertEqual(TrickRules.winnerIndex(trick: trick("1:Kh 2:Ah 3:2d 4:Qh"), trump: Self.spades), 1)
        XCTAssertEqual(TrickRules.winnerIndex(trick: trick("1:Kh 2:Ah 3:2s 4:LOj"), trump: Self.spades), 3)
        XCTAssertEqual(TrickRules.winnerIndex(trick: trick("1:LOj 2:As 3:HIj 4:Ks"), trump: Self.spades), 2)
        XCTAssertEqual(TrickRules.winnerIndex(trick: trick("1:Kh 2:As 3:Ah 4:2c"), trump: Self.noTrump), 2)
        XCTAssertEqual(TrickRules.winnerIndex(trick: trick("2:5d 3:6d 4:LOj 1:Ad"), trump: Self.noTrump), 2)
        XCTAssertNil(TrickRules.winnerIndex(trick: [], trump: Self.spades))
    }

    /// The reducer emits .overTrump once per server cardPlayed that is one:
    /// not for the partner case, not again for a repeated (already applied) seq.
    func testReducerFiresOnceFromCardPlayed() {
        var s = T.dealtState(hand: [T.card("spades", "3"), T.card("hearts", "K")], size: 2, dealer: 4, trump: T.card("spades", "7"))
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 2, "seq": 3]))
        let ots = { (fx: [TableEffect]) in fx.animations.filter { if case .overTrump = $0 { return true } else { return false } }.count }
        var seq = 4
        func play(_ pos: Int, _ suit: String, _ rank: String) -> Int {
            defer { seq += 1 }
            return ots(TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card(suit, rank), "position": pos, "seq": seq])))
        }
        // trick 1: 2 leads a heart, my partner (3) ruffs with the 9, 4 under-trumps, my ace beats the 9: no OT
        XCTAssertEqual(play(2, "hearts", "A"), 0)
        XCTAssertEqual(play(3, "spades", "9"), 0)
        XCTAssertEqual(play(4, "spades", "5"), 0)
        XCTAssertEqual(play(1, "spades", "A"), 0, "over my partner's 9: not an over-trump (the old rule fired: A over the 5)")
        TableReducer.reduce(&s, T.ev("trickComplete", ["winner": 1, "seq": seq])); seq += 1
        // trick 2: 2 leads a heart, 3 ruffs with the 2, 4 over-trumps with the LO joker: one OT
        XCTAssertEqual(play(2, "hearts", "Q"), 0)
        XCTAssertEqual(play(3, "spades", "2"), 0)
        let otSeq = seq
        XCTAssertEqual(play(4, "joker", "LO"), 1)
        // the same cardPlayed again: the seq gate drops it
        XCTAssertEqual(ots(TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("joker", "LO"), "position": 4, "seq": otSeq]))), 0)
        // my K of hearts: a follow, no OT
        XCTAssertEqual(play(1, "hearts", "K"), 0)
    }
}
