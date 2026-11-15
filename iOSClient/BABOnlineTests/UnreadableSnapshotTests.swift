import XCTest
import SwiftUI
@testable import BAB_Online

/// A snapshot this build cannot show (undecodable, v != 2, an unknown stage) ends the resync,
/// is retried SnapshotRetryPolicy.maxRetries times with backoff, then the table is `unreadable`
/// (update / leave), never a frozen table waiting forever on a resyncId.
@MainActor
final class UnreadableSnapshotTests: XCTestCase {
    private let fixture = "trick-mid-lead3"

    private func seated() throws -> ReplayHarness {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot(fixture), .rejoin, hints: nil))
        XCTAssertEqual(h.store.table.snapshotTrouble, .none)
        return h
    }

    private func raw(_ edit: (inout [String: Any]) -> Void = { _ in }) throws -> [String: Any] {
        var r = try FixtureLoader.v2Snapshot(fixture)
        edit(&r)
        return r
    }

    /// A snapshot as a server that dropped a field this build requires would send it.
    private func missingTrickHistory() throws -> [String: Any] { try raw { $0.removeValue(forKey: "trickHistory") } }

    /// An undecodable delta: the existing path (resyncNeeded -> gap-N at once).
    private func badDelta(_ h: ReplayHarness, seqAhead: Int = 1) {
        let seq = h.store.state.sync.lastSeq! + seqAhead
        h.handler.handle(event: "cardPlayed", payload: [["card": "not a card", "position": 2, "seq": seq]])
    }

    private func reply(_ h: ReplayHarness, _ snapshot: [String: Any], requestId: String) {
        h.handler.handle(event: "stateSnapshot", payload: [["snapshot": snapshot, "requestId": requestId]])
    }

    // MARK: undecodable stateSnapshot

    func testUndecodableStateSnapshotRetriesTwiceThenShowsTheUpdateState() throws {
        let h = try seated()
        badDelta(h)
        XCTAssertEqual(h.emitter.snapshotRequests, ["gap-1"])
        XCTAssertEqual(h.store.state.sync.resyncId, "gap-1")

        // the reply fails the same way: classified as a snapshot failure, with its request and path
        let first = h.store.apply(serverEvent: "stateSnapshot", payload: [["snapshot": try missingTrickHistory(), "requestId": "gap-1"]])
        XCTAssertEqual(first, .failure(.snapshot(event: "stateSnapshot", requestId: "gap-1",
                                                 problem: .undecodable("keyNotFound snapshot.trickHistory"))))
        XCTAssertNotEqual(h.store.state.sync.resyncId, "gap-1", "the pending resync is cleared (it froze the table)")
        XCTAssertEqual(h.store.table.snapshotTrouble, .retrying(attempt: 1))
        let retry1 = try XCTUnwrap(h.store.state.sync.resyncId)
        XCTAssertTrue(retry1.hasPrefix("snap-"))
        h.clock.advance(SnapshotRetryPolicy.delay(attempt: 1) - 0.1)
        XCTAssertEqual(h.emitter.snapshotRequests, ["gap-1"], "backoff: not at once")
        h.clock.advance(0.2)
        XCTAssertEqual(h.emitter.snapshotRequests, ["gap-1", retry1])

        reply(h, try missingTrickHistory(), requestId: retry1)
        XCTAssertEqual(h.store.table.snapshotTrouble, .retrying(attempt: 2))
        let retry2 = try XCTUnwrap(h.store.state.sync.resyncId)
        XCTAssertNotEqual(retry2, retry1)
        h.clock.advance(SnapshotRetryPolicy.delay(attempt: 2) - 0.1)
        XCTAssertEqual(h.emitter.snapshotRequests.count, 2, "a longer backoff the second time")
        h.clock.advance(0.2)
        XCTAssertEqual(h.emitter.snapshotRequests, ["gap-1", retry1, retry2])

        reply(h, try missingTrickHistory(), requestId: retry2)
        XCTAssertEqual(h.store.table.snapshotTrouble, .unreadable)
        XCTAssertNil(h.store.state.sync.resyncId)
        XCTAssertEqual(h.store.state.sync.snapshotFailures, SnapshotRetryPolicy.maxRetries + 1)

        // given up: no more requests, from retries, gaps or undecodable deltas
        h.clock.advance(60)
        badDelta(h, seqAhead: 3)
        h.handler.handle(event: "chatMessage", payload: [["username": "x", "message": "m", "position": 2, "type": "player",
                                                           "seq": h.store.state.sync.lastSeq! + 5]])
        h.clock.advance(60)
        XCTAssertEqual(h.emitter.snapshotRequests, ["gap-1", retry1, retry2])
        XCTAssertEqual(h.store.table.snapshotTrouble, .unreadable)
        XCTAssertEqual(h.store.state.sync.buffered, [], "nothing waits for a snapshot")
    }

    func testUnreadableDropsAPendingSubmission() throws {
        let h = try seated()
        let card = try XCTUnwrap(TableRenderModel(h.store.state).hand.flatMap { hand in hand.cards.first { hand.legalIds.contains($0.id) } })
        XCTAssertTrue(h.actions.play(card))
        for i in 0...SnapshotRetryPolicy.maxRetries {
            reply(h, try missingTrickHistory(), requestId: "r\(i)")
            h.clock.advance(SnapshotRetryPolicy.delay(attempt: i + 1))
        }
        XCTAssertEqual(h.store.table.snapshotTrouble, .unreadable)
        XCTAssertNil(h.store.state.pending, "nothing can confirm it now")
        XCTAssertTrue(h.effects.contains(.cancelAck(reqId: 1)))
    }

    // MARK: v != 2

    func testVersion3SnapshotIsNotShownAndEndsInTheUpdateState() throws {
        let h = try seated()
        let v3 = try raw { $0["v"] = 3 }
        let r = h.store.apply(serverEvent: "stateSnapshot", payload: [["snapshot": v3, "requestId": "x"]])
        XCTAssertEqual(r, .failure(.snapshot(event: "stateSnapshot", requestId: "x", problem: .version(3))))
        XCTAssertEqual(h.store.table.snapshotTrouble, .retrying(attempt: 1))
        for attempt in 1...SnapshotRetryPolicy.maxRetries {
            h.clock.advance(SnapshotRetryPolicy.delay(attempt: attempt))
            reply(h, v3, requestId: h.emitter.snapshotRequests.last!)
        }
        XCTAssertEqual(h.emitter.snapshotRequests.count, SnapshotRetryPolicy.maxRetries)
        XCTAssertEqual(h.store.table.snapshotTrouble, .unreadable)
        XCTAssertEqual(h.store.myCards, try T.snapshot(fixture).hand ?? [], "the v3 table was never applied")
    }

    /// A v3 snapshot that also fails to decode reports the version, and a missing or boolean v is not 2.
    func testVersionIsCheckedBeforeDecoding() throws {
        let broken = try raw { $0["v"] = 3; $0.removeValue(forKey: "seats") }
        XCTAssertEqual(ServerEvent.decode(name: "stateSnapshot", payload: [["snapshot": broken]]),
                       .failure(.snapshot(event: "stateSnapshot", requestId: nil, problem: .version(3))))
        let missing = try raw { $0.removeValue(forKey: "v") }
        XCTAssertEqual(ServerEvent.decode(name: "actionRejected", payload: [["action": "play", "snapshot": missing]]),
                       .failure(.snapshot(event: "actionRejected", requestId: nil, problem: .version(nil))))
        let boolean = try raw { $0["v"] = true }
        XCTAssertEqual(ServerEvent.decode(name: "stateSnapshot", payload: [["snapshot": boolean]]),
                       .failure(.snapshot(event: "stateSnapshot", requestId: nil, problem: .version(nil))))
        // a null snapshot (not_in_game) is no snapshot problem
        guard case .success = ServerEvent.decode(name: "stateSnapshot", payload: [["snapshot": NSNull(), "reason": "not_in_game"]]) else {
            return XCTFail("not_in_game must still decode")
        }
    }

    /// A rejoin into a table this build cannot show opens the game screen, where the table says so.
    func testUnreadableRejoinOpensTheGameScreen() throws {
        let h = ReplayHarness()
        h.appState.screen = .mainRoom
        h.handler.handle(event: "rejoinSuccess", payload: [["gameId": "g1", "snapshot": try raw { $0["v"] = 3 }]])
        XCTAssertEqual(h.appState.screen, .game)
        XCTAssertEqual(h.store.table.snapshotTrouble, .retrying(attempt: 1))
        // an undecodable stateSnapshot (already at the table) never navigates
        h.appState.screen = .mainRoom
        h.handler.handle(event: "stateSnapshot", payload: [["snapshot": try missingTrickHistory()]])
        XCTAssertEqual(h.appState.screen, .mainRoom)
    }

    func testUnknownStageIsASnapshotFailure() throws {
        let h = try seated()
        let r = h.store.apply(serverEvent: "stateSnapshot", payload: [["snapshot": try raw { $0["stage"] = "SOME_NEW_STAGE" }, "requestId": "q"]])
        XCTAssertEqual(r, .failure(.snapshot(event: "stateSnapshot", requestId: "q", problem: .unknownStage("SOME_NEW_STAGE"))))
        XCTAssertEqual(h.store.table.snapshotTrouble, .retrying(attempt: 1))
        // the reducer's own path (a snapshot handed to it directly) counts the same way
        var s = h.store.state
        let snap = try TableSnapshot.decode(try raw { $0["stage"] = "SOME_NEW_STAGE" })
        TableReducer.reduce(&s, .snapshot(snap, .requested("z"), hints: nil))
        XCTAssertEqual(s.table.snapshotTrouble, .retrying(attempt: 2))
    }

    // MARK: recovery

    func testAGoodSnapshotAfterABadOneRecoversNormally() throws {
        let h = try seated()
        badDelta(h)
        reply(h, try missingTrickHistory(), requestId: "gap-1")
        XCTAssertEqual(h.store.table.snapshotTrouble, .retrying(attempt: 1))
        h.clock.advance(SnapshotRetryPolicy.delay(attempt: 1))
        let retry = try XCTUnwrap(h.emitter.snapshotRequests.last)
        XCTAssertTrue(retry.hasPrefix("snap-"))
        let good = try raw { $0["seq"] = (($0["seq"] as? Int) ?? 0) + 1 }
        reply(h, good, requestId: retry)
        XCTAssertEqual(h.store.table.snapshotTrouble, .none)
        XCTAssertNil(h.store.state.sync.resyncId)
        XCTAssertEqual(h.store.state.sync.snapshotFailures, 0)
        XCTAssertEqual(h.store.state.sync.lastSeq, good["seq"] as? Int)
        XCTAssertEqual(h.store.myTurn, .choosing(.play), "the table plays on")
        // a later bad one starts the count again
        reply(h, try missingTrickHistory(), requestId: "later")
        XCTAssertEqual(h.store.table.snapshotTrouble, .retrying(attempt: 1))
    }

    func testAGoodSnapshotClearsTheUnreadableState() throws {
        let h = try seated()
        for i in 0...SnapshotRetryPolicy.maxRetries { reply(h, try missingTrickHistory(), requestId: "r\(i)") }
        XCTAssertEqual(h.store.table.snapshotTrouble, .unreadable)
        // e.g. the restore's rejoin after a reconnect to a fixed server
        h.handler.handle(event: "rejoinSuccess", payload: [["gameId": "g", "snapshot": try raw()]])
        XCTAssertEqual(h.store.table.snapshotTrouble, .none)
        XCTAssertEqual(h.store.myTurn, .choosing(.play))
    }

    /// not_in_game answering a retry: no snapshot is coming, so it stops saying "reloading".
    func testNotInGameAnsweringARetryEndsTheRetrying() throws {
        let h = try seated()
        reply(h, try missingTrickHistory(), requestId: "a")
        let retry = try XCTUnwrap(h.store.state.sync.resyncId)
        h.handler.handle(event: "stateSnapshot", payload: [["snapshot": NSNull(), "reason": "not_in_game", "requestId": retry]])
        XCTAssertEqual(h.store.table.snapshotTrouble, .none)
        XCTAssertNil(h.store.state.sync.resyncId)
        h.clock.advance(10)
        XCTAssertEqual(h.emitter.snapshotRequests, [], "the scheduled retry is dropped")
    }

    // MARK: deltas unchanged

    func testDeltaDecodeFailureStillResyncsAtOnceAndDebounces() throws {
        let h = try seated()
        let r = h.store.apply(serverEvent: "cardPlayed", payload: [["card": "not a card", "position": 2, "seq": h.store.state.sync.lastSeq! + 1]])
        guard case .failure(.decode(event: "cardPlayed", message: let message)) = r else { return XCTFail("\(r)") }
        XCTAssertTrue(message.hasPrefix("typeMismatch") && message.hasSuffix(" at card"), message)
        XCTAssertFalse(message.contains("not a card"), "never a payload value")
        XCTAssertEqual(h.emitter.snapshotRequests, ["gap-1"], "at once, no backoff")
        XCTAssertEqual(h.store.table.snapshotTrouble, .none)
        badDelta(h, seqAhead: 2)
        XCTAssertEqual(h.emitter.snapshotRequests, ["gap-1"], "one in flight")
        // a good reply resyncs as before
        reply(h, try raw(), requestId: "gap-1")
        XCTAssertNil(h.store.state.sync.resyncId)
        XCTAssertEqual(h.store.table.snapshotTrouble, .none)
    }

    /// An envelope field (not the snapshot) that fails is a delta-style failure: the resync's
    /// stateSnapshot can still bring the table.
    func testACarrierFieldOutsideTheSnapshotIsADeltaFailure() throws {
        let r = ServerEvent.decode(name: "rejoinSuccess", payload: [["gameId": 7, "snapshot": try raw()]])
        XCTAssertEqual(r, .failure(.decode(event: "rejoinSuccess", message: "typeMismatch String at gameId")))
    }

    // MARK: pieces

    func testDecodeTracePathsNameKeysAndIndicesOnly() throws {
        let bad = try raw { r in
            var seats = r["seats"] as! [[String: Any]]
            seats[1]["position"] = "two"
            r["seats"] = seats
        }
        let r = ServerEvent.decode(name: "stateSnapshot", payload: [["snapshot": bad]])
        XCTAssertEqual(r, .failure(.snapshot(event: "stateSnapshot", requestId: nil, problem: .undecodable("typeMismatch Int at snapshot.seats[1].position"))))
        XCTAssertFalse(SnapshotProblem.undecodable("x").summary.isEmpty)
        XCTAssertEqual(SnapshotProblem.version(3).summary, "snapshot v 3")
    }

    /// Both states draw in a phone-size window, differently (each written to the test's temp dir for a look).
    func testTheViewDrawsBothStates() throws {
        var drawn: [Data] = []
        for (name, trouble) in [("retrying", SnapshotTrouble.retrying(attempt: 1)), ("unreadable", .unreadable)] {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
            if let ws = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first { window.windowScene = ws }
            window.rootViewController = UIHostingController(rootView: UnreadableTableView(trouble: trouble, onLeave: {}))
            window.isHidden = false
            window.layoutIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let png = try XCTUnwrap(image.pngData(), name)
            drawn.append(png)
            let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("unreadable-\(name).png")
            try png.write(to: url)
            print("[UnreadableSnapshotTests] \(url.path)")
            window.isHidden = true
        }
        XCTAssertNotEqual(drawn[0], drawn[1])
    }

    func testAppStoreLinkIsTheWebGatesLink() {
        // client/src/boot/deviceGate.js APP_STORE_URL
        XCTAssertEqual(AppStoreLink.url.absoluteString, "https://apps.apple.com/app/id6759510890")
        XCTAssertTrue(UnreadableTableView.updateMessage.contains("Update BAB Online from the App Store"))
    }
}
