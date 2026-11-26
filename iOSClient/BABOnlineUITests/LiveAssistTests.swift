import XCTest

/// Opt-in live check of /help against a local server (never production): register a throwaway
/// account, a game with three bots, draw, then on my bid turn the lightbulb asks and the card
/// shows with a bid ringed ("Suggested"); after my bid, on my play turn, the lightbulb asks and
/// a hand card reads "<card>, suggested". Run with a Debug build and
/// `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`, `TEST_RUNNER_BAB_LIVE_USER=<new name>`
/// and `TEST_RUNNER_BAB_LIVE_PASS=<random>` (the account is created by the test; keep the
/// password out of logs and the repo; `TEST_RUNNER_BAB_LIVE_EXISTING=YES`: the account exists,
/// sign in). `TEST_RUNNER_BAB_SHOTS=<folder>` saves PNGs.
final class LiveAssistTests: XCTestCase {
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
        a.name = "live-assist-\(name)"
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("live-assist-\(name).png"))
        }
    }

    func testHelpOnABidTurnAndAPlayTurn() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), TEST_RUNNER_BAB_LIVE_USER, TEST_RUNNER_BAB_LIVE_PASS")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server]
        app.launch()

        let newGame = app.buttons["New Game"]
        if env["BAB_LIVE_EXISTING"] == "YES" {
            // an account made beforehand on the local server (a simulator whose new-password
            // fields drop typed characters: Password AutoFill's strong-password sheet)
            let name = app.textFields["Username"]
            // the Keychain outlives a reinstall on the simulator: a restored session skips this
            XCTAssertTrue(wait(30) { name.exists || newGame.exists || app.buttons["Add Bot"].exists })
        }
        if env["BAB_LIVE_EXISTING"] == "YES", app.textFields["Username"].exists {
            let name = app.textFields["Username"]
            name.tap()
            if let old = name.value as? String, !old.isEmpty, old != "Username" {
                name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
            }
            name.typeText(user)
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
            app.buttons.matching(NSPredicate(format: "label == %@", "Sign In")).firstMatch.tap()
        } else if env["BAB_LIVE_EXISTING"] != "YES" {
            // register (a fresh account)
            let toRegister = app.buttons.matching(NSPredicate(format: "label == %@", "Create Account")).firstMatch
            XCTAssertTrue(toRegister.waitForExistence(timeout: 30), "no Create Account on the sign-in screen")
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
        }
        // iOS's "Save Password?" over the main room after a sign-in: not now
        let notNow = app.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 4) { notNow.tap(); _ = notNow.waitForNonExistence(timeout: 5) }
        if !app.buttons["Add Bot"].exists {  // (a lobby left by an earlier run is reused)
            XCTAssertTrue(newGame.waitForExistence(timeout: 20), "not in the main room after registering")
            // a tap under a late "Save Password?" sheet misses: dismiss it and tap again
            for _ in 0..<4 where !app.buttons["Add Bot"].exists {
                if notNow.exists { notNow.tap(); _ = notNow.waitForNonExistence(timeout: 5) }
                XCTAssertTrue(wait(15) { newGame.isEnabled && newGame.isHittable })
                newGame.tap()
                Fixture.chooseClassicGame()
                _ = app.buttons["Add Bot"].waitForExistence(timeout: 6)
            }
        }

        // three bots, ready, the draw
        let addBot = app.buttons["Add Bot"]
        XCTAssertTrue(addBot.waitForExistence(timeout: 15), "no game lobby")
        for n in stride(from: app.buttons.matching(identifier: "lobby.removeBot").count + 1, through: 3, by: 1) {
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

        // my bid turn: the lightbulb on the bid panel; /help -> the card and a ringed bid
        let bidOverlay = app.descendants(matching: .any)["bidOverlay"]
        XCTAssertTrue(bidOverlay.waitForExistence(timeout: 60), "my bid turn never came")
        let ask = app.buttons["assist.ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 10), "no lightbulb on my bid turn")
        shot("1-bid-turn")
        ask.tap()
        let card = app.descendants(matching: .any)["assistCard"]
        XCTAssertTrue(card.waitForExistence(timeout: 10), "no /help card on my bid turn")
        let headline = app.descendants(matching: .any)["assist.headline"].label
        XCTAssertTrue(headline.hasPrefix("Bid "), headline)
        let ringed = bidOverlay.buttons.matching(NSPredicate(format: "value == %@", "Suggested")).firstMatch
        XCTAssertTrue(ringed.waitForExistence(timeout: 5), "no bid ringed")
        XCTAssertTrue(headline.hasSuffix(" \(ringed.label)") || headline.contains(ringed.label), "\(headline) vs ringed \(ringed.label)")
        let footer = app.descendants(matching: .any)["assist.footer"].label
        // a game with a native bot seat (3 lobby bots here): no count or limit words (owner 2026-11-19)
        XCTAssertEqual(footer, "What our strongest bot would play", footer)
        sleep(1)
        shot("2-bid-card")
        // the ringed bid, sent: the card goes
        ringed.tap()
        bidOverlay.buttons["Submit"].tap()
        XCTAssertTrue(wait(10) { !bidOverlay.exists }, "the bid did not go through")
        XCTAssertTrue(wait(5) { !card.exists }, "my own bid ends the card")

        // my play turn: the lightbulb by my hand; /help -> the card and a ringed hand card
        XCTAssertTrue(ask.waitForExistence(timeout: 90), "no lightbulb on my play turn")
        shot("3-play-turn")
        ask.tap()
        XCTAssertTrue(card.waitForExistence(timeout: 10), "no /help card on my play turn")
        let suggested = app.descendants(matching: .any).matching(NSPredicate(format: "label ENDSWITH %@", ", suggested")).firstMatch
        XCTAssertTrue(suggested.waitForExistence(timeout: 5), "no hand card reads as suggested")
        let playHeadline = app.descendants(matching: .any)["assist.headline"].label
        XCTAssertFalse(playHeadline.isEmpty)
        let playFooter = app.descendants(matching: .any)["assist.footer"].label
        XCTAssertEqual(playFooter, "What our strongest bot would play", playFooter)
        sleep(1)
        shot("4-play-card")
        // the room's notice of a counted use reads in the log ("<name> used /help.")
        app.buttons["log"].tap()
        let notice = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "used /help")).firstMatch
        XCTAssertTrue(notice.waitForExistence(timeout: 5), "no '<name> used /help.' in the game log")
        let mine = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Help: ")).firstMatch
        XCTAssertTrue(mine.exists, "no private 'Help: ... (only you see this)' row")
        // nothing about free uses, limits or bot-assisted anywhere in the log of a bot game
        let limitWords = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@ OR label CONTAINS[c] %@", "of 3 free", "bot-assisted", "unlimited"))
        XCTAssertEqual(limitWords.count, 0, limitWords.allElementsBoundByIndex.map(\.label).joined(separator: " | "))
        shot("5-log")
        let a = XCTAttachment(string: "bid: \(headline) / \(footer)\nplay: \(playHeadline) / \(playFooter) ringed \(suggested.label)")
        a.lifetime = .keepAlways
        add(a)
        app.terminate()
    }
}
