import XCTest

/// Opt-in live check against a local server (never production) of the foreground after
/// the keep-alive (SocketService.resumeAfterKeepAlive): background the app, let the
/// keep-alive end, suspend the app as iOS would, bring it back, and see what the player sees.
///
/// - `testKeptConnectionShowsNoReconnect`: the server untouched: no "Reconnecting..." toast,
///   New Game enabled throughout, and a New Game tapped at once opens a lobby.
/// - `testServerRestartedWhileBackgroundedRecovers`: the server restarted while the app was
///   suspended: the app reconnects and restores, as before.
/// - `testMidGameTableIsResyncedAfterForeground`: a solo game with three bots, backgrounded
///   while it is dealt and bid: the table after the foreground is the server's, and a bid
///   goes through.
///
/// A simulator's background task outlived 150 s under XCUITest and the app was never
/// suspended, so the app runs with `-keepAliveLimit 5` (DEBUG: the keep-alive ends after 5 s,
/// as its expiration would) and a host-side harness suspends it: in
/// `TEST_RUNNER_BAB_LIVE_CTL=<host dir>` the test creates `suspend-app` / `resume-app` (SIGSTOP /
/// SIGCONT of the app process, what iOS suspension does) and `restart-request` (restart the
/// server), and waits for `<name>.done`.
///
/// Run with a Debug build and `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`,
/// `TEST_RUNNER_BAB_LIVE_USER=<new name>`, `TEST_RUNNER_BAB_LIVE_PASS=<random>` (the account is
/// registered on first use; keep the password out of logs and the repo) and the CTL dir.
/// The server-side proof (no new handshake, the probe's requestSnapshot and its answer) is in
/// the server's own log.
final class LiveForegroundResumeTests: XCTestCase {
    /// Suspended for less than the server's ping timeout (20 s after an unanswered ping), so
    /// an untouched server still holds the connection.
    static let suspendSeconds: TimeInterval = 15

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

    /// Ask the host harness for `name` and wait until it is done.
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
        a.name = "resume-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func note(_ text: String) {
        let stamp = ISO8601DateFormatter.string(from: Date(), timeZone: TimeZone(identifier: "UTC")!,
                                                formatOptions: [.withFullTime, .withFractionalSeconds])
        print("[resume-test] \(stamp) \(text)")
        let a = XCTAttachment(string: "\(stamp) \(text)")
        a.name = "note"
        a.lifetime = .keepAlways
        add(a)
    }

    private func button(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// Launch into the main room: the saved session restores, or (a fresh simulator) register.
    private func launchSignedIn(_ app: XCUIApplication) {
        app.launch()
        let newGame = app.buttons["New Game"]
        if newGame.waitForExistence(timeout: 15) {
            XCTAssertTrue(wait(20) { newGame.isEnabled }, "New Game stays disabled (session)")
            return
        }
        let user = env["BAB_LIVE_USER"]!, pass = env["BAB_LIVE_PASS"]!
        // sign in (an unsigned test build keeps no keychain session between launches)
        let signInName = app.textFields["Username"]
        XCTAssertTrue(signInName.waitForExistence(timeout: 30), "neither the main room nor the sign-in screen")
        signInName.tap(); signInName.typeText(user)
        app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
        button(app, "Sign In").tap()
        // still seated from an earlier run: the sign-in rejoins that game; leave it
        if wait(10, { newGame.exists || app.buttons["leave"].exists }), app.buttons["leave"].exists { leaveGame(app) }
        if newGame.waitForExistence(timeout: 10) {
            XCTAssertTrue(wait(15) { newGame.isEnabled }, "New Game stays disabled (session)")
            return
        }
        // first use: register the account
        let toRegister = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Register")).firstMatch
        XCTAssertTrue(toRegister.waitForExistence(timeout: 10), "no Register link")
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

    /// Home; past the keep-alive (5 s); suspended for `suspendSeconds` (running
    /// `whileSuspended` first); resumed and back in front.
    private func backgroundPastKeepAlive(_ app: XCUIApplication, whileSuspended: () -> Void = {}) {
        note("background")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 8)  // the keep-alive ends at 5 s
        harness("suspend-app")
        let suspended = Date()
        whileSuspended()
        let left = Self.suspendSeconds - Date().timeIntervalSince(suspended)
        if left > 0 { Thread.sleep(forTimeInterval: left) }
        harness("resume-app")
        note("foreground")
        app.activate()
    }

    /// Samples the reconnect toast for `seconds`: did it ever show?
    private func toastShows(_ app: XCUIApplication, within seconds: TimeInterval, alsoCheck: () -> Void = {}) -> Bool {
        let toast = app.descendants(matching: .any)["connectionToast"]
        let deadline = Date().addingTimeInterval(seconds)
        var seen = false
        while Date() < deadline {
            if toast.exists { seen = true; note("toast: \(toast.label)") }
            alsoCheck()
            Thread.sleep(forTimeInterval: 0.25)
        }
        return seen
    }

    // MARK: - 1. untouched server: the connection is kept

    func testKeptConnectionShowsNoReconnect() throws {
        let app = try liveApp()
        launchSignedIn(app)
        let newGame = app.buttons["New Game"]
        shot("1-main-room")

        backgroundPastKeepAlive(app)

        XCTAssertTrue(newGame.waitForExistence(timeout: 5))
        var disabledSeen = false
        let toast = toastShows(app, within: 4) { if newGame.exists && !newGame.isEnabled { disabledSeen = true } }
        shot("1-after-foreground")
        XCTAssertFalse(toast, "a kept connection shows no Reconnecting toast")
        XCTAssertFalse(disabledSeen, "New Game never waits for a session")
        // responsive: a server action goes through at once
        note("tap New Game")
        newGame.tap()
        XCTAssertTrue(app.buttons["Add Bot"].waitForExistence(timeout: 5), "no game lobby")
        note("lobby open")
        shot("1-lobby")
        app.terminate()
    }

    // MARK: - 2. server restarted while backgrounded: recovers as before

    func testServerRestartedWhileBackgroundedRecovers() throws {
        let app = try liveApp()
        launchSignedIn(app)
        let newGame = app.buttons["New Game"]

        backgroundPastKeepAlive(app) { harness("restart-request") }

        let toast = toastShows(app, within: 2)
        shot("2-after-foreground")
        XCTAssertTrue(wait(20) { newGame.exists && newGame.isEnabled }, "not back in the main room with a session")
        note("session back; toast seen: \(toast)")
        newGame.tap()
        XCTAssertTrue(app.buttons["Add Bot"].waitForExistence(timeout: 10), "no game lobby after the restart")
        shot("2-lobby")
        app.terminate()
    }

    // MARK: - 2b. the probe goes unanswered: rebuilt after the bound, recovers

    /// The server process frozen across the foreground (`freeze-server`: SIGSTOP, its
    /// connections stay open and nothing answers, as on a link that died silently): the probe
    /// times out, a new connection is built, and once the server answers again the session
    /// is restored.
    func testUnansweredProbeRebuildsAndRecovers() throws {
        let app = try liveApp()
        launchSignedIn(app)
        let newGame = app.buttons["New Game"]

        note("background")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 8)  // the keep-alive ends at 5 s
        harness("freeze-server")
        note("foreground")
        app.activate()
        let toast = toastShows(app, within: 4)
        shot("2b-frozen")
        harness("thaw-server")
        XCTAssertTrue(toast, "the rebuild shows Reconnecting, as before")
        XCTAssertTrue(wait(20) { newGame.exists && newGame.isEnabled }, "no session after the server answers again")
        note("session back")
        newGame.tap()
        XCTAssertTrue(app.buttons["Add Bot"].waitForExistence(timeout: 10), "no game lobby after the rebuild")
        shot("2b-lobby")
        app.terminate()
    }

    // MARK: - 3. mid-game: the table after the foreground

    /// The hand as the table's cards read ("Queen of Clubs", "High Joker"...), in tree order,
    /// from one snapshot of the tree (walking live elements fails while cards animate).
    private func handLabels(_ app: XCUIApplication) -> [String] {
        guard let root = try? app.snapshot() else { return [] }
        var labels: [String] = []
        func walk(_ s: XCUIElementSnapshot) {
            let l = s.label
            let card = l.range(of: #"^(Ace|King|Queen|Jack|[0-9]+) of (Spades|Hearts|Diamonds|Clubs)$"#,
                               options: .regularExpression) != nil || l.hasSuffix("Joker")
            if card { labels.append(l) }  // bidding: no trick on the table, so every card is my hand
            s.children.forEach(walk)
        }
        walk(root)
        return labels
    }

    /// Leave the table (Exit Game), so the account is in no game for the next test.
    private func leaveGame(_ app: XCUIApplication) {
        let leave = app.buttons["leave"]
        guard leave.waitForExistence(timeout: 5) else { return }
        leave.tap()
        let exit = app.alerts.buttons["Exit Game"]
        if exit.waitForExistence(timeout: 5) { exit.tap() }
        _ = app.buttons["New Game"].waitForExistence(timeout: 15)
    }

    func testMidGameTableIsResyncedAfterForeground() throws {
        let app = try liveApp()
        launchSignedIn(app)
        app.buttons["New Game"].tap()
        let addBot = app.buttons["Add Bot"]
        XCTAssertTrue(addBot.waitForExistence(timeout: 15), "no game lobby")
        for n in 1...3 {
            XCTAssertTrue(wait(10) { addBot.exists && addBot.isEnabled }, "Add Bot \(n)")
            addBot.tap()
            XCTAssertTrue(wait(10) { app.buttons.matching(identifier: "lobby.removeBot").count == n }, "bot \(n)")
        }
        app.buttons["Ready"].tap()
        XCTAssertTrue(wait(30) { app.buttons["leave"].exists }, "the game did not start")
        // draw for deal: draw at once if offered (else the server's watchdog draws)
        let slot = app.descendants(matching: .any)["draw.slot.0"]
        if slot.waitForExistence(timeout: 10) { slot.tap() }
        note("drew; hand so far \(handLabels(app).count)")
        shot("3-before")

        // away while the deal and the bots' bids happen (queued for the suspended app)
        backgroundPastKeepAlive(app)

        let bidOverlay = app.descendants(matching: .any)["bidOverlay"]
        let toast = toastShows(app, within: 3)
        XCTAssertTrue(bidOverlay.waitForExistence(timeout: 30), "my bid turn never came after the foreground")
        sleep(1)
        let after = handLabels(app)
        note("after foreground: bidOverlay=\(bidOverlay.exists) hand \(after.count): \(after.joined(separator: ", "))")
        shot("3-after")
        XCTAssertFalse(toast, "no Reconnecting toast at the table")
        XCTAssertFalse(after.isEmpty)

        // responsive: bid 0, the panel goes
        let zero = bidOverlay.buttons.matching(NSPredicate(format: "label == %@", "0")).firstMatch
        XCTAssertTrue(zero.waitForExistence(timeout: 5))
        zero.tap()
        bidOverlay.buttons["Submit"].tap()
        note("bid sent")
        XCTAssertTrue(wait(10) { !bidOverlay.exists }, "the bid did not go through")
        shot("3-bid")
        leaveGame(app)
        app.terminate()
    }
}
