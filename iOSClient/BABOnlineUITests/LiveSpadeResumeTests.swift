import XCTest

/// Opt-in live check (the `LiveForegroundResumeTests` harness and environment, run on the iPhone
/// Duo open in landscape, where New Game is a vertical bar item) of the owner's report of
/// 2026-11-27 on the open iPhone Duo: "if I have the duo already open and haven't
/// opened the app in a while and I open the app after reconnecting the start game spade can
/// be greyed out". The app goes home, past the keep-alive, is suspended for longer than the
/// server's ping timeout (the server drops the socket meanwhile) and comes back; New Game (the
/// spade, a vertical bar item on the open Duo in landscape) must be enabled once the session
/// is back.
final class LiveSpadeResumeTests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

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
        a.name = "spade-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func note(_ text: String) {
        print("[spade-test] \(Date().timeIntervalSince1970) \(text)")
    }

    private func button(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func launchSignedIn(_ app: XCUIApplication) {
        app.launch()
        let newGame = button(app, "New Game")
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
        let toRegister = button(app, "Create Account")
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

    /// Away from the app. On the open Duo `XCUIDevice.press(.home)` left the scene active (no
    /// background notification at all, 2026-11-27), so another app is brought to the front
    /// (`BAB_SPADE_AWAY=home` keeps the home button).
    private func background() {
        if env["BAB_SPADE_AWAY"] == "home" {
            XCUIDevice.shared.press(.home)
        } else {
            XCUIApplication(bundleIdentifier: "com.apple.Preferences").activate()
        }
        Thread.sleep(forTimeInterval: 1)
        shot("away")
    }

    /// Home, past the keep-alive, suspended for `seconds`, resumed and back in front; then New
    /// Game must come on within 20 s.
    /// `thawAfter`: the server is frozen (nothing answers) from before the resume until that
    /// long after the foreground (a link that comes back slowly after a long sleep).
    private func roundTrip(_ app: XCUIApplication, suspended seconds: TimeInterval, tag: String,
                           thawAfter: TimeInterval? = nil) {
        let newGame = button(app, "New Game")
        note("\(tag) background")
        background()
        Thread.sleep(forTimeInterval: 8)
        harness("suspend-app")
        Thread.sleep(forTimeInterval: seconds)
        if thawAfter != nil { harness("freeze-server") }
        harness("resume-app")
        note("\(tag) foreground")
        app.activate()
        if let thawAfter {
            Thread.sleep(forTimeInterval: thawAfter)
            harness("thaw-server")
        }
        XCTAssertTrue(newGame.waitForExistence(timeout: 10), "\(tag): no New Game")
        let on = wait(20) { newGame.isEnabled }
        note("\(tag) New Game enabled: \(on)")
        shot(tag)
        XCTAssertTrue(on, "\(tag): New Game stays greyed out after the foreground")
    }

    /// The owner's path: suspended past the server's ping timeout (25 + 20 s).
    func testSpadeAfterALongSuspension() throws {
        let app = try liveApp()
        launchSignedIn(app)
        let rounds = Int(env["BAB_SPADE_ROUNDS"] ?? "") ?? 3
        for i in 1...rounds {
            roundTrip(app, suspended: 60, tag: "long-\(i)")
        }
        app.terminate()
    }

    /// Suspended under the ping timeout: the foreground probe keeps the connection.
    func testSpadeAfterAShortSuspension() throws {
        let app = try liveApp()
        launchSignedIn(app)
        let rounds = Int(env["BAB_SPADE_ROUNDS"] ?? "") ?? 3
        for i in 1...rounds {
            roundTrip(app, suspended: 15, tag: "short-\(i)")
        }
        app.terminate()
    }

    /// The server answers only some time after the foreground, around the probe's 1.5 s bound.
    func testSpadeWhenTheServerAnswersLate() throws {
        let app = try liveApp()
        launchSignedIn(app)
        let delays = (env["BAB_SPADE_THAW"] ?? "0.3,1.0,1.4,1.7,2.5,4").split(separator: ",").compactMap { Double($0) }
        for (i, d) in delays.enumerated() {
            roundTrip(app, suspended: Double(env["BAB_SPADE_SUSPEND"] ?? "") ?? 60, tag: "late-\(i + 1)-\(d)", thawAfter: d)
        }
        app.terminate()
    }

    /// A restore lost on its way (the harness started with `BAB_LIVE_DROP_RESTORES=2`: the
    /// library's reconnect's restore before the foreground and the foreground rebuild's are
    /// dropped unanswered): the connection is up, the toast gone, and New Game comes back once
    /// `SocketService.restoreAnswerWait` has rebuilt the connection. Before 2026-11-27 it stayed
    /// greyed out. Opt in with `TEST_RUNNER_BAB_SPADE_LOST=1`.
    func testSpadeAfterALostRestore() throws {
        guard env["BAB_SPADE_LOST"] == "1" else { throw XCTSkip("opt-in: TEST_RUNNER_BAB_SPADE_LOST=1 with BAB_LIVE_DROP_RESTORES=2 on the harness") }
        let app = try liveApp()
        launchSignedIn(app)
        roundTrip(app, suspended: 60, tag: "lost")
        app.terminate()
    }
}
