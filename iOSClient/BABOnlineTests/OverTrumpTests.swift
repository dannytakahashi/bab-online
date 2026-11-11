import XCTest
@testable import BAB_Online

/// The over-trump rule (owner 2026-11-11; TrickRules.isOverTrump, web mirror
/// client/src/rules/overTrump.test.js, same table): the card just played is
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

    // (name, trick, trump, expected, oldWasWrong)
    private static let cases: [(String, String, Card, Bool, Bool)] = [
        ("opponent ruffs, the next player trumps higher", "1:Kh 2:5s 3:9s", spades, true, false),
        ("an over-trump of an over-trump", "1:Kh 2:5s 3:9s 4:Js", spades, true, false),
        ("the 4th seat over-trumps the 3rd", "1:Kh 2:Ah 3:5s 4:9s", spades, true, false),
        ("LO joker over the opponent's trump ace", "1:Kh 2:As 3:LOj", spades, true, false),
        ("HI joker over the opponent's LO joker", "1:Kh 2:LOj 3:HIj", spades, true, false),
        ("no-trump hand: HI over the opponent's LO", "1:Kh 2:LOj 3:HIj", noTrump, true, false),
        ("over my partner's trump (the opponent between under-trumped)", "1:Kh 2:9s 3:5s 4:Js", spades, false, true),
        ("beats the under-trump, not the partner's winning 9", "1:Kh 2:9s 3:5s 4:7s", spades, false, true),
        ("both jokers: HI over the partner's LO", "1:Kh 2:LOj 3:2s 4:HIj", spades, false, true),
        ("no-trump hand: HI over the partner's LO", "1:Kh 2:LOj 3:5h 4:HIj", noTrump, false, false),
        ("partner ruffed, the opponent followed, I trump higher", "1:Kh 2:5s 3:2h 4:9s", spades, false, false),
        ("a trump lead, then a higher trump", "1:5s 2:9s 3:Js", spades, false, false),
        ("a trump lead, a higher trump by the 4th seat", "1:5s 2:2s 3:3s 4:Js", spades, false, false),
        ("the HI joker led: forced trumps", "1:HIj 2:As 3:2s 4:Ks", spades, false, false),
        ("the LO joker led, the HI joker over it", "1:LOj 2:2s 3:HIj", spades, false, false),
        ("no-trump hand: LO led, HI over it", "1:LOj 2:5h 3:HIj", noTrump, false, false),
        ("the first trump of the trick (a ruff)", "1:Kh 2:Ah 3:2s", spades, false, false),
        ("an under-trump of the opponent", "1:Kh 2:9s 3:5s", spades, false, false),
        ("a slough after an opponent ruffed", "1:Kh 2:5s 3:2d", spades, false, false),
        ("no-trump hand: a spade is not a trump", "1:Kh 2:LOj 3:As", noTrump, false, false),
        ("no-trump hand: the first joker of the trick", "1:Kh 2:As 3:LOj", noTrump, false, false),
        ("a lead and one card", "1:Kh 2:5s", spades, false, false),
    ]

    func testCaseTable() {
        for (name, spec, trump, expected, oldWasWrong) in Self.cases {
            let t = trick(spec)
            XCTAssertEqual(TrickRules.isOverTrump(trick: t, trump: trump), expected, name)
            XCTAssertEqual(legacy(t, trump) != expected, oldWasWrong, "old detector on: \(name)")
        }
        XCTAssertGreaterThanOrEqual(Self.cases.filter { $0.4 }.count, 3)
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
