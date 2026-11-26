import XCTest

/// Get Your Bid on iOS (State/Table/GetYourBid.swift; fixtures UIFixture+GetYourBid.swift): the
/// lobby option, the lists, the three-seat lobby, the three-seat table, the bid sheet's
/// Forbidden Bid and the game-end screen's per-player results. Runs on phones and the iPad.
final class GybUITests: XCTestCase {
    static let ax5 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

    override func setUp() {
        continueAfterFailure = false
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private func launchTable(_ fixture: String, extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: extra)
        let ready = fixture == "gyb-end" ? any(app, "gameEnd") : app.buttons["leave"]
        XCTAssertTrue(ready.waitForExistence(timeout: 15), "\(fixture) did not come up")
        return app
    }

    /// The window's frame (everything shown must be inside it).
    private func window(_ app: XCUIApplication) -> CGRect { app.windows.firstMatch.frame }

    // MARK: - The lobby option

    func testNewGameOffersBothGames() throws {
        for (choice, sent) in [("Get Your Bid", "createLobby:gyb"), ("Back Alley Bridge", "createLobby")] {
            let app = Fixture.launch("main-room")
            XCTAssertTrue(any(app, "screen.mainRoom").waitForExistence(timeout: 15))
            let newGame = app.buttons["New Game"].firstMatch
            XCTAssertTrue(newGame.waitForExistence(timeout: 5))
            newGame.tap()
            let button = app.buttons[choice].firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 5), "New Game offers \(choice)")
            XCTAssertTrue(app.buttons["Get Your Bid"].exists && app.buttons["Back Alley Bridge"].exists)
            button.tap()
            let deadline = Date().addingTimeInterval(5)
            while Fixture.probe(app, "fixture.sent") != sent && Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
            XCTAssertEqual(Fixture.probe(app, "fixture.sent"), sent)
            app.terminate()
        }
    }

    func testTheListsShowAGybLobbyAndATable() {
        let app = Fixture.launch("main-room-gyb")
        XCTAssertTrue(any(app, "screen.mainRoom").waitForExistence(timeout: 15))
        XCTAssertTrue(any(app, "lobbyCard.l-gyb").waitForExistence(timeout: 5))
        XCTAssertTrue(any(app, "lobbyCard.l-gyb").label.contains("Get Your Bid"), any(app, "lobbyCard.l-gyb").label)
        let table = any(app, "lobbyCard.g-gyb")
        XCTAssertTrue(table.waitForExistence(timeout: 5))
        XCTAssertTrue(table.label.contains("ora 26, max 13, pat 0"), table.label)
        XCTAssertTrue(app.staticTexts["ora 26 \u{00B7} max 13 \u{00B7} pat 0"].exists)
        XCTAssertGreaterThanOrEqual(app.staticTexts.matching(identifier: "gybChip").count, 2)
        XCTAssertTrue(app.buttons["Spectate"].exists)
    }

    func testTheLobbySeatsThree() {
        let app = Fixture.launch("gyb-lobby")
        XCTAssertTrue(any(app, "screen.gameLobby").waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Ready 1/3"].waitForExistence(timeout: 5), "the count is out of 3")
        XCTAssertTrue(any(app, "lobby.mode").exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "Waiting for player...")).count, 1, "one seat waits")
        XCTAssertTrue(app.buttons["Add Bot"].exists)
        XCTAssertTrue(any(app, "lobby.voiceHint").label.contains("The first 3"), any(app, "lobby.voiceHint").label)
    }

    // MARK: - The table

    func testTheThreeSeatTable() {
        let app = launchTable("gyb-playing")
        let seats = Fixture.probe(app, "table.seats")
        XCTAssertTrue(seats.hasPrefix("seats=3 2:left 3:right trick=2:left,3:right"), seats)
        XCTAssertTrue(seats.hasSuffix("clear=ok"), seats)
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        // the score bar: one column per player, mine first, each its score
        let mine = any(app, "scoreBar.seat.1")
        XCTAssertTrue(mine.waitForExistence(timeout: 5))
        XCTAssertEqual(mine.value as? String, "26")
        XCTAssertTrue(mine.label.hasPrefix("ivy, 26 points, bid 2, won 1"), mine.label)
        XCTAssertEqual(any(app, "scoreBar.seat.2").value as? String, "13")
        XCTAssertEqual(any(app, "scoreBar.seat.3").value as? String, "11")
        XCTAssertLessThan(mine.frame.minX, any(app, "scoreBar.seat.2").frame.minX, "mine first")
        // no team bar, no HSI, no /help, no tutorial
        XCTAssertFalse(any(app, "scoreBar.teamNames").exists)
        XCTAssertFalse(any(app, "hsi").exists)
        XCTAssertFalse(any(app, "assist.ask").exists)
        XCTAssertFalse(any(app, "tutorial.chip").exists)
        for id in ["scoreBar.seat.1", "scoreBar.seat.2", "scoreBar.seat.3"] {
            XCTAssertTrue(window(app).contains(any(app, id).frame), "\(id) on screen")
        }
    }

    func testAPlainSpectatorSeesThreeSeats() {
        let app = launchTable("gyb-spectator")
        let seats = Fixture.probe(app, "table.seats")
        XCTAssertTrue(seats.hasPrefix("seats=3 1:bottom 2:left 3:right trick=2:left,3:right"), seats)
        XCTAssertTrue(seats.hasSuffix("clear=ok"), seats)
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        XCTAssertEqual(any(app, "scoreBar.seat.1").value as? String, "26")
    }

    func testTheBidSheetStrikesTheForbiddenBid() {
        let app = launchTable("gyb-bidding")
        let sheet = any(app, "bidOverlay")
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        let forbidden = app.buttons["bid.forbidden"]
        XCTAssertTrue(forbidden.exists)
        XCTAssertEqual(forbidden.label, "3, the Forbidden Bid")
        XCTAssertFalse(forbidden.isEnabled)
        let line = any(app, "bid.forbiddenLine")
        XCTAssertEqual(line.label, "Forbidden Bid: 3")
        // drawn whole inside the sheet (a layout priority once squeezed it to nothing)
        XCTAssertGreaterThan(line.frame.width, 80, "\(line.frame)")
        XCTAssertTrue(sheet.frame.contains(line.frame), "\(line.frame) in \(sheet.frame)")
        // numbers only: no bores
        XCTAssertFalse(app.buttons["B"].exists)
        // a tap on the Forbidden Bid selects nothing; another bid does
        forbidden.tap()
        XCTAssertEqual(sheet.value as? String, "-")
        app.buttons["bid.2"].tap()
        XCTAssertEqual(sheet.value as? String, "2")
        // the chips: mine (0 so far), kim's 2, Mary's 1 of 6
        XCTAssertEqual(any(app, "bidChips").value as? String, "0+2+1/6")
        XCTAssertTrue(window(app).contains(sheet.frame), "the sheet is on screen")
        // Submit keeps its word beside the Forbidden Bid's line (it was cut to "Sub…")
        XCTAssertGreaterThan(app.buttons["Submit"].frame.width, 100, "\(app.buttons["Submit"].frame)")
    }

    func testTheBidSheetAtTheLargestTextSize() {
        let app = launchTable("gyb-bidding", extra: Self.ax5)
        let sheet = any(app, "bidOverlay")
        XCTAssertTrue(sheet.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["bid.forbidden"].exists)
        XCTAssertTrue(window(app).contains(any(app, "bid.forbiddenLine").frame), "Forbidden Bid line on screen")
        XCTAssertGreaterThan(any(app, "bid.forbiddenLine").frame.width, 80)
        XCTAssertGreaterThan(app.buttons["Submit"].frame.width, 100)
        XCTAssertTrue(window(app).contains(app.buttons["Submit"].frame), "Submit on screen")
    }

    // MARK: - Game end

    func testTheGameEndListsEachPlayerBestFirst() {
        let app = launchTable("gyb-end")
        XCTAssertEqual(any(app, "gameEnd.title").label, "Defeat")
        XCTAssertEqual(any(app, "gameEnd.winnerLine").label, "kim wins!")
        let kim = any(app, "gameEnd.solo.2"), me = any(app, "gameEnd.solo.1"), mary = any(app, "gameEnd.solo.3")
        XCTAssertTrue(kim.waitForExistence(timeout: 5))
        XCTAssertEqual(kim.label, "kim, 83 points, bids made 8 of 13, winner")
        XCTAssertEqual(me.label, "ivy, 62 points, bids made 5 of 13")
        XCTAssertLessThan(kim.frame.minY, me.frame.minY)
        XCTAssertLessThan(me.frame.minY, mary.frame.minY)
        XCTAssertTrue(app.buttons["Return to Lobby"].exists)
        // no team summary, no HSI column
        XCTAssertFalse(any(app, "gameEnd.team1Names").exists)
    }

    func testASharedTopScoreIsATie() {
        let app = launchTable("gyb-end", extra: ["-uiTie", "YES"])
        XCTAssertEqual(any(app, "gameEnd.title").label, "Tie game")
        XCTAssertEqual(any(app, "gameEnd.winnerLine").label, "ivy and kim tie!")
    }

    func testTheGameEndAtTheLargestTextSize() {
        let app = launchTable("gyb-end", extra: Self.ax5)
        let rows = ["gameEnd.solo.2", "gameEnd.solo.1", "gameEnd.solo.3"].map { any(app, $0) }
        for row in rows { XCTAssertTrue(row.waitForExistence(timeout: 5)) }
        // rows stack, none cut at the sides
        for row in rows { XCTAssertTrue(row.frame.minX >= window(app).minX && row.frame.maxX <= window(app).maxX + 0.5, "\(row.frame)") }
    }
}
