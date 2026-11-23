import XCTest

/// The avatar badges (State/Table/SeatBadges.swift; `-uiSeatBadges`, UIFixture+SeatBadges.swift):
/// the snapshot's lightbulb and graduation cap at launch, a live /help notice's lightbulb popping
/// in 2 s later; each clear of the table ("table.badges" clear=ok), inside the window, never on my
/// own seat, and spoken on the seat's name ("kim, asked for help this turn", "hal, tutorial on");
/// a watcher's watched seat has its on the watching pill's avatar ("table.shoulderBadge").
/// Runs on any device (the closed Duo, the iPad: whatever pose it is in).
final class SeatBadgesUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    private func note(_ name: String, _ text: String) {
        let a = XCTAttachment(string: text)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// "2:bulb 120.0 300.0 16.0 16.0 clear=ok;3:-;4:cap ... pops=1 pop=scale" -> per seat (kind, frame, clear).
    private func seats(_ probe: String) -> [Int: (kind: String, frame: CGRect?, clear: String?)] {
        let body = probe.components(separatedBy: " pops=").first ?? probe
        var out: [Int: (String, CGRect?, String?)] = [:]
        for item in body.split(separator: ";") {
            let parts = item.split(separator: " ").map(String.init)
            let head = parts.first?.split(separator: ":").map(String.init) ?? []
            guard head.count == 2, let pos = Int(head[0]) else { continue }
            var frame: CGRect?
            if parts.count >= 6, let x = Double(parts[1]), let y = Double(parts[2]), let w = Double(parts[3]), let h = Double(parts[4]) {
                frame = CGRect(x: x, y: y, width: w, height: h)
            }
            out[pos] = (head[1], frame, parts.last?.hasPrefix("clear=") == true ? String(parts.last!.dropFirst(6)) : nil)
        }
        return out
    }

    /// Waits for "table.badges" to say `pops` lightbulb pops.
    private func waitForPops(_ app: XCUIApplication, _ n: Int, timeout: TimeInterval = 10) -> String {
        let deadline = Date().addingTimeInterval(timeout)
        var last = Fixture.probe(app, "table.badges")
        while !last.contains("pops=\(n) ") && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.3)
            last = Fixture.probe(app, "table.badges")
        }
        return last
    }

    private func spoken(_ app: XCUIApplication, _ label: String) -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).count > 0
    }

    private func checkInWindow(_ app: XCUIApplication, _ frame: CGRect?, _ tag: String) {
        guard let f = frame, let window = Fixture.windowSize(Fixture.probe(app, "ui.pose")) else { return XCTFail("\(tag): no frame") }
        XCTAssertTrue(CGRect(origin: .zero, size: window).contains(f), "\(tag): \(f) inside the window \(window)")
        XCTAssertEqual(f.width, f.height, accuracy: 0.5, "\(tag): round")
    }

    func testSeatedBadgesAreClearAndSpoken() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiSeatBadges", "bulb:2,cap:3,pop:4,bulb:1", "-uiDealer", "2"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        shot("badges-seated-launch")
        _ = waitForPops(app, 1)
        // the snapshot's lightbulb (seat 2) never popped: one pop in all, the live one's
        Thread.sleep(forTimeInterval: 1)
        let probe = Fixture.probe(app, "table.badges")
        note("badges-after-pop", probe)
        let s = seats(probe)
        XCTAssertEqual(s.keys.sorted(), [2, 3, 4], "my own seat (1) has no avatar, so no badge: \(probe)")
        XCTAssertEqual(s[2]?.kind, "bulb")
        XCTAssertEqual(s[3]?.kind, "cap")
        XCTAssertEqual(s[4]?.kind, "bulb", "the live notice's lightbulb")
        for pos in [2, 3, 4] {
            XCTAssertEqual(s[pos]?.clear, "ok", "seat \(pos): \(probe)")
            checkInWindow(app, s[pos]?.frame, "seat \(pos)")
        }
        XCTAssertTrue(probe.hasSuffix("pops=1 pop=scale"), probe)
        XCTAssertTrue(spoken(app, "kim, asked for help this turn"))
        XCTAssertTrue(spoken(app, "hal, tutorial on"))
        XCTAssertTrue(spoken(app, "jon, asked for help this turn"))
        XCTAssertEqual(Fixture.probe(app, "table.extras").components(separatedBy: "dealer=").last, "2", "kim dealt: its marker and its badge both")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        shot("badges-seated")
    }

    func testASpectatorSeesEverySeatsBadge() {
        let app = Fixture.launch("spectator-mid-hand", extra: ["-uiSeatBadges", "bulb:1,cap:2,cap:3,pop:4"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let probe = waitForPops(app, 1)
        note("badges-spectator", probe)
        let s = seats(probe)
        XCTAssertEqual(s.keys.sorted(), [1, 2, 3, 4])
        XCTAssertEqual([1, 2, 3, 4].map { s[$0]?.kind ?? "?" }, ["bulb", "cap", "cap", "bulb"], probe)
        for pos in 1...4 {
            XCTAssertEqual(s[pos]?.clear, "ok", "seat \(pos): \(probe)")
            checkInWindow(app, s[pos]?.frame, "seat \(pos)")
        }
        XCTAssertTrue(spoken(app, "ivy, asked for help this turn"))
        XCTAssertTrue(spoken(app, "kim, tutorial on"))
        shot("badges-spectator")
    }

    /// "cap chip=x y w h avatar=x y w h text=x y w h pill=x y w h" -> kind and frames.
    private func pillBadge(_ probe: String) -> (kind: String, frames: [String: CGRect]) {
        let parts = probe.split(separator: " ").map(String.init)
        var frames: [String: CGRect] = [:]
        var i = 1
        while i < parts.count {
            let p = parts[i]
            if let eq = p.firstIndex(of: "="), i + 3 < parts.count,
               let x = Double(p[p.index(after: eq)...]), let y = Double(parts[i + 1]), let w = Double(parts[i + 2]), let h = Double(parts[i + 3]) {
                frames[String(p[..<eq])] = CGRect(x: x, y: y, width: w, height: h)
                i += 4
            } else {
                i += 1
            }
        }
        return (parts.first ?? "-", frames)
    }

    /// The watched seat's chip: on the pill's avatar, inside the pill, outside the avatar's rings
    /// (radius 12 + 1.25), off the name.
    private func checkPillChip(_ app: XCUIApplication, _ kind: String, _ value: String, file: StaticString = #filePath, line: UInt = #line) {
        let pill = app.buttons["shoulder.pill"]
        let deadline = Date().addingTimeInterval(8)
        var probe = Fixture.probe(app, "table.shoulderBadge")
        while !probe.hasPrefix(kind + " chip=") && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            probe = Fixture.probe(app, "table.shoulderBadge")
        }
        note("pill-badge-\(kind)", probe)
        let b = pillBadge(probe)
        XCTAssertEqual(b.kind, kind, probe, file: file, line: line)
        guard let chip = b.frames["chip"], let avatar = b.frames["avatar"], let text = b.frames["text"], let box = b.frames["pill"] else {
            return XCTFail("frames: \(probe)", file: file, line: line)
        }
        XCTAssertEqual(chip.width, 12, accuracy: 0.5, "a 12 pt chip", file: file, line: line)
        XCTAssertEqual(chip.width, chip.height, accuracy: 0.5, "round", file: file, line: line)
        XCTAssertTrue(box.insetBy(dx: 1, dy: 1).contains(chip), "inside the pill and its edge: \(chip) \(box)", file: file, line: line)
        let gap = hypot(chip.midX - avatar.midX, chip.midY - avatar.midY) - chip.width / 2 - (avatar.width / 2 + 1.25)
        XCTAssertGreaterThan(gap, 0.25, "outside the turn / speaking ring: \(probe)", file: file, line: line)
        XCTAssertFalse(chip.intersects(text), "off the name: \(chip) \(text)", file: file, line: line)
        XCTAssertGreaterThan(chip.midX, avatar.midX, "the trailing side", file: file, line: line)
        XCTAssertLessThan(chip.midY, avatar.midY, "the upper corner", file: file, line: line)
        XCTAssertTrue((pill.value as? String)?.hasSuffix(value) == true, "the pill says it: \(String(describing: pill.value))", file: file, line: line)
    }

    /// Watching kim's hand (`-uiShoulder 2`): her seat is the bottom hand, with no avatar on the
    /// felt, so her badge is on the watching pill's avatar (and spoken in its value); the other
    /// seats keep theirs on the felt, and Table view gives hers back to her avatar there.
    func testTheWatchedSeatsBadgeIsOnTheWatchingPill() {
        let app = Fixture.launch("spectator-mid-hand", extra: ["-uiShoulder", "2", "-uiSeatBadges", "bulb:1,cap:2,cap:3,pop:4"])
        let pill = app.buttons["shoulder.pill"]
        XCTAssertTrue(pill.waitForExistence(timeout: 20))
        let probe = waitForPops(app, 1)
        note("badges-watching", probe)
        let s = seats(probe)
        XCTAssertEqual(s.keys.sorted(), [1, 3, 4], "kim (2) is the bottom hand: \(probe)")
        XCTAssertEqual([1, 3, 4].map { s[$0]?.kind ?? "?" }, ["bulb", "cap", "bulb"], probe)
        for pos in [1, 3, 4] { XCTAssertEqual(s[pos]?.clear, "ok", "seat \(pos): \(probe)") }
        XCTAssertEqual(pill.label, "Watching kim's hand")
        checkPillChip(app, "cap", "Tutorial on")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        shot("badges-watching-cap")
        // Table view: kim's avatar is back on the felt with its cap; the pill and its chip are gone
        app.buttons["shoulder.tableView"].tap()
        let deadline = Date().addingTimeInterval(8)
        var back = Fixture.probe(app, "table.badges")
        while seats(back)[2]?.kind != "cap" && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            back = Fixture.probe(app, "table.badges")
        }
        XCTAssertEqual(seats(back)[2]?.kind, "cap", back)
        XCTAssertEqual(seats(back)[2]?.clear, "ok", back)
        XCTAssertEqual(Fixture.probe(app, "table.shoulderBadge"), "-")
        app.terminate()

        // the lightbulb on the watched seat (ivy, on turn: "Their turn, Asked for help this turn")
        let bulb = Fixture.launch("spectator-mid-hand", extra: ["-uiShoulder", "1", "-uiSeatBadges", "bulb:1"])
        XCTAssertTrue(bulb.buttons["shoulder.pill"].waitForExistence(timeout: 20))
        checkPillChip(bulb, "bulb", "Asked for help this turn")
        XCTAssertNil(seats(Fixture.probe(bulb, "table.badges"))[1], "no second badge for ivy on the felt")
        XCTAssertTrue(Fixture.probe(bulb, "table.shoulderBadge").hasSuffix("pops=0 pop=-"), "a snapshot's chip never pops")
        shot("badges-watching-bulb")
    }

    /// The watched seat's live /help notice (`pop:1`, 2 s after launch) pops the pill's chip once,
    /// as the felt's lightbulb pops; Reduce Motion fades it in instead.
    func testTheWatchingPillsChipPopsOnALiveNotice() {
        for reduce in [false, true] {
            let app = Fixture.launch("spectator-mid-hand", extra: ["-uiShoulder", "1", "-uiSeatBadges", "pop:1"]
                                     + (reduce ? ["-uiReduceMotion", "YES"] : []))
            XCTAssertTrue(app.buttons["shoulder.pill"].waitForExistence(timeout: 20))
            let want = "pops=1 pop=\(reduce ? "fade" : "scale")"
            let deadline = Date().addingTimeInterval(10)
            var probe = Fixture.probe(app, "table.shoulderBadge")
            while !probe.hasSuffix(want) && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.25)
                probe = Fixture.probe(app, "table.shoulderBadge")
            }
            note("pill-pop-\(reduce ? "fade" : "scale")", probe)
            XCTAssertTrue(probe.hasSuffix(want), probe)
            checkPillChip(app, "bulb", "Asked for help this turn")
            XCTAssertTrue(Fixture.probe(app, "table.badges").contains("pops=0 "), "ivy has no avatar on the felt: the pill's is the only pop")
            app.terminate()
        }
    }

    func testReduceMotionFadesTheLightbulbIn() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiSeatBadges", "pop:2", "-uiReduceMotion", "YES"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let probe = waitForPops(app, 1)
        XCTAssertTrue(probe.hasSuffix("pops=1 pop=fade"), probe)
        XCTAssertEqual(seats(probe)[2]?.clear, "ok", probe)
    }
}
