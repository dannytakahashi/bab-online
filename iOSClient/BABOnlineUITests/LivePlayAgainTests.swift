import XCTest

/// Opt-in live check of play again against a local server (never production; server PR D,
/// `server/socket/playAgain.js`): register a throwaway account, open a lobby with three bots,
/// play (as a lazy watcher, `/lazy`, so the bots finish the game), and at the end: the score
/// screen stays up although the server already moved this socket back into the lobby
/// (`lobbyReturn`); Return to Lobby shows that lobby (same name, the bots back, nobody ready),
/// and Ready there starts the next game. Run with a Debug build, a server started with
/// `BAB_PACING=fast` (NODE_ENV not production) and
/// `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`, `TEST_RUNNER_BAB_LIVE_USER=<new name>`,
/// `TEST_RUNNER_BAB_LIVE_PASS=<random>` (the account is created by the test; keep the password
/// out of logs and the repo).
final class LivePlayAgainTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func wait(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return condition()
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "live-play-again-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    func testTheResultsStayThenReturnToLobbyAndPlayAgain() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), TEST_RUNNER_BAB_LIVE_USER, TEST_RUNNER_BAB_LIVE_PASS")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server]
        app.launch()

        // register (a fresh simulator has no saved session)
        let toRegister = app.buttons.matching(NSPredicate(format: "label == %@", "Create Account")).firstMatch
        XCTAssertTrue(toRegister.waitForExistence(timeout: 30), "no Create Account on the sign-in screen")
        toRegister.tap()
        let name = app.textFields["Username"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap(); name.typeText(user)
        app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
        app.secureTextFields["Confirm Password"].tap(); app.secureTextFields["Confirm Password"].typeText(pass)
        let newGame = app.buttons["New Game"]
        for _ in 0..<3 where !newGame.exists {
            sleep(1)
            app.buttons.matching(NSPredicate(format: "label == %@", "Register")).firstMatch.tap()
            _ = newGame.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(newGame.waitForExistence(timeout: 20), "not in the main room after registering")
        XCTAssertTrue(wait(15) { newGame.isEnabled }, "New Game stays disabled (session)")

        // a lobby with three bots, then Ready: the game starts
        newGame.tap()
        Fixture.chooseClassicGame()
        let addBot = app.buttons["Add Bot"]
        XCTAssertTrue(addBot.waitForExistence(timeout: 15), "no game lobby")
        let lobbyName = "\(user)'s Game"  // the server's default name (GameManager.createNamedLobby)
        XCTAssertTrue(app.staticTexts[lobbyName].exists, "the lobby's header")
        for n in 1...3 {
            addBot.tap()
            XCTAssertTrue(wait(10) { app.buttons.matching(identifier: "lobby.removeBot").count == n }, "bot \(n)")
        }
        app.buttons["Ready"].tap()
        XCTAssertTrue(wait(60) { app.buttons["leave"].exists }, "the game did not start")

        // draw for deal (the deck, so the deal does not wait for the 30 s draw watchdog)
        let deck = app.buttons["Draw a card"]
        XCTAssertTrue(deck.waitForExistence(timeout: 15), "no deck to draw from")
        XCTAssertTrue(wait(10) { deck.isHittable }, "the deck is not tappable")
        deck.tap()

        // /lazy once dealt: a bot plays my seat and I watch it (a lazy watcher is moved back
        // at the end)
        let log = app.buttons["log"]
        let chat = app.textFields["Chat..."]
        XCTAssertTrue(wait(60) { !deck.exists && log.exists && log.isHittable }, "no game log button after the draw")
        sleep(2)
        // the drawer's field exists off screen; a tap during the deal's transition may be lost
        for _ in 0..<4 where !(chat.exists && chat.isHittable) {
            log.tap()
            _ = wait(4) { chat.exists && chat.isHittable }
        }
        XCTAssertTrue(chat.exists && chat.isHittable, "no chat field in the game log")
        chat.tap(); chat.typeText("/lazy\n")
        sleep(2)
        if log.exists && log.isHittable { log.tap() }  // close the drawer
        shot("1-lazy")

        // the end: the score screen, and it stays although lobbyReturn came with it
        let end = any(app, "gameEnd")
        XCTAssertTrue(end.waitForExistence(timeout: 900), "the game never ended")
        shot("2-results")
        sleep(8)
        XCTAssertTrue(end.exists, "the score screen stays")
        XCTAssertTrue(any(app, "gameEnd.stats").exists)
        XCTAssertFalse(any(app, "screen.gameLobby").exists, "no lobby behind the results")
        XCTAssertTrue(app.buttons["Return to Lobby"].isHittable)
        shot("3-results-still")

        // Return to Lobby: that lobby (same name, the bots back, nobody ready), not the main room
        app.buttons["Return to Lobby"].tap()
        XCTAssertTrue(any(app, "screen.gameLobby").waitForExistence(timeout: 10), "not in the lobby")
        XCTAssertFalse(any(app, "screen.mainRoom").exists)
        XCTAssertTrue(app.staticTexts[lobbyName].exists, "the same lobby name (\(lobbyName))")
        XCTAssertTrue(wait(10) { app.buttons.matching(identifier: "lobby.removeBot").count == 3 }, "the 3 bots are back, not ready")
        XCTAssertEqual(app.buttons["Ready"].label, "Ready")
        shot("4-lobby")

        // play again: Ready starts the next game from that lobby
        app.buttons["Ready"].tap()
        XCTAssertTrue(wait(60) { app.buttons["leave"].exists && !self.any(app, "screen.gameLobby").exists },
                      "the next game did not start")
        shot("5-next-game")
        app.terminate()
    }
}
