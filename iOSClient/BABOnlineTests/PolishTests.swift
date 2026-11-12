import XCTest
import SpriteKit
import SwiftUI
@testable import BAB_Online

/// 1.2.0 (3) polish: the seat pips keep off every name and initial, my pips keep
/// 8 pt off the trick piles, the box rows balance, the spectator chat bubble
/// keeps off the bottom pill and the badge, and VoiceOver reads the counts
/// (not the scene's drawing nodes).
@MainActor
final class PolishLayoutTests: XCTestCase {
    typealias Rel = Positions.RelativePosition

    /// The devices the polish pass checks, with their measured (or the device's) insets and chrome.
    static let devices: [(String, CGSize, TableInsets)] = [
        ("iPhone 17e", CGSize(width: 390, height: 844), TableLayoutTests.insets(47, 0, 34, 0)),
        ("iPhone SE size",CGSize(width: 375, height: 667), TableLayoutTests.insets(20, 0, 0, 0)),
        ("iPhone Pro Max", CGSize(width: 440, height: 956), TableLayoutTests.insets(62, 0, 34, 0)),
        ("iPad 13 portrait", CGSize(width: 1032, height: 1376), TableLayoutTests.insets(24, 0, 20, 0)),
        ("iPad 13 landscape", CGSize(width: 1376, height: 1032), TableLayoutTests.insets(24, 0, 20, 0)),
        ("Duo closed", CGSize(width: 466, height: 678), TableLayoutTests.insets(0, 0, 34, 84)),
        ("Duo open", CGSize(width: 669, height: 951), TableLayoutTests.insets(24, 0, 20, 0)),
        ("Duo open landscape", CGSize(width: 951, height: 669), TableLayoutTests.insets(0, 59, 21, 59)),
        ("Duo open landscape, log docked", CGSize(width: 546, height: 669), TableLayoutTests.insets(0, 0, 34, 0)),
    ]

    static func chrome(_ ins: TableInsets, bottomBar: CGFloat = 0, topBar: CGFloat = 75.5) -> TableChrome {
        TableChrome(safeArea: ins, topBar: topBar, cornerButton: CGSize(width: 80, height: 50.5), bottomBar: bottomBar)
    }

    func makeScene(_ h: ReplayHarness, size: CGSize, chrome: TableChrome) -> GameSKScene {
        let scene = GameSKScene(size: size)
        scene.animator = InstantAnimator()
        scene.chrome = chrome
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        return scene
    }

    /// `r` (in `n`'s coordinates) in scene coordinates.
    func toScene(_ r: CGRect, from n: SKNode, _ scene: SKScene) -> CGRect {
        let a = n.convert(CGPoint(x: r.minX, y: r.minY), to: scene), b = n.convert(CGPoint(x: r.maxX, y: r.maxY), to: scene)
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }

    func hit(_ a: CGRect, _ b: CGRect) -> Bool { TableLayout.overlaps(a, b) }

    // MARK: 1. seat pips vs names and initials

    /// Every seat's name label and avatar initial, in scene coordinates.
    func textRects(_ scene: GameSKScene) -> [(String, CGRect)] {
        var out: [(String, CGRect)] = []
        for (pos, seat) in scene.opponentManager.nodes {
            for c in seat.children {
                if let l = c as? SKLabelNode { out.append(("seat \(pos) name \(l.text ?? "")", toScene(l.frame, from: seat, scene))) }
            }
            seat.enumerateChildNodes(withName: "//avatar_initial") { n, _ in
                guard let l = n as? SKLabelNode, let p = l.parent else { return }
                out.append(("seat \(pos) initial", self.toScene(l.frame, from: p, scene)))
            }
        }
        return out
    }

    /// What a seat's pips draw, in scene coordinates: each dot's rect, and the bore arc's stroke as small squares.
    func pipRects(_ seat: OpponentHandNode, _ scene: GameSKScene) -> [CGRect] {
        var out: [CGRect] = []
        for c in seat.pipsNode.children {
            if c.role?.hasPrefix("pip.") == true {
                out.append(toScene(c.frame, from: seat.pipsNode, scene))
            } else if c.role == "pips.bore" {
                // the stroke: points along the arc, each with the half line width (a round cap at the ends)
                let half = TableLayout.seatArcHalfSpan, R = TableLayout.seatBoreRadius, w = TableLayout.seatBoreLine / 2
                for i in 0...200 {
                    let a = -half + 2 * half * CGFloat(i) / 200
                    let p = CGPoint(x: R * sin(a), y: R * cos(a))
                    out.append(toScene(CGRect(x: p.x - w, y: p.y - w, width: 2 * w, height: 2 * w), from: seat.pipsNode, scene))
                }
            }
        }
        return out
    }

    func testSeatPipsNeverOverlapANameOrInitialOnEveryDevice() throws {
        OpponentHandNode.avatarLoader = StubAvatarLoader()
        let names = ["kim", "Kj", "\u{00C5}\u{00C9}\u{00CE}", "gyp", "\u{1F916} Mary", "Wolfgang Amadeus Mozart"]
        var checked = 0
        for (device, size, ins) in Self.devices {
            for fixture in ["trick-mid-lead3", "spectator-mid-hand"] {
                let pill: CGFloat = fixture == "spectator-mid-hand" ? 45 : 0
                let h = ReplayHarness()
                let scene = makeScene(h, size: size, chrome: Self.chrome(ins, bottomBar: pill))
                h.store.apply(.snapshot(try T.snapshot(fixture), .rejoin, hints: nil))
                let seats = scene.opponentManager.nodes
                XCTAssertEqual(seats.count, fixture == "spectator-mid-hand" ? 4 : 3)
                for (i, name) in names.enumerated() {
                    for (pos, seat) in seats { seat.updateUsername(names[(i + pos) % names.count]) }
                    let texts = textRects(scene)
                    // bids 0...13 (a 0 bid that won tricks too) and a bore of every hand size
                    for need in 0...13 {
                        for won in Set([0, need / 2, need, 13]) {
                            for bore in [false, true] where !(bore && need == 0) {
                                for (pos, seat) in seats {
                                    seat.setPips(SeatPips(need: need, won: won, isBore: bore, countsTeam: bore), team: pos % 2 == 1 ? 1 : 2)
                                }
                                for (pos, seat) in seats {
                                    for r in pipRects(seat, scene) {
                                        for (what, t) in texts where hit(r, t) {
                                            XCTFail("\(device) \(fixture) \(name): seat \(pos) pips (need \(need) won \(won) bore \(bore)) \(r) over \(what) \(t)")
                                            return
                                        }
                                    }
                                }
                                checked += 1
                            }
                        }
                    }
                }
            }
        }
        XCTAssertGreaterThan(checked, 3000)
    }

    /// The ring is a horseshoe: no dot and no part of the bore outline below the floor, every
    /// count's dots apart from each other, symmetric about the top.
    func testRingGeometry() {
        for n in 1...13 {
            let dots = TableLayout.seatPipDots(n)
            XCTAssertEqual(dots.count, n)
            for d in dots { XCTAssertGreaterThanOrEqual(d.y - TableLayout.pipDot / 2, TableLayout.seatPipFloor - 0.001, "\(n)") }
            for (a, b) in zip(dots, dots.dropFirst()) {
                XCTAssertGreaterThanOrEqual(hypot(a.x - b.x, a.y - b.y), TableLayout.pipDot + 2, "\(n): dots touch")
            }
            XCTAssertEqual(dots.first!.x, -dots.last!.x, accuracy: 0.001)
        }
        let path = SeatPipsNode.boreArc()
        XCTAssertGreaterThanOrEqual(path.boundingBoxOfPath.minY - TableLayout.seatBoreLine / 2, TableLayout.seatPipFloor - 0.001)
    }

    // MARK: 2. my pips keep 8 pt from the trick piles

    /// The gap between two rects (0 when they touch or overlap).
    static func gap(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let dx = max(0, max(a.minX - b.maxX, b.minX - a.maxX)), dy = max(0, max(a.minY - b.maxY, b.minY - a.maxY))
        return max(dx, dy)
    }

    func testMyPipsBoxKeepsEightPointsFromThePiles() {
        var configs: [(String, TableLayout)] = []
        for (device, size, ins) in Self.devices {
            for topBar in [CGFloat(70), 75.5, 84] {
                configs.append(("\(device) topBar \(topBar)", TableLayout(size: size, chrome: Self.chrome(ins, topBar: topBar))))
            }
        }
        for (size, ins) in TableLayoutTests.listedSizes {
            configs.append(("\(size) \(ins)", TableLayout(size: size, chrome: TableLayoutTests.chrome(ins))))
        }
        for (size, chrome) in SceneLayoutTests.measured { configs.append(("measured \(size)", TableLayout(size: size, chrome: chrome))) }
        for (fold, size, ins, topBar) in TableLayoutTests.reachableFolds {
            configs.append(("\(size) fold \(fold)", TableLayout(size: size, chrome: TableLayoutTests.chrome(ins, topBar: topBar, fold: fold))))
        }
        for (tag, L) in configs where !L.isDegraded {
            let pile = L.historyRect.insetBy(dx: -TrickHistoryNode.borderPad, dy: -TrickHistoryNode.borderPad)
            XCTAssertGreaterThanOrEqual(Self.gap(L.myPips, pile), TableLayout.myPipsPileGap - 0.01, "\(tag): my pips \(L.myPips) pile \(pile)")
            XCTAssertEqual(MyPipsLayoutTests.problems(L), [], tag)
        }
    }

    /// On the scene: the drawn pill (8 and 13 slots, a bore's outline) and the drawn piles (13 slots each, borders).
    func testDrawnPillKeepsEightPointsFromTheDrawnPiles() throws {
        OpponentHandNode.avatarLoader = StubAvatarLoader()
        for (device, size, ins) in Self.devices {
            let h = ReplayHarness()
            let scene = makeScene(h, size: size, chrome: Self.chrome(ins))
            h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
            let hist = scene.trickManager.trickHistory
            hist.setCounts(team: 6, opp: 7, spacing: scene.layout.historySpacing, totals: .some((team: 13, opp: 13)))
            let pile = toScene(hist.calculateAccumulatedFrame(), from: hist.parent!, scene)
            for n in [1, 7, 8, 9, 12, 13] {
                scene.myPipsNode.update(SeatPips(need: n, won: n / 2, isBore: n == 8, countsTeam: n == 8), team: 1)
                let pill = toScene(scene.myPipsNode.calculateAccumulatedFrame(), from: scene.myPipsNode.parent!, scene)
                XCTAssertGreaterThanOrEqual(Self.gap(pill, pile), TableLayout.myPipsPileGap - 0.01, "\(device) \(n) slots: pill \(pill) pile \(pile)")
            }
        }
    }

    // MARK: 3. balanced rows

    func testBoxRowsBalance() {
        for n in 1...13 {
            let rows = TableLayout.myPipRows(n)
            XCTAssertEqual(rows.reduce(0, +), n)
            XCTAssertLessThanOrEqual(rows.count, 2)
            XCTAssertLessThanOrEqual((rows.max() ?? 0) - (rows.min() ?? 0), 1, "\(n): \(rows)")
            if n <= 7 { XCTAssertEqual(rows, [n]) }
            XCTAssertEqual(TableLayout.myPipDots(n).count, n)
            // fits the box
            let pill = TableLayout.myPipsPill(n), box = TableLayout.myPipsSize
            XCTAssertLessThanOrEqual(pill.width, box.width)
            XCTAssertLessThanOrEqual(pill.height, box.height)
        }
        XCTAssertEqual(TableLayout.myPipRows(8), [4, 4])
        XCTAssertEqual(TableLayout.myPipRows(9), [5, 4])
        XCTAssertEqual(TableLayout.myPipRows(13), [7, 6])
        // the 8-slot row: two rows of four dots (y), four columns (x)
        let dots = TableLayout.myPipDots(8)
        XCTAssertEqual(Set(dots.map { $0.y }).count, 2)
        XCTAssertEqual(dots.filter { $0.y > 0 }.count, 4)
        XCTAssertEqual(Set(dots.map { ($0.x * 10).rounded() }).count, 4)
    }

    // MARK: 4. chat bubbles keep off the bottom pill and the badge

    static let spectatorLines = ["lou: that bore is still alive!", "Wolfgang_Amadeus_20: " + String(repeating: "wow ", count: 10) + "end"]

    func testSpectatorBubbleKeepsOffThePillAndTheBadge() {
        var checked = 0
        for (device, size, ins) in Self.devices {
            for spectating in [true, false] {
                for topBar in [CGFloat(70), 84] {
                    let L = TableLayout(size: size, chrome: Self.chrome(ins, bottomBar: spectating ? 45 : 0, topBar: topBar))
                    let badge = L.spectatorBadge(spectating: spectating)
                    for line in Self.spectatorLines {
                        let (_, bsize) = SKChatBubbleManager.makeBubble(line, maxWidth: min(L.chatMaxWidth, SKChatBubbleManager.spectatorMaxWidth),
                                                                         name: "t", fill: .black, text: .white, limit: 60)
                        let c = L.spectatorBubbleCenter(badge: badge, bubbleSize: bsize, spectating: spectating)
                        let r = TableLayout.rect(c, bsize)
                        let tag = "\(device) spectating \(spectating) topBar \(topBar) \"\(line.prefix(12))\" \(r)"
                        XCTAssertFalse(hit(r, L.bottomBarRect), "\(tag): under the pill \(L.bottomBarRect)")
                        XCTAssertFalse(hit(r, badge), "\(tag): over the badge \(badge)")
                        XCTAssertTrue(L.safeRect.insetBy(dx: -0.01, dy: -0.01).contains(r), "\(tag): outside the safe rect")
                        XCTAssertLessThanOrEqual(r.maxY, L.topLimit + 0.01, "\(tag): under the score bar")
                        checked += 1
                    }
                }
            }
        }
        XCTAssertEqual(checked, Self.devices.count * 8)
    }

    /// The Pro Max case: "lou: that bore is still alive!" while spectating stayed under "Spectating / Exit".
    func testProMaxSpectatorLineIsAboveThePill() {
        let L = TableLayout(size: CGSize(width: 440, height: 956), chrome: Self.chrome(TableLayoutTests.insets(62, 0, 34, 0), bottomBar: 45))
        let badge = L.spectatorBadge(spectating: true)
        let (_, size) = SKChatBubbleManager.makeBubble(Self.spectatorLines[0], maxWidth: 200, name: "t", fill: .black, text: .white, limit: 45)
        let r = TableLayout.rect(L.spectatorBubbleCenter(badge: badge, bubbleSize: size, spectating: true), size)
        XCTAssertGreaterThanOrEqual(r.minY, L.bottomBarRect.maxY - 0.01)
        XCTAssertFalse(hit(r, badge))
        for rel in [Rel.top, .left, .right, .bottom] { XCTAssertFalse(hit(r, L.seatFootprint(rel)), "\(rel)") }
    }

    /// A seat's chat bubble keeps off the pill too (its last resort clamps above it).
    func testSeatChatBubblesKeepOffThePill() {
        for (device, size, ins) in Self.devices {
            let L = TableLayout(size: size, chrome: Self.chrome(ins, bottomBar: 45))
            for line in ["gl", "that bore is still alive and so is the next one!"] {
                let (_, bsize) = SKChatBubbleManager.makeBubble(line, maxWidth: L.chatMaxWidth, name: "t", fill: .black, text: .white)
                for rel in [Rel.top, .left, .right, .bottom] {
                    let r = TableLayout.rect(L.chatPosition(rel, bubbleSize: bsize), bsize)
                    XCTAssertFalse(hit(r, L.bottomBarRect), "\(device) \(rel) \(r)")
                    XCTAssertTrue(L.safeRect.insetBy(dx: -0.01, dy: -0.01).contains(r), "\(device) \(rel) \(r)")
                }
            }
        }
    }

    /// Long text wraps to at most two lines and ends with an ellipsis, never a cut-off third line.
    func testLongBubbleTextTruncatesCleanly() {
        let long = "Wolfgang_Amadeus_20: " + String(repeating: "abcdefghij ", count: 8)
        let (node, size) = SKChatBubbleManager.makeBubble(long, maxWidth: 200, name: "t", fill: .black, text: .white, limit: 21 + 40)
        let label = node.children.compactMap { $0 as? SKLabelNode }.first!
        XCTAssertTrue(label.text!.hasSuffix("\u{2026}"))
        XCTAssertLessThanOrEqual(label.frame.height, 2 * 13 * 1.35, "at most two lines: \(label.frame)")
        XCTAssertLessThanOrEqual(size.width, 200.01)
        // the text stays inside its bubble (the bubble is centred on its origin)
        XCTAssertTrue(CGRect(origin: CGPoint(x: -size.width / 2, y: -size.height / 2), size: size)
            .insetBy(dx: -0.5, dy: -0.5).contains(node.calculateAccumulatedFrame()), "the text inside its bubble \(label.frame)")
    }
}

/// The tournament lobby's capped list fades only while more is below.
final class CappedListFadeTests: XCTestCase {
    func testFadesOnlyWhileMoreIsBelow() {
        typealias C = CappedAboveChat<EmptyView, EmptyView>
        XCTAssertTrue(C.hasMoreBelow(contentHeight: 700, visibleMaxY: 260))   // 8 rows, the top shown
        XCTAssertFalse(C.hasMoreBelow(contentHeight: 700, visibleMaxY: 700))  // scrolled to the end
        XCTAssertFalse(C.hasMoreBelow(contentHeight: 240, visibleMaxY: 240.3)) // it all fits
        XCTAssertGreaterThan(C.fadeHeight, 0)
    }
}

/// VoiceOver: the counts' words, and the scene's drawing nodes are not elements.
@MainActor
final class PolishAccessibilityTests: XCTestCase {
    func testTrickWordsAndTheZeroBid() {
        XCTAssertEqual(SeatPips(need: 1, won: 0, isBore: false, countsTeam: false).accessibilityLabel, "0 of 1 trick")
        XCTAssertEqual(SeatPips(need: 1, won: 1, isBore: false, countsTeam: false).accessibilityLabel, "1 of 1 trick")
        XCTAssertEqual(SeatPips(need: 2, won: 1, isBore: false, countsTeam: false).accessibilityLabel, "1 of 2 tricks")
        XCTAssertEqual(SeatPips(need: 1, won: 0, isBore: false, countsTeam: true).accessibilityLabel, "Team 0 of 1 trick")
        XCTAssertEqual(SeatPips(need: 5, won: 2, isBore: false, countsTeam: true).accessibilityLabel, "Team 2 of 5 tricks")
        XCTAssertEqual(SeatPips(need: 0, won: 0, isBore: false, countsTeam: false).accessibilityLabel, "Bid 0, no tricks")
        XCTAssertEqual(SeatPips(need: 0, won: 1, isBore: false, countsTeam: false).accessibilityLabel, "Bid 0, 1 trick")
        XCTAssertEqual(SeatPips(need: 0, won: 2, isBore: false, countsTeam: false).accessibilityLabel, "Bid 0, 2 tricks")
        XCTAssertEqual(SeatPips(need: 4, won: 1, isBore: true, countsTeam: true).accessibilityLabel, "Team 1 of 4, bore")
        XCTAssertEqual(ScoreBarView.bidAccessibilityLabel("B/1"), "Bid B/1")
    }

    /// A seat that bid 0 and has no tricks draws nothing but is still spoken.
    func testZeroBidSeatIsSpoken() throws {
        let snap = try T.snapshot("trick-mid-lead3") { raw in
            var bids = raw["bids"] as! [String: Any]
            bids["byPosition"] = ["2", "0", "4", "1"]
            bids["teamBids"] = ["team1": 6, "team2": 1]
            raw["bids"] = bids
        }
        let s = TableReducer.state(from: snap, hints: nil, previous: nil, source: .rejoin)
        let model = TableRenderModel(s)
        XCTAssertNil(model.pips[2], "no slots drawn")
        XCTAssertEqual(model.spokenPips[2]?.accessibilityLabel, "Bid 0, no tricks")
        XCTAssertEqual(model.spokenPips[3]?.accessibilityLabel, "0 of 4 tricks")
        XCTAssertEqual(model.spokenPips[4]?.accessibilityLabel, "0 of 1 trick")
        XCTAssertEqual(Set(model.spokenPips.keys), [1, 2, 3, 4])
        XCTAssertEqual(model.mySpokenPips?.accessibilityLabel, "0 of 2 tricks")
    }

    func testDrawingNodesAreNotAccessibilityElements() throws {
        OpponentHandNode.avatarLoader = StubAvatarLoader()
        let h = ReplayHarness()
        let size = CGSize(width: 440, height: 956)
        let scene = GameSKScene(size: size)
        scene.animator = InstantAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3") { raw in
            var bids = raw["bids"] as! [String: Any]
            bids["byPosition"] = ["B", "1", "4", "1"]
            raw["bids"] = bids
            raw["tricks"] = ["team1": 2, "team2": 1]
            raw["tricksByPosition"] = [1, 1, 1, 0]
        }, .rejoin, hints: nil))
        var roots: [SKNode] = [scene.myPipsNode, scene.trickManager.trickHistory]
        roots += scene.opponentManager.nodes.values.map { $0.pipsNode }
        var count = 0
        for root in roots {
            for n in [root] + Self.descendants(root) {
                // SpriteKit lists a named node in the accessibility tree under its name
                XCTAssertNil(n.name, "\(n.role ?? "?") is named")
                XCTAssertNotNil(n.role)
                XCTAssertFalse(n.isAccessibilityElement, n.role ?? "?")
                XCTAssertTrue(n.accessibilityElementsHidden, n.role ?? "?")
                count += 1
            }
        }
        XCTAssertGreaterThan(count, 30)
        XCTAssertTrue(Self.descendants(scene.trickManager.trickHistory).contains { $0.role?.contains("slot") == true })
        XCTAssertTrue(Self.descendants(scene.myPipsNode).contains { $0.role == "pips.bore" })
    }

    static func descendants(_ n: SKNode) -> [SKNode] { n.children.flatMap { [$0] + descendants($0) } }

    /// The decorative icons inside labelled controls are hidden from VoiceOver (the XCUITest tree
    /// still lists hidden children on iOS 27, so this reads the source, as AccessibilityLabelSourceTests).
    func testDecorativeIconsAreHidden() throws {
        let views = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("BABOnline/Views/Game")
        for (file, symbol) in [("GameContainerView.swift", "rectangle.portrait.and.arrow.right"), ("ScoreBarView.swift", "target")] {
            let lines = try String(contentsOf: views.appendingPathComponent(file), encoding: .utf8).components(separatedBy: "\n")
            let uses = lines.indices.filter { lines[$0].contains("Image(systemName: \"\(symbol)\")") }
            XCTAssertFalse(uses.isEmpty, file)
            for i in uses {
                XCTAssertTrue(lines[i + 1].contains(".accessibilityHidden(true)"), "\(file):\(i + 1) \(symbol) is not hidden")
            }
            XCTAssertFalse(lines.contains { $0.contains("systemImage: \"\(symbol)\"") }, "\(file): a Label(systemImage:) reads the symbol's name")
        }
    }
}
