import XCTest

/// The voice panel tip (owner 2026-11-17; Voice/VoicePanelTip.swift): the first time the mic
/// button is on screen with voice on, a toast says to touch and hold it, once per install.
/// Fixture mode shows it only with `-uiVoiceTip YES`; `-uiVoiceTipFresh YES` starts from a fresh
/// install's flag.
final class VoicePanelTipUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private static let fresh = ["-uiVoiceTip", "YES", "-uiVoiceTipFresh", "YES"]

    private func tip(_ app: XCUIApplication) -> XCUIElement { app.descendants(matching: .any)["voicePanelTip"] }

    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// My seat: the tip at the top, off the mic, my hand and the table's edges; a second launch
    /// (the flag set) shows none.
    func testAtMySeatItShowsOnceClearOfTheMicAndTheHand() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiVoice", "YES"] + Self.fresh)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let t = tip(app)
        XCTAssertTrue(t.waitForExistence(timeout: 6), "the tip")
        XCTAssertTrue(t.label.contains("touch and hold the mic for the voice panel"), t.label)
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(window.insetBy(dx: -0.5, dy: -0.5).contains(t.frame), "\(t.frame) in \(window)")
        let mic = app.buttons["Mute microphone"]
        XCTAssertTrue(mic.exists)
        XCTAssertFalse(t.frame.intersects(mic.frame), "tip \(t.frame) over the mic \(mic.frame)")
        // the scene's cards reach the tree once it has rendered (as SeatRowUITests waits)
        _ = Fixture.settledState(app)
        for card in ["Queen of Clubs", "High Joker", "10 of Clubs"] {
            let c = app.descendants(matching: .any)[card]
            XCTAssertTrue(c.waitForExistence(timeout: 8), card)
            XCTAssertFalse(t.frame.intersects(c.frame), "tip \(t.frame) over \(card) \(c.frame)")
        }
        XCTAssertLessThan(t.frame.maxY, window.midY, "at the top: \(t.frame)")
        keep("voice-tip-table")
        app.terminate()

        let again = Fixture.launch("trick-mid-lead3", extra: ["-uiVoice", "YES", "-uiVoiceTip", "YES"])
        XCTAssertTrue(again.buttons["leave"].waitForExistence(timeout: 20))
        XCTAssertFalse(tip(again).waitForExistence(timeout: 4), "a second launch: no tip")
        again.terminate()
    }

    /// The lobby: under the header, off its mic; a tap dismisses it.
    func testInTheLobbyItHangsUnderTheHeaderAndATapDismissesIt() {
        let app = Fixture.launch("game-lobby", extra: ["-uiVoice", "YES"] + Self.fresh)
        XCTAssertTrue(Fixture.readyElement(app, "game-lobby").waitForExistence(timeout: 15))
        let t = tip(app)
        XCTAssertTrue(t.waitForExistence(timeout: 6), "the tip")
        let mic = app.descendants(matching: .any)["lobby.mic"]
        XCTAssertTrue(mic.exists)
        XCTAssertFalse(t.frame.intersects(mic.frame), "tip \(t.frame) over the mic \(mic.frame)")
        XCTAssertGreaterThanOrEqual(t.frame.minY, mic.frame.maxY - 0.5, "under the header's mic")
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(window.insetBy(dx: -0.5, dy: -0.5).contains(t.frame), "\(t.frame) in \(window)")
        keep("voice-tip-lobby")
        t.tap()
        XCTAssertTrue(waitForGone(t), "a tap dismisses it")
        app.terminate()
    }

    /// A long press that opens the panel while the tip shows hides it.
    func testOpeningThePanelHidesTheTip() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiVoice", "YES"] + Self.fresh)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let t = tip(app)
        XCTAssertTrue(t.waitForExistence(timeout: 6))
        app.buttons["Mute microphone"].press(forDuration: 0.8)
        XCTAssertTrue(waitForGone(t), "the panel opened: no tip")
        app.terminate()
    }

    /// A listen-only spectator's button shows headphones, and the tip says so.
    func testAListenOnlySpectatorHearsAboutTheHeadphones() {
        let app = Fixture.launch("spectator-mid-hand", extra: ["-uiSpectatorVoice", "listen"] + Self.fresh)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let t = tip(app)
        XCTAssertTrue(t.waitForExistence(timeout: 6))
        XCTAssertTrue(t.label.contains("touch and hold the headphones"), t.label)
        let mic = app.buttons["Tap to talk"]
        if mic.exists { XCTAssertFalse(t.frame.intersects(mic.frame), "tip \(t.frame) over \(mic.frame)") }
        keep("voice-tip-spectator")
        app.terminate()
    }

    /// A spectator's headphones under the draw or game-end scrim: no tip there, and it is not
    /// used up (the table later shows it, on a launch that keeps the flag).
    func testUnderTheDrawAndGameEndOverlaysItWaitsAndIsNotUsedUp() {
        let draw = Fixture.launch("draw-spectator", extra: ["-uiSpectatorVoice", "listen"] + Self.fresh)
        XCTAssertTrue(draw.staticTexts["Draw for Deal"].waitForExistence(timeout: 20))
        XCTAssertTrue(draw.buttons["Tap to talk"].waitForExistence(timeout: 5), "the pill's headphones, under the scrim")
        XCTAssertFalse(tip(draw).waitForExistence(timeout: 4), "no tip under the draw overlay")
        draw.terminate()

        let end = Fixture.launch("game-end-spectator", extra: ["-uiSpectatorVoice", "listen", "-uiVoiceTip", "YES"])
        XCTAssertTrue(Fixture.readyElement(end, "game-end-spectator").waitForExistence(timeout: 20))
        XCTAssertFalse(tip(end).waitForExistence(timeout: 4), "no tip under the game-end modal")
        end.terminate()

        let table = Fixture.launch("spectator-mid-hand", extra: ["-uiSpectatorVoice", "listen", "-uiVoiceTip", "YES"])
        XCTAssertTrue(table.buttons["leave"].waitForExistence(timeout: 20))
        XCTAssertTrue(tip(table).waitForExistence(timeout: 6), "still to come at the table")
        table.terminate()
    }

    /// The info toast in the tip's spot (e.g. a listen-only tap's "tap to talk" reason): the tip
    /// waits under no toast, and shows once the notice is gone.
    func testANoticeInItsSpotHoldsItUntilTheNoticeGoes() {
        let app = Fixture.launch("spectator-mid-hand", extra: ["-uiSpectatorVoice", "listen",
                                                                "-uiInfoToast", "The host turned off spectator talk"] + Self.fresh)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let notice = app.descendants(matching: .any)["infoToast"]
        XCTAssertTrue(notice.waitForExistence(timeout: 6))
        sleep(2)  // past the tip's 1 s delay (and a hide's 0.3 s fade)
        XCTAssertFalse(tip(app).exists, "a tip under the notice")
        notice.tap()
        XCTAssertTrue(waitForGone(notice))
        XCTAssertTrue(tip(app).waitForExistence(timeout: 5), "the tip once the notice is gone")
        app.terminate()
    }

    /// Fixture mode without `-uiVoiceTip`: never (the other UI tests see no toast), even fresh.
    func testFixtureModeWithoutTheFlagShowsNoTip() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiVoice", "YES", "-uiVoiceTipFresh", "YES"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        XCTAssertFalse(tip(app).waitForExistence(timeout: 4))
        app.terminate()
    }

    /// The largest text size: a few lines within the window, still off the mic.
    func testAtTheLargestTextItStaysWithinTheWindow() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiVoice", "YES", "-UIPreferredContentSizeCategoryName",
                                                             "UICTContentSizeCategoryAccessibilityXXXL"] + Self.fresh)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let t = tip(app)
        XCTAssertTrue(t.waitForExistence(timeout: 6))
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(window.insetBy(dx: -0.5, dy: -0.5).contains(t.frame), "\(t.frame) in \(window)")
        XCTAssertLessThan(t.frame.height, window.height / 3, "a few lines: \(t.frame)")
        let mic = app.buttons["Mute microphone"]
        if mic.exists { XCTAssertFalse(t.frame.intersects(mic.frame), "tip \(t.frame) over the mic \(mic.frame)") }
        keep("voice-tip-table-ax5")
        app.terminate()
    }

    private func waitForGone(_ e: XCUIElement, timeout: TimeInterval = 3) -> Bool {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: e)
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }
}
