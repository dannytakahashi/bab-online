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

    /// Drags inside `scroll` (pressed, moved slowly and held, so it does not fling) by the distance
    /// that brings `e` inside its frame, at most 80% of its height per call. False when `e` is
    /// already inside (nothing to drag).
    @discardableResult
    private func drag(_ scroll: XCUIElement, toShow e: XCUIElement) -> Bool {
        let s = scroll.frame, f = e.frame, margin: CGFloat = 8
        let dy: CGFloat  // > 0 moves the content down (e is above the top edge)
        if f.minY < s.minY { dy = min(s.minY - f.minY + margin, s.height * 0.8) }
        else if f.maxY > s.maxY { dy = -min(f.maxY - s.maxY + margin, s.height * 0.8) }
        else { return false }
        let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: dy > 0 ? 0.1 : 0.9))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: dy)),
                    withVelocity: .slow, thenHoldForDuration: 0.3)
        return true
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

    private static let ax3 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"]

    /// Opens an item of the "…" menu (a submenu) and returns its consequence (the submenu's
    /// header) and its one confirm button: the button with the item's title BELOW the header (the
    /// submenu's own title row above it carries the same words).
    private func openConfirm(_ app: XCUIApplication, _ title: String, _ message: String,
                             file: StaticString = #filePath, line: UInt = #line) -> (header: XCUIElement, confirm: XCUIElement) {
        let item = app.buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 3), "\(title) in the menu", file: file, line: line)
        item.tap()
        let header = app.staticTexts[message].firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 3), "the consequence heads the confirm: \(message)", file: file, line: line)
        let below = app.buttons.matching(NSPredicate(format: "label == %@", title)).allElementsBoundByIndex
            .filter { $0.exists && $0.frame.minY >= header.frame.maxY - 1 }
        XCTAssertEqual(below.count, 1, "one confirm under the consequence", file: file, line: line)
        return (header, below.first ?? item)
    }

    /// The confirm is in the menu: no alert, no popover, no dialog title floating over the chat.
    private func assertNothingFloats(_ app: XCUIApplication, _ question: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(app.alerts.count, 0, "no alert", file: file, line: line)
        XCTAssertEqual(app.popovers.count, 0, "no popover", file: file, line: line)
        XCTAssertFalse(app.staticTexts[question].exists, "no dialog question (\(question))", file: file, line: line)
    }

    /// The consequence on screen: the header carries the whole message and sits inside the window
    /// (whether a long one wraps rather than ending in an ellipsis is read from the screenshots).
    private func assertWhole(_ app: XCUIApplication, _ header: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(window.insetBy(dx: -1, dy: -1).contains(header.frame), "header \(header.frame) inside \(window)", file: file, line: line)
    }

    /// Closes the open menu by a tap beside it (the screen's leading edge, clear of the menu on every device), the "keep" choice.
    private func dismissMenu(_ app: XCUIApplication) {
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.45)).tap()
    }

    /// Cancel Tournament confirms IN the menu (owner 2026-11-26: the confirmationDialog showed as a
    /// popover pointing at the chat): its submenu says what happens in full and its one button
    /// sends cancelTournament; closing the menu sends nothing.
    func testCancelConfirmsInTheMenuAndDismissingSendsNothing() {
        let app = lobby("tournament-rounds")
        let button = more(app)
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        XCTAssertTrue(button.isHittable, "More is reachable (the vertical bar on the closed Duo)")
        let message = "The tournament ends for everyone before it starts."
        button.tap()
        let first = openConfirm(app, "Cancel Tournament", message)
        assertWhole(app, first.header)
        assertNothingFloats(app, "Cancel the tournament?")
        XCTAssertTrue(first.confirm.isHittable)
        XCTAssertEqual(sent(app), "-", "nothing sent before the confirmation")
        dismissMenu(app)
        waitFor("the menu closed") { !app.staticTexts[message].exists }
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertEqual(sent(app), "-", "closing the menu keeps the tournament")
        XCTAssertTrue(element(app, "tournament.ready").exists, "still in the lobby")

        more(app).tap()
        let second = openConfirm(app, "Cancel Tournament", message)
        shot("menu-host-confirm")
        second.confirm.tap()
        waitFor("cancelTournament sent") { sent(app) == "cancelTournament" }
        app.terminate()
    }

    /// The host's menu: Leave Tournament and Cancel Tournament, each a submenu; Leave says the role
    /// passes on and sends leaveTournament.
    func testTheHostsMenuLeavesAfterAConfirmation() {
        let app = lobby("tournament-rounds")
        more(app).tap()
        XCTAssertTrue(app.buttons["Cancel Tournament"].firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Leave Tournament"].exists)
        shot("menu-host")
        let (header, confirm) = openConfirm(app, "Leave Tournament",
                                            "You can join again while it's waiting to start. Another player becomes the host.")
        assertWhole(app, header)
        assertNothingFloats(app, "Leave the tournament?")
        XCTAssertEqual(sent(app), "-")
        confirm.tap()
        waitFor("leaveTournament sent") { sent(app) == "leaveTournament" }
        app.terminate()
    }

    /// A member's menu: Leave Tournament only, confirmed in its submenu, then leaveTournament.
    func testAMembersMenuLeavesAfterAConfirmation() {
        let app = lobby("tournament-between")
        more(app).tap()
        XCTAssertTrue(app.buttons["Leave Tournament"].firstMatch.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Cancel Tournament"].exists, "only the host cancels")
        shot("menu-member")
        let (header, confirm) = openConfirm(app, "Leave Tournament",
                                            "You'll miss the rounds still to come; a missed round scores that round's lowest.")
        assertWhole(app, header)
        assertNothingFloats(app, "Leave the tournament?")
        XCTAssertEqual(sent(app), "-")
        confirm.tap()
        waitFor("leaveTournament sent") { sent(app) == "leaveTournament" }
        app.terminate()
    }

    /// Screenshots of the menu and each confirm, at the default size and AX3 (`TEST_RUNNER_BAB_SHOTS`):
    /// the host in the lobby (Cancel, Leave), the host between rounds (Cancel), a member between
    /// rounds (Leave). Each consequence must read whole in the picture.
    func testConfirmScreenshots() {
        let cases: [(String, [String], String, String, String)] = [
            ("host-lobby", [], "tournament-rounds", "Cancel Tournament", "The tournament ends for everyone before it starts."),
            ("host-lobby", [], "tournament-rounds", "Leave Tournament",
             "You can join again while it's waiting to start. Another player becomes the host."),
            ("host-between", ["-uiHost", "ivy"], "tournament-between", "Cancel Tournament",
             "The tournament ends for everyone, and any games still in play stop now."),
            ("member-between", [], "tournament-between", "Leave Tournament",
             "You'll miss the rounds still to come; a missed round scores that round's lowest."),
        ]
        for (size, args) in [("default", [String]()), ("ax3", Self.ax3)] {
            var menuShot = Set<String>()
            for (who, extra, fixture, title, message) in cases {
                let app = lobby(fixture, extra + args)
                let button = more(app)
                for _ in 0..<4 where !button.isHittable { app.swipeDown(velocity: .slow) }
                button.tap()
                XCTAssertTrue(app.buttons[title].firstMatch.waitForExistence(timeout: 3))
                if !menuShot.contains(who) { shot("\(size)-\(who)-menu"); menuShot.insert(who) }
                let (header, confirm) = openConfirm(app, title, message)
                assertWhole(app, header)
                XCTAssertTrue(confirm.isHittable, "\(size) \(who) \(title): the confirm")
                shot("\(size)-\(who)-\(title == "Cancel Tournament" ? "cancel" : "leave")-confirm")
                app.terminate()
            }
        }
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
            // unpinned at AX5, the slot scrolls with the players in a short scroll view (167 pt on
            // the 18 Pro) that cannot show the slot (86 pt) and its caption (153 pt) at once: the
            // swipes end at its bottom, the caption in view and the slot above the top edge. Drag
            // inside that scroll view, by the slot's measured distance, until the slot is in it.
            let scroll = app.scrollViews.containing(.button, identifier: "tournament.ready").firstMatch
            for _ in 0..<8 where !slot.isHittable && scroll.exists {
                guard drag(scroll, toShow: slot) else { break }
            }
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
