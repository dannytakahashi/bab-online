import XCTest
@testable import BAB_Online

/// Done-when (a), reducer level: replaying each recorded viewer's events gives
/// the server's snapshot at every checkpoint and at the end of the game.
final class ReducerReplayTests: XCTestCase {
    func testEveryViewerMatchesEveryCheckpoint() throws {
        var compared = 0
        for game in try RecordedGame.all() {
            for viewer in game.viewers {
                let log = game.logs[viewer.label] ?? []
                var replay = ReducerReplay(viewer: viewer)
                var next = 0
                var lastSeq = 0
                var gameId: String?
                var failures = 0
                for check in game.checks(for: viewer.label) {
                    while next < check.afterIndex {
                        try replay.apply(log[next])
                        next += 1
                        if replay.state.table.gameId != gameId { gameId = replay.state.table.gameId; lastSeq = 0 }  // a tournament's next table
                        if let s = replay.state.sync.lastSeq {
                            XCTAssertGreaterThanOrEqual(s, lastSeq, "\(game.name)/\(viewer.label): seq went backwards")
                            lastSeq = s
                        }
                    }
                    let server = TableProjection(snapshot: try TableSnapshot.decode(check.snapshot, strict: true))
                    let diff = TableProjection(state: replay.state).diff(server)
                    if !diff.isEmpty && failures < 3 {
                        failures += 1
                        XCTFail("\(game.name)/\(viewer.label) after #\(check.afterIndex)\(check.isFinal ? " (final)" : ""): \(diff.joined(separator: "; "))")
                    }
                    compared += 1
                }
                while next < log.count { try replay.apply(log[next]); next += 1 }
                let bad = replay.effects.filter { if case .dropped = $0 { return true }; if case .gap = $0 { return true }; return false }
                XCTAssertEqual(bad, [], "\(game.name)/\(viewer.label): drops or gaps")
                if game.final[viewer.label] != nil {
                    guard case .ended(let end) = replay.state.table.phase else {
                        XCTFail("\(game.name)/\(viewer.label): not ended (\(replay.state.table.phase.kind))"); continue
                    }
                    let wire = try XCTUnwrap(GameEndData.from(game.final[viewer.label]!.gameEnd))
                    XCTAssertEqual(end, wire)
                }
            }
        }
        print("[replay] compared \(compared) checkpoints")
        XCTAssertGreaterThan(compared, 300)
    }

    /// The projection is not vacuous: a one-point score difference shows.
    func testProjectionDetectsADifference() throws {
        let game = try RecordedGame("events-bots-s12")
        let viewer = game.viewer("seat1-rejoin")
        let check = try XCTUnwrap(game.checks(for: viewer.label).first { !((($0.snapshot["hand"] as? [Any]) ?? []).isEmpty) })
        var replay = ReducerReplay(viewer: viewer)
        for e in game.logs[viewer.label]!.prefix(check.afterIndex) { try replay.apply(e) }
        let server = TableProjection(snapshot: try TableSnapshot.decode(check.snapshot, strict: true))
        XCTAssertEqual(TableProjection(state: replay.state).diff(server), [])
        replay.state.scores.score.team1 += 1
        XCTAssertEqual(TableProjection(state: replay.state).diff(server).count, 1)
        replay.state.table.hand.removeAll()
        XCTAssertEqual(TableProjection(state: replay.state).diff(server).count, 2)
    }
}
