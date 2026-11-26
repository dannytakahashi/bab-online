import XCTest

/// Opt-in live check of Get Your Bid against a local server (never production): register a
/// throwaway account, New Game -> Get Your Bid, add one bot, wait for a second human (a web tab
/// that joins the lobby), Ready, then play every hand from the app (a legal bid, never the
/// struck Forbidden Bid; a legal card) to the game's end, with screenshots of the lobby, the
/// three-seat table, my Forbidden Bid on a dealer turn of 5+ cards, and the results. Run with
/// a Debug build and `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`,
/// `TEST_RUNNER_BAB_LIVE_USER=<new name>`, `TEST_RUNNER_BAB_LIVE_PASS=<random>`;
/// `TEST_RUNNER_BAB_SHOTS=<folder>` saves PNGs (`live-gyb-<step>.png`).
final class LiveGybTests: XCTestCase {
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
        let png = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: png)
        a.name = "live-gyb-\(name)"
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("live-gyb-\(name).png"))
        }
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    /// My hand's playable cards (CardSpriteNode: a button, not enabled while illegal).
    private func playableCards(_ app: XCUIApplication) -> [XCUIElement] {
        let names = NSPredicate(format: "label MATCHES %@", "^(.+ of (Spades|Hearts|Diamonds|Clubs)|High Joker|Low Joker)$")
        return app.buttons.matching(names).allElementsBoundByIndex.filter { $0.isEnabled && $0.isHittable }
    }

    func testAGetYourBidGameFromTheLobbyToTheEnd() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), TEST_RUNNER_BAB_LIVE_USER, TEST_RUNNER_BAB_LIVE_PASS")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server]
        app.launch()

        // register
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
        XCTAssertTrue(wait(20) { newGame.isEnabled }, "New Game stays disabled (session)")

        // New Game -> Get Your Bid
        newGame.tap()
        let gyb = app.buttons["Get Your Bid"].firstMatch
        XCTAssertTrue(gyb.waitForExistence(timeout: 5), "New Game does not offer Get Your Bid")
        shot("0-new-game")
        gyb.tap()
        XCTAssertTrue(any(app, "lobby.mode").waitForExistence(timeout: 15), "no Get Your Bid lobby")
        XCTAssertTrue(app.staticTexts["Ready 0/3"].waitForExistence(timeout: 5))
        let addBot = app.buttons["Add Bot"]
        XCTAssertTrue(addBot.waitForExistence(timeout: 5))
        addBot.tap()
        // a web tab joins (the person running the check, within 5 minutes)
        let waiting = app.staticTexts.matching(NSPredicate(format: "label == %@", "Waiting for player..."))
        XCTAssertTrue(wait(300) { waiting.count == 0 }, "nobody joined the lobby")
        XCTAssertFalse(addBot.exists, "Add Bot only below 3")
        shot("1-lobby")
        app.buttons["Ready"].tap()

        // the draw: tap the deck
        let deck = app.buttons["Draw a card"]
        if deck.waitForExistence(timeout: 120) { deck.tap() }
        XCTAssertTrue(any(app, "scoreBar.seat.1").waitForExistence(timeout: 120) || any(app, "scoreBar.seat.2").exists,
                      "no three-column score bar")

        var sawTable = false, sawForbidden = false
        let gameEnd = any(app, "gameEnd")
        let deadline = Date().addingTimeInterval(1500)
        while !gameEnd.exists && Date() < deadline {
            let sheet = any(app, "bidOverlay")
            if sheet.exists && app.buttons["Submit"].exists {
                let forbidden = app.buttons["bid.forbidden"]
                if forbidden.exists {
                    XCTAssertFalse(forbidden.isEnabled, "the Forbidden Bid is disabled")
                    XCTAssertTrue(any(app, "bid.forbiddenLine").label.hasPrefix("Forbidden Bid: "))
                    if !sawForbidden { shot("3-forbidden-bid"); sawForbidden = true }
                }
                // the lowest bid that is not forbidden
                let bid = (0...13).lazy.map { app.buttons["bid.\($0)"] }.first { $0.exists && $0.isEnabled }
                bid?.tap()
                app.buttons["Submit"].tap()
                sleep(1)
                continue
            }
            if let card = playableCards(app).first {
                if !sawTable { shot("2-table"); sawTable = true }
                // the card's visible strip (the next card covers its right part): lift, then play
                let strip = card.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.3))
                strip.tap()
                usleep(300_000)
                strip.tap()
                sleep(1)
                continue
            }
            usleep(500_000)
        }
        XCTAssertTrue(gameEnd.waitForExistence(timeout: 60), "the game did not end")
        sleep(2)
        shot("4-game-end")
        XCTAssertTrue(sawTable)
        XCTAssertTrue(sawForbidden, "I never saw my Forbidden Bid (a dealer turn on 5+ cards)")
        XCTAssertTrue(any(app, "gameEnd.solo.1").exists && any(app, "gameEnd.solo.2").exists && any(app, "gameEnd.solo.3").exists)
        // play again: Return to Lobby enters a Get Your Bid lobby again
        app.buttons["Return to Lobby"].tap()
        XCTAssertTrue(any(app, "lobby.mode").waitForExistence(timeout: 15), "play again's lobby is not a Get Your Bid one")
        shot("5-play-again-lobby")
    }
}
