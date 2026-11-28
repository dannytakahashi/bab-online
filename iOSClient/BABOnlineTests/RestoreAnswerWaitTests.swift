import XCTest
import SocketIO
@testable import BAB_Online

/// The session gate after a reconnect (owner 2026-11-27, the open Duo: "the start game spade
/// can be greyed out" after reconnecting, until the app was backgrounded and opened again).
/// `isSessionReady` opens only on the restore's answer; a restore lost on its way (the server
/// never saw it) left the connection up, the connection toast gone and New Game, Join and
/// Spectate off with nothing asking again. Now a restore unanswered after
/// `SocketService.restoreAnswerWait` on a socket still connected gets a new connection, whose
/// restore opens the gate; each rebuild in a row waits twice as long (a slow server is still
/// heard). A real SocketManager and the app's router against
/// FakeSocketIOServer, which drops the restores a test says to.
final class RestoreAnswerWaitTests: XCTestCase {
    private var service: SocketService { SocketService.shared }  // the app skips its socket under XCTest
    private var server: FakeSocketIOServer!
    private var auth: AuthState!
    private var router: SocketEventRouter!
    /// What the server does with each restoreSession in turn (then answers success): read on
    /// the server's thread, so behind a lock.
    private final class Script: @unchecked Sendable {
        enum Step { case drop, retryable }
        private let lock = NSLock()
        private var steps: [Step] = []
        func set(_ s: [Step]) { lock.lock(); steps = s; lock.unlock() }
        func next() -> Step? { lock.lock(); defer { lock.unlock() }; return steps.isEmpty ? nil : steps.removeFirst() }
    }
    private let script = Script()
    static let restored: [String: Any] = ["success": true, "username": "ivy", "blockedUsers": []]
    static let retryable: [String: Any] = ["success": false, "message": "Database error", "retryable": true]

    @MainActor
    override func setUpWithError() throws {
        server = FakeSocketIOServer()
        try server.start()
        auth = AuthState()
        auth.username = "ivy"
        auth.sessionToken = "fixture-restore"  // never saved: the restore only needs it set
        router = SocketEventRouter(socket: service, authState: auth, mainRoomState: MainRoomState(), lobbyState: LobbyState(),
                                   gameState: GameState(), appState: AppState(), tournamentState: TournamentState(),
                                   leaderboardState: LeaderboardState(), recordsState: RecordsState(), safetyState: SafetyState())
        service.authState = auth
        service.eventRouter = router
        SocketService.restoreAnswerWait = 1.5
        let script = self.script
        server.replies = { name, _ in
            switch name {
            case "restoreSession":
                switch script.next() {
                case .drop: return []
                case .retryable: return [("restoreSessionResponse", Self.retryable)]
                case nil: return [("restoreSessionResponse", Self.restored)]
                }
            case "joinMainRoom":
                return [("mainRoomJoined", ["messages": [], "lobbies": [], "onlineCount": 1, "onlineUsers": ["ivy"]])]
            default:
                return []
            }
        }
    }

    @MainActor
    override func tearDown() {
        service.disconnect()
        service.serverURLOverride = nil
        service.authState = nil
        service.eventRouter = nil
        service.serverError = nil
        service.isConnected = false
        service.isSessionReady = false
        auth.restoreRetrying = false
        SocketService.restoreAnswerWait = 5
        SocketService.restoreAnswerWaitCap = 30
        server.stop()
        server = nil
        super.tearDown()
    }

    private func wait(_ what: String, timeout: TimeInterval = 10, until done: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertTrue(done(), what)
    }

    private func spin(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private var restores: Int { server.events.filter { $0.name == "restoreSession" }.count }

    private func connect() {
        service.serverURLOverride = server.url
        service.connect()
    }

    /// The restore is lost: the gate stays closed (nothing goes out early) until the wait ends,
    /// then a new connection restores and the gate opens. Without the wait the gate stayed
    /// closed for good on a connected socket.
    func testALostRestoreGetsANewConnection() throws {
        script.set([.drop])
        connect()
        wait("connected, the restore sent") { self.service.isConnected && self.restores == 1 }
        let first = try XCTUnwrap(service.manager)
        let opened = service.connectionsOpened

        spin(SocketService.restoreAnswerWait - 0.5)
        XCTAssertTrue(service.isConnected, "the connection is up")
        XCTAssertFalse(service.isSessionReady, "no answer: the gate stays closed")
        XCTAssertFalse(service.canSendMainRoomActions, "New Game waits")
        XCTAssertTrue(service.manager === first, "not before the wait ends")

        wait("a new connection restores and opens the gate", timeout: 10) { self.service.isSessionReady }
        XCTAssertEqual(service.connectionsOpened, opened + 1, "exactly one new connection")
        XCTAssertFalse(service.manager === first, "the old connection is retired")
        XCTAssertEqual(first.status, .disconnected)
        XCTAssertEqual(restores, 2, "the new connection's restore")
        XCTAssertTrue(service.canSendMainRoomActions)
        XCTAssertEqual(server.handshakes, 2)
    }

    /// Answered in time: the wait ending later changes nothing (no second connection).
    func testAnAnsweredRestoreKeepsTheConnection() throws {
        connect()
        wait("restored") { self.service.isSessionReady }
        let manager = try XCTUnwrap(service.manager)
        let opened = service.connectionsOpened
        spin(SocketService.restoreAnswerWait + 0.5)
        XCTAssertTrue(service.manager === manager)
        XCTAssertEqual(service.connectionsOpened, opened)
        XCTAssertEqual(restores, 1)
        XCTAssertTrue(service.canSendMainRoomActions)
    }

    /// A failure is an answer: a retryable one is asked again on the same socket by the retry
    /// (AuthSocketHandler), never replaced by the wait.
    func testARetryableFailureIsAnAnswer() throws {
        script.set([.retryable])
        connect()
        wait("the failure answered") { self.auth.restoreRetrying }
        let manager = try XCTUnwrap(service.manager)
        let opened = service.connectionsOpened
        wait("the retry restores on the same socket", timeout: 10) { self.service.isSessionReady }
        spin(SocketService.restoreAnswerWait + 0.3)
        XCTAssertTrue(service.manager === manager, "the same connection throughout")
        XCTAssertEqual(service.connectionsOpened, opened)
    }

    /// A retry that is lost too is waited for like the first restore.
    func testALostRetryGetsANewConnection() throws {
        script.set([.retryable, .drop])  // the retry (RestoreRetry's first delay: 1 s) is lost
        connect()
        wait("the failure answered") { self.auth.restoreRetrying }
        let manager = try XCTUnwrap(service.manager)
        wait("rebuilt after the lost retry and restored", timeout: 12) { self.service.isSessionReady }
        XCTAssertFalse(service.manager === manager, "a new connection")
    }

    /// Signed out meanwhile (no saved session): the wait ending builds nothing.
    func testNoSessionNoRebuild() throws {
        script.set([.drop])
        connect()
        wait("the restore sent") { self.restores == 1 }
        let manager = try XCTUnwrap(service.manager)
        auth.sessionToken = ""
        spin(SocketService.restoreAnswerWait + 0.5)
        XCTAssertTrue(service.manager === manager)
        XCTAssertFalse(service.isSessionReady)
    }

    /// A server that answers, but later than the first wait (2.2 s against 1.5 s: a restore
    /// waiting on the database): the rebuilt connection is given twice as long and is heard.
    /// With a fixed wait every restore was cut off before its answer, a new connection every
    /// wait and the gate never open.
    func testASlowServerIsHeardOnTheNextRound() {
        server.replyDelays = ["restoreSessionResponse": 2.2]
        let opened = service.connectionsOpened
        connect()
        wait("connected, the restore sent") { self.service.isConnected && self.restores == 1 }
        spin(1.0)
        XCTAssertFalse(service.canSendMainRoomActions, "nothing before the answer")
        wait("the slow restore is answered on the rebuilt connection", timeout: 15) { self.service.isSessionReady }
        XCTAssertLessThanOrEqual(service.connectionsOpened - opened, 2, "one rebuild at most")
        XCTAssertTrue(service.canSendMainRoomActions)
        let settled = service.connectionsOpened
        spin(SocketService.restoreAnswerWait * 2 + 0.5)
        XCTAssertEqual(service.connectionsOpened, settled, "kept once answered")
    }

    /// Rebuilds in a row wait longer each time (1.5 s, then 3 s), and a session resets it: the
    /// next lost restore is waited for 1.5 s again.
    func testUnansweredRebuildsWaitLongerUntilASession() {
        script.set([.drop, .drop])
        connect()
        wait("the first restore sent") { self.restores == 1 }
        let opened = service.connectionsOpened
        XCTAssertEqual(service.currentRestoreAnswerWait, 1.5)
        wait("the first rebuild", timeout: 5) { self.service.connectionsOpened == opened + 1 }
        let firstRebuild = Date()
        XCTAssertEqual(service.currentRestoreAnswerWait, 3, "doubled")
        wait("the second rebuild", timeout: 8) { self.service.connectionsOpened == opened + 2 }
        XCTAssertGreaterThan(Date().timeIntervalSince(firstRebuild), 2.8, "the second wait is twice the first")
        XCTAssertEqual(service.currentRestoreAnswerWait, 6)
        wait("restored", timeout: 10) { self.service.isSessionReady }
        XCTAssertEqual(service.currentRestoreAnswerWait, 1.5, "a session resets it")

        script.set([.drop])
        let before = service.connectionsOpened
        service.forceReconnect()
        let rebuilt = Date()
        wait("the new connection's restore sent") { self.restores == 4 }
        wait("rebuilt after the first wait again", timeout: 5) { self.service.connectionsOpened == before + 2 }
        XCTAssertLessThan(Date().timeIntervalSince(rebuilt), 2.8, "the first wait, not the doubled one")
        wait("restored", timeout: 10) { self.service.isSessionReady }
    }

    /// The wait stops growing at `restoreAnswerWaitCap`.
    func testTheWaitIsCapped() {
        SocketService.restoreAnswerWaitCap = 2
        script.set([.drop, .drop])
        connect()
        wait("the first restore sent") { self.restores == 1 }
        let opened = service.connectionsOpened
        wait("the first rebuild", timeout: 5) { self.service.connectionsOpened == opened + 1 }
        XCTAssertEqual(service.currentRestoreAnswerWait, 2, "3 s capped at 2")
        wait("the second rebuild", timeout: 5) { self.service.connectionsOpened == opened + 2 }
        XCTAssertEqual(service.currentRestoreAnswerWait, 2)
        wait("restored", timeout: 10) { self.service.isSessionReady }
    }
}
