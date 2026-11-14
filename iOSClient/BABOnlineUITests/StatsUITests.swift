import XCTest

/// The main room's Stats sheet in fixture mode (`-uiFixture main-room`; the replies come from
/// UIFixture+Stats, `-uiStats` picks them): the Leaderboard tab with the web's columns, sort
/// and population row, the Records tab with the web's periods and labels, and the loading,
/// empty, error, rate-limited and failed-refresh states. Runs on any device: the iPad (and
/// regular width with standard type) shows the table, phones and the Duo the list.
final class StatsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func openStats(_ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch("main-room", extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        let stats = app.buttons.matching(NSPredicate(format: "label == %@", "Stats")).firstMatch
        XCTAssertTrue(stats.waitForExistence(timeout: 5))
        stats.tap()
        XCTAssertTrue(app.navigationBars["Stats"].waitForExistence(timeout: 5), "Stats opens the Stats sheet")
        return app
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    /// Row identifiers top to bottom.
    private func rowOrder(_ app: XCUIApplication) -> [String] {
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'leaderboard.row.'"))
            .allElementsBoundByIndex.filter { $0.exists && !$0.frame.isEmpty }
        var seen = Set<String>()
        return rows.sorted { $0.frame.minY < $1.frame.minY }.compactMap {
            let id = String($0.identifier.dropFirst("leaderboard.row.".count))
            return seen.insert(id).inserted ? id : nil
        }
    }

    private func isTable(_ app: XCUIApplication) -> Bool {
        element(app, "leaderboard.sort.winRate").exists
    }

    /// Sorts by `column` the way the layout offers it: a header tap, or the menu.
    private func sort(_ app: XCUIApplication, _ column: String, title: String) {
        if isTable(app) {
            element(app, "leaderboard.sort.\(column)").tap()
        } else {
            element(app, "leaderboard.sortMenu").tap()
            let item = app.buttons[title].firstMatch
            XCTAssertTrue(item.waitForExistence(timeout: 3), "menu item \(title)")
            item.tap()
        }
        sleep(1)
    }

    private func flipOrder(_ app: XCUIApplication, _ column: String) {
        if isTable(app) { element(app, "leaderboard.sort.\(column)").tap() } else { element(app, "leaderboard.sortOrder").tap() }
        sleep(1)
    }

    /// Shows `title`'s card: a segment tap where one card fits across (phones), else nothing
    /// (every card is on screen).
    private func showPeriod(_ app: XCUIApplication, _ title: String) {
        let picker = app.segmentedControls["records.periods"]
        if picker.exists {
            picker.buttons[title].tap()
            XCTAssertTrue(picker.buttons[title].isSelected, title)
        }
    }

    private func keepScreenshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testLeaderboardRowsColumnsAndSort() {
        let app = openStats()
        XCTAssertTrue(app.segmentedControls["stats.tabs"].buttons["Leaderboard"].isSelected, "Leaderboard is the first tab")
        XCTAssertTrue(element(app, "leaderboard.row.kim").waitForExistence(timeout: 5), "rows from the reply")
        keepScreenshot(app, "stats-leaderboard")
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCTAssertTrue(isTable(app), "the iPad shows the eight-column table")
        }
        // the server's order is win rate descending; the population row sits among the players,
        // unranked; a row with only a name is kept (zeros), a row without one dropped
        XCTAssertEqual(Array(rowOrder(app).prefix(5)), ["Christopher Johnson1", "kim", "ivy", "max", "population"])
        XCTAssertTrue(element(app, "leaderboard.row.pat").exists, "a row with only its name")
        XCTAssertEqual(element(app, "leaderboard.row.population").label, "Population average")
        XCTAssertEqual(element(app, "leaderboard.row.kim").label, "Rank 2, kim")
        XCTAssertEqual(element(app, "leaderboard.row.ivy").label, "Rank 3, ivy, you", "the signed-in player")
        XCTAssertEqual(element(app, "leaderboard.row.hal").label, "Rank 5, hal", "the population row takes no rank")

        // Set % sorts ascending first (the web's defaultAscending), a second tap flips it
        sort(app, "setRate", title: "Set %")
        XCTAssertEqual(rowOrder(app).first, "pat", "set rate ascending: 0.0% first")
        flipOrder(app, "setRate")
        XCTAssertEqual(rowOrder(app).first, "jon", "set rate descending: 17.8% first")
        // Games sorts descending first
        sort(app, "gamesPlayed", title: "Games")
        XCTAssertEqual(rowOrder(app).first, "ivy", "games descending: 51 first")

        if isTable(app) {
            XCTAssertTrue(element(app, "leaderboard.sort.gamesPlayed").isSelected, "the sorted header is selected")
            // each header sits over its column: the rows' cells end 24 pt in from the list's
            // edge (the card's 16 pt inset, the row's own 8 pt), and so must the last header;
            // the first starts where the eight equal columns start
            let list = element(app, "leaderboard.list").frame
            let first = element(app, "leaderboard.sort.gamesPlayed").frame, last = element(app, "leaderboard.sort.avgHSI").frame
            XCTAssertEqual(last.maxX, list.maxX - 24, accuracy: 1, "HSI header over its column (\(last) in \(list))")
            XCTAssertEqual(first.minX, last.maxX - first.width * 8, accuracy: 1, "Games header over its column")
            XCTAssertTrue(element(app, "leaderboard.row.kim").value.map { "\($0)" }?.contains("Tricks per bid 1.05") == true)
        } else {
            // a list row expands to every column
            element(app, "leaderboard.row.kim").tap()
            let details = element(app, "leaderboard.details.kim")
            XCTAssertTrue(details.waitForExistence(timeout: 3), "the row expands")
            for label in ["Games played 42", "Win rate 64.3%", "Points per game 225.0", "Bids per game 12.4",
                          "Tricks per bid 1.05", "Set rate 11.2%", "Drag 58.1", "Hand strength index 7.7"] {
                XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).count > 0, label)
            }
            keepScreenshot(app, "stats-leaderboard-expanded")
        }
        app.terminate()
    }

    func testRecordsTab() {
        let app = openStats()
        app.segmentedControls["stats.tabs"].buttons["Records"].tap()
        let total = element(app, "records.total")
        XCTAssertTrue(total.waitForExistence(timeout: 5))
        XCTAssertEqual(total.label, "1,234 games played")
        let picker = app.segmentedControls["records.periods"]
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCTAssertFalse(picker.exists, "the iPad shows the three cards side by side")
            for period in ["allTime", "thisYear", "thisMonth"] {
                XCTAssertTrue(element(app, "records.period.\(period)").exists, period)
            }
        } else {
            XCTAssertTrue(picker.exists, "phones show one period at a time")
            XCTAssertTrue(picker.buttons["All Time"].isSelected, "All Time first, as the web")
            XCTAssertFalse(element(app, "records.period.thisMonth").exists, "one card at a time")
        }
        let allTime = element(app, "records.period.allTime")
        XCTAssertTrue(allTime.staticTexts["All Time"].exists)
        XCTAssertEqual(allTime.descendants(matching: .any)["records.Highest Score"].label, "Highest Score, 610 pts, kim & ora")
        XCTAssertEqual(allTime.descendants(matching: .any)["records.Lowest Score"].label, "Lowest Score, -240 pts, jon & pat")
        XCTAssertEqual(allTime.descendants(matching: .any)["records.Biggest Win"].label,
                       "Biggest Win, 705 pt margin, 610 - -95, winners kim & ora, losers pat & hal")
        XCTAssertEqual(allTime.descendants(matching: .any)["records.Least Bags"].label, "Least Bags, 0 bags, jon & hal")
        keepScreenshot(app, "stats-records")
        showPeriod(app, "This Year")
        let thisYear = element(app, "records.period.thisYear")
        XCTAssertEqual(thisYear.descendants(matching: .any)["records.Most Bags"].label, "Most Bags, no games yet",
                       "legacy games have no bag records")
        showPeriod(app, "This Month")
        let thisMonth = element(app, "records.period.thisMonth")
        XCTAssertTrue(thisMonth.staticTexts["This Month"].exists)
        XCTAssertTrue(thisMonth.staticTexts["No games yet"].exists, "a period without games")
        if picker.exists { keepScreenshot(app, "stats-records-this-month") }
        // the tab (and the period) is kept for the session
        app.buttons["stats.close"].tap()
        XCTAssertTrue(app.navigationBars["Stats"].waitForNonExistence(timeout: 5))
        app.buttons.matching(NSPredicate(format: "label == %@", "Stats")).firstMatch.tap()
        XCTAssertTrue(element(app, "records.total").waitForExistence(timeout: 5), "reopens on Records")
        if picker.exists { XCTAssertTrue(picker.buttons["This Month"].isSelected, "and on the period last shown") }
        app.terminate()
    }

    /// Humans / Bots / All: one control for both tabs, Humans first, each scope's numbers
    /// (UIFixture+Stats), the choice kept across launches.
    func testScopePicker() {
        var app = openStats()
        let scope = app.segmentedControls["stats.scope"]
        XCTAssertTrue(scope.waitForExistence(timeout: 5))
        XCTAssertEqual(scope.buttons.count, 3)
        XCTAssertTrue(scope.buttons["Human games"].isSelected, "Humans by default (VoiceOver: Human games)")
        XCTAssertTrue(scope.buttons["Bot games"].exists)
        XCTAssertTrue(scope.buttons["All games"].exists)
        XCTAssertTrue(element(app, "leaderboard.row.ivy").waitForExistence(timeout: 5))
        keepScreenshot(app, "stats-scope-humans")

        scope.buttons["Bot games"].tap()
        XCTAssertTrue(element(app, "leaderboard.row.ora").waitForExistence(timeout: 5), "the bot-game rows")
        XCTAssertFalse(element(app, "leaderboard.row.ivy").exists, "no human-game row under Bots")
        keepScreenshot(app, "stats-scope-bots")
        app.segmentedControls["stats.tabs"].buttons["Records"].tap()
        let total = element(app, "records.total")
        XCTAssertTrue(total.waitForExistence(timeout: 5))
        XCTAssertTrue(scope.buttons["Bot games"].isSelected, "one choice for both tabs")
        XCTAssertEqual(total.label, "6 games played")
        XCTAssertFalse(element(app, "records.botsNote").exists, "the note is for an empty page")
        keepScreenshot(app, "stats-scope-bots-records")

        scope.buttons["All games"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'records.total' AND label == '1,240 games played'"))
            .firstMatch.waitForExistence(timeout: 5), "All asks again")
        app.terminate()

        app = Fixture.launch("main-room", extra: ["-uiStatsKeepScope", "YES"])
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        app.buttons.matching(NSPredicate(format: "label == %@", "Stats")).firstMatch.tap()
        XCTAssertTrue(app.segmentedControls["stats.scope"].buttons["All games"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.segmentedControls["stats.scope"].buttons["All games"].isSelected, "the choice is saved")
        XCTAssertTrue(element(app, "leaderboard.row.ora").waitForExistence(timeout: 5), "All's rows: human and bot games")
        XCTAssertTrue(element(app, "leaderboard.row.ivy").exists)
        app.terminate()
    }

    /// A slow Humans reply (no echo, as the scoped server answers a request without a payload)
    /// that lands after the switch to Bots stays on Humans: Bots keeps its own rows, and Humans
    /// shows its rows when selected again, with no "didn't answer" error.
    func testLateHumansReplyStaysOnHumans() {
        let app = openStats(["-uiStatsHumanDelay", "3"])
        let scope = app.segmentedControls["stats.scope"]
        XCTAssertTrue(scope.waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "leaderboard.row.ivy").exists, "Humans is still waiting")
        scope.buttons["Bot games"].tap()
        XCTAssertTrue(element(app, "leaderboard.row.ora").waitForExistence(timeout: 5), "the bot-game rows")
        // the Humans reply lands about 3 s after the sheet opened
        XCTAssertFalse(element(app, "leaderboard.row.ivy").waitForExistence(timeout: 5), "no human-game row under Bots")
        XCTAssertTrue(element(app, "leaderboard.row.ora").exists)
        scope.buttons["Human games"].tap()
        XCTAssertTrue(element(app, "leaderboard.row.ivy").waitForExistence(timeout: 5), "the late reply filled Humans")
        XCTAssertFalse(element(app, "leaderboard.row.ora").exists)
        XCTAssertFalse(element(app, "stats.error").exists)
        app.terminate()
    }

    /// Bots with no games yet: bot games count from the server update on.
    func testScopeEmptyStates() {
        let app = openStats(["-uiStats", "empty"])
        let scope = app.segmentedControls["stats.scope"]
        XCTAssertTrue(scope.waitForExistence(timeout: 5))
        scope.buttons["Bot games"].tap()
        XCTAssertTrue(app.staticTexts["No Bot Games Yet"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Games with bots count from this update on."].exists)
        keepScreenshot(app, "stats-scope-bots-empty")
        app.segmentedControls["stats.tabs"].buttons["Records"].tap()
        XCTAssertTrue(element(app, "records.botsNote").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "records.total").label, "0 games played")
        scope.buttons["Human games"].tap()
        XCTAssertTrue(element(app, "records.botsNote").waitForNonExistence(timeout: 5), "no note under Humans")
        app.terminate()
    }

    func testEmptyStates() {
        let app = openStats(["-uiStats", "empty"])
        let empty = element(app, "stats.empty")
        XCTAssertTrue(empty.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No players have completed games yet."].exists)
        app.segmentedControls["stats.tabs"].buttons["Records"].tap()
        XCTAssertTrue(element(app, "records.total").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "records.total").label, "0 games played")
        if app.segmentedControls["records.periods"].exists {
            for title in ["All Time", "This Year", "This Month"] {
                showPeriod(app, title)
                XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "No games yet")).count, 1, title)
            }
        } else {
            XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "No games yet")).count, 3)
        }
        app.terminate()
    }

    /// The sheet rebuilds a tab on every switch: the sort (and an expanded list row) stay.
    func testSortSurvivesATabSwitch() {
        let app = openStats()
        XCTAssertTrue(element(app, "leaderboard.row.kim").waitForExistence(timeout: 5))
        sort(app, "setRate", title: "Set %")
        XCTAssertEqual(rowOrder(app).first, "pat", "set rate ascending")
        let table = isTable(app)
        if !table {
            element(app, "leaderboard.row.kim").tap()
            XCTAssertTrue(element(app, "leaderboard.details.kim").waitForExistence(timeout: 3))
        }
        let tabs = app.segmentedControls["stats.tabs"]
        tabs.buttons["Records"].tap()
        XCTAssertTrue(element(app, "records.total").waitForExistence(timeout: 5))
        tabs.buttons["Leaderboard"].tap()
        XCTAssertTrue(element(app, "leaderboard.row.kim").waitForExistence(timeout: 5))
        XCTAssertEqual(rowOrder(app).first, "pat", "still sorted by set rate, ascending")
        if table {
            XCTAssertTrue(element(app, "leaderboard.sort.setRate").isSelected)
        } else {
            XCTAssertEqual(element(app, "leaderboard.sortMenu").value as? String, "Set rate")
            XCTAssertTrue(element(app, "leaderboard.details.kim").exists, "the expanded row stays open")
        }
        app.terminate()
    }

    func testErrorAndRateLimitedStates() {
        var app = openStats(["-uiStats", "error"])
        let error = element(app, "stats.error")
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Couldn't Load Leaderboard"].exists)
        XCTAssertTrue(app.staticTexts["Database error"].exists, "the server's message")
        XCTAssertTrue(app.buttons["Try Again"].isHittable)
        keepScreenshot(app, "stats-error")
        app.segmentedControls["stats.tabs"].buttons["Records"].tap()
        XCTAssertTrue(app.staticTexts["Couldn't Load Records"].waitForExistence(timeout: 5))
        app.terminate()

        app = openStats(["-uiStats", "rateLimited"])
        XCTAssertTrue(element(app, "stats.rateLimited").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Too Many Requests"].exists)
        app.terminate()
    }

    /// No answer: the spinner, then after the 10 s timeout an error with Try Again.
    func testLoadingThenTimeout() {
        let app = openStats(["-uiStats", "silent"])
        XCTAssertTrue(element(app, "stats.loading").waitForExistence(timeout: 3), "loading state")
        XCTAssertTrue(element(app, "stats.error").waitForExistence(timeout: 15), "timeout error")
        XCTAssertTrue(app.staticTexts["The server didn't answer. Check your connection and try again."].exists)
        app.terminate()
    }

    /// A failed refresh keeps the rows and says so above them; pull to refresh asks again.
    func testFailedRefreshKeepsRows() {
        let app = openStats(["-uiStats", "refreshFail"])
        XCTAssertTrue(element(app, "leaderboard.row.kim").waitForExistence(timeout: 5))
        // a quick pull (a slow drag of the same length does not reach the refresh threshold on the iPad)
        let start = element(app, "leaderboard.list").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        start.press(forDuration: 0, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 500)))
        XCTAssertTrue(element(app, "stats.refreshError").waitForExistence(timeout: 5), "the failed refresh is shown")
        XCTAssertTrue(element(app, "leaderboard.row.kim").exists, "the rows stay")
        keepScreenshot(app, "stats-refresh-failed")
        app.terminate()
    }

    /// Accessibility type: the list (never the eight-column table), every row reachable, and
    /// where the system shows the Duo's vertical bar no sheet control reaches into it.
    func testLargeTypeUsesTheList() {
        let app = openStats(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
        XCTAssertTrue(element(app, "leaderboard.row.kim").waitForExistence(timeout: 5))
        XCTAssertFalse(isTable(app), "no table at accessibility sizes")
        XCTAssertTrue(element(app, "leaderboard.sortMenu").isHittable)
        keepScreenshot(app, "stats-large-type")
        // the sort bar is not pinned at these sizes: it scrolls away with the rows
        let bar = element(app, "leaderboard.sortMenu").frame.minY
        element(app, "leaderboard.list").swipeUp()
        sleep(1)
        let menu = element(app, "leaderboard.sortMenu")
        XCTAssertTrue(!menu.exists || menu.frame.minY < bar - 100, "the sort bar scrolled with the rows")
        app.terminate()
    }

    /// The sheet's controls stay out of the vertical bar's column (the Duo closed / open landscape).
    func testSheetClearOfVerticalBar() {
        let app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        sleep(1)
        let pose = Fixture.probe(app, "ui.pose")  // read before the sheet covers the probes
        app.buttons.matching(NSPredicate(format: "label == %@", "Stats")).firstMatch.tap()
        XCTAssertTrue(element(app, "leaderboard.row.kim").waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["stats.close"].isHittable, "the close button")
        guard let edge = pose.split(separator: " ").last, edge != "-", pose.contains(" vbar "),
              let size = Fixture.windowSize(pose), let insets = Fixture.insets(pose) else { app.terminate(); return }
        let column: ClosedRange<CGFloat> = edge == "leading" ? 0...insets.left : (size.width - insets.right)...size.width
        keepScreenshot(app, "stats-vbar")
        // the main room's own bar items stay in the column beside the sheet (LobbyControlsTests)
        let barItems = ["New Game", "Tournament", "Stats", "online", "Account settings"]
        for e in app.buttons.allElementsBoundByIndex where e.exists && !e.frame.isEmpty && e.identifier != "stats.close"
            && !barItems.contains(where: { e.label.contains($0) }) {
            let f = e.frame
            XCTAssertFalse(f.maxX > column.lowerBound + 1 && f.minX < column.upperBound - 1,
                           "\(e.label) at \(f) reaches into the vertical bar \(column)")
        }
        app.terminate()
    }
}
