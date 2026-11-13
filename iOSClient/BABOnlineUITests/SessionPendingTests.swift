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

    func testMainRoomActionsWaitForTheSession() {
        let app = Fixture.launch("main-room", extra: ["-uiSessionPending", "YES"])
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        for label in ["New Game", "Tournament", "Join", "Spectate"] {
            let b = button(app, label)
            XCTAssertTrue(b.waitForExistence(timeout: 5), label)
            XCTAssertFalse(b.isEnabled, "\(label) waits for the restore")
        }
        XCTAssertTrue(button(app, "Stats").isEnabled, "a sheet needs no session")
    }

    func testMainRoomActionsWorkOnceSignedIn() {
        let app = Fixture.launch("main-room")
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        for label in ["New Game", "Tournament", "Join", "Spectate", "Stats"] {
            let b = button(app, label)
            XCTAssertTrue(b.waitForExistence(timeout: 5), label)
            XCTAssertTrue(b.isEnabled, label)
        }
    }
}
