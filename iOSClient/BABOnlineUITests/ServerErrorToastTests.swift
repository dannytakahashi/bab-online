import XCTest

/// The server-error toast (ConnectionStatusToast.swift, `ServerErrorToast`) is an overlay of
/// the connection pill's stack. While the pill was hidden that stack had no width, so the
/// error toast showed as a tall, empty capsule with only its icon (owner screenshot,
/// 2026-11-16: adding bots right after leaving a game). `-uiServerError` raises one.
final class ServerErrorToastTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func toast(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["serverErrorToast"]
    }

    func testAShortMessageIsOneReadableLine() {
        let app = Fixture.launch("game-lobby-bots", extra: ["-uiServerError", "Lobby is full"])
        XCTAssertTrue(Fixture.readyElement(app, "game-lobby-bots").waitForExistence(timeout: 15))
        let t = toast(app)
        XCTAssertTrue(t.waitForExistence(timeout: 5))
        XCTAssertTrue(t.label.contains("Lobby is full"), t.label)
        let screen = app.windows.firstMatch.frame
        // the element's frame is the message's: the bug gave it ~0 width and one glyph per line
        XCTAssertGreaterThan(t.frame.width, 80, "the message has room: \(t.frame)")
        XCTAssertLessThan(t.frame.height, 30, "one line, not one glyph per line: \(t.frame)")
        XCTAssertLessThanOrEqual(t.frame.maxX, screen.maxX)
        XCTAssertGreaterThanOrEqual(t.frame.minX, screen.minX)
    }

    func testALongMessageWrapsWithinTheScreen() {
        // (no apostrophe: launch arguments lose it)
        let message = "The lobby closed while you were offline, so you are back in the main room."
        let app = Fixture.launch("main-room", extra: ["-uiServerError", message])
        XCTAssertTrue(Fixture.readyElement(app, "main-room").waitForExistence(timeout: 15))
        let t = toast(app)
        XCTAssertTrue(t.waitForExistence(timeout: 5))
        XCTAssertTrue(t.label.contains("The lobby closed while you were offline"), t.label)
        let screen = app.windows.firstMatch.frame
        // a phone wraps it at the screen's width; a 13-inch iPad fits it on one line (~585 pt)
        XCTAssertGreaterThan(t.frame.width, min(screen.width * 0.6, 500), "the message has its width: \(t.frame)")
        if t.frame.height > 30 {
            XCTAssertGreaterThan(t.frame.width, screen.width * 0.6, "wraps at the screen's width: \(t.frame)")
        }
        XCTAssertLessThan(t.frame.height, 80, "a few lines at most: \(t.frame)")
        XCTAssertLessThanOrEqual(t.frame.maxX, screen.maxX)
    }
}
