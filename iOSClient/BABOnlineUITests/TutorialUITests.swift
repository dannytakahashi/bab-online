import XCTest

/// The tutorial on iOS (State/Table/Tutorial.swift), in fixture mode: `-uiTutorial YES` turns it
/// on as an auto-start does and pushes this turn's welcome tip, rule tip and advice as the server
/// does (UIFixture+Tutorial). The welcome is no card (owner 2026-11-21): its row is in the log and
/// the rule tip shows at once, in its neutral card, with the advice's chip and headline in sight;
/// the advice in the /help card with its ring and no count; the tutorial's switch, there all
/// game on or off (the round button under the log's, the iPhone Duo's vertical bar item there),
/// asking before an on that makes the game bot-assisted; /tutorial in the chat list; and what
/// the column keeps clear of (my bid clock, my seat's row, the lightbulb, the fold, the corner
/// buttons: probes "table.assist" and "table.tutorial").
/// `TEST_RUNNER_BAB_SHOTS=<folder>` saves PNGs.
final class TutorialUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let png = app.screenshot()
        let a = XCTAttachment(screenshot: png)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("tutorial-\(name).png"))
        }
    }

    private func launch(_ fixture: String, _ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: ["-uiTutorial", "YES", "-uiAssist", "YES"] + extra)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        return app
    }

    private func waitFor(_ app: XCUIApplication, _ probe: String, contains text: String, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if Fixture.probe(app, probe).contains(text) { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
    }

    /// The vertical bar's column in screen points (the iPhone Duo closed, open in landscape, book
    /// pose: probe "ui.pose" ends "vbar <edge>"), nil where the system shows none.
    private func verticalBarColumn(_ app: XCUIApplication) -> ClosedRange<CGFloat>? {
        let pose = Fixture.probe(app, "ui.pose")
        guard let edge = pose.split(separator: " ").last, edge != "-", pose.contains(" vbar "),
              let size = Fixture.windowSize(pose), let insets = Fixture.insets(pose) else { return nil }
        switch edge {
        case "trailing": return (size.width - insets.right)...size.width
        case "leading": return 0...insets.left
        default:
            XCTFail("unexpected vertical bar edge in \(pose)")
            return nil
        }
    }

    /// The switch's frame: in the vertical bar's column (probe "chip=bar"), else the round button
    /// under the log's in the top trailing corner (probe "chip=corner"), hittable, clear of the
    /// column's cards and of what the column keeps clear of.
    @discardableResult
    private func chipClear(_ app: XCUIApplication, _ tag: String) -> CGRect {
        XCTAssertTrue(element(app, "tutorial.chip").waitForExistence(timeout: 5), tag)
        if let bar = verticalBarColumn(app) {
            XCTAssertTrue(waitFor(app, "table.tutorial", contains: "chip=bar"), "\(tag): \(Fixture.probe(app, "table.tutorial"))")
            let f = element(app, "tutorial.chip").frame
            XCTAssertTrue(bar.contains(f.midX), "\(tag): the switch \(f) outside the vertical bar \(bar)")
            return f
        }
        XCTAssertTrue(waitFor(app, "table.tutorial", contains: "chip=corner"), "\(tag): \(Fixture.probe(app, "table.tutorial"))")
        XCTAssertTrue(waitFor(app, "table.tutorial", contains: "clear=ok"),
                      "\(tag): \(Fixture.probe(app, "table.tutorial")) keeps \(Fixture.probe(app, "table.assist")) [\(Fixture.probe(app, "ui.pose"))]")
        print("[TutorialUITests] \(tag) \(Fixture.probe(app, "table.tutorial")) | \(Fixture.probe(app, "table.assist")) [\(Fixture.probe(app, "ui.pose"))]")
        let f = element(app, "tutorial.chip").frame
        let log = app.buttons["log"]
        if log.exists {
            // the same round size as the log's button
            XCTAssertEqual(f.width, log.frame.width, accuracy: 1.5, "\(tag): the switch \(f) the log's size \(log.frame)")
            if Fixture.probe(app, "table.tutorial").contains("chip=corner beside") {
                // beside it (a short pane: TableLayout.tutorialPlacement), level with it
                XCTAssertLessThanOrEqual(f.maxX, log.frame.minX + 1, "\(tag): the switch \(f) left of the log's button \(log.frame)")
                XCTAssertEqual(f.midY, log.frame.midY, accuracy: 1.5, "\(tag): level with the log's button")
            } else {
                XCTAssertGreaterThanOrEqual(f.minY, log.frame.maxY - 1, "\(tag): the switch \(f) under the log's button \(log.frame)")
                XCTAssertEqual(f.midX, log.frame.midX, accuracy: 1.5, "\(tag): centred under the log's button")
            }
        }
        XCTAssertFalse(f.intersects(app.buttons["leave"].frame), tag)
        XCTAssertFalse(f.intersects(columnFrame(app)), "\(tag): the switch \(f) under the column \(columnFrame(app))")
        XCTAssertTrue(element(app, "tutorial.chip").isHittable, tag)
        return f
    }

    /// The column's visible frame from the probe "table.assist" (frame=x y w h).
    private func columnFrame(_ app: XCUIApplication) -> CGRect {
        let probe = Fixture.probe(app, "table.assist")
        let parts = probe.components(separatedBy: "frame=").last?.split(separator: " ").prefix(4).compactMap { Double($0) } ?? []
        guard parts.count == 4 else { return .null }
        return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
    }

    /// The advice's confidence chip and headline are fully in sight: inside the screen and inside
    /// the column's visible frame (not scrolled out of it), and hittable.
    private func adviceInSight(_ app: XCUIApplication, _ tag: String) {
        let chip = element(app, "assist.confidence")
        let head = element(app, "assist.headline")
        XCTAssertTrue(chip.waitForExistence(timeout: 5), tag)
        XCTAssertTrue(head.waitForExistence(timeout: 5), tag)
        let screen = app.windows.firstMatch.frame
        let column = columnFrame(app).insetBy(dx: -1, dy: -1)
        for (name, e) in [("chip", chip), ("headline", head)] {
            XCTAssertTrue(screen.contains(e.frame), "\(tag): the advice's \(name) \(e.frame) off the screen \(screen)")
            XCTAssertTrue(column.contains(e.frame),
                          "\(tag): the advice's \(name) \(e.frame) scrolled out of the column \(column) [\(Fixture.probe(app, "ui.pose"))]")
            XCTAssertTrue(e.isHittable, "\(tag): the advice's \(name)")
        }
    }

    /// The cards cover nothing of the partner's seat (avatar, name, bid bubble, dealer button:
    /// probe "table.assist" seats=), and on a wide screen (the iPhone Duo open, an iPad) nothing
    /// of the side seats either. On a phone in portrait the side seats are level with the only
    /// room above the bid panel; clearing them would leave the cards under AssistLayout.sideRoom.
    private func clearOfSeats(_ app: XCUIApplication, _ tag: String) {
        let probe = Fixture.probe(app, "table.assist")
        let part = probe.components(separatedBy: " seats=").last ?? ""
        XCTAssertFalse(part.isEmpty || part == "-", "\(tag): \(probe)")
        let over = part.hasPrefix("over:") ? part.dropFirst(5).split(separator: ",").map(String.init) : []
        print("[TutorialUITests] \(tag) seats=\(part)")
        XCTAssertFalse(over.contains { !$0.hasPrefix("side.") }, "\(tag): the cards over the partner: \(probe) [\(Fixture.probe(app, "ui.pose"))]")
        if app.windows.firstMatch.frame.width > 700 {
            XCTAssertEqual(part, "ok", "\(tag): \(probe) [\(Fixture.probe(app, "ui.pose"))]")
        }
    }

    /// The tip's title and × are in sight: the card's own row inside the column, or (a short
    /// column scrolled to the advice) the row pinned at the column's top (probe pin=).
    private func tipHeadInSight(_ app: XCUIApplication, _ card: XCUIElement, _ tag: String) {
        let column = columnFrame(app).insetBy(dx: -1, dy: -1)
        let pinned = element(app, "tip.pinned").exists
        let title = app.staticTexts[pinned ? "tip.pinnedTitle" : "tip.title"].frame
        let close = tipButton(app, "tip.close")
        XCTAssertTrue(column.contains(title) && column.contains(close.frame), "\(tag): title \(title) × \(close.frame) column \(column)")
        if !pinned { XCTAssertTrue(close.isHittable, tag); return }
        let probe = Fixture.probe(app, "table.tutorial")
        let parts = probe.components(separatedBy: "pin=").last?.split(separator: " ").prefix(4).compactMap { Double($0) } ?? []
        XCTAssertEqual(parts.count, 4, "\(tag): the tip's row is scrolled up and not pinned: \(probe) title \(title) column \(column)")
        guard parts.count == 4 else { return }
        let pin = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
        XCTAssertTrue(column.contains(pin), "\(tag): pinned row \(pin) outside the column \(column)")
        XCTAssertEqual(pin.minY, column.minY + 1, accuracy: 2, "\(tag): pinned at the column's top")
        XCTAssertGreaterThanOrEqual(pin.height, 28, "\(tag): the whole row (the × is 28 pt)")
        let head = element(app, "assist.headline").frame
        XCTAssertLessThanOrEqual(pin.maxY, head.minY, "\(tag): the pinned row over the advice's headline")
    }

    /// A tip's control: its copy in the row pinned at a short column's top while that shows,
    /// else the card's own ("tip.close").
    private func tipButton(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        let pinnedId = "tip.pinned" + id.dropFirst(4).prefix(1).uppercased() + id.dropFirst(5)
        let pinned = app.buttons[pinnedId]
        // (XCUITest calls the pinned row's buttons not hittable, the scroll view under the
        // overlay answering its hit test; a tap there lands on them: testTheWelcomeIsARowAndTheRuleTipShowsWithTheAdviceOnMyBidTurn)
        return pinned.exists ? pinned : app.buttons[id]
    }

    /// An auto-start's first decision: the welcome is no card anywhere (owner 2026-11-21: the
    /// switch says the tutorial is on and turns it off), its row in the log; the rule tip shows at
    /// once with the advice, and the switch shows on.
    func testTheWelcomeIsARowAndTheRuleTipShowsWithTheAdviceOnMyBidTurn() throws {
        let app = launch("bidding-mid")
        let tip = element(app, "tutorialTip")
        XCTAssertTrue(tip.waitForExistence(timeout: 5), "the rule tip shows at once")
        XCTAssertFalse(element(app, "tutorialWelcome").exists, "no welcome card")
        XCTAssertFalse(app.buttons["tip.keep"].exists)
        XCTAssertFalse(app.buttons["tip.off"].exists)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "tip.title").count, 1, "one tip card")
        XCTAssertEqual(app.staticTexts["tip.title"].label, "Bidding")
        XCTAssertTrue(tip.staticTexts["tip.text"].label.hasPrefix("Bid how many tricks you expect to win."))
        // the advice: the /help card, never counted, under the tip
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(element(app, "assistCard").frame.minY, tip.frame.maxY - 1, "the advice under the tip")
        XCTAssertEqual(element(app, "assist.headline").label, "Bid 2")
        XCTAssertEqual(element(app, "assist.footer").label, "What our strongest bot would play")
        XCTAssertTrue(waitFor(app, "table.assist", contains: "bid=2"), Fixture.probe(app, "table.assist"))
        XCTAssertEqual(element(app, "bidOverlay").buttons["2"].value as? String, "Suggested")
        // the switch, on
        let chip = element(app, "tutorial.chip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertTrue(waitForLabel(chip, "Tutorial on"), switchState(chip))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "tutorial.chip").count, 1, "one switch")
        chipClear(app, "bid rule tip")
        XCTAssertTrue(waitFor(app, "table.assist", contains: "clear=ok"), Fixture.probe(app, "table.assist"))
        // the column stays below Exit and the corner buttons, above the bid panel
        XCTAssertFalse(tip.frame.intersects(app.buttons["leave"].frame), "tip \(tip.frame) leave \(app.buttons["leave"].frame)")
        XCTAssertTrue(app.buttons["leave"].isHittable)
        XCTAssertLessThanOrEqual(columnFrame(app).maxY, element(app, "bidOverlay").frame.minY + 1,
                                 "the column \(columnFrame(app)) above the bid panel \(element(app, "bidOverlay").frame)")
        adviceInSight(app, "bid rule tip")
        clearOfSeats(app, "bid rule tip")
        tipHeadInSight(app, tip, "bid rule tip")
        shot(app, "rule-tip")
        // its close: the tip goes, the tutorial stays on
        tipButton(app, "tip.close").tap()
        XCTAssertTrue(tip.waitForNonExistence(timeout: 3))
        XCTAssertTrue(waitForLabel(chip, "Tutorial on"), switchState(chip))
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("/tutorial"), "nothing sent for the welcome or the close")
        welcomeTextInSightOrLogged(app)
        shot(app, "welcome-row")
    }

    func testOnMyPlayTurnTheAdviceRingsTheCardAndTheChipTurnsItOff() {
        let app = launch("trick-mid-lead3", ["-uiTutorialWelcome", "NO"])
        let tip = element(app, "tutorialTip")
        XCTAssertTrue(tip.waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["tip.title"].label, "Following suit")
        XCTAssertEqual(tip.staticTexts["tip.text"].label, "Clubs were led: you must play a club if you have one.")
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "assist.headline").label, "Play 10 of Clubs")
        XCTAssertEqual(element(app, "assist.footer").label, "What our strongest bot would play")
        XCTAssertTrue(waitFor(app, "table.assist", contains: "card=10_clubs"), Fixture.probe(app, "table.assist"))
        XCTAssertTrue(waitFor(app, "table.assist", contains: "clear=ok"), Fixture.probe(app, "table.assist"))
        chipClear(app, "play advice")
        adviceInSight(app, "play advice")
        clearOfSeats(app, "play advice")
        tipHeadInSight(app, tip, "play advice")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        shot(app, "advice")
        // the advice closed: the lightbulb is back, and the tip and the chip keep above it
        app.buttons["assist.close"].tap()
        let ask = app.buttons["assist.ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 3))
        let chip = chipClear(app, "play lightbulb")
        if verticalBarColumn(app) == nil {
            XCTAssertTrue(Fixture.probe(app, "table.assist").contains("ask"), Fixture.probe(app, "table.assist"))
        } else {
            // the iPhone Duo's vertical bar: the lightbulb is its item, the switch under it
            XCTAssertTrue(waitFor(app, "table.assistAsk", contains: "bar on"), Fixture.probe(app, "table.assistAsk"))
            XCTAssertGreaterThan(chip.minY, ask.frame.maxY - 1, "switch \(chip) under the lightbulb \(ask.frame)")
        }
        XCTAssertTrue(element(app, "tutorial.chip").isHittable)
        XCTAssertFalse(chip.intersects(ask.frame), "chip \(chip) lightbulb \(ask.frame)")
        XCTAssertFalse(tip.frame.intersects(ask.frame), "tip \(tip.frame) lightbulb \(ask.frame)")
        XCTAssertTrue(ask.isHittable)
        shot(app, "chip")
        // the switch: /tutorial off (no question), and the server's answer ends the tutorial
        element(app, "tutorial.chip").tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial off"), Fixture.probe(app, "fixture.sent"))
        XCTAssertFalse(app.alerts.firstMatch.exists, "off asks nothing")
        XCTAssertTrue(switchShowsOff(app))
        XCTAssertTrue(tip.waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Tips off. /help still works any time."].waitForExistence(timeout: 3))
        shot(app, "off")
    }

    /// The switch: the iPhone Duo's vertical bar item (closed, open in landscape, book pose; owner
    /// 2026-11-20), else the round button under the log's (an iPhone, an iPad; owner 2026-11-21),
    /// never a row of the column. It stays all game: off sends /tutorial off and shows off, on
    /// again sends /tutorial on with no question (the auto-start's game is bot-assisted since my
    /// first own decision).
    func testTheSwitchStaysAllGameAndTurnsItOffAndOnAgain() throws {
        let app = launch("trick-mid-lead3", ["-uiTutorialWelcome", "NO"])
        let chip = element(app, "tutorial.chip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        // the bar keeps only a label (no value): the state is in it, on both
        XCTAssertTrue(waitForLabel(chip, "Tutorial on"), switchState(chip))
        let f = chipClear(app, "switch")
        if let bar = verticalBarColumn(app) {
            XCTAssertTrue(bar.contains(f.midX), "switch \(f) bar \(bar)")
        }
        // under Exit (and the log's button where it shows)
        XCTAssertGreaterThan(f.minY, app.buttons["leave"].frame.maxY - 1)
        if app.buttons["log"].exists { XCTAssertGreaterThan(f.minY, app.buttons["log"].frame.maxY - 1) }
        // the column has the tip and the advice, no switch row
        XCTAssertTrue(element(app, "tutorialTip").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "tutorial.chip").count, 1, "one switch")
        adviceInSight(app, "switch")
        shot(app, "switch-on")
        // off: /tutorial off, the tips go, the switch stays (owner 2026-11-21: "I should see the icon")
        chip.tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial off"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(element(app, "tutorialTip").waitForNonExistence(timeout: 3))
        XCTAssertTrue(waitForLabel(chip, "Tutorial off"), switchState(chip))
        chipClear(app, "switch off")
        shot(app, "switch-off")
        // and on again with no question: the auto-start's game became bot-assisted at my first
        // own decision (the server's first-decision marker), so nothing changes for my stats
        chip.tap()
        XCTAssertFalse(app.alerts["Turn on the tutorial?"].waitForExistence(timeout: 1.5), "asked in a game already bot-assisted")
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial on"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(waitForLabel(chip, "Tutorial on"), switchState(chip))
        XCTAssertTrue(app.buttons["leave"].isHittable, "Exit stays")
    }

    /// The switch is there with the tutorial off (no /tutorial to type). Turning it on asks first
    /// (it makes the game bot-assisted): Cancel sends nothing; Turn on sends /tutorial on. Once on
    /// (the game bot-assisted: the server's `assisted`), off and on again ask nothing.
    func testTheSwitchIsThereOffAndAsksBeforeTurningItOn() throws {
        let app = Fixture.launch("bidding-mid", extra: ["-uiTutorial", "YES", "-uiTutorialOff", "YES", "-uiAssist", "YES"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        let chip = element(app, "tutorial.chip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5), "the switch with the tutorial off")
        XCTAssertTrue(waitForLabel(chip, "Tutorial off"), switchState(chip))
        XCTAssertFalse(element(app, "tutorialTip").exists)
        chipClear(app, "off at start")
        shot(app, "off-at-start")
        // Cancel: nothing sent, still off
        chip.tap()
        let alert = app.alerts["Turn on the tutorial?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 3))
        XCTAssertTrue(alert.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "a win goes in your bot-game stats, a loss or tie stays in your human stats")).firstMatch.exists,
                      "the stats words")
        shot(app, "confirm")
        alert.buttons["Cancel"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 3))
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("/tutorial"), Fixture.probe(app, "fixture.sent"))
        XCTAssertEqual(switchState(chip), "Tutorial off")
        // Turn on: /tutorial on
        chip.tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 3))
        alert.buttons["Turn on"].tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial on"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(waitForLabel(chip, "Tutorial on"), switchState(chip))
        // the game is bot-assisted now: off and on again ask nothing
        chip.tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial off"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(waitForLabel(chip, "Tutorial off"), switchState(chip))
        chip.tap()
        XCTAssertFalse(alert.waitForExistence(timeout: 1.5), "asked again in a game already bot-assisted")
        XCTAssertTrue(waitForLabel(chip, "Tutorial on"), switchState(chip))
        XCTAssertEqual(Fixture.probe(app, "fixture.sent").components(separatedBy: "/tutorial on").count - 1, 2,
                       Fixture.probe(app, "fixture.sent"))
    }

    /// The welcome's row is in the log (opened where it is a drawer).
    private func welcomeTextInSightOrLogged(_ app: XCUIApplication) {
        let row = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Tutorial: Tips will appear above your cards.")).firstMatch
        if !row.exists, app.buttons["log"].exists { app.buttons["log"].tap() }
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the welcome's row in the log")
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Tutorial: Tips will appear above your cards.")).count, 1, "once")
    }

    /// The tutorial went off: the switch stays, "Tutorial off".
    private func switchShowsOff(_ app: XCUIApplication) -> Bool {
        waitForLabel(element(app, "tutorial.chip"), "Tutorial off")
    }

    /// The switch's state as VoiceOver reads it: the corner button is "Tutorial" with the value
    /// "On" / "Off"; the Duo's bar item (which keeps no value) says it in its label.
    private func switchState(_ e: XCUIElement) -> String {
        guard e.exists else { return "-" }
        if e.label == "Tutorial", let v = e.value as? String { return "Tutorial \(v.lowercased())" }
        return e.label
    }

    private func waitForLabel(_ e: XCUIElement, _ label: String, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if switchState(e) == label { return true }
            Thread.sleep(forTimeInterval: 0.2)
        } while Date() < deadline
        return false
    }

    func testTheChatListOffersTheTutorial() {
        let app = launch("trick-mid-lead3", ["-uiTutorialWelcome", "NO"])
        XCTAssertTrue(element(app, "tutorial.chip").waitForExistence(timeout: 5))
        let field = app.textFields["Chat..."]
        if !field.exists { app.buttons["log"].tap() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("/t")
        XCTAssertTrue(app.staticTexts["Turn off the tutorial"].waitForExistence(timeout: 5))
        shot(app, "chat-on")
        field.typeText("utorial off\n")
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial off"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(switchShowsOff(app))
        // the tip's row stays in the log (dim, private; the log's first tutorial row, so it alone
        // has the note), and the off's reply is the tutorial's, not /help's
        XCTAssertTrue(app.staticTexts["Tutorial: Clubs were led: you must play a club if you have one. (only you see this)"].exists)
        XCTAssertTrue(app.staticTexts["Tutorial: Tips off. /help still works any time."].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["Tutorial: Tips off. /help still works any time. (only you see this)"].exists)
        XCTAssertFalse(app.staticTexts["Help: Tips off. /help still works any time. (only you see this)"].exists)
        field.tap()
        field.typeText("/t")
        XCTAssertTrue(app.staticTexts["Tutorial: tips and advice every turn"].waitForExistence(timeout: 5))
    }

    /// On my timed bid turn (and in a tabletop pose) the column ends above the countdown pill
    /// and the lightbulb, and below the fold.
    func testOnATimedBidTheCountdownAndTheLightbulbStayInSight() {
        for fold in [nil, "tabletop"] as [String?] {
            let tag = fold ?? "flat"
            let app = launch("bidding-mid", ["-uiBidClock", "20", "-uiTutorialWelcome", "NO"] + (fold.map { ["-uiFold", $0] } ?? []))
            let pill = element(app, "bidClock")
            XCTAssertTrue(pill.waitForExistence(timeout: 5), tag)
            XCTAssertTrue(element(app, "tutorialTip").waitForExistence(timeout: 5), tag)
            XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5), tag)
            app.buttons["assist.close"].tap()  // the lightbulb shows with the tip and the chip
            XCTAssertTrue(app.buttons["assist.ask"].waitForExistence(timeout: 3), tag)
            let chip = chipClear(app, "bid clock \(tag)")
            let probe = Fixture.probe(app, "table.assist")
            if let bar = verticalBarColumn(app) {
                // the iPhone Duo's vertical bar holds the lightbulb and the switch: the column
                // keeps clear of the countdown only
                XCTAssertTrue(waitFor(app, "table.assistAsk", contains: "bar on"), "\(tag): \(Fixture.probe(app, "table.assistAsk"))")
                XCTAssertTrue(app.buttons["assist.ask"].isEnabled, tag)
                XCTAssertTrue(bar.contains(app.buttons["assist.ask"].frame.midX), "\(tag): \(app.buttons["assist.ask"].frame) bar \(bar)")
                XCTAssertTrue(probe.contains("bidClock") && !probe.contains("ask"), "\(tag): \(probe)")
                XCTAssertTrue(waitFor(app, "table.assist", contains: "clear=ok"), "\(tag): \(Fixture.probe(app, "table.assist"))")
                XCTAssertFalse(columnFrame(app).intersects(pill.frame), "\(tag): column \(columnFrame(app)) over the countdown \(pill.frame)")
                shot(app, "bid-clock-\(tag)")
                app.terminate()
                continue
            }
            XCTAssertTrue(probe.contains("bidClock") && probe.contains("ask"), "\(tag): \(probe)")
            XCTAssertTrue(waitFor(app, "table.assist", contains: "clear=ok"), "\(tag): \(Fixture.probe(app, "table.assist"))")
            XCTAssertFalse(chip.intersects(pill.frame), "\(tag): chip \(chip) over the countdown \(pill.frame)")
            // the column knows where the lightbulb is drawn (within a point)
            let ask = app.buttons["assist.ask"].frame
            print("[TutorialUITests] \(tag) lightbulb \(ask)")
            let known = Fixture.probe(app, "table.tutorial").components(separatedBy: "ask=").last?
                .split(separator: " ").prefix(2).compactMap { Double($0) } ?? []
            XCTAssertEqual(known.count, 2, Fixture.probe(app, "table.tutorial"))
            if known.count == 2 {
                XCTAssertEqual(known[0], Double(ask.minX), accuracy: 1, "\(tag): \(ask) vs \(Fixture.probe(app, "table.tutorial"))")
                XCTAssertEqual(known[1], Double(ask.minY), accuracy: 1, "\(tag): \(ask) vs \(Fixture.probe(app, "table.tutorial"))")
            }
            XCTAssertFalse(chip.intersects(app.buttons["assist.ask"].frame),
                           "\(tag): chip \(chip) over the lightbulb \(app.buttons["assist.ask"].frame) \(Fixture.probe(app, "table.tutorial"))")
            shot(app, "bid-clock-\(tag)")
            app.terminate()
        }
    }

    func testASpectatorSeesNoTutorial() {
        let app = launch("spectator-mid-hand")
        XCTAssertFalse(element(app, "tutorial.chip").waitForExistence(timeout: 3))
        XCTAssertFalse(element(app, "tutorialTip").exists)
        XCTAssertFalse(element(app, "tutorialWelcome").exists)
    }
}
