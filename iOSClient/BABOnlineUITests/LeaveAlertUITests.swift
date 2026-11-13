import XCTest

/// Owner, 2026-11-12: Leave in a solo bot game said a bot would finish my hand, but the
/// server ends a game no other owner can return to. The confirmation now says what happens
/// (LeaveOutcome; unit tests in LeaveOutcomeTests).
final class LeaveAlertUITests: XCTestCase {
    /// The alert's title (#235: "Exit" for a seat and a spectator alike).
    static let title = "Exit game?"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// Taps Leave on the fixture's table and returns the alert's message (then cancels).
    private func leaveMessage(_ app: XCUIApplication, _ tag: String) -> String {
        let leave = app.buttons["leave"]
        XCTAssertTrue(leave.waitForExistence(timeout: 20), "\(tag): no Leave button")
        _ = Fixture.settledState(app)
        leave.tap()
        let alert = app.alerts[LeaveAlertUITests.title]
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "\(tag): no Leave alert")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "leave-alert-\(tag)"
        shot.lifetime = .keepAlways
        add(shot)
        let texts = alert.staticTexts.allElementsBoundByIndex.map(\.label).filter { $0 != LeaveAlertUITests.title }
        alert.buttons["Cancel"].tap()
        XCTAssertFalse(alert.waitForExistence(timeout: 1), "\(tag): Cancel left the alert up")
        XCTAssertTrue(leave.exists, "\(tag): Cancel left the table")
        return texts.joined(separator: "\n")
    }

    /// The tournament-game fixture (me and three filler bots) with `edit` applied, through the environment.
    private func soloSnapshot(_ edit: (inout [String: Any]) -> Void) throws -> String {
        final class Token {}
        let url = try XCTUnwrap(Bundle(for: Token.self).url(forResource: "tournament-game", withExtension: "json", subdirectory: "v2"))
        let raw = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var snap = try XCTUnwrap(raw["snapshot"] as? [String: Any])
        edit(&snap)
        return String(decoding: try JSONSerialization.data(withJSONObject: snap), as: UTF8.self)
    }

    func testSoloBotGameSaysLeavingEndsIt() throws {
        let env = try soloSnapshot { $0["tournament"] = NSNull() }
        let app = Fixture.launch("env", env: ["UI_FIXTURE_SNAPSHOT": env])
        XCTAssertEqual(leaveMessage(app, "solo"), "You're the only player here, so leaving ends the game.")
        app.terminate()
    }

    func testSoloTournamentTableSaysItsGameEnds() {
        let app = Fixture.launch("tournament-game")
        XCTAssertEqual(leaveMessage(app, "tournament-solo"),
                       "You're the only player at this table, so leaving ends its game with no score for this round. You stay in the tournament.")
        app.terminate()
    }

    func testOnlyALazyOwnerBesideMeIsHedged() throws {
        // review L1: a lazy owner may have /leave'd with no event; until a snapshot settles it
        // (none comes in a fixture) the alert names both outcomes, never the plain bot line
        let env = try soloSnapshot { snap in
            snap["tournament"] = NSNull()
            var seats = snap["seats"] as? [[String: Any]] ?? []
            for i in seats.indices where seats[i]["position"] as? Int == 1 {
                seats[i]["controller"] = "lazyBot"
                seats[i]["presence"] = "connected"
                seats[i]["ownerUsername"] = "bob"
                seats[i]["isBot"] = true
            }
            snap["seats"] = seats
        }
        let app = Fixture.launch("env", env: ["UI_FIXTURE_SNAPSHOT": env])
        XCTAssertEqual(leaveMessage(app, "lazy-owner"),
                       "A bot will finish your hand for you, unless everyone else has left too: then leaving ends the game.")
        app.terminate()
    }

    func testWithOtherPlayersABotFinishes() {
        let app = Fixture.launch("presence-mixed")  // grace, resignable and lazy owners at the other seats
        XCTAssertEqual(leaveMessage(app, "others"), "A bot will finish your hand for you.")
        app.terminate()
    }

    // MARK: The reopened alert (verifier, 2026-11-13: its Leave Game sent no /leave)

    static let botFinishes = "A bot will finish your hand for you."
    static let endsGame = "You're the only player here, so leaving ends the game."
    static let hedged = "A bot will finish your hand for you, unless everyone else has left too: then leaving ends the game."

    /// The tournament-game table as a casual game with bob, a connected human, at seat 4 (I am 2).
    private func withBob() throws -> String {
        try soloSnapshot { snap in
            snap["tournament"] = NSNull()
            var seats = snap["seats"] as? [[String: Any]] ?? []
            for i in seats.indices where seats[i]["position"] as? Int == 4 {
                seats[i]["controller"] = "human"
                seats[i]["presence"] = "connected"
                seats[i]["ownerUsername"] = "bob"
                seats[i]["username"] = "bob"
                seats[i]["isBot"] = false
            }
            snap["seats"] = seats
        }
    }

    private func message(_ alert: XCUIElement) -> String {
        alert.staticTexts.allElementsBoundByIndex.map(\.label).filter { $0 != LeaveAlertUITests.title }.joined(separator: "\n")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// The chat messages the app sent ("|"-joined, "-" none), once that stops changing.
    private func sent(_ app: XCUIApplication, expecting: String, timeout: TimeInterval = 4) -> String {
        let deadline = Date().addingTimeInterval(timeout)
        var now = Fixture.probe(app, "fixture.sent")
        while now != expecting, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            now = Fixture.probe(app, "fixture.sent")
        }
        return now
    }

    /// Taps Leave with bob at the table; `-uiLeaveDrive drive` then sends bob's /leave as the
    /// server does (UIFixture.leaveAlertPresented), so LeaveAlertFlow closes the open alert
    /// and opens it again (GameContainerView). Returns the reopened alert, showing `reopened`.
    private func reopenedAlert(_ drive: String, _ reopened: String) throws -> (XCUIApplication, XCUIElement) {
        let app = Fixture.launch("env", extra: ["-uiLeaveDrive", drive], env: ["UI_FIXTURE_SNAPSHOT": try withBob()])
        let leave = app.buttons["leave"]
        XCTAssertTrue(leave.waitForExistence(timeout: 20), "no Leave button")
        _ = Fixture.settledState(app)
        leave.tap()
        let alert = app.alerts[LeaveAlertUITests.title]
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "no Leave alert")
        XCTAssertEqual(message(alert), Self.botFinishes, "bob is here: the first alert")
        // an open alert keeps its first words, so new words mean it was closed and opened again
        let deadline = Date().addingTimeInterval(8)
        var seen = message(alert)
        while seen != reopened, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
            seen = alert.exists ? message(alert) : "-"
        }
        XCTAssertEqual(seen, reopened, "\(drive): the alert never reopened with the new words")
        shot(app, "reopened-\(drive)")
        Thread.sleep(forTimeInterval: 1)  // a person reads it first
        XCTAssertEqual(Fixture.probe(app, "fixture.sent"), "-", "nothing sent before a button")
        return (app, alert)
    }

    /// The settled reopen (bob's /leave, then the snapshot reply): Leave Game sends /leave.
    func testReopenedAlertLeaveGameSendsLeave() throws {
        let (app, alert) = try reopenedAlert("settle", Self.endsGame)
        alert.buttons["Exit Game"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 3), "Leave Game left the alert up")
        XCTAssertEqual(sent(app, expecting: "/leave"), "/leave", "the reopened alert's Leave Game sent no /leave")
        app.terminate()
    }

    /// The hold-timeout reopen (bob's /leave, no reply within 1.5 s): Leave Game sends /leave.
    func testHedgedReopenedAlertLeaveGameSendsLeave() throws {
        let (app, alert) = try reopenedAlert("hold", Self.hedged)
        alert.buttons["Exit Game"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 3), "Leave Game left the alert up")
        XCTAssertEqual(sent(app, expecting: "/leave"), "/leave", "the reopened alert's Leave Game sent no /leave")
        app.terminate()
    }

    /// Cancel on the reopened alert sends nothing and keeps me at the table; Leave again opens
    /// a fresh alert (settled words) whose Leave Game sends /leave once.
    func testReopenedAlertCancelSendsNothing() throws {
        let (app, alert) = try reopenedAlert("settle", Self.endsGame)
        alert.buttons["Cancel"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 3), "Cancel left the alert up")
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertFalse(alert.exists, "the cancelled alert came back")
        XCTAssertEqual(Fixture.probe(app, "fixture.sent"), "-", "Cancel sent something")
        let leave = app.buttons["leave"]
        XCTAssertTrue(leave.exists, "Cancel left the table")
        leave.tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "no fresh alert")
        XCTAssertEqual(message(alert), Self.endsGame)
        alert.buttons["Exit Game"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 3))
        XCTAssertEqual(sent(app, expecting: "/leave"), "/leave")
        app.terminate()
    }

    /// A first-open alert (nothing changes while it is up): Leave Game sends /leave.
    func testFirstAlertLeaveGameSendsLeave() throws {
        let app = Fixture.launch("env", env: ["UI_FIXTURE_SNAPSHOT": try withBob()])
        let leave = app.buttons["leave"]
        XCTAssertTrue(leave.waitForExistence(timeout: 20), "no Leave button")
        _ = Fixture.settledState(app)
        leave.tap()
        let alert = app.alerts[LeaveAlertUITests.title]
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "no Leave alert")
        XCTAssertEqual(message(alert), Self.botFinishes)
        alert.buttons["Exit Game"].tap()
        XCTAssertTrue(alert.waitForNonExistence(timeout: 3))
        XCTAssertEqual(sent(app, expecting: "/leave"), "/leave")
        app.terminate()
    }
}
