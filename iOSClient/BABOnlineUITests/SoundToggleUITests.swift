import XCTest

/// The table's speaker (the game log's header) and the Account sheet's Sound switch: one
/// setting, "Sound" with an On / Off value, remembered across launches. Fixture mode never
/// plays a sound, so this checks the control, not audio.
final class SoundToggleUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func openLog(_ app: XCUIApplication) {
        // the log is a drawer, except where it is docked open (open-Duo landscape, book pose)
        if !app.textFields["Chat..."].exists { app.buttons["log"].tap() }
        XCTAssertTrue(app.textFields["Chat..."].waitForExistence(timeout: 5))
    }

    private func soundValue(_ app: XCUIApplication) -> String {
        let b = app.buttons["sound"]
        XCTAssertTrue(b.waitForExistence(timeout: 5))
        XCTAssertEqual(b.label, "Sound")
        return b.value as? String ?? ""
    }

    func testTableSpeakerTogglesAndIsRemembered() {
        var app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(Fixture.readyElement(app, "trick-mid-lead3").waitForExistence(timeout: 15))
        openLog(app)
        let start = soundValue(app)
        XCTAssertTrue(["On", "Off"].contains(start), start)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "sound-log-header"
        shot.lifetime = .keepAlways
        add(shot)
        app.buttons["sound"].tap()
        let flipped = start == "On" ? "Off" : "On"
        XCTAssertEqual(soundValue(app), flipped)
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        app.terminate()

        app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(Fixture.readyElement(app, "trick-mid-lead3").waitForExistence(timeout: 15))
        openLog(app)
        XCTAssertEqual(soundValue(app), flipped, "remembered on the device")
        app.buttons["sound"].tap()  // as it was
        XCTAssertEqual(soundValue(app), start)
        app.terminate()
    }

    func testAccountSheetSwitchIsTheSameSetting() {
        let app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        app.buttons.matching(NSPredicate(format: "label == %@", "Account settings")).firstMatch.tap()
        let toggle = app.switches["settings.sound"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        let start = toggle.value as? String ?? ""
        XCTAssertEqual(app.sliders["settings.soundVolume"].exists, start == "1", "the volume shows while sound is on")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "sound-account-sheet"
        shot.lifetime = .keepAlways
        add(shot)
        toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()
        XCTAssertNotEqual(toggle.value as? String ?? "", start)
        toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()  // as it was
        XCTAssertEqual(toggle.value as? String ?? "", start)
        app.terminate()
    }
}
