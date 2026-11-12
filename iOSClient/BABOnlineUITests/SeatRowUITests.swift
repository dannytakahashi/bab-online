import XCTest

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
        let pips = app.otherElements["pips.mine"], hsi = element(app, "hsi"), mic = app.buttons["Mute microphone"]
        XCTAssertTrue(pips.exists && hsi.exists && mic.exists, "pips \(pips.exists) hsi \(hsi.exists) mic \(mic.exists)")
        XCTAssertEqual(hsi.label, "Hand strength index 119.2")
        XCTAssertTrue(pips.label.hasPrefix("Your tricks: "), pips.label)
        XCTAssertFalse(element(app, "bidOverlay.hsi").exists, "no bid panel mid-hand")
        let p = pips.frame, h = hsi.frame, m = mic.frame
        let window = app.windows.firstMatch.frame
        // on the right, together: my pips before HSI (left of it, or over it), the button after both
        XCTAssertGreaterThan(p.minX, window.midX, "\(p) \(window)")
        XCTAssertTrue(p.maxX <= h.minX + 0.5 || p.maxY <= h.minY + 0.5, "pips \(p) before HSI \(h)")
        XCTAssertGreaterThanOrEqual(m.minX, max(p.maxX, h.maxX) - 0.5, "button \(m) after pips \(p) and HSI \(h)")
        let group = p.union(h).union(m)
        XCTAssertLessThanOrEqual(group.width, 186.5, "\(group)")
        XCTAssertLessThanOrEqual(group.height, 68.5, "\(group)")
        // just above my hand: 8 pt above the lifted cards (lift 20 pt), never far up
        // cards in my hand (the 4 and 6 of Clubs are on the table)
        let cards = ["Queen of Clubs", "High Joker", "10 of Clubs"].map { app.descendants(matching: .any)[$0].frame }
        let handTop = cards.map(\.minY).min() ?? 0
        XCTAssertGreaterThanOrEqual(handTop - group.maxY, 8 + 20 - 1, "row \(group) hand top \(handTop)")
        XCTAssertLessThanOrEqual(handTop - group.maxY, 8 + 20 + 1, "row \(group) hand top \(handTop)")
        XCTAssertEqual(Fixture.probe(app, "table.layoutCheck"), "ok")
        app.terminate()
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
