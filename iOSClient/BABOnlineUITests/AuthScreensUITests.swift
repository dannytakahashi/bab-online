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
        let logo = app.images["auth.logo"]
        XCTAssertTrue(logo.exists, "the logo")
        XCTAssertEqual(logo.label, "BAB Online")
        let name = app.textFields["Username"], pass = app.secureTextFields["Password"]
        XCTAssertTrue(name.exists)
        XCTAssertTrue(pass.exists)
        // VoiceOver names each field (the identifier alone would let the queries above pass)
        XCTAssertEqual(name.label, "Username")
        XCTAssertEqual(pass.label, "Password")
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

        // iOS AutoFill: leaving a filled password field asks "Save Password?" over the next
        // screen, and a new-password field's "Use Strong Password?" sheet covers the bottom of
        // the screen (fresh iPhone simulators, review 2026-11-17), so the password is cleared
        // before leaving and the register's Back is tried before any password is typed there
        pass.tap()
        pass.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8))
        dismissAutoFill(app)

        let create = button(app, "Create Account")
        reveal(app, create)
        create.tap()
        dismissAutoFill(app)
        XCTAssertTrue(element(app, "screen.register").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Create Account"].exists, "the card's title")
        XCTAssertTrue(app.textFields["Username"].exists)
        XCTAssertTrue(app.secureTextFields["Password"].exists)
        XCTAssertTrue(app.secureTextFields["Confirm Password"].exists)
        XCTAssertEqual(app.textFields["Username"].label, "Username")
        XCTAssertEqual(app.secureTextFields["Password"].label, "Password")
        XCTAssertEqual(app.secureTextFields["Confirm Password"].label, "Confirm Password")
        XCTAssertFalse(button(app, "Register").isEnabled)
        shot("register")
        let back = button(app, "Back to Sign In")
        reveal(app, back)
        back.tap()
        dismissAutoFill(app)
        XCTAssertTrue(element(app, "screen.signIn").waitForExistence(timeout: 5))

        // the password rule, last (its field brings up the strong-password sheet)
        let again = button(app, "Create Account")
        reveal(app, again)
        again.tap()
        XCTAssertTrue(element(app, "screen.register").waitForExistence(timeout: 5))
        let reg = app.secureTextFields["Password"]
        reg.tap()
        dismissAutoFill(app)
        reg.typeText("short")
        XCTAssertTrue(element(app, "register.passwordRule").waitForExistence(timeout: 3))
    }

    /// Closes the system's AutoFill prompts when they show ("Save Password?" -> Not Now, the
    /// strong-password suggestion -> its own-password choice); does nothing otherwise.
    private func dismissAutoFill(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let labels = ["Not Now", "Choose My Own Password", "Don’t Use"]
        for root in [app, springboard] {
            for label in labels {
                let b = root.buttons[label]
                if b.exists && b.isHittable { b.tap(); return }
            }
        }
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
        // the sign-in is laid out under the splash but hidden: its fields get their names
        // (and identifiers) only at the hand-off
        XCTAssertTrue(app.textFields["Username"].waitForExistence(timeout: 10), "the splash handed off")
        XCTAssertTrue(button(app, "Sign In").exists)
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element(app, "splash"))
        wait(for: [gone], timeout: 3)
        app.terminate()

        let held = Fixture.launch("sign-in", extra: ["-uiSplashFrame", "0.6"])
        let splash = element(held, "splash")
        XCTAssertTrue(splash.waitForExistence(timeout: 10))
        XCTAssertEqual(splash.label, "BAB Online")
        sleep(2)
        XCTAssertFalse(held.textFields["Username"].exists, "a held frame never hands off")
        XCTAssertFalse(button(held, "Sign In").exists, "nothing under the splash is named")
        XCTAssertFalse(button(held, "Create Account").exists)
    }

    /// The splash's last frame puts its logo exactly where the sign-in's logo stands (so the
    /// hand-off cross-fades one logo, not two), full motion and Reduce Motion; on the iPad in
    /// landscape too.
    func testSplashLogoIsTheSignInsLogo() {
        let pad = UIDevice.current.userInterfaceIdiom == .pad
        for orientation in pad ? [UIDeviceOrientation.portrait, .landscapeLeft] : [.portrait] {
            XCUIDevice.shared.orientation = orientation
            checkSplashLogo(landscape: orientation.isLandscape)
        }
    }

    private func checkSplashLogo(landscape: Bool) {
        let signIn = Fixture.launch("sign-in", extra: ["-uiPhrase", "13"])
        XCTAssertTrue(element(signIn, "screen.signIn").waitForExistence(timeout: 20))
        let logo = signIn.images["auth.logo"]
        XCTAssertTrue(logo.waitForExistence(timeout: 5))
        sleep(1)
        let target = logo.frame
        signIn.terminate()
        for (t, extra) in [(1.32, []), (0.9, ["-uiReduceMotion", "YES"])] as [(Double, [String])] {
            let held = Fixture.launch("sign-in", extra: ["-uiPhrase", "13", "-uiSplashFrame", "\(t)"] + extra)
            XCTAssertTrue(element(held, "splash").waitForExistence(timeout: 10))
            sleep(1)
            if landscape && extra.isEmpty { shot("splash-final-landscape") }
            // the sign-in under the splash is hidden: nothing there has a name
            XCTAssertFalse(held.textFields["Username"].exists, "the sign-in is hidden under the splash")
            XCTAssertFalse(held.secureTextFields["Password"].exists)
            let parts = Fixture.probe(held, "splash.logo").split(separator: " ").compactMap { Double($0) }
            XCTAssertEqual(parts.count, 4, "splash.logo probe")
            guard parts.count == 4 else { return }
            let f = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
            for (a, b, what) in [(f.minX, target.minX, "x"), (f.minY, target.minY, "y"),
                                 (f.width, target.width, "width"), (f.height, target.height, "height")] {
                XCTAssertEqual(a, b, accuracy: 1, "splash logo \(what) at \(t) s: \(f) vs the sign-in's \(target)")
            }
            held.terminate()
        }
    }

    /// The splash's frames (held by `-uiSplashFrame`), full motion and Reduce Motion.
    func testSplashFrames() {
        for (tag, t, extra) in [("0.00", 0.0, []), ("0.15", 0.15, []), ("0.30", 0.3, []), ("0.45", 0.45, []),
                                ("0.60", 0.6, []), ("0.80", 0.8, []), ("1.10", 1.1, []), ("1.20", 1.2, []),
                                ("final", 1.32, []),
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
