import XCTest
import SpriteKit
import SwiftUI
@testable import BAB_Online

/// iOS 1.2.0 (4), owner 2026-11-12: my own trick pips sit in my seat's row just
/// above my hand, on the right, as one group with HSI and the voice button
/// (pips, HSI, voice), and the row keeps 8 pt from everything else on the table
/// at every size, pose and pip state (TableLayout+SeatRow.swift). HSI shows in
/// the bid panel while the row is hidden (BidOverlayView, HSIBadge).
@MainActor
final class SeatRowTests: XCTestCase {
    typealias Rel = Positions.RelativePosition
    typealias Mode = TableLayout.SeatRow.Mode

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    /// The gap between two rects (0 when they touch or overlap).
    static func gap(_ a: CGRect, _ b: CGRect) -> CGFloat { PolishLayoutTests.gap(a, b) }

    /// `r` (in `n`'s coordinates) in scene coordinates.
    static func toScene(_ r: CGRect, from n: SKNode, _ scene: SKScene) -> CGRect {
        let a = n.convert(CGPoint(x: r.minX, y: r.minY), to: scene), b = n.convert(CGPoint(x: r.maxX, y: r.maxY), to: scene)
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }

    // MARK: every size class

    /// (name, size, chrome, the form the row takes)
    static let devices: [(String, CGSize, TableChrome, Mode)] = {
        let ch = PolishLayoutTests.chrome
        let i = TableLayoutTests.insets
        return [
            ("iPhone SE size", CGSize(width: 375, height: 667), ch(i(20, 0, 0, 0), 0, 75.5), .compact),
            ("iPhone 17e", CGSize(width: 390, height: 844), ch(i(47, 0, 34, 0), 0, 75.5), .compact),
            ("iPhone Pro Max", CGSize(width: 440, height: 956), ch(i(62, 0, 34, 0), 0, 75.5), .compact),
            ("iPad 13 portrait", CGSize(width: 1032, height: 1376), ch(i(24, 0, 20, 0), 0, 75.5), .row),
            ("iPad 13 landscape", CGSize(width: 1376, height: 1032), ch(i(24, 0, 20, 0), 0, 75.5), .row),
            ("Duo closed (measured)", SceneLayoutTests.measured[0].0, SceneLayoutTests.measured[0].1, .compact),
            ("Duo open", CGSize(width: 669, height: 951), ch(i(24, 0, 20, 0), 0, 75.5), .row),
            ("Duo open landscape", CGSize(width: 951, height: 669), ch(i(0, 59, 21, 59), 0, 75.5), .row),
            ("Duo open landscape, log docked", CGSize(width: 546, height: 669), ch(i(0, 0, 34, 0), 0, 75.5), .row),
            ("Duo book, table page", CGSize(width: 455.5, height: 669), ch(i(0, 0, 34, 0), 0, 75.5), .compact),
            ("Duo book, other landscape", CGSize(width: 455.5, height: 669), ch(i(0, 84, 34, 0), 0, 75.5), .compact),
            ("iPad Slide Over, short", CGSize(width: 320, height: 700), ch(.zero, 0, 70), .narrow),
        ]
    }()

    func testTheRowSitsJustAboveMyHandOnTheRight() {
        for (name, size, chrome, mode) in Self.devices {
            let L = TableLayout(size: size, chrome: chrome)
            let R = L.seatRow
            XCTAssertFalse(L.isDegraded, name)
            XCTAssertTrue(R.fits, name)
            XCTAssertEqual(R.mode, mode, name)
            // just above my lifted hand, right of my trick slot (and of the hand's centre)
            XCTAssertEqual(R.content.minY, L.liftTop + TableLayout.seatRowGap, accuracy: 0.01, name)
            XCTAssertEqual(R.content.minX, L.trickRect(.bottom).maxX + TableLayout.seatRowGap, accuracy: 0.01, name)
            XCTAssertGreaterThan(R.content.minX, L.handBaseline.x, name)
            Self.checkOrder(R, name)
        }
    }

    /// The parts inside the row, apart, in the order pips, HSI, voice (reading order where they share a line).
    static func checkOrder(_ R: TableLayout.SeatRow, _ tag: String, file: StaticString = #filePath, line: UInt = #line) {
        let parts = [("pips", R.pips), ("hsi", R.hsi), ("voice", R.voice)]
        for (n, r) in parts {
            XCTAssertTrue(R.content.insetBy(dx: -0.01, dy: -0.01).contains(r), "\(tag): \(n) \(r) outside \(R.content)", file: file, line: line)
        }
        for i in parts.indices {
            for j in parts.indices where j > i {
                XCTAssertFalse(TableLayout.overlaps(parts[i].1, parts[j].1), "\(tag): \(parts[i].0) x \(parts[j].0)", file: file, line: line)
            }
        }
        XCTAssertEqual(R.pips.size, TableLayout.myPipsSize, tag, file: file, line: line)
        XCTAssertEqual(R.hsi.size, TableLayout.hsiSize, tag, file: file, line: line)
        XCTAssertEqual(R.voice.size, CGSize(width: Theme.hitTarget, height: Theme.hitTarget), tag, file: file, line: line)
        switch R.mode {
        case .row:
            // one line, left to right, vertically centred
            XCTAssertLessThanOrEqual(R.pips.maxX, R.hsi.minX, tag, file: file, line: line)
            XCTAssertLessThanOrEqual(R.hsi.maxX, R.voice.minX, tag, file: file, line: line)
            XCTAssertEqual(R.pips.midY, R.voice.midY, accuracy: 0.01, tag, file: file, line: line)
            XCTAssertEqual(R.hsi.midY, R.voice.midY, accuracy: 0.01, tag, file: file, line: line)
        case .compact:
            // my pips over HSI (y up), the button beside the column
            XCTAssertGreaterThanOrEqual(R.pips.minY, R.hsi.maxY, tag, file: file, line: line)
            XCTAssertEqual(R.pips.minX, R.hsi.minX, accuracy: 0.01, tag, file: file, line: line)
            XCTAssertGreaterThanOrEqual(R.voice.minX, max(R.pips.maxX, R.hsi.maxX), tag, file: file, line: line)
            XCTAssertEqual(R.hsi.minY, R.voice.minY, accuracy: 0.01, "HSI and the button share the row's bottom", file: file, line: line)
        case .narrow:
            XCTAssertGreaterThanOrEqual(R.hsi.minY, max(R.pips.maxY, R.voice.maxY), tag, file: file, line: line)
            XCTAssertLessThanOrEqual(R.pips.maxX, R.voice.minX, tag, file: file, line: line)
        case .stacked:
            XCTAssertGreaterThanOrEqual(R.pips.minY, R.hsi.maxY, tag, file: file, line: line)
            XCTAssertGreaterThanOrEqual(R.hsi.minY, R.voice.maxY, tag, file: file, line: line)
        }
    }

    // MARK: 8 pt clearances

    /// Everything the row keeps 8 pt from, as the table draws it: the hand (13 cards, one lifted),
    /// the trick cards, the piles (13 a row, their border), every other seat (glow, name, bid
    /// bubble), their chat bubbles (small to the widest two-line one), the spectator badge
    /// and a spectator's chat bubble, the corner buttons, the fold; inside the safe area by 8 pt.
    static func clearanceProblems(_ L: TableLayout) -> [String] {
        let row = L.seatRow.content
        let G = TableLayout.seatRowGap - 0.01
        var out: [String] = []
        var keeps: [(String, CGRect)] = [("hand", TableLayoutTests.handRect(L, count: 13, lifted: true))]
        for r in [Rel.top, .bottom, .left, .right] { keeps.append(("trick.\(r)", L.trickRect(r))) }
        let pad = TrickHistoryNode.borderPad
        keeps.append(("piles", TableLayoutTests.historyRect(L, count: 13).insetBy(dx: -pad, dy: -pad)))
        for (g, r) in [("partner", Rel.top), ("left", .left), ("right", .right)] {
            let a = L.seatAnchor(r)
            keeps.append(("\(g).glow", TableLayout.glowRect(a)))
            keeps.append(("\(g).name", TableLayout.nameRect(a)))
            keeps.append(("\(g).bidBubble", L.bubbleRect(r)))
            for size in [CGSize(width: 60, height: 30), CGSize(width: 150, height: 48), CGSize(width: L.chatMaxWidth, height: 48)] {
                keeps.append(("\(g).chat \(Int(size.width))", TableLayout.rect(L.chatPosition(r, bubbleSize: size), size)))
            }
        }
        let badge = L.spectatorBadge(spectating: false)
        keeps.append(("spectatorBadge", badge))
        for size in [CGSize(width: 120, height: 34), CGSize(width: 200, height: 52)] {
            let c = L.spectatorBubbleCenter(badge: badge, bubbleSize: size, spectating: false)
            keeps.append(("spectatorBubble \(Int(size.width))", TableLayout.rect(c, size)))
        }
        for (i, c) in L.cornerRects.enumerated() { keeps.append(("corner\(i)", c)) }
        if let f = L.chrome.fold, !L.foldIgnored { keeps.append(("fold", f)) }
        for (name, k) in keeps where gap(k, row) < G {
            out.append("row \(row) within 8 pt of \(name) \(k) (gap \(gap(k, row)))")
        }
        let safe = L.safeRect.insetBy(dx: G, dy: G)
        if row.minX < safe.minX || row.maxX > safe.maxX || row.minY < safe.minY || row.maxY > L.topLimit - G {
            out.append("row \(row) within 8 pt of the safe area's edge \(L.safeRect) / topLimit \(L.topLimit)")
        }
        if !L.seatRow.fits { out.append("does not fit") }
        return out
    }

    static var configs: [(String, TableLayout)] {
        var out: [(String, TableLayout)] = []
        for (name, size, chrome, _) in devices { out.append((name, TableLayout(size: size, chrome: chrome))) }
        for (device, size, ins) in PolishLayoutTests.devices {
            for topBar in [CGFloat(70), 75.5, 84] {
                for bottomBar in [CGFloat(0), 45] {   // a lazy seat's pill
                    out.append(("\(device) topBar \(topBar) bottomBar \(bottomBar)",
                                TableLayout(size: size, chrome: PolishLayoutTests.chrome(ins, bottomBar: bottomBar, topBar: topBar))))
                }
            }
        }
        for (size, ins) in TableLayoutTests.listedSizes {
            for topBar in [CGFloat(70), 84] {
                for bottomBar in [CGFloat(0), 45] {
                    out.append(("\(size) \(ins) topBar \(topBar) bottomBar \(bottomBar)",
                                TableLayout(size: size, chrome: TableLayoutTests.chrome(ins, topBar: topBar, bottomBar: bottomBar))))
                }
            }
        }
        for (size, chrome) in SceneLayoutTests.measured { out.append(("measured \(size)", TableLayout(size: size, chrome: chrome))) }
        for (fold, size, ins, topBar) in TableLayoutTests.reachableFolds {
            out.append(("\(size) fold \(fold) topBar \(topBar)", TableLayout(size: size, chrome: TableLayoutTests.chrome(ins, topBar: topBar, fold: fold))))
        }
        return out
    }

    func testTheRowKeepsEightPointsFromEverything() {
        var checked = 0
        for (tag, L) in Self.configs where !L.isDegraded {
            XCTAssertEqual(Self.clearanceProblems(L), [], tag)
            Self.checkOrder(L.seatRow, tag)
            checked += 1
        }
        XCTAssertGreaterThan(checked, 120)
    }

    /// Fuzz: every window from 320 x 480 up (the corner buttons of both measured sizes) that is
    /// not degraded fits the row with its clearances.
    func testTheRowFitsEveryWindow() {
        var forms: [Mode: Int] = [:]
        for w in stride(from: CGFloat(320), through: 1400, by: 9) {
            for h in stride(from: CGFloat(480), through: 1400, by: 13) {
                for corner in [CGSize(width: 96, height: 52), CGSize(width: 80, height: 50.5)] {
                    let L = TableLayout(size: CGSize(width: w, height: h), chrome: TableLayoutTests.chrome(topBar: 75.5, corner: corner))
                    guard !L.isDegraded else { continue }
                    forms[L.seatRow.mode, default: 0] += 1
                    let p = Self.clearanceProblems(L)
                    if !p.isEmpty { XCTFail("\(w)x\(h) \(corner): \(p)"); return }
                }
            }
        }
        XCTAssertGreaterThan(forms[.row] ?? 0, 0)
        XCTAssertGreaterThan(forms[.compact] ?? 0, 0)
        XCTAssertGreaterThan(forms[.narrow] ?? 0, 0)
    }

    /// Each form's parts at their sizes (the form a window too narrow for the others takes too).
    func testEveryFormKeepsItsOrder() {
        for mode in Mode.allCases {
            let s = TableLayout.seatRowSize(mode)
            Self.checkOrder(TableLayout.seatRow(mode, CGRect(x: 10, y: -200, width: s.width, height: s.height), fits: true), "\(mode)")
        }
        XCTAssertEqual(TableLayout.seatRowSize(.row), CGSize(width: 186, height: 44))
        XCTAssertEqual(TableLayout.seatRowSize(.compact), CGSize(width: 122, height: 44))
        XCTAssertEqual(TableLayout.seatRowSize(.narrow), CGSize(width: 104, height: 68))
        XCTAssertEqual(TableLayout.seatRowSize(.stacked), CGSize(width: 74, height: 92))
    }

    // MARK: every pip state

    /// My seat (1) in trick-mid-lead3 (12 cards, a trick on the table: my bid bubble is gone).
    func snapshot(myBid: String, myTricks: Int, handSize: Int = 12) throws -> TableSnapshot {
        try T.snapshot("trick-mid-lead3") { raw in
            var bids = raw["bids"] as! [String: Any]
            bids["byPosition"] = [myBid, "1", "1", "1"]
            raw["bids"] = bids
            raw["tricksByPosition"] = [myTricks, 0, 0, 0]
            raw["tricks"] = ["team1": myTricks, "team2": 0]
            var deal = raw["deal"] as! [String: Any]
            deal["handSize"] = handSize
            raw["deal"] = deal
        }
    }

    /// (bid, tricks won, hand size, slots drawn, over, bore)
    static let pipStates: [(String, Int, Int, Int, Int, Bool)] = [
        ("0", 0, 12, 0, 0, false),     // a 0 bid: no slots
        ("0", 2, 12, 2, 2, false),     // a 0 bid that took two: gold
        ("1", 0, 12, 1, 0, false),
        ("2", 1, 12, 2, 0, false),
        ("3", 5, 12, 5, 2, false),     // over: two gold
        ("7", 3, 12, 7, 0, false),
        ("8", 8, 12, 8, 0, false),     // two rows
        ("12", 4, 12, 12, 0, false),
        ("13", 2, 13, 13, 0, false),
        ("B", 5, 12, 12, 0, true),     // the bore pill, 12 slots in two rows
        ("B", 9, 13, 13, 0, true),     // 13 slots
    ]

    func testEveryPipStateFitsTheRow() throws {
        for (name, size, chrome, _) in Self.devices {
            for (bid, won, handSize, slots, over, bore) in Self.pipStates {
                let tag = "\(name) bid \(bid) won \(won) hand \(handSize)"
                let h = ReplayHarness()
                let scene = GameSKScene(size: size)
                scene.animator = InstantAnimator()
                scene.chrome = chrome
                scene.configure(gameState: h.store, actions: h.actions)
                scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
                h.store.apply(.snapshot(try snapshot(myBid: bid, myTricks: won, handSize: handSize), .rejoin, hints: nil))
                let L = scene.layout
                let shown = scene.myPipsNode.shown
                XCTAssertEqual(shown.slots, slots, tag)
                XCTAssertEqual(shown.over, over, tag)
                XCTAssertEqual(shown.bore, bore, tag)
                guard slots > 0 else { continue }
                // the drawn pill (bore outline included) inside my pips' box, against its neighbour
                let pill = Self.toScene(scene.myPipsNode.calculateAccumulatedFrame(), from: scene.myPipsNode.parent!, scene)
                XCTAssertTrue(L.myPips.insetBy(dx: -0.5, dy: -0.5).contains(pill), "\(tag): pill \(pill) box \(L.myPips)")
                switch L.seatRow.mode {
                case .row: XCTAssertLessThanOrEqual(L.seatRow.hsi.minX - pill.maxX, TableLayout.seatRowSpacing + 1.5, "\(tag): pill next to HSI")
                case .compact: XCTAssertLessThanOrEqual(pill.minY - L.seatRow.hsi.maxY, TableLayout.seatRowColumnSpacing + 1.5, "\(tag): pill over HSI")
                default: break
                }
                // and the drawn piles 8 pt away
                let hist = scene.trickManager.trickHistory
                hist.setCounts(team: 6, opp: 7, spacing: L.historySpacing, totals: .some((team: 13, opp: 13)))
                let piles = Self.toScene(hist.calculateAccumulatedFrame(), from: hist.parent!, scene)
                XCTAssertGreaterThanOrEqual(Self.gap(pill, piles), TableLayout.myPipsPileGap - 0.01, "\(tag): pill \(pill) piles \(piles)")
                // the trick cards on the table (the drawn ones) 8 pt away
                for card in scene.trickArea.cardSprites {
                    let c = Self.toScene(card.calculateAccumulatedFrame(), from: card.parent!, scene)
                    XCTAssertGreaterThanOrEqual(Self.gap(pill, c), TableLayout.seatRowGap - 0.01, "\(tag): pill x trick card")
                }
                let hand = Self.toScene(scene.handNode.calculateAccumulatedFrame(), from: scene.handNode.parent!, scene)
                XCTAssertGreaterThanOrEqual(Self.gap(pill, hand), TableLayout.seatRowGap - 0.01, "\(tag): pill x hand")
            }
        }
    }

    /// VoiceOver: the "Your tricks" element is over my pips' box in the row.
    func testMyPipsElementFollowsTheRow() throws {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try snapshot(myBid: "3", myTricks: 1), .rejoin, hints: nil))
        let model = TableRenderModel(h.store.state)
        XCTAssertEqual(model.mySpokenPips?.accessibilityLabel, "1 of 3 tricks")
        for (name, size, chrome, _) in Self.devices {
            let L = TableLayout(size: size, chrome: chrome)
            // GameContainerView.pipsAccessibility places "pips.mine" at layout.window(layout.myPips)
            XCTAssertEqual(L.myPips, L.seatRow.pips, name)
            XCTAssertTrue(L.seatRow.content.contains(L.myPips), name)
        }
    }

    // MARK: spectators keep their table

    /// A spectator has no seat row: the badge, its bubble and the banner are where 1.2.0 (3) put them
    /// (values from 1e767d2's TableLayout).
    func testSpectatorTableUnchanged() {
        let ch = { (ins: TableInsets, topBar: CGFloat, corner: CGSize) in
            TableChrome(safeArea: ins, topBar: topBar, cornerButton: corner, bottomBar: 45)
        }
        let i = TableLayoutTests.insets
        let c1 = CGSize(width: 96, height: 52), c2 = CGSize(width: 80, height: 50.5)
        let pinned: [(CGSize, TableChrome, CGRect, CGPoint, CGRect?)] = [
            (CGSize(width: 393, height: 852), ch(i(59, 0, 34, 0), 70, c1), CGRect(x: 128.5, y: -341, width: 60, height: 44),
             CGPoint(x: 113.5, y: -215), CGRect(x: -188.5, y: -231, width: 377, height: 60)),
            (CGSize(width: 440, height: 956), ch(i(62, 0, 34, 0), 75.5, c2), CGRect(x: 152, y: -393, width: 60, height: 44),
             CGPoint(x: 137, y: -323), CGRect(x: -210, y: 204.5, width: 420, height: 60)),
            (CGSize(width: 466, height: 678), ch(i(0, 0, 34, 84), 75.333, CGSize(width: 79.667, height: 50.333)),
             CGRect(x: 81, y: -254, width: 60, height: 44), CGPoint(x: 66, y: -140), nil),
            (CGSize(width: 1032, height: 1376), ch(i(24, 0, 20, 0), 75.5, c2), CGRect(x: 448, y: -617, width: 60, height: 44),
             CGPoint(x: 433, y: -547), CGRect(x: -210, y: 522.5, width: 420, height: 60)),
            (CGSize(width: 1376, height: 1032), ch(i(24, 0, 20, 0), 75.5, c2), CGRect(x: 620, y: -445, width: 60, height: 44),
             CGPoint(x: 605, y: -375), CGRect(x: -210, y: 350.5, width: 420, height: 60)),
            (CGSize(width: 669, height: 951), ch(i(24, 0, 20, 0), 70, c1), CGRect(x: 266.5, y: -404.5, width: 60, height: 44),
             CGPoint(x: 251.5, y: -334.5), CGRect(x: -210, y: 315.5, width: 420, height: 60)),
        ]
        for (size, chrome, badge, bubble, banner) in pinned {
            let L = TableLayout(size: size, chrome: chrome)
            let b = L.spectatorBadge(spectating: true)
            XCTAssertEqual(b, badge, "\(size)")
            let p = L.spectatorBubbleCenter(badge: b, bubbleSize: CGSize(width: 150, height: 40), spectating: true)
            XCTAssertEqual(p.x, bubble.x, accuracy: 0.01, "\(size)")
            XCTAssertEqual(p.y, bubble.y, accuracy: 0.01, "\(size)")
            XCTAssertEqual(L.disconnectBanner(height: 60, spectating: true), banner, "\(size)")
        }
    }

    // MARK: HSI

    func testHSIReadsTheSameOnTheTableAndInThePanel() {
        XCTAssertEqual(HSIBadge.text(119.16666), "HSI 119.2")
        XCTAssertEqual(HSIBadge.text(79.0833), "HSI 79.1")
        XCTAssertEqual(HSIBadge.spoken(119.16666), "Hand strength index 119.2")
    }

    func testMyHSIOnlyForASeat() throws {
        let seated = ReplayHarness()
        seated.store.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertEqual(try XCTUnwrap(seated.store.myHSI), 79.083, accuracy: 0.001, "seat 4's value")
        let spectator = ReplayHarness()
        spectator.store.apply(.snapshot(try T.snapshot("spectator-mid-hand"), .rejoin, hints: nil))
        XCTAssertTrue(spectator.store.isSpectator)
        XCTAssertNil(spectator.store.myHSI)
        let noValues = ReplayHarness()
        noValues.store.apply(.snapshot(try T.snapshot("bidding-mid") { $0["hsi"] = NSNull() }, .rejoin, hints: nil))
        XCTAssertNil(noValues.store.myHSI)
    }

    /// The recorded real-server games: on every one of my bid turns (when the panel shows)
    /// there is an HSI for my seat, the server's value from that deal's gameStart.
    func testEveryRecordedBidTurnHasMyHSI() throws {
        var turns = 0
        for game in try RecordedGame.all() {
            for viewer in game.viewers where viewer.position != nil && viewer.role != "spectator" {
                let h = ReplayHarness(viewer: viewer)
                var dealt: Double?
                var wasMyBid = false
                for e in game.logs[viewer.label] ?? [] {
                    try h.apply(e)
                    if e.dir == "s2c", e.event == "gameStart", let d = e.data as? [String: Any], let pos = h.store.position,
                       let values = d["hsiValues"] as? [String: Any] {
                        dealt = (values[String(pos)] as? NSNumber)?.doubleValue
                    }
                    let myBid: Bool
                    if case .choosing(.bid) = h.store.myTurn { myBid = !h.store.isReadOnly } else { myBid = false }
                    if myBid && !wasMyBid {
                        turns += 1
                        let hsi = try XCTUnwrap(h.store.myHSI, "\(game.name)/\(viewer.label) #\(e.i): no HSI on my bid turn")
                        if let dealt { XCTAssertEqual(hsi, dealt, accuracy: 0.0001, "\(game.name)/\(viewer.label) #\(e.i)") }
                    }
                    wasMyBid = myBid
                }
            }
        }
        XCTAssertGreaterThan(turns, 20)
    }

    /// HSI goes in the bottom row's gap only with its margin each side; else the header.
    func testPanelHSIPlacementRule() {
        let m = BidOverlayView.hsiMargin
        XCTAssertTrue(BidOverlayView.hsiFitsRow(gap: 200, hsi: 70))
        XCTAssertTrue(BidOverlayView.hsiFitsRow(gap: 70 + 2 * m, hsi: 70))
        XCTAssertFalse(BidOverlayView.hsiFitsRow(gap: 70 + 2 * m - 1, hsi: 70))
        XCTAssertFalse(BidOverlayView.hsiFitsRow(gap: 8, hsi: 70))
    }

    /// The panel with HSI keeps the bid band's size (HSI in the gap adds no height).
    func testBidPanelWithHSIFitsTheBand() throws {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertNotNil(h.store.myHSI)
        for width in [CGFloat(340)] {   // the band's width (a narrower window is already narrower than the 7-cell grid)
            for type in [DynamicTypeSize.large, .xxLarge, .accessibility5] {
                let v = BidOverlayView().environmentObject(h.store).environmentObject(h.actions).environment(\.dynamicTypeSize, type)
                let host = UIHostingController(rootView: v)
                let s = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
                XCTAssertLessThanOrEqual(s.height, 140, "\(width) \(type)")
                XCTAssertLessThanOrEqual(s.width, width, "\(width) \(type)")
            }
        }
    }
}
