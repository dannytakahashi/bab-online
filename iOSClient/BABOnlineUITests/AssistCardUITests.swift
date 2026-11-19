import XCTest

/// /help on iOS (help plan 4.5), in fixture mode: `-uiAssist YES` answers the lightbulb's /help
/// as the server does with the cap `assist` (UIFixture+Assist). The lightbulb on my bid turn
/// (the bid panel's leading corner) and my play turn (my hand's right end), the card above the
/// bid panel or the hand, the suggested bid's ring ("Suggested"), the suggested card's ring
/// (probe "table.assist" card=, from the scene: SceneDump's suggested=true), Why?, the close
/// button, the warning on the 3rd use, no lightbulb for a spectator, /help in the chat list, and a
/// game with a native bot seat (`-uiAssistFree YES`, or filler bots alone): no count anywhere.
/// `TEST_RUNNER_BAB_SHOTS=<folder>` saves PNGs.
final class AssistCardUITests: XCTestCase {
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
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("assist-\(name).png"))
        }
    }

    private func launch(_ fixture: String, _ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: ["-uiAssist", "YES"] + extra)
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

    func testOnMyBidTurnTheLightbulbAsksAndTheBidIsRinged() {
        let app = launch("bidding-mid")
        let ask = app.buttons["assist.ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5), "my bid turn: the lightbulb")
        XCTAssertEqual(ask.label, "Ask a bot for advice")
        // the panel's accessibility container takes the lightbulb in: its chip row is the panel's top
        let panel = element(app, "bidOverlay").frame
        let chips = element(app, "bidChips").frame
        XCTAssertLessThan(ask.frame.midY, chips.minY, "on the bid panel's top edge, over the felt")
        XCTAssertLessThan(ask.frame.midX, panel.midX, "at its leading corner (the countdown keeps the trailing one)")
        shot(app, "bid-ask")
        ask.tap()
        XCTAssertTrue(waitFor(app, "fixture.sent", contains: "/help"), Fixture.probe(app, "fixture.sent"))
        let card = element(app, "assistCard")
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "assist.headline").label, "Bid 2")
        XCTAssertEqual(element(app, "assist.confidence").label, "Clear choice")
        XCTAssertEqual(element(app, "assist.footer").label, "What our strongest bot would play \u{00B7} Help 1 of 3 free")
        XCTAssertFalse(app.buttons["assist.ask"].exists, "hidden while the card is up")
        XCTAssertTrue(waitFor(app, "table.assist", contains: "bid=2"), Fixture.probe(app, "table.assist"))
        XCTAssertEqual(element(app, "bidOverlay").buttons["2"].value as? String, "Suggested")
        XCTAssertEqual(element(app, "bidOverlay").buttons["3"].value as? String ?? "", "")
        // above the bid panel, not over it
        XCTAssertLessThanOrEqual(card.frame.maxY, chips.minY, "card \(card.frame) chips \(chips)")
        XCTAssertGreaterThanOrEqual(card.frame.minX, 0)
        XCTAssertLessThanOrEqual(card.frame.maxX, app.windows.firstMatch.frame.maxX)
        // Why? opens the details
        XCTAssertFalse(element(app, "assist.detail").exists)
        app.buttons["assist.why"].tap()
        XCTAssertTrue(element(app, "assist.detail").waitForExistence(timeout: 3))
        shot(app, "bid-card")
        // the close button: the card and the ring go, the lightbulb is back
        app.buttons["assist.close"].tap()
        XCTAssertTrue(card.waitForNonExistence(timeout: 3))
        XCTAssertTrue(waitFor(app, "table.assist", contains: "bid=-"), Fixture.probe(app, "table.assist"))
        XCTAssertTrue(app.buttons["assist.ask"].waitForExistence(timeout: 3))
    }

    func testOnMyPlayTurnTheSuggestedCardIsRinged() {
        let app = launch("trick-mid-lead3")
        let ask = app.buttons["assist.ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5), "my play turn: the lightbulb")
        shot(app, "play-ask")
        ask.tap()
        let card = element(app, "assistCard")
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        XCTAssertTrue(waitFor(app, "table.assist", contains: "card=10_clubs"), Fixture.probe(app, "table.assist"))
        XCTAssertEqual(element(app, "assist.headline").label, "Play 10 of Clubs")
        XCTAssertEqual(element(app, "assist.confidence").label, "Close call")
        // VoiceOver: the card reads as suggested
        XCTAssertTrue(app.descendants(matching: .any)["10 of Clubs, suggested"].exists
                      || app.otherElements.matching(NSPredicate(format: "label == %@", "10 of Clubs, suggested")).count > 0)
        // the card sits above the hand: the scene's layout stays in the safe rect with the ring
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        shot(app, "play-card")
    }

    func testTheThirdUseWarnsAndTheChatListCounts() {
        let app = launch("bidding-mid", ["-uiAssistUses", "3"])
        app.buttons["assist.ask"].tap()
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        let note = element(app, "assist.note")
        XCTAssertTrue(note.exists)
        XCTAssertTrue(note.label.hasPrefix("That's your 3rd free /help."), note.label)
        XCTAssertEqual(element(app, "assist.footer").label, "What our strongest bot would play \u{00B7} Help 3 of 3 free")
        shot(app, "bid-warning")
        // the chat's command list says what the next one does
        // the log is a drawer, except where it is docked open (open-Duo landscape, book pose)
        let field = app.textFields["Chat..."]
        if !field.exists { app.buttons["log"].tap() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("/h")
        XCTAssertTrue(app.staticTexts["Ask a bot for advice (the next one makes this game bot-assisted)"].waitForExistence(timeout: 5))
        shot(app, "chat-help")
    }

    // MARK: - A game with a native bot seat (owner 2026-11-19: no count, no free / limit words)

    private func openChatList(_ app: XCUIApplication) {
        // the log is a drawer, except where it is docked open (open-Duo landscape, book pose)
        let field = app.textFields["Chat..."]
        if !field.exists { app.buttons["log"].tap() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("/h")
    }

    /// No on-screen text names a count, "free", "unlimited" or "bot-assisted".
    private func assertNoLimitWords(_ app: XCUIApplication, _ tag: String) {
        let words = NSPredicate(format: "label CONTAINS[c] 'free' OR label CONTAINS[c] 'unlimited' OR label CONTAINS[c] 'bot-assisted' OR label CONTAINS[c] ' of 3'")
        let hits = app.staticTexts.matching(words).allElementsBoundByIndex.map(\.label)
        XCTAssertEqual(hits, [], tag)
    }

    /// The tournament-game fixture (me and three filler bots) without viewer.assist: only the
    /// table's seats say it is a game with a native bot seat.
    private func fillerBotsOnly() throws -> [String: String] {
        final class Token {}
        let url = try XCTUnwrap(Bundle(for: Token.self).url(forResource: "tournament-game", withExtension: "json", subdirectory: "v2"))
        let raw = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var snap = try XCTUnwrap(raw["snapshot"] as? [String: Any])
        var viewer = try XCTUnwrap(snap["viewer"] as? [String: Any])
        viewer.removeValue(forKey: "assist")
        snap["viewer"] = viewer
        return ["UI_FIXTURE_SNAPSHOT": String(decoding: try JSONSerialization.data(withJSONObject: snap), as: UTF8.self)]
    }

    func testInABotGameTheFooterAndTheChatListNameNoCount() {
        // the hint's unlimited (as the server sends it there): a 4th use, no warning, no crossing
        let app = launch("bidding-mid", ["-uiAssistFree", "YES", "-uiAssistUses", "4"])
        let ask = app.buttons["assist.ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        XCTAssertEqual(ask.label, "Ask a bot for advice")
        ask.tap()
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "assist.footer").label, "What our strongest bot would play")
        XCTAssertFalse(element(app, "assist.note").exists, "no warning, no crossing note")
        assertNoLimitWords(app, "card")
        shot(app, "bot-game-card")
        openChatList(app)
        XCTAssertTrue(app.staticTexts["Ask a bot for advice"].waitForExistence(timeout: 5))
        assertNoLimitWords(app, "chat list")
        shot(app, "bot-game-chat-help")
    }

    func testFillerBotsAloneMakeTheChatListPlainBeforeAnyHelp() throws {
        let app = Fixture.launch("env", extra: ["-uiAssist", "YES"], env: try fillerBotsOnly())
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        openChatList(app)
        XCTAssertTrue(app.staticTexts["Ask a bot for advice"].waitForExistence(timeout: 5),
                      "no hint and no viewer.assist yet: the filler bots' seats say it")
        assertNoLimitWords(app, "chat list")
    }

    func testFillerBotsAloneMakeTheFooterPlain() throws {
        // the fixture answers as the server does at a table with native bot seats (unlimited: no
        // count, no warning; the hint's own flag decides, as on the web)
        let app = Fixture.launch("env", extra: ["-uiAssist", "YES", "-uiAssistUses", "3"], env: try fillerBotsOnly())
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        let ask = app.buttons["assist.ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5), "my bid turn at the tournament table: the lightbulb")
        ask.tap()
        XCTAssertTrue(element(app, "assistCard").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "assist.footer").label, "What our strongest bot would play")
        XCTAssertFalse(element(app, "assist.note").exists, "the 3rd-use warning is not shown there")
        assertNoLimitWords(app, "card")
        shot(app, "filler-bots-card")
    }

    // MARK: - What the card keeps clear of (review 2026-11-19)

    /// The card's visible frame (pane points, the window's on this app) and what it covers, from
    /// the probe "table.assist" (AssistLayout.Keeps). The element's own frame is the card's whole
    /// content: where the room is short it scrolls inside a shorter box, which the probe gives.
    @discardableResult
    private func cardClear(_ app: XCUIApplication, _ tag: String) -> CGRect {
        let card = element(app, "assistCard")
        XCTAssertTrue(card.waitForExistence(timeout: 5), tag)
        XCTAssertTrue(waitFor(app, "table.assist", contains: "clear=ok"),
                      "\(tag): \(Fixture.probe(app, "table.assist")) [\(Fixture.probe(app, "ui.pose"))]")
        let probe = Fixture.probe(app, "table.assist")
        print("[AssistCardUITests] \(tag) \(probe) [\(Fixture.probe(app, "ui.pose"))]")
        let parts = probe.components(separatedBy: "frame=").last?.split(separator: " ").prefix(4).compactMap { Double($0) } ?? []
        XCTAssertEqual(parts.count, 4, probe)
        guard parts.count == 4 else { return .null }
        return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
    }

    /// On my timed bid turn the card ends above the countdown pill on the bid panel's edge:
    /// the seconds stay in sight while I read the suggestion.
    func testOnATimedBidTheCountdownStaysInSight() {
        for fold in [nil, "tabletop"] as [String?] {
            let tag = fold ?? "flat"
            let app = launch("bidding-mid", ["-uiAssistShow", "YES", "-uiBidClock", "20"] + (fold.map { ["-uiFold", $0] } ?? []))
            let pill = element(app, "bidClock")
            XCTAssertTrue(pill.waitForExistence(timeout: 5), tag)
            let card = cardClear(app, tag)
            XCTAssertTrue(Fixture.probe(app, "table.assist").contains("bidClock"), "the card knows the pill's frame")
            XCTAssertFalse(card.intersects(pill.frame), "\(tag): card \(card) over the countdown \(pill.frame)")
            shot(app, "bid-clock-\(tag)")
            app.terminate()
        }
    }

    /// On my play turn the card ends above my seat's row: the voice button (mute, and the
    /// voice panel by long press) and HSI stay in reach while it is up.
    func testOnMyPlayTurnMySeatRowStaysInReach() {
        for fold in [nil, "tabletop"] as [String?] {
            let tag = fold ?? "flat"
            let app = launch("trick-mid-lead3", ["-uiAssistShow", "YES", "-uiVoice", "YES"] + (fold.map { ["-uiFold", $0] } ?? []))
            let card = cardClear(app, tag)
            XCTAssertTrue(Fixture.probe(app, "table.assist").contains("seatRow"))
            let mic = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "microphone")).firstMatch
            XCTAssertTrue(mic.waitForExistence(timeout: 5), tag)
            XCTAssertFalse(card.intersects(mic.frame), "\(tag): card \(card) over the voice button \(mic.frame)")
            XCTAssertTrue(mic.isHittable, "\(tag): the voice button takes a tap")
            shot(app, "play-seat-row-\(tag)")
            app.terminate()
        }
    }

    func testASpectatorHasNoLightbulb() {
        let app = launch("spectator-mid-hand")
        XCTAssertFalse(app.buttons["assist.ask"].waitForExistence(timeout: 2))
        XCTAssertFalse(element(app, "assistCard").exists)
    }

    func testOffMyTurnThereIsNoLightbulb() {
        let app = launch("between-tricks")
        XCTAssertFalse(app.buttons["assist.ask"].waitForExistence(timeout: 2), "seat 2 is on turn, not me")
    }
}
