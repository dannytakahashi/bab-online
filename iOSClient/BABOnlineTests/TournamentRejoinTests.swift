import XCTest
import SocketIO
import Combine
@testable import BAB_Online

/// An iOS player waiting in a tournament's lobby phase got a new socket: the server had
/// removed the member at the disconnect (no grace in the lobby phase) and records
/// activeTournamentId only at beginTournament, so the restore found nothing and the app went
/// to the main room. Now the restore joins the tournament on screen again
/// (`RestoreRoute.tournamentLobby`, as the web does from sessionStorage), once per socket and
/// with no joinMainRoom; a refusal goes to the main room with one short message. The
/// LobbyRejoinTests setup: a real SocketManager and the app's router against FakeSocketIOServer.
final class TournamentRejoinTests: XCTestCase {
    private var service: SocketService { SocketService.shared }  // the app skips its socket under XCTest
    private var server: FakeSocketIOServer!
    private var auth: AuthState!
    private var app: AppState!
    private var tournament: TournamentState!
    private var mainRoom: MainRoomState!
    private var router: SocketEventRouter!

    static let restored: [String: Any] = ["success": true, "username": "ivy", "blockedUsers": []]
    static func joined(_ id: String = "T1") -> [String: Any] {
        ["tournamentId": id, "name": "Sunday Cup", "phase": "lobby", "currentRound": 0, "totalRounds": 4,
         "creatorUsername": "kim", "isSpectator": false, "messages": [], "scoreboard": [], "winners": [], "activeGames": [],
         "players": [["username": "kim", "ready": true, "isCreator": true, "connected": true, "socketId": "s-kim"],
                     ["username": "ivy", "ready": false, "isCreator": false, "connected": true, "socketId": "n2"]]]
    }
    static func refused(_ message: String, code: String = "rejected") -> [String: Any] {
        ["code": code, "message": message, "handler": "joinTournament"]
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
        tournament = TournamentState()
        mainRoom = MainRoomState()
        router = SocketEventRouter(socket: service, authState: auth, mainRoomState: mainRoom, lobbyState: LobbyState(),
                                   gameState: GameState(), appState: app, tournamentState: tournament,
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
        service.claimTournamentServerError = nil
        service.serverError = nil
        service.isConnected = false
        service.isSessionReady = false
        RestartNotices.shared.survived()
        RestartNotices.shared.message = nil
        TournamentRejoin.answerWait = 15
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

    /// On the tournament lobby screen in its lobby phase, ready (as the old socket left it).
    private func inTournamentLobby(_ id: String = "T1") {
        tournament.tournamentId = id
        tournament.name = "Sunday Cup"
        tournament.phase = "lobby"
        tournament.creatorUsername = "ivy"
        tournament.isReady = true
        tournament.players = [TournamentPlayer(id: "n1", username: "ivy", pic: nil, isReady: true, isCreator: true, connected: true)]
        app.screen = .tournamentLobby
    }

    /// The server's answers: the restore, the joinTournament's reply, what a leaveTournament
    /// gets (tournamentLeft + the main room, also from a socket in no tournament) and a
    /// joinMainRoom's.
    private func script(restore: [String: Any] = restored, joinTournament: [(String, [String: Any])],
                        leaveTournament: [(String, [String: Any])] = [("tournamentLeft", [:]), ("mainRoomJoined", mainRoomJoined)]) {
        server.replies = { name, _ in
            switch name {
            case "restoreSession": return [("restoreSessionResponse", restore)]
            case "joinTournament": return joinTournament
            case "leaveTournament": return leaveTournament
            case "joinMainRoom": return [("mainRoomJoined", Self.mainRoomJoined)]
            default: return []
            }
        }
    }

    private func connect() {
        service.serverURLOverride = server.url
        service.connect()
    }

    // MARK: - Back into the tournament

    /// One joinTournament for the tournament on screen after the restore, the lobby stays (no
    /// joinMainRoom), and the server's state replaces the old one: a new member is not ready,
    /// and the host may have moved on.
    @MainActor
    func testRestoreInATournamentLobbyJoinsItOnce() {
        inTournamentLobby()
        script(joinTournament: [("tournamentJoined", Self.joined())])
        connect()
        wait("back in the tournament") {
            self.tournament.players.count == 2 && self.tournament.rejoiningTournamentId == nil && service.isSessionReady
        }
        spin(0.5)

        XCTAssertEqual(sent("joinTournament").count, 1)
        XCTAssertEqual(sent("joinTournament").first?["tournamentId"] as? String, "T1")
        XCTAssertEqual(names.filter { $0 == "restoreSession" || $0 == "joinTournament" }, ["restoreSession", "joinTournament"])
        XCTAssertFalse(names.contains("joinMainRoom"))
        XCTAssertEqual(app.screen, .tournamentLobby)
        XCTAssertEqual(tournament.tournamentId, "T1")
        XCTAssertEqual(tournament.creatorUsername, "kim")
        XCTAssertFalse(tournament.isReady, "Ready follows the server's row")
        XCTAssertNil(service.serverError)
    }

    /// Held until answered (the lobby's actions wait), and a second restore answer on the
    /// same socket sends no second joinTournament.
    @MainActor
    func testUnansweredRejoinIsSentOncePerSocket() {
        inTournamentLobby()
        script(joinTournament: [])
        connect()
        wait("the rejoin went out") { self.sent("joinTournament").count == 1 && service.isSessionReady }
        XCTAssertEqual(tournament.rejoiningTournamentId, "T1", "the lobby's actions wait")
        XCTAssertEqual(tournament.rejoinSocketId, service.socketId)
        XCTAssertEqual(app.screen, .tournamentLobby)

        let again = AuthSocketHandler(socket: service, authState: auth, appState: app, gameState: GameState(),
                                      safetyState: SafetyState(), lobbyState: LobbyState(), tournamentState: tournament)
        again.handleRestoreSessionResponse(Self.restored)
        spin(0.5)
        XCTAssertEqual(sent("joinTournament").count, 1, "one joinTournament per socket")
        XCTAssertFalse(names.contains("joinMainRoom"))
    }

    /// A new socket (the server restarted, the link dropped) joins again too.
    @MainActor
    func testEveryNewSocketRejoins() {
        inTournamentLobby()
        script(joinTournament: [("tournamentJoined", Self.joined())])
        connect()
        wait("first rejoin answered") { self.sent("joinTournament").count == 1 && self.tournament.rejoiningTournamentId == nil }

        server.restart()
        wait("reconnected and rejoined", timeout: 15) {
            self.sent("joinTournament").count == 2 && self.tournament.rejoiningTournamentId == nil
        }
        spin(0.5)

        let engines = zip(server.events, server.eventEngines).filter { $0.0.name == "joinTournament" }.map(\.1)
        XCTAssertEqual(Set(engines).count, 2, "one per socket")
        XCTAssertFalse(names.contains("joinMainRoom"))
        XCTAssertEqual(app.screen, .tournamentLobby)
    }

    // MARK: - Refused

    /// Gone meanwhile (the last member left, the host cancelled): the main room, the
    /// tournament forgotten, one message in the app's words.
    @MainActor
    func testTournamentGoneFallsBackToTheMainRoom() {
        inTournamentLobby()
        script(joinTournament: [("serverError", Self.refused("Tournament not found")), ("mainRoomJoined", Self.mainRoomJoined)])
        connect()
        wait("in the main room") { self.app.screen == .mainRoom && self.mainRoom.onlineCount == 3 }
        spin(0.3)

        XCTAssertEqual(tournament.tournamentId, "")
        XCTAssertNil(tournament.rejoiningTournamentId)
        XCTAssertEqual(service.serverError?.message, "The tournament closed while you were offline")
        XCTAssertEqual(sent("joinMainRoom").count, 1)
        XCTAssertEqual(sent("leaveTournament").count, 0)
        XCTAssertTrue(service.isSessionReady)
    }

    /// It began without this player (the member was removed at the disconnect).
    @MainActor
    func testTournamentStartedFallsBackToTheMainRoom() {
        inTournamentLobby()
        script(joinTournament: [("serverError", Self.refused("Tournament is not accepting players")),
                                ("mainRoomJoined", Self.mainRoomJoined)])
        connect()
        wait("in the main room") { self.app.screen == .mainRoom && self.mainRoom.onlineCount == 3 }
        XCTAssertEqual(service.serverError?.message, "The tournament started without you")
        XCTAssertEqual(tournament.tournamentId, "")
    }

    /// A rate limit (the handler never ran, so the server sends no main room): joined here.
    @MainActor
    func testRateLimitFallsBackToTheMainRoom() {
        inTournamentLobby()
        script(joinTournament: [("serverError", Self.refused("Too many requests, please slow down", code: "rateLimit"))])
        connect()
        wait("in the main room") { self.app.screen == .mainRoom && self.mainRoom.onlineCount == 3 }
        XCTAssertEqual(sent("joinMainRoom").count, 1)
        XCTAssertEqual(service.serverError?.message, "Couldn't get back into the tournament")
    }

    /// After a serverShutdown the restart alert says why; no toast beside it.
    @MainActor
    func testRefusalAfterARestartShowsTheRestartMessage() {
        let handler = TournamentSocketHandler(socket: service, tournamentState: tournament, gameState: GameState(),
                                              appState: app, safetyState: SafetyState())
        inTournamentLobby()
        tournament.rejoiningTournamentId = "T1"
        RestartNotices.shared.serverShutdown(place: .tournament)
        XCTAssertTrue(handler.handleRejoinRefused(Self.refused("Tournament not found")))
        XCTAssertEqual(RestartNotices.shared.message, RestartNotice.message(.tournament))
        XCTAssertNil(service.serverError)
        XCTAssertEqual(app.screen, .mainRoom)
    }

    /// A joinTournament refusal with no re-entry waiting (Join in the main room, the started
    /// tournament's pointer), or another handler's failure while one waits: the usual toast.
    @MainActor
    func testOtherFailuresAreNotClaimed() {
        let handler = TournamentSocketHandler(socket: service, tournamentState: tournament, gameState: GameState(),
                                              appState: app, safetyState: SafetyState())
        handler.register()  // sets the claim (no socket: no handlers)
        app.screen = .mainRoom
        XCTAssertFalse(handler.handleRejoinRefused(Self.refused("Tournament is not accepting players")))
        service.handleServerError(Self.refused("Tournament is not accepting players"), channel: .serverError)
        XCTAssertEqual(service.serverError?.message, "Tournament is not accepting players")

        inTournamentLobby()
        tournament.rejoiningTournamentId = "T1"
        XCTAssertFalse(handler.handleRejoinRefused(["code": "rejected", "message": "Not in a tournament", "handler": "tournamentReady"]))
        XCTAssertEqual(tournament.rejoiningTournamentId, "T1")
        XCTAssertEqual(app.screen, .tournamentLobby)
    }

    // MARK: - Unchanged

    /// A tournament that has begun: the server's pointer, as before (no re-entry state, so
    /// its refusal is not claimed).
    @MainActor
    func testRestoreWithAnActiveTournamentUsesThePointer() {
        inTournamentLobby()
        tournament.phase = "between_rounds"
        var restore = Self.restored
        restore["activeTournamentId"] = "T1"
        script(restore: restore, joinTournament: [])
        connect()
        wait("the join went out") { self.sent("joinTournament").count == 1 && service.isSessionReady }
        spin(0.3)
        XCTAssertEqual(sent("joinTournament").first?["tournamentId"] as? String, "T1")
        XCTAssertNil(tournament.rejoiningTournamentId)
        XCTAssertFalse(names.contains("joinMainRoom"))
    }

    /// The server's game pointer wins over the tournament on screen.
    @MainActor
    func testRestoreWithAnActiveGameRejoinsTheGame() {
        inTournamentLobby()
        var restore = Self.restored
        restore["activeGameId"] = "G1"
        script(restore: restore, joinTournament: [])
        connect()
        wait("the game rejoin went out") { self.sent("rejoinGame").count == 1 && service.isSessionReady }
        spin(0.3)
        XCTAssertEqual(sent("joinTournament").count, 0)
        XCTAssertNil(tournament.rejoiningTournamentId)
    }

    /// No tournament to go back to (left: the id reset), or one this player only watches or
    /// whose results are up: the main room, as before.
    @MainActor
    func testNoRememberedTournamentGoesToTheMainRoom() {
        app.screen = .tournamentLobby  // tournamentId "" (tournamentLeft reset it)
        script(joinTournament: [])
        connect()
        wait("main room joined") { self.sent("joinMainRoom").count == 1 && service.isSessionReady }
        XCTAssertEqual(app.screen, .mainRoom)
        XCTAssertEqual(sent("joinTournament").count, 0)
    }

    @MainActor
    func testSpectatedTournamentGoesToTheMainRoom() {
        inTournamentLobby()
        tournament.isSpectator = true  // joinTournament would make this player an entrant
        script(joinTournament: [])
        connect()
        wait("main room joined") { self.sent("joinMainRoom").count == 1 && service.isSessionReady }
        XCTAssertEqual(app.screen, .mainRoom)
        XCTAssertEqual(sent("joinTournament").count, 0)
    }

    /// A foreground probe that keeps the connection: no restore, so nothing is re-sent.
    @MainActor
    func testKeptForegroundSendsNoRejoin() {
        inTournamentLobby()
        script(joinTournament: [("tournamentJoined", Self.joined())])
        connect()
        wait("back in the tournament") {
            self.sent("joinTournament").count == 1 && self.tournament.rejoiningTournamentId == nil && service.isSessionReady
        }

        service.resumeAfterKeepAlive()
        wait("the probe answered") { service.lastForegroundOutcome == .kept }
        spin(0.5)
        XCTAssertEqual(sent("restoreSession").count, 1)
        XCTAssertEqual(sent("joinTournament").count, 1)
        XCTAssertFalse(names.contains("joinMainRoom"))
        XCTAssertEqual(app.screen, .tournamentLobby)
        XCTAssertEqual(server.handshakes, 1)
    }

    // MARK: - Leaving before the answer

    /// Leave while the re-entry waits, and the tournament is gone: the main room at once, one
    /// leaveTournament (answered with tournamentLeft even from a socket in no tournament), the
    /// joinTournament's refusal dropped without a toast.
    @MainActor
    func testLeaveDuringTheRejoinWhenTheTournamentIsGone() {
        inTournamentLobby()
        script(joinTournament: [],  // answered behind the Leave, in the server's order
               leaveTournament: [("serverError", Self.refused("Tournament not found")), ("mainRoomJoined", Self.mainRoomJoined),
                                 ("tournamentLeft", [:]), ("mainRoomJoined", Self.mainRoomJoined)])
        connect()
        wait("the rejoin went out") { self.sent("joinTournament").count == 1 && service.isSessionReady }

        var screens: [AppState.Screen] = []
        let watch = app.$screen.sink { screens.append($0) }
        TournamentRejoin.abandon(tournamentState: tournament, appState: app)  // TournamentLobbyView's Leave
        XCTAssertEqual(app.screen, .mainRoom, "at once")
        XCTAssertEqual(tournament.tournamentId, "")
        wait("main room joined") { self.mainRoom.onlineCount == 3 && self.sent("joinMainRoom").count == 1 }
        spin(0.3)
        watch.cancel()

        XCTAssertFalse(screens.dropFirst().contains(.tournamentLobby), "\(screens)")
        XCTAssertEqual(sent("leaveTournament").count, 1)
        XCTAssertNil(service.serverError, "the refusal of a re-entry left already says nothing")
        XCTAssertNil(tournament.abandonedRejoinTournamentId)
        XCTAssertEqual(app.screen, .mainRoom)
    }

    /// Leave while the re-entry waits, and the join went through: the late tournamentJoined is
    /// dropped (the tournament never flashes up), and the leaveTournament behind it leaves.
    @MainActor
    func testLeaveDuringTheRejoinWhenItJoined() {
        inTournamentLobby()
        script(joinTournament: [],
               leaveTournament: [("tournamentJoined", Self.joined()),
                                 ("tournamentPlayerJoined", ["username": "ivy", "players": Self.joined()["players"]!]),
                                 ("tournamentLeft", [:]), ("mainRoomJoined", Self.mainRoomJoined)])
        connect()
        wait("the rejoin went out") { self.sent("joinTournament").count == 1 && service.isSessionReady }

        var screens: [AppState.Screen] = []
        let watch = app.$screen.sink { screens.append($0) }
        TournamentRejoin.abandon(tournamentState: tournament, appState: app)
        wait("main room joined") { self.mainRoom.onlineCount == 3 && self.sent("joinMainRoom").count == 1 }
        spin(0.3)
        watch.cancel()

        XCTAssertFalse(screens.dropFirst().contains(.tournamentLobby), "the tournament never came back up: \(screens)")
        XCTAssertEqual(app.screen, .mainRoom)
        XCTAssertEqual(tournament.tournamentId, "")
        XCTAssertTrue(tournament.players.isEmpty, "tournamentLeft reset it")
        XCTAssertNil(tournament.abandonedRejoinTournamentId)
        XCTAssertNil(service.serverError)
    }

    /// No answer on a socket that stays connected: after `answerWait` the main room, as a refusal.
    @MainActor
    func testUnansweredRejoinGivesUpAfterTheWait() {
        TournamentRejoin.answerWait = 0.5
        inTournamentLobby()
        script(joinTournament: [])
        connect()
        wait("the rejoin went out") { self.sent("joinTournament").count == 1 && service.isSessionReady }
        XCTAssertEqual(app.screen, .tournamentLobby)
        wait("gave up") { self.app.screen == .mainRoom && self.mainRoom.onlineCount == 3 }
        XCTAssertEqual(sent("leaveTournament").count, 1)
        XCTAssertEqual(service.serverError?.message, "Couldn't get back into the tournament")
        XCTAssertNil(tournament.rejoiningTournamentId)
    }

    /// An answered re-entry's wait does nothing.
    @MainActor
    func testAnsweredRejoinIsNotGivenUp() {
        TournamentRejoin.answerWait = 0.3
        inTournamentLobby()
        script(joinTournament: [("tournamentJoined", Self.joined())])
        connect()
        wait("back in the tournament") { self.tournament.players.count == 2 && self.tournament.rejoiningTournamentId == nil }
        spin(0.8)
        XCTAssertEqual(app.screen, .tournamentLobby)
        XCTAssertEqual(sent("leaveTournament").count, 0)
        XCTAssertNil(service.serverError)
    }

    // MARK: - The route (pure)

    func testRouteOrder() {
        typealias R = RestoreRoute
        XCTAssertEqual(R.of(["activeGameId": "G1"], screen: .tournamentLobby, lobbyId: "", tournamentId: "T1"),
                       .rejoinGame(gameId: "G1"))
        XCTAssertEqual(R.of(["activeTournamentId": "T2"], screen: .tournamentLobby, lobbyId: "", tournamentId: "T1"),
                       .tournament(tournamentId: "T2"))
        XCTAssertEqual(R.of([:], screen: .tournamentLobby, lobbyId: "L1", tournamentId: "T1"), .tournamentLobby(tournamentId: "T1"))
        XCTAssertEqual(R.of([:], screen: .tournamentLobby, lobbyId: "", tournamentId: ""), .mainRoom)
        for screen in [AppState.Screen.signIn, .register, .mainRoom, .game] {
            XCTAssertEqual(R.of([:], screen: screen, lobbyId: "", tournamentId: "T1"), .mainRoom, "\(screen)")
        }
        XCTAssertEqual(R.of([:], screen: .gameLobby, lobbyId: "L1", tournamentId: "T1"), .lobby(lobbyId: "L1"))
        XCTAssertEqual(R.tournamentRefusedMessage("Tournament not found"), "The tournament closed while you were offline")
        XCTAssertEqual(R.tournamentRefusedMessage("Tournament is not accepting players"), "The tournament started without you")
        for m in ["Already in a tournament", "Too many requests, please slow down", nil] {
            XCTAssertEqual(R.tournamentRefusedMessage(m), "Couldn't get back into the tournament")
        }
    }

    @MainActor
    func testRememberedId() {
        let state = TournamentState()
        XCTAssertEqual(TournamentRejoin.rememberedId(state), "")
        state.tournamentId = "T1"
        for phase in ["lobby", "round_active", "between_rounds"] {
            state.phase = phase
            XCTAssertEqual(TournamentRejoin.rememberedId(state), "T1", phase)
        }
        state.phase = "complete"
        XCTAssertEqual(TournamentRejoin.rememberedId(state), "")
        state.phase = "lobby"
        state.isSpectator = true
        XCTAssertEqual(TournamentRejoin.rememberedId(state), "")
    }
}
