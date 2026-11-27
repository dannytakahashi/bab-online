import XCTest

/// Opt-in live check of a tournament round with partners shown openly and the draw for first deal
/// (iOS 1.2.7 (41)) against a local server (never production): this app registers, creates a
/// tournament and waits for a second member with the cap `tournamentPairings`
/// (`TEST_RUNNER_BAB_LIVE_PEER`, e.g. a node socket.io client that joins the tournament this
/// user created, readies, draws and goes /lazy); then Ready and Begin. The tournament screen shows
/// "Round 1 pairings" with the peer named, the table shows "Draw for First Deal" with the teams
/// line before anyone draws, and a tap on the deck draws (the server's log says which card was
/// asked for and dealt). Environment as `LiveTournamentVoiceTests`:
/// `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`, `TEST_RUNNER_BAB_LIVE_USER=<new name>`,
/// `TEST_RUNNER_BAB_LIVE_PASS=<random>` (keep the password out of logs and the repo),
/// `TEST_RUNNER_BAB_LIVE_PEER=<the peer's name>`. Screenshots are kept attachments `live-pairings-*`.
final class LiveTournamentPairingsTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "live-pairings-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    func testARoundShowsThePairingsAndTheDrawForFirstDeal() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["BAB_LIVE_SERVER"], let user = env["BAB_LIVE_USER"], let pass = env["BAB_LIVE_PASS"],
              let peer = env["BAB_LIVE_PEER"],
              server.hasPrefix("http://localhost:") || server.hasPrefix("http://127.0.0.1:") else {
            throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_SERVER (a localhost origin), _USER, _PASS, _PEER")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server]
        app.launch()

        let toRegister = app.buttons.matching(NSPredicate(format: "label == %@", "Create Account")).firstMatch
        XCTAssertTrue(toRegister.waitForExistence(timeout: 30), "no Create Account on the sign-in screen")
        toRegister.tap()
        let name = app.textFields["Username"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap(); name.typeText(user)
        app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(pass)
        app.secureTextFields["Confirm Password"].tap(); app.secureTextFields["Confirm Password"].typeText(pass)
        // the main room is up once New Game is (a tournament is New Game's choice since 2026-11-26)
        let tournament = app.buttons["New Game"].firstMatch
        for _ in 0..<3 where !tournament.exists {
            sleep(1)
            app.buttons.matching(NSPredicate(format: "label == %@", "Register")).firstMatch.tap()
            _ = tournament.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(tournament.waitForExistence(timeout: 20), "not in the main room after registering")
        let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: tournament)
        wait(for: [enabled], timeout: 15)
        Fixture.createTournament(app)

        let lobby = app.descendants(matching: .any)["screen.tournamentLobby"]
        XCTAssertTrue(lobby.waitForExistence(timeout: 20), "no tournament lobby")
        // the peer joins and readies
        let row = app.descendants(matching: .any)["tournament.players"].staticTexts[peer]
        XCTAssertTrue(row.waitForExistence(timeout: 240), "\(peer) never joined the tournament")
        XCTAssertFalse(app.descendants(matching: .any)["pairings"].exists, "no pairings in the lobby phase")
        app.buttons["Ready"].tap()
        let begin = app.buttons["tournament.begin"]
        XCTAssertTrue(begin.waitForExistence(timeout: 10))
        wait(for: [expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: begin)], timeout: 30)
        begin.tap()

        // round 1's pairings on the tournament screen (the announce: about 3.5 s before the table
        // opens, so each label is read once)
        let mine = app.descendants(matching: .any)["pairings.row.0"]
        XCTAssertTrue(mine.waitForExistence(timeout: 10), "no round pairings after Begin")
        shot("1-round-pairings")
        let roundLabel = app.descendants(matching: .any)["pairings.round"].label
        let mineLabel = mine.label
        print("[live] \(roundLabel): \(mineLabel)")
        XCTAssertEqual(roundLabel, "Round 1 pairings")
        XCTAssertTrue(mineLabel.hasPrefix("you and "), mineLabel)
        XCTAssertTrue(mineLabel.contains(peer), "the peer named in my table's pairing: \(mineLabel)")

        // the table: the draw for first deal with the teams shown before anyone draws
        let title = app.staticTexts["Draw for First Deal"]
        XCTAssertTrue(title.waitForExistence(timeout: 20), "no draw for first deal")
        XCTAssertTrue(app.staticTexts["Partners are set for this round. The highest card deals first."].exists)
        XCTAssertFalse(app.staticTexts["The two highest cards are partners; the highest deals."].exists)
        let teams = app.descendants(matching: .any)["draw.plannedTeams"]
        XCTAssertTrue(teams.waitForExistence(timeout: 5))
        XCTAssertTrue(teams.label.hasPrefix("Partners: you and "), teams.label)
        XCTAssertTrue(teams.label.contains(peer), teams.label)
        print("[live] teams line: \(teams.label)")
        shot("2-draw-teams")

        let deck = app.buttons["Draw a card"]
        XCTAssertTrue(deck.waitForExistence(timeout: 10))
        deck.tap()
        // my slot turns over: its card is the one the server dealt me (compared with the server log)
        var myCard = ""
        let deadline = Date().addingTimeInterval(20)
        while myCard.isEmpty && Date() < deadline {
            for i in 0..<4 {
                let slot = app.descendants(matching: .any)["draw.slot.\(i)"]
                if slot.exists, slot.label == "\(user), you", let v = slot.value as? String, !v.isEmpty { myCard = v }
            }
            if myCard.isEmpty { sleep(1) }
        }
        XCTAssertFalse(myCard.isEmpty, "my drawn card never showed")
        print("[live] my card: \(myCard)")
        sleep(2)
        shot("3-draw-results")
        // the teams panel after the seating: my partner is the plan's
        let panel = app.descendants(matching: .any)["draw.teams"]
        XCTAssertTrue(panel.waitForExistence(timeout: 20), "no teams panel")
        sleep(1)
        shot("4-teams-announced")
    }
}
