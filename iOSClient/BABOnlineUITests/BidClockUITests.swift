import XCTest

/// The bidder's bid clock countdown (owner 2026-11-18), in fixture mode: `-uiBidClock <s>`
/// runs the clock for the seat on turn with the countdown held at that many seconds. The pill
/// sits on the bid panel's top edge at its trailing corner and moves nothing: the panel and
/// every button keep their frames, it touches no button, chip, HSI, opponent seat, bid
/// bubble, card back or fold (probe "table.bidClock"). Run on 375 pt, 390 pt, an iPad and
/// the Duo (and `-uiFold book|tabletop`).
final class BidClockUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// The bid panel's controls: every grid cell, the bores, Submit, the chip row and HSI.
    private func controls(_ app: XCUIApplication) -> [String: CGRect] {
        var out: [String: CGRect] = [:]
        let panel = element(app, "bidOverlay")
        for b in panel.buttons.allElementsBoundByIndex where b.exists { out["button \(b.label)"] = b.frame }
        for id in ["bidChips", "bidOverlay.hsi"] where element(app, id).exists { out[id] = element(app, id).frame }
        out["panel"] = panel.frame
        return out
    }

    private func launchTable(_ extra: [String]) -> XCUIApplication {
        let app = Fixture.launch("bidding-mid", extra: extra)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        XCTAssertTrue(element(app, "bidOverlay").waitForExistence(timeout: 5))
        _ = Fixture.settledState(app)
        return app
    }

    // MARK: - On the panel's edge, nothing moved, nothing covered

    func testTheBidderSeesTheCountdownOnThePanelsEdge() {
        // the panel without a clock: its frames are the reference
        let plain = launchTable([])
        XCTAssertFalse(element(plain, "bidClock").exists)
        let before = controls(plain)
        plain.terminate()

        for fold in [nil, "book", "tabletop"] as [String?] {
            let tag = fold ?? "flat"
            let app = launchTable(["-uiBidClock", "27"] + (fold.map { ["-uiFold", $0] } ?? []))
            let pill = element(app, "bidClock")
            XCTAssertTrue(pill.waitForExistence(timeout: 5), tag)
            XCTAssertEqual(pill.value as? String, "27", tag)
            XCTAssertEqual(pill.label, "Time to bid: 27 seconds", tag)
            let after = controls(app)
            let p = pill.frame
            // the panel's own box (its accessibility container grows to take the pill in)
            let panel = fold == nil ? before["panel"]! : after["panel"]!.divided(atDistance: p.height - 1, from: .minYEdge).remainder
            if fold == nil {
                // nothing moved or resized for it
                XCTAssertEqual(Set(after.keys), Set(before.keys))
                for (k, r) in before where k != "panel" { XCTAssertEqual(after[k], r, "\(k) moved") }
                XCTAssertEqual(after["panel"]!.maxY, panel.maxY, accuracy: 0.5)
                XCTAssertEqual(after["panel"]!.width, panel.width, accuracy: 0.5)
            }
            // on the panel's top edge, at its trailing corner, inside the window
            XCTAssertEqual(p.maxY, panel.minY + 1, accuracy: 1, "\(tag): \(p) on \(panel)")
            XCTAssertLessThanOrEqual(p.maxX, panel.maxX, tag)
            XCTAssertGreaterThan(p.midX, panel.midX, "\(tag): the trailing half")
            XCTAssertTrue(app.windows.firstMatch.frame.contains(p), "\(tag): \(p)")
            XCTAssertLessThanOrEqual(p.height, 30, tag)
            // it touches no control, chip or HSI
            for (k, r) in after where k != "panel" {
                XCTAssertFalse(r.intersects(p), "\(tag): the countdown \(p) over \(k) \(r)")
            }
            // nor an opponent's seat, bid bubble or card backs, nor the fold (in-app probe)
            let probe = Fixture.probe(app, "table.bidClock")
            XCTAssertTrue(probe.contains("seats=ok"), "\(tag): \(probe) [\(Fixture.probe(app, "ui.pose"))]")
            XCTAssertFalse(probe.contains("fold=over"), "\(tag): \(probe)")
            // (fold=-: the layout ignores a fold it has no room for, as on a phone's book split)
            print("[BidClockUITests] \(tag) \(probe) [\(Fixture.probe(app, "ui.pose"))]")
            // the probe's frame is the element's (the same pane coordinates on this window)
            let parts = probe.split(separator: " ").prefix(4).compactMap { Double($0) }
            XCTAssertEqual(parts.count, 4, probe)
            if parts.count == 4 { XCTAssertEqual(CGFloat(parts[2]), p.width, accuracy: 1, probe) }
            attach(app, "bid-clock-27-\(tag)")
            app.terminate()
        }
    }

    func testTheLastTenSecondsShowInTheWarningColour() {
        let app = launchTable(["-uiBidClock", "8"])
        let pill = element(app, "bidClock")
        XCTAssertTrue(pill.waitForExistence(timeout: 5))
        XCTAssertEqual(pill.value as? String, "8 low")
        XCTAssertEqual(pill.label, "Time to bid: 8 seconds")
        XCTAssertTrue(Fixture.probe(app, "table.bidClock").contains("seats=ok"))
        attach(app, "bid-clock-8")
        app.terminate()
    }

    // MARK: - Only the bidder

    func testNoCountdownForAnotherSeatsClock() {
        // my bid panel is up, but the clock is another seat's
        let app = launchTable(["-uiBidClock", "27", "-uiBidClockSeat", "2"])
        XCTAssertFalse(element(app, "bidClock").waitForExistence(timeout: 2))
        XCTAssertEqual(Fixture.probe(app, "table.bidClock"), "-")
        app.terminate()
        // a seat waiting while another seat's clock runs (the server's own capture): no panel, no countdown
        let other = Fixture.launch("bid-clock-running")
        XCTAssertTrue(other.buttons["leave"].waitForExistence(timeout: 20))
        XCTAssertFalse(element(other, "bidOverlay").exists)
        XCTAssertFalse(element(other, "bidClock").exists)
        other.terminate()
    }

    // MARK: - At zero

    func testAtZeroTheBidButtonsWaitForTheServersBidThenReopen() {
        // 9 s, running down: at 0 the number goes and the buttons refuse; with no bid 0 from the
        // server (fixture mode has none) bidding opens again after the grace (5 s)
        let app = Fixture.launch("bidding-mid", extra: ["-uiBidClock", "9", "-uiBidClockLive", "YES"])
        let pill = element(app, "bidClock")
        XCTAssertTrue(pill.waitForExistence(timeout: 8), "seen before it runs out")
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: pill)
        wait(for: [gone], timeout: 12)
        let one = app.buttons["1"], submit = app.buttons["Submit"]
        XCTAssertTrue(one.exists && submit.exists)
        XCTAssertFalse(one.isEnabled, "expired: the cells refuse")
        XCTAssertFalse(submit.isEnabled)
        attach(app, "bid-clock-expired")
        // the grace (5 s) runs out: the buttons work again
        let open = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: one)
        wait(for: [open], timeout: 10)
        one.tap()
        XCTAssertTrue(submit.isEnabled)
        XCTAssertFalse(pill.exists)
        app.terminate()
    }
}
