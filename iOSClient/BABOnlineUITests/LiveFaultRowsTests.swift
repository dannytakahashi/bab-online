import XCTest

/// Opt-in live check of the red fault rows against a local server (never production): sign in
/// to a prepared account, a game with three bots, one /help on my bid turn, then `/lazy` until a
/// hand ends with a set team and its fault line shows red; `/active`, and once the game waits on
/// my play turn a forced reconnect (the server closes the transport when the file
/// `$BAB_LIVE_CTL/drop` appears: a notes-only preload) and then a relaunch (a rejoin): the
/// fault rows ("table.logFaults", `-uiLogProbe YES`) are the same, once each, and the chat list
/// counts the /help from the snapshot's viewer.assist. Env (TEST_RUNNER_ prefixed):
/// BAB_LIVE_SERVER (a localhost origin), BAB_LIVE_USER, BAB_LIVE_PASS (an existing account; keep
/// the password out of logs and the repo), BAB_LIVE_CTL (the folder the server watches),
/// BAB_SHOTS (optional PNG folder).
final class LiveFaultRowsTests: XCTestCase {
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
        let png = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: png)
        a.name = "live-faults-\(name)"
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("live-faults-\(name).png"))
        }
    }

    private func faults(_ app: XCUIApplication) -> String {
        let e = app.descendants(matching: .any)["table.logFaults"]
        return e.exists ? (e.value as? String ?? "") : "<no probe>"
    }

    private func count(_ app: XCUIApplication) -> Int {
        Int(faults(app).split(separator: ":").first ?? "") ?? -1
    }

    private func openLog(_ app: XCUIApplication) -> XCUIElement {
        let field = app.textFields["Chat..."]
        if !field.exists { app.buttons["log"].tap() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        return field
    }

    private func closeLog(_ app: XCUIApplication) {
        let close = app.buttons["Close game log"]
        if close.exists { close.tap() }
    }

    private func send(_ app: XCUIApplication, _ line: String) {
        let field = openLog(app)
        field.tap()
        field.typeText(line + "\n")
        Thread.sleep(forTimeInterval: 1)
    }

    func testAFaultRowIsRedLiveAndOnceAfterAReconnect() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              let ctl = env["BAB_LIVE_CTL"], !ctl.isEmpty,
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (localhost), _USER, _PASS (an existing account), _CTL")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server, "-uiLogProbe", "YES"]
        app.launch()

        // sign in (the Keychain may restore the session and skip this)
        let newGame = app.buttons["New Game"], name = app.textFields["Username"]
        XCTAssertTrue(wait(30) { name.exists || newGame.exists || app.buttons["Add Bot"].exists || app.buttons["leave"].exists })
        if name.exists {
            name.tap()
            if let old = name.value as? String, !old.isEmpty, old != "Username" {
                name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
            }
            name.typeText(user)
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
            app.buttons.matching(NSPredicate(format: "label == %@", "Sign In")).firstMatch.tap()
        }
        // iOS's "Save Password?" after a sign-in (it can come a few seconds late): not now
        let notNow = app.buttons.matching(NSPredicate(format: "label == %@", "Not Now")).firstMatch
        let dismissSave = { if notNow.exists { notNow.tap(); _ = notNow.waitForNonExistence(timeout: 5) } }
        if notNow.waitForExistence(timeout: 6) { dismissSave() }
        let addBot = app.buttons["Add Bot"]
        if !addBot.exists && !app.buttons["leave"].exists {
            XCTAssertTrue(newGame.waitForExistence(timeout: 20), "not in the main room")
            // a tap under the Save Password sheet misses (hit point -1, -1): dismiss it, again
            for _ in 0..<4 where !addBot.exists {
                dismissSave()
                XCTAssertTrue(wait(15) { newGame.isEnabled && newGame.isHittable })
                newGame.tap()
                _ = addBot.waitForExistence(timeout: 6)
            }
        }
        if !app.buttons["leave"].exists {
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
        }

        // one /help on my bid turn (the count a rejoin must keep)
        let ask = app.buttons["assist.ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 60), "my bid turn never came")
        ask.tap()
        XCTAssertTrue(app.descendants(matching: .any)["assistCard"].waitForExistence(timeout: 10), "no /help card")
        XCTAssertEqual(count(app), 0, faults(app))

        // a bot plays my seat until a hand ends with a set team
        send(app, "/lazy")
        XCTAssertTrue(wait(600) { count(app) > 0 }, "no fault line in 10 minutes: \(faults(app))")
        let firstRow = app.staticTexts.matching(identifier: "logFaultRow").firstMatch
        XCTAssertTrue(firstRow.waitForExistence(timeout: 5), "the fault row is not on screen")
        XCTAssertTrue(firstRow.label.hasPrefix("Fault: "), firstRow.label)
        shot("1-red-row")

        // back at my seat; wait until the game waits on my play turn (nothing more can be logged)
        send(app, "/active")
        closeLog(app)
        let bidOverlay = app.descendants(matching: .any)["bidOverlay"]
        XCTAssertTrue(wait(240) { ask.exists && !bidOverlay.exists }, "my play turn never came")
        Thread.sleep(forTimeInterval: 2)
        let before = faults(app)
        XCTAssertGreaterThan(count(app), 0)

        // the forced reconnect: the server closes the transport, the app reconnects and restores
        let drop = URL(fileURLWithPath: ctl).appendingPathComponent("drop")
        XCTAssertTrue(FileManager.default.createFile(atPath: drop.path, contents: Data()))
        XCTAssertTrue(wait(10) { !FileManager.default.fileExists(atPath: drop.path) }, "the server did not take the drop")
        Thread.sleep(forTimeInterval: 8)
        XCTAssertTrue(app.buttons["leave"].exists, "not at the table after the reconnect")
        XCTAssertEqual(faults(app), before, "the reconnect's snapshot replays the same fault rows, once each")
        _ = openLog(app)
        shot("2-after-reconnect")

        // a relaunch (a rejoin from nothing): the same rows, and the /help count from the snapshot
        app.terminate()
        app.launch()
        XCTAssertTrue(wait(45) { app.buttons["leave"].exists }, "the relaunch did not rejoin the table")
        XCTAssertTrue(wait(10) { faults(app) == before }, "after the relaunch: \(faults(app)) vs \(before)")
        let field = openLog(app)
        field.tap()
        field.typeText("/h")
        XCTAssertTrue(app.staticTexts["Suggest a move (1 of 3 free used)"].waitForExistence(timeout: 5),
                      "the chat list's count after a rejoin (snapshot viewer.assist)")
        shot("3-after-relaunch")
        let a = XCTAttachment(string: "fault rows: \(before)")
        a.lifetime = .keepAlways
        add(a)
        app.terminate()
    }
}
