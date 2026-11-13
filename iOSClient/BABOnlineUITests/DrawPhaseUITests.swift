import XCTest

/// The draw for deal (DrawPhaseView) in its fixture states (UIFixture.drawStates
/// plus the contract's draw-in-progress): before anyone draws, 2 of 4 drawn, all
/// drawn, the teams, all drawn with two long names, and 2 of 4 seen by a spectator. Screenshots are kept attachments named
/// `draw-<device>-<state>[-landscape]` (export with iOSClient/scripts/ios-screenshots.sh);
/// the layout itself is checked through the view's "draw.layoutCheck" probe.
final class DrawPhaseUITests: XCTestCase {
    static let states = ["draw-start", "draw-in-progress", "draw-all", "draw-teams", "draw-long", "draw-spectator"]
    /// The largest Dynamic Type size (the view caps what it uses itself).
    static let ax5 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    private var device: String {
        (ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "device")
            .replacingOccurrences(of: " ", with: "_")
    }

    /// Launches `state`, waits for it to settle (the flips end 1.4 s after the last
    /// card; the teams fade in 0.8 + 0.5 s after the event, which the fixture sends
    /// 3 s in and keeps up: UIFixture.holdsTeams).
    private func open(_ state: String, extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(state, extra: extra)
        XCTAssertTrue(app.staticTexts["Draw for Deal"].waitForExistence(timeout: 20), "\(state) did not come up")
        if state == "draw-teams" {
            XCTAssertTrue(app.staticTexts["Team 1"].waitForExistence(timeout: 8), "no teams")
            sleep(1)
        } else {
            sleep(2)
        }
        return app
    }

    private func shoot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "draw-\(device)-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    func testScreenshots() {
        for state in Self.states {
            let app = open(state)
            shoot(state)
            if UIDevice.current.userInterfaceIdiom == .pad {
                XCUIDevice.shared.orientation = .landscapeLeft
                sleep(2)
                shoot("\(state)-landscape")
                XCUIDevice.shared.orientation = .portrait
            }
            app.terminate()
        }
    }

    /// Every state at the default and at the largest Dynamic Type size: each name
    /// sits at least Theme.Space.s3 above its card and nothing leaves the screen
    /// or overlaps (DrawPhaseView's DEBUG layout check, see DrawLayoutProbe).
    func testLayoutAtEveryTextSize() {
        for extra in [[], Self.ax5] {
            for state in Self.states {
                let app = open(state, extra: extra)
                XCTAssertEqual(Fixture.probe(app, "draw.layoutCheck"), "ok", "\(state) \(extra)")
                if extra.isEmpty == false { shoot("\(state)-ax5") }
                app.terminate()
            }
        }
    }

    /// VoiceOver reads each drawn card with its player, and the deck as a button.
    func testAccessibilityLabels() {
        var app = open("draw-start")
        XCTAssertTrue(app.buttons["Draw a card"].exists, "the deck is a labeled button")
        app.terminate()
        app = open("draw-all")
        let fay = app.descendants(matching: .any)["draw.slot.0"]
        XCTAssertTrue(fay.waitForExistence(timeout: 5))
        XCTAssertEqual(fay.label, "fay, you")
        XCTAssertEqual(fay.value as? String, "Jack of Clubs")
        let gus = app.descendants(matching: .any)["draw.slot.3"]
        XCTAssertEqual(gus.label, "gus")
        XCTAssertEqual(gus.value as? String, "High Joker")
        app.terminate()
        app = open("draw-in-progress")
        let waiting = app.descendants(matching: .any)["draw.slot.3"]
        XCTAssertTrue(waiting.waitForExistence(timeout: 5))
        XCTAssertEqual(waiting.label, "Waiting for a player to draw")
        app.terminate()
        app = open("draw-spectator")
        XCTAssertTrue(app.descendants(matching: .any)["draw.slot.0"].waitForExistence(timeout: 5), "a spectator sees the draws")
        XCTAssertFalse(app.buttons["Draw a card"].exists, "a spectator has no deck to draw from")
        XCTAssertEqual(app.descendants(matching: .any)["draw.slot.0"].label, "fay", "nobody's slot is the spectator's")
        app.terminate()
    }
}
