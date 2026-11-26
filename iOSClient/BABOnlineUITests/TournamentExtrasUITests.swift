import XCTest

/// iOS 1.2.7 (41) around Cut for a buck, in fixture mode (UIFixture+Tournament, UIFixture+Profile,
/// UIFixture+Stats): the host's Rounds picker (`tournament-rounds`; the member's view with
/// `-uiHost kim -uiSettingsFrom kim:<n>`), the over-cap voice notice (`-uiVoiceFull <cap>`), the
/// profiles' Tournaments section between Statistics and Badges (`-uiTournaments`), and Lucky Buck
/// among the Records titles. `TEST_RUNNER_BAB_SHOTS=<folder>` also saves each screenshot there as
/// `e2-<name>.png`.
final class TournamentExtrasUITests: XCTestCase {
    private static let ax5 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

    override func setUp() {
        continueAfterFailure = false
    }

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: screenshot)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("e2-\(name).png"))
        }
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func text(_ app: XCUIApplication, containing s: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    private func lobby(_ extra: [String] = [], fixture: String = "tournament-rounds") -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20), "\(fixture) did not come up")
        return app
    }

    private func roundLine(_ app: XCUIApplication) -> String {
        element(app, "tournament.roundLine").label
    }

    private func waitFor(_ what: String, timeout: TimeInterval = 5, _ condition: () -> Bool) {
        let end = Date().addingTimeInterval(timeout)
        while !condition() && Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        XCTAssertTrue(condition(), what)
    }

    private func assertOnScreen(_ app: XCUIApplication, _ e: XCUIElement, _ what: String) {
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(window.insetBy(dx: -1, dy: -1).contains(e.frame), "\(what) \(e.frame) outside the window \(window)")
    }

    // MARK: - Rounds

    /// The host's segmented 1-5 in the header: a pick shows at once (round line, scoreboard
    /// columns), sends setTournamentRounds and gets the server's system line.
    func testTheHostPicksTheRounds() {
        let app = lobby()
        let picker = app.segmentedControls["tournament.rounds"]
        XCTAssertTrue(picker.waitForExistence(timeout: 5), "the host's picker")
        XCTAssertEqual(picker.buttons.count, 5)
        XCTAssertTrue(picker.buttons.element(boundBy: 3).isSelected, "4 by default")
        XCTAssertEqual(roundLine(app), "Waiting to start · 4 rounds")
        XCTAssertTrue(app.staticTexts["R4"].exists)
        XCTAssertFalse(app.staticTexts["R5"].exists)
        // in the header under the round line (owner 2026-11-26), well above the one action slot
        let line = element(app, "tournament.roundLine")
        XCTAssertLessThanOrEqual(line.frame.maxY, picker.frame.minY + 1, "under \"Waiting to start · 4 rounds\"")
        let ready = element(app, "tournament.ready")
        XCTAssertTrue(ready.exists, "the host is not ready yet: the slot reads Ready")
        XCTAssertLessThan(picker.frame.maxY, app.staticTexts["Players"].frame.minY, "in the header, above the players")
        XCTAssertLessThan(picker.frame.maxY, ready.frame.minY)
        assertOnScreen(app, picker, "the picker")
        shot("rounds-host")

        picker.buttons.element(boundBy: 2).tap()
        waitFor("the line follows the pick") { roundLine(app) == "Waiting to start · 3 rounds" }
        XCTAssertTrue(app.staticTexts["R3"].exists)
        XCTAssertFalse(app.staticTexts["R4"].exists, "the columns follow the count")
        XCTAssertTrue(text(app, containing: "ivy set the tournament to 3 rounds.").waitForExistence(timeout: 3), "the server's line")
        XCTAssertEqual(Fixture.probe(app, "fixture.sent"), "setTournamentRounds:3")

        picker.buttons.element(boundBy: 0).tap()
        waitFor("one round") { roundLine(app) == "Waiting to start · 1 round" }
        XCTAssertFalse(app.staticTexts["R2"].exists)
        XCTAssertTrue(text(app, containing: "set the tournament to 1 round.").waitForExistence(timeout: 3))
        // the same count again sends nothing
        picker.buttons.element(boundBy: 0).tap()
        XCTAssertEqual(Fixture.probe(app, "fixture.sent"), "setTournamentRounds:3|setTournamentRounds:1")
        shot("rounds-host-picked")
        app.terminate()
    }

    /// A member has no picker; the host's tournamentSettingsUpdated moves the round line and the
    /// columns, and the chat says who changed it.
    func testAMemberSeesTheHostsCount() {
        let app = lobby(["-uiHost", "kim", "-uiSettingsFrom", "kim:5"])
        XCTAssertFalse(app.segmentedControls["tournament.rounds"].exists, "only the host picks")
        XCTAssertFalse(element(app, "tournament.rounds").exists)
        waitFor("the host's count arrives", timeout: 6) { roundLine(app) == "Waiting to start · 5 rounds" }
        XCTAssertTrue(app.staticTexts["R5"].exists)
        XCTAssertTrue(text(app, containing: "kim set the tournament to 5 rounds.").waitForExistence(timeout: 3))
        shot("rounds-member")
        app.terminate()
    }

    /// The largest text size: a "Rounds: 4" menu instead of five letter-wide segments, inside the
    /// screen, and its pick works.
    func testThePickerAtTheLargestTextSize() {
        let app = lobby(Self.ax5)
        let menu = element(app, "tournament.rounds")
        for _ in 0..<6 where !(menu.exists && menu.isHittable) { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        XCTAssertFalse(app.segmentedControls["tournament.rounds"].exists, "a menu at AX5")
        XCTAssertEqual(menu.value as? String, "4 rounds")
        assertOnScreen(app, menu, "the rounds menu")
        shot("rounds-host-ax5")
        menu.tap()
        let five = app.buttons["5 rounds"].firstMatch
        XCTAssertTrue(five.waitForExistence(timeout: 3), "the menu's choices")
        shot("rounds-menu-ax5")
        five.tap()
        waitFor("the menu's pick") { (menu.value as? String) == "5 rounds" }
        XCTAssertEqual(Fixture.probe(app, "fixture.sent"), "setTournamentRounds:5")
        app.terminate()
    }

    // MARK: - Voice is full

    /// Waiting in line for a full tournament voice room: "Voice is full (20 people)" under the
    /// round line until the server lets this member in.
    func testVoiceIsFullUntilLetIn() {
        let app = lobby(["-uiVoiceFull", "20", "-uiVoiceAdmit", "5"], fixture: "tournament-lobby")
        let note = element(app, "tournament.voiceFull")
        XCTAssertTrue(note.waitForExistence(timeout: 3))
        XCTAssertEqual(note.label, "Voice is full (20 people)")
        assertOnScreen(app, note, "the notice")
        shot("voice-full")
        XCTAssertTrue(note.waitForNonExistence(timeout: 8), "let in: the notice goes")
        app.terminate()
    }

    func testVoiceIsFullAtTheLargestTextSize() {
        let app = lobby(["-uiVoiceFull", "20"] + Self.ax5, fixture: "tournament-lobby")
        let note = element(app, "tournament.voiceFull")
        XCTAssertTrue(note.waitForExistence(timeout: 3))
        XCTAssertEqual(note.label, "Voice is full (20 people)")
        assertOnScreen(app, note, "the notice")
        XCTAssertTrue(element(app, "tournament.roundLine").exists)
        shot("voice-full-ax5")
        app.terminate()
    }

    // MARK: - Profiles

    private func openAccount(_ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch("main-room", extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        let gear = app.buttons.matching(NSPredicate(format: "label == %@", "Account settings")).firstMatch
        XCTAssertTrue(gear.waitForExistence(timeout: 5))
        gear.tap()
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 5), "the Account sheet")
        return app
    }

    /// Rows are about 300 to 400 pt tall at AX5: short drags until all of `e` is on screen.
    private func dragFullyIn(_ app: XCUIApplication, _ e: XCUIElement) {
        let window = app.windows.firstMatch.frame
        for _ in 0..<8 where e.frame.maxY > window.maxY - 20 {
            let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -160)))
        }
    }

    /// Swipes until `e` is hittable, then short drags until all of it is in the window (a swipe
    /// may stop with a row half under the bottom edge).
    private func reveal(_ app: XCUIApplication, _ e: XCUIElement, swipes: Int = 10) {
        for _ in 0..<swipes where !(e.exists && e.isHittable) { app.swipeUp(velocity: .slow) }
        if e.exists { dragFullyIn(app, e) }
    }

    /// My Tournaments section: after my statistics, before my badges; the stats, five results
    /// with the cut lines in the owner's words.
    func testMyTournamentHistoryBetweenStatsAndBadges() {
        let app = openAccount()
        let stats = element(app, "profile.stats")
        XCTAssertTrue(stats.waitForExistence(timeout: 6))
        let section = element(app, "profile.tournaments")
        reveal(app, element(app, "profile.tournamentStat.cut"))
        XCTAssertTrue(section.waitForExistence(timeout: 5), "my history")
        XCTAssertEqual(element(app, "profile.tournamentStat.played").value as? String, "6")
        XCTAssertEqual(element(app, "profile.tournamentStat.won").value as? String, "2")
        XCTAssertEqual(element(app, "profile.tournamentStat.cut").value as? String, "2 of 3")
        if stats.exists, !stats.frame.isEmpty {
            XCTAssertGreaterThan(section.frame.minY, stats.frame.maxY - 1, "after the statistics")
        }
        shot("history-account")
        let first = element(app, "profile.tournament.0")
        reveal(app, first)
        XCTAssertTrue(first.label.hasPrefix("Sunday Cup, Won (tied), "), first.label)
        XCTAssertTrue(first.label.hasSuffix("6 players · 3 rounds, Won cut for a buck"), first.label)
        let second = element(app, "profile.tournament.1")
        reveal(app, second)
        XCTAssertTrue(second.label.contains("2nd of 8"), second.label)
        XCTAssertTrue(second.label.hasSuffix("Cut for a buck: kim"), second.label)
        let last = element(app, "profile.tournament.4")
        reveal(app, last)
        XCTAssertTrue(last.label.hasPrefix("Practice, Finished"), last.label)
        assertOnScreen(app, last, "the last result")
        shot("history-account-results")
        // the badges follow (ios/badges' rows sit below the new section)
        let felted = element(app, "profile.badge.felted")
        reveal(app, felted)
        XCTAssertTrue(felted.exists)
        XCTAssertGreaterThan(felted.frame.minY, last.frame.maxY - 1, "badges after the history")
        assertOnScreen(app, felted, "the first badge")
        shot("history-then-badges")
        app.terminate()
    }

    func testMyTournamentHistoryAtTheLargestTextSize() {
        let app = openAccount(Self.ax5)
        let cut = element(app, "profile.tournamentStat.cut")
        reveal(app, cut, swipes: 20)
        XCTAssertTrue(cut.waitForExistence(timeout: 6))
        assertOnScreen(app, cut, "the cut stat")
        shot("history-account-ax5")
        let first = element(app, "profile.tournament.0")
        reveal(app, first, swipes: 10)
        let window = app.windows.firstMatch.frame
        dragFullyIn(app, first)
        assertOnScreen(app, first, "the first result")
        XCTAssertLessThanOrEqual(first.frame.maxX, window.maxX + 1, "wraps, never runs off the side")
        shot("history-results-ax5")
        let felted = element(app, "profile.badge.felted")
        reveal(app, felted, swipes: 30)
        XCTAssertTrue(felted.exists)
        dragFullyIn(app, felted)
        assertOnScreen(app, felted, "the first badge")
        shot("history-then-badges-ax5")
        app.terminate()
    }

    /// Another player's sheet: kim's history (one cut won, a long tournament name) between the
    /// statistics and the badges; ora, who never finished a tournament, gets no section; a
    /// server without the history none either.
    func testAnotherPlayersHistory() {
        var app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 20))
        let online = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", " online")).firstMatch
        XCTAssertTrue(online.waitForExistence(timeout: 5))
        online.tap()
        var row = element(app, "online.kim")
        XCTAssertTrue(row.waitForExistence(timeout: 3))
        row.tap()
        XCTAssertTrue(element(app, "profile.stats").waitForExistence(timeout: 6))
        let cut = element(app, "profile.tournamentStat.cut")
        reveal(app, cut)
        XCTAssertEqual(cut.value as? String, "1 of 1")
        let second = element(app, "profile.tournament.1")
        reveal(app, second)
        XCTAssertTrue(second.label.hasPrefix("The Extremely Long Tournament Name For Testing, Won, "), second.label)
        assertOnScreen(app, second, "the long name's row")
        let first = element(app, "profile.tournament.0")
        XCTAssertTrue(first.label.hasSuffix("Won cut for a buck"), "kim won that cut: " + first.label)
        shot("history-player-kim")
        let chemistry = element(app, "profile.badge.chemistry")
        reveal(app, chemistry)
        XCTAssertGreaterThan(chemistry.frame.minY, second.frame.maxY - 1, "badges after the history")
        element(app, "profile.close").tap()

        row = element(app, "online.ora")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        XCTAssertTrue(element(app, "profile.stats").waitForExistence(timeout: 6))
        let empty = element(app, "profile.badgesEmpty")
        reveal(app, empty)
        XCTAssertTrue(empty.exists, "the badges section is there")
        XCTAssertFalse(element(app, "profile.tournaments").exists, "no finished tournament: no section")
        app.terminate()

        app = openAccount(["-uiTournaments", "absent"])
        let felted = element(app, "profile.badge.felted")
        reveal(app, felted)
        XCTAssertTrue(felted.exists)
        XCTAssertFalse(element(app, "profile.tournaments").exists, "a server without the history")
        app.terminate()
    }
}
