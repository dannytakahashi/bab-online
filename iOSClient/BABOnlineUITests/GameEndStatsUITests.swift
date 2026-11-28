import XCTest

/// The game-end screen shows each player's stats as the web's score modal does (owner,
/// 2026-11-13: "in the web client when the game ends it shows game stats ... but you don't
/// see this in the ios client"). Fixtures: `game-end` (seat 4, kim's casual game, the App
/// Store 05-game-end shot), `game-end-spectator`, `game-end-tournament`; `-uiNoEndStats YES`
/// sends a gameEnd without them (an older server).
final class GameEndStatsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    /// The fixture's seats (hand-resolving: ivy, kim, hal, jon) and their UIFixture totals.
    static let expected = [
        1: "ivy: 23 bids, 24 tricks, 1 fault, average HSI 120",
        2: "kim: 19 bids, 17 tricks, 3 faults, average HSI 104",
        3: "hal: 21 bids, 25 tricks, 0 faults, average HSI 131",
        4: "jon: 18 bids, 18 tricks, 2 faults, average HSI 97",
    ]

    private func launch(_ fixture: String, extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20), "\(fixture) did not come up")
        return app
    }

    private func row(_ app: XCUIApplication, _ pos: Int) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "gameEnd.stats.\(pos)").firstMatch
    }

    /// The results' own scroll view (the one holding the card). Swipe it, never the application:
    /// on the open Duo XCUIApplication's frame is the inner screen's portrait 669x951 while the
    /// window is landscape 951x669, so `app.swipeUp()` is placed on a frame that is not the
    /// window's and never scrolls the results (the card stayed put through 14 of them at AX5),
    /// while the same swipe on the window or this scroll view moves it a screen at a time. A
    /// person's swipe scrolls it on every device; this was the test's reach, not the screen's.
    private func scroller(_ app: XCUIApplication) -> XCUIElement {
        app.scrollViews.containing(.any, identifier: "gameEnd").firstMatch
    }

    /// Scroll the results until `e` can be tapped (up to `tries` swipes each way, `up` first).
    @discardableResult
    private func reveal(_ app: XCUIApplication, _ e: XCUIElement, up: Bool = true, tries: Int = 8) -> Bool {
        let s = scroller(app)
        for _ in 0..<tries where !e.isHittable { up ? s.swipeUp() : s.swipeDown() }
        for _ in 0..<tries where !e.isHittable { up ? s.swipeDown() : s.swipeUp() }
        return e.isHittable
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// One element per player, read as one sentence, inside the card and the window, in seat order.
    private func checkRows(_ app: XCUIApplication, _ tag: String, names: [Int: String]? = nil) {
        let card = app.descendants(matching: .any)["gameEnd"].frame
        let window = app.windows.firstMatch.frame
        var lastY = -CGFloat.infinity
        for pos in 1...4 {
            let e = row(app, pos)
            XCTAssertTrue(e.waitForExistence(timeout: 5), "\(tag): no stats row for seat \(pos)")
            guard e.exists else { continue }
            if let names {
                XCTAssertTrue(e.label.hasPrefix("\(names[pos]!): "), "\(tag) seat \(pos): \(e.label)")
                XCTAssertFalse(e.label.contains("team"), "\(tag) seat \(pos): never a team number: \(e.label)")
                XCTAssertTrue(e.label.range(of: #"\d+ bids?, \d+ tricks?, \d+ faults?, average HSI "#, options: .regularExpression) != nil, "\(tag): \(e.label)")
            } else {
                XCTAssertEqual(e.label, Self.expected[pos], "\(tag) seat \(pos)")
            }
            XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "gameEnd.stats.\(pos)").count, 1,
                           "\(tag): seat \(pos) is one element")
            let f = e.frame
            XCTAssertGreaterThan(f.minY, lastY, "\(tag): seat order")
            lastY = f.minY
            XCTAssertTrue(card.insetBy(dx: -1, dy: -1).contains(CGRect(x: f.minX, y: card.minY, width: f.width, height: 1)),
                          "\(tag): seat \(pos) row \(f) outside the card \(card)")
            XCTAssertGreaterThanOrEqual(f.minX, window.minX - 1, tag)
            XCTAssertLessThanOrEqual(f.maxX, window.maxX + 1, tag)
        }
    }

    func testSeatSeesEachPlayersStats() {
        let app = launch("game-end")
        sleep(1)
        attach(app, "game-end")
        checkRows(app, "game-end")
        // everything the screen showed before stays
        XCTAssertTrue(app.staticTexts["Defeat"].exists, "seat 4 is team 2: 287 to 312")
        for t in ["312", "287", "vs"] { XCTAssertTrue(app.staticTexts[t].exists, t) }
        // each team by its names, no "Team 1" heading (owner 2026-11-17)
        XCTAssertFalse(app.staticTexts["Team 1"].exists || app.staticTexts["Team 2"].exists, "a team number heading")
        for id in ["gameEnd.team1Names", "gameEnd.team2Names"] {
            let names = app.staticTexts[id]
            XCTAssertTrue(names.exists, id)
            XCTAssertTrue(names.label.contains(" and "), "\(id): \(names.label)")
        }
        XCTAssertTrue(app.buttons["Return to Lobby"].isHittable)
        // and in landscape (the iPad and the open Duo turn; a phone stays portrait: AppDelegate.mask)
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        attach(app, "game-end-landscape")
        checkRows(app, "game-end landscape")
        XCTAssertTrue(reveal(app, app.buttons["Return to Lobby"]), "Return to Lobby reachable in landscape")
    }

    func testSpectatorSeesTheSameStats() {
        let app = launch("game-end-spectator")
        sleep(1)
        attach(app, "game-end-spectator")
        XCTAssertTrue(app.staticTexts["Game Over"].exists)
        checkRows(app, "spectator")
    }

    func testTournamentGameKeepsItsReturn() {
        let app = launch("game-end-tournament")
        sleep(1)
        attach(app, "game-end-tournament")
        checkRows(app, "tournament", names: [1: "🤖 Mike", 2: "T1_u1", 3: "🤖 Mary", 4: "🤖 Sharon"])
        XCTAssertTrue(app.buttons["Return to Tournament"].isHittable)
        XCTAssertFalse(app.buttons["Return to Lobby"].exists)
    }

    /// An older server (or a gameEnd without the totals): the names alone, every value a dash.
    func testNoTotalsShowDashes() {
        let app = launch("game-end", extra: ["-uiNoEndStats", "YES"])
        XCTAssertTrue(row(app, 1).waitForExistence(timeout: 5))
        XCTAssertEqual(row(app, 1).label, "ivy: – bids, – tricks, – faults, average HSI –")
        XCTAssertTrue(app.staticTexts["312"].exists)
        XCTAssertTrue(app.buttons["Return to Lobby"].isHittable)
    }

    /// The largest text sizes: the largest standard one (the table, or the stacked rows where it
    /// does not fit) and the largest accessibility one (stacked): every row reads its sentence,
    /// stays inside the window, and the card scrolls to the button; the Summary | Scorecard
    /// control scrolls back into reach, and the scorecard's results scroll to the button too
    /// (the open Duo in landscape is the shortest: 669 pt).
    func testLargestTextSizesStayReadableAndReachable() {
        for (tag, category) in [("xxxl", "UICTContentSizeCategoryXXXL"), ("ax5", "UICTContentSizeCategoryAccessibilityXXXL")] {
            // -uiScorecard YES: the scorecard's 13 hands (the stats rows are the fixture's either way)
            let app = launch("game-end", extra: ["-UIPreferredContentSizeCategoryName", category, "-uiScorecard", "YES"])
            sleep(1)
            attach(app, "game-end-\(tag)")
            let window = app.windows.firstMatch.frame
            for pos in 1...4 {
                let e = row(app, pos)
                reveal(app, e)
                XCTAssertTrue(e.isHittable, "\(tag) seat \(pos) scrolled into reach")
                XCTAssertEqual(e.label, Self.expected[pos], "\(tag) seat \(pos)")
                XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "gameEnd.stats.\(pos)").count, 1, "\(tag) seat \(pos)")
                XCTAssertGreaterThanOrEqual(e.frame.minX, window.minX - 1, "\(tag) seat \(pos) inside the window")
                XCTAssertLessThanOrEqual(e.frame.maxX, window.maxX + 1, "\(tag) seat \(pos) inside the window")
            }
            let button = app.buttons["Return to Lobby"]
            XCTAssertTrue(reveal(app, button), "Return to Lobby reachable at \(tag)")
            attach(app, "game-end-\(tag)-return")
            // back up to the Summary | Scorecard control, then the scorecard's way to the button
            let scorecard = app.descendants(matching: .any)["gameEnd.tabs"].buttons["Scorecard"]
            XCTAssertTrue(reveal(app, scorecard, up: false), "Summary | Scorecard reachable at \(tag)")
            scorecard.tap()
            XCTAssertTrue(app.descendants(matching: .any)["scorecard.row.13"].waitForExistence(timeout: 3), "\(tag): the scorecard shows")
            XCTAssertTrue(reveal(app, button), "Return to Lobby reachable from the scorecard at \(tag)")
            attach(app, "game-end-\(tag)-scorecard-return")
            app.terminate()
        }
    }
}
