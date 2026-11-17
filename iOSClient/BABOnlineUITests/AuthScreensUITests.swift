import XCTest

/// Build 13: the boot splash and the web-styled sign-in / register (fixture mode: no socket).
/// `TEST_RUNNER_BAB_SHOTS=<folder>` also saves each screenshot there as a PNG named
/// `<device>-<name>.png` (the device is `TEST_RUNNER_BAB_DEVICE`, else "device").
final class AuthScreensUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func button(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: screenshot)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        let env = ProcessInfo.processInfo.environment
        if let dir = env["BAB_SHOTS"] {
            let device = env["BAB_DEVICE"] ?? "device"
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(device)-\(name).png"))
        }
    }

    /// Scrolls the auth page until `e` is hittable (short screens, large type).
    private func reveal(_ app: XCUIApplication, _ e: XCUIElement) {
        for _ in 0..<6 where !e.isHittable { app.swipeUp() }
    }

    /// The sign-in has the web's parts, the fields the live tests find by name, and its
    /// buttons go where they did.
    func testSignInAndRegister() {
        let app = Fixture.launch("sign-in", extra: ["-uiPhrase", "13"])
        XCTAssertTrue(element(app, "screen.signIn").waitForExistence(timeout: 20))
        XCTAssertFalse(element(app, "splash").exists, "fixture mode skips the splash")
        XCTAssertTrue(app.images["BAB Online"].exists, "the logo")
        let name = app.textFields["Username"], pass = app.secureTextFields["Password"]
        XCTAssertTrue(name.exists)
        XCTAssertTrue(pass.exists)
        XCTAssertEqual(name.value as? String, "ivy", "the saved username is pre-filled")
        XCTAssertTrue(app.staticTexts["New user?"].exists)
        let signIn = button(app, "Sign In")
        XCTAssertTrue(signIn.exists)
        XCTAssertFalse(signIn.isEnabled, "no password yet")
        XCTAssertGreaterThanOrEqual(signIn.frame.height, 44)
        XCTAssertFalse(app.staticTexts["Connecting to server..."].exists)
        shot("signin")
        pass.tap()
        pass.typeText("12345678")
        XCTAssertTrue(signIn.isEnabled)
        // the keyboard's return goes from Username to Password
        name.tap()
        app.keyboards.buttons.matching(NSPredicate(format: "label ==[c] %@", "next")).firstMatch.tap()
        XCTAssertTrue((pass.value(forKey: "hasKeyboardFocus") as? Bool) ?? false, "Next moves to Password")

        let create = button(app, "Create Account")
        reveal(app, create)
        create.tap()
        XCTAssertTrue(element(app, "screen.register").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Create Account"].exists, "the card's title")
        XCTAssertTrue(app.textFields["Username"].exists)
        XCTAssertTrue(app.secureTextFields["Password"].exists)
        XCTAssertTrue(app.secureTextFields["Confirm Password"].exists)
        XCTAssertFalse(button(app, "Register").isEnabled)
        shot("register")
        let reg = app.secureTextFields["Password"]
        reg.tap()
        reg.typeText("short")
        XCTAssertTrue(element(app, "register.passwordRule").waitForExistence(timeout: 3))
        let back = button(app, "Back to Sign In")
        reveal(app, back)
        back.tap()
        XCTAssertTrue(element(app, "screen.signIn").waitForExistence(timeout: 5))
    }

    /// Not connected: both forms say so and keep their buttons off.
    func testConnecting() {
        let app = Fixture.launch("sign-in", extra: ["-uiOffline", "YES"])
        XCTAssertTrue(element(app, "screen.signIn").waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Connecting to server..."].exists)
        let pass = app.secureTextFields["Password"]
        pass.tap()
        pass.typeText("12345678")
        XCTAssertFalse(button(app, "Sign In").isEnabled)
        app.terminate()
        let reg = Fixture.launch("register", extra: ["-uiOffline", "YES"])
        XCTAssertTrue(element(reg, "screen.register").waitForExistence(timeout: 20))
        XCTAssertTrue(reg.staticTexts["Connecting to server..."].exists)
    }

    /// The largest text size: every field and button can be reached and keeps a 44 pt target.
    func testLargestTextSize() {
        for fixture in ["sign-in", "register"] {
            let app = Fixture.launch(fixture, extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
                                                      "-uiPhrase", "14"])
            let screen = fixture == "sign-in" ? "screen.signIn" : "screen.register"
            XCTAssertTrue(element(app, screen).waitForExistence(timeout: 20))
            shot("\(fixture)-ax5")
            let labels = fixture == "sign-in" ? ["Sign In", "Create Account"] : ["Register", "Back to Sign In"]
            for field in [app.textFields["Username"], app.secureTextFields["Password"]] {
                reveal(app, field)
                XCTAssertTrue(field.isHittable)
            }
            for label in labels {
                let b = button(app, label)
                reveal(app, b)
                XCTAssertTrue(b.isHittable, "\(fixture): \(label)")
                XCTAssertGreaterThanOrEqual(b.frame.height, 44)
            }
            app.terminate()
        }
    }

    /// Landscape (short heights): the form scrolls to every control.
    func testLandscape() {
        let app = Fixture.launch("sign-in", extra: ["-uiPhrase", "14"])
        XCTAssertTrue(element(app, "screen.signIn").waitForExistence(timeout: 20))
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        shot("signin-landscape")
        let create = button(app, "Create Account")
        reveal(app, create)
        XCTAssertTrue(create.isHittable)
        create.tap()
        XCTAssertTrue(element(app, "screen.register").waitForExistence(timeout: 5))
        sleep(1)
        shot("register-landscape")
        let back = button(app, "Back to Sign In")
        reveal(app, back)
        XCTAssertTrue(back.isHittable)
    }

    /// A real launch's splash ends by itself on the sign-in, and VoiceOver can read it.
    func testSplashHandsOff() {
        let app = Fixture.launch("sign-in", extra: ["-uiSplash", "YES"])
        let signIn = element(app, "screen.signIn")
        XCTAssertTrue(signIn.waitForExistence(timeout: 10), "the splash handed off")
        XCTAssertTrue(app.textFields["Username"].waitForExistence(timeout: 2))
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element(app, "splash"))
        wait(for: [gone], timeout: 3)
        app.terminate()

        let held = Fixture.launch("sign-in", extra: ["-uiSplashFrame", "0.6"])
        let splash = element(held, "splash")
        XCTAssertTrue(splash.waitForExistence(timeout: 10))
        XCTAssertEqual(splash.label, "BAB Online")
        sleep(2)
        XCTAssertFalse(element(held, "screen.signIn").exists, "a held frame never hands off")
    }

    /// The splash's frames (held by `-uiSplashFrame`), full motion and Reduce Motion.
    func testSplashFrames() {
        for (tag, t, extra) in [("0.00", 0.0, []), ("0.15", 0.15, []), ("0.30", 0.3, []), ("0.45", 0.45, []),
                                ("0.60", 0.6, []), ("0.80", 0.8, []), ("final", 1.25, []),
                                ("reduced-0.15", 0.15, ["-uiReduceMotion", "YES"]), ("reduced-final", 0.9, ["-uiReduceMotion", "YES"])]
                as [(String, Double, [String])] {
            let app = Fixture.launch("sign-in", extra: ["-uiSplashFrame", "\(t)"] + extra)
            XCTAssertTrue(element(app, "splash").waitForExistence(timeout: 10), tag)
            sleep(1)
            shot("splash-\(tag)")
            app.terminate()
        }
    }
}
