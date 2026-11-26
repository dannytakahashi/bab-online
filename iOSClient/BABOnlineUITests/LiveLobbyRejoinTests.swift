import XCTest

/// Opt-in live check against a local server (never production) of the lobby re-entry after
/// a restore (RestoreRoute.lobby, LobbyRejoinTests): the same host harness and environment
/// as LiveForegroundResumeTests (its header has the run command; use
/// `-only-testing:BABOnlineUITests/LiveLobbyRejoinTests`).
///
/// - `testLobbySeatSurvivesASlowWakeUp`: alone in a new lobby (a host-only lobby is the one
///   the server deletes when the seat expires), background, keep-alive over, the app
///   suspended for `suspendSeconds` (longer than the server's ping timeout, so the server
///   drops the socket and holds the seat for its 30 s grace), resumed: the app never shows
///   the main room, the lobby is back, and well past the grace an Add Bot still goes
///   through (the new socket holds the seat).
/// - `testLobbyLostInARestartGoesToTheMainRoom`: the server restarts (its lobbies are in
///   memory): the re-entry is refused, the main room and the restart alert.
final class LiveLobbyRejoinTests: XCTestCase {
    /// Past pingInterval + pingTimeout (25 s + 20 s) and inside the 30 s grace after it.
    static let suspendSeconds: TimeInterval = 52

    override func setUp() {
        continueAfterFailure = false
    }

    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func liveApp() throws -> XCUIApplication {
        guard let server = env["BAB_LIVE_SERVER"], env["BAB_LIVE_USER"] != nil, env["BAB_LIVE_PASS"] != nil,
              env["BAB_LIVE_CTL"] != nil,
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), TEST_RUNNER_BAB_LIVE_USER, TEST_RUNNER_BAB_LIVE_PASS, TEST_RUNNER_BAB_LIVE_CTL")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server, "-keepAliveLimit", "5"]
        return app
    }

    private func harness(_ name: String, timeout: TimeInterval = 30) {
        let fm = FileManager.default
        let dir = env["BAB_LIVE_CTL"]! as NSString
        let done = dir.appendingPathComponent(name + ".done")
        try? fm.removeItem(atPath: done)
        XCTAssertTrue(fm.createFile(atPath: dir.appendingPathComponent(name), contents: Data()), "cannot write to the CTL dir")
        XCTAssertTrue(wait(timeout) { fm.fileExists(atPath: done) }, "the harness did not do \(name)")
        note("harness: \(name) done")
    }

    private func wait(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return condition()
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "rejoin-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func note(_ text: String) {
        print("[rejoin-test] \(Date()) \(text)")
        let a = XCTAttachment(string: text)
        a.name = "note"
        a.lifetime = .keepAlways
        add(a)
    }

    private func button(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func screen(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    /// `players` seated in a lobby of up to 4, whatever the server: the empty seats ("Waiting
    /// for player...") are the rest (the header shows only "Ready n/4" since 2026-11-19).
    private func seated(_ app: XCUIApplication, _ players: Int) -> Bool {
        screen(app, "lobby.count").exists && emptySeats(app) == 4 - players
    }

    private func emptySeats(_ app: XCUIApplication) -> Int {
        app.staticTexts.matching(NSPredicate(format: "label == %@", "Waiting for player...")).count
    }

    private func countLabel(_ app: XCUIApplication) -> String {
        let count = screen(app, "lobby.count")
        return count.exists ? "\(count.label), \(emptySeats(app)) empty seats" : "no lobby.count"
    }

    /// Into the main room: the saved session restores, or sign in, or (first use) register.
    private func launchSignedIn(_ app: XCUIApplication) {
        app.launch()
        let newGame = app.buttons["New Game"]
        if newGame.waitForExistence(timeout: 15) {
            XCTAssertTrue(wait(20) { newGame.isEnabled }, "New Game stays disabled (session)")
            return
        }
        let user = env["BAB_LIVE_USER"]!, pass = env["BAB_LIVE_PASS"]!
        let signInName = app.textFields["Username"]
        XCTAssertTrue(signInName.waitForExistence(timeout: 30), "neither the main room nor the sign-in screen")
        signInName.tap(); signInName.typeText(user)
        app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
        button(app, "Sign In").tap()
        if newGame.waitForExistence(timeout: 10) {
            XCTAssertTrue(wait(15) { newGame.isEnabled }, "New Game stays disabled (session)")
            return
        }
        let toRegister = app.buttons.matching(NSPredicate(format: "label == %@", "Create Account")).firstMatch
        XCTAssertTrue(toRegister.waitForExistence(timeout: 10), "no Create Account on the sign-in screen")
        toRegister.tap()
        let name = app.textFields["Username"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap(); name.typeText(user)
        app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
        app.secureTextFields["Confirm Password"].tap(); app.secureTextFields["Confirm Password"].typeText(pass)
        for _ in 0..<3 where !newGame.exists {
            sleep(1)
            button(app, "Register").tap()
            _ = newGame.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(newGame.waitForExistence(timeout: 20), "not in the main room after registering")
        XCTAssertTrue(wait(15) { newGame.isEnabled }, "New Game stays disabled (session)")
    }

    /// New Game: alone in a new lobby.
    private func openLobby(_ app: XCUIApplication) {
        app.buttons["New Game"].tap()
        Fixture.chooseClassicGame()
        XCTAssertTrue(app.buttons["Add Bot"].waitForExistence(timeout: 10), "no game lobby")
        XCTAssertTrue(wait(5) { seated(app, 1) }, "not alone in the lobby: \(countLabel(app))")
        note("lobby open")
    }

    func testLobbySeatSurvivesASlowWakeUp() throws {
        let app = try liveApp()
        launchSignedIn(app)
        openLobby(app)
        shot("1-lobby")

        note("background")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 8)  // the keep-alive ends at 5 s
        harness("suspend-app")
        Thread.sleep(forTimeInterval: Self.suspendSeconds)
        harness("resume-app")
        note("foreground")
        app.activate()

        // never the main room on the way back
        var mainRoomSeen = false
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            if screen(app, "screen.mainRoom").exists { mainRoomSeen = true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        shot("1-after-foreground")
        XCTAssertFalse(mainRoomSeen, "the app went to the main room")
        XCTAssertTrue(screen(app, "screen.gameLobby").exists, "not on the lobby screen")
        let addBot = app.buttons["Add Bot"]
        XCTAssertTrue(wait(15) { addBot.exists && addBot.isEnabled }, "the lobby's actions never came back")
        XCTAssertTrue(seated(app, 1), "my seat is not in the lobby: \(countLabel(app))")

        // past the seat's 30 s grace: only a seat the new socket took back is still there
        note("waiting out the grace")
        Thread.sleep(forTimeInterval: 35)
        addBot.tap()
        XCTAssertTrue(wait(10) { seated(app, 2) }, "Add Bot did not go through: no seat: \(countLabel(app))")
        XCTAssertFalse(screen(app, "screen.mainRoom").exists)
        note("bot added after the grace")
        shot("1-bot-added")
        button(app, "Leave").tap()
        XCTAssertTrue(app.buttons["New Game"].waitForExistence(timeout: 10))
        app.terminate()
    }

    func testLobbyLostInARestartGoesToTheMainRoom() throws {
        let app = try liveApp()
        launchSignedIn(app)
        openLobby(app)

        harness("restart-request")
        let alert = app.alerts["Server restarted"]
        XCTAssertTrue(alert.waitForExistence(timeout: 30), "no restart alert")
        note("alert: \(alert.staticTexts.allElementsBoundByIndex.map(\.label))")
        XCTAssertTrue(alert.staticTexts["Your lobby closed because the server restarted for an update."].exists)
        shot("2-alert")
        alert.buttons["OK"].tap()
        let newGame = app.buttons["New Game"]
        XCTAssertTrue(wait(15) { newGame.exists && newGame.isEnabled }, "not in the main room with a session")
        XCTAssertFalse(app.buttons["Add Bot"].exists)
        app.terminate()
    }
}
