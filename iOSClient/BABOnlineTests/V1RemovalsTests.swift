import XCTest
@testable import BAB_Online

/// Executed contract/V1_REMOVALS.md entries: the app no longer listens for
/// events the server never sends (string literals on purpose: the generated
/// SocketEvents constants are gone with the schema entries).
final class V1RemovalsTests: XCTestCase {
    /// #3: lobbyJoined, roomFull and activeTournamentFound were never emitted
    /// (joining a lobby answers lobbyCreated; sign-in carries activeTournamentId).
    func testClientOnlyListenersAreGone() throws {
        XCTAssertFalse(GameSocketHandler.events.contains("roomFull"))
        guard case .failure(.unknownEvent("roomFull")) = ServerEvent.decode(name: "roomFull", payload: [[:]]) else {
            return XCTFail("roomFull still decodes")
        }
        let handlers = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("BABOnline/Networking/Handlers")
        for file in try FileManager.default.contentsOfDirectory(atPath: handlers.path) where file.hasSuffix(".swift") {
            let src = try String(contentsOf: handlers.appendingPathComponent(file), encoding: .utf8)
            for name in ["lobbyJoined", "roomFull", "activeTournamentFound"] {
                XCTAssertFalse(src.contains(name), "\(file) still names \(name)")
            }
        }
        // kept: the server hook that makes the app rejoin its game by itself
        XCTAssertEqual(SocketEvents.Server.activeGameFound, "activeGameFound")
    }

    /// #7: the server no longer sends playerAssigned; the seat comes from positionUpdate
    /// (my socket / username) and every seat gameStart's position.
    @MainActor
    func testPlayerAssignedIsGoneAndTheSeatStillComesFromTheDeal() throws {
        XCTAssertFalse(GameSocketHandler.events.contains("playerAssigned"))
        guard case .failure(.unknownEvent("playerAssigned")) = ServerEvent.decode(name: "playerAssigned", payload: [["playerId": "s", "position": 3]]) else {
            return XCTFail("playerAssigned still decodes")
        }
        var s = TableState()
        _ = TableReducer.reduce(&s, T.ev("gameStart", ["gameId": "g1", "position": 3, "hand": [], "currentHand": 1, "dealer": 1]))
        XCTAssertEqual(s.table.viewer.position, 3)
    }
}
