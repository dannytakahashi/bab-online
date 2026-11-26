import XCTest

/// The tournament lobby's layout (owner 2026-11-26): one action slot at the bottom (Ready ->
/// Unready; the host's Begin once allowed, with Unready under it), the host's Rounds picker in the
/// header, Leave / Cancel Tournament in a "…" menu ("More") with a confirmation; and New Game as a
/// native menu with each game's rules under its name. Fixture mode; run on the iPhone 18 Pro,
/// the iPad and the closed iPhone Duo (where the menu is a vertical bar item).
/// `TEST_RUNNER_BAB_SHOTS=<folder>` (+ `TEST_RUNNER_BAB_DEVICE=<tag>`) saves PNGs.
final class LobbyMenuLayoutUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private static let xxxl = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]
    private static let ax5 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: screenshot)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        let env = ProcessInfo.processInfo.environment
        if let dir = env["BAB_SHOTS"], !dir.isEmpty {
            let tag = env["BAB_DEVICE"].map { "\($0)-" } ?? ""
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(tag)\(name).png"))
        }
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func lobby(_ fixture: String, _ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20), "\(fixture) did not come up")
        return app
    }

    private func sent(_ app: XCUIApplication) -> String { Fixture.probe(app, "fixture.sent") }

    private func waitFor(_ what: String, timeout: TimeInterval = 5, _ condition: () -> Bool) {
        let end = Date().addingTimeInterval(timeout)
        while !condition() && Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        XCTAssertTrue(condition(), what)
    }

    /// Inside the window and not under another element of the slot.
    private func assertOnScreen(_ app: XCUIApplication, _ e: XCUIElement, _ what: String) {
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(e.exists, "\(what) is missing")
        XCTAssertTrue(window.insetBy(dx: -1, dy: -1).contains(e.frame), "\(what) \(e.frame) outside the window \(window)")
    }

    private var more: (XCUIApplication) -> XCUIElement {
        { $0.buttons.matching(NSPredicate(format: "label == %@", "More")).firstMatch }
    }

    // MARK: - The slot

    /// Host, lobby phase: Ready (primary), then Unready with what Begin waits for; once everyone
    /// is ready Begin Tournament with a small Unready under it, which sends beginTournament.
    func testTheHostsSlotFromReadyToBegin() {
        var app = lobby("tournament-rounds")
        let slot = element(app, "tournament.ready")
        XCTAssertTrue(slot.waitForExistence(timeout: 5))
        XCTAssertEqual(slot.label, "Ready")
        XCTAssertFalse(element(app, "tournament.begin").exists, "one action at a time")
        XCTAssertFalse(app.buttons["Cancel Tournament"].exists, "Cancel is in the menu")
        assertOnScreen(app, slot, "Ready")
        shot("lobby-host")
        slot.tap()
        waitFor("Unready after Ready") { element(app, "tournament.ready").label == "Unready" }
        XCTAssertEqual(element(app, "tournament.slotCaption").label, "Waiting for 1 player to ready up, then you can begin")
        XCTAssertEqual(sent(app), "tournamentReady")
        shot("lobby-host-ready")
        element(app, "tournament.ready").tap()
        waitFor("Ready again") { element(app, "tournament.ready").label == "Ready" }
        XCTAssertEqual(sent(app), "tournamentReady|tournamentUnready")
        app.terminate()

        app = lobby("tournament-rounds", ["-uiAllReady", "YES"])
        let begin = element(app, "tournament.begin")
        XCTAssertTrue(begin.waitForExistence(timeout: 5))
        XCTAssertEqual(begin.label, "Begin Tournament")
        let toggle = element(app, "tournament.readyToggle")
        XCTAssertEqual(toggle.label, "Unready", "the host can still take it back")
        XCTAssertLessThan(begin.frame.maxY, toggle.frame.minY + 1, "the small Unready under Begin")
        XCTAssertFalse(element(app, "tournament.ready").exists)
        shot("lobby-host-canbegin")
        begin.tap()
        waitFor("beginTournament sent") { sent(app) == "beginTournament" }
        toggle.tap()
        waitFor("Unready from the toggle") { sent(app) == "beginTournament|tournamentUnready" }
        waitFor("back to the Ready slot") { element(app, "tournament.ready").label == "Ready" }
        app.terminate()
    }

    /// Member, lobby phase: no picker, the count in the round line; Ready -> Unready, waiting.
    func testAMembersSlot() {
        let app = lobby("tournament-lobby")
        XCTAssertFalse(app.segmentedControls["tournament.rounds"].exists, "only the host picks")
        XCTAssertEqual(element(app, "tournament.roundLine").label, "Waiting to start · 4 rounds")
        let slot = element(app, "tournament.ready")
        XCTAssertEqual(slot.label, "Ready")
        XCTAssertFalse(element(app, "tournament.begin").exists)
        shot("lobby-member")
        slot.tap()
        waitFor("Unready") { element(app, "tournament.ready").label == "Unready" }
        XCTAssertTrue(element(app, "tournament.slotCaption").label.hasPrefix("Waiting for"))
        shot("lobby-member-ready")
        app.terminate()
    }

    /// Between rounds: the host's Begin Next Round once everyone is ready (Start with ready
    /// players past the deadline: LobbyParityUITests); a member's Unready; nothing in a round.
    func testBetweenRoundsAndDuringARound() {
        var app = lobby("tournament-between", ["-uiHost", "ivy", "-uiAllReady", "YES"])
        let begin = element(app, "tournament.begin")
        XCTAssertTrue(begin.waitForExistence(timeout: 5))
        XCTAssertEqual(begin.label, "Begin Next Round")
        XCTAssertFalse(app.segmentedControls["tournament.rounds"].exists, "no picker once begun")
        shot("between-host-canbegin")
        begin.tap()
        waitFor("beginNextRound sent") { sent(app) == "beginNextRound" }
        app.terminate()

        app = lobby("tournament-between", ["-uiHost", "ivy"])
        XCTAssertEqual(element(app, "tournament.ready").label, "Unready")
        XCTAssertTrue(element(app, "tournament.slotCaption").label.hasSuffix("then you can begin"))
        shot("between-host")
        app.terminate()

        app = lobby("tournament-between")
        XCTAssertEqual(element(app, "tournament.ready").label, "Unready", "ivy is ready in this fixture")
        XCTAssertFalse(element(app, "tournament.begin").exists)
        shot("between-member")
        app.terminate()

        for host in ["kim", "ivy"] {
            app = lobby("tournament-round", ["-uiHost", host])
            XCTAssertFalse(element(app, "tournament.ready").exists, "no Ready during a round (\(host))")
            XCTAssertFalse(element(app, "tournament.begin").exists, "no Begin during a round (\(host))")
            XCTAssertTrue(more(app).exists, "the menu stays (\(host))")
            app.terminate()
        }
    }

    // MARK: - The menu

    /// The host's menu: Leave Tournament and Cancel Tournament; Cancel asks first and only then
    /// sends cancelTournament; Keep Tournament sends nothing.
    func testTheHostsMenuCancelsAfterAConfirmation() {
        let app = lobby("tournament-rounds")
        let button = more(app)
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        XCTAssertTrue(button.isHittable, "More is reachable (the vertical bar on the closed Duo)")
        button.tap()
        let cancel = app.buttons["Cancel Tournament"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Leave Tournament"].exists)
        shot("menu-host")
        cancel.tap()
        let confirm = app.buttons.matching(NSPredicate(format: "label == %@", "Cancel Tournament")).firstMatch
        XCTAssertTrue(app.staticTexts["Cancel the tournament?"].waitForExistence(timeout: 3), "asks first")
        XCTAssertTrue(app.staticTexts["The tournament ends for everyone before it starts."].exists)
        XCTAssertEqual(sent(app), "-", "nothing sent before the confirmation")
        shot("menu-host-confirm")
        confirm.tap()
        waitFor("cancelTournament sent") { sent(app) == "cancelTournament" }
        app.terminate()
    }

    /// A member's menu: Leave Tournament only, confirmed, then leaveTournament.
    func testAMembersMenuLeavesAfterAConfirmation() {
        let app = lobby("tournament-between")
        more(app).tap()
        let leave = app.buttons["Leave Tournament"].firstMatch
        XCTAssertTrue(leave.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Cancel Tournament"].exists, "only the host cancels")
        shot("menu-member")
        leave.tap()
        XCTAssertTrue(app.staticTexts["Leave the tournament?"].waitForExistence(timeout: 3))
        XCTAssertEqual(sent(app), "-")
        app.buttons.matching(NSPredicate(format: "label == %@", "Leave Tournament")).firstMatch.tap()
        waitFor("leaveTournament sent") { sent(app) == "leaveTournament" }
        app.terminate()
    }

    /// The results: no menu and no slot; the back control reads Main Room.
    func testNoMenuOnTheResults() {
        let app = lobby("tournament-results", ["-uiPlainResults", "YES"])
        XCTAssertTrue(app.buttons["Main Room"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(more(app).exists)
        XCTAssertFalse(element(app, "tournament.ready").exists)
        app.terminate()
    }

    // MARK: - Text sizes

    /// XXXL and AX5: the slot's button and caption are whole and on screen, the menu reachable.
    func testTheSlotAtLargeTextSizes() {
        for (tag, size) in [("xxxl", Self.xxxl), ("ax5", Self.ax5)] {
            let app = lobby("tournament-rounds", size + ["-uiMeReady", "YES"])
            let slot = element(app, "tournament.ready")
            for _ in 0..<6 where !(slot.exists && slot.isHittable) { app.swipeUp(velocity: .slow) }
            XCTAssertTrue(slot.isHittable, "\(tag): the slot")
            assertOnScreen(app, slot, "\(tag) slot")
            XCTAssertGreaterThan(slot.frame.height, 44, "\(tag): it grows with the text")
            let caption = element(app, "tournament.slotCaption")
            assertOnScreen(app, caption, "\(tag) caption")
            XCTAssertTrue(more(app).exists, "\(tag): the menu")
            shot("lobby-host-ready-\(tag)")
            app.terminate()
        }
    }

    // MARK: - New Game

    /// New Game is a native menu: each game with its rules as the subtitle (the item's label
    /// reads both); nothing is sent until a game is picked.
    func testNewGameIsAMenuWithSubtitles() {
        let app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        app.buttons["New Game"].firstMatch.tap()
        let classic = Fixture.newGameChoice(app, "classic"), gyb = Fixture.newGameChoice(app, "gyb")
        XCTAssertTrue(classic.waitForExistence(timeout: 5))
        XCTAssertTrue(gyb.exists)
        let words = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "4 players in two teams")).firstMatch
        XCTAssertTrue(words.exists, "Back Alley Bridge's subtitle")
        let gybWords = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Score only by taking exactly what you bid")).firstMatch
        XCTAssertTrue(gybWords.exists, "Get Your Bid's subtitle")
        XCTAssertFalse(app.staticTexts["New Game"].exists && app.buttons["Cancel"].exists, "no dialog with a Cancel")
        XCTAssertEqual(sent(app), "-")
        shot("newgame-menu")
        gyb.tap()
        waitFor("createLobby:gyb") { sent(app) == "createLobby:gyb" }
        app.terminate()
    }
}
