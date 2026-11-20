import XCTest

/// The tutorial on iOS (State/Table/Tutorial.swift), in fixture mode: `-uiTutorial YES` turns it
/// on as an auto-start does and pushes this turn's welcome tip, rule tip and advice as the server
/// does (UIFixture+Tutorial). The welcome with Keep / Turn off, the rule tip in its neutral card,
/// the advice in the /help card with its ring and no count, the "Tutorial on" chip and its off
/// switch, /tutorial in the chat list, and what the column keeps clear of (my bid clock, my
/// seat's row, the lightbulb, the fold: probes "table.assist" and "table.tutorial").
/// `TEST_RUNNER_BAB_SHOTS=<folder>` saves PNGs.
final class TutorialUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let png = app.screenshot()
        let a = XCTAttachment(screenshot: png)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("tutorial-\(name).png"))
        }
    }

    private func launch(_ fixture: String, _ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: ["-uiTutorial", "YES", "-uiAssist", "YES"] + extra)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        return app
    }

    private func waitFor(_ app: XCUIApplication, _ probe: String, contains text: String, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Fixture.probe(app, probe).contains(text) { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    /// The chip's frame from the probe "table.tutorial", once it clears what it keeps clear of.
    @discardableResult
    private func chipClear(_ app: XCUIApplication, _ tag: String) -> CGRect {
        XCTAssertTrue(element(app, "tutorial.chip").waitForExistence(timeout: 5), tag)
        XCTAssertTrue(waitFor(app, "table.tutorial", contains: "clear=ok"),
                      "\(tag): \(Fixture.probe(app, "table.tutorial")) keeps \(Fixture.probe(app, "table.assist")) [\(Fixture.probe(app, "ui.pose"))]")
        let probe = Fixture.probe(app, "table.tutorial")
        print("[TutorialUITests] \(tag) \(probe) | \(Fixture.probe(app, "table.assist")) [\(Fixture.probe(app, "ui.pose"))]")
        let parts = probe.components(separatedBy: "chip=").last?.split(separator: " ").prefix(4).compactMap { Double($0) } ?? []
        guard parts.count == 4 else { XCTFail(probe); return .null }
        return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
    }

    func testTheWelcomeThenTheRuleTipWithTheAdviceOnMyBidTurn() {
        let app = launch("bidding-mid")
        let welcome = element(app, "tutorialWelcome")
        XCTAssertTrue(welcome.waitForExistence(timeout: 5))
        XCTAssertEqual(welcome.staticTexts["tip.title"].label, "Tutorial on")
        XCTAssertTrue(welcome.staticTexts["tip.text"].label.hasPrefix("Tips will appear above your cards. Only you see them."))
        XCTAssertTrue(app.buttons["tip.keep"].exists)
        XCTAssertTrue(app.buttons["tip.off"].exists)
        // the rule tip under the welcome (each tip comes once a game: never hidden behind it)
        let tip = element(app, "tutorialTip")
        XCTAssertTrue(tip.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(tip.frame.minY, welcome.frame.maxY - 1, "tip \(tip.frame) welcome \(welcome.frame)")
        // the advice: the /help card, never counted
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "assist.headline").label, "Bid 2")
        XCTAssertEqual(element(app, "assist.footer").label, "What our strongest bot would play")
        XCTAssertTrue(waitFor(app, "table.assist", contains: "bid=2"), Fixture.probe(app, "table.assist"))
        XCTAssertEqual(element(app, "bidOverlay").buttons["2"].value as? String, "Suggested")
        // the chip, with its switch on
        let chip = app.switches["tutorial.chip"]
        XCTAssertTrue(chip.waitForExistence(timeout: 5), "a switch to VoiceOver")
        XCTAssertEqual(chip.label, "Tutorial")
        XCTAssertEqual(chip.value as? String, "On")
        chipClear(app, "bid welcome")
        XCTAssertTrue(waitFor(app, "table.assist", contains: "clear=ok"), Fixture.probe(app, "table.assist"))
        // the column stays above the bid panel and below Exit and the log's button
        let panel = element(app, "bidOverlay").frame
        XCTAssertLessThanOrEqual(chip.frame.maxY, panel.minY + 1, "chip \(chip.frame) panel \(panel)")
        XCTAssertGreaterThanOrEqual(welcome.frame.minY, app.buttons["leave"].frame.maxY, "welcome \(welcome.frame)")
        XCTAssertTrue(app.buttons["leave"].isHittable)
        shot(app, "welcome")
        // Keep: /tutorial keep, and the rule tip stays
        app.buttons["tip.keep"].tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial keep"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(welcome.waitForNonExistence(timeout: 3))
        XCTAssertTrue(tip.waitForExistence(timeout: 3))
        XCTAssertEqual(tip.staticTexts["tip.title"].label, "Bidding")
        XCTAssertTrue(tip.staticTexts["tip.text"].label.hasPrefix("Bid how many tricks you expect to win."))
        XCTAssertFalse(app.buttons["tip.keep"].exists, "a rule tip has no buttons but its close")
        chipClear(app, "bid rule tip")
        shot(app, "rule-tip")
        // its close: the tip goes, the tutorial stays on
        app.buttons["tip.close"].tap()
        XCTAssertTrue(tip.waitForNonExistence(timeout: 3))
        XCTAssertTrue(chip.exists)
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("/tutorial off"))
    }

    func testOnMyPlayTurnTheAdviceRingsTheCardAndTheChipTurnsItOff() {
        let app = launch("trick-mid-lead3", ["-uiTutorialWelcome", "NO"])
        let tip = element(app, "tutorialTip")
        XCTAssertTrue(tip.waitForExistence(timeout: 5))
        XCTAssertEqual(tip.staticTexts["tip.title"].label, "Following suit")
        XCTAssertEqual(tip.staticTexts["tip.text"].label, "Clubs were led: you must play a club if you have one.")
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "assist.headline").label, "Play 10 of Clubs")
        XCTAssertEqual(element(app, "assist.footer").label, "What our strongest bot would play")
        XCTAssertTrue(waitFor(app, "table.assist", contains: "card=10_clubs"), Fixture.probe(app, "table.assist"))
        XCTAssertTrue(waitFor(app, "table.assist", contains: "clear=ok"), Fixture.probe(app, "table.assist"))
        chipClear(app, "play advice")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        shot(app, "advice")
        // the advice closed: the lightbulb is back, and the tip and the chip keep above it
        app.buttons["assist.close"].tap()
        let ask = app.buttons["assist.ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 3))
        let chip = chipClear(app, "play lightbulb")
        XCTAssertTrue(Fixture.probe(app, "table.assist").contains("ask"), Fixture.probe(app, "table.assist"))
        XCTAssertFalse(chip.intersects(ask.frame), "chip \(chip) lightbulb \(ask.frame)")
        XCTAssertFalse(tip.frame.intersects(ask.frame), "tip \(tip.frame) lightbulb \(ask.frame)")
        XCTAssertTrue(ask.isHittable)
        shot(app, "chip")
        // the chip's switch: /tutorial off, and the server's answer ends the tutorial
        element(app, "tutorial.chip").tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial off"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(element(app, "tutorial.chip").waitForNonExistence(timeout: 3))
        XCTAssertTrue(tip.waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Tips off. /help still works any time."].waitForExistence(timeout: 3))
        shot(app, "off")
    }

    func testTurnOffOnTheWelcome() {
        let app = launch("bidding-mid")
        XCTAssertTrue(app.buttons["tip.off"].waitForExistence(timeout: 5))
        app.buttons["tip.off"].tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial off"), Fixture.probe(app, "fixture.sent"))
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("/tutorial keep"))
        XCTAssertTrue(element(app, "tutorialWelcome").waitForNonExistence(timeout: 3))
        XCTAssertTrue(element(app, "tutorial.chip").waitForNonExistence(timeout: 3))
        XCTAssertFalse(element(app, "tutorialTip").exists, "off: the waiting tip goes too")
        XCTAssertTrue(app.staticTexts["Tips off. /help still works any time."].waitForExistence(timeout: 3))
    }

    func testTheWelcomesCloseSendsItsOwnLine() {
        let app = launch("bidding-mid")
        let welcome = element(app, "tutorialWelcome")
        XCTAssertTrue(welcome.waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "tutorialTip").waitForExistence(timeout: 5))
        welcome.buttons["tip.close"].tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial close"), Fixture.probe(app, "fixture.sent"))
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("/tutorial keep"), "× is not Keep")
        XCTAssertTrue(welcome.waitForNonExistence(timeout: 3))
        XCTAssertTrue(element(app, "tutorialTip").exists, "the rule tip stays")
        XCTAssertTrue(element(app, "tutorial.chip").exists, "the tutorial stays on")
    }

    func testTheChatListOffersTheTutorial() {
        let app = launch("trick-mid-lead3", ["-uiTutorialWelcome", "NO"])
        XCTAssertTrue(element(app, "tutorial.chip").waitForExistence(timeout: 5))
        let field = app.textFields["Chat..."]
        if !field.exists { app.buttons["log"].tap() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("/t")
        XCTAssertTrue(app.staticTexts["Turn off the tutorial"].waitForExistence(timeout: 5))
        shot(app, "chat-on")
        field.typeText("utorial off\n")
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial off"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(element(app, "tutorial.chip").waitForNonExistence(timeout: 3))
        // the tip's row stays in the log (dim, private)
        XCTAssertTrue(app.staticTexts["Tip: Clubs were led: you must play a club if you have one."].exists)
        field.tap()
        field.typeText("/t")
        XCTAssertTrue(app.staticTexts["Tutorial: tips and advice every turn"].waitForExistence(timeout: 5))
    }

    /// On my timed bid turn (and in a tabletop pose) the column ends above the countdown pill
    /// and the lightbulb, and below the fold.
    func testOnATimedBidTheCountdownAndTheLightbulbStayInSight() {
        for fold in [nil, "tabletop"] as [String?] {
            let tag = fold ?? "flat"
            let app = launch("bidding-mid", ["-uiBidClock", "20", "-uiTutorialWelcome", "NO"] + (fold.map { ["-uiFold", $0] } ?? []))
            let pill = element(app, "bidClock")
            XCTAssertTrue(pill.waitForExistence(timeout: 5), tag)
            XCTAssertTrue(element(app, "tutorialTip").waitForExistence(timeout: 5), tag)
            XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5), tag)
            app.buttons["assist.close"].tap()  // the lightbulb shows with the tip and the chip
            XCTAssertTrue(app.buttons["assist.ask"].waitForExistence(timeout: 3), tag)
            let chip = chipClear(app, "bid clock \(tag)")
            let probe = Fixture.probe(app, "table.assist")
            XCTAssertTrue(probe.contains("bidClock") && probe.contains("ask"), "\(tag): \(probe)")
            XCTAssertTrue(waitFor(app, "table.assist", contains: "clear=ok"), "\(tag): \(Fixture.probe(app, "table.assist"))")
            XCTAssertFalse(chip.intersects(pill.frame), "\(tag): chip \(chip) over the countdown \(pill.frame)")
            // the column knows where the lightbulb is drawn (within a point)
            let ask = app.buttons["assist.ask"].frame
            print("[TutorialUITests] \(tag) lightbulb \(ask)")
            let known = Fixture.probe(app, "table.tutorial").components(separatedBy: "ask=").last?
                .split(separator: " ").prefix(2).compactMap { Double($0) } ?? []
            XCTAssertEqual(known.count, 2, Fixture.probe(app, "table.tutorial"))
            if known.count == 2 {
                XCTAssertEqual(known[0], Double(ask.minX), accuracy: 1, "\(tag): \(ask) vs \(Fixture.probe(app, "table.tutorial"))")
                XCTAssertEqual(known[1], Double(ask.minY), accuracy: 1, "\(tag): \(ask) vs \(Fixture.probe(app, "table.tutorial"))")
            }
            XCTAssertFalse(chip.intersects(app.buttons["assist.ask"].frame),
                           "\(tag): chip \(chip) over the lightbulb \(app.buttons["assist.ask"].frame) \(Fixture.probe(app, "table.tutorial"))")
            shot(app, "bid-clock-\(tag)")
            app.terminate()
        }
    }

    func testASpectatorSeesNoTutorial() {
        let app = launch("spectator-mid-hand")
        XCTAssertFalse(element(app, "tutorial.chip").waitForExistence(timeout: 3))
        XCTAssertFalse(element(app, "tutorialTip").exists)
        XCTAssertFalse(element(app, "tutorialWelcome").exists)
    }
}
