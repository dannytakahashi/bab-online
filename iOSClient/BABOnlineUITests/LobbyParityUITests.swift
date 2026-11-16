import XCTest

/// iOS 1.2.2 lobby parity with the web, on screen (fixtures: `main-room-cards`,
/// `game-lobby-reconnecting`, `tournament-deadline`, `tournament-results`, `-uiInfoToast`,
/// `-uiVoicePanel`; the rules themselves are LobbyParityTests).
final class LobbyParityUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ fixture: String, extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20), "\(fixture) never came up")
        return app
    }

    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    // MARK: - Main-room cards

    func testLobbyCardsShowMembersAndRejoinOnlyForMySeat() {
        let app = launch("main-room-cards")
        let open = any(app, "lobbyCard.l1")
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        XCTAssertTrue(open.label.contains("3/4 players"), open.label)
        XCTAssertTrue(open.label.contains("kim, hal"), open.label)
        // my held seat in a full lobby: Rejoin (an enabled button); another full lobby: Full, no button
        XCTAssertTrue(any(app, "lobbyCard.l2").label.contains("ivy, jon, ora, max"))
        let rejoin = app.buttons["lobby.rejoin"]
        XCTAssertEqual(app.buttons.matching(identifier: "lobby.rejoin").count, 1)
        XCTAssertTrue(rejoin.isEnabled)
        XCTAssertEqual(rejoin.label, "Rejoin")
        XCTAssertEqual(app.buttons.matching(identifier: "lobby.join").count, 1)
        XCTAssertTrue(app.staticTexts["Full"].exists)
        keep("main-room-cards")
    }

    func testInProgressCardsShowHandScoreAndWatchers() {
        let app = launch("main-room-cards")
        let detailed = any(app, "lobbyCard.g1")
        // the browser is a short list above the chat on a phone: bring the games up
        var tries = 0
        while !(detailed.exists && detailed.isHittable) && tries < 6 {
            any(app, "lobbyCard.l2").swipeUp()
            tries += 1
        }
        XCTAssertTrue(detailed.waitForExistence(timeout: 5))
        // VoiceOver hears words, not "uma/wes: 120 | vic/xan: -85"
        XCTAssertEqual(detailed.label, "uma & wes vs vic & xan. Hand 5. uma and wes 120, vic and xan -85. 2 watching")
        // a game listed without the details (an older server) keeps the old line
        let bare = any(app, "lobbyCard.g2")
        XCTAssertTrue(bare.waitForExistence(timeout: 5))
        XCTAssertTrue(bare.label.contains("4/4 players"), bare.label)
        XCTAssertFalse(bare.label.contains("Hand"), bare.label)
        keep("main-room-cards-in-progress")
    }

    // MARK: - Game lobby: a held seat

    func testAHeldSeatSaysReconnecting() {
        let app = launch("game-lobby-reconnecting")
        let marks = app.staticTexts.matching(identifier: "lobby.reconnecting")
        XCTAssertTrue(marks.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(marks.count, 1, "only hal's seat is held")
        XCTAssertEqual(marks.firstMatch.label, "Reconnecting\u{2026}")
        let hal = any(app, "lobby.players").staticTexts["hal"]
        XCTAssertTrue(hal.exists)
        // the caption sits under hal's name, in his row
        XCTAssertLessThan(abs(marks.firstMatch.frame.minX - hal.frame.minX), 2)
        XCTAssertGreaterThanOrEqual(marks.firstMatch.frame.minY, hal.frame.maxY - 1)
        XCTAssertLessThan(marks.firstMatch.frame.minY - hal.frame.maxY, 12)
        keep("game-lobby-reconnecting")
    }

    func testNoSeatIsMarkedWhenNoneIsHeld() {
        let app = launch("game-lobby")
        XCTAssertTrue(any(app, "lobby.players").waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts.matching(identifier: "lobby.reconnecting").count, 0)
    }

    // MARK: - Tournament: the ready deadline

    func testPastTheDeadlineTheHostStartsWithTheReadyPlayers() {
        let app = launch("tournament-deadline")
        let begin = app.buttons["tournament.begin"]
        XCTAssertTrue(begin.waitForExistence(timeout: 5))
        XCTAssertEqual(begin.label, "Start with ready players")
        XCTAssertTrue(begin.isEnabled, "the host may begin although hal and max are not ready")
        // hal and max sit out; the host (not ready either) and ned (away) do not
        let sitting = app.staticTexts.matching(identifier: "tournament.sittingOut")
        XCTAssertTrue(sitting.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(sitting.firstMatch.label, "Sitting out")
        keep("tournament-deadline-host")
    }

    func testAMemberSeesWhoSitsOutButNoBegin() {
        let app = launch("tournament-deadline", extra: ["-uiHost", "kim"])
        XCTAssertTrue(app.staticTexts.matching(identifier: "tournament.sittingOut").firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["tournament.begin"].exists)
        keep("tournament-deadline-member")
    }

    func testBeforeTheDeadlineBeginWaitsForEveryone() {
        // tournament-between: the deadline has not passed (and kim hosts, not me)
        let app = launch("tournament-between")
        XCTAssertEqual(app.staticTexts.matching(identifier: "tournament.sittingOut").count, 0)
        XCTAssertFalse(app.buttons["tournament.begin"].exists, "ivy is not the host in this fixture")
    }

    // MARK: - Tournament results

    func testResultsShowEveryRoundAndTheMarkers() {
        let app = launch("tournament-results")
        let winner = app.staticTexts["results.winner"]
        XCTAssertTrue(winner.waitForExistence(timeout: 5))
        XCTAssertEqual(winner.label, "kim & ivy tie!")
        let max = any(app, "results.row.max")
        XCTAssertTrue(max.waitForExistence(timeout: 5))
        XCTAssertEqual(max.label, "7. max, 82 points. Round 1: 55. Round 2: -20. Round 3: -30, left the table. Round 4: 77")
        let ned = any(app, "results.row.ned")
        XCTAssertTrue(ned.label.contains("Round 3: -30, sat out. Round 4: 31, sat out"), ned.label)
        XCTAssertTrue(any(app, "results.row.jon").label.contains("Round 3: 45, table ended early"))
        XCTAssertTrue(any(app, "results.table.wide").exists, "at the default text size the rounds sit beside the name")
        // the lobby's scoreboard behind the overlay speaks its rows the same way (no glyphs)
        XCTAssertEqual(any(app, "scoreboard.row.max").label,
                       "7. max, 82 points. Round 1: 55. Round 2: -20. Round 3: -30, left the table. Round 4: 77")
        // (and carries the same legend)
        let legend = any(app, "tournament.results").descendants(matching: .any)["tournament.flagLegend"]
        XCTAssertTrue(legend.exists)
        for part in ["table ended early", "left the table", "sat out"] {
            XCTAssertTrue(legend.label.contains(part), legend.label)
        }
        // the whole card is on screen and Return is reachable
        let screen = app.windows.firstMatch.frame
        let back = app.buttons["results.return"]
        XCTAssertTrue(back.isHittable)
        XCTAssertLessThanOrEqual(back.frame.maxY, screen.maxY)
        for name in ["kim", "ned"] {
            let row = any(app, "results.row.\(name)")
            XCTAssertGreaterThanOrEqual(row.frame.minX, screen.minX)
            XCTAssertLessThanOrEqual(row.frame.maxX, screen.maxX)
        }
        keep("tournament-results")
        back.tap()
        XCTAssertTrue(any(app, "screen.mainRoom").waitForExistence(timeout: 5))
    }

    func testResultsWithoutRoundDetailsShowNoLegend() {
        let app = launch("tournament-results", extra: ["-uiPlainResults", "YES"])
        let max = any(app, "results.row.max")
        XCTAssertTrue(max.waitForExistence(timeout: 5))
        XCTAssertEqual(max.label, "7. max, 82 points. Round 1: 55. Round 2: -20. Round 3: -30. Round 4: 77")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "tournament.flagLegend").count, 0)
    }

    func testResultsAtTheLargestTextSizeKeepReturnReachable() {
        let app = launch("tournament-results", extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"])
        let back = app.buttons["results.return"]
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        XCTAssertTrue(back.isHittable, "the standings scroll; Return stays on screen")
        XCTAssertLessThanOrEqual(back.frame.maxY, app.windows.firstMatch.frame.maxY)
        XCTAssertTrue(any(app, "results.row.kim").exists)
        keep("tournament-results-accessibility-xl")
    }

    /// Between the default and the accessibility sizes the fixed round columns grow with the
    /// text: the table stacks as soon as the name would be squeezed, and stays in the card.
    func testResultsStackWhenTheRoundsLeaveNoRoomForTheName() throws {
        let app = launch("tournament-results", extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"])
        let card = any(app, "tournament.results")
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        let pose = Fixture.probe(app, "ui.pose")
        let stacked = any(app, "results.table.stacked").exists
        if let size = Fixture.windowSize(pose), size.width < 500 {
            XCTAssertTrue(stacked, "a phone at xxxLarge has no room for four rounds beside the name (\(pose))")
            XCTAssertFalse(any(app, "results.table.wide").exists)
        }
        for name in ["kim", "max", "ned"] {
            let row = any(app, "results.row.\(name)")
            XCTAssertTrue(row.exists)
            XCTAssertGreaterThanOrEqual(row.frame.minX, card.frame.minX, "\(name) leaves the card")
            XCTAssertLessThanOrEqual(row.frame.maxX, card.frame.maxX, "\(name) leaves the card")
        }
        XCTAssertTrue(app.buttons["results.return"].isHittable)
        keep("tournament-results-xxxl-\(stacked ? "stacked" : "wide")")
    }

    // MARK: - Book pose (`-uiFold book`: a 20 pt hinge at the window center)

    /// The hinge's x span when the window is wide enough for two pages (FoldReader.bookHinge).
    private func bookHinge(_ app: XCUIApplication) -> ClosedRange<CGFloat>? {
        let pose = Fixture.probe(app, "ui.pose")
        guard pose.contains(" sc regular/"), let size = Fixture.windowSize(pose), size.width >= 500 else { return nil }
        return (size.width / 2 - 10)...(size.width / 2 + 10)
    }

    private func assertClear(_ element: XCUIElement, of hinge: ClosedRange<CGFloat>, _ what: String) {
        let f = element.frame
        XCTAssertTrue(f.maxX <= hinge.lowerBound + 1 || f.minX >= hinge.upperBound - 1, "\(what) \(f) spans the hinge \(hinge)")
    }

    func testInBookPoseTheResultsCardStaysOnOnePage() throws {
        let app = launch("tournament-results", extra: ["-uiFold", "book"])
        let card = any(app, "tournament.results")
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["results.return"].isHittable)
        keep("tournament-results-book")
        guard let hinge = bookHinge(app) else { throw XCTSkip("no book hinge on a window this narrow") }
        XCTAssertLessThanOrEqual(card.frame.maxX, hinge.lowerBound + 1, "the results card \(card.frame) spans the hinge \(hinge)")
        assertClear(app.buttons["results.return"], of: hinge, "Return")
        assertClear(any(app, "results.row.kim"), of: hinge, "kim's row")
    }

    func testInBookPoseTheDeadlineControlsStayOnOnePage() throws {
        let app = launch("tournament-deadline", extra: ["-uiFold", "book"])
        let begin = app.buttons["tournament.begin"]
        XCTAssertTrue(begin.waitForExistence(timeout: 5))
        XCTAssertEqual(begin.label, "Start with ready players")
        let sitting = app.staticTexts.matching(identifier: "tournament.sittingOut").firstMatch
        XCTAssertTrue(sitting.exists)
        keep("tournament-deadline-book")
        guard let hinge = bookHinge(app) else { throw XCTSkip("no book hinge on a window this narrow") }
        assertClear(begin, of: hinge, "Begin")
        assertClear(sitting, of: hinge, "Sitting out")
    }

    func testInBookPoseTheCardsAndTheirButtonsStayOnOnePage() throws {
        let app = launch("main-room-cards", extra: ["-uiFold", "book"])
        let rejoin = app.buttons["lobby.rejoin"]
        XCTAssertTrue(rejoin.waitForExistence(timeout: 5))
        keep("main-room-cards-book")
        guard let hinge = bookHinge(app) else { throw XCTSkip("no book hinge on a window this narrow") }
        assertClear(rejoin, of: hinge, "Rejoin")
        assertClear(app.buttons["lobby.join"], of: hinge, "Join")
        assertClear(any(app, "lobbyCard.l2"), of: hinge, "the full lobby's card")
        XCTAssertLessThanOrEqual(rejoin.frame.maxX, hinge.lowerBound + 1, "the browser is the left page")
    }

    func testInBookPoseAHeldSeatStaysOnOnePage() throws {
        let app = launch("game-lobby-reconnecting", extra: ["-uiFold", "book"])
        let mark = app.staticTexts.matching(identifier: "lobby.reconnecting").firstMatch
        XCTAssertTrue(mark.waitForExistence(timeout: 5))
        keep("game-lobby-reconnecting-book")
        guard let hinge = bookHinge(app) else { throw XCTSkip("no book hinge on a window this narrow") }
        assertClear(mark, of: hinge, "Reconnecting")
    }

    // MARK: - The neutral toast

    func testAHostChangeShowsTheInfoToast() {
        let app = launch("tournament-lobby", extra: ["-uiInfoToast", "You are now the tournament host"])
        let toast = any(app, "infoToast")
        XCTAssertTrue(toast.waitForExistence(timeout: 5))
        XCTAssertTrue(toast.label.contains("You are now the tournament host"), toast.label)
        XCTAssertFalse(any(app, "serverErrorToast").exists, "a notice, not an error")
        let screen = app.windows.firstMatch.frame
        XCTAssertGreaterThan(toast.frame.width, 80)
        XCTAssertLessThanOrEqual(toast.frame.maxX, screen.maxX)
        keep("tournament-host-toast")
    }

    // MARK: - Voice panel volume

    func testEachPlayerHasAVolumeSlider() {
        let app = launch("game-lobby", extra: ["-uiVoicePanel", "YES"])
        let kim = app.sliders["voice.volume.kim"]
        XCTAssertTrue(kim.waitForExistence(timeout: 8))
        XCTAssertEqual(kim.label, "kim volume")
        XCTAssertEqual(kim.value as? String, "100%")
        let hal = app.sliders["voice.volume.hal"]
        XCTAssertEqual(hal.value as? String, "150%")
        XCTAssertEqual(app.sliders.count, 2, "none for my own row")
        keep("voice-panel-volume")
        // all the way down, then all the way up: 0% to 200%, in the web's range
        // (XCUITest's drag can land one 5% step short of the end on the iPad's long slider;
        // the exact ends of the range are LobbyParityTests')
        func percent() -> Int { Int((kim.value as? String ?? "").dropLast()) ?? -1 }
        kim.adjust(toNormalizedSliderPosition: 0)
        XCTAssertTrue((0...5).contains(percent()), "\(percent())%")
        kim.adjust(toNormalizedSliderPosition: 1)
        XCTAssertTrue((195...200).contains(percent()), "\(percent())%")
        XCTAssertEqual(hal.value as? String, "150%", "one player's slider leaves the other's alone")
        // mute is separate and still there
        XCTAssertTrue(app.buttons["Mute kim"].exists)
        XCTAssertTrue(app.buttons["Unmute hal"].exists)
    }
}
