import XCTest

/// The tutorial on iOS (State/Table/Tutorial.swift), in fixture mode: `-uiTutorial YES` turns it
/// on as an auto-start does and pushes this turn's welcome tip, rule tip and advice as the server
/// does (UIFixture+Tutorial). One tip card at a time (the welcome first; the rule tip waits behind
/// it until Keep or ×), the advice's chip and headline in sight. The welcome with Keep / Turn off, the rule tip in its neutral card,
/// the advice in the /help card with its ring and no count, the "Tutorial on" chip and its off
/// switch, /tutorial in the chat list, and what the column keeps clear of (my bid clock, my
/// seat's row, the lightbulb, the fold: probes "table.assist" and "table.tutorial").
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

    /// The switch is the vertical bar's item (probe "chip=bar"), not the chip in the column.
    private func switchInBar(_ app: XCUIApplication) -> Bool {
        Fixture.probe(app, "table.tutorial").hasPrefix("chip=bar")
    }

    /// The chip's frame from the probe "table.tutorial", once it clears what it keeps clear of;
    /// where the switch is the vertical bar's item, its frame in the bar's column.
    @discardableResult
    private func chipClear(_ app: XCUIApplication, _ tag: String) -> CGRect {
        XCTAssertTrue(element(app, "tutorial.chip").waitForExistence(timeout: 5), tag)
        if let bar = verticalBarColumn(app) {
            XCTAssertTrue(waitFor(app, "table.tutorial", contains: "chip=bar"), "\(tag): \(Fixture.probe(app, "table.tutorial"))")
            let f = element(app, "tutorial.chip").frame
            XCTAssertTrue(bar.contains(f.midX), "\(tag): the switch \(f) outside the vertical bar \(bar)")
            return f
        }
        XCTAssertTrue(waitFor(app, "table.tutorial", contains: "clear=ok"),
                      "\(tag): \(Fixture.probe(app, "table.tutorial")) keeps \(Fixture.probe(app, "table.assist")) [\(Fixture.probe(app, "ui.pose"))]")
        let probe = Fixture.probe(app, "table.tutorial")
        print("[TutorialUITests] \(tag) \(probe) | \(Fixture.probe(app, "table.assist")) [\(Fixture.probe(app, "ui.pose"))]")
        let parts = probe.components(separatedBy: "chip=").last?.split(separator: " ").prefix(4).compactMap { Double($0) } ?? []
        guard parts.count == 4 else { XCTFail(probe); return .null }
        return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
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
        // the welcome's Keep and Turn off: in the pinned row while the card's own are under it
        // or scrolled up, else the card's own below it in sight; never both (play test
        // 2026-11-21: the iPhone Duo closed showed the pair twice and none of the tip's text)
        if card.identifier == "tutorialWelcome" {
            let pinnedPair = app.buttons["tip.pinnedKeep"].exists
            print("[TutorialUITests] \(tag) welcome pair \(pinnedPair ? "pinned" : "card's own") pin \(pin) own \(app.buttons["tip.keep"].frame)")
            for id in ["tip.pinnedKeep", "tip.pinnedOff"] {
                XCTAssertEqual(app.buttons[id].exists, pinnedPair, "\(tag): \(id)")
                if pinnedPair { XCTAssertTrue(pin.contains(app.buttons[id].frame), "\(tag): \(id) \(app.buttons[id].frame) in \(pin)") }
            }
            for id in ["tip.keep", "tip.off"] {
                let own = app.buttons[id].frame
                let ownInSight = own.minY >= pin.maxY - 1 && column.contains(own)
                if pinnedPair {
                    XCTAssertFalse(ownInSight, "\(tag): \(id) \(own) in sight under the pinned pair \(pin)")
                } else {
                    XCTAssertTrue(ownInSight, "\(tag): the card's own \(id) \(own) out of sight under \(pin) in \(column)")
                    XCTAssertTrue(app.buttons[id].isHittable, "\(tag): \(id)")
                }
            }
        }
    }

    /// Some of the welcome's text is in sight: below the pinned row (where it shows) and inside the
    /// column, at least a line (play test 2026-11-21, the iPhone Duo closed: scrolled to the
    /// advice, the column showed the title row and Turn off / Keep twice and none of the text).
    private func welcomeTextInSight(_ app: XCUIApplication, _ welcome: XCUIElement, _ tag: String) {
        let column = columnFrame(app)
        let pin = element(app, "tip.pinned")
        let top = pin.exists ? max(column.minY, pin.frame.maxY) : column.minY
        let text = welcome.staticTexts["tip.text"].frame
        let shown = text.intersection(CGRect(x: column.minX, y: top, width: column.width, height: max(0, column.maxY - top)))
        print("[TutorialUITests] \(tag) welcome text \(text) shown \(shown) column \(column)")
        XCTAssertGreaterThanOrEqual(shown.isNull ? 0 : shown.height, 14, "\(tag): none of the welcome's text in sight: text \(text) column \(column) pin \(pin.exists ? pin.frame : .null)")
    }

    /// A tip's control: its copy in the row pinned at a short column's top while that shows,
    /// else the card's own ("tip.keep" / "tip.off" / "tip.close").
    private func tipButton(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        let pinnedId = "tip.pinned" + id.dropFirst(4).prefix(1).uppercased() + id.dropFirst(5)
        let pinned = app.buttons[pinnedId]
        // (XCUITest calls the pinned row's buttons not hittable, the scroll view under the
        // overlay answering its hit test; a tap there lands on them: testTheWelcomesCloseSendsItsOwnLine)
        return pinned.exists ? pinned : app.buttons[id]
    }

    func testTheWelcomeThenTheRuleTipWithTheAdviceOnMyBidTurn() {
        let app = launch("bidding-mid")
        let welcome = element(app, "tutorialWelcome")
        XCTAssertTrue(welcome.waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["tip.title"].label, "Tutorial on")
        XCTAssertTrue(welcome.staticTexts["tip.text"].label.hasPrefix("Tips will appear above your cards. Only you see them."))
        XCTAssertTrue(app.buttons["tip.keep"].exists)
        XCTAssertTrue(app.buttons["tip.off"].exists)
        // the advice: the /help card, never counted
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        // one tip card at a time: the rule tip (pushed before the advice) waits behind the welcome
        let tip = element(app, "tutorialTip")
        XCTAssertFalse(tip.exists, "one tip card at a time: the welcome has priority")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "tip.title").count, 1, "one tip card")
        XCTAssertGreaterThanOrEqual(element(app, "assistCard").frame.minY, welcome.frame.maxY - 1, "the advice under the welcome")
        XCTAssertEqual(element(app, "assist.headline").label, "Bid 2")
        XCTAssertEqual(element(app, "assist.footer").label, "What our strongest bot would play")
        XCTAssertTrue(waitFor(app, "table.assist", contains: "bid=2"), Fixture.probe(app, "table.assist"))
        XCTAssertEqual(element(app, "bidOverlay").buttons["2"].value as? String, "Suggested")
        // the chip, with its switch on
        let chip = element(app, "tutorial.chip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        // a switch to VoiceOver ("Tutorial", "On"); in the iPhone Duo's vertical bar, a bar item:
        // a button "Tutorial on" (the bar keeps no value)
        if verticalBarColumn(app) == nil {
            XCTAssertEqual(chip.elementType, .switch)
            XCTAssertEqual(chip.label, "Tutorial")
            XCTAssertEqual(chip.value as? String, "On")
        } else {
            XCTAssertEqual(chip.elementType, .button)
            XCTAssertEqual(chip.label, "Tutorial on")
        }
        chipClear(app, "bid welcome")
        XCTAssertTrue(waitFor(app, "table.assist", contains: "clear=ok"), Fixture.probe(app, "table.assist"))
        // the column stays above the bid panel and below Exit and the log's button
        let panel = element(app, "bidOverlay").frame
        if !switchInBar(app) {
            XCTAssertLessThanOrEqual(chip.frame.maxY, panel.minY + 1, "chip \(chip.frame) panel \(panel)")
        }
        // (Exit is above the column on a phone, in the side rail on a wide screen: the iPhone Duo open)
        XCTAssertFalse(welcome.frame.intersects(app.buttons["leave"].frame), "welcome \(welcome.frame) leave \(app.buttons["leave"].frame)")
        XCTAssertTrue(app.buttons["leave"].isHittable)
        adviceInSight(app, "bid welcome")
        clearOfSeats(app, "bid welcome")
        tipHeadInSight(app, welcome, "bid welcome")
        welcomeTextInSight(app, welcome, "bid welcome")
        shot(app, "welcome")
        // Keep: /tutorial keep, and the rule tip that waited shows now, still one tip card
        tipButton(app, "tip.keep").tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial keep"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(welcome.waitForNonExistence(timeout: 3))
        XCTAssertTrue(tip.waitForExistence(timeout: 3), "the rule tip behind the welcome shows now")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "tip.title").count, 1, "one tip card")
        XCTAssertTrue(element(app, "assistCard").exists, "the advice stays")
        XCTAssertGreaterThanOrEqual(element(app, "assistCard").frame.minY, tip.frame.maxY - 1, "the advice under the tip")
        XCTAssertEqual(app.staticTexts["tip.title"].label, "Bidding")
        XCTAssertTrue(tip.staticTexts["tip.text"].label.hasPrefix("Bid how many tricks you expect to win."))
        XCTAssertFalse(app.buttons["tip.keep"].exists, "a rule tip has no buttons but its close")
        chipClear(app, "bid rule tip")
        XCTAssertTrue(waitFor(app, "table.assist", contains: "clear=ok"), Fixture.probe(app, "table.assist"))
        XCTAssertFalse(tip.frame.intersects(app.buttons["leave"].frame), "tip \(tip.frame) leave \(app.buttons["leave"].frame)")
        XCTAssertTrue(app.buttons["leave"].isHittable)
        adviceInSight(app, "bid rule tip")
        clearOfSeats(app, "bid rule tip")
        tipHeadInSight(app, tip, "bid rule tip")
        shot(app, "rule-tip")
        // its close: the tip goes, the tutorial stays on
        tipButton(app, "tip.close").tap()
        XCTAssertTrue(tip.waitForNonExistence(timeout: 3))
        XCTAssertTrue(chip.exists)
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("/tutorial off"))
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
        XCTAssertFalse(chip.intersects(ask.frame), "chip \(chip) lightbulb \(ask.frame)")
        XCTAssertFalse(tip.frame.intersects(ask.frame), "tip \(tip.frame) lightbulb \(ask.frame)")
        XCTAssertTrue(ask.isHittable)
        shot(app, "chip")
        // the chip's switch: /tutorial off, and the server's answer ends the tutorial
        element(app, "tutorial.chip").tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial off"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(element(app, "tutorial.chip").waitForNonExistence(timeout: 3))
        XCTAssertTrue(tip.waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Tips off. /help still works any time."].waitForExistence(timeout: 3))
        shot(app, "off")
    }

    /// The iPhone Duo with its vertical bar (closed, open in landscape, book pose; owner
    /// 2026-11-20): the switch is a bar item under the log's button, not a row of the column;
    /// a tap sends /tutorial off and the item goes with the answer. Elsewhere: the chip.
    func testWithTheVerticalBarTheSwitchIsABarItem() throws {
        let app = launch("trick-mid-lead3", ["-uiTutorialWelcome", "NO"])
        guard let bar = verticalBarColumn(app) else { throw XCTSkip("no vertical bar here: the chip test covers it") }
        let chip = element(app, "tutorial.chip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        // the bar draws its items as buttons and keeps only their label (no value, no toggle
        // trait): VoiceOver reads "Tutorial on" and the hint
        XCTAssertEqual(chip.elementType, .button)
        XCTAssertEqual(chip.label, "Tutorial on")
        XCTAssertTrue(waitFor(app, "table.tutorial", contains: "chip=bar"), Fixture.probe(app, "table.tutorial"))
        XCTAssertTrue(bar.contains(chip.frame.midX), "switch \(chip.frame) bar \(bar)")
        XCTAssertTrue(chip.isHittable)
        // under Exit (and the log's button where it shows)
        XCTAssertGreaterThan(chip.frame.minY, app.buttons["leave"].frame.maxY - 1)
        if app.buttons["log"].exists { XCTAssertGreaterThan(chip.frame.minY, app.buttons["log"].frame.maxY - 1) }
        // the column has the tip and the advice, no chip row
        XCTAssertTrue(element(app, "tutorialTip").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "tutorial.chip").count, 1, "one switch")
        adviceInSight(app, "bar")
        shot(app, "bar-switch")
        chip.tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial off"), Fixture.probe(app, "fixture.sent"))
        XCTAssertTrue(chip.waitForNonExistence(timeout: 3))
        XCTAssertTrue(element(app, "tutorialTip").waitForNonExistence(timeout: 3))
        XCTAssertTrue(waitFor(app, "table.tutorial", contains: "chip=-"), Fixture.probe(app, "table.tutorial"))
        XCTAssertTrue(app.buttons["leave"].isHittable, "Exit stays")
    }

    func testTurnOffOnTheWelcome() {
        let app = launch("bidding-mid")
        XCTAssertTrue(app.buttons["tip.off"].waitForExistence(timeout: 5))
        tipButton(app, "tip.off").tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial off"), Fixture.probe(app, "fixture.sent"))
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("/tutorial keep"))
        XCTAssertTrue(element(app, "tutorialWelcome").waitForNonExistence(timeout: 3))
        XCTAssertTrue(element(app, "tutorial.chip").waitForNonExistence(timeout: 3))
        XCTAssertFalse(element(app, "tutorialTip").exists, "off: the waiting tip goes too")
        XCTAssertTrue(app.staticTexts["Tips off. /help still works any time."].waitForExistence(timeout: 3))
    }

    func testTheWelcomesCloseSendsItsOwnLine() {
        let app = launch("bidding-mid")
        let welcome = element(app, "tutorialWelcome")
        XCTAssertTrue(welcome.waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "tutorialTip").exists, "behind the welcome")
        tipButton(app, "tip.close").tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/tutorial close"), Fixture.probe(app, "fixture.sent"))
        XCTAssertFalse(Fixture.probe(app, "fixture.sent").contains("/tutorial keep"), "× is not Keep")
        XCTAssertTrue(welcome.waitForNonExistence(timeout: 3))
        XCTAssertTrue(element(app, "tutorialTip").waitForExistence(timeout: 3), "the rule tip behind it shows now")
        XCTAssertTrue(element(app, "tutorial.chip").exists, "the tutorial stays on")
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
        XCTAssertTrue(element(app, "tutorial.chip").waitForNonExistence(timeout: 3))
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
