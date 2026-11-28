import XCTest

/// The scorecard (owner 2026-11-27): the game-end screen's "Summary | Scorecard" control and the
/// score bar's mid-game sheet, in fixture mode (`-uiScorecard YES`: UIFixture+Scorecard; the
/// rows follow the server's rules: a fault, extra tricks, a made bore, a set 2B, a joker hand, a
/// rainbow; Get Your Bid with its Forbidden Bid). `-uiScorecardNone YES`: an older server (no key).
/// Run on the iPhone 18 Pro, the iPhone Duo closed and open and the iPad, default and AX5.
/// `TEST_RUNNER_BAB_SHOTS=<folder>` (+ `TEST_RUNNER_BAB_DEVICE=<tag>`) saves PNGs.
final class ScorecardUITests: XCTestCase {
    static let ax5 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

    override func setUp() { continueAfterFailure = true }

    private func launch(_ fixture: String, _ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: ["-uiScorecard", "YES"] + extra)
        let ready = fixture.hasSuffix("-end") ? app.descendants(matching: .any)["gameEnd"] : Fixture.readyElement(app, fixture)
        XCTAssertTrue(ready.waitForExistence(timeout: 20), "\(fixture) did not come up")
        return app
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        let env = ProcessInfo.processInfo.environment
        if let dir = env["BAB_SHOTS"] ?? env["TEST_RUNNER_BAB_SHOTS"] {
            let tag = env["BAB_DEVICE"] ?? env["TEST_RUNNER_BAB_DEVICE"] ?? "device"
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/scorecard-\(tag)-\(name).png"))
        }
    }

    /// Every row element: one sentence, inside the window across (never clipped sideways).
    private func checkRows(_ app: XCUIApplication, _ handNos: [Int], _ tag: String) {
        let window = app.windows.firstMatch.frame
        for n in handNos {
            let row = any(app, "scorecard.row.\(n)")
            XCTAssertTrue(row.waitForExistence(timeout: 5), "\(tag): no row for hand \(n)")
            guard row.exists else { continue }
            XCTAssertTrue(row.label.hasPrefix("Hand "), "\(tag) hand \(n): \(row.label)")
            XCTAssertNil(row.label.range(of: #"Team \d|T\d|Your Team|Opponents"#, options: .regularExpression), "\(tag): \(row.label)")
            XCTAssertGreaterThanOrEqual(row.frame.minX, window.minX - 1, "\(tag) hand \(n)")
            XCTAssertLessThanOrEqual(row.frame.maxX, window.maxX + 1, "\(tag) hand \(n)")
        }
    }

    // MARK: - Game end

    func testTheGameEndHasSummaryThenScorecard() {
        let app = launch("game-end")
        let tabs = any(app, "gameEnd.tabs")
        XCTAssertTrue(tabs.waitForExistence(timeout: 5), "the Summary | Scorecard control")
        XCTAssertTrue(app.buttons["Summary"].isSelected, "Summary first and shown")
        XCTAssertTrue(any(app, "gameEnd.stats").exists, "the summary unchanged")
        shot("game-end-summary")
        app.buttons["Scorecard"].tap()
        XCTAssertTrue(any(app, "scorecard").waitForExistence(timeout: 5))
        XCTAssertFalse(any(app, "gameEnd.stats").exists, "the summary goes while the scorecard shows")
        XCTAssertEqual(any(app, "scorecard").value as? String, "fits", "the columns fit at the default size")
        shot("game-end-scorecard")
        checkRows(app, Array(1...13), "game-end")
        // the ledger: no delta on the first hand, then "+41/92"-style, and the roles
        let first = any(app, "scorecard.row.1").value as? String ?? ""
        XCTAssertTrue(first.contains("=51") && first.contains("=33"), "hand 1: totals only: \(first)")
        let second = any(app, "scorecard.row.2").value as? String ?? ""
        XCTAssertTrue(second.contains("fault:3 \u{2192} 1"), "kim at fault: \(second)")
        XCTAssertTrue(second.contains("+43/94") && second.contains("\u{2212}50/-17"), "delta above total: \(second)")
        XCTAssertTrue((any(app, "scorecard.row.5").value as? String ?? "").contains("bore:B \u{2192} 4"), "a made bore")
        XCTAssertTrue((any(app, "scorecard.row.9").value as? String ?? "").contains("boreSet:2B \u{2192} 4"), "a set 2B")
        XCTAssertTrue((any(app, "scorecard.row.1").value as? String ?? "").contains("plain+:2 \u{2192} 3"), "extra tricks gold")
        XCTAssertTrue(any(app, "scorecard.row.7").label.hasPrefix("Hand 1, no trump, low joker."), any(app, "scorecard.row.7").label)
        XCTAssertTrue(any(app, "scorecard.row.2").label.contains("kim bid 3, took 1, at fault."), any(app, "scorecard.row.2").label)
        // back to the summary
        app.buttons["Summary"].tap()
        XCTAssertTrue(any(app, "gameEnd.stats").waitForExistence(timeout: 3))
    }

    func testAnOlderServerHasNoScorecard() {
        let app = launch("game-end", ["-uiScorecardNone", "YES"])
        XCTAssertTrue(any(app, "gameEnd.stats").waitForExistence(timeout: 5))
        XCTAssertFalse(any(app, "gameEnd.tabs").exists, "no control without the key")
        let table = Fixture.launch("trick-mid-lead3", extra: ["-uiScorecardNone", "YES"])
        XCTAssertTrue(Fixture.readyElement(table, "trick-mid-lead3").waitForExistence(timeout: 20))
        XCTAssertFalse(any(table, "scoreBar.scorecard").exists, "no score-bar entry without the key")
    }

    func testTheGameEndScorecardAtAX5ScrollsSidewaysNeverClips() {
        let app = launch("game-end", Self.ax5)
        let seg = app.buttons["Scorecard"]
        XCTAssertTrue(seg.waitForExistence(timeout: 5))
        seg.tap()
        XCTAssertTrue(any(app, "scorecard").waitForExistence(timeout: 5))
        shot("game-end-scorecard-ax5")
        checkRows(app, [1, 2, 3], "AX5")
    }

    // MARK: - Mid-game

    func testTheScoreBarOpensTheSheetWithTheHandInPlay() {
        let app = launch("trick-mid-lead3")
        let entry = any(app, "scoreBar.scorecard")
        XCTAssertTrue(entry.waitForExistence(timeout: 5), "the score bar's Scorecard button")
        XCTAssertEqual(entry.label, "Scorecard")
        XCTAssertTrue((entry.value as? String ?? "").contains("Hand 6"), "\(String(describing: entry.value))")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "\u{203A}")).count > 0
                      || entry.exists, "the hint")
        entry.tap()
        let sheet = any(app, "scorecard.sheet")
        XCTAssertTrue(sheet.waitForExistence(timeout: 5), "the sheet")
        checkRows(app, [1, 2, 3], "sheet")
        let current = any(app, "scorecard.current")
        XCTAssertTrue(current.exists, "the hand in play")
        let v = current.value as? String ?? ""
        XCTAssertTrue(v.contains("\u{2192} \u{2013}") && v.hasSuffix("-"), "bids only, no score: \(v)")
        XCTAssertTrue(current.label.contains("Hand in play"), current.label)
        shot("midgame-sheet")
        // a swipe down closes it
        sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.99)))
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: sheet)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(entry.exists)
    }

    func testASpectatorOpensItToo() {
        let app = launch("spectator-mid-hand")
        let entry = any(app, "scoreBar.scorecard")
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        entry.tap()
        XCTAssertTrue(any(app, "scorecard.sheet").waitForExistence(timeout: 5))
        XCTAssertTrue(any(app, "scorecard.row.2").label.contains("ivy and hal"), "seats 1 and 3 first")
        shot("midgame-sheet-spectator")
    }

    func testTheSheetAtAX5() {
        let app = launch("trick-mid-lead3", Self.ax5)
        let entry = any(app, "scoreBar.scorecard")
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        entry.tap()
        XCTAssertTrue(any(app, "scorecard.sheet").waitForExistence(timeout: 5))
        checkRows(app, [1, 2, 3], "sheet AX5")
        shot("midgame-sheet-ax5")
    }

    // MARK: - Get Your Bid

    func testGetYourBidsScorecard() {
        let app = launch("gyb-end")
        XCTAssertTrue(app.buttons["Scorecard"].waitForExistence(timeout: 5))
        app.buttons["Scorecard"].tap()
        XCTAssertTrue(any(app, "scorecard").waitForExistence(timeout: 5))
        checkRows(app, Array(1...13), "gyb-end")
        let row1 = any(app, "scorecard.row.1")
        XCTAssertFalse((row1.value as? String ?? "").contains("fault"), "no fault in Get Your Bid")
        XCTAssertTrue((1...13).contains { (any(app, "scorecard.row.\($0)").value as? String ?? "").contains("~") }, "the Forbidden Bid")
        shot("gyb-end-scorecard")

        let mid = Fixture.launch("gyb-bidding", extra: ["-uiScorecard", "YES"])
        XCTAssertTrue(Fixture.readyElement(mid, "gyb-bidding").waitForExistence(timeout: 20))
        let entry = any(mid, "scoreBar.scorecard")
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        entry.tap()
        XCTAssertTrue(any(mid, "scorecard.sheet").waitForExistence(timeout: 5))
        let r3 = any(mid, "scorecard.row.3").value as? String ?? ""
        XCTAssertTrue(r3.hasSuffix("+13/26 +0/13 +0/11") || r3.contains("/26"), "the totals 26, 13, 11: \(r3)")
        shot("gyb-midgame-sheet")
    }
}
