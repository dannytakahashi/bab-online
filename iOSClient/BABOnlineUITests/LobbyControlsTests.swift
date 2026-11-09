import XCTest

/// The main room's and the lobbies' header controls. Where the system shows the
/// vertical bar (the Duo closed, open in landscape, book pose) they are toolbar
/// items in that column ("vbar <edge>" in "ui.pose") and no content control
/// reaches into it; elsewhere they are the header row. Either way each control
/// exists exactly once and works.
final class LobbyControlsTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// The vertical bar's column in screen points, nil where the system shows none.
    private func verticalBarColumn(_ app: XCUIApplication) -> ClosedRange<CGFloat>? {
        let pose = Fixture.probe(app, "ui.pose")
        // the Duo's poses with a vertical bar (TEST_RUNNER_BAB_POSE, as FixtureScreenshotTests)
        if let expected = ProcessInfo.processInfo.environment["BAB_POSE"], ["closed", "open-landscape"].contains(expected) {
            XCTAssertFalse(pose.hasSuffix("vbar -"), "no vertical bar reported in \(expected): \(pose)")
        }
        guard let edge = pose.split(separator: " ").last, edge != "-", pose.contains(" vbar "),
              let size = Fixture.windowSize(pose), let insets = Fixture.insets(pose) else { return nil }
        switch edge {
        case "trailing": return (size.width - insets.right)...size.width
        case "leading": return 0...insets.left
        default:
            XCTFail("unexpected vertical bar edge in \(pose)")
            return nil
        }
    }

    private func buttons(_ app: XCUIApplication, _ predicate: String, _ arg: String) -> [XCUIElement] {
        app.buttons.matching(NSPredicate(format: predicate, arg)).allElementsBoundByIndex
    }

    /// Exactly one button with this label; in the column where there is a vertical bar.
    @discardableResult
    private func assertControl(_ app: XCUIApplication, _ predicate: String, _ arg: String,
                               column: ClosedRange<CGFloat>?, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement? {
        let found = buttons(app, predicate, arg)
        XCTAssertEqual(found.count, 1, "\(arg): \(found.map(\.label))", file: file, line: line)
        guard let e = found.first else { return nil }
        XCTAssertTrue(e.isHittable, "\(arg) is not hittable", file: file, line: line)
        if let column {
            XCTAssertTrue(column.contains(e.frame.midX), "\(arg) at \(e.frame) is not in the vertical bar \(column)", file: file, line: line)
        }
        return e
    }

    /// With a vertical bar no other button reaches into its column.
    private func assertContentClear(_ app: XCUIApplication, column: ClosedRange<CGFloat>?, barLabels: [String],
                                    file: StaticString = #filePath, line: UInt = #line) {
        guard let column else { return }
        for e in app.buttons.allElementsBoundByIndex where e.exists && !e.frame.isEmpty {
            if barLabels.contains(where: { e.label.contains($0) }) { continue }
            let f = e.frame
            let overlaps = f.maxX > column.lowerBound + 1 && f.minX < column.upperBound - 1
            XCTAssertFalse(overlaps, "\(e.label) at \(f) reaches into the vertical bar \(column)", file: file, line: line)
        }
    }

    func testMainRoomControls() {
        let app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        sleep(1)
        let column = verticalBarColumn(app)
        let labels = ["New Game", "Tournament", "Stats", "7 online", "Account settings"]
        for label in labels {
            assertControl(app, "label == %@", label, column: column)
        }
        assertContentClear(app, column: column, barLabels: labels)

        buttons(app, "label == %@", "Stats").first?.tap()
        XCTAssertTrue(app.navigationBars["Leaderboard"].waitForExistence(timeout: 5), "Stats opens the leaderboard")
        app.terminate()
    }

    func testGameLobbyLeave() {
        lobbyLeave("game-lobby")
    }

    func testTournamentLobbyLeave() {
        lobbyLeave("tournament-lobby")
    }

    private func lobbyLeave(_ fixture: String) {
        let app = Fixture.launch(fixture)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20))
        sleep(1)
        let column = verticalBarColumn(app)
        assertControl(app, "label CONTAINS %@", "Leave", column: column)
        assertContentClear(app, column: column, barLabels: ["Leave"])
        app.terminate()
    }
}
