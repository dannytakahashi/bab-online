import XCTest
import CoreGraphics
import SpriteKit
@testable import BAB_Online

/// TableLayout (roadmap item 25): the pure layout, against golden values,
/// plus no-intersection, fit and fuzz checks. The rect model here (glow, name,
/// bubble, hand, history rects) is TableLayout's own; SceneLayoutTests checks
/// the same configurations, folds included, with the real nodes' frames.
///
/// The goldens are FROZEN values: they were produced by the item-25 reference
/// model (`layout_ref.py`, a planning tool kept outside the repo, which the
/// port matched when it was written) and are pinned here so a
/// change to the solver shows up as a diff. TableLayout.swift is the source of
/// truth now (item 27 added the tabletop k range, the edge-occlusion insets and
/// the 13-card step floor, which the reference model does not have); to change
/// a golden, change the solver on purpose and update the value here.
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
        (CGSize(width: 546, height: 669), insets(0, 0, 34, 0)),    // measured: open-Duo landscape pane, log docked on the right
        (CGSize(width: 455.5, height: 669), insets(0, 0, 34, 0)),  // measured: book pose, table on the left page
        (CGSize(width: 455.5, height: 669), insets(0, 84, 34, 0)), // book pose, other landscape (status column on the left)
        (CGSize(width: 466, height: 678), insets(0, 0, 34, 84)),   // measured: the closed Duo ("ui.pose"; status cluster on the right)
        (CGSize(width: 820, height: 1180), insets(32, 0, 20, 0)),  // measured: iPad Air 11-inch (M4) portrait
        (CGSize(width: 1180, height: 820), insets(32, 0, 20, 0)),  // measured: iPad Air 11-inch (M4) landscape
        // the zoomed tables (2026-11-12, TableZoomTests): iPad 13, iPad 11 and the mini, both ways
        (CGSize(width: 1032, height: 1376), insets(32, 0, 20, 0)),
        (CGSize(width: 1376, height: 1032), insets(32, 0, 20, 0)),
        (CGSize(width: 834, height: 1210), insets(32, 0, 20, 0)),
        (CGSize(width: 1210, height: 834), insets(32, 0, 20, 0)),
        (CGSize(width: 744, height: 1133), insets(32, 0, 20, 0)),
        (CGSize(width: 1133, height: 744), insets(32, 0, 20, 0)),
        (CGSize(width: 900, height: 1032), insets(32, 0, 20, 0)),   // an iPad 13 split, the wide side
    ]

    // MARK: golden (frozen; see the type comment)

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

    /// Every rect of the table at `L`: a seated player (a 13-card hand, its card lifted),
    /// or a spectator (a fourth seat at the bottom instead of the hand and HSI / voice).
    static func items(_ L: TableLayout, spectator: Bool = false) -> [Item] {
        var out: [Item] = []
        for (g, r) in [("partner", Rel.top), ("left", .left), ("right", .right)] {
            let a = L.seatAnchor(r)
            out.append(Item(group: g, rect: TableLayout.glowRect(a), kind: "glow"))
            out.append(Item(group: g, rect: TableLayout.nameRect(a), kind: "name"))
            out.append(Item(group: g, rect: L.bubbleRect(r), kind: "bubble"))
        }
        for r in [Rel.top, .bottom, .left, .right] { out.append(Item(group: "trick.\(r)", rect: L.trickRect(r), kind: "trick")) }
        if spectator {
            let a = L.seatAnchor(.bottom)
            out.append(Item(group: "bottomSeat", rect: TableLayout.glowRect(a), kind: "glow"))
            out.append(Item(group: "bottomSeat", rect: TableLayout.nameRect(a), kind: "name"))
            out.append(Item(group: "history", rect: historyRect(L, count: 13), kind: "history"))
            for (i, c) in L.cornerRects.enumerated() { out.append(Item(group: "corner\(i)", rect: c, kind: "corner")) }
            if let f = L.chrome.fold, !L.foldIgnored { out.append(Item(group: "fold", rect: f, kind: "fold")) }
            return out
        }
        out.append(Item(group: "handLifted", rect: handRect(L, count: 13, lifted: true), kind: "hand"))
        out.append(Item(group: "myBubble", rect: L.bubbleRect(.bottom), kind: "bubble"))
        out.append(Item(group: "history", rect: historyRect(L, count: 13), kind: "history"))
        out.append(Item(group: "accessory", rect: L.accessory, kind: "accessory"))
        out.append(Item(group: "bidBand", rect: L.bidBand, kind: "bid"))
        for (i, c) in L.cornerRects.enumerated() { out.append(Item(group: "corner\(i)", rect: c, kind: "corner")) }
        if let f = L.chrome.fold, !L.foldIgnored { out.append(Item(group: "fold", rect: f, kind: "fold")) }
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
        if pair.contains("fold") {
            // a fold may cross the corner buttons' strip; in book pose (an undocked vertical
            // hinge) the hand, the bid band, the history and HSI / voice may span it: only
            // the trick cluster and the seats (the bottom one included) must avoid it
            let fold = a.group == "fold" ? a : b, other = a.group == "fold" ? b : a
            if other.kind == "corner" { return true }
            if fold.rect.height > fold.rect.width,
               ["hand", "bid", "history", "accessory"].contains(other.kind) || other.group == "myBubble" { return true }
        }
        // never on screen together: the bid panel shows only before the hand's first card (trick empty, history 0)
        if pair.contains("bidBand") && (pair.contains { $0.hasPrefix("trick.") } || pair.contains("history") || pair.contains("accessory") || pair.contains("myBubble")) { return true }
        // every bid bubble shows only while the history is 0 (TableInvariantTests)
        if pair.contains("history") && (a.kind == "bubble" || b.kind == "bubble") { return true }
        // bid bubbles coexist only with my provisional card
        let bubble = a.kind == "bubble" ? a : (b.kind == "bubble" ? b : nil)
        let trick = a.kind == "trick" ? a : (b.kind == "trick" ? b : nil)
        if let bubble, let trick, bubble.group != "myBubble", trick.group != "trick.bottom" { return true }
        return false
    }

    static func problems(_ L: TableLayout, spectator: Bool = false) -> [String] {
        var out: [String] = []
        let all = items(L, spectator: spectator)
        for i in all.indices {
            for j in (i + 1)..<all.count where !exempt(all[i], all[j]) {
                let x = all[i].rect.intersection(all[j].rect)
                if !x.isNull && x.width > 0.01 && x.height > 0.01 {
                    out.append("\(all[i].group).\(all[i].kind) x \(all[j].group).\(all[j].kind) \(x)")
                }
            }
        }
        let safe = L.safeRect.insetBy(dx: -0.01, dy: -0.01)
        for it in all where it.kind != "corner" && it.kind != "fold" {
            let r = it.rect
            if r.minX < safe.minX || r.maxX > safe.maxX || r.minY < safe.minY || (r.maxY > L.topLimit + 0.01 && it.group != "bidBand") {
                out.append("outside \(it.group).\(it.kind) \(r)")
            }
        }
        if spectator { return out }
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
        // folds TableLayout really receives (GameContainerView docks the log on a book fold
        // at 951 x 669, so that one never reaches it): whichever way the Duo's hinge runs,
        // portrait 669 x 951 is tabletop or an undocked book, landscape 951 x 669 (and the
        // pane beside the side panel) is tabletop. Seated and spectating.
        for (fold, size, ins, topBar) in Self.reachableFolds {
            for spectator in [false, true] {
                let L = TableLayout(size: size, chrome: Self.chrome(ins, topBar: topBar, bottomBar: spectator ? 45 : 0, fold: fold))
                let tag = "\(size) fold \(fold) topBar \(topBar) spectator \(spectator)"
                XCTAssertFalse(L.isDegraded, tag)
                XCTAssertFalse(L.foldIgnored, tag)
                let p = Self.problems(L, spectator: spectator)
                XCTAssertTrue(p.isEmpty, "\(tag): \(p)")
                checked += 1
            }
        }
        XCTAssertEqual(checked, Self.listedSizes.count * 4 + Self.reachableFolds.count * 2)
    }

    /// (fold, size, insets, topBar): the folds the app hands TableLayout, the hinge moved +-10
    /// in portrait; topBar 70 and the measured 75.5 (at 84 a landscape tabletop is ignored, below).
    static var reachableFolds: [(CGRect, CGSize, TableInsets, CGFloat)] {
        var out: [(CGRect, CGSize, TableInsets, CGFloat)] = []
        let portrait = CGSize(width: 669, height: 951), pIns = insets(24, 0, 20, 0)
        for topBar in [CGFloat(70), 75.5] {
            for dy in [CGFloat(-10), 0, 10] {
                out.append((CGRect(x: -334.5, y: -10 + dy, width: 669, height: 20), portrait, pIns, topBar))   // tabletop
                out.append((CGRect(x: -10 + dy, y: -475.5, width: 20, height: 951), portrait, pIns, topBar))   // book, undocked
            }
            out.append((CGRect(x: -475.5, y: -10, width: 951, height: 20), CGSize(width: 951, height: 669), insets(0, 59, 21, 59), topBar))
            // synthetic: on the Duo a landscape division is vertical (book, measured 2026-11-09), so this
            // landscape tabletop beside the side panel is not reachable there; kept to exercise the split
            out.append((CGRect(x: -286, y: -10, width: 572, height: 20), CGSize(width: 572, height: 669), insets(0, 0, 21, 59), topBar))
        }
        return out
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
        for (fold, size, ins, topBar) in Self.reachableFolds where fold.width > fold.height {
            let L = TableLayout(size: size, chrome: Self.chrome(ins, topBar: topBar, fold: fold))
            XCTAssertFalse(L.isDegraded)
            XCTAssertFalse(L.foldIgnored, "\(size) \(fold)")
            for r in [Rel.top, .bottom, .left, .right] {
                XCTAssertGreaterThanOrEqual(L.trickRect(r).minY, fold.maxY + TableLayout.gap - 0.01, "trick \(r) above the fold")
                XCTAssertGreaterThanOrEqual(TableLayout.nameRect(L.seatAnchor(r == .bottom ? .top : r)).minY, fold.maxY, "seat above the fold")
            }
            XCTAssertLessThanOrEqual(L.liftTop, fold.minY, "hand below the fold")
            XCTAssertLessThanOrEqual(L.bidBand.maxY, fold.minY - TableLayout.gap + 0.01, "bid controls below the fold")
            XCTAssertGreaterThanOrEqual(L.accessory.minY, fold.maxY)
            if size.width > size.height {
                // the short landscape split takes the smaller trick cards, never below k = 0.6
                XCTAssertGreaterThanOrEqual(L.trickScale, 0.6 - 0.001)
            }
        }
        // the largest capped ScoreBar (84) leaves no room above a landscape hinge: the fold is ignored, not degraded
        let tall = TableLayout(size: CGSize(width: 951, height: 669),
                               chrome: Self.chrome(Self.insets(0, 59, 21, 59), topBar: 84, fold: CGRect(x: -475.5, y: -10, width: 951, height: 20)))
        XCTAssertFalse(tall.isDegraded)
        XCTAssertTrue(tall.foldIgnored)
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

    /// The undocked book fold (open portrait, pages too narrow to dock the log): the
    /// cluster and every seat, a spectator's bottom seat included, stay off the hinge.
    func testBookClusterOffHinge() {
        for (fold, size, ins, topBar) in Self.reachableFolds where fold.height > fold.width {
            for pill in [CGFloat(0), 45] {
                let L = TableLayout(size: size, chrome: Self.chrome(ins, topBar: topBar, bottomBar: pill, fold: fold))
                XCTAssertFalse(L.isDegraded)
                XCTAssertFalse(L.foldIgnored)
                let hinge = fold.insetBy(dx: -TableLayout.gap + 0.01, dy: 0)
                for r in [Rel.top, .bottom, .left, .right] {
                    XCTAssertFalse(L.trickRect(r).intersects(hinge), "\(fold) trick \(r) on the hinge")
                    XCTAssertFalse(L.seatFootprint(r).intersects(fold), "\(fold) seat \(r) on the hinge")
                }
                // the bottom seat sits under the cluster, on the same page
                XCTAssertEqual(L.seatAnchor(.bottom).x, L.trickSlot(.bottom).x, accuracy: 0.001)
            }
        }
    }

    /// A full-height system strip on an edge (the iPad's 32 pt occlusion in landscape) is an
    /// inset, not a corner obstacle; an occlusion in the top quarter joins the corner only there.
    func testOcclusions() {
        let size = CGSize(width: 1180, height: 820), ins = Self.insets(32, 0, 20, 0)
        let plain = TableLayout(size: size, chrome: Self.chrome(ins, topBar: 75.5, corner: CGSize(width: 80, height: 50.5)))
        var c = Self.chrome(ins, topBar: 75.5, corner: CGSize(width: 80, height: 50.5))
        c.occlusions = [CGRect(x: -590, y: -410, width: 32, height: 820)]
        let strip = TableLayout(size: size, chrome: c)
        // the iPad's table is zoomed (scene units = points / zoom); the strip keeps its zoom
        XCTAssertGreaterThan(plain.zoom, 1)
        XCTAssertEqual(strip.zoom, plain.zoom)
        let z = strip.zoom
        XCTAssertEqual(strip.paneOccludedLeft, 32, accuracy: 0.001)
        XCTAssertEqual(strip.occludedLeft, 32 / z, accuracy: 0.001)
        XCTAssertEqual(strip.occludedRight, 0)
        XCTAssertEqual(strip.window(strip.safeRect).minX, 32, accuracy: 0.001, "the safe rect starts at the strip, in points")
        XCTAssertEqual(strip.safeRect.minX, plain.safeRect.minX + 32 / z, accuracy: 0.001)
        XCTAssertEqual(strip.cornerRects[0].minX, plain.cornerRects[0].minX + 32 / z, accuracy: 0.001)
        XCTAssertEqual(strip.cornerRects[0].height, plain.cornerRects[0].height, accuracy: 0.001, "the strip does not grow the corner")
        XCTAssertFalse(strip.isDegraded)
        XCTAssertTrue(Self.problems(strip).isEmpty, "\(Self.problems(strip))")
        // a small occlusion near the top right: only its part in the top quarter counts
        c.occlusions = [CGRect(x: 400, y: 0, width: 60, height: 400)]
        let top = TableLayout(size: size, chrome: c)
        XCTAssertEqual(top.occludedRight, 0)
        let quarterBottom = top.safeRect.maxY - top.safeRect.height / 4
        XCTAssertEqual(top.cornerRects[1].minY, min(plain.cornerRects[1].minY, quarterBottom), accuracy: 0.001)
    }

    /// A 320 pt window (iPad Slide Over) takes a smaller hand scale before the 13-card step drops under 18 s.
    func testNarrowWindowKeepsTheHandStep() {
        let L = TableLayout(size: CGSize(width: 320, height: 1180), chrome: Self.chrome(Self.insets(32, 0, 20, 0)))
        XCTAssertFalse(L.isDegraded)
        XCTAssertLessThan(L.handScale, 1)
        XCTAssertGreaterThanOrEqual(L.handOverlap(count: 13), 18 * L.handScale - 0.001)
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
            XCTAssertNear(s.handNode.position, s.layout.handBaseline)
            XCTAssertEqual(s.handNode.xScale, s.layout.handScale)
            XCTAssertNear(s.trickManager.trickHistory.position, s.layout.historyOrigin)
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
