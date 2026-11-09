import XCTest

/// Item 27 done-when: folding / unfolding mid-trick and mid-bid keeps state.
/// Opt-in (TEST_RUNNER_BAB_POSE_CHANGE=1): each test waits up to 120 s for
/// "ui.pose" to change while someone changes the Duo's pose in Device Hub.
final class PoseChangeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        guard ProcessInfo.processInfo.environment["BAB_POSE_CHANGE"] == "1" else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_POSE_CHANGE=1, then fold / unfold in Device Hub")
        }
    }

    private func waitForPoseChange(_ app: XCUIApplication, from pose: String, timeout: TimeInterval = 120) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        print("[PoseChange] waiting for a pose change from \(pose)")
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 1)
            let now = Fixture.probe(app, "ui.pose")
            if Fixture.windowSize(now) != Fixture.windowSize(pose) {
                Thread.sleep(forTimeInterval: 2)  // let the relayout settle
                return Fixture.probe(app, "ui.pose")
            }
        }
        return nil
    }

    /// Lift a legal card by tapping the top strip of each hand slot until the probe shows a lifted card.
    private func liftACard(_ app: XCUIApplication) -> Bool {
        let pose = Fixture.probe(app, "ui.pose")
        guard let size = Fixture.windowSize(pose), let ins = Fixture.insets(pose) else { return false }
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let y = size.height - ins.bottom - 12 - 145 + 30
        let safeW = size.width - ins.left - ins.right
        for i in stride(from: 0.95, through: 0.05, by: -0.06) {
            origin.withOffset(CGVector(dx: ins.left + safeW * i, dy: y)).tap()
            Thread.sleep(forTimeInterval: 0.4)
            if !Fixture.probe(app, "table.state").contains("lifted=-") { return true }
        }
        return false
    }

    func testFoldMidTrickKeepsTheLiftedCard() throws {
        let app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        XCTAssertTrue(liftACard(app), "could not lift a card")
        let state = Fixture.settledState(app)
        let pose = Fixture.probe(app, "ui.pose")
        let after = try XCTUnwrap(waitForPoseChange(app, from: pose), "no pose change within 120 s")
        print("[PoseChange] \(pose) -> \(after)")
        XCTAssertEqual(Fixture.settledState(app), state, "lifted card, hand, trick and the scene (didMove) survive")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok", after)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "pose-change-trick-\(Fixture.poseName(after))"
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testFoldMidBidKeepsTheSelectedBid() throws {
        let app = Fixture.launch("bidding-mid")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let overlay = app.descendants(matching: .any)["bidOverlay"]
        XCTAssertTrue(overlay.waitForExistence(timeout: 5))
        app.buttons["3"].tap()
        XCTAssertEqual(overlay.value as? String, "3")
        let state = Fixture.settledState(app)
        let pose = Fixture.probe(app, "ui.pose")
        let after = try XCTUnwrap(waitForPoseChange(app, from: pose), "no pose change within 120 s")
        print("[PoseChange] \(pose) -> \(after)")
        XCTAssertEqual(app.descendants(matching: .any)["bidOverlay"].value as? String, "3", "the selected bid survives")
        XCTAssertEqual(Fixture.settledState(app), state)
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok", after)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "pose-change-bid-\(Fixture.poseName(after))"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
