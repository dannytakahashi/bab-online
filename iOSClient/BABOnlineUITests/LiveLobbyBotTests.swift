import XCTest

/// Opt-in live check against a local server (never production): register a throwaway
/// account, create a game lobby, add two bots, remove one, add one again, ready, and the
/// game starts. Run with a Debug build and
/// `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`, `TEST_RUNNER_BAB_LIVE_USER=<new name>`
/// and `TEST_RUNNER_BAB_LIVE_PASS=<random>` (the account is created by the test; keep the
/// password out of logs and the repo).
final class LiveLobbyBotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func wait(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return condition()
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "live-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func removeButtons(_ app: XCUIApplication) -> [XCUIElement] {
        app.buttons.matching(identifier: "lobby.removeBot").allElementsBoundByIndex
    }

    func testAddRemoveAddBotsThenStart() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), TEST_RUNNER_BAB_LIVE_USER, TEST_RUNNER_BAB_LIVE_PASS")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server]
        app.launch()

        // register (a fresh simulator has no saved session)
        let toRegister = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Register")).firstMatch
        XCTAssertTrue(toRegister.waitForExistence(timeout: 30), "no Register link on the sign-in screen")
        toRegister.tap()
        let name = app.textFields["Username"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap(); name.typeText(user)
        app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
        app.secureTextFields["Confirm Password"].tap(); app.secureTextFields["Confirm Password"].typeText(pass)
        shot("0-register")
        // the form moves when the keyboard goes: tap Register once it has settled, again if
        // the first tap only ended the editing
        let newGame = app.buttons["New Game"]
        for _ in 0..<3 where !newGame.exists {
            sleep(1)
            app.buttons.matching(NSPredicate(format: "label == %@", "Register")).firstMatch.tap()
            _ = newGame.waitForExistence(timeout: 8)
        }

        // main room -> New Game
        if !newGame.waitForExistence(timeout: 20) { shot("0-register-failed") }
        XCTAssertTrue(newGame.exists, "not in the main room after registering")
        XCTAssertTrue(wait(15) { newGame.isEnabled }, "New Game stays disabled (session)")
        newGame.tap()
        let addBot = app.buttons["Add Bot"]
        XCTAssertTrue(addBot.waitForExistence(timeout: 15), "no game lobby")

        // two bots, each removable (not ready)
        addBot.tap()
        XCTAssertTrue(wait(10) { self.removeButtons(app).count == 1 }, "first bot")
        addBot.tap()
        XCTAssertTrue(wait(10) { self.removeButtons(app).count == 2 }, "second bot")
        XCTAssertEqual(Set(removeButtons(app).map(\.label)), ["Remove Bot", "Remove Bot 2"])
        shot("1-two-bots")

        // remove one: the server's list drops it
        app.buttons["Remove Bot 2"].tap()
        XCTAssertTrue(wait(10) { self.removeButtons(app).count == 1 }, "the bot was not removed")
        XCTAssertEqual(removeButtons(app).first?.label, "Remove Bot")
        shot("2-removed")

        // add one again, then the fourth seat
        addBot.tap()
        XCTAssertTrue(wait(10) { self.removeButtons(app).count == 2 }, "re-added bot")
        XCTAssertTrue(addBot.exists, "3 of 4: Add Bot stays")
        addBot.tap()
        XCTAssertTrue(wait(10) { self.removeButtons(app).count == 3 }, "fourth seat")
        XCTAssertFalse(addBot.exists, "full")
        shot("3-full")

        // ready: the bots ready with me, their remove controls go, and the game starts
        app.buttons["Ready"].tap()
        XCTAssertTrue(wait(10) { self.removeButtons(app).isEmpty }, "ready bots must not be removable")
        shot("4-ready")
        // allPlayersReady: the table (its Leave control, "leave") replaces the lobby
        XCTAssertTrue(wait(30) { app.buttons["leave"].exists && !app.descendants(matching: .any)["screen.gameLobby"].exists },
                      "the game did not start")
        sleep(3)
        shot("5-game")
        app.terminate()
    }
}
