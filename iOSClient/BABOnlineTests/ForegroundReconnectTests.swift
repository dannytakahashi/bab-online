import XCTest
import SocketIO
@testable import BAB_Online

/// Buttons dead after a long background (owner, 2026-11-12). Socket.IO-Client-Swift 16.1.1,
/// once reconnecting, waits for a backoff tick it cannot be asked to fire early (up to
/// reconnectWaitMax, 5 s), and each tick starts a handshake beside one still in flight; so
/// forceReconnect replaces the manager and socket instead of reconnecting them (SocketService).
/// And a tap between `.connect` and the restore's answer was undone by the restore's
/// joinMainRoom, so main-room actions wait for `isSessionReady`.
final class ForegroundReconnectTests: XCTestCase {
    /// A local port nothing listens on: every handshake is refused at once, so the library
    /// goes into its reconnect backoff without a server.
    static let refusedURL = "http://127.0.0.1:9"

    private var service: SocketService { SocketService.shared }  // the app skips its socket under XCTest

    override func tearDown() {
        service.disconnect()
        service.serverURLOverride = nil
        service.isConnected = false
        service.isSessionReady = false
        super.tearDown()
    }

    private func wait(_ what: String, timeout: TimeInterval = 10, until done: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertTrue(done(), what)
    }

    /// R1: the foreground lands between two of the library's attempts (a deploy or a network
    /// drop during the keep-alive): the manager is `.notConnected`, the socket `.connecting`,
    /// nothing is in flight and the next tick is 1.5 s to 5 s away. A handshake must start NOW,
    /// on a new manager, and the old one must never act again.
    func testForegroundMidBackoffStartsAHandshakeAtOnce() throws {
        service.serverURLOverride = Self.refusedURL
        service.connect()
        let old = try XCTUnwrap(service.manager)
        let oldSocket = try XCTUnwrap(service.socket)
        var attempts = 0
        oldSocket.on(clientEvent: .reconnectAttempt) { _, _ in attempts += 1 }
        // the first attempt is refused at once; its successor is a tick away (>= 1.5 s)
        wait("the library is between two reconnect attempts") {
            attempts >= 1 && old.status == .notConnected && oldSocket.status == .connecting
        }

        service.forceReconnect()

        let fresh = try XCTUnwrap(service.manager)
        XCTAssertFalse(fresh === old, "a new manager, not the old one's next tick")
        XCTAssertEqual(fresh.status, .connecting, "its handshake started at once")
        XCTAssertEqual(service.socket?.status, .connecting)
        XCTAssertEqual(old.status, .disconnected, "the old manager's tick returns at once")
        XCTAssertFalse(old.reconnects)
        XCTAssertTrue(oldSocket.handlers.isEmpty, "none of our handlers runs on the old socket")
        XCTAssertNil(old.nsps["/"])

        // past the old manager's pending tick (1.5 s to 2.25 s after attempt 1): it started
        // nothing (a connect would have set it .connecting)
        RunLoop.main.run(until: Date().addingTimeInterval(2.5))
        XCTAssertEqual(old.status, .disconnected)
    }

    /// R2: a late answer to the retired manager's handshake (a slow link) joins no namespace and
    /// starts no reconnect cycle: it cannot be taken for the new connection's.
    func testRetiredManagerIgnoresALateHandshake() {
        let (manager, socket) = SocketService.makeConnection(url: URL(string: Self.refusedURL)!)
        var events: [String] = []
        socket.on(clientEvent: .connect) { _, _ in events.append("connect") }
        socket.on(clientEvent: .reconnectAttempt) { _, _ in events.append("reconnectAttempt") }

        SocketService.retire(manager: manager, socket: socket)
        XCTAssertTrue(socket.handlers.isEmpty)
        XCTAssertFalse(manager.reconnects)
        XCTAssertEqual(manager.status, .disconnected)

        manager.engineDidOpen(reason: "late handshake answer")
        manager.engineDidClose(reason: "the server drops the namespace-less engine")
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(socket.status, .notConnected, "no namespace connect on the retired socket")
        XCTAssertNil(manager.nsps["/"])
        XCTAssertEqual(events, [])
    }

    /// Every forceReconnect is one new connection, whatever the old one was doing: the old
    /// one is retired before the new one exists, so only the new one can connect a namespace.
    func testEveryForceReconnectIsANewConnection() throws {
        service.serverURLOverride = Self.refusedURL
        service.connect()
        var seen: [SocketManager] = []  // held, so no address is reused
        for _ in 0..<3 {
            let old = try XCTUnwrap(service.manager)
            seen.append(old)
            service.forceReconnect()
            XCTAssertEqual(old.status, .disconnected)
            XCTAssertFalse(old.reconnects)
        }
        let last = try XCTUnwrap(service.manager)
        XCTAssertFalse(seen.contains { $0 === last })
        XCTAssertEqual(Set(seen.map(ObjectIdentifier.init)).count, 3)
    }

    /// A socket the library is reconnecting (no .disconnect event) cannot emit: isConnected
    /// and isSessionReady go false, so the toast says Reconnecting… until the next .connect
    /// instead of a stale "connected" while taps are dropped.
    func testReconnectingStatusIsNotConnected() {
        for s in [SocketIOStatus.connecting, .disconnected, .notConnected] {
            service.isConnected = true
            service.isSessionReady = true
            service.noteStatus(s)
            XCTAssertFalse(service.isConnected, "\(s)")
            XCTAssertFalse(service.isSessionReady, "\(s)")
        }
        service.isConnected = true
        service.isSessionReady = true
        service.noteStatus(.connected)
        XCTAssertTrue(service.isConnected, "connected is left to .connect")
        XCTAssertTrue(service.isSessionReady)
    }

    /// R3: the session is ready only once the restore has answered and its joinMainRoom (or
    /// rejoin) has gone out; a tap sent after that reaches the server behind it.
    @MainActor
    func testRestoreAnswerMakesTheSessionReady() {
        let auth = AuthState(), app = AppState(), game = GameState(), safety = SafetyState()
        let handler = AuthSocketHandler(socket: service, authState: auth, appState: app, gameState: game, safetyState: safety)
        service.isSessionReady = false

        handler.handleRestoreSessionResponse(["success": false, "message": "Session expired"])
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertFalse(service.isSessionReady, "a failed restore signs nobody in")

        handler.handleRestoreSessionResponse(["success": true, "username": "ivy"])
        XCTAssertFalse(service.isSessionReady, "not before the answer is handled")
        wait("the restore's answer handled") { service.isSessionReady }
        XCTAssertEqual(app.screen, .mainRoom)
        auth.clearCredentials()
    }
}
