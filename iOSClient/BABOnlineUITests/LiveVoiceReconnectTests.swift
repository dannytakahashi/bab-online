import XCTest

/// Opt-in live check of voice across a server hand-off (owner 2026-11-27: after a deploy during a
/// game "the voices sounded strange, like there was maybe an echo"; docs/claude/voice.md "One
/// call per player after a reconnect") against a local server pair (never production): this app
/// makes a lobby, the web pages named in `TEST_RUNNER_BAB_LIVE_PEERS` join it, a page adds a bot,
/// everyone readies and the game starts; then the app holds the table while the host script
/// deploys a successor, drops the proxy's sockets and reloads a page, and reads the app's calls
/// from `-meshProbeFile` (`Debug/MeshProbe.swift`, a Debug build). A file `relaunch` in
/// `TEST_RUNNER_BAB_LIVE_CTL` terminates and launches the app again (answered `relaunch.done`),
/// `stop` ends the test. Environment: `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`,
/// `TEST_RUNNER_BAB_LIVE_USER=<new name>`, `TEST_RUNNER_BAB_LIVE_PASS=<random>` (the account is
/// created by the test; keep the password out of logs and the repo), `TEST_RUNNER_BAB_LIVE_PEERS`
/// (the pages' names, comma separated; else read from `pages.json` in the ctl dir, which the host
/// script writes) and `TEST_RUNNER_BAB_LIVE_CTL`. The host script is `scripts/voice-reconnect-live.mjs`
/// (`--run` = this ctl dir) on `scripts/persist-live-harness.sh`; mute the Mac first.
final class LiveVoiceReconnectTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "live-voice-reconnect-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    func testVoiceAcrossAServerHandOff() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              let ctl = env["BAB_LIVE_CTL"],
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), _USER, _PASS, _PEERS, _CTL")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server, "-meshProbeFile", (ctl as NSString).appendingPathComponent("ios-probe.json")]
        app.launch()

        // register (a fresh simulator has no saved session; a second run of this account restores it)
        let toRegister = app.buttons.matching(NSPredicate(format: "label == %@", "Create Account")).firstMatch
        let newGame = app.buttons["New Game"]
        XCTAssertTrue(toRegister.waitForExistence(timeout: 30) || newGame.exists, "no Create Account on the sign-in screen")
        if !newGame.exists {
            toRegister.tap()
            let name = app.textFields["Username"]
            XCTAssertTrue(name.waitForExistence(timeout: 10))
            name.tap(); name.typeText(user)
            fillPasswords(app, pass)
        }
        for _ in 0..<3 where !newGame.exists {
            sleep(1)
            app.buttons.matching(NSPredicate(format: "label == %@", "Register")).firstMatch.tap()
            _ = newGame.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(newGame.waitForExistence(timeout: 20), "not in the main room after registering")
        let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: newGame)
        wait(for: [enabled], timeout: 15)
        newGame.tap()
        Fixture.chooseClassicGame()
        XCTAssertTrue(app.buttons["Add Bot"].waitForExistence(timeout: 20), "no game lobby")
        try? "lobby".write(toFile: (ctl as NSString).appendingPathComponent("ios-lobby"), atomically: true, encoding: .utf8)

        // the pages join (one adds the bot), then I ready and the game starts
        let peers = try waitForPeers(env["BAB_LIVE_PEERS"], ctl: ctl)
        for peer in peers {
            XCTAssertTrue(app.staticTexts[peer].waitForExistence(timeout: 240), "\(peer) never joined the lobby")
        }
        shot("1-lobby")
        let ready = app.buttons["Ready"]
        XCTAssertTrue(ready.waitForExistence(timeout: 120), "no Ready")
        // the bot fills the fourth seat first (Ready with an empty seat waits anyway)
        sleep(3)
        ready.tap()
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 90), "the game did not start")
        try? "game".write(toFile: (ctl as NSString).appendingPathComponent("ios-game"), atomically: true, encoding: .utf8)
        shot("2-game")

        // hold the table until the host says stop; relaunch on request
        let fm = FileManager.default
        let relaunch = (ctl as NSString).appendingPathComponent("relaunch")
        let stop = (ctl as NSString).appendingPathComponent("stop")
        let deadline = Date().addingTimeInterval(1500)
        while Date() < deadline, !fm.fileExists(atPath: stop) {
            if fm.fileExists(atPath: relaunch) {
                try? fm.removeItem(atPath: relaunch)
                app.terminate()
                sleep(2)
                app.launch()
                // an unsigned Debug build keeps no Keychain session: sign in again, the restore
                // then rejoins the table
                let signIn = app.buttons.matching(NSPredicate(format: "label == %@", "Sign In")).firstMatch
                if signIn.waitForExistence(timeout: 20), !app.buttons["leave"].exists {
                    let name = app.textFields["Username"]
                    if name.waitForExistence(timeout: 5) { name.tap(); name.typeText(user) }
                    app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
                    for _ in 0..<3 where !app.buttons["leave"].exists {
                        sleep(1)
                        if signIn.exists { signIn.tap() }
                        _ = app.buttons["leave"].waitForExistence(timeout: 8)
                    }
                }
                XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 30), "not back at the table after the relaunch")
                try? "done".write(toFile: relaunch + ".done", atomically: true, encoding: .utf8)
            }
            sleep(1)
        }
        shot("3-end")
        app.terminate()
    }

    /// iOS AutoFill's "Use Strong Password?" sheet (a new-password field on a simulator that has
    /// not answered it yet) takes the keyboard after the first character typed, so the password
    /// lands short and Register stays off ("Passwords do not match"; 2026-11-28 runs: 1 of 20).
    /// Dismiss it and type both fields again until Register is on (as `LiveCutForABuckTests`).
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

    /// The pages' names: `TEST_RUNNER_BAB_LIVE_PEERS`, else the host script's `pages.json` in the ctl dir.
    private func waitForPeers(_ listed: String?, ctl: String) throws -> [String] {
        if let listed, !listed.isEmpty { return listed.split(separator: ",").map(String.init) }
        let file = (ctl as NSString).appendingPathComponent("pages.json")
        for _ in 0..<240 {
            if let data = FileManager.default.contents(atPath: file),
               let names = try? JSONSerialization.jsonObject(with: data) as? [String], !names.isEmpty { return names }
            sleep(1)
        }
        XCTFail("no peers listed in \(file)")
        return []
    }
}
