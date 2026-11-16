import XCTest
import SpriteKit
@testable import BAB_Online

/// iOS 1.2.2: opponent card backs and the dealer marker (TableLayout+Fans.swift,
/// SeatExtrasNode.swift), placed from the solved layout without changing it.
@MainActor
final class SeatExtrasTests: XCTestCase {
    typealias Rel = Positions.RelativePosition

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    /// (name, size, chrome, the fan scale seated, spectating; nil: no room for every seat's fan at any scale).
    static let devices: [(String, CGSize, TableChrome, CGFloat?, CGFloat?)] = {
        let ch = PolishLayoutTests.chrome
        let i = TableLayoutTests.insets
        return [
            ("iPhone SE size", CGSize(width: 375, height: 667), ch(i(20, 0, 0, 0), 0, 75.5), 0.62, 0.62),
            ("iPhone 17e", CGSize(width: 390, height: 844), ch(i(47, 0, 34, 0), 0, 75.5), 0.62, 0.62),
            ("iPhone 17 Pro", CGSize(width: 402, height: 874), ch(i(62, 0, 34, 0), 0, 75.5), 0.62, 0.62),
            ("iPhone Pro Max", CGSize(width: 440, height: 956), ch(i(62, 0, 34, 0), 0, 75.5), 0.62, 0.62),
            ("iPad 13 portrait", CGSize(width: 1032, height: 1376), ch(i(24, 0, 20, 0), 0, 75.5), 1.3, 1),
            ("iPad 13 landscape", CGSize(width: 1376, height: 1032), ch(i(24, 0, 20, 0), 0, 75.5), 1.3, 1),
            ("iPad Air 11 portrait (measured)", SceneLayoutTests.measured[1].0, SceneLayoutTests.measured[1].1, 1, 1),
            ("iPad Air 11 landscape (measured)", SceneLayoutTests.measured[2].0, SceneLayoutTests.measured[2].1, 1.3, 1),
            ("Duo closed (measured)", SceneLayoutTests.measured[0].0, SceneLayoutTests.measured[0].1, 0.62, 0.62),
            // the closed Duo as the app runs today (iOS 27.1+, live probe 2026-11-16): Leave and the
            // log in the vertical bar, so no corner buttons and a 70 pt score bar; the seats sit
            // higher and the top seat's beside-the-avatar spot touches the left seat's only one
            ("Duo closed, vertical bar (probed)", CGSize(width: 466, height: 678), TableChrome(safeArea: i(0, 0, 34, 84), topBar: 70), 0.62, 0.62),
            ("Duo open, corner buttons", CGSize(width: 669, height: 951),
             TableChrome(safeArea: i(82, 0, 34, 0), topBar: 75.5, cornerButton: CGSize(width: 80, height: 50.5)), 1.3, 1),
            ("Duo open landscape, vertical bar", CGSize(width: 951, height: 669), TableChrome(safeArea: i(0, 0, 34, 84), topBar: 70), 1.3, 1),
            ("Duo open landscape, log docked, vertical bar", CGSize(width: 546, height: 669), TableChrome(safeArea: i(0, 0, 34, 0), topBar: 70), 1, 1),
            ("Duo open", CGSize(width: 669, height: 951), TableChrome(safeArea: i(82, 0, 34, 0), topBar: 75.5), 1.3, 1),
            ("Duo open landscape", CGSize(width: 951, height: 669), TableChrome(safeArea: i(0, 0, 34, 84), topBar: 75.5), 1.3, 1),
            ("Duo open landscape, log docked", CGSize(width: 546, height: 669), TableChrome(safeArea: i(0, 0, 34, 0), topBar: 75.5), 1, 1),
        ]
    }()

    static func scale(_ fans: [Rel: CGRect]?) -> CGFloat? {
        fans?.values.first.map { (TableLayout.fanScale(of: $0) * 100).rounded() / 100 }
    }

    // MARK: fan geometry

    func testAFanFitsItsBoxAtEveryCount() {
        let box = CGRect(x: -TableLayout.fanBox.width / 2, y: -TableLayout.fanBox.height / 2,
                         width: TableLayout.fanBox.width, height: TableLayout.fanBox.height)
        XCTAssertEqual(TableLayout.fanSlots(count: 0), [])
        XCTAssertEqual(TableLayout.fanSlots(count: -3), [])
        for n in 1...13 {
            let slots = TableLayout.fanSlots(count: n)
            XCTAssertEqual(slots.count, n)
            for s in slots {
                let r = TableLayout.fanCardBounds(s)
                XCTAssertTrue(box.insetBy(dx: -0.01, dy: -0.01).contains(r), "\(n) cards: \(r) inside \(box)")
            }
            // left to right, symmetric, the middle upright
            XCTAssertEqual(slots.map(\.center.x), slots.map(\.center.x).sorted())
            XCTAssertEqual(slots.first!.center.x, -slots.last!.center.x, accuracy: 0.001)
            XCTAssertEqual(slots.first!.rotation, -slots.last!.rotation, accuracy: 0.001)
        }
        XCTAssertEqual(TableLayout.fanSlots(count: 20).count, 13, "never more than a full hand")
        XCTAssertEqual(TableLayout.fanSlots(count: 1), [TableLayout.FanSlot(center: .zero, rotation: 0)])
    }

    func testWhereTheTableShowsFans() {
        // a window with no room for any fan (a degraded table) shows none
        let none = TableLayout(size: Self.small.0, chrome: Self.small.1)
        XCTAssertNil(none.fans(spectating: false))
        XCTAssertNil(none.fans(spectating: true))
        for (name, size, chrome, seated, spectating) in Self.devices {
            let L = TableLayout(size: size, chrome: chrome)
            XCTAssertEqual(Self.scale(L.fans(spectating: false)), seated, "\(name) seated: \(L.zoom) \(L.mode)")
            XCTAssertEqual(Self.scale(L.fans(spectating: true)), spectating, "\(name) spectating")
        }
    }

    /// Everything a fan keeps clear of (the transient chat bubbles, effects and banner aside).
    static func obstacles(_ L: TableLayout, spectating: Bool) -> [(String, CGRect)] {
        var out: [(String, CGRect)] = []
        for r in [Rel.top, .left, .right, .bottom] { out.append(("trick \(r)", L.trickRect(r))) }
        let seats: [Rel] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
        for r in seats {
            // the seat's parts (a compact fan sits in the corner between the glow and the name band)
            out.append(("glow \(r)", TableLayout.glowRect(L.seatAnchor(r))))
            out.append(("name \(r)", TableLayout.nameRect(L.seatAnchor(r))))
            out.append(("bubble \(r)", L.bubbleRect(r)))
            out.append(("dealer \(r)", L.dealerChip(r)))
        }
        out.append(("history", TableLayoutTests.historyRect(L, count: 13)))
        for (i, c) in L.cornerRects.enumerated() { out.append(("corner \(i)", c)) }
        out.append(("badge", L.spectatorBadge(spectating: spectating)))
        if !spectating {
            out.append(("hand", TableLayoutTests.handRect(L, count: 13, lifted: true)))
            out.append(("seat row", L.seatRow.content))
            out.append(("my bubble", L.bubbleRect(.bottom)))
            out.append(("bid band", L.bidBand))
            out.append(("my dealer", L.myDealerChip(handCount: 13)))
        }
        if let f = L.chrome.fold, !L.foldIgnored { out.append(("fold", f)) }
        return out
    }

    static func problems(_ L: TableLayout, spectating: Bool, banner: Bool = false) -> [String] {
        guard let fans = L.fans(spectating: spectating), !fans.isEmpty else { return [] }
        var bad: [String] = []
        let seats: [Rel] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
        // (a banner may leave a seat's fan out)
        if !banner, Set(fans.keys) != Set(seats) { bad.append("fans for \(fans.keys) not \(seats)") }
        let top = min(L.safeRect.maxY, L.topLimit)
        for (r, box) in fans {
            let k = TableLayout.fanScale(of: box)
            if !TableLayout.fanScales.contains(where: { abs($0 - k) < 0.001 }) || abs(box.height - TableLayout.fanBox.height * k) > 0.001 {
                bad.append("\(r) box \(box.size)")
            }
            if abs(k - TableLayout.fanScale(of: fans.values.first!)) > 0.001 { bad.append("\(r) fan at another scale than the rest") }
            if box.minX < L.safeRect.minX - 0.01 || box.maxX > L.safeRect.maxX + 0.01 || box.minY < L.safeRect.minY - 0.01 || box.maxY > top + 0.01 {
                bad.append("\(r) fan \(box) outside \(L.safeRect) top \(top)")
            }
            for (name, o) in obstacles(L, spectating: spectating) where TableLayout.overlaps(o, box) {
                bad.append("\(r) fan \(box) over \(name) \(o)")
            }
            for (q, other) in fans where q != r && TableLayout.overlaps(other, box) { bad.append("\(r) fan over \(q) fan") }
            // by its own seat: the box touches the seat's footprint grown by the gaps
            let near = L.seatFootprint(r).insetBy(dx: -(TableLayout.gap + 0.5), dy: -(TableLayout.gap + 0.5))
            if !near.intersects(box) { bad.append("\(r) fan \(box) is not by its seat \(L.seatFootprint(r))") }
        }
        return bad
    }

    func testFansAreClearOfEverythingAtTheListedSizes() {
        for (name, size, chrome, _, _) in Self.devices {
            for bar in [CGFloat(0), 56] {
                var c = chrome
                c.bottomBar = bar
                let L = TableLayout(size: size, chrome: c)
                for spectating in [false, true] {
                    XCTAssertEqual(Self.problems(L, spectating: spectating), [], "\(name) bar \(bar) spectating \(spectating)")
                }
            }
        }
    }

    func testFansAreClearAtEverySizeAndFold() {
        var shown = 0, total = 0
        for w in stride(from: CGFloat(320), through: 1400, by: 36) {
            for h in stride(from: CGFloat(480), through: 1400, by: 44) {
                let size = CGSize(width: w, height: h)
                var chromes = [PolishLayoutTests.chrome(TableLayoutTests.insets(24, 0, 20, 0), bottomBar: 0, topBar: 75.5),
                               TableChrome(safeArea: TableLayoutTests.insets(0, 0, 34, 84), topBar: 84)]
                var book = chromes[0], tabletop = chromes[0]
                book.fold = CGRect(x: -10, y: -h / 2, width: 20, height: h)
                tabletop.fold = CGRect(x: -w / 2, y: -10, width: w, height: 20)
                chromes += [book, tabletop]
                for c in chromes {
                    let L = TableLayout(size: size, chrome: c)
                    for spectating in [false, true] {
                        total += 1
                        if L.fans(spectating: spectating) != nil { shown += 1 }
                        if L.isDegraded { XCTAssertNil(L.fans(spectating: spectating), "\(size): a degraded table shows none") }
                        XCTAssertEqual(Self.problems(L, spectating: spectating), [], "\(size) fold \(String(describing: c.fold)) spectating \(spectating)")
                    }
                }
            }
        }
        XCTAssertGreaterThan(shown, total / 4, "the fuzz reaches tables with fans")
        XCTAssertLessThan(shown, total, "and tables without")
    }

    // MARK: dealer marker geometry

    func testTheDealerMarkerStaysInsideItsSeat() {
        for (name, size, chrome, _, _) in Self.devices {
            let L = TableLayout(size: size, chrome: chrome)
            for r in [Rel.top, .left, .right, .bottom] {
                let chip = L.dealerChip(r)
                XCTAssertEqual(chip.size, CGSize(width: TableLayout.dealerChip, height: TableLayout.dealerChip))
                XCTAssertTrue(L.seatFootprint(r).insetBy(dx: -0.01, dy: -0.01).contains(chip), "\(name) \(r): \(chip) in \(L.seatFootprint(r))")
                // off the name, the pips' ring and the bore outline
                let a = L.seatAnchor(r)
                XCTAssertFalse(TableLayout.overlaps(TableLayout.nameRect(a), chip), "\(name) \(r)")
                let d = hypot(chip.midX - a.x, chip.midY - a.y) - TableLayout.dealerChip / 2
                XCTAssertGreaterThanOrEqual(d, TableLayout.seatBoreRadius + TableLayout.seatBoreLine / 2, "\(name) \(r)")
                for q in [Rel.top, .left, .right, .bottom] {
                    XCTAssertFalse(TableLayout.overlaps(L.bubbleRect(q), chip), "\(name) \(r) chip over \(q) bubble")
                    XCTAssertFalse(TableLayout.overlaps(L.trickRect(q), chip), "\(name) \(r) chip over \(q) trick card")
                }
                for c in L.cornerRects { XCTAssertFalse(TableLayout.overlaps(c, chip), "\(name) \(r) chip over a corner button") }
            }
        }
    }

    func testMyDealerMarkerSitsAtMyHandsLeftEnd() {
        for (name, size, chrome, _, _) in Self.devices {
            let L = TableLayout(size: size, chrome: chrome)
            for n in [0, 1, 2, 7, 13] {
                let chip = L.myDealerChip(handCount: n)
                XCTAssertGreaterThanOrEqual(chip.minY, L.handTop - 0.01, "\(name) \(n): above the resting hand")
                XCTAssertLessThanOrEqual(chip.maxY, L.liftTop + 0.01, "\(name) \(n): inside the lift band")
                XCTAssertGreaterThanOrEqual(chip.minX, L.safeRect.minX, "\(name) \(n)")
                XCTAssertLessThanOrEqual(chip.maxX, L.safeRect.maxX, "\(name) \(n)")
                // nothing else is placed below the bid band's floor
                XCTAssertFalse(TableLayout.overlaps(L.bidBand, chip), "\(name) \(n)")
                XCTAssertFalse(TableLayout.overlaps(L.seatRow.content, chip), "\(name) \(n)")
                XCTAssertFalse(TableLayout.overlaps(TableLayoutTests.historyRect(L, count: 13), chip), "\(name) \(n)")
                if n > 0 {
                    let hand = TableLayoutTests.handRect(L, count: n, lifted: false)
                    XCTAssertEqual(chip.minX, max(L.safeRect.minX + 2, hand.minX), accuracy: 0.5, "\(name) \(n): the hand's left end")
                }
            }
        }
    }

    // MARK: the render model

    func testTheModelCarriesTheDealerAndEachSeatsCards() throws {
        let s = try T.state(fixture: "trick-mid-lead3")
        let m = TableRenderModel(s)
        XCTAssertEqual(m.dealer, s.table.deal?.dealer)
        XCTAssertNotNil(m.dealer)
        for o in m.opponents { XCTAssertEqual(o.cards, s.players.seats[o.position]?.cardsInHand, "seat \(o.position)") }
        XCTAssertTrue(m.opponents.contains { $0.cards > 0 })
        XCTAssertEqual(m.opponents.count, 3)

        let watch = TableRenderModel(try T.state(fixture: "spectator-mid-hand"))
        XCTAssertEqual(watch.opponents.count, 4, "a spectator sees four fans")
        XCTAssertFalse(watch.iDeal, "a spectator has no seat to deal from")
        XCTAssertNotNil(watch.dealer)

        // off the table (the draw): no dealer, no cards
        let draw = TableRenderModel(try T.state(fixture: "draw-in-progress"))
        XCTAssertNil(draw.dealer)
        XCTAssertTrue(draw.opponents.allSatisfy { $0.cards == 0 })
    }

    func testCardsShrinkAsTheyArePlayedAndTheDealerMovesWithTheDeal() {
        var s = T.dealtState(size: 3, dealer: 4)
        XCTAssertEqual(TableRenderModel(s).dealer, 4)
        XCTAssertEqual(TableRenderModel(s).opponents.map(\.cards), [3, 3, 3])
        XCTAssertFalse(TableRenderModel(s).iDeal)
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 2, "seq": 3]))
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", "3"), "position": 2, "trump": false, "seq": 4]))
        let m = TableRenderModel(s)
        XCTAssertEqual(m.opponents.first { $0.position == 2 }?.cards, 2)
        XCTAssertEqual(m.opponents.first { $0.position == 3 }?.cards, 3)
        // the next deal: I deal
        TableReducer.reduce(&s, T.ev("gameStart", ["hand": [T.card("spades", "2")], "trump": T.card("clubs", "3"), "dealer": 1, "position": 1,
                                                   "currentHand": 1, "score1": 0, "score2": 0, "seq": 5]))
        let next = TableRenderModel(s)
        XCTAssertEqual(next.dealer, 1)
        XCTAssertTrue(next.iDeal)
        XCTAssertEqual(next.opponents.map(\.cards), [1, 1, 1])
    }

    // MARK: the scene

    static let iPad = (CGSize(width: 1032, height: 1376), PolishLayoutTests.chrome(TableLayoutTests.insets(24, 0, 20, 0), bottomBar: 0, topBar: 75.5))
    static let phone = (CGSize(width: 390, height: 844), PolishLayoutTests.chrome(TableLayoutTests.insets(47, 0, 34, 0), bottomBar: 0, topBar: 75.5))

    private func makeScene(_ fixture: String, _ device: (CGSize, TableChrome), edit: (inout [String: Any]) -> Void = { _ in }) throws -> (ReplayHarness, GameSKScene) {
        let h = ReplayHarness()
        let snap = try T.snapshot(fixture, edit: edit)
        let me = snap.seats.first { $0.position == snap.viewer.position }?.username
        h.store.apply(.local(.identity(username: me ?? "viewer", playerId: "sid-viewer")))
        h.store.apply(.snapshot(snap, .rejoin, hints: nil))
        let scene = GameSKScene(size: device.0)
        scene.animator = InstantAnimator()
        scene.chrome = device.1
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: device.0)))
        return (h, scene)
    }

    private func fanCounts(_ scene: GameSKScene) -> [Int: Int] {
        scene.opponentManager.nodes.mapValues { $0.fanNode.count }
    }

    private func sceneRect(_ node: SKNode, _ scene: SKScene) -> CGRect {
        let f = node.calculateAccumulatedFrame()
        guard let p = node.parent else { return f }
        let a = p.convert(CGPoint(x: f.minX, y: f.minY), to: scene), b = p.convert(CGPoint(x: f.maxX, y: f.maxY), to: scene)
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }

    func testASnapshotShowsEachSeatsCardBacksInItsBox() throws {
        let (h, scene) = try makeScene("trick-mid-lead3", Self.iPad)
        let state = h.store.state
        let fans = try XCTUnwrap(scene.layout.fans(spectating: false))
        XCTAssertEqual(scene.opponentManager.nodes.count, 3)
        for (pos, node) in scene.opponentManager.nodes {
            let cards = try XCTUnwrap(state.players.seats[pos]?.cardsInHand)
            XCTAssertEqual(node.fanNode.count, cards, "seat \(pos)")
            XCTAssertEqual(node.fanNode.children.count, cards)
            XCTAssertTrue(node.fanNode.children.allSatisfy { ($0 as? SKSpriteNode)?.texture === CardFanNode.backTexture })
            guard cards > 0 else { continue }
            let box = try XCTUnwrap(fans[node.relativePosition])
            XCTAssertTrue(box.insetBy(dx: -0.5, dy: -0.5).contains(sceneRect(node.fanNode, scene)), "seat \(pos): \(sceneRect(node.fanNode, scene)) in \(box)")
        }
        XCTAssertTrue(fanCounts(scene).values.contains { $0 > 0 })
    }

    func testTheBackIsTheRedLattice() {
        let size = CardFanNode.backTexture.size()
        XCTAssertEqual(size.width / size.height, 100.0 / 145.0, accuracy: 0.02)
        let px = CardTextureGenerator.backPixelSize(width: TableLayout.fanCard.width * 1.3 * CardTextureGenerator.textureZoom)
        XCTAssertEqual(size.width * UIScreen.main.scale, px.width, accuracy: 1.5, "rendered at the largest fan card's on-screen size")
    }

    /// A window too small for any fan (a degraded table).
    static let small = (CGSize(width: 320, height: 420), PolishLayoutTests.chrome(TableLayoutTests.insets(20, 0, 0, 0), bottomBar: 0, topBar: 75.5))

    /// A phone shows the compact fans: the node carries the scale, and every back stays in its box.
    func testAPhoneShowsCompactFans() throws {
        let (h, scene) = try makeScene("trick-mid-lead3", Self.phone)
        let fans = try XCTUnwrap(scene.layout.fans(spectating: false))
        XCTAssertEqual(Self.scale(fans), 0.62)
        for (pos, node) in scene.opponentManager.nodes {
            let cards = try XCTUnwrap(h.store.state.players.seats[pos]?.cardsInHand)
            XCTAssertEqual(node.fanNode.count, cards)
            XCTAssertEqual(node.fanNode.xScale, 0.62, accuracy: 0.001)
            guard cards > 0 else { continue }
            let box = try XCTUnwrap(fans[node.relativePosition])
            XCTAssertTrue(box.insetBy(dx: -0.5, dy: -0.5).contains(sceneRect(node.fanNode, scene)), "seat \(pos): \(sceneRect(node.fanNode, scene)) in \(box)")
        }
        // the largest table: the roomy scale
        let (_, big) = try makeScene("trick-mid-lead3", Self.iPad)
        for node in big.opponentManager.nodes.values { XCTAssertEqual(node.fanNode.xScale, 1.3, accuracy: 0.001) }
    }

    func testATableWithNoRoomKeepsItsLightweightSeats() throws {
        let (_, scene) = try makeScene("trick-mid-lead3", Self.small)
        XCTAssertNil(scene.layout.fans(spectating: false))
        XCTAssertTrue(fanCounts(scene).values.allSatisfy { $0 == 0 })
        for node in scene.opponentManager.nodes.values {
            XCTAssertTrue(node.fanNode.children.isEmpty)
            XCTAssertEqual(node.fanNode.xScale, 1)
        }
    }

    // MARK: the banner

    /// The disconnect / idle banner stays up (a grace period, an offer until someone answers):
    /// no fan sits under it. A fan it would cover moves to its seat's next clear spot or is
    /// left out; the other seats keep theirs.
    func testNoFanSitsUnderTheBanner() {
        var moved = 0, dropped = 0
        for (name, size, chrome, _, _) in Self.devices {
            for banner in [CGFloat(31), 47, 86, 141, 220] {
                var c = chrome
                c.banner = banner
                let L = TableLayout(size: size, chrome: c)
                for spectating in [false, true] {
                    guard let plan = L.fanPlan(spectating: spectating), let fans = L.fans(spectating: spectating) else { continue }
                    let rect = L.bannerRect(spectating: spectating)!
                    for (r, box) in fans {
                        XCTAssertFalse(TableLayout.overlaps(rect, box), "\(name) banner \(banner) spectating \(spectating): \(r) fan \(box) under the banner \(rect)")
                        if box != plan[r] { moved += 1 }
                    }
                    dropped += plan.count - fans.count
                    // a fan the banner does not reach stays where it was
                    for (r, box) in plan where !TableLayout.overlaps(rect.insetBy(dx: -TableLayout.fanGap, dy: -TableLayout.fanGap), box) {
                        XCTAssertEqual(fans[r], box, "\(name) banner \(banner): \(r)")
                    }
                    // what is left is still clear of everything
                    XCTAssertEqual(Self.problems(L, spectating: spectating, banner: true), [], "\(name) banner \(banner) spectating \(spectating)")
                }
            }
        }
        XCTAssertGreaterThan(moved + dropped, 0, "some banner reaches some fan in the list")
    }

    func testWithNoBannerTheFansAreThePlan() {
        for (name, size, chrome, _, _) in Self.devices {
            let L = TableLayout(size: size, chrome: chrome)
            XCTAssertNil(L.bannerRect(spectating: false), name)
            XCTAssertEqual(L.fans(spectating: false), L.fanPlan(spectating: false), name)
        }
    }

    /// The scene: the banner going up re-places the fans, and its going away brings them back.
    func testTheSceneMovesAFanOutFromUnderTheBanner() throws {
        let (_, scene) = try makeScene("trick-mid-lead3", Self.iPad)
        let plan = try XCTUnwrap(scene.layout.fans(spectating: false))
        var chrome = Self.iPad.1
        chrome.banner = 141
        scene.chrome = chrome
        let rect = try XCTUnwrap(scene.layout.bannerRect(spectating: false))
        let fans = try XCTUnwrap(scene.layout.fans(spectating: false))
        for node in scene.opponentManager.nodes.values {
            if let box = fans[node.relativePosition], node.fanNode.count > 0 {
                XCTAssertTrue(box.insetBy(dx: -0.5, dy: -0.5).contains(sceneRect(node.fanNode, scene)))
                XCTAssertFalse(TableLayout.overlaps(rect, sceneRect(node.fanNode, scene)))
            } else {
                XCTAssertEqual(node.fanNode.count, 0, "a fan with no clear spot is left out while the banner shows")
            }
        }
        scene.chrome = Self.iPad.1
        XCTAssertEqual(scene.layout.fans(spectating: false), plan)
        for node in scene.opponentManager.nodes.values where node.fanNode.count > 0 {
            XCTAssertTrue(plan[node.relativePosition]!.insetBy(dx: -0.5, dy: -0.5).contains(sceneRect(node.fanNode, scene)))
        }
    }

    /// destroyHands (a redeal) takes every seat's cards, not only mine: the fans empty with my hand.
    func testDestroyHandsEmptiesEveryFan() throws {
        let (h, scene) = try makeScene("bidding-mid", Self.iPad)
        XCTAssertTrue(fanCounts(scene).values.allSatisfy { $0 > 0 })
        h.store.apply(T.ev("destroyHands", ["seq": (h.store.state.sync.lastSeq ?? 0) + 1]))
        XCTAssertTrue(h.store.state.players.seats.values.allSatisfy { $0.cardsInHand == 0 })
        XCTAssertTrue(h.store.state.table.hand.isEmpty)
        XCTAssertTrue(fanCounts(scene).values.allSatisfy { $0 == 0 }, "\(fanCounts(scene))")
    }

    /// The fan and the dealer marker take no touches: a tap on them reaches nothing of the seat
    /// (the profile hook on the avatar must test the avatar, not the seat's accumulated frame).
    func testTheFanAndTheDealerMarkerTakeNoTouches() throws {
        let (_, scene) = try makeScene("trick-mid-lead3", Self.iPad)
        for node in scene.opponentManager.nodes.values {
            XCTAssertFalse(node.fanNode.isUserInteractionEnabled)
            XCTAssertFalse(node.dealerNode.isUserInteractionEnabled)
            XCTAssertTrue(node.fanNode.children.allSatisfy { !$0.isUserInteractionEnabled })
            guard node.fanNode.count > 0 else { continue }
            // the fan lies outside the avatar's glow: a hit test of the avatar circle never finds it
            let fan = sceneRect(node.fanNode, scene)
            XCTAssertFalse(TableLayout.overlaps(TableLayout.glowRect(scene.layout.seatAnchor(node.relativePosition)), fan))
        }
    }

    func testASpectatorSeesFourFans() throws {
        let (h, scene) = try makeScene("spectator-mid-hand", Self.iPad)
        XCTAssertEqual(scene.opponentManager.nodes.count, 4)
        XCTAssertNotNil(scene.layout.fans(spectating: true))
        for (pos, node) in scene.opponentManager.nodes {
            XCTAssertEqual(node.fanNode.count, h.store.state.players.seats[pos]?.cardsInHand, "seat \(pos)")
        }
        XCTAssertFalse(scene.myDealerNode.isShown)
    }

    func testAFanShrinksWhenItsSeatPlaysAndRefillsOnTheDeal() throws {
        let (h, scene) = try makeScene("bidding-mid", Self.iPad)
        let before = fanCounts(scene)
        let size = try XCTUnwrap(h.store.state.table.deal?.handSize)
        XCTAssertTrue(before.values.allSatisfy { $0 == size }, "bidding: every seat holds the whole hand \(before)")
        // the next live events: bidding ends, a seat plays
        var seq = (h.store.state.sync.lastSeq ?? 0) + 1
        let lead = scene.opponentManager.nodes.keys.sorted()[0]
        h.store.apply(T.ev("doneBidding", ["bids": ["1", "1", "1", "1"], "lead": lead, "seq": seq])); seq += 1
        h.store.apply(T.ev("cardPlayed", ["card": T.card("spades", "3"), "position": lead, "trump": false, "seq": seq])); seq += 1
        var after = fanCounts(scene)
        XCTAssertEqual(after[lead], size - 1)
        for (pos, n) in after where pos != lead { XCTAssertEqual(n, size, "seat \(pos)") }
        // idempotent: a second render of the same model changes nothing
        let dump = SceneDump.dump(scene)
        scene.renderLatest()
        XCTAssertEqual(SceneDump.dump(scene), dump)
        // a new deal fills them again
        h.store.apply(T.ev("gameStart", ["hand": [T.card("spades", "2"), T.card("hearts", "2")], "trump": T.card("clubs", "3"), "dealer": lead,
                                         "position": h.store.state.table.viewer.position ?? 1, "currentHand": 2, "score1": 0, "score2": 0, "seq": seq]))
        after = fanCounts(scene)
        XCTAssertTrue(after.values.allSatisfy { $0 == 2 }, "\(after)")
        XCTAssertTrue(scene.opponentManager.nodes[lead]!.dealerNode.isShown, "the dealer marker moved with the deal")
        XCTAssertEqual(scene.opponentManager.nodes.values.filter { $0.dealerNode.isShown }.count, 1)
    }

    func testAnOpponentsCardFliesFromItsFan() throws {
        let (h, scene) = try makeScene("bidding-mid", Self.iPad)
        let model = try XCTUnwrap(scene.lastModel)
        let fans = try XCTUnwrap(scene.layout.fans(spectating: false))
        for rel in [Rel.top, .left, .right] {
            let box = try XCTUnwrap(fans[rel])
            XCTAssertEqual(scene.cardEntry(rel, model: model), CGPoint(x: box.midX, y: box.midY))
        }
        XCTAssertEqual(scene.cardEntry(.bottom, model: model), scene.layout.trickEntry(.bottom), "my own card comes from my hand's side")
        // no fans: off-screen, as before
        let (_, small) = try makeScene("bidding-mid", Self.small)
        let m = try XCTUnwrap(small.lastModel)
        XCTAssertEqual(small.cardEntry(.left, model: m), small.layout.trickEntry(.left))
        _ = h
    }

    func testTheDealerMarkerIsOnTheDealersSeat() throws {
        for dealer in 1...4 {
            let (h, scene) = try makeScene("trick-mid-lead3", Self.phone) { snap in
                var deal = snap["deal"] as! [String: Any]
                deal["dealer"] = dealer
                snap["deal"] = deal
            }
            let me = try XCTUnwrap(h.store.state.table.viewer.position)
            let shown = scene.opponentManager.nodes.filter { $0.value.dealerNode.isShown }.map(\.key)
            if dealer == me {
                XCTAssertEqual(shown, [])
                XCTAssertTrue(scene.myDealerNode.isShown)
                let chip = scene.layout.myDealerChip(handCount: scene.lastModel?.hand?.cards.count ?? 0)
                XCTAssertEqual(scene.myDealerNode.position.x, chip.midX, accuracy: 0.01)
                XCTAssertEqual(scene.myDealerNode.position.y, chip.midY, accuracy: 0.01)
            } else {
                XCTAssertEqual(shown, [dealer])
                XCTAssertFalse(scene.myDealerNode.isShown)
                let node = scene.opponentManager.nodes[dealer]!
                let chip = scene.layout.dealerChip(node.relativePosition)
                let r = sceneRect(node.dealerNode, scene)
                XCTAssertTrue(chip.insetBy(dx: -1.5, dy: -1.5).contains(r), "\(r) in \(chip)")
            }
        }
    }

    func testARelayoutMovesTheFansAndDropsThemWhereThereIsNoRoom() throws {
        let (_, scene) = try makeScene("trick-mid-lead3", Self.iPad)
        XCTAssertTrue(fanCounts(scene).values.contains { $0 > 0 })
        // the same table in the smallest phone's window: no fans
        scene.chrome = Self.small.1
        scene.size = Self.small.0
        XCTAssertNil(scene.layout.fans(spectating: false))
        XCTAssertTrue(fanCounts(scene).values.allSatisfy { $0 == 0 })
        // and back: the fans return in the new boxes
        scene.chrome = Self.iPad.1
        scene.size = Self.iPad.0
        let fans = try XCTUnwrap(scene.layout.fans(spectating: false))
        for node in scene.opponentManager.nodes.values where node.fanNode.count > 0 {
            XCTAssertTrue(fans[node.relativePosition]!.insetBy(dx: -0.5, dy: -0.5).contains(sceneRect(node.fanNode, scene)))
        }
        XCTAssertTrue(fanCounts(scene).values.contains { $0 > 0 })
    }

    /// Opt-in (`TEST_RUNNER_BAB_SCENE_SHOTS=<dir>`): the scene alone (no SwiftUI chrome) drawn at
    /// the open Duo's sizes, which no simulator pose can be scripted into, as PNGs in <dir>.
    func testWritesSceneImagesWhenAsked() throws {
        guard let dir = ProcessInfo.processInfo.environment["BAB_SCENE_SHOTS"], !dir.isEmpty else {
            throw XCTSkip("set TEST_RUNNER_BAB_SCENE_SHOTS to a directory")
        }
        let i = TableLayoutTests.insets
        let shots: [(String, String, CGSize, TableChrome)] = [
            ("duo-open-portrait-seated", "trick-mid-lead3", CGSize(width: 669, height: 951), TableChrome(safeArea: i(82, 0, 34, 0), topBar: 75.5)),
            ("duo-open-portrait-bidding", "bidding-mid", CGSize(width: 669, height: 951), TableChrome(safeArea: i(82, 0, 34, 0), topBar: 75.5)),
            ("duo-open-portrait-spectator", "spectator-mid-hand", CGSize(width: 669, height: 951), TableChrome(safeArea: i(82, 0, 34, 0), topBar: 75.5, bottomBar: 56)),
            ("duo-open-landscape-docked-seated", "trick-mid-lead3", CGSize(width: 546, height: 669), TableChrome(safeArea: i(0, 0, 34, 0), topBar: 75.5)),
            ("duo-open-landscape-seated", "trick-mid-lead3", CGSize(width: 951, height: 669), TableChrome(safeArea: i(0, 0, 34, 84), topBar: 75.5)),
            ("duo-closed-seated", "trick-mid-lead3", SceneLayoutTests.measured[0].0, SceneLayoutTests.measured[0].1),
            ("duo-closed-bidding", "bidding-mid", SceneLayoutTests.measured[0].0, SceneLayoutTests.measured[0].1),
            ("iphone-17e-seated", "trick-mid-lead3", Self.phone.0, Self.phone.1),
            ("iphone-se-seated", "trick-mid-lead3", CGSize(width: 375, height: 667), PolishLayoutTests.chrome(TableLayoutTests.insets(20, 0, 0, 0), bottomBar: 0, topBar: 75.5)),
            ("iphone-17pro-seated", "trick-mid-lead3", CGSize(width: 402, height: 874), PolishLayoutTests.chrome(TableLayoutTests.insets(62, 0, 34, 0), bottomBar: 0, topBar: 75.5)),
            ("iphone-17pro-bidding", "bidding-mid", CGSize(width: 402, height: 874), PolishLayoutTests.chrome(TableLayoutTests.insets(62, 0, 34, 0), bottomBar: 0, topBar: 75.5)),
            ("iphone-17pro-spectator", "spectator-mid-hand", CGSize(width: 402, height: 874), PolishLayoutTests.chrome(TableLayoutTests.insets(62, 0, 34, 0), bottomBar: 56, topBar: 75.5)),
        ]
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for (name, fixture, size, chrome) in shots {
            let (_, scene) = try makeScene(fixture, (size, chrome))
            let view = SKView(frame: CGRect(origin: .zero, size: size))
            view.presentScene(scene)
            guard let texture = view.texture(from: scene) else { XCTFail("no texture for \(name)"); continue }
            let image = UIImage(cgImage: texture.cgImage())
            let data = try XCTUnwrap(image.pngData())
            try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    func testTheGameOverTableAndTheDrawShowNoMarkers() throws {
        let (h, scene) = try makeScene("draw-in-progress", Self.iPad)
        XCTAssertTrue(scene.opponentManager.nodes.isEmpty)
        XCTAssertFalse(scene.myDealerNode.isShown)
        _ = h
    }
}
