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
}
