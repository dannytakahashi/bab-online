import XCTest

/// Opt-in live check of the tutorial's auto-start against a local server (never production):
/// register a throwaway account (users.tutorial 'pending'), a game with three bots, draw; the
/// first game starts with the tutorial on: the welcome tip (Keep / Turn off), the "Tutorial on"
/// chip, and on my bid turn the advice card without asking (no lightbulb tap), a bid ringed;
/// after Keep and my bid, my play turn gets its advice card too. Nothing about free uses, limits
/// or bot-assisted shows (a game with a native bot seat). Run with a Debug build and
/// `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`, `TEST_RUNNER_BAB_LIVE_USER=<new name>`
/// and `TEST_RUNNER_BAB_LIVE_PASS=<random>` (the account is created by the test; keep the
/// password out of logs and the repo). `TEST_RUNNER_BAB_SHOTS=<folder>` saves PNGs.
final class LiveTutorialTests: XCTestCase {
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

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: png)
        a.name = "live-tutorial-\(name)"
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("live-tutorial-\(name).png"))
        }
    }

    func testANewAccountsFirstGameStartsWithTheTutorial() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), TEST_RUNNER_BAB_LIVE_USER, TEST_RUNNER_BAB_LIVE_PASS")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server]
        app.launch()

        // register (a fresh account: the auto-start is for new accounts only)
        let newGame = app.buttons["New Game"]
        let toRegister = app.buttons.matching(NSPredicate(format: "label == %@", "Create Account")).firstMatch
        XCTAssertTrue(toRegister.waitForExistence(timeout: 30), "no Create Account on the sign-in screen (signed in already?)")
        toRegister.tap()
        let name = app.textFields["Username"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap(); name.typeText(user)
        app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
        app.secureTextFields["Confirm Password"].tap(); app.secureTextFields["Confirm Password"].typeText(pass)
        for _ in 0..<3 where !newGame.exists {
            sleep(1)
            app.buttons.matching(NSPredicate(format: "label == %@", "Register")).firstMatch.tap()
            _ = newGame.waitForExistence(timeout: 8)
        }
        let notNow = app.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 4) { notNow.tap(); _ = notNow.waitForNonExistence(timeout: 5) }
        XCTAssertTrue(newGame.waitForExistence(timeout: 20), "not in the main room after registering")
        for _ in 0..<4 where !app.buttons["Add Bot"].exists {
            if notNow.exists { notNow.tap(); _ = notNow.waitForNonExistence(timeout: 5) }
            XCTAssertTrue(wait(15) { newGame.isEnabled && newGame.isHittable })
            newGame.tap()
            _ = app.buttons["Add Bot"].waitForExistence(timeout: 6)
        }

        // three bots, ready, the draw
        let addBot = app.buttons["Add Bot"]
        XCTAssertTrue(addBot.waitForExistence(timeout: 15), "no game lobby")
        for n in 1...3 {
            XCTAssertTrue(wait(10) { addBot.exists && addBot.isEnabled }, "Add Bot \(n)")
            addBot.tap()
            XCTAssertTrue(wait(10) { app.buttons.matching(identifier: "lobby.removeBot").count == n }, "bot \(n)")
        }
        app.buttons["Ready"].tap()
        XCTAssertTrue(wait(30) { app.buttons["leave"].exists }, "the game did not start")
        let deck = app.buttons["Draw a card"]
        XCTAssertTrue(deck.waitForExistence(timeout: 15), "no deck to draw from")
        XCTAssertTrue(wait(10) { deck.isHittable })
        deck.tap()

        // the auto-start: the welcome tip with Keep / Turn off, the chip
        let welcome = element(app, "tutorialWelcome")
        XCTAssertTrue(welcome.waitForExistence(timeout: 90), "no welcome tip in a new account's first game")
        XCTAssertEqual(app.staticTexts["tip.title"].label, "Tutorial on")
        XCTAssertTrue(app.buttons["tip.keep"].exists)
        XCTAssertTrue(app.buttons["tip.off"].exists)
        XCTAssertTrue(element(app, "tutorial.chip").waitForExistence(timeout: 10), "no Tutorial on chip")

        // my bid turn: the advice card comes without asking, a bid ringed
        let bidOverlay = element(app, "bidOverlay")
        XCTAssertTrue(bidOverlay.waitForExistence(timeout: 60), "my bid turn never came")
        let card = element(app, "assistCard")
        XCTAssertTrue(card.waitForExistence(timeout: 15), "no advice card on my bid turn")
        let headline = element(app, "assist.headline").label
        XCTAssertTrue(headline.hasPrefix("Bid "), headline)
        let ringed = bidOverlay.buttons.matching(NSPredicate(format: "value == %@", "Suggested")).firstMatch
        XCTAssertTrue(ringed.waitForExistence(timeout: 5), "no bid ringed")
        let footer = element(app, "assist.footer").label
        XCTAssertEqual(footer, "What our strongest bot would play", footer)
        sleep(1)
        shot("1-bid-welcome-advice")

        // Keep: the welcome goes, the chip stays
        app.buttons["tip.keep"].tap()
        XCTAssertTrue(wait(5) { !welcome.exists }, "Keep did not close the welcome")
        XCTAssertTrue(element(app, "tutorial.chip").exists, "the chip went with Keep")

        // the ringed bid, sent
        ringed.tap()
        bidOverlay.buttons["Submit"].tap()
        XCTAssertTrue(wait(10) { !bidOverlay.exists }, "the bid did not go through")

        // my play turn: its advice card, a hand card suggested, without asking
        let suggested = app.descendants(matching: .any).matching(NSPredicate(format: "label ENDSWITH %@", ", suggested")).firstMatch
        XCTAssertTrue(suggested.waitForExistence(timeout: 90), "no advice on my play turn")
        XCTAssertTrue(card.exists, "no advice card on my play turn")
        sleep(1)
        shot("2-play-advice")

        // nothing about free uses, limits or bot-assisted in the log of a bot game
        app.buttons["log"].tap()
        let auto = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "is playing with the tutorial")).firstMatch
        XCTAssertTrue(auto.waitForExistence(timeout: 5), "no '<name> is playing with the tutorial.' in the game log")
        let limitWords = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@ OR label CONTAINS[c] %@", "of 3 free", "bot-assisted", "unlimited"))
        XCTAssertEqual(limitWords.count, 0, limitWords.allElementsBoundByIndex.map(\.label).joined(separator: " | "))
        shot("3-log")
        app.terminate()
    }
}
