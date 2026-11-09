import XCTest
@testable import BAB_Online

/// Done-when (c): a rejected or unanswered play/bid is restored.
@MainActor
final class ActionCoordinatorTests: XCTestCase {
    // MARK: recorded rejects (events-humans-s13, seat3 = position 4, on turn at hand 2)

    private func seat3(upTo index: Int) throws -> (ReplayHarness, [RecordedGame.Entry]) {
        let game = try RecordedGame("events-humans-s13")
        let viewer = game.viewer("seat3")
        let log = game.logs["seat3"]!
        let h = ReplayHarness(viewer: viewer)
        for e in log.prefix(index) { try h.apply(e) }
        return (h, log)
    }

    private func index(_ log: [RecordedGame.Entry], reason: String) -> Int {
        log.firstIndex { $0.event == "actionRejected" && ($0.data as? [String: Any])?["reason"] as? String == reason }!
    }

    func testRecordedIllegalCardRejectPutsTheCardBack() throws {
        let game = try RecordedGame("events-humans-s13")
        let rej = index(game.logs["seat3"]!, reason: "illegal_card")
        let (h, log) = try seat3(upTo: rej - 1)
        XCTAssertEqual(h.store.myTurn, .choosing(.play))
        let card = Card.from((log[rej - 1].data as! [String: Any])["card"] as! [String: Any])!
        try h.apply(log[rej - 1])  // the c2s play
        XCTAssertEqual(h.store.state.pending?.submission, .play(card))
        XCTAssertTrue(h.store.myTurn.isSubmitted)
        XCTAssertFalse(TableRenderModel(h.store.state).hand!.cards.contains(card), "hidden while submitted")
        try h.apply(log[rej])      // actionRejected illegal_card + snapshot
        XCTAssertEqual(h.store.myTurn, .choosing(.play))
        XCTAssertTrue(TableRenderModel(h.store.state).hand!.cards.contains(card), "back in the hand")
    }

    func testRecordedCardNotInHandRejectAndRestorePlayerState() throws {
        let game = try RecordedGame("events-humans-s13")
        let rej = index(game.logs["seat3"]!, reason: "invalid_play")
        let (h, log) = try seat3(upTo: rej - 1)
        let notInHand = Card.from((log[rej - 1].data as! [String: Any])["card"] as! [String: Any])!
        XCTAssertFalse(h.actions.play(notInHand), "the app never sends a card it does not hold")
        let hand = h.store.myCards
        try h.apply(log[rej - 1]); try h.apply(log[rej]); try h.apply(log[rej + 1])  // play, actionRejected, restorePlayerState
        XCTAssertEqual(log[rej + 1].event, "restorePlayerState")
        XCTAssertEqual(h.store.myCards.sorted { $0.id < $1.id }, hand.sorted { $0.id < $1.id })
        XCTAssertEqual(h.store.myTurn, .choosing(.play))
    }

    func testRecordedDoubleTapKeepsTheCardPlayed() throws {
        let game = try RecordedGame("events-humans-s13")
        let log = game.logs["seat3"]!
        let illegal = index(log, reason: "illegal_card")
        let rej = log.indices.first { $0 > illegal && log[$0].event == "actionRejected" && (log[$0].data as? [String: Any])?["action"] as? String == "play" }!
        let (h, _) = try seat3(upTo: rej + 1)
        guard case .playing(let p) = h.store.table.phase else { return XCTFail() }
        let mine = try XCTUnwrap(p.trick.first { $0.position == 4 })
        XCTAssertFalse(h.store.myCards.contains(mine.card), "the not_your_turn snapshot shows it played")
        XCTAssertNil(h.store.state.pending)
    }

    // MARK: coordinator behaviour

    private func store(fixture: String) throws -> ReplayHarness {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot(fixture), .rejoin, hints: nil))
        return h
    }

    private func legalCard(_ h: ReplayHarness) throws -> Card {
        let hand = try XCTUnwrap(TableRenderModel(h.store.state).hand)
        return try XCTUnwrap(hand.cards.first { hand.legalIds.contains($0.id) })
    }

    func testBidRejectReenablesTheOverlayAndBoresGoAsStrings() throws {
        let h = try store(fixture: "bidding-mid")  // seat 4 on bid turn, B already bid
        XCTAssertEqual(h.store.myTurn, .choosing(.bid))
        XCTAssertTrue(h.actions.bid("2B"))
        XCTAssertEqual(h.emitter.sent, [.bid("2B", 4)])
        XCTAssertEqual(LiveGameEmitter.playerBidPayload("2B", position: 4)["bid"] as? String, "2B")
        XCTAssertEqual(LiveGameEmitter.playerBidPayload("3", position: 4)["bid"] as? Int, 3)
        XCTAssertEqual(h.store.myTurn, .submitted(.bid("2B"), reqId: 1))
        XCTAssertFalse(h.actions.bid("1"), "no second submit")
        let raw = try FixtureLoader.v2Snapshot("bidding-mid")
        h.handler.handle(event: "actionRejected", payload: [["action": "bid", "reason": "not_your_turn", "snapshot": raw]])
        XCTAssertEqual(h.store.myTurn, .choosing(.bid))
    }

    func testDoubleTapWhileSubmittedIsBlocked() throws {
        let h = try store(fixture: "trick-mid-lead3")
        let card = try legalCard(h)
        XCTAssertTrue(h.actions.play(card))
        XCTAssertFalse(h.actions.play(card))
        XCTAssertEqual(h.emitter.sent.count, 1)
    }

    func testTimeoutResyncsAndTheReplyRestoresTheCard() throws {
        let h = try store(fixture: "trick-mid-lead3")
        let card = try legalCard(h)
        h.actions.play(card)
        h.clock.advance(AckPolicy.timeout - 0.1)
        XCTAssertEqual(h.emitter.snapshotRequests, [])
        h.clock.advance(0.2)
        XCTAssertEqual(h.emitter.snapshotRequests, ["ack-1"])
        XCTAssertTrue(h.store.myTurn.isSubmitted, "kept until the reply")
        // The server never saw the play: its snapshot still has the card in hand
        h.handler.handle(event: "stateSnapshot", payload: [["snapshot": try FixtureLoader.v2Snapshot("trick-mid-lead3"), "requestId": "ack-1"]])
        XCTAssertEqual(h.store.myTurn, .choosing(.play))
        XCTAssertTrue(TableRenderModel(h.store.state).hand!.cards.contains(card))
    }

    func testSecondTimeoutRollsBackLocally() throws {
        let h = try store(fixture: "trick-mid-lead3")
        let card = try legalCard(h)
        h.actions.play(card)
        XCTAssertFalse(TableRenderModel(h.store.state).hand!.cards.contains(card), "hidden while submitted")
        h.clock.advance(AckPolicy.timeout)
        h.clock.advance(AckPolicy.timeout)
        XCTAssertEqual(h.emitter.snapshotRequests, ["ack-1"], "one resync (maxResyncs), then a local rollback")
        XCTAssertEqual(h.store.myTurn, .choosing(.play))
        XCTAssertTrue(TableRenderModel(h.store.state).hand!.cards.contains(card), "the card is back in the hand")
        XCTAssertEqual(h.clock.pending, 0)
    }

    func testTransportErrorResyncsAtOnce() throws {
        let h = try store(fixture: "trick-mid-lead3")
        h.actions.play(try legalCard(h))
        h.store.apply(.local(.transportError(handler: "playCard")))
        XCTAssertEqual(h.emitter.snapshotRequests, ["ack-1"])
    }

    func testNotInGameDropsThePending() throws {
        let h = try store(fixture: "trick-mid-lead3")
        h.actions.play(try legalCard(h))
        h.clock.advance(AckPolicy.timeout)
        h.handler.handle(event: "stateSnapshot", payload: [["snapshot": NSNull(), "reason": "not_in_game", "requestId": "ack-1"]])
        XCTAssertNil(h.store.state.pending)
        XCTAssertFalse(h.store.myTurn.isSubmitted)
    }

    func testAConfirmedPlayCancelsItsTimer() throws {
        let h = try store(fixture: "trick-mid-lead3")
        let card = try legalCard(h)
        h.actions.play(card)
        let seq = h.store.state.sync.lastSeq! + 1
        h.handler.handle(event: "cardPlayed", payload: [["card": ["suit": card.suit.rawValue, "rank": card.rank.rawValue], "position": 1, "trump": false, "seq": seq]])
        XCTAssertNil(h.store.state.pending)
        XCTAssertEqual(h.clock.pending, 0)
        h.clock.advance(AckPolicy.timeout * 3)
        XCTAssertEqual(h.emitter.snapshotRequests, [], "a stale timer does nothing")
        XCTAssertFalse(h.store.myCards.contains(card))
    }

    func testIllegalOrOutOfTurnPlaysAreNeverSent() throws {
        let h = try store(fixture: "between-tricks")  // seat 2 on turn, I am seat 1
        XCTAssertFalse(h.actions.play(h.store.myCards[0]))
        XCTAssertEqual(h.emitter.sent, [])
    }
}
