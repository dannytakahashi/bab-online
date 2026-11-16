import XCTest

/// Play again on screen (1.2.3, build 12; owner 2026-11-16). Fixture `game-end` /
/// `game-end-spectator` with `-uiLobbyReturn YES`: 0.5 s after the gameEnd the server's
/// lobbyReturn arrives ("Family night": me the host, ivy's place held, kim, a bot, grandpa expected).
/// The score screen must stay exactly as it is until Return to Lobby (label unchanged), which
/// then shows that lobby instead of the main room. `-uiLobbyReturn lost`: no gameEnd ever
/// applies, so after 5 s the app enters the lobby. The rules are PlayAgainTests.
final class PlayAgainUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func reveal(_ app: XCUIApplication, _ e: XCUIElement) {
        for _ in 0..<8 where !(e.exists && e.isHittable) { app.swipeUp(velocity: .slow) }
    }

    /// The results stay, full screen, well after lobbyReturn landed: same title, stats and
    /// button, no lobby behind or over them.
    private func assertResultsStay(_ app: XCUIApplication, title: String) {
        XCTAssertTrue(any(app, "gameEnd").waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 3)  // lobbyReturn came at 0.5 s
        XCTAssertTrue(any(app, "gameEnd").exists, "the score screen is still up")
        XCTAssertEqual(any(app, "gameEnd.title").label, title)
        XCTAssertTrue(any(app, "gameEnd.stats").exists, "the per-player stats are still there")
        XCTAssertFalse(any(app, "screen.gameLobby").exists, "no lobby behind the results")
        XCTAssertFalse(app.buttons["Close"].exists, "the button is not relabelled")
        XCTAssertTrue(app.buttons["Return to Lobby"].isHittable)
    }

    func testTheResultsStayUntilReturnToLobbyWhichOpensTheLobby() {
        let app = Fixture.launch("game-end", extra: ["-uiLobbyReturn", "YES"])
        assertResultsStay(app, title: "Defeat")  // jon, seat 4
        keep("play-again-results-kept")

        app.buttons["Return to Lobby"].tap()
        XCTAssertTrue(any(app, "screen.gameLobby").waitForExistence(timeout: 5), "the lobby, not the main room")
        XCTAssertFalse(any(app, "screen.mainRoom").exists)
        XCTAssertTrue(app.staticTexts["Family night"].exists)
        for name in ["jon", "ivy", "kim"] {
            XCTAssertTrue(app.staticTexts[name].exists, "\(name) is in the lobby")
        }
        // ivy's place is held ("Not back yet"), grandpa (an older app) is expected
        XCTAssertEqual(app.staticTexts.matching(identifier: "lobby.returning").count, 1)
        XCTAssertTrue(any(app, "lobby.expected").exists)
        XCTAssertTrue(any(app, "lobby.expected.grandpa").label.contains("Not back yet"))
        XCTAssertFalse(app.buttons["Add Bot"].exists, "4 members and one expected: no bot")
        XCTAssertEqual(app.buttons["Ready"].label, "Ready", "nobody is ready after a game")
        keep("play-again-lobby")

        // the host may stop waiting: ivy's hold, then grandpa's reservation
        let ivy = app.buttons["lobby.dontWait.ivy"]
        reveal(app, ivy)
        XCTAssertEqual(ivy.label, "Don't wait for ivy")
        ivy.tap()
        XCTAssertTrue(Fixture.probe(app, "fixture.sent").contains("releaseLobbyHold:ivy"))
        XCTAssertTrue(app.staticTexts["ivy"].waitForNonExistence(timeout: 3), "the held place went")
        let grandpa = app.buttons["lobby.dontWait.grandpa"]
        reveal(app, grandpa)
        grandpa.tap()
        XCTAssertTrue(Fixture.probe(app, "fixture.sent").contains("releaseLobbyHold:grandpa"))
        XCTAssertTrue(any(app, "lobby.expected").waitForNonExistence(timeout: 3))
        reveal(app, app.buttons["Add Bot"])
        XCTAssertTrue(app.buttons["Add Bot"].exists, "3 members, nobody expected: Add Bot again")
    }

    func testASpectatorsResultsStayToo() {
        let app = Fixture.launch("game-end-spectator", extra: ["-uiLobbyReturn", "YES"])
        assertResultsStay(app, title: "Game Over")
        app.buttons["Return to Lobby"].tap()
        XCTAssertTrue(any(app, "screen.gameLobby").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Family night"].exists)
        XCTAssertEqual(app.staticTexts.matching(identifier: "lobby.returning").count, 1, "ivy's place held")
        XCTAssertTrue(any(app, "lobby.expected.grandpa").exists)
    }

    func testWithoutALobbyReturnTheButtonGoesToTheMainRoom() {
        let app = Fixture.launch("game-end")
        XCTAssertTrue(any(app, "gameEnd").waitForExistence(timeout: 20))
        app.buttons["Return to Lobby"].tap()
        XCTAssertTrue(any(app, "screen.mainRoom").waitForExistence(timeout: 5), "today's way: the main room")
    }

    func testNoGameEndInTimeEntersTheLobby() {
        let app = Fixture.launch("game-end", extra: ["-uiLobbyReturn", "lost"])
        // the table without results until LobbyReturn.gameEndWait (5 s from the return) runs
        // out (a slow first launch may already be past it: the lobby is what must come)
        let lobby = any(app, "screen.gameLobby")
        XCTAssertTrue(lobby.waitForExistence(timeout: 30), "into the lobby after LobbyReturn.gameEndWait")
        XCTAssertFalse(any(app, "gameEnd").exists, "no score screen ever showed")
        XCTAssertTrue(app.staticTexts["Family night"].exists)
    }
}
