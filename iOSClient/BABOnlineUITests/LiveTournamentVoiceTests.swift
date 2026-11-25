import XCTest

/// Opt-in live check of tournament-room voice (iOS 1.2.6) against a local server with
/// server/voice/tournamentVoice.js (never production): this app creates a tournament and is alone
/// in its lobby (no mic: no voice alone); a second member with the cap `tournamentVoice` joins
/// (`TEST_RUNNER_BAB_LIVE_PEER`, e.g. a script that offers to every voicePeerList peer): the
/// server announces them (voicePeerJoined) and voice starts muted with no microphone prompt; once
/// they leave (voicePeerLeft) the mic goes after the 30 s grace. Environment as
/// `LiveMutedVoiceTests`: `TEST_RUNNER_BAB_LIVE_SERVER=http://localhost:<port>`,
/// `TEST_RUNNER_BAB_LIVE_USER=<new name>`, `TEST_RUNNER_BAB_LIVE_PASS=<random>` (the account is
/// created by the test; keep the password out of logs and the repo), `TEST_RUNNER_BAB_LIVE_PEER`.
/// A peer script's hand-made SDP needs an `a=ssrc` line (and `a=msid`): without one WebRTC makes
/// no receive stream until media arrives, so it never starts playout and the VoiceProcessingIO
/// unit (and `VoiceDucking`'s "[Voice] ducking set" in the simulator's log) never comes up.
final class LiveTournamentVoiceTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "live-tournament-voice-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private struct Live { let app: XCUIApplication; let peer: String }

    /// Registers the test's account against the local server and creates a tournament.
    private func createTournament() throws -> Live {
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
        let tournament = app.buttons["Tournament"]
        for _ in 0..<3 where !tournament.exists {
            sleep(1)
            app.buttons.matching(NSPredicate(format: "label == %@", "Register")).firstMatch.tap()
            _ = tournament.waitForExistence(timeout: 8)
        }
        XCTAssertTrue(tournament.waitForExistence(timeout: 20), "not in the main room after registering")
        let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: tournament)
        wait(for: [enabled], timeout: 15)
        tournament.tap()
        return Live(app: app, peer: peer)
    }

    func testTheTournamentLobbyStartsVoiceWhenAMemberIsAnnounced() throws {
        guard ProcessInfo.processInfo.environment["BAB_LIVE_TABLE"] != "1" else { throw XCTSkip("the table run") }
        let live = try createTournament()
        let app = live.app, peer = live.peer

        // alone in the tournament lobby: no voice
        let screen = app.descendants(matching: .any)["screen.tournamentLobby"]
        XCTAssertTrue(screen.waitForExistence(timeout: 20), "no tournament lobby")
        sleep(3)
        let mic = app.descendants(matching: .any)["tournament.mic"]
        XCTAssertFalse(mic.exists, "voice started with nobody else in the room")
        shot("1-alone")

        // the other member joins: announced, so voice starts muted
        // their row in the players list (the scoreboard keeps a leaver's row)
        let row = app.descendants(matching: .any)["tournament.players"].staticTexts[peer]
        XCTAssertTrue(row.waitForExistence(timeout: 240), "\(peer) never joined the tournament")
        XCTAssertTrue(mic.waitForExistence(timeout: 20), "the header's mic")
        XCTAssertEqual(mic.label, "Unmute microphone", "muted at the start")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertFalse(springboard.alerts.matching(NSPredicate(format: "label CONTAINS[c] 'microphone'")).firstMatch.exists,
                       "joining voice asked for the microphone")
        shot("2-with-peer")

        // they leave: the mic goes after the grace (30 s)
        XCTAssertTrue(row.waitForNonExistence(timeout: 120), "\(peer) never left")
        XCTAssertTrue(mic.exists, "the grace keeps voice")
        XCTAssertTrue(mic.waitForNonExistence(timeout: 45), "voice still on 45 s after the last member left")
        shot("3-alone-again")
    }

    /// `TEST_RUNNER_BAB_LIVE_TABLE=1` (the peer readies up and draws, and answers an offer): the
    /// tournament room's voice, then Ready and Begin; at the round's table the room's call is gone
    /// (the room change at the assignment) and voice starts again once the seating shows the peer
    /// (the server announces the table right after positionUpdate).
    func testATournamentTableStartsVoiceAtTheSeating() throws {
        guard ProcessInfo.processInfo.environment["BAB_LIVE_TABLE"] == "1" else { throw XCTSkip("opt-in: TEST_RUNNER_BAB_LIVE_TABLE=1") }
        let live = try createTournament()
        let app = live.app, peer = live.peer
        let row = app.descendants(matching: .any)["tournament.players"].staticTexts[peer]
        XCTAssertTrue(row.waitForExistence(timeout: 240), "\(peer) never joined the tournament")
        let mic = app.descendants(matching: .any)["tournament.mic"]
        XCTAssertTrue(mic.waitForExistence(timeout: 20), "the tournament room's voice")
        app.buttons["Ready"].tap()
        let begin = app.buttons["tournament.begin"]
        XCTAssertTrue(begin.waitForExistence(timeout: 10))
        let canBegin = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: begin)
        wait(for: [canBegin], timeout: 30)
        begin.tap()

        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 30), "the round's table did not open")
        XCTAssertFalse(app.buttons["Unmute microphone"].exists, "the draw: the room's voice ended, the table's waits for the seating")
        shot("table-1-draw")
        let deck = app.buttons["Draw a card"]
        XCTAssertTrue(deck.waitForExistence(timeout: 15), "no deck to draw from")
        let hittable = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: deck)
        wait(for: [hittable], timeout: 10)
        deck.tap()
        // seated with the peer: voice starts muted (my seat's row)
        XCTAssertTrue(app.buttons["Unmute microphone"].waitForExistence(timeout: 40), "no voice at the table after the seating")
        sleep(5)  // the call's offer and answer (the peer's log)
        shot("table-2-seated")
    }
}
