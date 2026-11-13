import XCTest

/// Owner, 2026-11-12: Leave in a solo bot game said a bot would finish my hand, but the
/// server ends a game no other owner can return to. The confirmation now says what happens
/// (LeaveOutcome; unit tests in LeaveOutcomeTests).
final class LeaveAlertUITests: XCTestCase {
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
        let alert = app.alerts["Leave game?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "\(tag): no Leave alert")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "leave-alert-\(tag)"
        shot.lifetime = .keepAlways
        add(shot)
        let texts = alert.staticTexts.allElementsBoundByIndex.map(\.label).filter { $0 != "Leave game?" }
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
}
