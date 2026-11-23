import XCTest

/// The avatar badges (State/Table/SeatBadges.swift; `-uiSeatBadges`, UIFixture+SeatBadges.swift):
/// the snapshot's lightbulb and graduation cap at launch, a live /help notice's lightbulb popping
/// in 2 s later; each clear of the table ("table.badges" clear=ok), inside the window, never on my
/// own seat, and spoken on the seat's name ("kim, asked for help this turn", "hal, tutorial on").
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

    func testReduceMotionFadesTheLightbulbIn() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiSeatBadges", "pop:2", "-uiReduceMotion", "YES"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let probe = waitForPops(app, 1)
        XCTAssertTrue(probe.hasSuffix("pops=1 pop=fade"), probe)
        XCTAssertEqual(seats(probe)[2]?.clear, "ok", probe)
    }
}
