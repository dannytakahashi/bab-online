import XCTest
@testable import BAB_Online

/// Toast follow-ups (toast audit 2026-11-18, "iOS gaps"; NoticeText.swift): every new toast is
/// announced to VoiceOver, server failures in the web's words and looks (never Joi's text), the
/// session outcomes that were silent (abortGame, forceLogout, voice full), the admin flag's
/// info look, and the toast layer mounted just after a notice.
@MainActor
final class ToastRoutingTests: XCTestCase {
    private var announced: [ServerErrorNotice] = []
    private var restoreAnnounce: ((ServerErrorNotice) -> Void)?

    override func setUp() {
        super.setUp()
        announced = []
        restoreAnnounce = ServerErrorNotice.announce
        ServerErrorNotice.announce = { [unowned self] in self.announced.append($0) }
        SocketService.shared.serverError = nil
    }

    override func tearDown() {
        if let restoreAnnounce { ServerErrorNotice.announce = restoreAnnounce }
        SocketService.shared.serverError = nil
        super.tearDown()
    }

    // MARK: VoiceOver

    func testEveryNewToastIsAnnouncedOnce() {
        let s = SocketService.shared
        let a = ServerErrorNotice(message: "Lobby is full")
        s.serverError = a
        s.serverError = a  // the same notice again: not news
        let b = ServerErrorNotice(message: "Lobby is full")
        s.serverError = b  // the same words, a new failure (a repeated tap): said again
        s.serverError = nil
        XCTAssertEqual(announced.map(\.id), [a.id, b.id])
        let back = LobbyReturn.backInNotice("Family night")
        s.serverError = back
        XCTAssertTrue(announced.last?.urgent == true, "the play-again line is read at high priority")
    }

    // MARK: serverError words and looks

    func testServerFailuresInThePlayersWords() {
        func n(_ d: [String: Any]) -> ServerErrorNotice { NoticeText.serverError(d) }
        let joi = "Validation failed: \"message\" length must be less than or equal to 500 characters long"
        XCTAssertEqual(n(["code": "validation", "message": joi, "handler": "chatMessage"]).message, "That message is too long (500 characters max).")
        XCTAssertEqual(n(["code": "validation", "message": joi, "handler": "lobbyChat"]).message, "That message is too long (500 characters max).")
        XCTAssertEqual(n(["code": "validation", "message": joi, "handler": "joinLobby"]).message, "That wasn't accepted. Try again.")
        XCTAssertEqual(n(["type": "validation", "message": joi]).message, "That wasn't accepted. Try again.", "the legacy error's type too")
        let limited = n(["code": "rateLimit", "message": "Too many requests, please slow down", "handler": "chatMessage"])
        XCTAssertEqual(limited.message, "Too many requests. Please slow down.")
        XCTAssertEqual(limited.kind, .error, "amber: a nudge")
        XCTAssertEqual(n(["code": "server", "message": "Internal error"]).message, "Something went wrong. Try again.")
        XCTAssertEqual(n(["code": "rejected", "handler": "joinLobby"]).message, "Something went wrong. Try again.", "no text: the fallback")
        XCTAssertEqual(n(["code": "rejected", "message": "Lobby is full", "handler": "joinLobby"]).message, "Lobby is full")
        XCTAssertEqual(n(["code": "rejected", "message": "Lobby is full", "handler": "joinLobby"]).kind, .error)
        let full = n(["code": "rejected", "message": "The table is full \u{2014} you'll watch this game", "handler": "playerReady"])
        XCTAssertEqual(full.kind, .info, "information sent as a refusal: teal")
        XCTAssertEqual(full.message, "The table is full \u{2014} you'll watch this game")
    }

    func testHandleServerErrorShowsTheMappedNotice() {
        let s = SocketService.shared
        s.handleServerError(["code": "validation", "message": "Validation failed: \"x\" is required", "handler": "createLobby"],
                            channel: .serverError, at: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(s.serverError?.message, "That wasn't accepted. Try again.")
        XCTAssertFalse(announced.contains { $0.message.contains("Validation failed") }, "Joi's text never reaches the player")
    }

    // MARK: session outcomes

    func testAbortReasons() {
        XCTAssertEqual(NoticeText.abortText("All players left"), "The game ended: every player left.")
        XCTAssertEqual(NoticeText.abortText("All players disconnected"), "The game ended: every player disconnected.")
        XCTAssertEqual(NoticeText.abortText("Game stalled"), "The game ended.")
        XCTAssertEqual(NoticeText.abortText(nil), "The game ended.")
        XCTAssertNil(NoticeText.abortText("Tournament cancelled"), "the cancel's own toast says it")
    }

    func testAbortGameShowsItsReason() {
        let store = GameState(), app = AppState()
        store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        app.screen = .game
        let handler = GameSocketHandler(socket: SocketService.shared, gameState: store, appState: app)
        handler.handle(event: "abortGame", payload: [["reason": "All players left"]])
        XCTAssertEqual(SocketService.shared.serverError?.message, "The game ended: every player left.")
        XCTAssertEqual(SocketService.shared.serverError?.kind, .info)
        XCTAssertEqual(app.screen, .mainRoom)
        // posted with the screen change: VoiceOver hears it once the main room is up, at high
        // priority (the new screen's speech would cut a default one off)
        XCTAssertEqual(announced.last?.message, "The game ended: every player left.")
        XCTAssertEqual(announced.last?.urgent, true)
        XCTAssertEqual(announced.last?.announceDelay, ServerErrorNotice.screenChangeDelay)
    }

    func testForceLogoutSaysWhyOnTheSignIn() async {
        let auth = AuthState(), app = AppState()
        auth.username = "ivy"
        auth.isAuthenticated = true
        app.screen = .mainRoom
        let handler = AuthSocketHandler(socket: SocketService.shared, authState: auth, appState: app, gameState: GameState(),
                                        safetyState: SafetyState(), lobbyState: LobbyState())
        handler.handleForceLogout(nil)
        for _ in 0..<50 where app.screen != .signIn { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(app.screen, .signIn)
        XCTAssertEqual(SocketService.shared.serverError?.message, "You were signed out. Sign in again to keep playing.")
        XCTAssertEqual(SocketService.shared.serverError?.kind, .info)
        XCTAssertTrue(ServerErrorToast.fresh(SocketService.shared.serverError!), "the sign-in's toast layer, just mounted, still shows it")
        XCTAssertFalse(ServerErrorToast.fresh(SocketService.shared.serverError!, now: Date().addingTimeInterval(3)))
        // VoiceOver hears it once the sign-in is up, at high priority (not cut off by the screen's speech)
        XCTAssertEqual(announced.last?.message, NoticeText.signedOut)
        XCTAssertEqual(announced.last?.urgent, true)
        XCTAssertEqual(announced.last?.announceDelay, ServerErrorNotice.screenChangeDelay)
    }

    func testVoiceFullIsAToastOnce() {
        let store = GameState()
        store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        let m = VoiceChatManager.silent()
        var said: [String] = []
        let full: [String: Any] = ["gameId": "g1", "host": "ivy", "spectatorsCanTalk": true, "role": "none", "canTalk": false, "canChange": false]
        VoiceSocketHandler.applyVoiceSettings(full, manager: m, gameState: store, start: { _ in }, notify: { said.append($0) })
        VoiceSocketHandler.applyVoiceSettings(full, manager: m, gameState: store, start: { _ in }, notify: { said.append($0) })
        XCTAssertEqual(said, ["Voice is full (8 people). You can still watch and chat."], "once, when it becomes full")
    }

    func testRemovingMyOwnAdminFlagIsInfo() {
        XCTAssertEqual(AdminCopy.toastKind(AdminCopy.noLongerAdmin), .info)
        XCTAssertEqual(AdminCopy.toastKind(AdminCopy.forbiddenToast), .error)
    }

    func testTheTableRefusalsAreThere() {
        // the web now has these too (noticeText.js NOTICE): iOS had them first
        XCTAssertEqual(TableRenderModel.Blocked.notYourTurn, "Not your turn.")
        XCTAssertEqual(TableRenderModel.Blocked.bidFirst, "Bid first.")
        XCTAssertEqual(TableRenderModel.Blocked.onItsWay, "Your card is on its way.")
        XCTAssertEqual(TableRenderModel.Blocked.trickClearing, "Wait for the trick to clear.")
        XCTAssertEqual(VoiceCopy.micDenied, "Microphone access denied. You can still listen.")
    }
}
