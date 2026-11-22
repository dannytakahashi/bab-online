import XCTest

/// The mic in the iPhone Duo's vertical bar (owner 2026-11-22; GameContainerView.micSpot,
/// VoiceBarButton): where the bar shows the table's controls (the Duo closed, open in
/// landscape, book pose) my mic is a bar item, one tap mutes / unmutes, touch and hold opens
/// "Voice panel…", the probe "table.voice" says the glyph's state (muted red, talking green),
/// and the bar never folds it into its overflow menu. Elsewhere (other phones, the iPad, the
/// Duo open in portrait) the felt keeps it ("at=felt"). Run on "iPhone Duo" for the bar cases
/// (each skips where no vertical bar is used) and on any other simulator for the felt case.
final class DuoBarMicUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func usesVerticalBar(_ app: XCUIApplication) -> Bool {
        let pose = Fixture.probe(app, "ui.pose")
        return pose.contains(" vbar ") && !pose.hasSuffix("vbar -")
    }

    private func waitFor(_ app: XCUIApplication, _ probe: String, contains text: String, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Fixture.probe(app, probe).contains(text) { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    private func launchSeated(_ extra: [String] = []) throws -> XCUIApplication {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiVoice", "YES"] + extra)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        guard usesVerticalBar(app) else {
            app.terminate()
            throw XCTSkip("no vertical bar here: \(Fixture.probe(app, "ui.pose"))")
        }
        return app
    }

    /// One tap mutes / unmutes; the long press is the menu's "Voice panel…" only.
    func testInTheBarOneTapMutesAndTheHoldOpensThePanel() throws {
        let app = try launchSeated(["-uiTutorial", "YES", "-uiAssist", "YES"])
        XCTAssertTrue(waitFor(app, "table.voice", contains: "at=bar symbol=mic.slash.fill tint=red"), Fixture.probe(app, "table.voice"))
        let mic = app.buttons["Unmute microphone"]
        XCTAssertTrue(mic.waitForExistence(timeout: 5) && mic.isHittable, "the bar's mic, muted at the start")
        mic.tap()
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 3), "one tap unmutes")
        XCTAssertTrue(waitFor(app, "table.voice", contains: "symbol=mic.fill tint=-"))
        app.buttons["Mute microphone"].press(forDuration: 1.0)
        let item = app.buttons[VoicePanelItem.label]
        XCTAssertTrue(item.waitForExistence(timeout: 3), "the hold opens the menu")
        item.tap()
        let bar = app.navigationBars["Voice Chat"]
        XCTAssertTrue(bar.waitForExistence(timeout: 5), "Voice panel… opens the panel")
        bar.buttons["Done"].tap()
        XCTAssertTrue(bar.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 3), "the hold changed nothing")
        app.buttons["Mute microphone"].tap()
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 3), "one tap mutes")
        app.terminate()
    }

    /// My talking shows on the control: green while I talk, the bar's own colour between.
    func testTheGlyphTurnsGreenWhileITalk() throws {
        let app = try launchSeated(["-uiSelfSpeaking", "pulse"])
        XCTAssertTrue(waitFor(app, "table.voice", contains: "symbol=mic.fill tint=green"), Fixture.probe(app, "table.voice"))
        XCTAssertTrue(waitFor(app, "table.voice", contains: "symbol=mic.fill tint=-"), "follows the talking live")
        XCTAssertTrue(waitFor(app, "table.voice", contains: "tint=green"))
        app.buttons["Mute microphone"].tap()
        XCTAssertTrue(waitFor(app, "table.voice", contains: "symbol=mic.slash.fill tint=red"))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(Fixture.probe(app, "table.voice").contains("tint=red"), "muted never shows talking")
        app.terminate()
    }

    /// The overflow: with the bar packed past its room (DEBUG filler items) and the mic as its
    /// LAST item, the high visibility priority keeps the mic one tap away while the items before
    /// it fold; the control case (standard priority) folds it.
    func testThePackedBarKeepsTheMic() throws {
        let app = try launchSeated(["-uiBarFiller", "9", "-uiBarMicLast", "YES"])
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Unmute microphone"].isHittable, "the mic stays in the bar")
        XCTAssertFalse(app.buttons["bar.filler.9"].exists && app.buttons["bar.filler.9"].isHittable, "the bar folded something")
        app.buttons["Unmute microphone"].tap()
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 3))
        app.terminate()

        let control = try launchSeated(["-uiBarFiller", "9", "-uiBarMicLast", "YES", "-uiBarMicPriority", "standard"])
        Thread.sleep(forTimeInterval: 1)
        let folded = control.buttons["Unmute microphone"]
        XCTAssertFalse(folded.exists && folded.isHittable, "standard priority: the bar folds the last item")
        control.terminate()
    }

    /// A spectator's mic (the pill's, a watcher's above the eye) moves into the bar too.
    func testASpectatorsMicIsInTheBar() throws {
        let app = Fixture.launch("spectator-mid-hand", extra: ["-uiSpectatorVoice", "muted"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        guard usesVerticalBar(app) else { app.terminate(); throw XCTSkip("no vertical bar here") }
        XCTAssertTrue(waitFor(app, "table.voice", contains: "at=bar"), Fixture.probe(app, "table.voice"))
        XCTAssertEqual(app.buttons.matching(identifier: "Unmute microphone").count, 1, "one mic, in the bar")
        app.terminate()

        let watcher = Fixture.launch("spectator-mid-hand", extra: ["-uiShoulder", "auto", "-uiSpectatorVoice", "denied"])
        XCTAssertTrue(watcher.buttons["leave"].waitForExistence(timeout: 20))
        XCTAssertTrue(waitFor(watcher, "table.voice", contains: "at=bar symbol=headphones tint=-"), Fixture.probe(watcher, "table.voice"))
        XCTAssertTrue(watcher.buttons["Listening only (no mic access)"].waitForExistence(timeout: 5))
        watcher.terminate()
    }

    /// Without the vertical bar nothing moves: the felt keeps the mic.
    func testWithoutTheBarTheFeltKeepsTheMic() throws {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiVoice", "YES"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        if usesVerticalBar(app) { app.terminate(); throw XCTSkip("the vertical bar is in use here") }
        XCTAssertTrue(waitFor(app, "table.voice", contains: "at=felt"), Fixture.probe(app, "table.voice"))
        app.terminate()
    }
}

/// The menu item's words (VoiceBarButton.panelItem; the UI tests do not link the app).
private enum VoicePanelItem {
    static let label = "Voice panel\u{2026}"
}
