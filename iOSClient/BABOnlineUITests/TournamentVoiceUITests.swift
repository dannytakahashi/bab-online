import XCTest

/// The tournament lobby's mic (iOS 1.2.6, tournament-room voice; docs/claude/voice.md
/// "Tournament voice"): the game lobby's header mic in the tournament lobby's header while voice
/// runs (`-uiVoice YES` in fixture mode, where voice itself never starts): muted at the start, a
/// tap unmutes, touch and hold opens the voice panel and toggles nothing, the voice panel tip
/// hangs under the header, and the mic coming and going never moves the lobby under it.
final class TournamentVoiceUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func launch(_ fixture: String, extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20), fixture)
        return app
    }

    /// At the default and the largest text size, in the lobby phase and during a round: the mic is
    /// in the header, on screen, clear of the title, the round line, the count and Leave.
    func testTheHeaderHasTheMicClearOfEverythingElse() {
        for fixture in ["tournament-lobby", "tournament-round", "tournament-between"] {
            for (tag, size) in [("default", nil), ("ax5", "UICTContentSizeCategoryAccessibilityXXXL")] as [(String, String?)] {
                var extra = ["-uiVoice", "YES"]
                if let size { extra += ["-UIPreferredContentSizeCategoryName", size] }
                let app = launch(fixture, extra: extra)
                let mic = any(app, "tournament.mic")
                XCTAssertTrue(mic.waitForExistence(timeout: 5), "\(fixture) \(tag): the header's mic")
                XCTAssertEqual(mic.label, "Unmute microphone", "muted at the start")
                let window = app.windows.firstMatch.frame
                XCTAssertTrue(window.insetBy(dx: -0.5, dy: -0.5).contains(mic.frame), "\(fixture) \(tag): \(mic.frame) in \(window)")
                XCTAssertTrue(mic.isHittable, "\(fixture) \(tag)")
                let title = app.staticTexts["Sunday Cup"]
                XCTAssertTrue(title.exists)
                // at AX5 one row left the title a letter wide: it gets a row of its own there
                // ("Sunday Cup" is 96 pt wide at the default size, about 230 at AX5)
                XCTAssertGreaterThan(title.frame.width, size == nil ? 90 : 200, "\(fixture) \(tag): the title squeezed to \(title.frame)")
                for other in [title, app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' players'")).firstMatch,
                              app.buttons["Leave"]] where other.exists {
                    XCTAssertFalse(other.frame.intersects(mic.frame), "\(fixture) \(tag): \(other.label) \(other.frame) under the mic \(mic.frame)")
                }
                keep("tournament-mic-\(fixture)-\(tag)")
                app.terminate()
            }
        }
    }

    func testATapUnmutesAndALongPressOnlyOpensThePanel() {
        let app = launch("tournament-lobby", extra: ["-uiVoice", "YES"])
        let mic = app.buttons["Unmute microphone"]
        XCTAssertTrue(mic.waitForExistence(timeout: 5))
        Fixture.holdForVoicePanel(app, mic)
        let bar = app.navigationBars["Voice Chat"]
        XCTAssertTrue(bar.waitForExistence(timeout: 5), "the long press opens the voice panel")
        bar.buttons["Done"].tap()
        XCTAssertTrue(bar.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 3), "still muted after the long press")
        app.buttons["Unmute microphone"].tap()
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 3), "a tap unmutes")
        app.buttons["Mute microphone"].tap()
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 3), "a tap mutes")
        app.terminate()
    }

    /// No mic while voice is off (alone, a spectator, an older server): and the lobby under the
    /// header sits where it sits with the mic.
    func testTheMicNeverMovesTheLobby() {
        func playersTop(_ extra: [String]) -> (CGFloat, Bool) {
            let app = launch("tournament-lobby", extra: extra)
            let players = any(app, "tournament.players")
            XCTAssertTrue(players.waitForExistence(timeout: 5))
            let top = players.frame.minY
            let hasMic = any(app, "tournament.mic").exists
            app.terminate()
            return (top, hasMic)
        }
        let (without, micOff) = playersTop([])
        let (with, micOn) = playersTop(["-uiVoice", "YES"])
        XCTAssertFalse(micOff, "voice off: no mic")
        XCTAssertTrue(micOn)
        XCTAssertEqual(without, with, accuracy: 0.5, "the header keeps its height")
    }

    /// The voice panel tip (once per install) hangs just under the header, off the mic.
    func testTheVoicePanelTipHangsUnderTheHeader() {
        let app = launch("tournament-lobby", extra: ["-uiVoice", "YES", "-uiVoiceTip", "YES", "-uiVoiceTipFresh", "YES"])
        let tip = any(app, "voicePanelTip")
        XCTAssertTrue(tip.waitForExistence(timeout: 6), "the tip")
        let mic = any(app, "tournament.mic")
        XCTAssertTrue(mic.exists)
        XCTAssertFalse(tip.frame.intersects(mic.frame), "tip \(tip.frame) over the mic \(mic.frame)")
        XCTAssertGreaterThanOrEqual(tip.frame.minY, mic.frame.maxY - 0.5, "under the header's mic")
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(window.insetBy(dx: -0.5, dy: -0.5).contains(tip.frame))
        Thread.sleep(forTimeInterval: 1)  // past its slide in
        XCTAssertTrue(tip.isHittable, "drawn over the player list, not under it")
        keep("tournament-voice-tip")
        app.terminate()
    }
}
