import XCTest
import CoreGraphics
import SpriteKit
@testable import BAB_Online

/// TableLayout (roadmap item 25): the pure layout, against the reference
/// model's golden values, plus no-intersection, fit and fuzz checks.
final class TableLayoutTests: XCTestCase {
    typealias Rel = Positions.RelativePosition

    static func insets(_ t: CGFloat, _ l: CGFloat, _ b: CGFloat, _ r: CGFloat) -> TableInsets { TableInsets(top: t, left: l, bottom: b, right: r) }

    static func chrome(_ ins: TableInsets = .zero, topBar: CGFloat = 70, corner: CGSize = CGSize(width: 96, height: 52),
                       bottomBar: CGFloat = 0, fold: CGRect? = nil) -> TableChrome {
        TableChrome(safeArea: ins, topBar: topBar, cornerButton: corner, bottomBar: bottomBar, fold: fold)
    }

    /// The item's seven sizes with their device insets (the Duo's are the assumed ones; see docs).
    static let scopeSizes: [(CGSize, TableInsets)] = [
        (CGSize(width: 393, height: 852), insets(59, 0, 34, 0)),
        (CGSize(width: 375, height: 667), insets(20, 0, 0, 0)),
        (CGSize(width: 466, height: 678), insets(59, 0, 34, 0)),
        (CGSize(width: 669, height: 951), insets(24, 0, 20, 0)),
        (CGSize(width: 951, height: 669), insets(0, 59, 21, 59)),
        (CGSize(width: 1180, height: 820), insets(24, 0, 20, 0)),
        (CGSize(width: 820, height: 1180), insets(24, 0, 20, 0)),
    ]
    static let listedSizes: [(CGSize, TableInsets)] = scopeSizes + [
        (CGSize(width: 375, height: 667), .zero),
        (CGSize(width: 466, height: 678), .zero),
        (CGSize(width: 572, height: 669), insets(0, 0, 21, 59)),   // inner landscape, log docked
        (CGSize(width: 466, height: 678), insets(0, 0, 34, 84)),   // measured: the closed Duo ("ui.pose"; status cluster on the right)
        (CGSize(width: 820, height: 1180), insets(32, 0, 20, 0)),  // measured: iPad Air 11-inch (M4) portrait
        (CGSize(width: 1180, height: 820), insets(32, 0, 20, 0)),  // measured: iPad Air 11-inch (M4) landscape
    ]

    // MARK: golden (layout_ref.py output)

    func testGoldenValues() {
        struct Row { let w, h: CGFloat; let ins: TableInsets; var topBar: CGFloat = 70; var bottomBar: CGFloat = 0
            var corner = CGSize(width: 96, height: 52)
            let s, k: CGFloat; let mode: TableLayout.SeatMode?; let overlap: CGFloat? }
        let rows: [Row] = [
            Row(w: 375, h: 667, ins: Self.insets(20, 0, 0, 0), s: 1, k: 0.90, mode: .raised, overlap: 21.6),
            Row(w: 393, h: 852, ins: Self.insets(59, 0, 34, 0), s: 1, k: 1, mode: .raised, overlap: 23.1),
            Row(w: 466, h: 678, ins: Self.insets(59, 0, 34, 0), s: 1, k: 1, mode: .row, overlap: 29.2),
            Row(w: 466, h: 678, ins: .zero, s: 1, k: 1, mode: .row, overlap: 29.2),
            Row(w: 669, h: 951, ins: Self.insets(24, 0, 20, 0), s: 1, k: 1, mode: .row, overlap: 35),
            Row(w: 951, h: 669, ins: Self.insets(0, 59, 21, 59), s: 1, k: 1, mode: .row, overlap: 35),
            Row(w: 572, h: 669, ins: Self.insets(0, 0, 21, 59), s: 1, k: 1, mode: .row, overlap: 33.1),
            Row(w: 1180, h: 820, ins: Self.insets(24, 0, 20, 0), s: 1, k: 1, mode: .row, overlap: 35),
            Row(w: 820, h: 1180, ins: Self.insets(24, 0, 20, 0), s: 1, k: 1, mode: .row, overlap: 35),
            Row(w: 375, h: 667, ins: Self.insets(20, 0, 0, 0), topBar: 84, s: 1, k: 0.80, mode: nil, overlap: nil),
            Row(w: 466, h: 678, ins: Self.insets(59, 0, 34, 0), topBar: 84, s: 0.90, k: 1, mode: nil, overlap: nil),
            Row(w: 375, h: 667, ins: Self.insets(20, 0, 0, 0), bottomBar: 45, s: 0.90, k: 0.75, mode: nil, overlap: nil),
            // measured in fixture mode (ui.pose and the [Layout] line): the closed Duo and the iPad
            Row(w: 466, h: 678, ins: Self.insets(0, 0, 34, 84), topBar: 75.333, corner: CGSize(width: 79.667, height: 50.333),
                s: 1, k: 0.85, mode: .raised, overlap: 22.2),
            Row(w: 466, h: 678, ins: Self.insets(0, 0, 34, 84), topBar: 75.333, bottomBar: 45, corner: CGSize(width: 79.667, height: 50.333),
                s: 0.85, k: 0.75, mode: .raised, overlap: nil),
            Row(w: 820, h: 1180, ins: Self.insets(32, 0, 20, 0), topBar: 75.5, corner: CGSize(width: 80, height: 50.5),
                s: 1, k: 1, mode: .row, overlap: 35),
            Row(w: 1180, h: 820, ins: Self.insets(32, 0, 20, 0), topBar: 75.5, corner: CGSize(width: 80, height: 50.5),
                s: 1, k: 1, mode: .row, overlap: 35),
        ]
        for row in rows {
            let L = TableLayout(size: CGSize(width: row.w, height: row.h),
                                chrome: Self.chrome(row.ins, topBar: row.topBar, corner: row.corner, bottomBar: row.bottomBar))
            let tag = "\(row.w)x\(row.h) \(row.ins) topBar \(row.topBar) bottomBar \(row.bottomBar)"
            XCTAssertFalse(L.isDegraded, tag)
            XCTAssertEqual(L.handScale, row.s, accuracy: 0.001, tag)
            XCTAssertEqual(L.trickScale, row.k, accuracy: 0.001, tag)
            if let m = row.mode { XCTAssertEqual(L.mode, m, tag) }
            if let ov = row.overlap { XCTAssertEqual(L.handOverlap(count: 13), ov, accuracy: 0.5, tag) }
        }
        // spot values (raw = from the bottom edge) from layout_ref.out
        let se = TableLayout(size: CGSize(width: 375, height: 667), chrome: Self.chrome(Self.insets(20, 0, 0, 0)))
        XCTAssertEqual(se.trickSlot(.left).y + 333.5, 294.8, accuracy: 0.5)
        XCTAssertEqual(se.seatAnchor(.top).y + 333.5, 487, accuracy: 0.5)
        XCTAssertEqual(se.seatAnchor(.left).y + 333.5, 437, accuracy: 0.5)
        XCTAssertEqual(se.seatAnchor(.left).x, -135.5, accuracy: 0.5)
        XCTAssertEqual(se.accessory.width, 138, accuracy: 0.5)
        XCTAssertEqual(se.accessory.height, 54, accuracy: 0.5)
        XCTAssertEqual(se.historySpacing, 10.5, accuracy: 0.05)
        let duo = TableLayout(size: CGSize(width: 466, height: 678), chrome: Self.chrome(Self.insets(59, 0, 34, 0)))
        XCTAssertEqual(duo.trickSlot(.left).y + 339, 342.5, accuracy: 0.5)
        XCTAssertEqual(duo.seatAnchor(.top).y + 339, 513, accuracy: 0.5)
        XCTAssertEqual(duo.seatAnchor(.right).x, 181, accuracy: 0.5)
        XCTAssertEqual(duo.bidBand.minY + 339, 215, accuracy: 0.5)
        XCTAssertEqual(duo.topLimit + 339, 543, accuracy: 0.5)
    }

    func testLazyPillFallsBackAt466() {
        let L = TableLayout(size: CGSize(width: 466, height: 678), chrome: Self.chrome(Self.insets(59, 0, 34, 0), bottomBar: 45))
        XCTAssertFalse(L.isDegraded)
        XCTAssertEqual(L.usedBottomBar, 0, "no (s, k) fits above the pill: the pill overlays the bottom of a read-only hand")
        XCTAssertEqual(L.handScale, 1)
        XCTAssertEqual(L.trickScale, 1)
        // a spectator's bottom-seat name stays clear of the pill (45 = pill + 12 padding)
        XCTAssertGreaterThanOrEqual(TableLayout.nameRect(L.seatAnchor(.bottom)).minY, L.safeRect.minY + 45 + 0.49)
        let se = TableLayout(size: CGSize(width: 375, height: 667), chrome: Self.chrome(Self.insets(20, 0, 0, 0), bottomBar: 45))
        XCTAssertEqual(se.usedBottomBar, 45)
        let tall = TableLayout(size: CGSize(width: 393, height: 852), chrome: Self.chrome(Self.insets(59, 0, 34, 0), bottomBar: 45))
        XCTAssertEqual(tall.usedBottomBar, 45)
        XCTAssertGreaterThanOrEqual(tall.handBaseline.y - 72.5 * tall.handScale, tall.safeRect.minY + 45 + TableLayout.gap - 0.01)
    }

    // MARK: no intersections

    struct Item { let group: String; let rect: CGRect; let kind: String }

    /// Every rect of the table at `L` (a 13-card hand, its card lifted).
    static func items(_ L: TableLayout) -> [Item] {
        var out: [Item] = []
        for (g, r) in [("partner", Rel.top), ("left", .left), ("right", .right)] {
            let a = L.seatAnchor(r)
            out.append(Item(group: g, rect: TableLayout.glowRect(a), kind: "glow"))
            out.append(Item(group: g, rect: TableLayout.nameRect(a), kind: "name"))
            out.append(Item(group: g, rect: L.bubbleRect(r), kind: "bubble"))
        }
        for r in [Rel.top, .bottom, .left, .right] { out.append(Item(group: "trick.\(r)", rect: L.trickRect(r), kind: "trick")) }
        out.append(Item(group: "handLifted", rect: handRect(L, count: 13, lifted: true), kind: "hand"))
        out.append(Item(group: "myBubble", rect: L.bubbleRect(.bottom), kind: "bubble"))
        out.append(Item(group: "history", rect: historyRect(L, count: 13), kind: "history"))
        out.append(Item(group: "accessory", rect: L.accessory, kind: "accessory"))
        out.append(Item(group: "bidBand", rect: L.bidBand, kind: "bid"))
        for (i, c) in L.cornerRects.enumerated() { out.append(Item(group: "corner\(i)", rect: c, kind: "corner")) }
        return out
    }

    static func handRect(_ L: TableLayout, count: Int, lifted: Bool) -> CGRect {
        let s = L.handScale
        let w = TableLayout.cardSize.width * s + L.handOverlap(count: count) * CGFloat(max(0, count - 1))
        let bottom = L.handBaseline.y - TableLayout.cardSize.height * s / 2
        return CGRect(x: L.handBaseline.x - w / 2, y: bottom, width: w, height: (lifted ? L.liftTop : L.handTop) - bottom)
    }

    /// The history at `count` tricks per row: icons 12x16 at (i * spacing, 0) and (i * spacing, -30).
    static func historyRect(_ L: TableLayout, count: Int) -> CGRect {
        let o = L.historyOrigin
        return CGRect(x: o.x - 6, y: o.y - 30 - 8, width: 12 + L.historySpacing * CGFloat(count - 1), height: 46)
    }

    static func exempt(_ a: Item, _ b: Item) -> Bool {
        let pair = Set([a.group, b.group])
        if a.group == b.group { return true }
        if a.kind == "corner" && b.kind == "corner" { return true }
        // never on screen together: the bid panel shows only before the hand's first card (trick empty, history 0)
        if pair.contains("bidBand") && (pair.contains { $0.hasPrefix("trick.") } || pair.contains("history") || pair.contains("accessory") || pair.contains("myBubble")) { return true }
        // my bid bubble shows only while the history is 0
        if pair == ["myBubble", "history"] { return true }
        // bid bubbles coexist only with my provisional card
        let bubble = a.kind == "bubble" ? a : (b.kind == "bubble" ? b : nil)
        let trick = a.kind == "trick" ? a : (b.kind == "trick" ? b : nil)
        if let bubble, let trick, bubble.group != "myBubble", trick.group != "trick.bottom" { return true }
        return false
    }

    static func problems(_ L: TableLayout) -> [String] {
        var out: [String] = []
        let all = items(L)
        for i in all.indices {
            for j in (i + 1)..<all.count where !exempt(all[i], all[j]) {
                let x = all[i].rect.intersection(all[j].rect)
                if !x.isNull && x.width > 0.01 && x.height > 0.01 {
                    out.append("\(all[i].group).\(all[i].kind) x \(all[j].group).\(all[j].kind) \(x)")
                }
            }
        }
        let safe = L.safeRect.insetBy(dx: -0.01, dy: -0.01)
        for it in all where it.kind != "corner" {
            let r = it.rect
            if r.minX < safe.minX || r.maxX > safe.maxX || r.minY < safe.minY || (r.maxY > L.topLimit + 0.01 && it.group != "bidBand") {
                out.append("outside \(it.group).\(it.kind) \(r)")
            }
        }
        let a = L.accessory
        if !((a.width >= 123.99 && a.height >= 47.99) || (a.width >= 83.99 && a.height >= 75.99)) { out.append("accessory \(a.size)") }
        return out
    }

    func testNoIntersections() {
        var checked = 0
        for (size, ins) in Self.listedSizes {
            for topBar in [CGFloat(70), 84] {
                for bottomBar in [CGFloat(0), 45] {
                    let L = TableLayout(size: size, chrome: Self.chrome(ins, topBar: topBar, bottomBar: bottomBar))
                    XCTAssertFalse(L.isDegraded, "\(size) \(ins) \(topBar) \(bottomBar)")
                    let p = Self.problems(L)
                    XCTAssertTrue(p.isEmpty, "\(size) \(ins) topBar \(topBar) bottomBar \(bottomBar): \(p)")
                    checked += 1
                }
            }
        }
        // folds: tabletop (horizontal division) and book (vertical), moved +-10
        for dy in [CGFloat(-10), 0, 10] {
            let table = TableLayout(size: CGSize(width: 669, height: 951),
                                    chrome: Self.chrome(Self.insets(24, 0, 20, 0), fold: CGRect(x: -334.5, y: -10 + dy, width: 669, height: 20)))
            XCTAssertTrue(Self.problems(table).isEmpty, "tabletop \(dy): \(Self.problems(table))")
            let book = TableLayout(size: CGSize(width: 951, height: 669),
                                   chrome: Self.chrome(Self.insets(0, 59, 21, 59), fold: CGRect(x: -10 + dy, y: -334.5, width: 20, height: 669)))
            XCTAssertTrue(Self.problems(book).isEmpty, "book \(dy): \(Self.problems(book))")
            checked += 2
        }
        XCTAssertEqual(checked, Self.listedSizes.count * 4 + 6)
    }

    func testNotDegradedAtListedSizes() {
        for (size, ins) in Self.listedSizes {
            for topBar in [CGFloat(0), 70, 84] {
                XCTAssertFalse(TableLayout(size: size, chrome: Self.chrome(ins, topBar: topBar)).isDegraded, "\(size) \(ins) \(topBar)")
            }
            XCTAssertFalse(TableLayout(size: size, chrome: TableChrome()).isDegraded, "\(size) zero chrome")
        }
        // known infeasible: falls back, still finite
        let tiny = TableLayout(size: CGSize(width: 320, height: 568), chrome: Self.chrome(Self.insets(20, 0, 0, 0)))
        XCTAssertTrue(tiny.isDegraded)
        XCTAssertEqual(tiny.handScale, 0.8, accuracy: 0.001)
        XCTAssertEqual(tiny.trickScale, 0.7, accuracy: 0.001)
    }

    func testHandFitsSafeWidth() {
        for (size, ins) in Self.listedSizes {
            for topBar in [CGFloat(70), 84] {
                let L = TableLayout(size: size, chrome: Self.chrome(ins, topBar: topBar))
                let allowed = L.safeRect.insetBy(dx: TableLayout.margin - 0.01, dy: 0)
                for n in 1...13 {
                    let slots = L.handSlots(count: n)
                    XCTAssertEqual(slots.count, n)
                    XCTAssertTrue(slots.allSatisfy { $0.y == 0 })
                    // slots are local (unscaled) units: scene x = baseline.x + slot.x * s
                    let s = L.handScale
                    let minX = L.handBaseline.x + (slots.first!.x - 50) * s, maxX = L.handBaseline.x + (slots.last!.x + 50) * s
                    XCTAssertGreaterThanOrEqual(minX, allowed.minX, "\(size) n \(n)")
                    XCTAssertLessThanOrEqual(maxX, allowed.maxX, "\(size) n \(n)")
                    if n > 1 {
                        XCTAssertGreaterThanOrEqual(L.handOverlap(count: n), 18 * s, "\(size) n \(n)")
                        XCTAssertEqual((slots[1].x - slots[0].x) * s, L.handOverlap(count: n), accuracy: 0.001)
                    }
                }
            }
        }
    }

    func testFuzzFiniteAndInside() {
        var degraded = 0
        for w in stride(from: CGFloat(320), through: 1400, by: 20) {
            for h in stride(from: CGFloat(320), through: 1400, by: 20) {
                for chrome in [TableChrome(), Self.chrome()] {
                    let L = TableLayout(size: CGSize(width: w, height: h), chrome: chrome)
                    if L.isDegraded { degraded += 1 }
                    let window = CGRect(x: -w / 2, y: -h / 2, width: w, height: h).insetBy(dx: -0.01, dy: -0.01)
                    var points: [CGPoint] = [L.handBaseline, L.historyOrigin, L.boreBadgeCenter, L.overTrumpCenter]
                    for r in [Rel.top, .bottom, .left, .right] {
                        points += [L.seatAnchor(r), L.trickSlot(r), L.bubbleAnchor(r), L.collectPoint(r), L.rainbowCenter(r),
                                   L.chatPosition(r, bubbleSize: CGSize(width: 200, height: 40))]
                    }
                    for p in points {
                        XCTAssertTrue(p.x.isFinite && p.y.isFinite, "\(w)x\(h) \(p)")
                        XCTAssertTrue(window.contains(p), "\(w)x\(h) \(chrome == TableChrome() ? "zero" : "std"): \(p) outside")
                    }
                    for r in [L.bidBand, L.accessory] {
                        XCTAssertTrue(r.minX.isFinite && r.maxY.isFinite)
                    }
                    let hand = Self.handRect(L, count: 13, lifted: false)
                    XCTAssertGreaterThanOrEqual(hand.minX, L.safeRect.minX + TableLayout.margin - 0.01, "\(w)x\(h)")
                    XCTAssertLessThanOrEqual(hand.maxX, L.safeRect.maxX - TableLayout.margin + 0.01, "\(w)x\(h)")
                    XCTAssertLessThanOrEqual(L.handScale, 1)
                }
            }
        }
        XCTAssertGreaterThan(degraded, 0, "small windows exercise the fallback")
    }

    func testTabletopTableAboveHandBelow() {
        for dy in [CGFloat(-10), 0, 10] {
            let fold = CGRect(x: -334.5, y: -10 + dy, width: 669, height: 20)
            let L = TableLayout(size: CGSize(width: 669, height: 951), chrome: Self.chrome(Self.insets(24, 0, 20, 0), fold: fold))
            XCTAssertFalse(L.isDegraded)
            for r in [Rel.top, .bottom, .left, .right] {
                XCTAssertGreaterThanOrEqual(L.trickRect(r).minY, fold.maxY + TableLayout.gap - 0.01, "trick \(r) above the fold")
                XCTAssertGreaterThanOrEqual(TableLayout.nameRect(L.seatAnchor(r == .bottom ? .top : r)).minY, fold.maxY, "seat above the fold")
            }
            XCTAssertLessThanOrEqual(L.liftTop, fold.minY, "hand below the fold")
            XCTAssertLessThanOrEqual(L.bidBand.maxY, fold.minY - TableLayout.gap + 0.01, "bid controls below the fold")
            XCTAssertGreaterThanOrEqual(L.accessory.minY, fold.maxY)
        }
    }

    /// A tabletop fold with no room for table-above / hand-below (the closed Duo's height) is ignored, not degraded.
    func testTabletopIgnoredWhenNoRoom() {
        let fold = CGRect(x: -233, y: -10, width: 466, height: 20)
        let L = TableLayout(size: CGSize(width: 466, height: 678), chrome: Self.chrome(Self.insets(0, 0, 34, 84), fold: fold))
        XCTAssertFalse(L.isDegraded)
        XCTAssertTrue(L.foldIgnored)
        XCTAssertEqual(L.trickSlot(.top), TableLayout(size: CGSize(width: 466, height: 678), chrome: Self.chrome(Self.insets(0, 0, 34, 84))).trickSlot(.top))
        let open = TableLayout(size: CGSize(width: 669, height: 951), chrome: Self.chrome(Self.insets(24, 0, 20, 0), fold: CGRect(x: -334.5, y: -10, width: 669, height: 20)))
        XCTAssertFalse(open.foldIgnored)
    }

    /// An undocked book fold on a narrow window: the cluster fits its page or the fold is ignored; never off-screen.
    func testBookFallbackStaysOnScreen() {
        for (size, ins) in [(CGSize(width: 466, height: 678), Self.insets(0, 0, 34, 84)), (CGSize(width: 669, height: 951), Self.insets(24, 0, 20, 0)),
                            (CGSize(width: 820, height: 1180), Self.insets(32, 0, 20, 0))] {
            let fold = CGRect(x: -10, y: -size.height / 2, width: 20, height: size.height)
            let L = TableLayout(size: size, chrome: Self.chrome(ins, fold: fold))
            XCTAssertFalse(L.isDegraded, "\(size)")
            for r in [Rel.top, .bottom, .left, .right] {
                XCTAssertTrue(L.safeRect.insetBy(dx: -0.01, dy: -0.01).contains(L.trickRect(r)), "\(size) \(r)")
                if !L.foldIgnored { XCTAssertFalse(L.trickRect(r).intersects(fold), "\(size) \(r) on the hinge") }
            }
            XCTAssertTrue(Self.problems(L).isEmpty, "\(size): \(Self.problems(L))")
        }
    }

    func testBookClusterOffHinge() {
        for dy in [CGFloat(-10), 0, 10] {
            let fold = CGRect(x: -10 + dy, y: -334.5, width: 20, height: 669)
            let L = TableLayout(size: CGSize(width: 951, height: 669), chrome: Self.chrome(Self.insets(0, 59, 21, 59), fold: fold))
            XCTAssertFalse(L.isDegraded)
            let hinge = fold.insetBy(dx: -TableLayout.gap + 0.01, dy: 0)
            for r in [Rel.top, .bottom, .left, .right] {
                XCTAssertFalse(L.trickRect(r).intersects(hinge), "trick \(r) on the hinge")
                if r != .bottom { XCTAssertFalse(L.seatFootprint(r).intersects(fold), "seat \(r) on the hinge") }
            }
        }
    }

    func testWindowAndBidInset() {
        let L = TableLayout(size: CGSize(width: 466, height: 678), chrome: Self.chrome(Self.insets(59, 0, 34, 0)))
        let w = L.window(L.bidBand)
        XCTAssertEqual(w.minX, L.bidBand.minX + 233, accuracy: 0.001)
        XCTAssertEqual(w.maxY, 678 - (L.bidBand.minY + 339), accuracy: 0.001)
        XCTAssertEqual(L.bidPanelBottomInset, L.bidBand.minY + 339, accuracy: 0.001)
    }

    // MARK: scene

    @MainActor
    private func scene(_ h: ReplayHarness, size: CGSize, chrome: TableChrome) -> GameSKScene {
        OpponentHandNode.avatarLoader = StubAvatarLoader()
        let scene = GameSKScene(size: size)
        scene.animator = InstantAnimator()
        scene.chrome = chrome
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        return scene
    }

    /// My played card (the hand's sprite, hand scaled 0.9) and a freshly built trick card have the same frame at k = 0.75.
    @MainActor
    func testTrickFrameSameForAdoptedAndFresh() throws {
        let size = CGSize(width: 375, height: 667)
        let chrome = Self.chrome(Self.insets(20, 0, 0, 0), bottomBar: 45)
        let h = ReplayHarness()
        let live = scene(h, size: size, chrome: chrome)
        XCTAssertEqual(live.layout.trickScale, 0.75, accuracy: 0.001)
        XCTAssertEqual(live.layout.handScale, 0.9, accuracy: 0.001)
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        let hand = try XCTUnwrap(TableRenderModel(h.store.state).hand)
        let card = try XCTUnwrap(hand.cards.first { hand.legalIds.contains($0.id) })
        let handSprite = try XCTUnwrap(live.handNode.sprite(for: card.id))
        XCTAssertTrue(h.actions.play(card))
        let me = try XCTUnwrap(h.store.state.table.viewer.position)
        let adopted = try XCTUnwrap(live.trickArea.sprite(named: TrickAreaNode.spriteName(me, card)))
        XCTAssertTrue(adopted === handSprite)
        let fresh = scene(ReplayHarness(), size: size, chrome: chrome)
        fresh.render(TableRenderModel(h.store.state))
        let built = try XCTUnwrap(fresh.trickArea.sprite(named: TrickAreaNode.spriteName(me, card)))
        XCTAssertFalse(built === adopted)
        XCTAssertEqual(adopted.frame.width, 60, accuracy: 0.01)
        XCTAssertEqual(adopted.frame.height, 87, accuracy: 0.01)
        XCTAssertEqual(adopted.frame.size, built.frame.size)
        XCTAssertEqual(adopted.position, built.position)
        let other = try XCTUnwrap(live.trickArea.cardSprites.first { $0 !== adopted })
        XCTAssertEqual(other.frame.size, built.frame.size)
        XCTAssertEqual(SceneDump.dump(live).filter { $0.hasPrefix("trick") }, SceneDump.dump(fresh).filter { $0.hasPrefix("trick") })
    }

    @MainActor
    func testAllLayersAtOrigin() throws {
        for (size, ins) in Self.scopeSizes {
            let h = ReplayHarness()
            let s = scene(h, size: size, chrome: Self.chrome(ins))
            h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
            for layer in [s.opponentsLayer, s.bidsLayer, s.trickArea, s.transientLayer, s.backgroundNode] as [SKNode] {
                XCTAssertEqual(layer.position, .zero, "\(size) \(layer.name ?? "?")")
            }
            XCTAssertEqual(s.handNode.position, s.layout.handBaseline)
            XCTAssertEqual(s.handNode.xScale, s.layout.handScale)
            XCTAssertEqual(s.trickManager.trickHistory.position, s.layout.historyOrigin)
        }
    }

    func testChatPositionsInsideAndOffCorners() {
        for (size, ins) in Self.listedSizes {
            let L = TableLayout(size: size, chrome: Self.chrome(ins))
            let bubble = CGSize(width: L.chatMaxWidth, height: 40)
            for r in [Rel.top, .left, .right] {
                let rect = TableLayout.rect(L.chatPosition(r, bubbleSize: bubble), bubble)
                XCTAssertTrue(L.safeRect.insetBy(dx: -0.01, dy: -0.01).contains(rect), "\(size) \(r) \(rect)")
                XCTAssertLessThanOrEqual(rect.maxY, L.topLimit + 0.01, "\(size) \(r)")
                XCTAssertFalse(L.cornerRects.contains { $0.intersects(rect) }, "\(size) \(r) on a corner button")
                XCTAssertFalse(rect.intersects(Self.handRect(L, count: 13, lifted: true)), "\(size) \(r) over my hand")
            }
        }
    }
}
