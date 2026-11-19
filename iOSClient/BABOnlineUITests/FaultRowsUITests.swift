import XCTest

/// Red fault rows in the game log (the server's hand-end fault lines): two stored in the
/// seeded snapshot, one arriving live, then a reconnect's snapshot holding all three: each
/// shows once ("logFaultRow"), and the snapshot's viewer.assist makes the /help count exact.
final class FaultRowsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func openLog(_ app: XCUIApplication) {
        // the log is a drawer, except where it is docked open (open-Duo landscape, book pose)
        if !app.textFields["Chat..."].exists { app.buttons["log"].tap() }
        XCTAssertTrue(app.textFields["Chat..."].waitForExistence(timeout: 5))
    }

    private func faultRows(_ app: XCUIApplication) -> [String] {
        app.staticTexts.matching(identifier: "logFaultRow").allElementsBoundByIndex.map(\.label)
    }

    func testFaultRowsReplayLiveAndOnceAfterAReconnect() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiFaults", "YES", "-uiSnapshotHelpUses", "2"])
        XCTAssertTrue(Fixture.readyElement(app, "trick-mid-lead3").waitForExistence(timeout: 15))
        openLog(app)
        // the live line (2 s after launch)
        XCTAssertTrue(app.staticTexts["Fault: hal (bid 4, took 2)"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Hand 1 over. ivy and hal were set."].exists)
        XCTAssertEqual(app.staticTexts.matching(identifier: "logFaultRow").matching(NSPredicate(format: "label BEGINSWITH 'Hand'")).count, 0,
                       "a plain system line is not a fault row")
        // the reconnect's snapshot (4 s after launch) replays them: still once each
        Thread.sleep(forTimeInterval: 3.5)
        XCTAssertEqual(faultRows(app), ["Fault: ivy (bid 3, took 1)", "Fault: hal (bid 2, took 0)", "Fault: hal (bid 4, took 2)"])
        XCTAssertEqual(Fixture.probe(app, "table.logFaults"),
                       "3: Fault: ivy (bid 3, took 1) | Fault: hal (bid 2, took 0) | Fault: hal (bid 4, took 2)")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "fault-rows"
        shot.lifetime = .keepAlways
        add(shot)
        // the snapshot's viewer.assist: 2 used
        let field = app.textFields["Chat..."]
        field.tap()
        field.typeText("/h")
        XCTAssertTrue(app.staticTexts["Suggest a move (2 of 3 free used)"].waitForExistence(timeout: 5))
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
    }
}
