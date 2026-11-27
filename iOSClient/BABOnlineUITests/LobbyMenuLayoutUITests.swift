import XCTest

/// The tournament lobby's layout (owner 2026-11-26): one action slot at the bottom (Ready ->
/// Unready; the host's Begin once allowed, with Unready under it), the host's Rounds picker in the
/// header, Leave / Stop Watching as a button (a member, a spectator), the host's Leave and End
/// Tournament as two icons (owner 2026-11-26: one action = one icon; the "…" menu only where a header
/// cannot fit both, which no tested device reaches; in the Duo's vertical bar Leave alone in the top
/// pill as the game's Exit, End in its own pill under it), each confirmed by a centred alert; and New Game
/// as a native menu with each choice's words under its name (Tournament among them), the trophy
/// opening the leaderboard. Fixture mode; run on the iPhone 18 Pro, the iPad and the iPhone Duo
/// closed and open (where the buttons are vertical bar items).
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
        static let endInTheLobby = "The tournament ends for everyone before it starts."
        static let endOnceBegun = "The tournament ends for everyone, and any games still in play stop now."
        static let hostLeavesTheLobby = "You can join again while it's waiting to start. Another player becomes the host."
        static let memberLeavesTheLobby = "You can join again while it's waiting to start."
        static let noWayBack = "You can't come back to this tournament, and you won't be among the winners."
        static let stopWatching = "You go back to the main room."
    }

    /// The fallback "…" menu (only where a header row cannot fit the host's two icons).
    private var more: (XCUIApplication) -> XCUIElement {
        { $0.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "tournament.more", "More")).firstMatch }
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
        XCTAssertTrue(endButton(app).exists && leaveButton(app).exists, "the host's two icons")
        XCTAssertFalse(more(app).exists, "no menu")
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
            // the host keeps Leave and End Tournament, a member the Leave button alone
            XCTAssertTrue(leaveButton(app).exists, "Leave stays (\(host))")
            XCTAssertEqual(endButton(app).exists, host == "ivy", "End only for the host (\(host))")
            app.terminate()
        }
    }

    // MARK: - Leave / End Tournament / Stop Watching

    /// A Leave / End / Stop Watching button (before any alert is up: the alert has a "Leave
    /// Tournament" button too), by its identifier or its VoiceOver label (the vertical bar's item).
    private func entryButton(_ app: XCUIApplication, _ id: String, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", id, label)).firstMatch
    }

    private func leaveButton(_ app: XCUIApplication) -> XCUIElement {
        entryButton(app, "tournament.leave", "Leave Tournament")
    }

    private func endButton(_ app: XCUIApplication) -> XCUIElement {
        entryButton(app, "tournament.end", "End Tournament")
    }

    /// Brings the entry point into reach (at AX5 the header can sit above a scrolled list).
    private func reach(_ app: XCUIApplication, _ e: XCUIElement) {
        XCTAssertTrue(e.waitForExistence(timeout: 5), "the entry point")
        for _ in 0..<4 where !e.isHittable { app.swipeDown(velocity: .slow) }
    }

    /// The host's two icons, Leave and End Tournament (owner 2026-11-26: "tournament host should
    /// get two separate icons"): both reachable, side by side (a row in the header, a column in the
    /// Duo's bar, a pill each), no "…" menu (the fallback never shows on a tested device), nothing
    /// asked yet.
    @discardableResult
    private func hostButtons(_ app: XCUIApplication, file: StaticString = #filePath,
                             line: UInt = #line) -> (leave: XCUIElement, end: XCUIElement) {
        let leave = leaveButton(app), end = endButton(app)
        reach(app, end)
        XCTAssertTrue(leave.isHittable, "Leave is reachable", file: file, line: line)
        XCTAssertTrue(end.isHittable, "End Tournament is reachable", file: file, line: line)
        XCTAssertFalse(more(app).exists, "two icons, no menu", file: file, line: line)
        XCTAssertEqual(leave.label, "Leave Tournament", "VoiceOver hears the whole choice", file: file, line: line)
        XCTAssertEqual(end.label, "End Tournament", file: file, line: line)
        let l = leave.frame, e = end.frame
        XCTAssertFalse(l.intersects(e.insetBy(dx: 1, dy: 1)), "apart: \(l) \(e)", file: file, line: line)
        let row = abs(l.midY - e.midY) < 2, column = abs(l.midX - e.midX) < 2
        XCTAssertTrue(row || column, "side by side: \(l) \(e)", file: file, line: line)
        if row { XCTAssertLessThan(e.maxX, l.minX + 1, "End before Leave, Leave in the corner", file: file, line: line) }
        if column {
            XCTAssertLessThan(l.maxY, e.minY + 1, "Leave on top in the bar", file: file, line: line)
            // Leave alone in the top pill as the game's Exit, End in its own pill under it (owner
            // 2026-11-27): on the open Duo (iOS 27.2) two items of one pill sit 14 pt apart, two
            // pills 22 pt
            XCTAssertGreaterThan(e.minY - l.maxY, 18, "End in its own pill: \(l) \(e)", file: file, line: line)
        }
        XCTAssertEqual(app.alerts.count, 0, "nothing asked yet", file: file, line: line)
        return (leave, end)
    }

    /// The alert a choice opens: centred (no popover), its question and the consequence.
    private func openedAlert(_ app: XCUIApplication, _ question: String, _ message: String,
                             file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let alert = app.alerts[question]
        XCTAssertTrue(alert.waitForExistence(timeout: 4), "the alert \(question)", file: file, line: line)
        XCTAssertTrue(alert.staticTexts[message].exists, "it says what happens: \(message)", file: file, line: line)
        XCTAssertEqual(app.popovers.count, 0, "no popover", file: file, line: line)
        XCTAssertEqual(app.alerts.count, 1, "one alert", file: file, line: line)
        // never a menu behind it
        XCTAssertFalse(app.buttons["End Tournament…"].exists, "no menu behind the alert", file: file, line: line)
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

    /// End Tournament: the host's stop icon, a centred alert "End tournament?" with the
    /// consequence; Keep Tournament sends nothing; End Tournament sends cancelTournament (the wire
    /// event keeps its name).
    func testEndAsksInAnAlertAndKeepSendsNothing() {
        let app = lobby("tournament-rounds")
        let buttons = hostButtons(app)
        shot("host-icons")
        buttons.end.tap()
        var alert = openedAlert(app, "End tournament?", TournamentCopy.endInTheLobby)
        XCTAssertEqual(confirm(alert).label, "End Tournament")
        XCTAssertEqual(keep(alert).label, "Keep Tournament", "never a bare Cancel")
        XCTAssertEqual(sent(app), "-", "nothing sent before the confirmation")
        shot("alert-host-end")
        keep(alert).tap()
        waitGone(alert, "Keep Tournament closed the alert")
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertEqual(sent(app), "-", "Keep Tournament keeps the tournament")
        XCTAssertTrue(element(app, "tournament.ready").exists, "still in the lobby")

        hostButtons(app).end.tap()
        alert = openedAlert(app, "End tournament?", TournamentCopy.endInTheLobby)
        confirm(alert).tap()
        waitFor("cancelTournament sent") { sent(app) == "cancelTournament" }
        app.terminate()
    }

    /// The host's Leave: its own icon, the alert says the role passes on; Stay keeps me there,
    /// Leave Tournament sends leaveTournament.
    func testTheHostsLeaveAsksInAnAlert() {
        let app = lobby("tournament-rounds")
        hostButtons(app).leave.tap()
        var alert = openedAlert(app, "Leave tournament?", TournamentCopy.hostLeavesTheLobby)
        XCTAssertEqual(confirm(alert).label, "Leave Tournament")
        XCTAssertEqual(keep(alert).label, "Stay")
        keep(alert).tap()
        waitGone(alert, "Stay closed the alert")
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(sent(app), "-", "Stay keeps me in the tournament")
        hostButtons(app).leave.tap()
        alert = openedAlert(app, "Leave tournament?", TournamentCopy.hostLeavesTheLobby)
        shot("alert-host-leave")
        confirm(alert).tap()
        waitFor("leaveTournament sent") { sent(app) == "leaveTournament" }
        app.terminate()
    }

    /// End Tournament waits for the session (`-uiSessionPending YES`): disabled, while Leave never
    /// waits and still asks.
    func testEndWaitsForTheSessionAndLeaveDoesNot() {
        let app = lobby("tournament-rounds", ["-uiSessionPending", "YES"])
        let leave = leaveButton(app), end = endButton(app)
        reach(app, end)
        XCTAssertFalse(end.isEnabled, "End Tournament waits for the session")
        XCTAssertTrue(leave.isEnabled, "Leave never waits")
        shot("host-icons-session-pending")
        leave.tap()
        let alert = openedAlert(app, "Leave tournament?", TournamentCopy.hostLeavesTheLobby)
        keep(alert).tap()
        waitGone(alert, "Stay closed the alert")
        XCTAssertEqual(sent(app), "-")
        app.terminate()
    }

    /// During the cut the host has only Leave: one button, no End, no menu.
    func testTheHostDuringTheCutHasOnlyLeave() {
        let app = lobby("tournament-cut", ["-uiCut", "8 drawing", "-uiHost", "ivy"])
        let leave = leaveButton(app)
        reach(app, leave)
        XCTAssertFalse(endButton(app).exists, "no End during the cut")
        XCTAssertFalse(more(app).exists)
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
        XCTAssertFalse(endButton(app).exists, "only the host ends it")
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

    /// A host hand-off while End's alert is up (`-uiHandOffOnAlert kim`, 3 s after it opens): End
    /// is no longer mine, so its alert goes with nothing sent, and only the member's Leave is left.
    func testAHostHandOffRemovesEndsAlert() {
        let app = lobby("tournament-rounds", ["-uiHandOffOnAlert", "kim"])
        hostButtons(app).end.tap()
        let alert = openedAlert(app, "End tournament?", TournamentCopy.endInTheLobby)
        waitFor("the hand-off took End's alert away", timeout: 6) { !alert.exists }
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(app.alerts.count, 0, "no other alert in its place")
        XCTAssertEqual(sent(app), "-", "nothing sent")
        XCTAssertTrue(leaveButton(app).waitForExistence(timeout: 3), "a member now: the Leave button")
        waitFor("no End for a member") { !endButton(app).exists }
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

    /// A re-entry under End's alert (`-uiRejoinOnAlert`: 3 s after it opens, for 3 s): the same
    /// alert stays, its End Tournament disabled while the re-entry waits (as the icon is), then
    /// enabled again; it sends cancelTournament once tapped (review of PR #437: it closed the alert
    /// and sent nothing).
    func testEndsConfirmWaitsForTheReentry() {
        let app = lobby("tournament-rounds", ["-uiRejoinOnAlert", "YES"])
        hostButtons(app).end.tap()
        let alert = openedAlert(app, "End tournament?", TournamentCopy.endInTheLobby)
        XCTAssertTrue(confirm(alert).isEnabled, "enabled while the session is up")
        XCTAssertTrue(keep(alert).isEnabled)
        waitFor("disabled during the re-entry", timeout: 6) { !confirm(alert).isEnabled }
        XCTAssertTrue(alert.exists, "the same alert stays")
        XCTAssertTrue(keep(alert).isEnabled, "Keep Tournament never waits")
        shot("alert-end-waits")
        waitFor("enabled once the re-entry is answered", timeout: 6) { confirm(alert).isEnabled }
        XCTAssertEqual(sent(app), "-")
        confirm(alert).tap()
        waitFor("cancelTournament sent") { sent(app) == "cancelTournament" }
        app.terminate()
    }

    /// Screenshots of the buttons and each alert at the default size and AX5
    /// (`TEST_RUNNER_BAB_SHOTS`): the host in the lobby (its two icons: End, Leave), the host between
    /// rounds (End), a member between rounds (the Leave button), a spectator. Each alert must read
    /// whole in the picture.
    func testConfirmScreenshots() {
        // (who, launch, fixture, the button's identifier, question, message, file tag)
        let cases: [(String, [String], String, String, String, String, String)] = [
            ("host-lobby", [], "tournament-rounds", "tournament.end", "End tournament?", TournamentCopy.endInTheLobby, "end"),
            ("host-lobby", [], "tournament-rounds", "tournament.leave", "Leave tournament?", TournamentCopy.hostLeavesTheLobby, "leave"),
            ("host-between", ["-uiHost", "ivy"], "tournament-between", "tournament.end", "End tournament?", TournamentCopy.endOnceBegun, "end"),
            ("member-between", [], "tournament-between", "tournament.leave", "Leave tournament?", TournamentCopy.noWayBack, "leave"),
            ("spectator", ["-uiSpectator", "YES"], "tournament-pairings", "tournament.stopWatching", "Stop watching?", TournamentCopy.stopWatching, "stop"),
        ]
        for (size, args) in [("default", [String]()), ("ax5", Self.ax5)] {
            for (who, extra, fixture, id, question, message, tag) in cases {
                let app = lobby(fixture, extra + args)
                let label = ["tournament.end": "End Tournament", "tournament.leave": "Leave Tournament"][id] ?? "Stop Watching"
                let button = entryButton(app, id, label)
                if who.hasPrefix("host") { hostButtons(app) } else { reach(app, button) }
                XCTAssertTrue(button.isHittable, "\(size) \(who): the button")
                // one line in the AX controls row (review of PR #437: "Stop / Watching" was 132 pt)
                XCTAssertLessThan(button.frame.height, 100, "\(size) \(who): one line, \(button.frame)")
                shot("\(size)-\(who)-\(tag)-button")
                button.tap()
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
        XCTAssertFalse(endButton(app).exists)
        XCTAssertFalse(element(app, "tournament.ready").exists)
        app.terminate()
    }

    // MARK: - Text sizes

    /// XXXL and AX5: the slot's button and caption are whole and on screen without scrolling
    /// (pinned: at AX5 the host's Rounds picker scrolls with the players, review of PR #430),
    /// the host's two buttons reachable, and the picker still there under the header.
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
            XCTAssertTrue(endButton(app).exists && leaveButton(app).exists, "\(tag): the host's two buttons")
            XCTAssertFalse(more(app).exists, "\(tag): two icons fit, no menu")
            XCTAssertTrue(element(app, "tournament.rounds").exists, "\(tag): the host's Rounds picker")
            shot("lobby-host-ready-\(tag)")
            app.terminate()
        }
    }

    /// The accessibility sizes' controls row (review of PR #438: at every AX size the host's words
    /// went straight to two bare icons, while a member's Leave kept its word): in a header row the
    /// host's Leave and End Tournament show their words (capped to fit the row,
    /// TournamentLobbyMenu.wordCaps), with the mic on and off, the pair apart from the mic. In the
    /// Duo's vertical bar (a column) they are the bar's items.
    func testTheHostsWordsAtAccessibilitySizes() {
        let sizes = [("ax1", "UICTContentSizeCategoryAccessibilityM"), ("ax3", "UICTContentSizeCategoryAccessibilityXL"),
                     ("ax5", "UICTContentSizeCategoryAccessibilityXXXL")]
        for (tag, category) in sizes {
            for voice in [false, true] {
                let what = "\(tag)\(voice ? " voice" : "")"
                let app = lobby("tournament-between", ["-uiHost", "ivy", "-UIPreferredContentSizeCategoryName", category]
                                + (voice ? ["-uiVoice", "YES"] : []))
                let (leave, end) = hostButtons(app)
                let l = leave.frame, e = end.frame
                print("\(what): leave \(l) end \(e)")
                if abs(l.midY - e.midY) < 2 {
                    XCTAssertGreaterThan(e.width, e.height * 2.5, "\(what): End Tournament shows its words, \(e)")
                    XCTAssertGreaterThan(l.width, l.height * 1.6, "\(what): Leave shows its word, \(l)")
                    let window = app.windows.firstMatch.frame
                    XCTAssertTrue(window.contains(e) && window.contains(l), "\(what): both whole on screen")
                    XCTAssertLessThan(l.height, 100, "\(what): one line")
                    if voice {
                        let mic = element(app, "tournament.mic")
                        XCTAssertTrue(mic.exists, "\(what): the mic")
                        print("\(what): mic \(mic.frame)")
                        XCTAssertLessThan(mic.frame.maxX, e.minX, "\(what): the mic, then the pair")
                        XCTAssertLessThan(abs(mic.frame.midY - e.midY), 8, "\(what): one row")
                    }
                }
                shot("\(tag)\(voice ? "-voice" : "")-host-words")
                app.terminate()
            }
        }
    }

    /// The default one-row header with the mic (review of PR #438: a stop beside a mic): the mic,
    /// a gap, then End Tournament and Leave.
    func testTheHostsIconsBesideTheMic() {
        let app = lobby("tournament-between", ["-uiHost", "ivy", "-uiVoice", "YES"])
        let (leave, end) = hostButtons(app)
        let mic = element(app, "tournament.mic")
        if abs(leave.frame.midY - end.frame.midY) < 2 {
            XCTAssertTrue(mic.exists, "the mic")
            XCTAssertLessThan(mic.frame.maxX, end.frame.minX, "the mic, then the pair")
            print("mic \(mic.frame) end \(end.frame) leave \(leave.frame)")
        }
        shot("default-voice-host-icons")
        app.terminate()
    }

    // MARK: - New Game and the trophy

    private func mainRoom(_ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch("main-room", extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        return app
    }

    private func subtitle(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    /// New Game is a native menu: each choice with its words as the subtitle (the item's label
    /// reads both), Tournament the third; nothing is sent until one is picked.
    func testNewGameIsAMenuWithSubtitles() {
        let app = mainRoom()
        app.buttons["New Game"].firstMatch.tap()
        let classic = Fixture.newGameChoice(app, "classic"), gyb = Fixture.newGameChoice(app, "gyb")
        let tournament = Fixture.newGameChoice(app, "tournament")
        XCTAssertTrue(classic.waitForExistence(timeout: 5))
        XCTAssertTrue(gyb.exists)
        XCTAssertTrue(tournament.exists, "Tournament is New Game's third choice")
        XCTAssertLessThan(gyb.frame.minY, tournament.frame.minY, "after the two games")
        XCTAssertTrue(subtitle(app, "4 players in two teams").exists, "Back Alley Bridge's subtitle")
        XCTAssertTrue(subtitle(app, "Score only by taking exactly what you bid").exists, "Get Your Bid's subtitle")
        XCTAssertTrue(subtitle(app, "Several rounds, a new partner each round. The top score wins.").exists,
                      "Tournament's subtitle, the web's words")
        XCTAssertFalse(app.staticTexts["New Game"].exists && app.buttons["Cancel"].exists, "no dialog with a Cancel")
        XCTAssertEqual(sent(app), "-")
        shot("newgame-menu")
        gyb.tap()
        waitFor("createLobby:gyb") { sent(app) == "createLobby:gyb" }
        app.terminate()
    }

    /// New Game's Tournament sends what creating a tournament always sent (createTournament).
    func testNewGamesTournamentCreatesATournament() {
        let app = mainRoom()
        app.buttons["New Game"].firstMatch.tap()
        let tournament = Fixture.newGameChoice(app, "tournament")
        XCTAssertTrue(tournament.waitForExistence(timeout: 5))
        tournament.tap()
        waitFor("createTournament sent") { sent(app) == "createTournament" }
        app.terminate()
    }

    /// New Game, and with it a tournament, waits for the session; the trophy (a sheet) does not.
    func testNewGameWaitsForTheSessionAndTheTrophyDoesNot() {
        let app = mainRoom(["-uiSessionPending", "YES"])
        XCTAssertFalse(app.buttons["New Game"].firstMatch.isEnabled)
        XCTAssertTrue(trophy(app).isEnabled)
        app.terminate()
    }

    /// The main room's header at AX5: whichever ViewThatFits form fits (words, New Game's word
    /// with the trophy's icon, or icons), New Game and the trophy are on screen and reachable.
    func testTheMainRoomHeaderAtAX5() {
        let app = mainRoom(Self.ax5)
        let newGame = app.buttons["New Game"].firstMatch, button = trophy(app)
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        XCTAssertTrue(newGame.isHittable, "New Game")
        XCTAssertTrue(button.isHittable, "the trophy")
        assertOnScreen(app, newGame, "New Game")
        assertOnScreen(app, button, "the trophy")
        XCTAssertFalse(newGame.frame.intersects(button.frame.insetBy(dx: 1, dy: 1)), "\(newGame.frame) \(button.frame)")
        print("ax5 header: New Game \(newGame.frame) trophy \(button.frame)")
        shot("mainroom-header-ax5")
        button.tap()
        XCTAssertTrue(app.navigationBars["Leaderboard"].waitForExistence(timeout: 5))
        app.terminate()
    }

    private func trophy(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "mainRoom.leaderboard", "Leaderboard")).firstMatch
    }

    /// The open Duo's bar (owner 2026-11-27): New Game alone in the top pill; the trophy starts the
    /// bottom pill, above Players and the settings. A pill break is a wider gap than the spacing
    /// inside a pill.
    func testTheBarPutsTheTrophyInTheBottomPill() {
        let app = mainRoom()
        let pose = Fixture.probe(app, "ui.pose")
        guard pose.contains(" vbar ") else { app.terminate(); return }  // only where the bar shows
        let newGame = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "New Game")).firstMatch
        let cup = trophy(app)
        let players = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "online")).firstMatch
        let settings = app.buttons.matching(NSPredicate(format: "label == %@", "Account settings")).firstMatch
        for (e, name) in [(newGame, "New Game"), (cup, "trophy"), (players, "Players"), (settings, "settings")] {
            XCTAssertTrue(e.waitForExistence(timeout: 5), name)
        }
        let n = newGame.frame, t = cup.frame, p = players.frame, s = settings.frame
        XCTAssertLessThan(n.midY, t.midY, "New Game above the trophy")
        XCTAssertLessThan(t.midY, p.midY, "the trophy above Players")
        XCTAssertLessThan(p.midY, s.midY, "Players above the settings")
        let pillBreak = t.minY - n.maxY, inside = p.minY - t.maxY
        XCTAssertGreaterThan(pillBreak, inside + 4, "New Game and the trophy in different pills (gap \(pillBreak) vs \(inside))")
        shot("bar-trophy-bottom-pill")
        app.terminate()
    }

    /// The trophy opens the leaderboard and records (the Stats sheet); there is no Stats icon and
    /// no Tournament button any more (header and the Duo's bar).
    func testTheTrophyOpensTheLeaderboardAndThereIsNoStatsIcon() {
        let app = mainRoom()
        let button = trophy(app)
        XCTAssertTrue(button.waitForExistence(timeout: 5), "the trophy")
        XCTAssertEqual(button.label, "Leaderboard")
        XCTAssertTrue(button.isHittable)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "Stats")).count, 0, "no Stats icon")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "Tournament")).count, 0,
                       "a tournament is New Game's choice")
        shot("mainroom-header")
        button.tap()
        XCTAssertTrue(app.navigationBars["Leaderboard"].waitForExistence(timeout: 5), "the leaderboard's sheet, titled as its button")
        XCTAssertFalse(app.navigationBars["Stats"].exists)
        XCTAssertTrue(app.segmentedControls.buttons["Leaderboard"].exists, "the Leaderboard tab")
        XCTAssertTrue(app.segmentedControls.buttons["Records"].exists, "Records is there too")
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        shot("leaderboard-from-trophy")
        XCTAssertEqual(sent(app), "-", "the trophy sends nothing of its own (the sheet asks for the rows)")
        app.terminate()
    }
}
