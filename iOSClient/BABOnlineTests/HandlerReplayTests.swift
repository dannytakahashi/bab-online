import XCTest
@testable import BAB_Online

/// Done-when (a) through the app's own path: every recorded event goes through
/// GameSocketHandler.handle (and the chat / voice / error routes) into the store.
@MainActor
final class HandlerReplayTests: XCTestCase {
    func testEveryViewerMatchesEveryCheckpointThroughTheHandlers() throws {
        var compared = 0
        var coordinated = 0
        for game in try RecordedGame.all() {
            for viewer in game.viewers {
                let log = game.logs[viewer.label] ?? []
                let h = ReplayHarness(viewer: viewer)
                var next = 0
                var failures = 0
                for check in game.checks(for: viewer.label) {
                    while next < check.afterIndex { try h.apply(log[next]); next += 1 }
                    let server = TableProjection(snapshot: try TableSnapshot.decode(check.snapshot, strict: true))
                    let diff = TableProjection(state: h.store.state).diff(server)
                    if !diff.isEmpty && failures < 3 {
                        failures += 1
                        XCTFail("\(game.name)/\(viewer.label) after #\(check.afterIndex): \(diff.joined(separator: "; "))")
                    }
                    // the published slices always mirror the state
                    XCTAssertEqual(h.store.table, h.store.state.table)
                    compared += 1
                }
                while next < log.count { try h.apply(log[next]); next += 1 }
                XCTAssertEqual(h.badEffects, [], "\(game.name)/\(viewer.label)")
                XCTAssertEqual(h.emitter.snapshotRequests, [], "\(game.name)/\(viewer.label): no resync (and no ack timeout) was needed")
                coordinated += h.coordinated
                if game.final[viewer.label] != nil {
                    XCTAssertEqual(h.store.phase, .ended, "\(game.name)/\(viewer.label)")
                    XCTAssertNotNil(h.store.gameEndData)
                    XCTAssertEqual(h.appState.screen, .game)
                }
                XCTAssertFalse(h.renderer.calls.isEmpty)
            }
        }
        XCTAssertGreaterThan(compared, 300)
        XCTAssertGreaterThan(coordinated, 300, "the recorded plays and bids went through ActionCoordinator")
    }
}

/// Every sequenced event reaches the store's seq gate.
@MainActor
final class SeqCoverageTests: XCTestCase {
    static let otherRoutes: Set<String> = ["chatMessage", "voicePeerLeft"]

    func testEverySequencedEventIsRouted() {
        let routed = Set(GameSocketHandler.events).union(Self.otherRoutes)
        XCTAssertEqual(ContractSeq.events.subtracting(routed), [])
    }

    func testRecordedSequencedEventsAdvanceSeq() throws {
        var seen: Set<String> = []
        for game in try RecordedGame.all() {
            for (_, log) in game.logs {
                for e in log where e.dir == "s2c" && !seen.contains(e.event) {
                    guard let seq = (e.data as? [String: Any])?["seq"] as? Int, ContractSeq.events.contains(e.event) else { continue }
                    let h = ReplayHarness()
                    try h.apply(e)
                    XCTAssertEqual(h.store.state.sync.lastSeq, seq, e.event)
                    seen.insert(e.event)
                }
            }
        }
        XCTAssertGreaterThan(seen.count, 20, "\(ContractSeq.events.subtracting(seen))")
    }
}
