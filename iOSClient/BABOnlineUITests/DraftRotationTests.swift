import XCTest

/// Item 27 done-when: rotating while typing in the main-room chat keeps the draft.
/// Needs a window that rotates (the iPad, the open Duo); on a portrait-only
/// window the rotation is refused and the check is trivially kept.
final class DraftRotationTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    func testMainRoomDraftSurvivesRotation() {
        XCUIDevice.shared.orientation = .portrait
        let app = Fixture.launch("main-room")
        let field = app.textFields["mainRoomChatField"]
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        field.typeText("half a thought")
        let before = Fixture.probe(app, "ui.pose")
        for o in [UIDeviceOrientation.landscapeLeft, .portrait, .landscapeRight, .portrait] {
            XCUIDevice.shared.orientation = o
            sleep(2)
            let f = app.textFields["mainRoomChatField"]
            XCTAssertTrue(f.waitForExistence(timeout: 5))
            XCTAssertEqual(f.value as? String, "half a thought", "after rotating to \(o.rawValue) (\(Fixture.probe(app, "ui.pose")))")
        }
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "\(Fixture.poseName(before))-main-room-draft-after-rotation"
        shot.lifetime = .keepAlways
        add(shot)
        app.terminate()
    }
}
