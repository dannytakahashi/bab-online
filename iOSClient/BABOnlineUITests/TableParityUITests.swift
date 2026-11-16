import XCTest

/// iOS 1.2.2 table parity with the web, in fixture mode: the idle-seat offer's
/// wording, a tied game, a refused action's reason, the bid-total chips, an
/// unknown chat command's hint, the dealer marker and the opponent card backs.
final class TableParityUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    // MARK: (a) idle-seat offer

    func testAnIdleSeatOfferSaysIdleNotDisconnected() {
        // seat 2 (kim) is connected; the server offers it as idle (resignationAvailable idle: true)
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiIdleOffer", "2"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let message = element(app, "resignOffer.message")
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertEqual(message.label, "kim seems idle. Replace with a bot?")
        let wrong = NSPredicate(format: "label CONTAINS[c] 'disconnected' OR label CONTAINS[c] 'timed out' OR label CONTAINS[c] 'reconnection'")
        XCTAssertEqual(app.staticTexts.matching(wrong).count, 0, "an idle player is not disconnected")
        let replace = element(app, "resignOffer.replace"), wait = element(app, "resignOffer.wait")
        XCTAssertTrue(replace.isHittable)
        XCTAssertTrue(wait.isHittable)
        let window = app.windows.firstMatch.frame
        for e in [message, replace, wait] {
            XCTAssertGreaterThanOrEqual(e.frame.minX, window.minX)
            XCTAssertLessThanOrEqual(e.frame.maxX, window.maxX, "\(e.identifier) inside the window: \(e.frame)")
        }
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        // the banner stays until someone answers: no seat's card backs sit under it
        for pos in 2...4 {
            let fan = element(app, "fan.\(pos)")
            guard fan.exists else { continue }
            for e in [message, replace, wait] {
                XCTAssertFalse(fan.frame.intersects(e.frame), "fan.\(pos) \(fan.frame) under the banner's \(e.identifier) \(e.frame)")
            }
        }
        attach(app, "idle-offer")
        // Wait: the offer goes (until the server asks again)
        wait.tap()
        XCTAssertTrue(message.waitForNonExistence(timeout: 5))
        app.terminate()
    }

    // MARK: (c) tie game

    func testATiedGameSaysTieGame() {
        let app = Fixture.launch("game-end", extra: ["-uiTie", "YES"])
        XCTAssertTrue(Fixture.readyElement(app, "game-end").waitForExistence(timeout: 20))
        let title = element(app, "gameEnd.title")
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Tie game")
        XCTAssertFalse(app.staticTexts["Victory!"].exists)
        XCTAssertFalse(app.staticTexts["Defeat"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == '312'")).count, 2, "both teams' equal scores")
        attach(app, "tie-game")
        app.terminate()
    }

    /// The web's overlay says GAME OVER to a spectator whatever the score (ScoreModal.js); so does iOS.
    func testATiedGameIsStillGameOverToASpectator() {
        let app = Fixture.launch("game-end-spectator", extra: ["-uiTie", "YES"])
        XCTAssertTrue(Fixture.readyElement(app, "game-end-spectator").waitForExistence(timeout: 20))
        let title = element(app, "gameEnd.title")
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Game Over")
        app.terminate()
    }

    func testADecidedGameStillSaysWhoWon() {
        let app = Fixture.launch("game-end")
        XCTAssertTrue(Fixture.readyElement(app, "game-end").waitForExistence(timeout: 20))
        let title = element(app, "gameEnd.title")
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue(["Victory!", "Defeat"].contains(title.label), title.label)
        app.terminate()
    }

    // MARK: (d) a refused action

    func testARefusedPlaySaysWhyWithoutBlockingTheTable() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiReject", "not_your_turn"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let toast = element(app, "serverErrorToast")
        XCTAssertTrue(toast.waitForExistence(timeout: 8))
        XCTAssertTrue(toast.label.contains("Not your turn"), toast.label)
        let window = app.windows.firstMatch.frame
        XCTAssertLessThan(toast.frame.height, 60, "a short line: \(toast.frame)")
        XCTAssertLessThanOrEqual(toast.frame.maxX, window.maxX)
        // non-blocking: the table and its controls stay usable under it
        XCTAssertTrue(app.buttons["leave"].isHittable)
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        XCTAssertTrue(Fixture.settledState(app).contains("hand=12"), "the hand is whole")
        attach(app, "rejected-play")
        app.terminate()
    }

    /// A tap on a dimmed card says why it cannot be played (the web's illegalReason), in the
    /// same toast; the card stays in the hand and the table stays usable.
    func testATapOnADimmedCardSaysWhy() {
        // my turn, clubs led, I hold clubs: the 5 of Spades (the hand's first card) must follow suit
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiToasts", "YES"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        let card = element(app, "5 of Spades")
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "serverErrorToast").exists)
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.5)).tap()
        let toast = element(app, "serverErrorToast")
        XCTAssertTrue(toast.waitForExistence(timeout: 8))
        XCTAssertTrue(toast.label.contains("Must follow suit."), toast.label)
        XCTAssertTrue(app.buttons["leave"].isHittable)
        XCTAssertTrue(Fixture.settledState(app).contains("hand=12"), "nothing was played")
        XCTAssertTrue(Fixture.settledState(app).contains("lifted=-"), "a dimmed card does not lift")
        attach(app, "dimmed-card-reason")
        app.terminate()
    }

    // MARK: (e) bid chips

    func testTheBidPanelShowsTheBidTotalChips() {
        // ned (seat 4) to bid; max bid B (the whole 12-card hand) and pat 1: an overbid by 1
        let app = Fixture.launch("bidding-mid")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let panel = element(app, "bidOverlay")
        XCTAssertTrue(panel.waitForExistence(timeout: 5))
        let chips = element(app, "bidChips")
        XCTAssertTrue(chips.waitForExistence(timeout: 5))
        XCTAssertEqual(chips.value as? String, "12+1/12")
        XCTAssertEqual(chips.label, "Bids: your team 12, opponents 1, of 12 tricks. Over by 1")
        XCTAssertTrue(panel.frame.insetBy(dx: -1, dy: -1).contains(chips.frame), "\(chips.frame) inside \(panel.frame)")
        XCTAssertGreaterThan(chips.frame.width, 120)
        // 13 chips of a set width (16 pt and a 2 pt gap, times the zoom), not a bar across the panel
        let zoomed = Fixture.tableZoom(app) ?? 1
        XCTAssertLessThanOrEqual(chips.frame.width, (13 * 16 + 12 * 2) * zoomed + 1, "\(chips.frame)")
        // the panel still fits the layout's 340 x 140 bid band (times the table's zoom)
        let zoom = Fixture.tableZoom(app) ?? 1
        XCTAssertLessThanOrEqual(panel.frame.height, 140 * zoom + 0.5, "\(panel.frame)")
        XCTAssertLessThanOrEqual(panel.frame.width, 340 * zoom + 0.5)
        // the chips sit above the bid buttons
        let zero = app.buttons["0"]
        XCTAssertTrue(zero.exists)
        XCTAssertLessThanOrEqual(chips.frame.maxY, zero.frame.minY + 4)
        attach(app, "bid-chips")
        app.terminate()
    }

    // MARK: (f) unknown chat command

    func testAnUnknownCommandGetsAHintAndIsNotSent() {
        let app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let field = app.textFields["Chat..."]
        if !field.exists { app.buttons["log"].tap() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("/shrug")
        app.buttons["Send"].tap()
        let hint = element(app, "chat.commandHint")
        XCTAssertTrue(hint.waitForExistence(timeout: 5))
        XCTAssertTrue(hint.label.contains("Unknown command: /shrug"), hint.label)
        XCTAssertEqual(Fixture.probe(app, "fixture.sent"), "-", "nothing was sent")
        XCTAssertEqual(field.value as? String, "/shrug", "the line stays, to fix")
        // the commands are listed with it
        for command in ["/lazy", "/active", "/leave"] {
            XCTAssertTrue(app.staticTexts[command].exists, command)
        }
        attach(app, "unknown-command")
        // typing clears the hint; a unique prefix is sent as its command
        field.typeText(XCUIKeyboardKey.delete.rawValue + XCUIKeyboardKey.delete.rawValue + XCUIKeyboardKey.delete.rawValue
                       + XCUIKeyboardKey.delete.rawValue + XCUIKeyboardKey.delete.rawValue + "a")
        XCTAssertTrue(hint.waitForNonExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "/a")
        app.buttons["Send"].tap()
        let sent = NSPredicate { _, _ in Fixture.probe(app, "fixture.sent").contains("/active") }
        wait(for: [expectation(for: sent, evaluatedWith: nil)], timeout: 5)
        app.terminate()
    }

    // MARK: (b) dealer marker, (g) card backs

    func testTheDealerMarkerIsOnTheDealersSeat() {
        // hal (seat 3, my partner) dealt
        var app = Fixture.launch("trick-mid-lead3", extra: ["-uiDealer", "3"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        var dealer = element(app, "dealer")
        XCTAssertTrue(dealer.waitForExistence(timeout: 5))
        XCTAssertEqual(dealer.label, "Dealer: hal")
        XCTAssertTrue(Fixture.probe(app, "table.extras").hasSuffix("dealer=3"), Fixture.probe(app, "table.extras"))
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        let window = app.windows.firstMatch.frame
        XCTAssertTrue(window.contains(dealer.frame), "\(dealer.frame)")
        attach(app, "dealer-partner")
        app.terminate()

        // the fixture's own deal: I (ivy, seat 1) dealt: the marker is by my hand
        app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        dealer = element(app, "dealer")
        XCTAssertTrue(dealer.waitForExistence(timeout: 5))
        XCTAssertEqual(dealer.label, "You are the dealer")
        XCTAssertTrue(Fixture.probe(app, "table.extras").hasSuffix("dealer=me"), Fixture.probe(app, "table.extras"))
        XCTAssertTrue(app.windows.firstMatch.frame.contains(dealer.frame), "\(dealer.frame)")
        attach(app, "dealer-me")
        app.terminate()
    }

    /// "fans=2:12,3:11,4:11 dealer=me" -> [2: 12, 3: 11, 4: 11]; nil where the table shows no fans ("fans=-").
    private func fans(_ app: XCUIApplication) -> [Int: Int]? {
        let extras = Fixture.probe(app, "table.extras")
        guard let field = extras.split(separator: " ").first(where: { $0.hasPrefix("fans=") })?.dropFirst(5), field != "-" else { return nil }
        var out: [Int: Int] = [:]
        for pair in field.split(separator: ",") {
            let kv = pair.split(separator: ":").compactMap { Int($0) }
            if kv.count == 2 { out[kv[0]] = kv[1] }
        }
        return out
    }

    func testOpponentsShowTheirCardBacksWhereTheTableHasRoom() throws {
        let app = Fixture.launch("trick-mid-lead3")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        attach(app, "card-backs-seated")
        guard let shown = fans(app) else {
            // only the smallest phones (an SE-size screen): the lightweight seats of before, no fan elements
            XCTAssertLessThan(app.windows.firstMatch.frame.width, 390, "this screen has room for the fans")
            XCTAssertFalse(element(app, "fan.2").exists)
            app.terminate()
            return
        }
        // the snapshot's cardsInHand: kim 12, hal 11, jon 11
        XCTAssertEqual(shown, [2: 12, 3: 11, 4: 11])
        let window = app.windows.firstMatch.frame
        for (pos, name, cards) in [(2, "kim", 12), (3, "hal", 11), (4, "jon", 11)] {
            let fan = element(app, "fan.\(pos)")
            XCTAssertTrue(fan.waitForExistence(timeout: 5), "fan.\(pos)")
            XCTAssertEqual(fan.label, "\(name): \(cards) cards")
            XCTAssertTrue(window.contains(fan.frame), "\(fan.frame)")
        }
        // no fan covers another, my hand's cards or the bid/score chrome
        let frames = [2, 3, 4].map { element(app, "fan.\($0)").frame }
        for i in frames.indices { for j in frames.indices where j > i { XCTAssertFalse(frames[i].intersects(frames[j])) } }
        app.terminate()
    }

    func testASpectatorSeesEverySeatsCardBacks() throws {
        let app = Fixture.launch("spectator-mid-hand")
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        attach(app, "card-backs-spectator")
        guard let shown = fans(app) else {
            XCTAssertLessThan(app.windows.firstMatch.frame.width, 390, "this screen has room for the fans")
            app.terminate()
            return
        }
        XCTAssertEqual(shown, [1: 12, 2: 12, 3: 11, 4: 11])
        XCTAssertEqual(element(app, "fan.1").label, "ivy: 12 cards")
        XCTAssertEqual(element(app, "dealer").label, "Dealer: ivy")
        app.terminate()
    }
}
