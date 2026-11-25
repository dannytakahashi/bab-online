import XCTest

/// The tournament screen's pairings (owner 2026-11-25; iOS 1.2.7 (41)), fixture
/// `tournament-pairings` (round 3 in play: ivy's partners a bot, sat out, a 20-character name):
/// "Round 3 pairings" with my table first, "Partners so far", a spectator's every round
/// (`-uiSpectator YES`), and the update screen (`update-required`). Each row is read whole (it
/// wraps, never cuts) inside the window, at the default and the largest text size, on every
/// device the UI plan runs on (phones, the iPad, the Duo closed / open / book pose).
final class TournamentPairingsUITests: XCTestCase {
    static let ax5 = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    private let long1 = "Christopher Johnson1", long2 = "Alexandra Montgomery"

    override func setUp() {
        continueAfterFailure = true
    }

    private var device: String {
        (ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] ?? "device").replacingOccurrences(of: " ", with: "_")
    }

    private func shoot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = "pairings-\(device)-\(name)"
        a.lifetime = .keepAlways
        add(a)
    }

    private func open(_ extra: [String] = []) -> XCUIApplication {
        let app = Fixture.launch("tournament-pairings", extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, "tournament-pairings").waitForExistence(timeout: 20), "the tournament lobby")
        sleep(1)
        return app
    }

    /// Scrolls `element` into the window (the pairings sit in the capped scroll above the chat).
    private func reveal(_ app: XCUIApplication, _ element: XCUIElement) -> Bool {
        let window = app.windows.firstMatch.frame
        for _ in 0..<10 {
            let f = element.frame
            if element.exists, f.minY >= window.minY, f.maxY <= window.maxY, element.isHittable { return true }
            let scroll = app.scrollViews.containing(.any, identifier: "pairings").firstMatch
            guard scroll.exists else { return false }
            let down = f.maxY > window.maxY || !element.isHittable
            let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.8 : 0.2))
            let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.3 : 0.7))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        return element.isHittable
    }

    private func assertInside(_ app: XCUIApplication, _ element: XCUIElement, _ what: String) {
        let window = app.windows.firstMatch.frame
        let f = element.frame
        XCTAssertGreaterThanOrEqual(f.minX, window.minX - 0.5, "\(what) \(f) left of \(window)")
        XCTAssertLessThanOrEqual(f.maxX, window.maxX + 0.5, "\(what) \(f) right of \(window)")
        XCTAssertGreaterThan(f.width, 20, what)
    }

    func testAMemberSeesTheRoundsPairingsAndPartnersSoFar() {
        for extra in [[], Self.ax5] {
            let app = open(extra)
            let round = app.descendants(matching: .any)["pairings.round"]
            XCTAssertTrue(round.waitForExistence(timeout: 5), "no pairings \(extra)")
            XCTAssertEqual(round.label, "Round 3 pairings")
            // my table first, my team first, read whole with "and" / "versus"
            let rows = [("pairings.row.0", "You & \(long1) vs \(long2) & kim", "you and \(long1) versus \(long2) and kim"),
                        ("pairings.row.1", "hal & a bot vs jon & ora", "hal and a bot versus jon and ora"),
                        ("pairings.row.2", "max & a bot vs two bots", "max and a bot versus two bots")]
            for (id, _, spoken) in rows {
                let row = app.descendants(matching: .any)[id]
                XCTAssertTrue(row.waitForExistence(timeout: 5), id)
                XCTAssertEqual(row.label, spoken, id)
                XCTAssertTrue(reveal(app, row), "\(id) never came into view \(extra)")
                assertInside(app, row, id)
            }
            if extra.isEmpty { shoot("member") }
            let partners = app.descendants(matching: .any)["pairings.partners"]
            XCTAssertTrue(partners.waitForExistence(timeout: 5))
            XCTAssertEqual(partners.label, "Partners so far")
            for (n, partner) in [(1, "a bot"), (2, "sat out"), (3, long1)] {
                let p = app.descendants(matching: .any)["pairings.partner.\(n)"]
                XCTAssertTrue(p.waitForExistence(timeout: 5), "round \(n)")
                XCTAssertEqual(p.label, "Round \(n): \(partner)")
                XCTAssertTrue(reveal(app, p), "round \(n) partner never came into view \(extra)")
                assertInside(app, p, "round \(n) partner")
            }
            shoot(extra.isEmpty ? "member-partners" : "member-ax5")
            // never a team number
            for word in ["Team 1", "Team 2", "Your Team", "Opponents"] {
                XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", word)).firstMatch.exists, word)
            }
            app.terminate()
        }
    }

    func testASpectatorSeesEveryRound() {
        let app = open(["-uiSpectator", "YES"])
        XCTAssertTrue(app.descendants(matching: .any)["pairings.round"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.descendants(matching: .any)["pairings.round"].label, "Round 3 pairings")
        XCTAssertFalse(app.descendants(matching: .any)["pairings.partners"].exists, "no Partners so far for a spectator")
        for n in [2, 1] {
            let h = app.descendants(matching: .any)["pairings.round.\(n)"]
            XCTAssertTrue(h.waitForExistence(timeout: 5), "round \(n)")
            XCTAssertEqual(h.label, "Round \(n) pairings")
        }
        // plan order, full names (rows numbered across the rounds, latest first)
        XCTAssertEqual(app.descendants(matching: .any)["pairings.row.0"].label, "\(long2) and kim versus ivy and \(long1)")
        XCTAssertEqual(app.descendants(matching: .any)["pairings.row.3"].label, "kim and hal versus jon and \(long1)")
        XCTAssertEqual(app.descendants(matching: .any)["pairings.row.5"].label, "ivy and a bot versus kim and a bot")
        let last = app.descendants(matching: .any)["pairings.row.7"]
        XCTAssertTrue(reveal(app, last), "the last row never came into view")
        assertInside(app, last, "row 7")
        shoot("spectator")
        app.terminate()
    }

    func testTheUpdateScreenCoversTheAppWithTheAppStoreButton() {
        for extra in [[], Self.ax5] {
            let app = Fixture.launch("update-required", extra: extra)
            let screen = app.descendants(matching: .any)["updateRequired"]
            XCTAssertTrue(screen.waitForExistence(timeout: 20))
            XCTAssertEqual(app.descendants(matching: .any)["updateRequired.message"].label,
                           "Update required. Please update BAB Online in the App Store. You'll stay signed in.")
            let button = app.buttons["updateRequired.appStore"]
            XCTAssertTrue(button.exists)
            XCTAssertEqual(button.label, "Open the App Store")
            if !button.isHittable { app.swipeUp() }
            XCTAssertTrue(button.isHittable, "the App Store button is reachable \(extra)")
            assertInside(app, button, "App Store button")
            shoot(extra.isEmpty ? "update-required" : "update-required-ax5")
            app.terminate()
        }
    }
}
