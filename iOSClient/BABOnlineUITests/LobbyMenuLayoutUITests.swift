import XCTest

/// The tournament lobby's layout (owner 2026-11-26): one action slot at the bottom (Ready ->
/// Unready; the host's Begin once allowed, with Unready under it), the host's Rounds picker in the
/// header, Leave / Stop Watching as a button (a member, a spectator) or the host's "…" menu ("More")
/// of Leave Tournament… / Cancel Tournament…, one level, each confirmed by a centred alert; and New
/// Game as a native menu with each game's rules under its name. Fixture mode; run on the iPhone 18
/// Pro, the iPad and the iPhone Duo closed and open (where the entry point is a vertical bar item).
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

    /// The confirmations' words (TournamentLobbyMenu.Copy and confirmMessage; the UI tests do not
    /// link the app).
    private enum TournamentCopy {
        static let cancelInTheLobby = "The tournament ends for everyone before it starts."
        static let cancelOnceBegun = "The tournament ends for everyone, and any games still in play stop now."
        static let hostLeavesTheLobby = "You can join again while it's waiting to start. Another player becomes the host."
        static let memberLeavesTheLobby = "You can join again while it's waiting to start."
        static let noWayBack = "You can't come back to this tournament, and you won't be among the winners."
        static let stopWatching = "You go back to the main room."
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
        XCTAssertEqual(toggle.label, "Mark me not ready", "the host can still take it back (a button, not a status)")
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
            // the host keeps the "…" (Leave and Cancel), a member the Leave button
            XCTAssertTrue(host == "ivy" ? more(app).exists : leaveButton(app).exists, "Leave stays (\(host))")
            app.terminate()
        }
    }

    // MARK: - The menu

    /// The member's / spectator's button (before any alert is up: the alert has a "Leave
    /// Tournament" button too), by its identifier or its VoiceOver label (the vertical bar's item).
    private func entryButton(_ app: XCUIApplication, _ id: String, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", id, label)).firstMatch
    }

    private func leaveButton(_ app: XCUIApplication) -> XCUIElement {
        entryButton(app, "tournament.leave", "Leave Tournament")
    }

    /// Brings the entry point into reach (at AX5 the header can sit above a scrolled list).
    private func reach(_ app: XCUIApplication, _ e: XCUIElement) {
        XCTAssertTrue(e.waitForExistence(timeout: 5), "the entry point")
        for _ in 0..<4 where !e.isHittable { app.swipeDown(velocity: .slow) }
    }

    /// The host's "…" menu: one level of plain items with a trailing ellipsis, nothing nested.
    private func openHostMenu(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let button = more(app)
        reach(app, button)
        XCTAssertTrue(button.isHittable, "More is reachable (the vertical bar on the Duo)", file: file, line: line)
        button.tap()
        XCTAssertTrue(app.buttons["Cancel Tournament…"].firstMatch.waitForExistence(timeout: 3), "Cancel in the menu", file: file, line: line)
        XCTAssertTrue(app.buttons["Leave Tournament…"].firstMatch.exists, "Leave in the menu", file: file, line: line)
        XCTAssertEqual(app.alerts.count, 0, "nothing asked yet", file: file, line: line)
    }

    /// The alert a choice opens: centred (no popover), its question and the consequence.
    private func openedAlert(_ app: XCUIApplication, _ question: String, _ message: String,
                             file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let alert = app.alerts[question]
        XCTAssertTrue(alert.waitForExistence(timeout: 4), "the alert \(question)", file: file, line: line)
        XCTAssertTrue(alert.staticTexts[message].exists, "it says what happens: \(message)", file: file, line: line)
        XCTAssertEqual(app.popovers.count, 0, "no popover", file: file, line: line)
        XCTAssertEqual(app.alerts.count, 1, "one alert", file: file, line: line)
        // never a submenu: the menu went away when its item opened the alert
        XCTAssertFalse(app.buttons["Cancel Tournament…"].exists, "no menu behind the alert", file: file, line: line)
        // UIKit lays the alert out: at AX5 on the closed Duo it is centred in the content beside the
        // vertical bar and overhangs the leading edge by about 10 pt (its message and buttons
        // scroll inside it); it is never wider than the window and its centre is on screen
        let window = app.windows.firstMatch.frame
        XCTAssertLessThanOrEqual(alert.frame.width, window.width, "the alert \(alert.frame) fits \(window)", file: file, line: line)
        XCTAssertTrue(window.contains(CGPoint(x: alert.frame.midX, y: alert.frame.midY)), "the alert \(alert.frame) on \(window)", file: file, line: line)
        return alert
    }

    /// The alert's destructive button (`tournament.confirm`) and keep button (`tournament.keep`):
    /// UIAlertAction's accessibilityIdentifier, which XCUITest reads (the alert's tree lists each
    /// button twice, so the first match).
    private func confirm(_ alert: XCUIElement) -> XCUIElement { alert.buttons["tournament.confirm"].firstMatch }
    private func keep(_ alert: XCUIElement) -> XCUIElement { alert.buttons["tournament.keep"].firstMatch }

    private func waitGone(_ alert: XCUIElement, _ what: String) {
        waitFor(what) { !alert.exists }
    }

    /// Cancel Tournament: the host's "…" then Cancel Tournament…, a centred alert "Cancel
    /// tournament?" with the consequence; Keep Tournament sends nothing; Cancel Tournament sends
    /// cancelTournament.
    func testCancelAsksInAnAlertAndKeepSendsNothing() {
        let app = lobby("tournament-rounds")
        openHostMenu(app)
        // each row on one line at the default size (review of PR #437: with the icon "Cancel
        // Tournament…" broke over two on the Duo, open and closed, and the iPhone 18 Pro)
        let cancelRow = app.buttons["Cancel Tournament…"].firstMatch, leaveRow = app.buttons["Leave Tournament…"].firstMatch
        XCTAssertEqual(cancelRow.frame.height, leaveRow.frame.height, accuracy: 2,
                       "Cancel Tournament… \(cancelRow.frame) as tall as Leave Tournament… \(leaveRow.frame)")
        XCTAssertLessThan(cancelRow.frame.height, 56, "one line: \(cancelRow.frame)")
        shot("menu-host")
        app.buttons["Cancel Tournament…"].firstMatch.tap()
        var alert = openedAlert(app, "Cancel tournament?", TournamentCopy.cancelInTheLobby)
        XCTAssertEqual(confirm(alert).label, "Cancel Tournament")
        XCTAssertEqual(keep(alert).label, "Keep Tournament", "never a bare Cancel beside Cancel Tournament")
        XCTAssertEqual(sent(app), "-", "nothing sent before the confirmation")
        shot("alert-host-cancel")
        keep(alert).tap()
        waitGone(alert, "Keep Tournament closed the alert")
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertEqual(sent(app), "-", "Keep Tournament keeps the tournament")
        XCTAssertTrue(element(app, "tournament.ready").exists, "still in the lobby")

        openHostMenu(app)
        app.buttons["Cancel Tournament…"].firstMatch.tap()
        alert = openedAlert(app, "Cancel tournament?", TournamentCopy.cancelInTheLobby)
        confirm(alert).tap()
        waitFor("cancelTournament sent") { sent(app) == "cancelTournament" }
        app.terminate()
    }

    /// The host's Leave: "…" then Leave Tournament…, the alert says the role passes on; Stay
    /// keeps me there, Leave Tournament sends leaveTournament.
    func testTheHostsLeaveAsksInAnAlert() {
        let app = lobby("tournament-rounds")
        openHostMenu(app)
        app.buttons["Leave Tournament…"].firstMatch.tap()
        var alert = openedAlert(app, "Leave tournament?", TournamentCopy.hostLeavesTheLobby)
        XCTAssertEqual(keep(alert).label, "Stay")
        keep(alert).tap()
        waitGone(alert, "Stay closed the alert")
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(sent(app), "-", "Stay keeps me in the tournament")
        openHostMenu(app)
        app.buttons["Leave Tournament…"].firstMatch.tap()
        alert = openedAlert(app, "Leave tournament?", TournamentCopy.hostLeavesTheLobby)
        shot("alert-host-leave")
        confirm(alert).tap()
        waitFor("leaveTournament sent") { sent(app) == "leaveTournament" }
        app.terminate()
    }

    /// A member has ONE choice: Leave is a button (no "…", no menu), straight to its alert; Stay
    /// keeps me there, Leave Tournament sends leaveTournament.
    func testAMembersLeaveIsAButtonThatAsksFirst() {
        let app = lobby("tournament-between")
        let button = leaveButton(app)
        reach(app, button)
        XCTAssertFalse(more(app).exists, "no menu for one choice")
        XCTAssertEqual(button.label, "Leave Tournament", "VoiceOver hears the whole choice")
        XCTAssertFalse(app.buttons["Cancel Tournament"].exists, "only the host cancels")
        shot("member-button")
        button.tap()
        // between rounds a member who leaves is gone for good, never "a missed round scores..."
        var alert = openedAlert(app, "Leave tournament?", TournamentCopy.noWayBack)
        XCTAssertEqual(confirm(alert).label, "Leave Tournament")
        XCTAssertEqual(keep(alert).label, "Stay")
        shot("alert-member-leave")
        keep(alert).tap()
        waitGone(alert, "Stay closed the alert")
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(sent(app), "-", "Stay keeps me in the tournament")
        XCTAssertTrue(leaveButton(app).exists, "still in the lobby")
        leaveButton(app).tap()
        alert = openedAlert(app, "Leave tournament?", TournamentCopy.noWayBack)
        confirm(alert).tap()
        waitFor("leaveTournament sent") { sent(app) == "leaveTournament" }
        app.terminate()
    }

    /// A spectator's Stop Watching is a button; its alert's Keep Watching keeps watching.
    func testASpectatorsStopWatchingIsAButtonThatAsksFirst() {
        let app = lobby("tournament-pairings", ["-uiSpectator", "YES"])
        let button = entryButton(app, "tournament.stopWatching", "Stop Watching")
        reach(app, button)
        XCTAssertFalse(more(app).exists, "no menu for one choice")
        XCTAssertFalse(leaveButton(app).exists)
        button.tap()
        var alert = openedAlert(app, "Stop watching?", TournamentCopy.stopWatching)
        XCTAssertEqual(confirm(alert).label, "Stop Watching")
        XCTAssertEqual(keep(alert).label, "Keep Watching")
        shot("alert-spectator")
        keep(alert).tap()
        waitGone(alert, "Keep Watching closed the alert")
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(sent(app), "-")
        entryButton(app, "tournament.stopWatching", "Stop Watching").tap()
        alert = openedAlert(app, "Stop watching?", TournamentCopy.stopWatching)
        confirm(alert).tap()
        waitFor("leaveTournament sent") { sent(app) == "leaveTournament" }
        app.terminate()
    }

    /// A host hand-off while Cancel's alert is up (`-uiHandOffOnAlert kim`, 3 s after it opens):
    /// Cancel is no longer mine, so its alert goes with nothing sent, and the entry point becomes
    /// the member's Leave button.
    func testAHostHandOffRemovesCancelsAlert() {
        let app = lobby("tournament-rounds", ["-uiHandOffOnAlert", "kim"])
        openHostMenu(app)
        app.buttons["Cancel Tournament…"].firstMatch.tap()
        let alert = openedAlert(app, "Cancel tournament?", TournamentCopy.cancelInTheLobby)
        waitFor("the hand-off took Cancel's alert away", timeout: 6) { !alert.exists }
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(app.alerts.count, 0, "no other alert in its place")
        XCTAssertEqual(sent(app), "-", "nothing sent")
        XCTAssertTrue(leaveButton(app).waitForExistence(timeout: 3), "a member now: the Leave button")
        XCTAssertFalse(more(app).exists)
        app.terminate()
    }

    /// The role coming to me while Leave's alert is up (`-uiHost kim -uiHandOffOnAlert ivy`): the
    /// same alert stays and its consequence gains "Another player becomes the host." in place.
    func testAHandOffChangesLeavesWordsInPlace() {
        let app = lobby("tournament-rounds", ["-uiHost", "kim", "-uiHandOffOnAlert", "ivy"])
        let button = leaveButton(app)
        reach(app, button)
        button.tap()
        let alert = openedAlert(app, "Leave tournament?", TournamentCopy.memberLeavesTheLobby)
        let frame = alert.frame
        var seenGone = false
        let end = Date().addingTimeInterval(6)
        while !alert.staticTexts[TournamentCopy.hostLeavesTheLobby].exists && Date() < end {
            if app.alerts.count == 0 { seenGone = true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertTrue(alert.staticTexts[TournamentCopy.hostLeavesTheLobby].exists, "the host's consequence")
        XCTAssertFalse(seenGone, "never closed and opened again")
        XCTAssertEqual(app.alerts.count, 1)
        XCTAssertEqual(alert.frame.midX, frame.midX, accuracy: 1, "the same alert, where it was")
        shot("alert-handoff-in-place")
        confirm(alert).tap()
        waitFor("leaveTournament sent") { sent(app) == "leaveTournament" }
        app.terminate()
    }

    /// The tournament gone under Leave's alert with no screen change (`-uiResetOnAlert`: the state
    /// is reset 3 s after it opens): the alert goes with nothing sent, never "The tournament ends,
    /// since nobody else has joined." in place (review of PR #437).
    func testTheTournamentGoneRemovesTheAlert() {
        let app = lobby("tournament-between", ["-uiResetOnAlert", "YES"])
        let button = leaveButton(app)
        reach(app, button)
        button.tap()
        let alert = openedAlert(app, "Leave tournament?", TournamentCopy.noWayBack)
        waitFor("the tournament going took the alert away", timeout: 6) { !alert.exists }
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(app.alerts.count, 0, "no alert with new words in its place")
        XCTAssertEqual(sent(app), "-", "nothing sent")
        app.terminate()
    }

    /// A re-entry under Cancel's alert (`-uiRejoinOnAlert`: 3 s after it opens, for 3 s): the
    /// same alert stays, its Cancel Tournament disabled while the re-entry waits (as the menu
    /// item is), then enabled again; it sends cancelTournament once tapped (review of PR #437: it
    /// closed the alert and sent nothing).
    func testCancelsConfirmWaitsForTheReentry() {
        let app = lobby("tournament-rounds", ["-uiRejoinOnAlert", "YES"])
        openHostMenu(app)
        app.buttons["Cancel Tournament…"].firstMatch.tap()
        let alert = openedAlert(app, "Cancel tournament?", TournamentCopy.cancelInTheLobby)
        XCTAssertTrue(confirm(alert).isEnabled, "enabled while the session is up")
        XCTAssertTrue(keep(alert).isEnabled)
        waitFor("disabled during the re-entry", timeout: 6) { !confirm(alert).isEnabled }
        XCTAssertTrue(alert.exists, "the same alert stays")
        XCTAssertTrue(keep(alert).isEnabled, "Keep Tournament never waits")
        shot("alert-cancel-waits")
        waitFor("enabled once the re-entry is answered", timeout: 6) { confirm(alert).isEnabled }
        XCTAssertEqual(sent(app), "-")
        confirm(alert).tap()
        waitFor("cancelTournament sent") { sent(app) == "cancelTournament" }
        app.terminate()
    }

    /// Screenshots of the entry point, the menu and each alert at the default size and AX5
    /// (`TEST_RUNNER_BAB_SHOTS`): the host in the lobby (the menu, Cancel, Leave), the host between
    /// rounds (Cancel), a member between rounds (the Leave button), a spectator. Each alert must
    /// read whole in the picture.
    func testConfirmScreenshots() {
        // (who, launch, fixture, the menu item or nil for the button, question, message, file tag)
        let cases: [(String, [String], String, String?, String, String, String)] = [
            ("host-lobby", [], "tournament-rounds", "Cancel Tournament…", "Cancel tournament?", TournamentCopy.cancelInTheLobby, "cancel"),
            ("host-lobby", [], "tournament-rounds", "Leave Tournament…", "Leave tournament?", TournamentCopy.hostLeavesTheLobby, "leave"),
            ("host-between", ["-uiHost", "ivy"], "tournament-between", "Cancel Tournament…", "Cancel tournament?", TournamentCopy.cancelOnceBegun, "cancel"),
            ("member-between", [], "tournament-between", nil, "Leave tournament?", TournamentCopy.noWayBack, "leave"),
            ("spectator", ["-uiSpectator", "YES"], "tournament-pairings", nil, "Stop watching?", TournamentCopy.stopWatching, "stop"),
        ]
        for (size, args) in [("default", [String]()), ("ax5", Self.ax5)] {
            var entryShot = Set<String>()
            for (who, extra, fixture, item, question, message, tag) in cases {
                let app = lobby(fixture, extra + args)
                if let item {
                    openHostMenu(app)
                    if !entryShot.contains(who) { shot("\(size)-\(who)-menu"); entryShot.insert(who) }
                    app.buttons[item].firstMatch.tap()
                } else {
                    let button = who == "spectator" ? entryButton(app, "tournament.stopWatching", "Stop Watching") : leaveButton(app)
                    reach(app, button)
                    XCTAssertTrue(button.isHittable, "\(size) \(who): the button")
                    // one line in the AX controls row (review of PR #437: "Stop / Watching" was 132 pt)
                    XCTAssertLessThan(button.frame.height, 100, "\(size) \(who): one line, \(button.frame)")
                    shot("\(size)-\(who)-button")
                    button.tap()
                }
                let alert = openedAlert(app, question, message)
                XCTAssertTrue(confirm(alert).isHittable, "\(size) \(who): the confirm")
                XCTAssertTrue(keep(alert).isHittable, "\(size) \(who): the keep button")
                shot("\(size)-\(who)-\(tag)-alert")
                app.terminate()
            }
        }
    }

    /// The results: no menu, no Leave and no slot; the back control reads Main Room.
    func testNoMenuOnTheResults() {
        let app = lobby("tournament-results", ["-uiPlainResults", "YES"])
        XCTAssertTrue(app.buttons["Main Room"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(more(app).exists)
        XCTAssertFalse(leaveButton(app).exists)
        XCTAssertFalse(element(app, "tournament.ready").exists)
        app.terminate()
    }

    // MARK: - Text sizes

    /// XXXL and AX5: the slot's button and caption are whole and on screen without scrolling
    /// (pinned: at AX5 the host's Rounds picker scrolls with the players, review of PR #430),
    /// the menu reachable, and the picker still there under the header.
    func testTheSlotAtLargeTextSizes() {
        for (tag, size) in [("xxxl", Self.xxxl), ("ax5", Self.ax5)] {
            let app = lobby("tournament-rounds", size + ["-uiMeReady", "YES"])
            let slot = element(app, "tournament.ready")
            XCTAssertTrue(slot.waitForExistence(timeout: 5), "\(tag): the slot")
            XCTAssertTrue(slot.isHittable, "\(tag): the slot is pinned, on screen at once")
            assertOnScreen(app, slot, "\(tag) slot")
            XCTAssertGreaterThan(slot.frame.height, 44, "\(tag): it grows with the text")
            let caption = element(app, "tournament.slotCaption")
            assertOnScreen(app, caption, "\(tag) caption")
            XCTAssertTrue(more(app).exists, "\(tag): the menu")
            XCTAssertTrue(element(app, "tournament.rounds").exists, "\(tag): the host's Rounds picker")
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
