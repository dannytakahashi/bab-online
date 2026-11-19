import XCTest

/// Touching and holding the mic / headphones opens the voice panel and does nothing else
/// (owner 2026-11-18: a spectator's long press on the headphones also turned the mic on, and a
/// player's unmuted them). VoiceMuteButton skips the Button action SwiftUI fires when that
/// long press lifts; a plain tap still mutes and unmutes. Voice starts muted (build 16).
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

    /// At my seat: voice starts muted. Holding the mic twice leaves it muted, then a tap
    /// unmutes and a tap mutes; unmuted, a long press keeps it unmuted.
    func testAtMySeatALongPressNeverTogglesTheMic() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiVoice", "YES"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        for _ in 0..<2 {
            let mic = app.buttons["Unmute microphone"]
            XCTAssertTrue(mic.waitForExistence(timeout: 5), "muted at the start")
            mic.press(forDuration: 1.0)
            closePanel(app)
            XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 3), "still muted after the long press")
            XCTAssertFalse(app.buttons["Mute microphone"].exists, "the long press unmuted the mic")
        }
        app.buttons["Unmute microphone"].tap()
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 3), "a tap unmutes")
        app.buttons["Mute microphone"].tap()
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 3), "a tap mutes")
        // Unmuted, a long press keeps it unmuted
        app.buttons["Unmute microphone"].tap()
        let live = app.buttons["Mute microphone"]
        XCTAssertTrue(live.waitForExistence(timeout: 3))
        live.press(forDuration: 1.0)
        closePanel(app)
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 3), "still unmuted after the long press")
        app.terminate()
    }

    /// The game lobby's header mic: the same button, the same rule.
    func testInTheLobbyHeaderALongPressNeverTogglesTheMic() {
        let app = Fixture.launch("game-lobby", extra: ["-uiVoice", "YES"])
        let mic = app.buttons["Unmute microphone"]
        XCTAssertTrue(mic.waitForExistence(timeout: 20), "muted at the start")
        mic.press(forDuration: 1.0)
        closePanel(app)
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 3), "still muted after the long press")
        XCTAssertFalse(app.buttons["Mute microphone"].exists)
        app.buttons["Unmute microphone"].tap()
        XCTAssertTrue(app.buttons["Mute microphone"].waitForExistence(timeout: 3), "a tap unmutes")
        app.terminate()
    }

    /// A spectator's pill button (muted at the start) and, after a refused mic, its headphones:
    /// a long press opens the panel and changes nothing.
    func testOnASpectatorsPillALongPressNeverTogglesTheMic() {
        let app = Fixture.launch("spectator-mid-hand", extra: ["-uiSpectatorVoice", "muted"])
        let mic = app.buttons["Unmute microphone"]
        XCTAssertTrue(mic.waitForExistence(timeout: 20))
        mic.press(forDuration: 1.0)
        closePanel(app)
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 3), "still muted after the long press")
        app.terminate()

        let denied = Fixture.launch("spectator-mid-hand", extra: ["-uiSpectatorVoice", "denied"])
        let phones = denied.buttons["Listening only (no mic access)"]
        XCTAssertTrue(phones.waitForExistence(timeout: 20))
        phones.press(forDuration: 1.0)
        closePanel(denied)
        XCTAssertTrue(denied.buttons["Listening only (no mic access)"].waitForExistence(timeout: 3))
        denied.terminate()
    }
}
