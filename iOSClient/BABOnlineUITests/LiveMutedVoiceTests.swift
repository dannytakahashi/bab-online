import XCTest

/// Opt-in live check of the muted voice start against a local server (never production) and a
/// second person in the lobby (a web tab): joining voice must not ask for the microphone, and
/// the first unmute asks then (owner 2026-11-18). Run with a Debug build on a simulator whose
/// microphone permission for the app is reset (`xcrun simctl privacy <udid> reset microphone
/// com.bab-online.BABOnline`), and `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`,
/// `TEST_RUNNER_BAB_LIVE_USER=<new name>`, `TEST_RUNNER_BAB_LIVE_PASS=<random>` (the account
/// is created by the test; keep the password out of logs and the repo) and
/// `TEST_RUNNER_BAB_LIVE_PEER=<the other person's name>`, who joins this account's lobby
/// within 4 minutes. The test then holds the unmuted call 60 s and the muted one 30 s so the
/// other side can be inspected. `TEST_RUNNER_BAB_LIVE_GRANTED=1`: the microphone was allowed
/// before (a later session), so no prompt is expected at the unmute either;
/// `TEST_RUNNER_BAB_LIVE_HOLD=<s>` holds the muted call that long before the unmute (10 s).
final class LiveMutedVoiceTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "live-voice-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    /// The system's microphone alert (springboard), if one is up.
    private var micAlert: XCUIElement {
        springboard.alerts.matching(NSPredicate(format: "label CONTAINS[c] 'microphone'")).firstMatch
    }

    func testJoiningVoiceAsksNothingAndTheFirstUnmuteAsks() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              let peer = env["BAB_LIVE_PEER"],
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), _USER, _PASS, _PEER")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server]
        app.launch()

        // register (a fresh simulator has no saved session)
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
        XCTAssertTrue(newGame.waitForExistence(timeout: 20), "not in the main room after registering")
        let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: newGame)
        wait(for: [enabled], timeout: 15)
        newGame.tap()

        // the lobby: voice is on and muted, and nothing asked for the microphone
        let mic = app.buttons["Unmute microphone"]
        XCTAssertTrue(mic.waitForExistence(timeout: 20), "the header's mic, muted")
        XCTAssertFalse(micAlert.exists, "joining voice asked for the microphone")
        shot("1-lobby-muted")

        // the other person joins; their call comes up (their row in the voice panel)
        XCTAssertTrue(app.staticTexts[peer].waitForExistence(timeout: 240), "\(peer) never joined the lobby")
        mic.press(forDuration: 1.0)
        let bar = app.navigationBars["Voice Chat"]
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        XCTAssertTrue(app.sliders["voice.volume.\(peer)"].waitForExistence(timeout: 30), "no call with \(peer)")
        let granted = env["BAB_LIVE_GRANTED"] == "1"
        sleep(UInt32(env["BAB_LIVE_HOLD"].flatMap(UInt32.init) ?? 10))  // the call plays out by now
        XCTAssertFalse(micAlert.exists, "a call that plays out asked for the microphone")
        XCTAssertFalse(app.alerts.firstMatch.exists)
        shot("2-panel-call-muted")
        bar.buttons["Done"].tap()
        XCTAssertTrue(bar.waitForNonExistence(timeout: 5))

        // the first unmute asks; allowed, the mic is live
        app.buttons["Unmute microphone"].tap()
        if granted {
            XCTAssertFalse(micAlert.waitForExistence(timeout: 3), "allowed before: no prompt")
        } else {
            XCTAssertTrue(micAlert.waitForExistence(timeout: 10), "the first unmute did not ask for the microphone")
            shot("3-mic-prompt")
            let allow = micAlert.buttons.matching(NSPredicate(format: "label IN {'Allow', 'OK'}")).firstMatch
            XCTAssertTrue(allow.exists, micAlert.debugDescription)
            allow.tap()
        }
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 10), "unmuted after allowing")
        shot("4-unmuted")
        sleep(60)  // the other side sees audio arrive on the same call

        app.buttons["Mute microphone"].tap()
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 5))
        XCTAssertFalse(micAlert.exists, "asked only once")
        sleep(30)  // and stop again
        shot("5-muted-again")
        app.buttons["Unmute microphone"].tap()
        XCTAssertFalse(micAlert.waitForExistence(timeout: 3), "a second unmute asks nothing")
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 5))
        app.terminate()
    }
}
