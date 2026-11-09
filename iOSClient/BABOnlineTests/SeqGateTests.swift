import XCTest
@testable import BAB_Online

/// contract/README.md R1-R5 through the reducer's gate.
final class SeqGateTests: XCTestCase {
    private func playing() -> TableState {
        var s = T.dealtState()  // lastSeq 2
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "1", "0", "0"], "lead": 2, "teamBids": ["team1": 1, "team2": 1],
                                                      "mults": ["team1": 1, "team2": 1], "seq": 3]))
        return s
    }

    func testClassify() {
        XCTAssertEqual(SeqGate.classify(lastSeq: nil, seq: 7), .apply)
        XCTAssertEqual(SeqGate.classify(lastSeq: 7, seq: 8), .apply)
        XCTAssertEqual(SeqGate.classify(lastSeq: 7, seq: 7), .drop)
        XCTAssertEqual(SeqGate.classify(lastSeq: 7, seq: 3), .drop)
        XCTAssertEqual(SeqGate.classify(lastSeq: 7, seq: 9), .gap)
    }

    func testInOrderAndDuplicate() {
        var s = playing()
        XCTAssertEqual(s.sync.lastSeq, 3)
        let fx = TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "4"), "position": 2, "trump": false, "seq": 4]))
        XCTAssertEqual(s.table.phase.trick.count, 1)
        XCTAssertFalse(fx.contains { if case .gap = $0 { return true }; return false })
        let dup = TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "4"), "position": 2, "trump": false, "seq": 4]))
        XCTAssertEqual(dup, [.dropped(event: "cardPlayed", seq: 4)])
        XCTAssertEqual(s.table.phase.trick.count, 1)
    }

    func testGapBuffersAsksOnceThenASnapshotReplaysAboveS() throws {
        var s = playing()
        let fx1 = TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "4"), "position": 3, "trump": false, "seq": 6]))
        XCTAssertEqual(fx1, [.gap(expected: 4, got: 6), .requestSnapshot(requestId: "gap-1", log: false)])
        let fx2 = TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "5"), "position": 4, "trump": false, "seq": 7]))
        XCTAssertEqual(fx2, [.gap(expected: 4, got: 7)], "one request per gap")
        XCTAssertTrue(s.table.phase.trick.isEmpty, "nothing applied while buffered")
        // The snapshot reflects up to seq 6 (seats 2 and 3 played): seq 7 replays on top
        let snap = try T.snapshot("between-tricks") { raw in
            raw["gameId"] = "g1"; raw["seq"] = 6
            raw["trick"] = ["number": 2, "leadPosition": 2, "cards": [["position": 2, "card": T.card("clubs", "2")], ["position": 3, "card": T.card("clubs", "4")]]]
            raw["turn"] = ["position": 4, "action": "play"]
        }
        let fx3 = TableReducer.reduce(&s, .snapshot(snap, .requested("gap-1"), hints: nil))
        XCTAssertTrue(fx3.contains(.animate(.sceneReset)))
        XCTAssertEqual(s.table.phase.trick.map(\.position), [2, 3, 4])
        XCTAssertEqual(s.sync.lastSeq, 7)
        XCTAssertNil(s.sync.resyncId)
        XCTAssertEqual(s.sync.buffered, [])
    }

    func testFallbackFlushWhenNoSnapshotComes() {
        var s = playing()
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "4"), "position": 2, "trump": false, "seq": 5]))
        XCTAssertEqual(s.sync.buffered.count, 1)
        TableReducer.reduce(&s, T.ev("stateSnapshot", ["snapshot": NSNull(), "reason": "not_in_game", "requestId": "gap-1"]))
        XCTAssertEqual(s.table.phase.trick.count, 1, "degrades to applying in arrival order")
        XCTAssertEqual(s.sync.lastSeq, 5)
        XCTAssertNil(s.sync.resyncId)
    }

    func testRequestSnapshotErrorAlsoFlushes() {
        var s = playing()
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "4"), "position": 2, "trump": false, "seq": 5]))
        TableReducer.reduce(&s, .local(.transportError(handler: "requestSnapshot")))
        XCTAssertEqual(s.table.phase.trick.count, 1)
    }

    func testUnsequencedEventsAlwaysApply() {
        var s = playing()
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "4"), "position": 3, "trump": false, "seq": 9]))  // a gap is open
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1]))  // private, no seq
        XCTAssertEqual(s.table.phase.turn, 1)
    }

    func testBlockedChatStillAdvancesSeq() {
        var s = playing()
        TableReducer.reduce(&s, T.ev("chatMessage", ["username": "troll", "message": "x", "position": 2, "type": "player", "seq": 4], blocked: true))
        XCTAssertEqual(s.sync.lastSeq, 4)
        XCTAssertFalse(s.log.entries.contains { $0.message == "x" })
        let fx = TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "4"), "position": 2, "trump": false, "seq": 5]))
        XCTAssertFalse(fx.contains { if case .gap = $0 { return true }; return false })
    }

    func testContextChangesClearSync() {
        var s = playing()
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g2", tournamentId: nil)))
        XCTAssertNil(s.sync.lastSeq)
        s = playing()
        TableReducer.reduce(&s, .local(.reset))
        XCTAssertNil(s.sync.lastSeq)
    }
}
