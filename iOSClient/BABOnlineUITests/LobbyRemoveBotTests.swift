import XCTest

/// Owner report (2026-11-13): "no ability to remove bots from lobby once added". A bot that
/// is not ready shows a remove control in its row, as on the web (GameLobby.js): any lobby
/// member may tap it, it sends removeBot with the bot's socket id, and the server's answer
/// (emulated in the `game-lobby-bots` fixture: UIFixture.emulateLobby) drops the row and
/// keeps the humans' ready flags (server PR #248), so my button still reads Unready; a bot
/// added afterwards takes the lowest free name. Human rows never show
/// one. Each control is a 44 pt target inside the window and, on the Duo, clear of the
/// vertical bar.
final class LobbyRemoveBotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func removeButtons(_ app: XCUIApplication) -> [XCUIElement] {
        app.buttons.matching(identifier: "lobby.removeBot").allElementsBoundByIndex
    }

    /// Waits up to `timeout` s for `condition`.
    private func wait(_ timeout: TimeInterval = 5, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return condition()
    }

    /// The vertical bar's column in screen points (LobbyControlsTests), nil where there is none.
    private func verticalBarColumn(_ pose: String) -> ClosedRange<CGFloat>? {
        guard let edge = pose.split(separator: " ").last, edge != "-", pose.contains(" vbar "),
              let size = Fixture.windowSize(pose), let insets = Fixture.insets(pose) else { return nil }
        switch edge {
        case "trailing": return (size.width - insets.right)...size.width
        case "leading": return 0...insets.left
        default: return nil
        }
    }

    private func shot(_ name: String, _ pose: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "\(Fixture.poseName(pose))-game-lobby-bots-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    func testRemoveBotThenAddAgain() {
        let fixture = "game-lobby-bots"
        let app = Fixture.launch(fixture)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20))
        sleep(1)
        let pose = Fixture.probe(app, "ui.pose")
        let size = Fixture.windowSize(pose)
        let column = verticalBarColumn(pose)

        // one control per bot that is not ready, none on the human rows
        let controls = removeButtons(app)
        XCTAssertEqual(controls.count, 2, "\(pose): \(controls.map(\.label))")
        XCTAssertEqual(Set(controls.map(\.label)), ["Remove Bot", "Remove Bot 2"], "the VoiceOver labels")
        for c in controls {
            let f = c.frame
            XCTAssertTrue(c.isHittable, "\(c.label) is not hittable at \(f)")
            XCTAssertGreaterThanOrEqual(f.width, 44 - 0.5, "\(c.label): \(f) is under 44 pt wide")
            XCTAssertGreaterThanOrEqual(f.height, 44 - 0.5, "\(c.label): \(f) is under 44 pt tall")
            if let size {
                XCTAssertTrue(CGRect(origin: .zero, size: size).insetBy(dx: -1, dy: -1).contains(f), "\(c.label): \(f) leaves the window \(size)")
            }
            if let column {
                XCTAssertFalse(f.maxX > column.lowerBound + 1 && f.minX < column.upperBound - 1,
                               "\(c.label) at \(f) reaches into the vertical bar \(column)")
            }
        }
        XCTAssertTrue(app.buttons["Unready"].exists, "I am ready in the fixture")
        XCTAssertFalse(app.buttons["Add Bot"].exists, "a full lobby has no Add Bot")
        shot("before", pose)

        // remove one: the server's list drops it; the humans stay ready
        app.buttons["Remove Bot 2"].tap()
        XCTAssertTrue(wait { Fixture.probe(app, "fixture.sent") == "removeBot:bot:fixture-2" },
                      "sent: \(Fixture.probe(app, "fixture.sent"))")
        XCTAssertTrue(wait { self.removeButtons(app).count == 1 }, "the removed bot's row is still there")
        XCTAssertEqual(removeButtons(app).first?.label, "Remove Bot")
        XCTAssertFalse(app.staticTexts["🤖 Bot 2"].exists, "the removed bot is still listed")
        XCTAssertTrue(app.buttons["Unready"].exists, "removing a bot keeps my ready flag (the button follows the server's list)")
        XCTAssertTrue(app.buttons["Add Bot"].waitForExistence(timeout: 3), "a seat is free: Add Bot is back")
        shot("removed", pose)

        // add one again: a new bot that is not ready, removable
        app.buttons["Add Bot"].tap()
        XCTAssertTrue(wait { self.removeButtons(app).count == 2 }, "the added bot has no remove control")
        XCTAssertEqual(Set(removeButtons(app).map(\.label)), ["Remove Bot", "Remove Bot 2"], "the new bot takes the free name Bot 2, never a second Bot")
        XCTAssertEqual(Fixture.probe(app, "fixture.sent"), "removeBot:bot:fixture-2|addBot")
        XCTAssertFalse(app.buttons["Add Bot"].exists, "full again")
        shot("added", pose)
        app.terminate()
    }

    /// The `game-lobby` fixture's bot is ready (a human readied the full lobby): no remove
    /// control, as on the web, so a bot cannot be taken out of a lobby that is starting.
    func testReadyBotHasNoRemoveControl() {
        let app = Fixture.launch("game-lobby")
        XCTAssertTrue(Fixture.readyElement(app, "game-lobby").waitForExistence(timeout: 20))
        sleep(1)
        XCTAssertTrue(app.descendants(matching: .any)["lobby.players"].waitForExistence(timeout: 5))
        XCTAssertEqual(removeButtons(app).count, 0)
        app.terminate()
    }
}
