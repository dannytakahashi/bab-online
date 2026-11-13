import XCTest
import SocketIO
@testable import BAB_Online

/// Buttons dead after a long background (owner, 2026-11-12): forceReconnect on the
/// foreground started a second handshake beside the one the library had already
/// started for the dead engine, and the socket's namespace connect was lost
/// (no `.connect`, no restore) until the server dropped the engine. Repro and
/// timings: the R-resume notes of the 2026-11-12 track.
final class ForegroundReconnectTests: XCTestCase {
    /// Records what forceReconnect asked of the library.
    final class FakeConnection: SocketService.ReconnectableConnection {
        var managerStatus: SocketIOStatus
        var socketStatus: SocketIOStatus
        var calls: [String] = []
        init(manager: SocketIOStatus, socket: SocketIOStatus) { managerStatus = manager; socketStatus = socket }
        func reconnectManager() { calls.append("reconnectManager") }
        func connectSocket() { calls.append("connectSocket") }
    }

    /// The foreground after a long background: the library found the dead engine first
    /// and is reconnecting (its own handshake in flight). Nothing more may start.
    func testLibraryAlreadyReconnectingStartsNothing() {
        for (manager, socket) in [(SocketIOStatus.connecting, SocketIOStatus.connecting),  // handshake in flight
                                  (.notConnected, .connecting),                            // between two attempts
                                  (.connecting, .disconnected),                            // a connect in flight
                                  (.connected, .connecting)] {                             // namespace connect in flight
            let c = FakeConnection(manager: manager, socket: socket)
            XCTAssertEqual(SocketService.forceReconnect(c), .none, "\(manager)/\(socket)")
            XCTAssertEqual(c.calls, [], "\(manager)/\(socket): a second handshake would race the library's")
        }
    }

    /// The socket still looks connected (the engine may be dead and not yet noticed):
    /// one library-owned cycle, never a namespace leave + join beside it.
    func testLookingConnectedIsOneManagerReconnect() {
        for manager in [SocketIOStatus.connected, .notConnected] {
            let c = FakeConnection(manager: manager, socket: .connected)
            XCTAssertEqual(SocketService.forceReconnect(c), .reconnectManager)
            XCTAssertEqual(c.calls, ["reconnectManager"])
        }
    }

    /// Nothing connecting and the socket not connected (the server dropped the namespace,
    /// or a manual disconnect): connect it, once.
    func testIdleDisconnectedSocketConnectsOnce() {
        for (manager, socket) in [(SocketIOStatus.connected, SocketIOStatus.disconnected),
                                  (.disconnected, .disconnected), (.notConnected, .notConnected)] {
            let c = FakeConnection(manager: manager, socket: socket)
            XCTAssertEqual(SocketService.forceReconnect(c), .connectSocket, "\(manager)/\(socket)")
            XCTAssertEqual(c.calls, ["connectSocket"])
        }
    }

    /// A socket the library is reconnecting (manager reconnect: no .disconnect event) cannot
    /// emit: isConnected goes false, so the toast says Reconnecting… until the next .connect
    /// instead of a stale "connected" while taps are dropped.
    func testReconnectingStatusIsNotConnected() {
        let service = SocketService.shared  // the app skips its socket under XCTest
        defer { service.isConnected = false }
        for s in [SocketIOStatus.connecting, .disconnected, .notConnected] {
            service.isConnected = true
            service.noteStatus(s)
            XCTAssertFalse(service.isConnected, "\(s)")
        }
        service.isConnected = true
        service.noteStatus(.connected)
        XCTAssertTrue(service.isConnected, "connected is left to .connect")
    }
}
