import XCTest

/// Opt-in live check of Cut for a buck (iOS 1.2.7 (41)) against a local server (never production):
/// this app registers and joins a 1-round tournament that a scripted member created
/// (`TEST_RUNNER_BAB_LIVE_HOST`: the host's username; a second scripted member joins too, both
/// with the web's caps, ready, /lazy at the table and draw in the cut), readies, draws for first
/// deal, goes /lazy (the bots play), and at the score screen sees the cut's strip and taps "Join
/// cut for a buck". In the cut it taps the deck whenever its draw is open, until the winner; a
/// player knocked out keeps watching the next rounds (the round line moves on). Then the final
/// lobby with the cut's winner. Environment as `LiveTournamentPairingsTests`:
/// `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`, `TEST_RUNNER_BAB_LIVE_USER=<new name>`,
/// `TEST_RUNNER_BAB_LIVE_PASS=<random>`, `TEST_RUNNER_BAB_LIVE_HOST=<the host's name>`. Screenshots
/// are kept attachments `live-cut-*`.
final class LiveCutForABuckTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "live-cut-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    /// iOS AutoFill's "Use Strong Password?" sheet (a new-password field on a simulator that has
    /// not answered it yet) takes the keyboard after the first character typed, so the password
    /// lands short and Register stays off ("Passwords do not match"). Dismiss it and type both
    /// fields again until Register is on.
    private func fillPasswords(_ app: XCUIApplication, _ pass: String) {
        let register = app.buttons.matching(NSPredicate(format: "label == %@", "Register")).firstMatch
        let clear = String(repeating: XCUIKeyboardKey.delete.rawValue, count: pass.count + 8)
        for attempt in 0..<4 {
            if attempt > 0 && register.exists && register.isEnabled { return }
            for id in ["Password", "Confirm Password"] {
                let field = app.secureTextFields[id]
                field.tap()
                dismissAutoFill(app, wait: 1.5)
                if attempt > 0 { field.tap(); field.typeText(clear) }
                field.typeText(pass)
            }
            dismissAutoFill(app)
            sleep(1)
        }
    }

    private func dismissAutoFill(_ app: XCUIApplication, wait: TimeInterval = 0) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let labels = ["Close", "Not Now", "Choose My Own Password", "Don\u{2019}t Use"]
        let deadline = Date().addingTimeInterval(wait)
        repeat {
            for root in [app, springboard] {
                for label in labels {
                    let b = root.buttons[label]
                    if b.exists && b.isHittable { b.tap(); return }
                }
            }
            if Date() < deadline { usleep(200_000) }
        } while Date() < deadline
    }

    private func wait(_ seconds: TimeInterval, _ check: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if check() { return true }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return check()
    }

    func testACutFromTheScoreScreenToTheFinalLobby() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              let host = env["BAB_LIVE_HOST"],
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), _USER, _PASS, _HOST")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server]
        app.launch()

        let toRegister = app.buttons.matching(NSPredicate(format: "label == %@", "Create Account")).firstMatch
        XCTAssertTrue(toRegister.waitForExistence(timeout: 30), "no Create Account on the sign-in screen")
        toRegister.tap()
        let name = app.textFields["Username"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap(); name.typeText(user)
        fillPasswords(app, pass)
        let tournament = app.buttons["Tournament"]
        for _ in 0..<3 where !tournament.exists {
            sleep(1)
            app.buttons.matching(NSPredicate(format: "label == %@", "Register")).firstMatch.tap()
            _ = tournament.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(tournament.waitForExistence(timeout: 20), "not in the main room after registering")

        // the host's tournament in the main room: Join
        let join = app.buttons.matching(NSPredicate(format: "label == %@", "Join")).firstMatch
        XCTAssertTrue(join.waitForExistence(timeout: 120), "\(host)'s tournament never listed")
        XCTAssertTrue(wait(15) { join.isEnabled })
        join.tap()
        let lobby = any(app, "screen.tournamentLobby")
        XCTAssertTrue(lobby.waitForExistence(timeout: 20), "no tournament lobby")
        app.buttons["Ready"].tap()

        // the table: draw for first deal, then /lazy (the bots play)
        let deck = app.buttons["Draw a card"]
        XCTAssertTrue(deck.waitForExistence(timeout: 60), "no draw at the table")
        sleep(1)
        deck.tap()
        let log = app.buttons["log"]
        XCTAssertTrue(log.waitForExistence(timeout: 60), "no table")
        let field = app.textFields["Chat..."]
        XCTAssertTrue(wait(30) {
            if !field.exists, log.exists, log.isHittable { log.tap() }
            return field.exists
        }, "no game log chat")
        field.tap()
        field.typeText("/lazy\n")
        sleep(1)
        if app.buttons["Close game log"].exists { app.buttons["Close game log"].tap() }

        // the score screen: the cut's strip and "Join cut for a buck"
        XCTAssertTrue(any(app, "gameEnd").waitForExistence(timeout: 20 * 60), "the game never ended")
        let strip = any(app, "gameEnd.cutStrip")
        XCTAssertTrue(strip.waitForExistence(timeout: 30), "no cut strip on the score screen")
        print("[live] strip: \(strip.label)")
        shot("1-score-strip")
        let joinCut = app.buttons["Join cut for a buck"]
        XCTAssertTrue(joinCut.waitForExistence(timeout: 10))
        // the gather's seconds left when I join: the intro plays from more than 3
        let gatherLeft = strip.label.components(separatedBy: "starts in ").last.flatMap { Int($0.prefix { $0.isNumber }) }
        joinCut.tap()

        // the cut: tap the deck whenever my draw is open
        let status = any(app, "cut.status")
        XCTAssertTrue(status.waitForExistence(timeout: 30), "no cut screen")
        shot("2-cut")
        // the intro ran its whole 2.6 s (the DEBUG probe cut.introCheck: "playing", then
        // "ran <s>"; a stage view rebuilt as the screen came up used to end it at once)
        if let left = gatherLeft, left > 4 {
            let probe = any(app, "cut.introCheck")
            var ran = ""
            let until = Date().addingTimeInterval(6)
            while Date() < until {
                ran = probe.exists ? ((probe.value as? String) ?? "") : ""
                if ran.hasPrefix("ran ") { break }
                usleep(200_000)
            }
            print("[live] intro: \(ran) (joined with \(left) s of gather left)")
            XCTAssertGreaterThanOrEqual(Double(ran.dropFirst(4)) ?? 0, 2.5, "the intro was cut short: \(ran)")
        }
        var tapped = Set<String>()
        var outAt: String?
        var roundsSeenOut = Set<String>()
        var verdicts: [String] = []
        let winner = any(app, "cut.winner")
        let final = any(app, "results.cut")
        let end = Date().addingTimeInterval(15 * 60)
        while Date() < end && !winner.exists && !final.exists {
            let st = status.exists ? status.label : ""
            let round = any(app, "cut.round").exists ? any(app, "cut.round").label : ""
            if st == "Tap the deck to draw", !tapped.contains(round), any(app, "cut.deck").exists {
                any(app, "cut.deck").tap()
                tapped.insert(round)
                print("[live] drew in \(round)")
                if tapped.count == 1 { Thread.sleep(forTimeInterval: 0.6); shot("3-my-draw") }
            }
            if st.hasPrefix("You're safe") || st.hasPrefix("You're out") || st.hasPrefix("Everyone tied") || st.hasSuffix("are out with") || st.contains(" is out with") {
                if verdicts.last != "\(round): \(st)" {
                    verdicts.append("\(round): \(st)")
                    print("[live] verdict \(round): \(st)")
                    if verdicts.count == 1 { shot("4-verdict") }
                }
                if st.hasPrefix("You're out") && outAt == nil { outAt = round; shot("5-out") }
            }
            if st == "You're out. Watching the rest" {
                roundsSeenOut.insert(round)
                if roundsSeenOut.count == 1 { shot("6-out-watching") }
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
        XCTAssertTrue(winner.exists || final.exists, "no winner in 15 minutes")
        if winner.exists {
            print("[live] winner: \(winner.label)")
            shot("7-winner")
        }
        XCTAssertFalse(tapped.isEmpty, "I never drew")
        if let outAt { print("[live] out at \(outAt); later rounds watched: \(roundsSeenOut.sorted())") }

        // the final lobby
        XCTAssertTrue(final.waitForExistence(timeout: 30), "no final lobby with the cut's winner")
        print("[live] final: \(app.staticTexts["results.winner"].label) / \(final.label)")
        XCTAssertTrue(final.label.hasSuffix("won cut for a buck"), final.label)
        sleep(1)
        shot("8-final-lobby")
    }
}
