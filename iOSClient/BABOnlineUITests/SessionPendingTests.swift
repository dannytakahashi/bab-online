import XCTest

/// After a reconnect (a long background, a deploy) the main room is on screen before the
/// server has restored the session; a New Game tapped then made a lobby that the restore's
/// joinMainRoom left at once (owner, 2026-11-12). Until the restore answers
/// (`-uiSessionPending YES` holds that moment) the actions that go to the server wait;
/// the ones that only open a sheet do not.
final class SessionPendingTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func button(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func readyButton(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Ready", "Unready")).firstMatch
    }

    func testMainRoomActionsWaitForTheSession() {
        let app = Fixture.launch("main-room", extra: ["-uiSessionPending", "YES"])
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        // New Game holds a tournament too now (its third choice)
        for label in ["New Game", "Join", "Spectate"] {
            let b = button(app, label)
            XCTAssertTrue(b.waitForExistence(timeout: 5), label)
            XCTAssertFalse(b.isEnabled, "\(label) waits for the restore")
        }
        XCTAssertTrue(button(app, "Leaderboard").isEnabled, "a sheet needs no session")
    }

    /// A foreground after the keep-alive probes the connection before keeping it
    /// (`-uiForegroundProbe YES` holds that moment, signed in): an action sent then could go
    /// out on a socket the probe retires, so the same actions wait, with no Reconnecting
    /// toast (a live link answers in milliseconds).
    func testMainRoomActionsWaitForAForegroundProbe() {
        let app = Fixture.launch("main-room", extra: ["-uiForegroundProbe", "YES"])
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        for label in ["New Game", "Join", "Spectate"] {
            let b = button(app, label)
            XCTAssertTrue(b.waitForExistence(timeout: 5), label)
            XCTAssertFalse(b.isEnabled, "\(label) waits for the probe's answer")
        }
        XCTAssertTrue(button(app, "Leaderboard").isEnabled, "a sheet needs no session")
        XCTAssertFalse(app.descendants(matching: .any)["connectionToast"].exists, "no Reconnecting toast")
    }

    /// A lobby after a reconnect stays on screen while the restore and its joinLobby run
    /// (LobbyRejoinTests): this socket is not in the lobby until the re-entry is answered,
    /// so Ready and removing a bot wait; Leave never does.
    func testLobbyActionsWaitForTheSessionAndTheRejoin() {
        for extra in [["-uiSessionPending", "YES"], ["-uiLobbyRejoin", "YES"]] {
            let app = Fixture.launch("game-lobby-bots", extra: extra)
            XCTAssertTrue(Fixture.readyElement(app, "game-lobby-bots").waitForExistence(timeout: 15), "\(extra)")
            let ready = readyButton(app)  // "Unready": I am ready in this fixture
            XCTAssertTrue(ready.waitForExistence(timeout: 5), "\(extra)")
            XCTAssertFalse(ready.isEnabled, "Ready waits: \(extra)")
            let removes = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove")).allElementsBoundByIndex
            XCTAssertFalse(removes.isEmpty, "\(extra)")
            for r in removes { XCTAssertFalse(r.isEnabled, "\(r.label) waits: \(extra)") }
            XCTAssertTrue(button(app, "Leave").isEnabled, "Leave never waits: \(extra)")
            app.terminate()
        }
        let app = Fixture.launch("game-lobby-bots")
        XCTAssertTrue(Fixture.readyElement(app, "game-lobby-bots").waitForExistence(timeout: 15))
        XCTAssertTrue(readyButton(app).isEnabled, "signed in, nothing pending")
    }

    /// During the re-entry the chat's Send waits too (the server drops a line from a socket
    /// not in the lobby without a word), and Leave goes to the main room at once (a
    /// leaveLobby from that socket would be refused and strand the screen, LobbyRejoin).
    func testChatWaitsAndLeaveWorksDuringTheRejoin() {
        let app = Fixture.launch("game-lobby-bots", extra: ["-uiLobbyRejoin", "YES"])
        XCTAssertTrue(Fixture.readyElement(app, "game-lobby-bots").waitForExistence(timeout: 15))
        let field = app.textFields["lobbyChatField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("back soon")
        XCTAssertFalse(button(app, "Send").isEnabled, "Send waits for the re-entry")
        XCTAssertEqual(field.value as? String, "back soon", "the line stays in the field")
        button(app, "Leave").tap()
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 5), "Leave is never stranded")
        app.terminate()

        let plain = Fixture.launch("game-lobby-bots")
        XCTAssertTrue(Fixture.readyElement(plain, "game-lobby-bots").waitForExistence(timeout: 15))
        let f = plain.textFields["lobbyChatField"]
        XCTAssertTrue(f.waitForExistence(timeout: 5))
        f.tap()
        f.typeText("hi")
        XCTAssertTrue(button(plain, "Send").isEnabled, "nothing pending")
    }

    func testMainRoomActionsWorkOnceSignedIn() {
        let app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        for label in ["New Game", "Join", "Spectate", "Leaderboard"] {
            let b = button(app, label)
            XCTAssertTrue(b.waitForExistence(timeout: 5), label)
            XCTAssertTrue(b.isEnabled, label)
        }
    }
}
