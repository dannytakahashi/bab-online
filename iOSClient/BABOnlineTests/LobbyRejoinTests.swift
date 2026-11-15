import XCTest
import SocketIO
import Combine
@testable import BAB_Online

/// An iOS player waiting in a lobby got a new socket (a deploy, a network change, a slow
/// wake-up): the restore found no game, the app went to the main room, and the seat the
/// server held for 30 s for a joinLobby only the web re-sent expired (a host-only lobby was
/// deleted). Now the restore re-enters the lobby on screen (`RestoreRoute.lobby`), once per
/// socket, with no joinMainRoom (which would run the Leave flow server-side); a refusal goes
/// to the main room with one short message. A real SocketManager and the app's router
/// against FakeSocketIOServer, which answers restoreSession and joinLobby as the server does.
final class LobbyRejoinTests: XCTestCase {
    private var service: SocketService { SocketService.shared }  // the app skips its socket under XCTest
    private var server: FakeSocketIOServer!
    private var auth: AuthState!
    private var app: AppState!
    private var lobby: LobbyState!
    private var mainRoom: MainRoomState!
    private var router: SocketEventRouter!

    static let restored: [String: Any] = ["success": true, "username": "ivy", "blockedUsers": []]
    static func lobbyCreated(_ id: String) -> [String: Any] {
        ["lobbyId": id, "name": "Friday night", "messages": [],
         "players": [["username": "ivy", "isReady": false, "socketId": "n2"],
                     ["username": "kim", "isReady": true, "socketId": "s-kim"]]]
    }
    static func refused(_ message: String) -> [String: Any] {
        ["code": "rejected", "message": message, "handler": "joinLobby"]
    }
    static let mainRoomJoined: [String: Any] = ["messages": [], "lobbies": [], "onlineCount": 3, "onlineUsers": ["ivy", "kim", "lee"]]

    @MainActor
    override func setUpWithError() throws {
        server = FakeSocketIOServer()
        try server.start()
        RestartNotices.shared.survived()
        RestartNotices.shared.message = nil
        auth = AuthState()
        auth.username = "ivy"
        auth.sessionToken = "fixture-restore"  // never saved: the restore only needs it set
        app = AppState()
        lobby = LobbyState()
        mainRoom = MainRoomState()
        router = SocketEventRouter(socket: service, authState: auth, mainRoomState: mainRoom, lobbyState: lobby,
                                   gameState: GameState(), appState: app, tournamentState: TournamentState(),
                                   leaderboardState: LeaderboardState(), recordsState: RecordsState(), safetyState: SafetyState())
        service.authState = auth
        service.eventRouter = router
        service.serverError = nil
    }

    @MainActor
    override func tearDown() {
        service.disconnect()
        service.serverURLOverride = nil
        service.authState = nil
        service.eventRouter = nil
        service.claimServerError = nil
        service.serverError = nil
        service.isConnected = false
        service.isSessionReady = false
        RestartNotices.shared.survived()
        RestartNotices.shared.message = nil
        LobbyRejoin.answerWait = 15
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

    private func sent(_ name: String) -> [[String: Any]] {
        server.events.filter { $0.name == name }.map(\.payload)
    }

    private var names: [String] { server.events.map(\.name) }

    /// In the lobby with a seat (as lobbyCreated left it), then a new connection.
    private func seatInLobby(_ id: String = "L1") {
        lobby.lobbyId = id
        lobby.lobbyName = "Friday night"
        lobby.players = [LobbyPlayer(id: "n1", username: "ivy", pic: nil, isReady: true, isBot: false)]
        app.screen = .gameLobby
    }

    /// The server's answers: the restore (optionally with pointers), the lobby's reply, and
    /// what follows a joinMainRoom (by default the main room).
    private func script(restore: [String: Any] = restored, joinLobby: [(String, [String: Any])],
                        joinMainRoom: [(String, [String: Any])] = [("mainRoomJoined", mainRoomJoined)]) {
        server.replies = { name, _ in
            switch name {
            case "restoreSession": return [("restoreSessionResponse", restore)]
            case "joinLobby": return joinLobby
            case "joinMainRoom": return joinMainRoom
            default: return []
            }
        }
    }

    private func connect() {
        service.serverURLOverride = server.url
        service.connect()
    }

    // MARK: - Back into the lobby

    /// No game to go back to and a lobby on screen: one joinLobby for it after the restore,
    /// the lobby stays (no joinMainRoom), and the server's list replaces the old one (my
    /// ready flag reset, as the server does on a takeover).
    @MainActor
    func testRestoreInALobbyRejoinsItOnce() {
        seatInLobby()
        script(joinLobby: [("lobbyCreated", Self.lobbyCreated("L1"))])
        connect()
        wait("back in the lobby") { self.lobby.players.count == 2 && self.lobby.rejoiningLobbyId == nil && service.isSessionReady }
        spin(0.5)

        XCTAssertEqual(sent("joinLobby").count, 1)
        XCTAssertEqual(sent("joinLobby").first?["lobbyId"] as? String, "L1")
        XCTAssertEqual(names.filter { $0 == "restoreSession" || $0 == "joinLobby" }, ["restoreSession", "joinLobby"],
                       "after the restore")
        XCTAssertFalse(names.contains("joinMainRoom"), "a joinMainRoom would leave the seat")
        XCTAssertEqual(app.screen, .gameLobby)
        XCTAssertEqual(lobby.lobbyId, "L1")
        XCTAssertEqual(lobby.players.first { $0.username == "ivy" }?.isReady, false)
        XCTAssertNil(service.serverError)
    }

    /// The restore's joinLobby is held until answered: the lobby's actions wait for it
    /// (`rejoiningLobbyId`), and a second restore answer on the same socket sends no second
    /// joinLobby.
    @MainActor
    func testUnansweredRejoinIsSentOncePerSocket() throws {
        seatInLobby()
        script(joinLobby: [])  // no reply yet
        connect()
        wait("the rejoin went out") { self.sent("joinLobby").count == 1 && service.isSessionReady }
        XCTAssertEqual(lobby.rejoiningLobbyId, "L1", "the lobby's actions wait")
        XCTAssertEqual(lobby.rejoinSocketId, service.socketId)
        XCTAssertEqual(app.screen, .gameLobby)

        let again = AuthSocketHandler(socket: service, authState: auth, appState: app, gameState: GameState(),
                                      safetyState: SafetyState(), lobbyState: lobby)
        again.handleRestoreSessionResponse(Self.restored)
        spin(0.5)
        XCTAssertEqual(sent("joinLobby").count, 1, "one joinLobby per socket")
        XCTAssertFalse(names.contains("joinMainRoom"))
    }

    /// The server restarts (or the link drops) while the app is in front: the library
    /// reconnects on a new socket, and that socket re-enters the lobby too (one joinLobby on
    /// each engine).
    @MainActor
    func testEveryNewSocketRejoins() {
        seatInLobby()
        script(joinLobby: [("lobbyCreated", Self.lobbyCreated("L1"))])
        connect()
        wait("first rejoin answered") { self.sent("joinLobby").count == 1 && self.lobby.rejoiningLobbyId == nil }

        server.restart()
        wait("reconnected and rejoined", timeout: 15) { self.sent("joinLobby").count == 2 && self.lobby.rejoiningLobbyId == nil }
        spin(0.5)

        let engines = zip(server.events, server.eventEngines).filter { $0.0.name == "joinLobby" }.map(\.1)
        XCTAssertEqual(engines.count, 2)
        XCTAssertEqual(Set(engines).count, 2, "one per socket")
        XCTAssertFalse(names.contains("joinMainRoom"))
        XCTAssertEqual(app.screen, .gameLobby)
        XCTAssertEqual(lobby.lobbyId, "L1")
    }

    // MARK: - Refused

    /// The lobby closed meanwhile: the main room, the lobby forgotten, one message in the
    /// app's words (not the server's), and the main room joined after the refusal.
    @MainActor
    func testLobbyGoneFallsBackToTheMainRoom() {
        seatInLobby()
        script(joinLobby: [("serverError", Self.refused("Lobby not found"))])
        connect()
        wait("in the main room") { self.app.screen == .mainRoom && self.sent("joinMainRoom").count == 1 }
        spin(0.3)

        XCTAssertEqual(lobby.lobbyId, "")
        XCTAssertNil(lobby.rejoiningLobbyId)
        XCTAssertEqual(service.serverError?.message, "The lobby closed while you were offline")
        XCTAssertEqual(names.filter { ["restoreSession", "joinLobby", "joinMainRoom"].contains($0) },
                       ["restoreSession", "joinLobby", "joinMainRoom"])
        XCTAssertTrue(service.isSessionReady)
    }

    /// Full (the seat may still be the previous socket's) or any other refusal: the same
    /// fallback, the general message.
    @MainActor
    func testLobbyFullFallsBackToTheMainRoom() {
        seatInLobby()
        script(joinLobby: [("serverError", Self.refused("Lobby is full"))])
        connect()
        wait("in the main room") { self.app.screen == .mainRoom && self.sent("joinMainRoom").count == 1 }
        XCTAssertEqual(service.serverError?.message, "Couldn't get back into the lobby")
        XCTAssertEqual(lobby.lobbyId, "")
    }

    /// After a serverShutdown the restart alert says why; no toast beside it.
    @MainActor
    func testRefusalAfterARestartShowsTheRestartMessage() {
        let handler = LobbySocketHandler(socket: service, mainRoomState: MainRoomState(), lobbyState: lobby,
                                         appState: app, gameState: GameState(), safetyState: SafetyState())
        seatInLobby()
        lobby.rejoiningLobbyId = "L1"
        RestartNotices.shared.serverShutdown(place: .lobby)
        XCTAssertTrue(handler.handleRejoinRefused(Self.refused("Lobby not found")))
        XCTAssertEqual(RestartNotices.shared.message, RestartNotice.message(.lobby))
        XCTAssertNil(service.serverError)
        XCTAssertEqual(app.screen, .mainRoom)
    }

    /// A joinLobby refusal with no re-entry waiting (a Join tapped in the main room), or
    /// another handler's failure while one waits, is not the re-entry's: the usual toast.
    @MainActor
    func testOtherFailuresAreNotClaimed() {
        let handler = LobbySocketHandler(socket: service, mainRoomState: MainRoomState(), lobbyState: lobby,
                                         appState: app, gameState: GameState(), safetyState: SafetyState())
        handler.register()  // sets the claim (no socket: no handlers)
        app.screen = .mainRoom
        XCTAssertFalse(handler.handleRejoinRefused(Self.refused("Lobby is full")))
        service.handleServerError(Self.refused("Lobby is full"), channel: .serverError)
        XCTAssertEqual(service.serverError?.message, "Lobby is full")

        seatInLobby()
        lobby.rejoiningLobbyId = "L1"
        XCTAssertFalse(handler.handleRejoinRefused(["code": "rejected", "message": "Not in a lobby", "handler": "playerReady"]))
        XCTAssertEqual(lobby.rejoiningLobbyId, "L1")
        XCTAssertEqual(app.screen, .gameLobby)
    }

    // MARK: - Unchanged

    /// The server's game pointer wins: the rejoin, as before, and no joinLobby.
    @MainActor
    func testRestoreWithAnActiveGameRejoinsTheGame() {
        seatInLobby()
        var restore = Self.restored
        restore["activeGameId"] = "G1"
        script(restore: restore, joinLobby: [])
        connect()
        wait("the game rejoin went out") { self.sent("rejoinGame").count == 1 && service.isSessionReady }
        spin(0.3)
        XCTAssertEqual(sent("rejoinGame").first?["gameId"] as? String, "G1")
        XCTAssertEqual(sent("joinLobby").count, 0)
        XCTAssertNil(lobby.rejoiningLobbyId)
    }

    /// No lobby to go back to (left, or another screen with an old id): the main room, as before.
    @MainActor
    func testNoRememberedLobbyGoesToTheMainRoom() {
        app.screen = .gameLobby  // lobbyId "" (Leave reset it)
        script(joinLobby: [])
        connect()
        wait("main room joined") { self.sent("joinMainRoom").count == 1 && service.isSessionReady }
        XCTAssertEqual(app.screen, .mainRoom)
        XCTAssertEqual(sent("joinLobby").count, 0)
    }

    @MainActor
    func testStaleLobbyIdOffTheLobbyScreenGoesToTheMainRoom() {
        lobby.lobbyId = "L1"  // allPlayersReady keeps it; the game ended meanwhile
        app.screen = .game
        script(joinLobby: [])
        connect()
        wait("main room joined") { self.sent("joinMainRoom").count == 1 && service.isSessionReady }
        XCTAssertEqual(app.screen, .mainRoom)
        XCTAssertEqual(sent("joinLobby").count, 0)
    }

    /// A foreground probe that keeps the connection: no restore, so no rejoin (the socket
    /// never left the lobby).
    @MainActor
    func testKeptForegroundSendsNoRejoin() {
        seatInLobby()
        script(joinLobby: [("lobbyCreated", Self.lobbyCreated("L1"))])
        connect()
        wait("back in the lobby") { self.sent("joinLobby").count == 1 && self.lobby.rejoiningLobbyId == nil && service.isSessionReady }

        service.resumeAfterKeepAlive()
        wait("the probe answered") { service.lastForegroundOutcome == .kept }
        spin(0.5)
        XCTAssertEqual(sent("restoreSession").count, 1)
        XCTAssertEqual(sent("joinLobby").count, 1)
        XCTAssertFalse(names.contains("joinMainRoom"))
        XCTAssertEqual(app.screen, .gameLobby)
        XCTAssertEqual(server.handshakes, 1)
    }

    // MARK: - Leaving before the answer (review 2026-11-15)

    /// Leave while the re-entry waits, and the lobby is gone: the socket was never back in it,
    /// so a leaveLobby would be refused ("Not in a lobby") with no leftLobby and the screen
    /// stranded. Leave goes out as joinMainRoom (the server answers the joinLobby first: here
    /// the refusal, dropped without a toast) and the main room is up at once.
    @MainActor
    func testLeaveDuringTheRejoinWhenTheLobbyIsGone() {
        seatInLobby()
        script(joinLobby: [],  // answered behind the Leave, in the server's order
               joinMainRoom: [("serverError", Self.refused("Lobby not found")), ("mainRoomJoined", Self.mainRoomJoined)])
        connect()
        wait("the rejoin went out") { self.sent("joinLobby").count == 1 && service.isSessionReady }

        LobbyRejoin.abandon(lobbyState: lobby, appState: app)  // GameLobbyView.leaveLobby during the re-entry
        XCTAssertEqual(app.screen, .mainRoom, "at once")
        XCTAssertEqual(lobby.lobbyId, "")
        wait("main room joined") { self.mainRoom.onlineCount == 3 && self.lobby.abandonedRejoinLobbyId == nil }
        spin(0.3)

        XCTAssertEqual(sent("leaveLobby").count, 0)
        XCTAssertEqual(sent("joinMainRoom").count, 1)
        XCTAssertNil(service.serverError, "the refusal of a re-entry left already says nothing")
        XCTAssertEqual(app.screen, .mainRoom)
    }

    /// Leave while the re-entry waits, and the seat came back: the late lobbyCreated is
    /// dropped (the lobby never flashes up), and the joinMainRoom behind it leaves the lobby
    /// server-side (leftLobby + mainRoomJoined).
    @MainActor
    func testLeaveDuringTheRejoinWhenTheSeatCameBack() {
        seatInLobby()
        script(joinLobby: [],
               joinMainRoom: [("lobbyCreated", Self.lobbyCreated("L1")), ("leftLobby", [:]), ("mainRoomJoined", Self.mainRoomJoined)])
        connect()
        wait("the rejoin went out") { self.sent("joinLobby").count == 1 && service.isSessionReady }

        var screens: [AppState.Screen] = []
        let watch = app.$screen.sink { screens.append($0) }
        LobbyRejoin.abandon(lobbyState: lobby, appState: app)
        wait("main room joined") { self.mainRoom.onlineCount == 3 }
        spin(0.3)
        watch.cancel()

        XCTAssertFalse(screens.dropFirst().contains(.gameLobby), "the lobby never came back up: \(screens)")
        XCTAssertEqual(app.screen, .mainRoom)
        XCTAssertEqual(lobby.lobbyId, "")
        XCTAssertTrue(lobby.players.isEmpty)
        XCTAssertNil(lobby.abandonedRejoinLobbyId)
        XCTAssertEqual(sent("leaveLobby").count, 0)
        XCTAssertNil(service.serverError)
    }

    /// No answer at all on a socket that stays connected (the server drops a parked socket's
    /// events while a sign-in is re-checked): after `answerWait` the main room, as a refusal.
    @MainActor
    func testUnansweredRejoinGivesUpAfterTheWait() {
        LobbyRejoin.answerWait = 0.5
        seatInLobby()
        script(joinLobby: [])
        connect()
        wait("the rejoin went out") { self.sent("joinLobby").count == 1 && service.isSessionReady }
        XCTAssertEqual(app.screen, .gameLobby)
        wait("gave up") { self.app.screen == .mainRoom && self.mainRoom.onlineCount == 3 }
        XCTAssertEqual(sent("joinMainRoom").count, 1)
        XCTAssertEqual(service.serverError?.message, "Couldn't get back into the lobby")
        XCTAssertNil(lobby.rejoiningLobbyId)
    }

    /// An answered re-entry's wait does nothing.
    @MainActor
    func testAnsweredRejoinIsNotGivenUp() {
        LobbyRejoin.answerWait = 0.3
        seatInLobby()
        script(joinLobby: [("lobbyCreated", Self.lobbyCreated("L1"))])
        connect()
        wait("back in the lobby") { self.lobby.players.count == 2 && self.lobby.rejoiningLobbyId == nil }
        spin(0.8)
        XCTAssertEqual(app.screen, .gameLobby)
        XCTAssertEqual(sent("joinMainRoom").count, 0)
        XCTAssertNil(service.serverError)
    }

    /// A restart notice older than its window shows no alert, so the refusal toasts.
    @MainActor
    func testRefusalAfterAnOldRestartNoticeToasts() {
        let handler = LobbySocketHandler(socket: service, mainRoomState: MainRoomState(), lobbyState: lobby,
                                         appState: app, gameState: GameState(), safetyState: SafetyState())
        seatInLobby()
        lobby.rejoiningLobbyId = "L1"
        RestartNotices.shared.serverShutdown(place: .lobby, now: Date().addingTimeInterval(-(RestartNotice.window + 60)))
        XCTAssertTrue(handler.handleRejoinRefused(Self.refused("Lobby not found")))
        XCTAssertNil(RestartNotices.shared.message)
        XCTAssertEqual(service.serverError?.message, "The lobby closed while you were offline")
        XCTAssertEqual(app.screen, .mainRoom)
    }

    // MARK: - The route (pure)

    func testRouteOrder() {
        typealias R = RestoreRoute
        let both: [String: Any] = ["activeGameId": "G1", "activeTournamentId": "T1"]
        XCTAssertEqual(R.of(both, screen: .gameLobby, lobbyId: "L1"), .rejoinGame(gameId: "G1"))
        XCTAssertEqual(R.of(["activeTournamentId": "T1"], screen: .gameLobby, lobbyId: "L1"), .tournament(tournamentId: "T1"))
        XCTAssertEqual(R.of(["activeGameId": ""], screen: .gameLobby, lobbyId: "L1"), .lobby(lobbyId: "L1"))
        XCTAssertEqual(R.of([:], screen: .gameLobby, lobbyId: ""), .mainRoom)
        for screen in [AppState.Screen.signIn, .register, .mainRoom, .tournamentLobby, .game] {
            XCTAssertEqual(R.of([:], screen: screen, lobbyId: "L1"), .mainRoom, "\(screen)")
        }
        XCTAssertEqual(R.lobbyRefusedMessage("Lobby not found"), "The lobby closed while you were offline")
        for m in ["Lobby is full", "Already in game", nil] {
            XCTAssertEqual(R.lobbyRefusedMessage(m), "Couldn't get back into the lobby")
        }
    }
}
