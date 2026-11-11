import XCTest
@testable import BAB_Online

/// Owner report 2026-11-11: "both members of the other team did a bore and
/// double bore and it was my turn to bid ... not sure if triple bore was
/// grayed out (it should be available)". The bid sheet's bore buttons are
/// BidRules.availableBores(bids: GameState.tempBids) (BidOverlayView shows
/// only those; 1.1.0's view has the same inline rule). These tests drive the
/// owner's sequence through the reducer: live, from a recorded game, from a
/// reload snapshot and after a redeal.
final class BoreButtonTests: XCTestCase {
    func testAvailableBoresRule() {
        XCTAssertEqual(BidRules.availableBores(bids: []), ["B"])
        XCTAssertEqual(BidRules.availableBores(bids: ["3", "0"]), ["B"])
        XCTAssertEqual(BidRules.availableBores(bids: ["B"]), ["2B"])
        XCTAssertEqual(BidRules.availableBores(bids: ["B", "1", "2B"]), ["3B"])
        XCTAssertEqual(BidRules.availableBores(bids: ["B", "2B"]), ["3B"])
        XCTAssertEqual(BidRules.availableBores(bids: ["b", "2b"]), ["3B"], "any case")
        XCTAssertEqual(BidRules.availableBores(bids: ["B", "2B", "3B"]), ["4B"])
        XCTAssertEqual(BidRules.availableBores(bids: ["B", "2B", "3B", "4B"]), [])
    }

    private func bid(_ s: inout TableState, _ pos: Int, _ bid: Any, array: [Any], seq: Int) {
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": bid, "position": pos, "bidArray": array, "seq": seq]))
    }

    /// Me at seat 1, bidder 2: opp 2 bids B, my partner (3) a number, opp 4 2B, then my turn.
    func testOpponentsBoreAndDoubleBoreThenMyTurn() {
        for partner in ["0", "3"] as [Any] {
            var s = T.dealtState(size: 3, dealer: 1)
            XCTAssertEqual(s.table.phase.bids?.order, [2, 3, 4, 1])
            TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 3]))
            XCTAssertEqual(BidRules.availableBores(bids: s.table.phase.bids?.tempBids ?? []), ["B"])
            bid(&s, 2, "B", array: [NSNull(), "B"], seq: 4)
            TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 3, "seq": 5]))
            bid(&s, 3, partner, array: [NSNull(), "B", "\(partner)"], seq: 6)
            TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 4, "seq": 7]))
            bid(&s, 4, "2B", array: [NSNull(), "B", "\(partner)", "2B"], seq: 8)
            TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 9]))
            XCTAssertEqual(s.table.myTurn, .choosing(.bid))
            XCTAssertEqual(s.table.phase.bids?.tempBids, ["B", "\(partner)", "2B"])
            XCTAssertEqual(BidRules.availableBores(bids: s.table.phase.bids?.tempBids ?? []), ["3B"])
        }
    }

    /// A redeal (every bid 0) before the bores: nothing of the first deal is left.
    func testRedealThenBores() {
        var s = T.dealtState(size: 3, dealer: 1)
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 3]))
        bid(&s, 2, "0", array: [NSNull(), "0"], seq: 4)
        bid(&s, 3, "0", array: [NSNull(), "0", "0"], seq: 5)
        bid(&s, 4, "0", array: [NSNull(), "0", "0", "0"], seq: 6)
        bid(&s, 1, "0", array: ["0", "0", "0", "0"], seq: 7)
        TableReducer.reduce(&s, T.ev("destroyHands", ["seq": 8]))
        TableReducer.reduce(&s, T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "2"), T.card("hearts", "3"), T.card("clubs", "4")],
                                                    "trump": T.card("clubs", "3"), "dealer": 1, "position": 1, "currentHand": 3, "seq": 9]))
        XCTAssertEqual(s.table.phase.bids?.tempBids, [])
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 10]))
        bid(&s, 2, "B", array: [NSNull(), "B"], seq: 11)
        bid(&s, 3, "1", array: [NSNull(), "B", "1"], seq: 12)
        bid(&s, 4, "2B", array: [NSNull(), "B", "1", "2B"], seq: 13)
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 14]))
        XCTAssertEqual(s.table.myTurn, .choosing(.bid))
        XCTAssertEqual(BidRules.availableBores(bids: s.table.phase.bids?.tempBids ?? []), ["3B"])
    }

    /// A reload in the middle of that bidding: the snapshot's bids give the same buttons.
    func testReloadSnapshotMidBidding() throws {
        let snap = try T.snapshot("bidding-mid") { raw in
            var bids = raw["bids"] as! [String: Any]
            bids["byPosition"] = ["B", "0", "2B", NSNull()]
            bids["order"] = [1, 2, 3, 4]
            bids["mults"] = ["team1": 4, "team2": 1]
            raw["bids"] = bids
            var deal = raw["deal"] as! [String: Any]
            deal["dealer"] = 4
            deal["bidder"] = 1
            raw["deal"] = deal
        }
        let s = TableReducer.state(from: snap, hints: nil, previous: nil, source: .requested("t"))
        XCTAssertEqual(s.table.viewer.position, 4)
        XCTAssertEqual(s.table.myTurn, .choosing(.bid))
        XCTAssertEqual(s.table.phase.bids?.tempBids, ["B", "0", "2B"])
        XCTAssertEqual(BidRules.availableBores(bids: s.table.phase.bids?.tempBids ?? []), ["3B"])
    }

    /// The recorded game with exactly the owner's sequence (events-presence-s21,
    /// seat 3 after a reconnect): bot seat 4 bids B, seat 1 (my partner) 1,
    /// bot seat 2 2B, then my turn. The scripted player bid 1; the sheet offered 3B.
    func testRecordedOwnerSequence() throws {
        let game = try RecordedGame("events-presence-s21")
        let viewer = game.viewer("seat3-rejoin")
        let log = try XCTUnwrap(game.logs[viewer.label])
        let turn = try XCTUnwrap(log.firstIndex { e in
            guard e.event == "updateTurn", let d = e.data as? [String: Any], d["currentTurn"] as? Int == 3, e.i > 0 else { return false }
            let prev = log[e.i - 1]
            return prev.event == "bidReceived" && ((prev.data as? [String: Any])?["bid"] as? String) == "2B"
        })
        var replay = ReducerReplay(viewer: viewer)
        for e in log.prefix(through: turn) { try replay.apply(e) }
        XCTAssertEqual(replay.state.table.viewer.position, 3)
        XCTAssertEqual(replay.state.table.myTurn, .choosing(.bid))
        XCTAssertEqual(replay.state.table.phase.bids?.tempBids, ["B", "1", "2B"])
        XCTAssertEqual(BidRules.availableBores(bids: replay.state.table.phase.bids?.tempBids ?? []), ["3B"])
    }
}
