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

    /// The main room's trophy, which opens this sheet.
    static func trophy(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "mainRoom.leaderboard", "Leaderboard")).firstMatch
    }

    private func openStats(_ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch("main-room", extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        // the trophy (owner 2026-11-26: "the trophy could be for the leaderboard/records")
        let stats = Self.trophy(app)
        XCTAssertTrue(stats.waitForExistence(timeout: 5))
        stats.tap()
        XCTAssertTrue(app.navigationBars["Stats"].waitForExistence(timeout: 5), "the trophy opens the Stats sheet")
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

    /// The Records tab has its data on screen: a period card (every layout shows one).
    @discardableResult
    private func waitForRecords(_ app: XCUIApplication, timeout: TimeInterval = 5) -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'records.period.'"))
            .firstMatch.waitForExistence(timeout: timeout)
    }

    /// The game count shown for `period` (allTime / thisYear / thisMonth): one card at a time
    /// shows the selected period's under the control ("records.total"; `title` is selected
    /// first), side by side or stacked cards each show their own ("records.count.<period>").
    /// nil when no count is shown for it.
    private func countLabel(_ app: XCUIApplication, _ period: String, title: String) -> String? {
        if app.segmentedControls["records.periods"].exists {
            showPeriod(app, title)
            let line = element(app, "records.total")
            return line.waitForExistence(timeout: 2) ? line.label : nil
        }
        let line = element(app, "records.count.\(period)")
        return line.exists ? line.label : nil
    }

    /// Waits until the All Time count reads `label` (a reply landing after a scope switch).
    private func waitForAllTimeCount(_ app: XCUIApplication, _ label: String, timeout: TimeInterval = 5) -> Bool {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "(identifier == 'records.total' OR identifier == 'records.count.allTime') AND label == %@", label))
            .firstMatch.waitForExistence(timeout: timeout)
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
        XCTAssertTrue(waitForRecords(app))
        XCTAssertTrue(waitForAllTimeCount(app, "1,234 games played"), "All Time's count")
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
        // superlatives (additive 2026-11-20): under the records, rendered from the reply alone
        XCTAssertTrue(allTime.descendants(matching: .any)["records.superlatives"].exists, "the Superlatives header")
        XCTAssertEqual(allTime.descendants(matching: .any)["records.superlative.bagBoy"].label, "Bag Boy, kim, 2.4 bags a game")
        XCTAssertEqual(allTime.descendants(matching: .any)["records.superlative.helpFromFriends"].label,
                       "A little help from my friends, ivy, 37 /help uses")
        XCTAssertFalse(allTime.descendants(matching: .any)["records.superlative.botFriends"].exists, "absent from the reply")
        XCTAssertEqual(allTime.descendants(matching: .any)["records.superlative.luckyBuck"].label, "Lucky Buck, kim, 3 wins in 7 cuts",
                       "a title the app has no code for shows as the server sent it")
        let anchor = allTime.descendants(matching: .any)["records.superlative.anchor"]
        for _ in 0..<4 where !anchor.isHittable { element(app, "records.list").swipeUp() }
        keepScreenshot(app, "stats-records-superlatives")
        element(app, "records.list").swipeDown()
        element(app, "records.list").swipeDown()
        // owner 2026-11-14: each period says its own count (the one total never changed)
        XCTAssertEqual(countLabel(app, "thisYear", title: "This Year"), "317 games played")
        if picker.exists { keepScreenshot(app, "stats-records-this-year") }
        XCTAssertEqual(countLabel(app, "thisMonth", title: "This Month"), "0 games played")
        XCTAssertEqual(countLabel(app, "allTime", title: "All Time"), "1,234 games played")
        showPeriod(app, "This Year")
        let thisYear = element(app, "records.period.thisYear")
        XCTAssertEqual(thisYear.descendants(matching: .any)["records.Most Bags"].label, "Most Bags, no games yet",
                       "legacy games have no bag records")
        XCTAssertEqual(thisYear.descendants(matching: .any)["records.superlative.bagBoy"].label,
                       "Bag Boy, hal, kim, ned, 2.1 bags a game (+2 more)", "a tie: names joined with commas")
        if picker.exists {
            let yearAnchor = thisYear.descendants(matching: .any)["records.superlative.anchor"]
            for _ in 0..<4 where !yearAnchor.isHittable { element(app, "records.list").swipeUp() }
            keepScreenshot(app, "stats-records-this-year-superlatives")
            element(app, "records.list").swipeDown()
            element(app, "records.list").swipeDown()
        }
        showPeriod(app, "This Month")
        let thisMonth = element(app, "records.period.thisMonth")
        XCTAssertFalse(thisMonth.descendants(matching: .any)["records.superlatives"].exists, "no games: no Superlatives section")
        XCTAssertTrue(thisMonth.staticTexts["This Month"].exists)
        XCTAssertTrue(thisMonth.staticTexts["No games yet"].exists, "a period without games")
        if picker.exists { keepScreenshot(app, "stats-records-this-month") }
        // the tab (and the period) is kept for the session
        app.buttons["stats.close"].tap()
        XCTAssertTrue(app.navigationBars["Stats"].waitForNonExistence(timeout: 5))
        Self.trophy(app).tap()
        XCTAssertTrue(waitForRecords(app), "reopens on Records")
        if picker.exists {
            XCTAssertTrue(picker.buttons["This Month"].isSelected, "and on the period last shown")
            XCTAssertEqual(element(app, "records.total").label, "0 games played", "with that period's count")
        }
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
        XCTAssertTrue(waitForRecords(app))
        XCTAssertTrue(scope.buttons["Bot games"].isSelected, "one choice for both tabs")
        XCTAssertTrue(waitForAllTimeCount(app, "6 games played"))
        XCTAssertFalse(element(app, "records.botsNote").exists, "the note is for an empty page")
        keepScreenshot(app, "stats-scope-bots-records")
        // the solo-games title appears only where the reply has it (Bots), rendered like any other
        XCTAssertEqual(element(app, "records.superlative.botFriends").label,
                       "Some of my best friends are bots, ora, 4 solo games")

        scope.buttons["All games"].tap()
        XCTAssertTrue(waitForAllTimeCount(app, "1,240 games played"), "All asks again")
        XCTAssertEqual(countLabel(app, "thisYear", title: "This Year"), "323 games played")
        XCTAssertEqual(countLabel(app, "thisMonth", title: "This Month"), "6 games played")
        showPeriod(app, "All Time")
        app.terminate()

        app = Fixture.launch("main-room", extra: ["-uiStatsKeepScope", "YES"])
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        Self.trophy(app).tap()
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

    /// A server from before periodGames: All Time keeps the all-time total; This Year and This
    /// Month show no count rather than the all-time one.
    func testRecordsWithoutPeriodGames() {
        let app = openStats(["-uiStats", "noPeriodGames"])
        app.segmentedControls["stats.tabs"].buttons["Records"].tap()
        XCTAssertTrue(waitForRecords(app))
        XCTAssertTrue(waitForAllTimeCount(app, "1,234 games played"))
        XCTAssertNil(countLabel(app, "thisYear", title: "This Year"), "no count known for This Year")
        XCTAssertTrue(element(app, "records.period.thisYear").exists, "the records still show")
        XCTAssertNil(countLabel(app, "thisMonth", title: "This Month"))
        XCTAssertEqual(countLabel(app, "allTime", title: "All Time"), "1,234 games played")
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
        XCTAssertTrue(waitForAllTimeCount(app, "0 games played"))
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
        XCTAssertTrue(waitForRecords(app))
        XCTAssertTrue(waitForAllTimeCount(app, "0 games played"))
        if app.segmentedControls["records.periods"].exists {
            for title in ["All Time", "This Year", "This Month"] {
                showPeriod(app, title)
                XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "No games yet")).count, 1, title)
                XCTAssertEqual(element(app, "records.total").label, "0 games played", title)
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
        XCTAssertTrue(waitForRecords(app))
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

    /// The Records tab at the largest accessibility size: the cards stack (no period control) and
    /// every superlative row is reachable, inside the window's width (it wraps, never runs off
    /// the side) and keeps its one VoiceOver label.
    func testRecordsSuperlativesLargeType() {
        let app = openStats(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        app.segmentedControls["stats.tabs"].buttons["Records"].tap()
        XCTAssertTrue(waitForRecords(app))
        XCTAssertFalse(app.segmentedControls["records.periods"].exists, "accessibility sizes stack the cards")
        let window = app.windows.firstMatch.frame
        let allTime = element(app, "records.period.allTime")
        let expected = [
            ("bagBoy", "Bag Boy, kim, 2.4 bags a game"),
            ("luckyDuck", "Lucky Duck, ora, 141.2 avg HSI"),
            ("cursed", "Cursed, jon, 98.7 avg HSI"),
            ("helpFromFriends", "A little help from my friends, ivy, 37 /help uses"),
            ("anchor", "Anchor, hal, 31% of hands set"),
            // the Cut for a buck title (1.2.7 server), drawn generically like the rest
            ("luckyBuck", "Lucky Buck, kim, 3 wins in 7 cuts"),
        ]
        var shot = false
        for (id, label) in expected {
            let row = allTime.descendants(matching: .any)["records.superlative.\(id)"]
            for _ in 0..<12 where !row.isHittable { element(app, "records.list").swipeUp() }
            XCTAssertTrue(row.isHittable, "\(id) reachable")
            XCTAssertEqual(row.label, label)
            XCTAssertGreaterThanOrEqual(row.frame.minX, window.minX, "\(id) inside the window")
            XCTAssertLessThanOrEqual(row.frame.maxX, window.maxX, "\(id) inside the window")
            if id == "helpFromFriends", !shot { keepScreenshot(app, "stats-records-superlatives-ax5"); shot = true }
        }
        let tie = element(app, "records.period.thisYear").descendants(matching: .any)["records.superlative.bagBoy"]
        for _ in 0..<12 where !tie.isHittable { element(app, "records.list").swipeUp() }
        XCTAssertEqual(tie.label, "Bag Boy, hal, kim, ned, 2.1 bags a game (+2 more)")
        XCTAssertLessThanOrEqual(tie.frame.maxX, window.maxX)
        // short drags until the whole tie (names and the wrapped detail) is on screen for the shot
        let list = element(app, "records.list")
        for _ in 0..<6 where tie.frame.maxY > window.maxY - 40 {
            let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -220)))
        }
        keepScreenshot(app, "stats-records-superlatives-ax5-tie")
        app.terminate()
    }

    /// The sheet's controls stay out of the vertical bar's column (the Duo closed / open landscape).
    func testSheetClearOfVerticalBar() {
        let app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        sleep(1)
        let pose = Fixture.probe(app, "ui.pose")  // read before the sheet covers the probes
        Self.trophy(app).tap()
        XCTAssertTrue(element(app, "leaderboard.row.kim").waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["stats.close"].isHittable, "the close button")
        guard let edge = pose.split(separator: " ").last, edge != "-", pose.contains(" vbar "),
              let size = Fixture.windowSize(pose), let insets = Fixture.insets(pose) else { app.terminate(); return }
        let column: ClosedRange<CGFloat> = edge == "leading" ? 0...insets.left : (size.width - insets.right)...size.width
        keepScreenshot(app, "stats-vbar")
        // the main room's own bar items stay in the column beside the sheet (LobbyControlsTests)
        let barItems = ["New Game", "online", "Account settings"]
        for e in app.buttons.allElementsBoundByIndex where e.exists && !e.frame.isEmpty && e.identifier != "stats.close"
            && e.identifier != "mainRoom.leaderboard" && !barItems.contains(where: { e.label.contains($0) }) {
            let f = e.frame
            XCTAssertFalse(f.maxX > column.lowerBound + 1 && f.minX < column.upperBound - 1,
                           "\(e.label) at \(f) reaches into the vertical bar \(column)")
        }
        app.terminate()
    }
}
