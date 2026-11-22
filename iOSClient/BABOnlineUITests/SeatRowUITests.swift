import XCTest

/// TableLayout's zoom bounds (`maxZoom`, `zoomMinSide`), restated: the UI test target cannot see the app's types.
enum TableZoomLimits {
    static let max: CGFloat = 1.4
    static let minSide: CGFloat = 700
}

/// iOS 1.2.0 (4), owner 2026-11-12, on a live table in fixture mode: my pips,
/// HSI and the voice button are one group just above my hand, on the right
/// (TableLayout+SeatRow.swift), and while I bid HSI shows inside the bid panel,
/// between the bore button and Submit, without moving either (BidOverlayView).
final class SeatRowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    func testMySeatRowIsOneGroupJustAboveMyHand() {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiVoice", "YES"])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        _ = Fixture.settledState(app)
        let pips = app.otherElements["pips.mine"], hsi = element(app, "hsi"), mic = app.buttons["Unmute microphone"]
        XCTAssertTrue(pips.exists && hsi.exists && mic.exists, "pips \(pips.exists) hsi \(hsi.exists) mic \(mic.exists)")
        XCTAssertEqual(hsi.label, "Hand strength index 105.8")
        XCTAssertTrue(pips.label.hasPrefix("Your tricks: "), pips.label)
        XCTAssertFalse(element(app, "bidOverlay.hsi").exists, "no bid panel mid-hand")
        let p = pips.frame, h = hsi.frame, m = mic.frame
        let window = app.windows.firstMatch.frame
        // on the right, together: my pips before HSI (left of it, or over it), the button after both
        XCTAssertGreaterThan(p.minX, window.midX, "\(p) \(window)")
        XCTAssertTrue(p.maxX <= h.minX + 0.5 || p.maxY <= h.minY + 0.5, "pips \(p) before HSI \(h)")
        // the iPhone Duo with its vertical bar: my mic is the bar's item (owner 2026-11-22), not in the row
        let barMic = Fixture.usesVerticalBar(app)
        if !barMic {
            XCTAssertGreaterThanOrEqual(m.minX, max(p.maxX, h.maxX) - 0.5, "button \(m) after pips \(p) and HSI \(h)")
        }
        // The limits are in scene units: on an iPad the whole table, this row with it, is drawn
        // `zoom` times larger (TableLayout.zoom, up to 1.4). A phone never zooms.
        guard let zoom = Fixture.tableZoom(app) else {
            return XCTFail("no table.zoom probe: \(Fixture.probe(app, "table.zoom"))")
        }
        XCTAssertTrue((1...TableZoomLimits.max).contains(zoom), "zoom \(zoom)")
        if min(window.width, window.height) < TableZoomLimits.minSide {
            XCTAssertEqual(zoom, 1, "a phone-sized window \(window) never zooms")
        }
        if min(window.width, window.height) >= 1000 {
            XCTAssertEqual(zoom, TableZoomLimits.max, "a full-screen iPad 13 \(window) grows the table all the way")
        }
        let group = barMic ? p.union(h) : p.union(h).union(m)
        XCTAssertLessThanOrEqual(group.width, 186.5 * zoom, "\(group) zoom \(zoom)")
        XCTAssertLessThanOrEqual(group.height, 68.5 * zoom, "\(group) zoom \(zoom)")
        // just above my hand: 8 above the lifted cards (lift 20), never far up, both in scene units
        // cards in my hand (the 4 and 6 of Clubs are on the table)
        let cards = ["Queen of Clubs", "High Joker", "10 of Clubs"].map { app.descendants(matching: .any)[$0].frame }
        let handTop = cards.map(\.minY).min() ?? 0
        let gap = (8 + 20) * zoom
        XCTAssertGreaterThanOrEqual(handTop - group.maxY, gap - 1, "row \(group) hand top \(handTop) zoom \(zoom)")
        XCTAssertLessThanOrEqual(handTop - group.maxY, gap + 1, "row \(group) hand top \(handTop) zoom \(zoom)")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        app.terminate()
    }

    // MARK: A live deal's HSI (the web's PR #345)

    /// A live deal (`-uiDeal`, 8 s after launch) with my seat's HSI `-uiDealHSI <value>`: the
    /// rejoin's 105.8 (the fixture hand under the HSI of #382) goes to "HSI --" with the deal and the new value shows a second after it
    /// (HSIScale.revealDelay), in my seat's row or, on my bid turn, the bid panel. The colour
    /// (red to green, HSIScale.color) is in the screenshot, `hsi-<name>` (`BAB_SHOTS` saves it).
    private func checkLiveDealHSI(_ value: String, shot name: String) {
        let app = Fixture.launch("trick-mid-lead3", extra: ["-uiDeal", "YES", "-uiDealHSI", value])
        XCTAssertTrue(app.buttons["leave"].waitForExistence(timeout: 20))
        let row = element(app, "hsi"), panel = element(app, "bidOverlay.hsi")
        func reading() -> String? {
            if panel.exists { return panel.label }
            return row.exists ? row.label : nil
        }
        let shown = "Hand strength index \(value)"
        var labels: [String] = []
        var pendingAt: Date?, shownAt: Date?
        let deadline = Date().addingTimeInterval(25)
        while Date() < deadline, shownAt == nil {
            guard let label = reading() else { Thread.sleep(forTimeInterval: 0.05); continue }
            if labels.last != label { labels.append(label) }
            if label == "Hand strength index pending", pendingAt == nil { pendingAt = Date() }
            if label == shown { shownAt = Date() }
            Thread.sleep(forTimeInterval: 0.05)
        }
        XCTAssertNotNil(shownAt, "\(name): never showed \(shown): \(labels)")
        // read before the deal (the rejoin's value), then "HSI --" for the reveal's second
        if labels.first == "Hand strength index 105.8" {
            XCTAssertEqual(labels, ["Hand strength index 105.8", "Hand strength index pending", shown], name)
            if let pendingAt, let shownAt {
                XCTAssertLessThan(shownAt.timeIntervalSince(pendingAt), 2.5, "\(name): held too long")
            }
        } else {
            XCTAssertEqual(labels.last, shown, "\(name): \(labels)")
        }
        let png = app.screenshot()
        let a = XCTAttachment(screenshot: png)
        a.name = "hsi-\(name)"
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["BAB_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? png.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("hsi-\(name).png"))
        }
        app.terminate()
    }

    /// A weak hand (64.0: under 70, full red, lifted for contrast).
    func testALiveDealShowsAWeakHSIAfterTheDashes() {
        checkLiveDealHSI("64.0", shot: "weak")
    }

    /// A strong hand (182.0: near green).
    func testALiveDealShowsAStrongHSIAfterTheDashes() {
        checkLiveDealHSI("182.0", shot: "strong")
    }

    // MARK: HSI in the bid panel

    /// bidding-mid (I am seat 4, my turn; seat 2 bid B, seat 3 1) with its bids changed so each
    /// bore option shows.
    private func biddingSnapshot(_ edit: (inout [String: Any]) -> Void) throws -> String {
        final class Token {}
        let url = try XCTUnwrap(Bundle(for: Token.self).url(forResource: "bidding-mid", withExtension: "json", subdirectory: "v2"))
        let raw = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var snap = try XCTUnwrap(raw["snapshot"] as? [String: Any])
        edit(&snap)
        return String(decoding: try JSONSerialization.data(withJSONObject: snap), as: UTF8.self)
    }

    private static func bids(_ s: inout [String: Any], _ byPosition: [Any], order: [Int]? = nil, bidder: Int? = nil) {
        var b = s["bids"] as! [String: Any]
        b["byPosition"] = byPosition
        if let order { b["order"] = order }
        s["bids"] = b
        if let bidder {
            var d = s["deal"] as! [String: Any]
            d["bidder"] = bidder
            s["deal"] = d
        }
    }

    struct Frames { let bore: CGRect?; let hsi: CGRect?; let submit: CGRect; let panel: CGRect }

    private func panelFrames(_ env: String, bore level: String?, extra: [String] = []) -> Frames? {
        let app = Fixture.launch("env", extra: extra, env: ["UI_FIXTURE_SNAPSHOT": env])
        defer { app.terminate() }
        let panel = element(app, "bidOverlay")
        guard panel.waitForExistence(timeout: 20) else { XCTFail("no bid panel"); return nil }
        sleep(1)
        let submit = panel.buttons["Submit"]
        XCTAssertTrue(submit.exists)
        XCTAssertFalse(element(app, "hsi").exists, "the seat row is hidden on my bid turn")
        let hsi = element(app, "bidOverlay.hsi")
        let bore = level.map { panel.buttons[$0] }
        if let bore { XCTAssertTrue(bore.exists, "\(level!) button") }
        return Frames(bore: bore?.frame, hsi: hsi.exists ? hsi.frame : nil, submit: submit.frame, panel: panel.frame)
    }

    private func checkBetween(_ f: Frames, _ tag: String) {
        guard let hsi = f.hsi else { return XCTFail("\(tag): no HSI in the panel") }
        // on the bottom row, centred on Submit's line, 8 pt clear of the bore button and Submit
        XCTAssertEqual(hsi.midY, f.submit.midY, accuracy: 1, "\(tag): HSI \(hsi) not on Submit's row \(f.submit)")
        XCTAssertGreaterThanOrEqual(f.submit.minX - hsi.maxX, 8 - 0.5, "\(tag): HSI \(hsi) Submit \(f.submit)")
        if let bore = f.bore {
            XCTAssertGreaterThanOrEqual(hsi.minX - bore.maxX, 8 - 0.5, "\(tag): HSI \(hsi) bore \(bore)")
        }
        XCTAssertTrue(f.panel.contains(hsi), "\(tag)")
    }

    func testBidPanelShowsHSIBetweenTheBoreButtonAndSubmit() throws {
        let sets: [(String, (inout [String: Any]) -> Void)] = [
            ("B", { Self.bids(&$0, [NSNull(), "1", "2", NSNull()]) }),
            ("2B", { _ in }),
            ("3B", { Self.bids(&$0, [NSNull(), "B", "2B", NSNull()]) }),
            ("4B", { Self.bids(&$0, ["B", "2B", "3B", NSNull()], order: [1, 2, 3, 4], bidder: 1) }),
        ]
        var withHSI: [String: Frames] = [:]
        for (level, edit) in sets {
            guard let f = panelFrames(try biddingSnapshot(edit), bore: level) else { continue }
            checkBetween(f, level)
            withHSI[level] = f
        }
        // the same panel without an HSI value: the buttons sit exactly where they were
        guard let none = panelFrames(try biddingSnapshot { $0["hsi"] = NSNull() }, bore: "2B"), let two = withHSI["2B"] else { return }
        XCTAssertNil(none.hsi, "no value, no HSI")
        XCTAssertEqual(none.submit, two.submit, "HSI moved Submit")
        XCTAssertEqual(none.bore, two.bore, "HSI moved the bore button")
        XCTAssertEqual(none.panel, two.panel, "HSI changed the panel")
    }

    /// The widest controls the panel allows (Dynamic Type xxLarge, its cap) on this phone: still between.
    func testBidPanelHSIAtTheLargestTextSize() throws {
        let xxl = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXL"]
        let env = try biddingSnapshot { Self.bids(&$0, ["B", "2B", "3B", NSNull()], order: [1, 2, 3, 4], bidder: 1) }
        guard let f = panelFrames(env, bore: "4B", extra: xxl) else { return }
        checkBetween(f, "4B xxLarge")
        guard let none = panelFrames(try biddingSnapshot {
            Self.bids(&$0, ["B", "2B", "3B", NSNull()], order: [1, 2, 3, 4], bidder: 1)
            $0["hsi"] = NSNull()
        }, bore: "4B", extra: xxl) else { return }
        XCTAssertEqual(none.submit, f.submit, "HSI moved Submit at xxLarge")
        XCTAssertEqual(none.bore, f.bore, "HSI moved the bore button at xxLarge")
    }
}
