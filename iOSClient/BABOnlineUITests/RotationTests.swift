import XCTest

/// Item 25 done-when on the iPad: rotating mid-hand keeps everything on-screen
/// ("table.layoutCheck") and the table state unchanged ("table.state").
final class RotationTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad only") }
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    func testRotateMidHand() {
        XCUIDevice.shared.orientation = .portrait
        let app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let state = Fixture.settledState(app)
        XCTAssertTrue(state.contains("hand=12"), state)
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        var poses: [String] = [Fixture.probe(app, "ui.pose")]
        for o in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = o
            sleep(2)
            let pose = Fixture.probe(app, "ui.pose")
            poses.append(pose)
            XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok", "after rotating to \(o.rawValue): \(pose)")
            XCTAssertEqual(Fixture.settledState(app), state, "after rotating to \(o.rawValue)")
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "ipad-rotation-\(Fixture.poseName(pose))"
            shot.lifetime = .keepAlways
            add(shot)
        }
        XCTAssertNotEqual(poses[0], poses[1], "the window rotated: \(poses)")
        app.terminate()
    }
}
