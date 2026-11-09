import XCTest
@testable import BAB_Online

final class RenderModelTests: XCTestCase {
    func testProvisionalCardLeavesTheHandForMyTrickSlot() throws {
        var s = try T.state(fixture: "trick-mid-lead3")  // seat 1 on turn, seats 3 and 4 played
        let card = try XCTUnwrap(TableRenderModel(s).hand?.cards.first { TableRenderModel(s).hand!.legalIds.contains($0.id) })
        TableReducer.reduce(&s, .local(.submitPlay(card, reqId: 1)))
        XCTAssertTrue(s.table.hand.contains(card), "the hand itself is never changed by a submission")
        let m = TableRenderModel(s)
        XCTAssertFalse(m.hand!.cards.contains(card))
        XCTAssertEqual(m.trick.last, .init(card: card, position: 1, playIndex: 2, provisional: true))
        XCTAssertFalse(m.hand!.interactive, "nothing more to play while submitted")
        // rollback = dropping the pending action
        s.pending = nil
        XCTAssertTrue(TableRenderModel(s).hand!.cards.contains(card))
        XCTAssertEqual(TableRenderModel(s).trick.count, 2)
    }

    func testLegalityOnlyOnMyPlayTurn() throws {
        let mine = TableRenderModel(try T.state(fixture: "trick-mid-lead3"))
        XCTAssertTrue(mine.hand!.interactive)
        XCTAssertFalse(mine.hand!.legalIds.isEmpty)
        XCTAssertLessThan(mine.hand!.legalIds.count, mine.hand!.cards.count + 1)
        let other = TableRenderModel(try T.state(fixture: "between-tricks"))  // seat 2 on turn
        XCTAssertEqual(other.hand!.legalIds, [])
        XCTAssertFalse(other.hand!.interactive)
        let bidding = TableRenderModel(try T.state(fixture: "bidding-mid"))  // my bid turn: every card shows
        XCTAssertEqual(bidding.hand!.legalIds.count, bidding.hand!.cards.count)
        XCTAssertFalse(bidding.hand!.interactive)
    }

    func testBidBubblesFromTheFirstBidUntilTheFirstCard() throws {
        XCTAssertEqual(TableRenderModel(try T.state(fixture: "bidding-mid")).bidBubbles, [2: "B", 3: "1"])
        let lead3 = TableRenderModel(try T.state(fixture: "trick-mid-lead3"))
        XCTAssertEqual(lead3.bidBubbles, [:], "gone once a card is down")
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "2", "0"], "lead": 1, "seq": 3]))
        XCTAssertEqual(TableRenderModel(s).bidBubbles, [1: "1", 2: "0", 3: "2", 4: "0"], "still up before the first card")
    }

    func testSpectatorSeesFourSeatsFromSeatOne() throws {
        let m = TableRenderModel(try T.state(fixture: "spectator-mid-hand"))
        XCTAssertTrue(m.isSpectator)
        XCTAssertEqual(m.opponents.map(\.rel), [.bottom, .left, .top, .right])
        XCTAssertEqual(m.opponents.first { $0.isTurn }?.position, 1)
        XCTAssertNil(m.hand)
    }

    func testSeatSeesPartnerAndOpponents() throws {
        let m = TableRenderModel(try T.state(fixture: "between-tricks"))
        XCTAssertEqual(m.opponents.map(\.position), [3, 2, 4])
        XCTAssertEqual(m.opponents.map(\.rel), [.top, .left, .right])
        XCTAssertEqual(m.trickKey, TrickKey(dealSeq: try XCTUnwrap(T.state(fixture: "between-tricks").table.deal?.dealSeq), trick: 2))
    }
}
