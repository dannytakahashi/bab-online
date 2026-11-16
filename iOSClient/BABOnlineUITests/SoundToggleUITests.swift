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

    /// The speaker: a button with the toggle trait, which XCUITest lists as a switch.
    private func speaker(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "sound").firstMatch
    }

    private func soundValue(_ app: XCUIApplication) -> String {
        let b = speaker(app)
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
        speaker(app).tap()
        let flipped = start == "On" ? "Off" : "On"
        XCTAssertEqual(soundValue(app), flipped)
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        app.terminate()

        app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(Fixture.readyElement(app, "trick-mid-lead3").waitForExistence(timeout: 15))
        openLog(app)
        XCTAssertEqual(soundValue(app), flipped, "remembered on the device")
        speaker(app).tap()  // as it was
        XCTAssertEqual(soundValue(app), start)
        app.terminate()
    }

    /// The Sound section sits under the profile (iOS 1.2.2): scroll the Account sheet to it.
    private func revealSound(_ app: XCUIApplication, _ toggle: XCUIElement) {
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 5))
        for _ in 0..<6 where !(toggle.exists && toggle.isHittable) { app.swipeUp(velocity: .slow) }
    }

    func testAccountSheetSwitchIsTheSameSetting() {
        var app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        app.buttons.matching(NSPredicate(format: "label == %@", "Account settings")).firstMatch.tap()
        var toggle = app.switches["settings.sound"]
        revealSound(app, toggle)
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        let start = toggle.value as? String ?? ""
        XCTAssertEqual(app.sliders["settings.soundVolume"].exists, start == "1", "the volume shows while sound is on")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "sound-account-sheet"
        shot.lifetime = .keepAlways
        add(shot)
        toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()
        let flipped = toggle.value as? String ?? ""
        XCTAssertNotEqual(flipped, start)
        app.terminate()

        // the table's speaker shows what the Account switch set, and flips it back
        app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(Fixture.readyElement(app, "trick-mid-lead3").waitForExistence(timeout: 15))
        openLog(app)
        XCTAssertEqual(soundValue(app), flipped == "1" ? "On" : "Off")
        // .isToggle: XCUITest lists the button as a switch (a plain button would be .button)
        XCTAssertTrue([.switch, .toggle].contains(speaker(app).elementType), "a toggle to VoiceOver: \(speaker(app).elementType.rawValue)")
        speaker(app).tap()
        XCTAssertEqual(soundValue(app), start == "1" ? "On" : "Off")
        app.terminate()

        app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        app.buttons.matching(NSPredicate(format: "label == %@", "Account settings")).firstMatch.tap()
        toggle = app.switches["settings.sound"]
        revealSound(app, toggle)
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String ?? "", start, "the speaker's flip is the Account switch's setting")
        app.terminate()
    }
}
