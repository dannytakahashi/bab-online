import XCTest

/// The corner buttons (Exit, the game log) when the deal ends the draw. Carried by the phase
/// change's 0.3 s animation, they faded in about 60 pt below their table spot (the log button
/// over the right seat's card backs) and slid up, although no layout pass ever placed them
/// there (live on an iPhone 17, 2026-11-16; GameContainerView `cornerButtons`). The
/// `draw-deal` fixture shows the draw and, 6 s after launch, the table in BIDDING; the test
/// samples the buttons' frames (XCUITest reads them mid-animation) from before the deal until
/// they settle: every sample must be either the draw's spot or the table's, nothing between
/// or below. The table is found by the score bar's names (`scoreBar.teamNames`: the players'
/// names since owner 2026-11-17, no longer the "Your Team" text).
final class TableChromeAnimationTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testCornerButtonsTakeTheirTableSpotAtOnce() throws {
        let app = Fixture.launch("draw-deal")
        XCTAssertTrue(app.staticTexts["Draw for Deal"].waitForExistence(timeout: 20), "the draw did not come up")
        let leave = app.buttons["leave"], log = app.buttons["log"]
        XCTAssertTrue(leave.waitForExistence(timeout: 5))
        let names = app.staticTexts["scoreBar.teamNames"]
        XCTAssertFalse(names.exists, "the deal came before the test could watch it")
        if !log.exists { throw XCTSkip("no corner log button on this device (the vertical bar or a docked log)") }
        let drawSpot = (leave: leave.frame.minY, log: log.frame.minY)
        var samples: [(t: TimeInterval, leave: CGFloat, log: CGFloat, table: Bool)] = []
        let t0 = Date()
        var settledAt: Date?
        while Date().timeIntervalSince(t0) < 12 {
            let table = names.exists
            samples.append((Date().timeIntervalSince(t0), leave.frame.minY, log.frame.minY, table))
            if table, settledAt == nil { settledAt = Date() }
            if let s = settledAt, Date().timeIntervalSince(s) > 1.5 { break }
        }
        XCTAssertNotNil(settledAt, "the table never came: \(samples.count) samples")
        guard let last = samples.last else { return }
        // the table spot: just under the score bar
        let bar = names.frame
        // the bar names the players, read with its side first (never the old placeholder)
        XCTAssertTrue(names.label.hasPrefix("Your team, "), "score bar names: \(names.label)")
        XCTAssertTrue(app.staticTexts["scoreBar.oppNames"].label.hasPrefix("Opponents, "), "score bar names: \(app.staticTexts["scoreBar.oppNames"].label)")
        XCTAssertFalse(app.staticTexts["Your Team"].exists, "the old placeholder in the score bar")
        XCTAssertLessThan(abs(last.leave - last.log), 1, "Exit and the log button share a top: \(last)")
        XCTAssertGreaterThan(last.leave, bar.maxY, "under the score bar: \(last) bar \(bar)")
        XCTAssertLessThan(last.leave - bar.minY, 90, "right under the score bar: \(last) bar \(bar)")
        let text = samples.map { String(format: "%.2fs %.1f/%.1f%@", $0.t, $0.leave, $0.log, $0.table ? " table" : "") }.joined(separator: ", ")
        print("[chrome] draw \(drawSpot) samples: \(text)")
        let a = XCTAttachment(string: text)
        a.name = "corner-samples"
        a.lifetime = .keepAlways
        add(a)
        for s in samples {
            for (name, y, from) in [("Exit", s.leave, drawSpot.leave), ("log", s.log, drawSpot.log)] {
                let atDraw = abs(y - from) < 1, atTable = abs(y - (name == "Exit" ? last.leave : last.log)) < 1
                XCTAssertTrue(atDraw || atTable, "\(name) passed through \(y) at \(String(format: "%.2f", s.t)) s (draw \(from), table \(name == "Exit" ? last.leave : last.log)): \(text)")
            }
        }
    }
}
