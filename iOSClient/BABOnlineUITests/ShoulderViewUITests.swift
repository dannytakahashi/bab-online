import XCTest

/// The over-the-shoulder view in fixture mode (UIFixture+Shoulder answers watchHand as the
/// server does; State/Table/Shoulder.swift): the default watch, switching seats by an avatar tap,
/// Table view, the read-only hand, the watched seat's bid clock and mirrored cards, the paused
/// rule, refusals, the own-seat rule, a tournament table, the voice ring, nothing to act on.
/// Run on the iPhone 18 Pro, 17e, iPad Air and the iPhone Duo (closed and book pose: set the
/// posture before the run). `TEST_RUNNER_BAB_SHOTS=<folder>` (+ `TEST_RUNNER_BAB_DEVICE=<tag>`)
/// saves PNGs.
final class ShoulderViewUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let png = app.screenshot()
        let a = XCTAttachment(screenshot: png)
        a.name = "shoulder-\(name)"
        a.lifetime = .keepAlways
        add(a)
        let env = ProcessInfo.processInfo.environment
        if let dir = env["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            let device = env["BAB_DEVICE"] ?? "device"
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(device)-shoulder-\(name).png"))
        }
    }

    private func launch(_ extra: [String]) -> XCUIApplication { launch("spectator-mid-hand", extra) }

    private func launch(_ fixture: String, _ extra: [String]) -> XCUIApplication {
        let app = Fixture.launch(fixture, extra: extra)
        XCTAssertTrue(Fixture.readyElement(app, fixture).waitForExistence(timeout: 15))
        return app
    }

    private var any: (XCUIApplication, String) -> XCUIElement { { app, id in app.descendants(matching: .any)[id] } }

    /// Waits until the probe's value satisfies `ok`, returning the last value.
    @discardableResult
    private func waitProbe(_ app: XCUIApplication, _ id: String, timeout: TimeInterval = 8, _ ok: (String) -> Bool) -> String {
        let deadline = Date().addingTimeInterval(timeout)
        var v = Fixture.probe(app, id)
        while !ok(v) && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            v = Fixture.probe(app, id)
        }
        return v
    }

    private func pill(_ app: XCUIApplication) -> XCUIElement { app.buttons["shoulder.pill"] }

    private func waitPill(_ app: XCUIApplication, _ label: String, timeout: TimeInterval = 8) {
        let p = pill(app)
        XCTAssertTrue(p.waitForExistence(timeout: timeout), "the watching pill")
        let deadline = Date().addingTimeInterval(timeout)
        while p.label != label && Date() < deadline { Thread.sleep(forTimeInterval: 0.25) }
        XCTAssertEqual(p.label, label, "\(Fixture.probe(app, "table.shoulder")) sent \(sent(app))")
    }

    /// A seat avatar's centre from "table.shoulder" ("seats=1:x,y;2:x,y").
    private func seatPoint(_ app: XCUIApplication, _ pos: Int) -> CGVector? {
        let v = Fixture.probe(app, "table.shoulder")
        guard let seats = v.components(separatedBy: "seats=").last else { return nil }
        for part in seats.split(separator: ";") {
            let kv = part.split(separator: ":")
            guard kv.count == 2, Int(kv[0]) == pos else { continue }
            let xy = kv[1].split(separator: ",").compactMap { Double($0) }
            if xy.count == 2 { return CGVector(dx: xy[0], dy: xy[1]) }
        }
        return nil
    }

    /// Taps seat `pos`'s avatar: its name label (the scene's element; XCUITest maps an element's
    /// frame in every orientation, the Duo's inner screen included), else the probe's point.
    private func tapSeat(_ app: XCUIApplication, _ pos: Int, name: String) {
        guard let p = seatPoint(app, pos) else { return XCTFail("no seat \(pos) in \(Fixture.probe(app, "table.shoulder"))") }
        // (the seat's name is the only element read exactly as the name: the pill, the score bar and
        // the log say more)
        let label = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).allElementsBoundByIndex
            .first { $0.isHittable }
        if let label {
            label.tap()
        } else {
            // from the window, not the app: on the iPhone Duo's inner screen the app's frame is the
            // portrait one while the window is landscape (book pose)
            app.windows.firstMatch.coordinate(withNormalizedOffset: .zero).withOffset(p).tap()
        }
    }

    private func sent(_ app: XCUIApplication) -> [String] {
        Fixture.probe(app, "fixture.sent").split(separator: "|").map(String.init)
    }

    /// Nothing that acts: no bid panel, no lightbulb, no tutorial switch (the corner's or the
    /// Duo's vertical bar item), and no bid, play or chat line went out.
    private func assertNothingToActOn(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(any(app, "bidOverlay").exists, "no bid sheet for a watcher", file: file, line: line)
        XCTAssertFalse(app.buttons["assist.ask"].exists, "no lightbulb", file: file, line: line)
        XCTAssertFalse(any(app, "tutorial.chip").exists, "no tutorial switch", file: file, line: line)
        XCTAssertTrue(sent(app).allSatisfy { $0.hasPrefix("watchHand:") || $0 == "-" }, "only watchHand: \(sent(app))", file: file, line: line)
    }

    // MARK: - The default watch, switching, Table view

    func testTheDefaultWatchSwitchingAndTableView() {
        let app = launch(["-uiShoulder", "auto"])
        waitPill(app, "Watching ivy's hand")
        XCTAssertTrue(app.buttons["shoulder.tableView"].exists)
        XCTAssertEqual(app.buttons["shoulder.tableView"].label, "Table view")
        var probe = waitProbe(app, "table.shoulder") { $0.hasPrefix("watch=1 ") && $0.contains("hand=12") }
        XCTAssertTrue(probe.contains("readOnly=1"), probe)
        XCTAssertEqual(sent(app).first, "watchHand:1")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        assertNothingToActOn(app)
        XCTAssertTrue(Fixture.settledState(app).hasPrefix("lifted=- hand=12 "), Fixture.probe(app, "table.state"))
        shot(app, "default-watch")

        // an avatar tap switches seats
        tapSeat(app, 3, name: "hal")
        waitPill(app, "Watching hal's hand")
        probe = waitProbe(app, "table.shoulder") { $0.hasPrefix("watch=3 ") }
        XCTAssertTrue(probe.contains("hand=11"), probe)
        XCTAssertTrue(sent(app).contains("watchHand:3"))
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        shot(app, "switched-seat")

        // Table view: the plain spectator view at once, a stop sent
        app.buttons["shoulder.tableView"].tap()
        XCTAssertTrue(app.staticTexts["Spectating"].waitForExistence(timeout: 5))
        XCTAssertFalse(pill(app).exists)
        probe = waitProbe(app, "table.shoulder") { $0.hasPrefix("watch=- ") }
        XCTAssertTrue(probe.contains("hand=-1"), "no hand: \(probe)")
        XCTAssertEqual(sent(app).last, "watchHand:null")
        shot(app, "table-view")
        // a tap on an avatar watches again (seat 1 sits at the bottom of the plain view)
        tapSeat(app, 2, name: "kim")
        waitPill(app, "Watching kim's hand")
    }

    /// The person's own pick and Table view are remembered for the game (`-uiShoulder <seat>|table`).
    func testAPickAndTableViewAtTheStart() {
        var app = launch(["-uiShoulder", "4"])
        waitPill(app, "Watching jon's hand")
        XCTAssertEqual(Array(sent(app).prefix(2)), ["watchHand:1", "watchHand:4"])
        app.terminate()
        app = launch(["-uiShoulder", "table"])
        XCTAssertTrue(app.staticTexts["Spectating"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(pill(app).exists, "Table view wins over the default")
        XCTAssertEqual(sent(app).last, "watchHand:null")
    }

    // MARK: - The bid clock and the mirrored cards

    func testTheWatchedSeatsReadOnlyBidSheetClockAndMirroredCards() {
        let app = launch("bidding-mid", ["-uiAsSpectator", "YES", "-uiShoulder", "4", "-uiShoulderHint", "YES",
                                         "-uiBidClock", "23", "-uiBidClockSeat", "4"])
        waitPill(app, "Watching ned's hand")
        // the watched seat's bid turn mirrored read-only where a seat's bid panel goes: one
        // static element (no buttons for VoiceOver), its choices, the advice's ring, its clock
        let sheet = any(app, "bidOverlay.watched")
        XCTAssertTrue(sheet.waitForExistence(timeout: 8), "the read-only bid sheet")
        XCTAssertEqual(sheet.label, "ned is bidding")
        let value = sheet.value as? String ?? ""
        XCTAssertTrue(value.hasPrefix("Choices: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 2B"), value)
        XCTAssertTrue(value.contains("Suggested: 2"), value)
        XCTAssertTrue(value.contains("23 seconds left"), value)
        // (XCUITest's tree still lists the cells under the one VoiceOver element: every one disabled)
        let cells = sheet.buttons.allElementsBoundByIndex
        XCTAssertEqual(cells.count, 14, "0...12 and 2B")
        XCTAssertTrue(cells.allSatisfy { !$0.isEnabled }, "no cell can be activated")
        XCTAssertFalse(app.buttons["Submit"].exists, "no Submit")
        XCTAssertTrue(any(app, "assistCard").waitForExistence(timeout: 8), "the watched seat's advice")
        XCTAssertTrue(any(app, "tutorialTip").exists, "the watched seat's tip")
        XCTAssertTrue(app.staticTexts["Bid 2"].exists)
        // (the column scrolls when short: its headline is kept in sight, above the sheet and its clock)
        XCTAssertLessThanOrEqual(any(app, "assist.headline").frame.maxY, sheet.frame.minY + 1, "the advice sits above the sheet")
        let clockProbe = waitProbe(app, "table.bidClock") { $0 != "-" }
        XCTAssertTrue(clockProbe.contains("seats=ok"), "the clock keeps off the seats: \(clockProbe)")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        assertNothingToActOn(app)
        shot(app, "advice-card")
        // taps all over the sheet (every bid cell, the bores, where Submit would be): nothing
        // is selected and nothing is sent
        let before = sent(app)
        let f = sheet.frame
        let origin = app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
        var y = f.minY + 30
        while y < f.maxY - 4 {
            var x = f.minX + 22
            while x < f.maxX - 4 {
                origin.withOffset(CGVector(dx: x, dy: y)).tap()
                x += 44
            }
            y += 40
        }
        XCTAssertEqual(sent(app), before, "no bid, no chat, no watch")
        XCTAssertTrue(sheet.exists)
        XCTAssertEqual(pill(app).label, "Watching ned's hand", "no seat under the sheet was tapped")
        // the advice's close is local: nothing is sent
        if any(app, "assistCard").exists {
            any(app, "assistCard").buttons["assist.close"].tap()
            XCTAssertFalse(any(app, "assistCard").waitForExistence(timeout: 1))
        }
        XCTAssertEqual(sent(app), before)
    }

    // MARK: - The paused rule

    func testThePausedTableKeepsTheSeatAndComesBack() {
        let app = launch(["-uiShoulder", "auto", "-uiShoulderPause", "5", "-uiShoulderResume", "6"])
        waitPill(app, "Watching ivy's hand")
        waitPill(app, "Watching ivy's hand \u{00B7} paused", timeout: 12)
        XCTAssertTrue(any(app, "shoulder.paused").exists)
        let probe = waitProbe(app, "table.shoulder") { $0.contains("paused=1") }
        XCTAssertTrue(probe.contains("hand=0"), "no stale cards: \(probe)")
        shot(app, "paused")
        // "Game resumed.": the watch is sent again and the hand comes back
        waitPill(app, "Watching ivy's hand", timeout: 15)
        XCTAssertTrue(waitProbe(app, "table.shoulder") { $0.contains("paused=0") && $0.contains("hand=12") }.contains("hand=12"))
        XCTAssertGreaterThanOrEqual(sent(app).filter { $0 == "watchHand:1" }.count, 2)
    }

    func testAnUnavailableRefusalPausesUntilTheResume() {
        let app = launch(["-uiShoulder", "auto", "-uiShoulderRefuse", "unavailable", "-uiShoulderResume", "10"])
        waitPill(app, "Watching ivy's hand \u{00B7} paused")
        waitPill(app, "Watching ivy's hand", timeout: 15)
    }

    // MARK: - Refusals and the fairness rules

    func testTheOwnSeatRefusalSwitchesToTheOwnSeat() {
        let app = launch(["-uiShoulder", "auto", "-uiShoulderRefuse", "own_seat:3"])
        waitPill(app, "Watching hal's hand")
        XCTAssertEqual(Array(sent(app).prefix(2)), ["watchHand:1", "watchHand:3"])
    }

    func testTheOwnSeatRuleOffersOnlyThatSeat() {
        // kim (seat 2) on another device
        let app = launch(["-uiShoulder", "auto", "-uiSpectatorName", "kim"])
        waitPill(app, "Watching kim's hand")
        tapSeat(app, 3, name: "hal")
        Thread.sleep(forTimeInterval: 1)
        XCTAssertFalse(sent(app).contains("watchHand:3"), "never another seat: \(sent(app))")
        XCTAssertEqual(pill(app).label, "Watching kim's hand")
    }

    func testATournamentTableHasNoShoulderView() {
        let app = launch("tournament-game", ["-uiAsSpectator", "YES", "-uiShoulder", "auto"])
        XCTAssertTrue(app.staticTexts["Spectating"].waitForExistence(timeout: 8))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(pill(app).exists)
        XCTAssertFalse(sent(app).contains { $0.hasPrefix("watchHand:") }, "nothing sent: \(sent(app))")
        XCTAssertTrue(Fixture.probe(app, "table.shoulder").hasPrefix("watch=- "))
    }

    func testATournamentRefusalDropsTheView() {
        let app = launch(["-uiShoulder", "auto", "-uiShoulderRefuse", "tournament"])
        XCTAssertTrue(app.staticTexts["Spectating"].waitForExistence(timeout: 8))
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertFalse(pill(app).exists)
    }

    // MARK: - Voice: the watcher's own mic above the eye, the watched player's ring

    /// "x,y,w,h" after `key=` in "table.shoulder".
    private func probeRect(_ app: XCUIApplication, _ key: String) -> CGRect? {
        let v = Fixture.probe(app, "table.shoulder")
        guard let part = v.split(separator: " ").first(where: { $0.hasPrefix("\(key)=") }) else { return nil }
        let n = part.dropFirst(key.count + 1).split(separator: ",").compactMap { Double($0) }
        return n.count == 4 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
    }

    /// The watcher's own mic (owner 2026-11-21: "above the eye", never in the watched seat's
    /// row, which shows only that player): one mic, clear of the row, the eye, the hand's area
    /// and the pill.
    private func assertWatcherMic(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let mic = app.buttons["Unmute microphone"]
        XCTAssertTrue(mic.waitForExistence(timeout: 5), "the watcher's own mic", file: file, line: line)
        XCTAssertEqual(app.buttons.matching(identifier: "Unmute microphone").count, 1, "one mic, not the pill's too", file: file, line: line)
        let row = probeRect(app, "row"), badge = probeRect(app, "badge")
        if let row { XCTAssertFalse(mic.frame.insetBy(dx: 1, dy: 1).intersects(row), "not in the watched seat's row: \(mic.frame) \(row)", file: file, line: line) }
        if let badge {
            XCTAssertFalse(mic.frame.insetBy(dx: 1, dy: 1).intersects(badge), "not on the eye", file: file, line: line)
            XCTAssertTrue(mic.frame.maxY <= badge.minY + 1 || mic.frame.maxX <= badge.minX + 1,
                          "above the eye (else beside it): \(mic.frame) \(badge)", file: file, line: line)
        }
        XCTAssertLessThan(mic.frame.maxY, pill(app).frame.minY, "not beside the pill", file: file, line: line)
        return mic
    }

    func testTheWatchersMicIsAboveTheEyeAndTheWatchedPlayerTalks() {
        let app = launch(["-uiShoulder", "auto", "-uiSpectatorVoice", "muted", "-uiShoulderSpeaking", "YES"])
        waitPill(app, "Watching ivy's hand")
        _ = assertWatcherMic(app)
        XCTAssertTrue(app.buttons["table.spectators"].exists, "the eye")
        XCTAssertEqual(pill(app).value as? String, "Talking, Their turn", "the watched player's speaking ring (ivy is on turn)")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        shot(app, "voice")
        // on the watched seat's bid turn too, clear of the read-only sheet
        app.terminate()
        let bidding = launch("bidding-mid", ["-uiAsSpectator", "YES", "-uiShoulder", "4", "-uiSpectatorVoice", "muted",
                                             "-uiShoulderHint", "YES"])
        waitPill(bidding, "Watching ned's hand")
        let sheet = any(bidding, "bidOverlay.watched")
        XCTAssertTrue(sheet.waitForExistence(timeout: 8))
        let mic = assertWatcherMic(bidding)
        XCTAssertFalse(mic.frame.insetBy(dx: 1, dy: 1).intersects(sheet.frame), "not under the read-only sheet: \(mic.frame) \(sheet.frame)")
        if any(bidding, "assist.headline").exists {
            XCTAssertFalse(mic.frame.insetBy(dx: 1, dy: 1).intersects(any(bidding, "assist.headline").frame), "not under the advice")
        }
        shot(bidding, "voice-bidding")
    }

    // MARK: - A seat's screen is unchanged

    func testASeatedPlayersTableIsUnchanged() {
        let app = launch("bidding-mid", ["-uiShoulder", "auto"])
        XCTAssertTrue(any(app, "bidOverlay").waitForExistence(timeout: 8) || app.buttons["2"].exists, "my bid sheet")
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertFalse(pill(app).exists)
        XCTAssertFalse(sent(app).contains { $0.hasPrefix("watchHand:") })
        XCTAssertTrue(Fixture.probe(app, "table.shoulder").contains("readOnly=0"))
    }
}
