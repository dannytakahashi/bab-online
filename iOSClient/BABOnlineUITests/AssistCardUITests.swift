import XCTest

/// /help on iOS (help plan 4.5), in fixture mode: `-uiAssist YES` answers the lightbulb's /help
/// as the server does with the cap `assist` (UIFixture+Assist). The lightbulb on my bid turn
/// (the bid panel's leading corner) and my play turn (my hand's right end), the card above the
/// bid panel or the hand, the suggested bid's ring ("Suggested"), the suggested card's ring
/// (probe "table.assist" card=, from the scene: SceneDump's suggested=true), Why?, the close
/// button, the warning on the 3rd use, no lightbulb for a spectator, /help in the chat list.
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
        XCTAssertEqual(ask.label, "Suggest a move")
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
        app.buttons["log"].tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("/h")
        XCTAssertTrue(app.staticTexts["Suggest a move (the next one makes this game bot-assisted)"].waitForExistence(timeout: 5))
        shot(app, "chat-help")
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
