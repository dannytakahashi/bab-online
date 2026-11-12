import XCTest

/// The 8-player tournament lobby on a small screen (phones, the closed Duo):
/// the player list is capped above the chat and scrolls; every row can be
/// brought fully into view above the chat, and the part cut off by the cap
/// fades instead of ending on a hard half row.
final class TournamentListReachTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func reachEveryRow(_ fixture: String) {
        let app = Fixture.launch(fixture)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 20))
        sleep(1)
        let pose = Fixture.probe(app, "ui.pose")
        let list = app.descendants(matching: .any)["tournament.players"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        let field = app.textFields["tournamentChatField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        let first = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: first)
        a.name = "\(Fixture.poseName(pose))-\(fixture)-players-top"
        a.lifetime = .keepAlways
        add(a)
        // the capped scroll view (its frame is what shows above the chat)
        let viewport = app.scrollViews.containing(.any, identifier: "tournament.players").firstMatch
        XCTAssertTrue(viewport.exists)
        for name in ["kim", "ivy", "hal", "jon", "ora", "max", "pat", "ned"] {
            let row = list.staticTexts[name]
            XCTAssertTrue(row.waitForExistence(timeout: 2), "\(pose): no row \(name)")
            func shown() -> Bool {
                let f = row.frame, v = viewport.frame
                return f.minY >= v.minY - 0.5 && f.maxY <= v.maxY + 0.5 && row.isHittable
            }
            var tries = 0
            // short drags inside the viewport, toward the row
            while !shown() && tries < 12 {
                let down = row.frame.maxY > viewport.frame.maxY
                let start = viewport.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.75 : 0.25))
                let end = viewport.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.4 : 0.6))
                start.press(forDuration: 0.05, thenDragTo: end)
                tries += 1
            }
            XCTAssertTrue(shown(), "\(pose): row \(name) \(row.frame) never came fully into view \(viewport.frame)")
        }
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "\(Fixture.poseName(pose))-\(fixture)-players-end"
        shot.lifetime = .keepAlways
        add(shot)
        app.terminate()
    }

    func testEveryPlayerRowIsReachableMidRound() { reachEveryRow("tournament-round") }
    func testEveryPlayerRowIsReachableBetweenRounds() { reachEveryRow("tournament-between") }
}
