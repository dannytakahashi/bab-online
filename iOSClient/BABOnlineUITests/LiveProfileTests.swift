import XCTest

/// Opt-in live check of the profile wire against a local server (never production): register
/// a throwaway account with a space typed after the password (sent trimmed, as the web sends
/// it), open the Account sheet (getProfile), choose a stock avatar (updateProfilePic), upload
/// a photo (uploadProfilePic: the server's image pipeline takes the PNG this build makes), then
/// open another player's profile from their chat line (getPlayerProfile) and block / unblock
/// them. Run with a Debug build and `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`,
/// `TEST_RUNNER_BAB_LIVE_USER=<new name>`, `TEST_RUNNER_BAB_LIVE_PASS=<random>` and
/// `TEST_RUNNER_BAB_LIVE_PEER=<a signed-in player who keeps chatting in the main room>`
/// (keep the password out of logs and the repo). `TEST_RUNNER_BAB_SHOTS=<folder>` saves PNGs.
final class LiveProfileTests: XCTestCase {
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
        let screenshot = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: screenshot)
        a.name = "live-\(name)"
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("live-\(name).png"))
        }
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func stat(_ app: XCUIApplication, _ id: String) -> String {
        let e = element(app, "profile.stat.\(id)")
        return e.exists ? (e.value as? String ?? "<nil>") : "<none>"
    }

    func testProfileWire() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              let peer = env["BAB_LIVE_PEER"],
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), _USER, _PASS, _PEER")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server, "-uiPickPhoto", "YES"]
        app.launch()

        // register, with a space after each password: it is not part of the password sent
        let toRegister = app.buttons.matching(NSPredicate(format: "label == %@", "Create Account")).firstMatch
        XCTAssertTrue(toRegister.waitForExistence(timeout: 30), "no Create Account on the sign-in screen")
        toRegister.tap()
        let name = app.textFields["Username"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap(); name.typeText(user)
        app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass + " ")
        app.secureTextFields["Confirm Password"].tap(); app.secureTextFields["Confirm Password"].typeText(pass + " ")
        let newGame = app.buttons["New Game"]
        for _ in 0..<3 where !newGame.exists {
            sleep(1)
            app.buttons.matching(NSPredicate(format: "label == %@", "Register")).firstMatch.tap()
            _ = newGame.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(newGame.waitForExistence(timeout: 20), "not in the main room after registering")

        // my own profile: the server's reply for a new account
        app.buttons.matching(NSPredicate(format: "label == %@", "Account settings")).firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 5))
        XCTAssertTrue(wait(10) { self.stat(app, "gamesPlayed") == "0" }, "getProfile answered: \(stat(app, "gamesPlayed"))")
        XCTAssertEqual(stat(app, "winRate"), "0%")
        XCTAssertTrue(element(app, "profile.hero").label.contains(user))
        sleep(2)  // the sign-up's random stock picture loads over HTTP
        shot("1-own-profile")
        app.segmentedControls["profile.scope"].buttons["Bot games"].tap()
        XCTAssertTrue(element(app, "profile.botsEmpty").waitForExistence(timeout: 10), "getProfile {scope: bots} answered")
        app.segmentedControls["profile.scope"].buttons["Human games"].tap()

        // Choose Avatar
        element(app, "profile.chooseAvatar").tap()
        let pick = element(app, "avatarPicker.33")
        XCTAssertTrue(app.navigationBars["Select Profile Picture"].waitForExistence(timeout: 5))
        for _ in 0..<8 where !(pick.exists && pick.isHittable) { app.swipeUp(velocity: .slow) }
        for _ in 0..<8 where !(pick.exists && pick.isHittable) { app.swipeDown(velocity: .slow) }
        sleep(2)
        shot("2-avatar-picker")
        pick.tap()
        let notice = element(app, "profile.pictureNotice")
        XCTAssertTrue(wait(10) { notice.exists && notice.label == "Profile picture updated!" }, "profilePicUpdateResponse")
        sleep(2)
        shot("3-avatar-updated")

        // Upload Photo (the sample photo, through the same crop and encoding as a picked one)
        element(app, "profile.uploadPhoto").tap()
        XCTAssertTrue(wait(15) { notice.exists && notice.label == "Profile picture uploaded!" },
                      "profilePicUploadResponse: \(notice.exists ? notice.label : "-")")
        shot("4-photo-uploaded")
        app.buttons["Done"].firstMatch.tap()

        // the peer's chat line -> View Profile
        let line = app.staticTexts.matching(NSPredicate(format: "label == %@", peer)).firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 30), "no chat line from \(peer)")
        line.press(forDuration: 1.2)
        let view = app.buttons["View Profile"].firstMatch
        XCTAssertTrue(view.waitForExistence(timeout: 5))
        view.tap()
        XCTAssertTrue(element(app, "profile.name").waitForExistence(timeout: 5))
        XCTAssertTrue(wait(10) { self.stat(app, "gamesPlayed") == "0" }, "getPlayerProfile answered")
        XCTAssertEqual(element(app, "profile.name").label, peer)
        sleep(2)
        shot("5-player-profile")

        // Block (confirmed), then Unblock: the server's block list drives the button
        let block = element(app, "profile.block")
        block.tap()
        XCTAssertTrue(app.alerts["Block \(peer)?"].waitForExistence(timeout: 5))
        app.alerts["Block \(peer)?"].buttons["Block"].tap()
        XCTAssertTrue(app.alerts["Safety"].staticTexts["Block list updated."].waitForExistence(timeout: 10), "blockListUpdated")
        app.alerts["Safety"].buttons["OK"].tap()
        XCTAssertTrue(wait(5) { block.label == "Unblock" })
        shot("6-blocked")
        block.tap()
        XCTAssertTrue(app.alerts["Safety"].waitForExistence(timeout: 10))
        app.alerts["Safety"].buttons["OK"].tap()
        XCTAssertTrue(wait(5) { block.label == "Block" })
        element(app, "profile.close").tap()

        // my new picture is the one the Stats and profile caches load next (a new version's URL)
        app.buttons.matching(NSPredicate(format: "label == %@", "Account settings")).firstMatch.tap()
        XCTAssertTrue(wait(10) { self.stat(app, "gamesPlayed") == "0" })
        sleep(3)
        shot("7-own-profile-reopened")
        app.terminate()
    }
}
