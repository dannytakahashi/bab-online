import XCTest

/// Who watches which hand (the over-the-shoulder view's transparency, docs/claude/spectators.md
/// "Who watches which hand"), in fixture mode: `-uiWatchers <seat>:<count>[,...]`
/// (Debug/UIFixture+Watchers.swift) sends the wide spectatorsUpdated. The seat eye on another seat
/// and on mine, its VoiceOver words, the badge list's "watching <player>" rows, a spectator's
/// table, and nothing at all with today's list (no `shoulder`). `TEST_RUNNER_BAB_SHOTS=<folder>`
/// saves PNGs (watch-*.png).
final class SeatWatchUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id]
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let png = app.screenshot()
        let a = XCTAttachment(screenshot: png)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("watch-\(name).png"))
        }
    }

    private func launch(_ fixture: String, _ extra: [String]) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: extra)
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        return app
    }

    /// The eye on the screen, clear of the seat's other drawn parts that VoiceOver names (the
    /// dealer marker, the card backs, the bid bubbles) and of the corner buttons.
    private func assertClear(_ app: XCUIApplication, _ eye: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        let f = eye.frame
        XCTAssertTrue(app.windows.firstMatch.frame.contains(f), "\(f) on screen", file: file, line: line)
        XCTAssertGreaterThan(f.width, 10, file: file, line: line)
        var others: [(String, CGRect)] = []
        let dealer = element(app, "dealer")
        if dealer.exists { others.append(("dealer", dealer.frame)) }
        for p in 1...4 where element(app, "fan.\(p)").exists { others.append(("fan.\(p)", element(app, "fan.\(p)").frame)) }
        let bids = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Bid '"))
        for i in 0..<bids.count { others.append(("bubble \(bids.element(boundBy: i).label)", bids.element(boundBy: i).frame)) }
        for id in ["leave", "log", "table.spectators"] where element(app, id).exists { others.append((id, element(app, id).frame)) }
        for (what, o) in others where o.width > 0 {
            XCTAssertFalse(o.insetBy(dx: 0.5, dy: 0.5).intersects(f), "the eye \(f) is over \(what) \(o)", file: file, line: line)
        }
    }

    func testAWatchedSeatShowsTheEyeAndSaysWho() {
        // hal (seat 3, my partner) dealt, so his dealer marker is beside the eye
        let app = launch("trick-mid-lead3", ["-uiWatchers", "3:1", "-uiDealer", "3"])
        let eye = element(app, "watch.3")
        XCTAssertTrue(eye.waitForExistence(timeout: 5))
        XCTAssertEqual(eye.label, "zach is watching hal's hand")
        XCTAssertFalse(element(app, "watch.1").exists)
        XCTAssertFalse(element(app, "watch.2").exists)
        assertClear(app, eye)
        shot(app, "seat-1")
        app.terminate()

        let two = launch("trick-mid-lead3", ["-uiWatchers", "3:2", "-uiDealer", "3"])
        let eye2 = element(two, "watch.3")
        XCTAssertTrue(eye2.waitForExistence(timeout: 5))
        XCTAssertEqual(eye2.label, "zach and yan are watching hal's hand")
        assertClear(two, eye2)
        shot(two, "seat-2")
        two.terminate()
    }

    func testMyWatchedHandShowsTheEyeByMyHand() {
        // the fixture's own deal is mine: my dealer marker is at my hand's left end
        let app = launch("trick-mid-lead3", ["-uiWatchers", "1:1"])
        let eye = element(app, "watch.1")
        XCTAssertTrue(eye.waitForExistence(timeout: 5))
        XCTAssertEqual(eye.label, "zach is watching your hand")
        assertClear(app, eye)
        shot(app, "mine-1")
        app.terminate()

        let two = launch("trick-mid-lead3", ["-uiWatchers", "1:2,2:1"])
        let eye2 = element(two, "watch.1")
        XCTAssertTrue(eye2.waitForExistence(timeout: 5))
        XCTAssertEqual(eye2.label, "zach and yan are watching your hand")
        XCTAssertEqual(element(two, "watch.2").label, "xena is watching kim's hand")
        assertClear(two, eye2)
        assertClear(two, element(two, "watch.2"))
        shot(two, "mine-2")
        two.terminate()
    }

    func testTheBadgesListSaysWhoWatchesWhom() {
        let app = launch("trick-mid-lead3", ["-uiWatchers", "3:1,1:1,0:1"])
        let badge = element(app, "table.spectators")
        XCTAssertTrue(badge.waitForExistence(timeout: 5))
        XCTAssertEqual(badge.label, "3 people watching")
        badge.tap()
        XCTAssertTrue(app.staticTexts["zach · watching hal"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["yan · watching ivy"].exists)
        XCTAssertTrue(app.staticTexts["xena"].exists, "a plain spectator's row is just the name")
        for label in ["zach · watching hal", "yan · watching ivy", "xena"] {
            XCTAssertFalse(label.lowercased().contains("team"))
        }
        shot(app, "list")
        app.terminate()
    }

    func testWithTodaysListNothingChanges() {
        let app = launch("trick-mid-lead3", ["-uiWatchers", "0:2"])
        let badge = element(app, "table.spectators")
        XCTAssertTrue(badge.waitForExistence(timeout: 5))
        XCTAssertEqual(badge.label, "2 people watching")
        for p in 1...4 { XCTAssertFalse(element(app, "watch.\(p)").exists, "seat \(p)") }
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        badge.tap()
        XCTAssertTrue(app.staticTexts["zach"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["yan"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'watching '")).count, 0)
        app.terminate()
    }

    func testASpectatorSeesWhoWatchesEachHand() {
        let app = launch("spectator-mid-hand", ["-uiWatchers", "2:1,4:2"])
        let kim = element(app, "watch.2"), jon = element(app, "watch.4")
        XCTAssertTrue(kim.waitForExistence(timeout: 5))
        XCTAssertEqual(kim.label, "zach is watching kim's hand")
        XCTAssertEqual(jon.label, "yan and xena are watching jon's hand")
        assertClear(app, kim)
        assertClear(app, jon)
        shot(app, "spectator")
        app.terminate()
    }

    func testOnTheBidTheEyeKeepsOffTheBidBubbles() {
        // bidding-mid: max (2) bid B and pat (3) bid 1, ned (4) is me
        let app = launch("bidding-mid", ["-uiWatchers", "2:2,3:1,4:1"])
        for p in [2, 3] {
            let eye = element(app, "watch.\(p)")
            XCTAssertTrue(eye.waitForExistence(timeout: 5), "seat \(p)")
            assertClear(app, eye)
        }
        XCTAssertEqual(element(app, "watch.4").label, "wes is watching your hand")
        shot(app, "bidding")
        app.terminate()
    }
}
