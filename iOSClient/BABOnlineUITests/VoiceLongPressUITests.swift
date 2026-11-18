import XCTest

/// Touching and holding the mic / headphones opens the voice panel and does nothing else
/// (owner 2026-11-18: a spectator's long press on the headphones also turned the mic on, and a
/// player's unmuted them). VoiceMuteButton skips the Button action SwiftUI fires when that
/// long press lifts; a plain tap still mutes and unmutes.
final class VoiceLongPressUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func closePanel(_ app: XCUIApplication) {
        let bar = app.navigationBars["Voice Chat"]
        XCTAssertTrue(bar.waitForExistence(timeout: 5), "the long press opens the panel")
        bar.buttons["Done"].tap()
        XCTAssertTrue(bar.waitForNonExistence(timeout: 5), "the panel closed")
    }

    /// At my seat: holding the mic twice leaves it unmuted, then a tap mutes and a tap unmutes.
    func testAtMySeatALongPressNeverTogglesTheMic() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiVoice", "YES"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        for _ in 0..<2 {
            let mic = app.buttons["Mute microphone"]
            XCTAssertTrue(mic.waitForExistence(timeout: 5), "unmuted")
            mic.press(forDuration: 1.0)
            closePanel(app)
            XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 3), "still unmuted after the long press")
            XCTAssertFalse(app.buttons["Unmute microphone"].exists, "the long press muted the mic")
        }
        app.buttons["Mute microphone"].tap()
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 3), "a tap still mutes")
        app.buttons["Unmute microphone"].tap()
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 3), "a tap still unmutes")
        // Muted, a long press keeps it muted
        app.buttons["Mute microphone"].tap()
        let muted = app.buttons["Unmute microphone"]
        XCTAssertTrue(muted.waitForExistence(timeout: 3))
        muted.press(forDuration: 1.0)
        closePanel(app)
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 3), "still muted after the long press")
        app.terminate()
    }

    /// The game lobby's header mic: the same button, the same rule.
    func testInTheLobbyHeaderALongPressNeverTogglesTheMic() {
        let app = Fixture.launch("game-lobby", extra: ["-uiVoice", "YES"])
        let mic = app.buttons["Mute microphone"]
        XCTAssertTrue(mic.waitForExistence(timeout: 20))
        mic.press(forDuration: 1.0)
        closePanel(app)
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 3), "still unmuted after the long press")
        XCTAssertFalse(app.buttons["Unmute microphone"].exists)
        app.buttons["Mute microphone"].tap()
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 3), "a tap still mutes")
        app.terminate()
    }
}
