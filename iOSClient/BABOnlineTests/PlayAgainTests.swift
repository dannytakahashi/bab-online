import XCTest
import SocketIO
@testable import BAB_Online

/// Play again (owner 2026-11-16; iOS 1.2.3, build 12; server/socket/playAgain.js): at the end
/// of a casual game a lobby started, the server moves this socket back into that lobby and
/// sends `lobbyReturn` right after `gameEnd`. The owner's rule: the score screen stays exactly
/// as it is until the person taps the existing Return to Lobby, which then enters that lobby
/// (not the main room), voice kept. Payloads are shaped as playAgain.openLobby sends them.
@MainActor
final class PlayAgainTests: XCTestCase {
    private let lobbyId = "00000000-0000-4000-8000-0000000000aa"

    /// jon's table (seat 4 of hand-resolving) on screen, the last hand resolving; `ended`: its
    /// gameEnd applied (GameEndView up).
    private func table(ended: Bool) throws -> (GameState, AppState, String) {
        let store = GameState()
        store.apply(.local(.identity(username: "jon", playerId: "p-jon")))
        let snap = try TableSnapshot.decode(try FixtureLoader.v2Snapshot("hand-resolving"), strict: true)
        store.apply(.snapshot(snap, .rejoin, hints: nil))
        let gameId = try XCTUnwrap(store.gameId)
        if ended { endGame(store, seq: snap.seq + 1) }
        let app = AppState()
        app.screen = .game
        return (store, app, gameId)
    }

    private func endGame(_ store: GameState, seq: Int) {
        _ = store.apply(serverEvent: "gameEnd", payload: [[
            "score": ["team1": 312, "team2": 287], "playerStats": [String: Any](), "tournamentId": NSNull(), "seq": seq,
        ] as [String: Any]])
    }

    private func member(_ u: String, returning: Bool = false, bot: Bool = false) -> [String: Any] {
        var m: [String: Any] = ["socketId": returning ? "away:\(u)" : bot ? "bot:\(u)" : "sid-\(u)", "username": u,
                                "ready": false, "playing": !bot]
        if returning { m["reconnecting"] = true; m["returning"] = true }
        if bot { m["isBot"] = true }
        return m
    }

    /// lobbyReturn as openLobby sends it: jon and ivy moved, kim held (returning), a lobby bot,
    /// hal (an older app) expected.
    private func lobbyReturn(gameId: String, expected: [String]? = ["hal"]) -> [String: Any] {
        let members = [member("ivy"), member("jon"), member("kim", returning: true), member("\u{1F916} Bot", bot: true)]
        var d: [String: Any] = [
            "lobbyId": lobbyId, "name": "Family night", "players": members, "members": members,
            "reconnecting": ["kim"],
            "messages": [["username": "ivy", "message": "gg", "timestamp": 1], ["username": "spam", "message": "x", "timestamp": 2]],
            "host": "ivy", "settings": ["spectatorsCanTalk": false], "capacity": 8,
            "lastGame": ["gameId": gameId, "score": ["team1": 312, "team2": 287], "playerStats": [String: Any](), "position": 4],
        ]
        if let expected { d["expected"] = expected }
        return d
    }

    private func receive(_ dict: [String: Any], _ lobby: LobbyState, _ app: AppState, _ store: GameState,
                         left: (() -> Void)? = nil, scheduled: ((TimeInterval, @escaping @MainActor () -> Void) -> Void)? = nil) {
        LobbyReturn.receive(dict, lobbyState: lobby, appState: app, gameState: store, isBlocked: { $0 == "spam" },
                            leaveLobby: left ?? { XCTFail("no leaveLobby expected") },
                            schedule: scheduled ?? { _, _ in XCTFail("nothing to wait for") })
    }

    // MARK: - The score screen stays

    func testTheResultsStayAndTheLobbyIsKeptBehindThem() throws {
        let (store, app, gameId) = try table(ended: true)
        let lobby = LobbyState()
        receive(lobbyReturn(gameId: gameId), lobby, app, store)

        XCTAssertEqual(app.screen, .game, "lobbyReturn changes no screen (owner 2026-11-16)")
        XCTAssertEqual(store.phase, .ended)
        XCTAssertNotNil(store.gameEndData, "GameEndView still has its results")
        XCTAssertEqual(store.gameId, gameId)
        XCTAssertEqual(lobby.returnFromGameId, gameId)
        XCTAssertEqual(lobby.lobbyId, lobbyId)
        XCTAssertEqual(lobby.lobbyName, "Family night")
        XCTAssertEqual(lobby.players.map(\.username), ["ivy", "jon", "kim", "\u{1F916} Bot"])
        XCTAssertEqual(lobby.players.filter(\.returning).map(\.username), ["kim"])
        XCTAssertTrue(lobby.isReconnecting(lobby.players[2]))
        XCTAssertEqual(lobby.expected, ["hal"])
        XCTAssertEqual(lobby.host, "ivy")
        XCTAssertEqual(lobby.capacity, 8)
        XCTAssertFalse(lobby.spectatorsCanTalk)
        XCTAssertEqual(lobby.messages.map(\.username), ["ivy"], "a blocked sender's line is dropped")
        XCTAssertFalse(lobby.carriesVoice)

        // the lobby's events keep it current behind the results (LobbySocketHandler applies
        // them whatever the screen): ivy readies, hal's reservation ends
        var later = lobbyReturn(gameId: gameId, expected: nil)
        var members = later["members"] as! [[String: Any]]
        members[0]["ready"] = true
        later["members"] = members
        lobby.applyPlayers(from: later, namesHeldSeats: true)
        XCTAssertEqual(lobby.players.first?.isReady, true)
        XCTAssertEqual(lobby.expected, [], "members without expected: no reservation stands")
        XCTAssertEqual(app.screen, .game)
    }

    func testReturnToLobbyEntersThatLobbyWithVoiceKept() throws {
        let (store, app, gameId) = try table(ended: true)
        let lobby = LobbyState()
        receive(lobbyReturn(gameId: gameId), lobby, app, store)

        XCTAssertTrue(LobbyReturn.enterOnReturn(lobbyState: lobby, appState: app, gameState: store))
        XCTAssertEqual(app.screen, .gameLobby)
        XCTAssertNil(lobby.returnFromGameId)
        XCTAssertEqual(lobby.lobbyId, lobbyId, "the lobby the server put me in, as kept")
        XCTAssertEqual(lobby.players.count, 4)
        XCTAssertEqual(store.gameId, lobbyId, "the table reset for the lobby (enterLobby)")
        XCTAssertNotEqual(store.phase, .ended)
        XCTAssertTrue(lobby.carriesVoice)
        // GameContainerView's onDisappear: voice kept once, the flag spent
        XCTAssertTrue(LobbyReturn.keepsVoice(lobbyState: lobby, appState: app))
        XCTAssertFalse(lobby.carriesVoice)
        XCTAssertFalse(LobbyReturn.keepsVoice(lobbyState: lobby, appState: app))
        // after a reconnect in that lobby, the restore takes the seat back (RestoreRoute.lobby)
        XCTAssertEqual(RestoreRoute.of([:], screen: app.screen, lobbyId: lobby.lobbyId), .lobby(lobbyId: lobbyId))
    }

    func testWithoutAReturnTheButtonKeepsItsOldWay() throws {
        let (store, app, gameId) = try table(ended: true)
        let lobby = LobbyState()
        XCTAssertFalse(LobbyReturn.enterOnReturn(lobbyState: lobby, appState: app, gameState: store),
                       "an older server, a tournament, a legacy flow: the main room as before")
        lobby.applyLobby(lobbyReturn(gameId: gameId), isBlocked: { _ in false })
        lobby.returnFromGameId = "another-game"
        XCTAssertFalse(LobbyReturn.enterOnReturn(lobbyState: lobby, appState: app, gameState: store),
                       "a return for another game is not this score screen's")
        XCTAssertEqual(app.screen, .game)
    }

    /// A stray lobbyCreated (or any way off the table but the return) never carries the game's
    /// calls into a lobby: voice shuts down as before (review finding on rev 1).
    func testOnlyTheReturnKeepsVoice() throws {
        let app = AppState(), lobby = LobbyState()
        app.screen = .gameLobby
        XCTAssertFalse(LobbyReturn.keepsVoice(lobbyState: lobby, appState: app), "lobbyCreated sets no flag")
        lobby.carriesVoice = true
        app.screen = .mainRoom
        XCTAssertFalse(LobbyReturn.keepsVoice(lobbyState: lobby, appState: app), "off the table elsewhere: shut down")
        XCTAssertFalse(lobby.carriesVoice)
        // from the main room the lobby comes up with no flag (no game voice to keep)
        let store = GameState()
        receive(lobbyReturn(gameId: "g-old"), lobby, app, store)
        XCTAssertEqual(app.screen, .gameLobby)
        XCTAssertFalse(lobby.carriesVoice)
    }

    // MARK: - gameEnd still in the seq gate

    func testAReturnBeforeItsGameEndWaitsForIt() throws {
        let (store, app, gameId) = try table(ended: false)
        let lobby = LobbyState()
        var waited: [(TimeInterval, () -> Void)] = []
        receive(lobbyReturn(gameId: gameId), lobby, app, store, scheduled: { delay, work in waited.append((delay, work)) })
        XCTAssertEqual(app.screen, .game)
        XCTAssertEqual(lobby.returnFromGameId, gameId)
        XCTAssertEqual(waited.map(\.0), [5])

        // gameEnd applies: the score screen, and the fallback does nothing
        endGame(store, seq: (store.state.sync.lastSeq ?? 0) + 1)
        XCTAssertEqual(store.phase, .ended)
        waited.first?.1()
        XCTAssertEqual(app.screen, .game, "the results stay")
        XCTAssertEqual(lobby.returnFromGameId, gameId)
        XCTAssertTrue(LobbyReturn.enterOnReturn(lobbyState: lobby, appState: app, gameState: store))
    }

    func testNoGameEndInTimeEntersTheLobby() throws {
        let (store, app, gameId) = try table(ended: false)
        let lobby = LobbyState()
        var waited: [() -> Void] = []
        receive(lobbyReturn(gameId: gameId), lobby, app, store, scheduled: { _, work in waited.append(work) })
        XCTAssertEqual(waited.count, 1)
        waited[0]()
        XCTAssertEqual(app.screen, .gameLobby, "no score screen to keep: into the lobby")
        XCTAssertTrue(lobby.carriesVoice)
        XCTAssertNil(lobby.returnFromGameId)
    }

    func testTheFallbackDoesNothingOnceTheTableMovedOn() throws {
        let (store, app, gameId) = try table(ended: false)
        let lobby = LobbyState()
        var waited: [() -> Void] = []
        receive(lobbyReturn(gameId: gameId), lobby, app, store, scheduled: { _, work in waited.append(work) })
        lobby.reset()  // e.g. leftLobby behind the table
        waited[0]()
        XCTAssertEqual(app.screen, .game)
    }

    // MARK: - Elsewhere

    func testAtTheMainRoomItEntersAtOnce() {
        let store = GameState(), app = AppState(), lobby = LobbyState()
        app.screen = .mainRoom
        receive(lobbyReturn(gameId: "g1"), lobby, app, store)
        XCTAssertEqual(app.screen, .gameLobby)
        XCTAssertEqual(lobby.lobbyId, lobbyId)
        XCTAssertEqual(store.gameId, lobbyId)
        XCTAssertNil(lobby.returnFromGameId)
    }

    func testAtAnotherTableOrTournamentItLeavesThatLobby() throws {
        let (store, app, _) = try table(ended: true)
        let lobby = LobbyState()
        var left = 0
        receive(lobbyReturn(gameId: "another-game"), lobby, app, store, left: { left += 1 })
        XCTAssertEqual(left, 1, "the server's membership is put right (leaveLobby)")
        XCTAssertEqual(lobby.lobbyId, "")
        XCTAssertEqual(app.screen, .game)

        app.screen = .tournamentLobby
        receive(lobbyReturn(gameId: "g1"), lobby, app, store, left: { left += 1 })
        XCTAssertEqual(left, 2)
        XCTAssertEqual(app.screen, .tournamentLobby)
        receive(["lobbyId": ""], lobby, app, store)  // unreadable: nothing
    }

    func testLeftLobbyBehindTheResultsKeepsTheResults() throws {
        let (store, app, gameId) = try table(ended: true)
        let lobby = LobbyState()
        receive(lobbyReturn(gameId: gameId), lobby, app, store)
        LobbySocketHandler.applyLeftLobby(lobbyState: lobby, appState: app)
        XCTAssertEqual(app.screen, .game, "the results stay up")
        XCTAssertNil(lobby.returnFromGameId)
        XCTAssertFalse(LobbyReturn.enterOnReturn(lobbyState: lobby, appState: app, gameState: store),
                       "Return to Lobby goes to the main room again")

        // in the lobby itself, leftLobby is the main room as before
        app.screen = .gameLobby
        lobby.lobbyId = "L1"
        LobbySocketHandler.applyLeftLobby(lobbyState: lobby, appState: app)
        XCTAssertEqual(app.screen, .mainRoom)
        XCTAssertEqual(lobby.lobbyId, "")
    }

    // MARK: - The lobby after the game

    func testDontWaitAndAddBot() {
        let lobby = LobbyState()
        lobby.applyLobby(lobbyReturn(gameId: "g1"), isBlocked: { _ in false })
        XCTAssertTrue(lobby.canRelease("ivy"), "the host")
        XCTAssertFalse(lobby.canRelease("jon"), "not while the host is here")
        XCTAssertFalse(lobby.canRelease("kim"), "not the held one")
        XCTAssertFalse(lobby.canRelease(nil))
        XCTAssertFalse(lobby.canAddBot, "4 members: no bot")

        // the host is the one held: any present member may
        var held = lobbyReturn(gameId: "g1", expected: nil)
        held["members"] = [member("ivy", returning: true), member("jon")]
        lobby.applyPlayers(from: held, namesHeldSeats: true)
        XCTAssertTrue(lobby.canRelease("jon"))
        XCTAssertFalse(lobby.canRelease("ivy"))
        XCTAssertTrue(lobby.canAddBot)

        // 2 members + 2 expected: the server refuses a bot (reservationBlocks)
        var reserved = held
        reserved["expected"] = ["hal", "abe"]
        lobby.applyPlayers(from: reserved, namesHeldSeats: true)
        XCTAssertFalse(lobby.canAddBot)
        lobby.reset()
        XCTAssertEqual(lobby.expected, [])
        XCTAssertFalse(lobby.carriesVoice)
    }

    func testAnOlderServersLobbyHasNoReturningOrExpected() {
        let lobby = LobbyState()
        lobby.applyPlayers(from: ["lobbyId": "l", "players": [["username": "a", "socketId": "s"]], "expected": ["x"]],
                           namesHeldSeats: true)
        XCTAssertEqual(lobby.expected, [], "expected is read only beside members")
        XCTAssertFalse(lobby.players[0].returning)
        XCTAssertTrue(lobby.canAddBot)
    }

    func testTheLobbyIsInTalkModeForEveryone() {
        let m = VoiceChatManager(hooks: .init(requestRecordPermission: { true }, configureAudioSession: {},
                                              sendOffer: { _, _, _ in }, sendAnswer: { _, _ in }),
                                 iceStore: IceServerStore(timeout: 0.05, emit: { _ in }))
        // a lobby extra the host's switch held to listening
        m.settings = VoiceSettings(gameId: "g1", host: "ivy", spectatorsCanTalk: false, role: .spectator, canTalk: false, canChange: false)
        m.setDesiredMode(canTalk: false, wantsMic: true)
        m.setForcedMuted(["kim"])
        LobbyReturn.toLobbyVoice(m)
        XCTAssertNil(m.settings, "the game's voice settings went with the game")
        XCTAssertTrue(m.talkAllowed)
        XCTAssertTrue(m.wantsMic)
        XCTAssertEqual(m.forcedMuted, [])
    }

    func testTheWords() {
        XCTAssertEqual(LobbyReturn.backInText("Family night"),
                       "Back in \u{201C}Family night\u{201D}. Tap Ready when you want to play again.")
        XCTAssertEqual(PlayAgainCopy.dontWaitFor("kim"), "Don't wait for kim")
        XCTAssertEqual(LobbyReturn.gameEndWait, 5)
        XCTAssertTrue(ClientHello.caps.contains("playAgain"))
        XCTAssertEqual(SocketEvents.Server.lobbyReturn, "lobbyReturn")
        XCTAssertEqual(SocketEvents.Client.releaseLobbyHold, "releaseLobbyHold")
    }
}

/// The real socket and the app's router against FakeSocketIOServer: lobbyReturn is routed,
/// and a restore while the score screen keeps a lobby goes to the main room, whose
/// joinMainRoom the server answers by putting this new socket back in that lobby.
final class PlayAgainSocketTests: XCTestCase {
    private var service: SocketService { SocketService.shared }
    private var server: FakeSocketIOServer!
    private var app: AppState!
    private var lobby: LobbyState!
    private var store: GameState!
    private var router: SocketEventRouter!

    @MainActor
    override func setUpWithError() throws {
        server = FakeSocketIOServer()
        try server.start()
        let auth = AuthState()
        auth.username = "jon"
        auth.sessionToken = "fixture-restore"
        app = AppState()
        lobby = LobbyState()
        store = GameState()
        router = SocketEventRouter(socket: service, authState: auth, mainRoomState: MainRoomState(), lobbyState: lobby,
                                   gameState: store, appState: app, tournamentState: TournamentState(),
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
        server.stop()
        server = nil
        super.tearDown()
    }

    private func wait(_ what: String, timeout: TimeInterval = 10, until done: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        XCTAssertTrue(done(), what)
    }

    private static let lobbyId = "00000000-0000-4000-8000-0000000000bb"
    private static func lobbyPayload(extra: [String: Any] = [:]) -> [String: Any] {
        let members: [[String: Any]] = [["socketId": "s-ivy", "username": "ivy", "ready": false, "playing": true],
                                        ["socketId": "s-jon", "username": "jon", "ready": false, "playing": true]]
        return ["lobbyId": lobbyId, "name": "Family night", "players": members, "members": members, "messages": [],
                "host": "ivy", "settings": ["spectatorsCanTalk": true], "capacity": 8].merging(extra) { $1 }
    }

    /// Off the score screen (a restore lands in the main room): the server's lobbyReturn from
    /// the router enters the lobby at once.
    @MainActor
    func testLobbyReturnIsRoutedAtTheMainRoom() {
        app.screen = .mainRoom
        server.replies = { name, _ in
            switch name {
            case "restoreSession": return [("restoreSessionResponse", ["success": true, "username": "jon", "blockedUsers": []])]
            case "joinMainRoom":
                return [("lobbyReturn", Self.lobbyPayload(extra: ["lastGame": ["gameId": "g-old", "score": ["team1": 1, "team2": 0],
                                                                                "playerStats": [String: Any](), "position": 2]]))]
            default: return []
            }
        }
        service.serverURLOverride = server.url
        service.connect()
        wait("in the lobby") { self.app.screen == .gameLobby && self.lobby.lobbyId == Self.lobbyId }
        XCTAssertEqual(lobby.lobbyName, "Family night")
    }

    /// A restore on the score screen that kept a lobby: that was the old socket's, so it is
    /// forgotten and the restore goes to the main room as from any score screen; the server
    /// answers that joinMainRoom with the ordinary lobbyCreated (playAgain.autoClaimTarget).
    @MainActor
    func testARestoreOnTheResultsGoesThroughTheMainRoomBackToTheLobby() throws {
        let snap = try TableSnapshot.decode(try FixtureLoader.v2Snapshot("hand-resolving"), strict: true)
        store.apply(.snapshot(snap, .rejoin, hints: nil))
        let gameId = try XCTUnwrap(store.gameId)
        _ = store.apply(serverEvent: "gameEnd", payload: [["score": ["team1": 3, "team2": 1], "playerStats": [String: Any](),
                                                           "tournamentId": NSNull(), "seq": snap.seq + 1] as [String: Any]])
        app.screen = .game
        lobby.applyLobby(Self.lobbyPayload(), isBlocked: { _ in false })
        lobby.returnFromGameId = gameId

        server.replies = { name, _ in
            switch name {
            case "restoreSession": return [("restoreSessionResponse", ["success": true, "username": "jon", "blockedUsers": []])]
            case "joinMainRoom": return [("lobbyCreated", Self.lobbyPayload())]
            default: return []
            }
        }
        service.serverURLOverride = server.url
        service.connect()
        wait("back in the lobby") { self.app.screen == .gameLobby }
        XCTAssertEqual(server.events.filter { $0.name == "joinMainRoom" }.count, 1)
        XCTAssertFalse(server.events.contains { $0.name == "joinLobby" }, "no lobby route from a score screen")
        XCTAssertEqual(lobby.lobbyId, Self.lobbyId)
        XCTAssertNil(lobby.returnFromGameId)
    }
}
