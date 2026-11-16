import XCTest
@testable import BAB_Online

/// The admin panel over a real socket: the app's SocketService, router and AdminState
/// against `FakeSocketIOServer`. adminRequest goes out only on a socket whose restore was
/// answered, adminResponse comes back by requestId, isAdmin on the restore shows the entry,
/// a forbidden answer closes the panel and clears the flag, the request limit's serverError
/// fails the request fast with no raw toast, and a lost connection fails what waits.
final class AdminSocketTests: XCTestCase {
    private var server: FakeSocketIOServer!
    private var service: SocketService { .shared }
    private var auth: AuthState!
    private var app: AppState!
    private var router: SocketEventRouter!
    private var admin: AdminState!

    @MainActor
    override func setUpWithError() throws {
        server = FakeSocketIOServer()
        try server.start()
        auth = AuthState()
        auth.username = "ivy"
        auth.sessionToken = "fixture-restore"  // never saved: the restore only needs it set
        app = AppState()
        admin = AdminState(api: AdminApi(timeout: 5, rateLimitGrace: 0.4))
        router = SocketEventRouter(socket: service, authState: auth, mainRoomState: MainRoomState(), lobbyState: LobbyState(),
                                   gameState: GameState(), appState: app, tournamentState: TournamentState(),
                                   leaderboardState: LeaderboardState(), recordsState: RecordsState(), safetyState: SafetyState(),
                                   adminApi: admin.api)
        service.authState = auth
        service.eventRouter = router
        service.serverError = nil
        admin.attach(socket: service, auth: auth)
    }

    @MainActor
    override func tearDown() {
        admin.close()
        service.disconnect()
        service.serverURLOverride = nil
        service.authState = nil
        service.eventRouter = nil
        service.claimAdminServerError = nil
        service.isConnected = false
        service.isSessionReady = false
        service.serverError = nil
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

    private func sent(_ name: String) -> [[String: Any]] {
        server.events.filter { $0.name == name }.map(\.payload)
    }

    /// Connects and restores as an admin; adminRequest is answered by `answer` (the
    /// requestId and action are echoed here, as the server does).
    private func connect(isAdmin: Bool = true, answer: @escaping ([String: Any]) -> [(String, [String: Any])]) {
        server.replies = { name, payload in
            switch name {
            case "restoreSession":
                var reply: [String: Any] = ["success": true, "username": "ivy"]
                if isAdmin { reply["isAdmin"] = true }
                return [("restoreSessionResponse", reply)]
            case "joinMainRoom": return [("mainRoomJoined", ["messages": [Any](), "lobbies": [Any](), "onlineCount": 1, "onlineUsers": ["ivy"]])]
            case "adminRequest":
                return answer(payload).map { event, body in
                    guard event == "adminResponse" else { return (event, body) }
                    var body = body
                    body["requestId"] = payload["requestId"]
                    body["action"] = payload["action"]
                    return (event, body)
                }
            default: return []
            }
        }
        service.serverURLOverride = server.url
        service.connect()
    }

    @MainActor
    func testRequestsWaitForTheSessionAndAreAnsweredByRequestId() {
        // before any connection: no flag, no panel; a request is refused at once, nothing sent
        admin.open()
        XCTAssertFalse(admin.isPresented)
        var early: AdminApi.Outcome?
        Task { early = await self.admin.api.request(.listAdmins) }
        wait("refused offline") { early != nil }
        if case .failure(let why) = early { XCTAssertEqual(why, .offline) } else { XCTFail("not sent while offline") }

        connect { _ in [("adminResponse", ["ok": true, "admins": [["username": "ivy", "adminSince": "2026-11-01T00:00:00.000Z"],
                                                                   ["username": "jon", "adminSince": NSNull()]]])] }
        wait("restored as an admin") { self.service.isSessionReady && self.auth.isAdmin }
        XCTAssertTrue(auth.isAdmin, "restoreSessionResponse isAdmin: true shows the Admin entry")
        XCTAssertEqual(sent("adminRequest").count, 0, "nothing went out before the session")

        admin.open()
        XCTAssertTrue(admin.isPresented)
        admin.tab = .admins
        Task { await self.admin.loadAdmins() }
        wait("the admins list") { self.admin.admins != nil }
        XCTAssertEqual(admin.admins?.map(\.username), ["ivy", "jon"])
        let request = sent("adminRequest").first
        XCTAssertEqual(request?["action"] as? String, "listAdmins")
        XCTAssertTrue((request?["requestId"] as? String ?? "").hasPrefix("adm-"))
        XCTAssertNotNil(request?["args"] as? [String: Any])
        XCTAssertEqual(admin.api.pendingCount, 0)
        XCTAssertNil(service.serverError)
    }

    @MainActor
    func testARestoreWithoutTheFlagShowsNoEntry() {
        auth.isAdmin = true  // left from an earlier session
        connect(isAdmin: false) { _ in [] }
        wait("restored") { self.service.isSessionReady }
        XCTAssertFalse(auth.isAdmin)
    }

    @MainActor
    func testForbiddenClosesThePanelAndClearsTheFlag() {
        connect { _ in [("adminResponse", ["ok": false, "error": "forbidden", "message": "Not available."])] }
        wait("restored as an admin") { self.service.isSessionReady && self.auth.isAdmin }
        admin.open()
        Task { await self.admin.tabOpened(.players) }
        wait("the panel closed") { !self.admin.isPresented }
        XCTAssertFalse(auth.isAdmin, "the entry is hidden")
        XCTAssertEqual(service.serverError?.message, "Admin access is not available on this connection.")
        XCTAssertNil(admin.roster)
    }

    @MainActor
    func testTheRequestLimitFailsFastWithNoRawToast() {
        connect { _ in [("serverError", ["code": "rateLimit", "handler": "adminRequest", "message": "Too many requests. Please slow down."])] }
        wait("restored as an admin") { self.service.isSessionReady && self.auth.isAdmin }
        admin.open()
        let started = Date()
        Task { await self.admin.loadPlayers() }
        wait("the rate limit is said", timeout: 4) { self.admin.status != nil }
        XCTAssertEqual(admin.status, .init(text: "Too many admin requests in a minute. Wait a moment and try again.", kind: .error))
        XCTAssertLessThan(Date().timeIntervalSince(started), 3, "after the grace, not the 5 s timeout")
        XCTAssertNil(service.serverError, "the panel says it: no raw toast")
        XCTAssertTrue(admin.isPresented)
        XCTAssertTrue(auth.isAdmin)
    }

    @MainActor
    func testAnotherHandlersErrorStillToasts() {
        connect { _ in [("serverError", ["code": "rejected", "handler": "joinLobby", "message": "Lobby is full"])] }
        wait("restored as an admin") { self.service.isSessionReady && self.auth.isAdmin }
        admin.open()
        Task { await self.admin.loadPlayers() }
        wait("the toast") { self.service.serverError != nil }
        XCTAssertEqual(service.serverError?.message, "Lobby is full")
    }

    @MainActor
    func testALostConnectionFailsWhatWaits() {
        connect { _ in [] }  // never answers
        wait("restored as an admin") { self.service.isSessionReady && self.auth.isAdmin }
        admin.open()
        Task { await self.admin.loadPlayers() }
        wait("the request is out") { self.sent("adminRequest").count == 1 }
        XCTAssertEqual(admin.api.pendingCount, 1)
        service.disconnect()
        wait("failed without waiting for the timeout", timeout: 3) { self.admin.status != nil }
        XCTAssertEqual(admin.status?.text, "No answer from the server. Check the connection and try again.")
        XCTAssertEqual(admin.api.pendingCount, 0)
        XCTAssertTrue(admin.isPresented, "the panel stays: the access is not known to be gone")
        XCTAssertTrue(auth.isAdmin)
    }
}
