import XCTest
import CoreGraphics
import SpriteKit
import SwiftUI
@testable import BAB_Online

/// The table grows on big panes (owner, 2026-11-12: "on the web client and iPad the
/// default may be a little small", "grow to fit"): TableLayout.zoom. Phones (and the
/// Duo, closed and open) and every narrow window stay exactly as before.
@MainActor
final class TableZoomTests: XCTestCase {
    typealias Rel = Positions.RelativePosition

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    /// The measured iPad chrome (fixture mode: insets 32/0/20/0, ScoreBar 75.5, corner 80 x 50.5).
    static func ipad(_ w: CGFloat, _ h: CGFloat, bottomBar: CGFloat = 0) -> (CGSize, TableChrome) {
        (CGSize(width: w, height: h), TableLayoutTests.chrome(TableLayoutTests.insets(32, 0, 20, 0), topBar: 75.5,
                                                              corner: CGSize(width: 80, height: 50.5), bottomBar: bottomBar))
    }

    /// The pinned fingerprint of every never-zooming pane (LayoutDigest), computed by the
    /// same code on main 6aab8f5, before the zoom.
    static let phoneDigest = "66751b0eb339e2c3"

    // MARK: phones unchanged

    func testPhonesAndNarrowWindowsLayOutExactlyAsBefore() {
        let d = LayoutDigest.digest()
        XCTAssertEqual(d.count, 3689)
        XCTAssertEqual(d.hash, Self.phoneDigest, "a pane under \(TableLayout.zoomMinSide) pt changed: phones must stay as they were")
        for size in LayoutDigest.sizes {
            for chrome in LayoutDigest.chromes {
                let L = TableLayout(size: size, chrome: chrome)
                XCTAssertEqual(L.zoom, 1, "\(size)")
                XCTAssertEqual(L.size, size, "\(size)")
                XCTAssertEqual(L.paneSize, size, "\(size)")
                XCTAssertEqual(L, TableLayout.unzoomed(size: size, chrome: chrome), "\(size)")
            }
        }
    }

    func testOnlyAPaneSevenHundredPointsOnItsShortSideMayZoom() {
        XCTAssertFalse(TableLayout.mayZoom(CGSize(width: 440, height: 956)), "the largest iPhone")
        XCTAssertFalse(TableLayout.mayZoom(CGSize(width: 956, height: 440)))
        XCTAssertFalse(TableLayout.mayZoom(CGSize(width: 669, height: 951)), "the open Duo")
        XCTAssertFalse(TableLayout.mayZoom(CGSize(width: 699.5, height: 1376)))
        XCTAssertTrue(TableLayout.mayZoom(CGSize(width: 744, height: 1133)), "the iPad mini")
        XCTAssertTrue(TableLayout.mayZoom(CGSize(width: 700, height: 700)))
    }

    // MARK: big panes grow

    /// (name, pane, expected zoom): the iPads full screen, both ways, with the measured chrome.
    /// The zoom is chosen for the tallest score bar (`zoomTopBar`), so the 11-inch landscapes
    /// grow a little less than for a 75.5 pt bar alone (1.15), and keep it through a game.
    static let ipads: [(String, CGFloat, CGFloat, CGFloat)] = [
        ("iPad 13 portrait", 1032, 1376, 1.4), ("iPad 13 landscape", 1376, 1032, 1.4),
        ("iPad 11 portrait", 834, 1210, 1.4), ("iPad 11 landscape", 1210, 834, 1.1),
        ("iPad Air 11 portrait", 820, 1180, 1.4), ("iPad Air 11 landscape", 1180, 820, 1.05),
        ("iPad mini portrait", 744, 1133, 1.4), ("iPad mini landscape", 1133, 744, 1),
        ("iPad 13 split 2/3", 900, 1032, 1.4), ("iPad 13 split 1/2", 678, 1032, 1), ("iPad 13 split 1/3", 466, 1032, 1),
        ("Slide Over", 320, 1032, 1),
    ]

    func testIPadsGrowToFit() {
        for (name, w, h, want) in Self.ipads {
            let (size, chrome) = Self.ipad(w, h)
            let L = TableLayout(size: size, chrome: chrome)
            XCTAssertEqual(L.zoom, want, accuracy: 0.0001, name)
            XCTAssertEqual(L.paneSize, size, name)
            XCTAssertEqual(L.size.width, w / L.zoom, accuracy: 0.0001, name)
            XCTAssertEqual(L.size.height, h / L.zoom, accuracy: 0.0001, name)
            print("[Zoom] \(name) \(Int(w))x\(Int(h)): zoom \(L.zoom), a hand card \(145 * L.handScale * L.zoom) pt tall")
        }
    }

    /// The chromes a pane goes through in a game (points): the draw (no score bar, no corner
    /// buttons before they are measured), the score bar at 71 / 81 / 109 pt and between, the
    /// corner buttons as measured (and a little smaller: a narrower type).
    static func gameChromes(bottomBar: CGFloat) -> [TableChrome] {
        var out: [TableChrome] = []
        for topBar in [CGFloat(0), 60, 71, 75.5, 81, 90, 95, 109, 110] {
            for corner in [CGSize.zero, CGSize(width: 80, height: 50.5), CGSize(width: 76, height: 48)] {
                out.append(TableLayoutTests.chrome(TableLayoutTests.insets(32, 0, 20, 0), topBar: topBar, corner: corner, bottomBar: bottomBar))
            }
        }
        return out
    }

    /// The table never changes size mid-game (verifier F2: on cc2bb72 an iPad 11 landscape went
    /// 1.20 -> 1.15 -> 1.10 as the score bar measured 71, 81, 109 pt): for each pane and role
    /// (no bottom pill; a spectator's or lazy player's pill) every chrome of a game gives the
    /// same zoom. Uses only API that existed on cc2bb72, so it runs (and fails) there too.
    func testTheZoomStaysPutThroughAGame() {
        var panes: [(String, CGSize)] = Self.ipads.map { ($0.0, CGSize(width: $0.1, height: $0.2)) }
        for w in stride(from: CGFloat(700), through: 1400, by: 100) {
            for h in stride(from: CGFloat(700), through: 1400, by: 100) { panes.append(("\(Int(w))x\(Int(h))", CGSize(width: w, height: h))) }
        }
        var zoomedPanes = 0
        for (name, size) in panes {
            for pill in [CGFloat(0), 45, 56] {
                var zooms = Set<CGFloat>()
                for chrome in Self.gameChromes(bottomBar: pill) {
                    let L = TableLayout(size: size, chrome: chrome)
                    zooms.insert(L.zoom)
                    if L.zoom > 1 {
                        XCTAssertTrue(TableLayoutTests.problems(L).isEmpty, "\(name) \(chrome): \(TableLayoutTests.problems(L))")
                    }
                }
                XCTAssertEqual(zooms.count, 1, "\(name) pill \(pill): the zoom changed with the chrome: \(zooms.sorted())")
                if zooms.contains(where: { $0 > 1 }) { zoomedPanes += 1 }
            }
        }
        XCTAssertGreaterThan(zoomedPanes, 40)
    }

    /// The disconnect banner (verifier F1): wherever zoom 1 has a clear spot for the banner on
    /// screen (one player's row 31 pt; one row + the timeout row 86; presence-mixed's two rows +
    /// the timeout row 123.5; three rows + the timeout row 162), the zoomed table has one too,
    /// for every banner, on every pane and chrome of a game, seated and spectating. A banner
    /// within the reserve never moves the zoom; a taller one steps it down while it shows.
    func testTheDisconnectBannerKeepsItsSpotWhenZoomed() {
        var panes: [CGSize] = Self.ipads.map { CGSize(width: $0.1, height: $0.2) }
        for w in stride(from: CGFloat(700), through: 1400, by: 175) {
            for h in stride(from: CGFloat(700), through: 1400, by: 175) { panes.append(CGSize(width: w, height: h)) }
        }
        var steppedDown = 0, checked = 0
        for size in panes {
            for pill in [CGFloat(0), 45] {
                for var chrome in Self.gameChromes(bottomBar: pill) where chrome.cornerButton.width != 76 {
                    let none = TableLayout(size: size, chrome: chrome)
                    let base = TableLayout.unzoomed(size: size, chrome: chrome)
                    for banner in [CGFloat(31), 60, 86, 123.5, 162] {
                        chrome.banner = banner
                        let L = TableLayout(size: size, chrome: chrome)
                        let tag = "\(size) topBar \(chrome.topBar) pill \(pill) banner \(banner) zoom \(L.zoom)"
                        XCTAssertLessThanOrEqual(L.zoom, none.zoom, tag)
                        if banner <= TableLayout.zoomBannerReserve { XCTAssertEqual(L.zoom, none.zoom, "\(tag): a short banner moved the zoom") }
                        if L.zoom < none.zoom { steppedDown += 1 }
                        for spectating in [false, true] where base.disconnectBanner(height: banner, spectating: spectating) != nil {
                            XCTAssertNotNil(L.disconnectBanner(height: banner / L.zoom, spectating: spectating),
                                            "\(tag) spectating \(spectating): zoom 1 has a spot for the banner, the zoomed table none")
                            checked += 1
                        }
                    }
                }
            }
        }
        XCTAssertGreaterThan(checked, 1000)
        XCTAssertGreaterThan(steppedDown, 50, "the tall banners step some zooms down")
    }

    /// The verifier's case: presence-mixed (two players disconnected, one timed out: the banner
    /// measures 123.5 pt) under a 109 pt score bar. At zoom 1.4 the banner found no spot on an
    /// iPad 11 portrait, a mini portrait or an iPad 13 landscape and fell back over the partner;
    /// now the table steps down while it shows and the banner sits clear, as on base.
    func testPresenceMixedBannerSitsClear() throws {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("presence-mixed"), .rejoin, hints: nil))
        let banner = fit(DisconnectBannerView().environmentObject(h.store).frame(maxWidth: TableLayout.disconnectBannerMaxWidth),
                         width: 834).height
        XCTAssertGreaterThan(banner, TableLayout.zoomBannerReserve, "two rows and the timeout row")
        XCTAssertLessThan(banner, 162)
        for (name, w, hh) in [("iPad 11 portrait", CGFloat(834), CGFloat(1210)), ("iPad mini portrait", 744, 1133),
                              ("iPad 13 landscape", 1376, 1032), ("iPad 13 portrait", 1032, 1376)] {
            let size = CGSize(width: w, height: hh)
            var chrome = TableLayoutTests.chrome(TableLayoutTests.insets(32, 0, 20, 0), topBar: 109, corner: CGSize(width: 80, height: 50.5))
            let before = TableLayout(size: size, chrome: chrome)
            XCTAssertNotNil(TableLayout.unzoomed(size: size, chrome: chrome).disconnectBanner(height: banner, spectating: false), name)
            chrome.banner = banner
            let L = TableLayout(size: size, chrome: chrome)
            let spot = try XCTUnwrap(L.disconnectBanner(height: banner / L.zoom, spectating: false), name)
            // clear of the partner's seat and bubble, in points under the corner buttons' row
            XCTAssertFalse(spot.intersects(L.seatFootprint(.top)), name)
            XCTAssertFalse(spot.intersects(L.bubbleRect(.top)), name)
            print("[Zoom] \(name) presence-mixed: zoom \(before.zoom) -> \(L.zoom) with the \(banner) pt banner")
        }
    }

    /// A zoomed layout is zoom 1's table, larger: a full-size hand, the same trick scale,
    /// seat mode, seat-row form, bottom pill and fold handling, nothing degraded, and the
    /// disconnect banner's reserve kept (where zoom 1 has room for it). The zoom is the largest
    /// such for the pane's worst-case chrome (`zoomChrome`).
    func testAZoomedTableKeepsItsShape() {
        var zoomed = 0
        let need = TableLayout.zoomBannerReserve
        for w in stride(from: CGFloat(700), through: 1400, by: 25) {
            for h in stride(from: CGFloat(700), through: 1400, by: 25) {
                for bottomBar in [CGFloat(0), 45] {
                    let (size, chrome) = Self.ipad(w, h, bottomBar: bottomBar)
                    let L = TableLayout(size: size, chrome: chrome), base = TableLayout.unzoomed(size: size, chrome: chrome)
                    let tag = "\(size) pill \(bottomBar)"
                    XCTAssertGreaterThanOrEqual(L.zoom, 1, tag)
                    XCTAssertLessThanOrEqual(L.zoom, TableLayout.maxZoom + 0.0001, tag)
                    let worst = TableLayout.zoomChrome(chrome)
                    XCTAssertEqual(L.zoom, TableLayout.zoom(for: size, chrome: worst), tag)
                    guard L.zoom > 1 else {
                        XCTAssertEqual(L, base, tag)
                        continue
                    }
                    zoomed += 1
                    XCTAssertFalse(L.isDegraded, tag)
                    XCTAssertEqual(L.handScale, 1, tag)
                    XCTAssertEqual(L.trickScale, base.trickScale, tag)
                    XCTAssertEqual(L.mode, base.mode, tag)
                    XCTAssertEqual(L.seatRow.mode, base.seatRow.mode, tag)
                    XCTAssertTrue(L.seatRow.fits, tag)
                    XCTAssertEqual(L.usedBottomBar > 0, base.usedBottomBar > 0, tag)
                    for sp in [false, true] where base.disconnectBanner(height: need, spectating: sp) != nil {
                        XCTAssertNotNil(L.disconnectBanner(height: need / L.zoom, spectating: sp), tag)
                    }
                    // the largest such zoom: one step more no longer keeps the shape (for the worst-case chrome)
                    if L.zoom < TableLayout.maxZoom - 0.0001 {
                        let z = L.zoom + TableLayout.zoomStep
                        let wBase = TableLayout.unzoomed(size: size, chrome: worst)
                        let next = TableLayout.solved(size: size, chrome: worst, zoom: z)
                        let banner = [false, true].allSatisfy { sp in
                            next.fitsBanner(wBase.bannerRoom(spectating: sp, upTo: need), spectating: sp)
                        }
                        XCTAssertFalse(next.keepsShape(of: wBase) && banner, "\(tag): \(z) fits too")
                    }
                }
            }
        }
        XCTAssertGreaterThan(zoomed, 500)
    }

    /// The scene units map to the pane's points by `zoom` (SwiftUI), and the measured chrome
    /// comes back in scene units.
    func testScenePaneMapping() {
        let (size, chrome) = Self.ipad(1032, 1376)
        let L = TableLayout(size: size, chrome: chrome)
        XCTAssertEqual(L.zoom, 1.4)
        let z = L.zoom
        XCTAssertEqual(L.chrome.topBar, 75.5 / z, accuracy: 0.0001)
        XCTAssertEqual(L.chrome.safeArea.top, 32 / z, accuracy: 0.0001)
        XCTAssertEqual(L.chrome.cornerButton.width, 80 / z, accuracy: 0.0001)
        // the safe rect is the pane's safe area, in points
        let safe = L.window(L.safeRect)
        XCTAssertEqual(safe.minX, 0, accuracy: 0.0001)
        XCTAssertEqual(safe.minY, 32, accuracy: 0.0001)
        XCTAssertEqual(safe.width, 1032, accuracy: 0.0001)
        XCTAssertEqual(safe.maxY, 1376 - 20, accuracy: 0.0001)
        // the corner buttons' obstacle stays where the buttons are (their points)
        let corner = L.window(L.cornerRects[0])
        XCTAssertEqual(corner.minY, 32 + 75.5, accuracy: 0.0001)
        // the hand card on screen, the bid panel's room and its bottom inset
        XCTAssertEqual(L.window(TableLayout.rect(L.handBaseline, TableLayout.cardSize)).height, 145 * z, accuracy: 0.0001)
        XCTAssertEqual(L.window(L.bidBand).width, 340 * z, accuracy: 0.0001)
        XCTAssertEqual(L.bidPanelBottomInset, size.height - L.window(L.bidBand).maxY, accuracy: 0.0001)
        // a full-height edge strip: the corner buttons' padding is in points
        var strip = chrome
        strip.occlusions = [CGRect(x: -516, y: -688, width: 32, height: 1376)]
        let S = TableLayout(size: size, chrome: strip)
        XCTAssertEqual(S.paneOccludedLeft, 32, accuracy: 0.0001)
        XCTAssertEqual(S.window(S.safeRect).minX, 32, accuracy: 0.0001)
        // at zoom 1 the mapping is the identity it was
        let phone = TableLayout(size: CGSize(width: 393, height: 852), chrome: TableLayoutTests.chrome(TableLayoutTests.insets(59, 0, 34, 0)))
        XCTAssertEqual(phone.zoom, 1)
        XCTAssertEqual(phone.window(phone.bidBand).width, phone.bidBand.width)
        XCTAssertEqual(phone.paneOccludedLeft, phone.occludedLeft)
    }

    /// The rect model's no-intersection checks (TableLayoutTests.problems), seated and
    /// spectating, the seat row's 8 pt, and the hand inside the safe width, across big panes.
    func testNoIntersectionsWhenZoomed() {
        var checked = 0
        for w in stride(from: CGFloat(700), through: 1400, by: 50) {
            for h in stride(from: CGFloat(700), through: 1400, by: 50) {
                for bottomBar in [CGFloat(0), 45] {
                    for topBar in [CGFloat(70), 84] {
                        let size = CGSize(width: w, height: h)
                        let chrome = TableLayoutTests.chrome(TableLayoutTests.insets(32, 0, 20, 0), topBar: topBar, bottomBar: bottomBar)
                        let L = TableLayout(size: size, chrome: chrome)
                        guard L.zoom > 1 else { continue }
                        let tag = "\(size) topBar \(topBar) pill \(bottomBar) zoom \(L.zoom)"
                        XCTAssertTrue(TableLayoutTests.problems(L).isEmpty, "\(tag): \(TableLayoutTests.problems(L))")
                        XCTAssertTrue(TableLayoutTests.problems(L, spectator: true).isEmpty, "\(tag) spectator")
                        XCTAssertTrue(L.seatRowIsClear(L.seatRow.content), tag)
                        let hand = TableLayoutTests.handRect(L, count: 13, lifted: true)
                        XCTAssertGreaterThanOrEqual(hand.minX, L.safeRect.minX + TableLayout.margin - 0.01, tag)
                        XCTAssertLessThanOrEqual(hand.maxX, L.safeRect.maxX - TableLayout.margin + 0.01, tag)
                        checked += 1
                    }
                }
            }
        }
        XCTAssertGreaterThan(checked, 300)
    }

    // MARK: the scene

    func scene(_ h: ReplayHarness, size: CGSize, chrome: TableChrome) -> GameSKScene {
        let s = GameSKScene(size: size)
        s.animator = InstantAnimator()
        s.chrome = chrome
        s.configure(gameState: h.store, actions: h.actions)
        s.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        return s
    }

    /// A zoomed scene draws through a camera at 1 / zoom (the layout's scene units fill the
    /// pane); a phone's has none. A resize between the two adds and drops it.
    func testTheSceneZoomsThroughItsCamera() throws {
        let h = ReplayHarness()
        let (size, chrome) = Self.ipad(1376, 1032)
        let s = scene(h, size: size, chrome: chrome)
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        XCTAssertEqual(s.layout.zoom, 1.4)
        let cam = try XCTUnwrap(s.camera)
        XCTAssertEqual(cam.xScale, 1 / 1.4, accuracy: 0.0001)
        XCTAssertEqual(cam.position, .zero)
        // the felt fills what the camera sees (SKSpriteNode keeps its size as Float)
        XCTAssertEqual(s.backgroundNode.size.width, s.layout.size.width, accuracy: 0.001)
        XCTAssertEqual(s.backgroundNode.size.height, s.layout.size.height, accuracy: 0.001)
        // an unchanged zoomed layout is a no-op (the Float felt size still matches)
        let before = s.relayoutCount
        s.relayout(animated: false)
        XCTAssertEqual(s.relayoutCount, before, "an unchanged zoomed layout relaid out")
        // on screen: a hand card 203 pt tall (the camera's scale times the hand's)
        let card = try XCTUnwrap(s.handNode.sprites.values.first)
        XCTAssertEqual(card.size.height * s.handNode.yScale / cam.yScale, 145 * 1.4, accuracy: 0.01)
        // to a phone size: no camera, the scene exactly as before
        let phone = CGSize(width: 393, height: 852)
        s.size = phone
        XCTAssertEqual(s.layout.zoom, 1)
        XCTAssertNil(s.camera)
        XCTAssertEqual(s.backgroundNode.size, phone)
        s.size = size
        XCTAssertTrue(s.camera === cam)
        XCTAssertEqual(s.children.filter { $0 is SKCameraNode }.count, 1, "one camera, reused")
    }

    /// The fixture's "table.zoom" probe reports the layout's zoom, which the UI tests scale
    /// their point limits by (SeatRowUITests): 1.40 on an iPad 13, 1.00 on a phone.
    func testTheZoomProbeReportsTheLayoutsZoom() throws {
        let h = ReplayHarness()
        let (size, chrome) = Self.ipad(1032, 1376)
        let s = scene(h, size: size, chrome: chrome)
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        let probe = TableDebugProbe()
        XCTAssertEqual(probe.tableZoom, "-")
        probe.update(scene: s)
        XCTAssertEqual(s.layout.zoom, 1.4)
        XCTAssertEqual(probe.tableZoom, "1.40")
        XCTAssertEqual(probe.layoutCheck, "ok")
        s.chrome = TableLayoutTests.chrome(TableLayoutTests.insets(62, 0, 34, 0))
        s.size = CGSize(width: 402, height: 874)
        probe.update(scene: s)
        XCTAssertEqual(probe.tableZoom, "1.00")
    }

    /// A phone's scene never adds the camera node (its node tree is the one it was).
    func testAPhoneSceneHasNoCamera() throws {
        let h = ReplayHarness()
        let s = scene(h, size: CGSize(width: 402, height: 874), chrome: TableLayoutTests.chrome(TableLayoutTests.insets(62, 0, 34, 0)))
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        XCTAssertNil(s.camera)
        XCTAssertFalse(s.children.contains { $0 is SKCameraNode })
    }

    /// Scene text is drawn for the device's largest zoom and scaled back, so the zoomed camera
    /// shows it 1:1 (a phone's factor is 1: its labels are what they were).
    func testLabelsAreDrawnForTheDevicesLargestZoom() {
        let k = CardTextureGenerator.textureZoom
        XCTAssertEqual(k, UIDevice.current.userInterfaceIdiom == .phone ? 1 : TableLayout.maxZoom)
        func labels(_ n: SKNode) -> [SKLabelNode] {
            let own: [SKLabelNode] = (n as? SKLabelNode).map { [$0] } ?? []
            return own + n.children.flatMap(labels)
        }
        let seat = OpponentHandNode(position: .left, username: "kim")
        let bid = BidBubbleNode(bid: "3")
        let (chat, size) = SKChatBubbleManager.makeBubble("a fairly long chat line that has to wrap onto two lines at least", maxWidth: 200,
                                                   name: "chat.2", fill: .black, text: .white)
        let all = labels(seat) + labels(bid) + labels(chat)
        XCTAssertGreaterThanOrEqual(all.count, 4, "name, initial, bid, chat")
        for l in all {
            XCTAssertEqual(l.xScale, 1 / k, accuracy: 0.0001, l.text ?? "")
            XCTAssertEqual(l.yScale, 1 / k, accuracy: 0.0001, l.text ?? "")
        }
        // the same size in scene units as before: the 13 pt chat line still wraps to two lines
        XCTAssertLessThanOrEqual(size.height, 45, "two lines of 13 pt")
        XCTAssertGreaterThan(size.height, 30, "two lines of 13 pt")
        XCTAssertLessThanOrEqual(size.width, 200)
    }

    // MARK: SwiftUI at zoom

    func fit<V: View>(_ v: V, width: CGFloat) -> CGSize {
        UIHostingController(rootView: v).sizeThatFits(in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
    }

    /// The bid panel grows with the band (cells and the bottom row; the type stays Dynamic
    /// Type) and still fits it, HSI included.
    func testZoomedBidPanelFitsTheZoomedBand() throws {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertNotNil(h.store.myHSI)
        let z = TableLayout.maxZoom
        let band = CGSize(width: TableLayout.bidBandSize.width * z, height: TableLayout.bidBandSize.height * z)
        for type in [DynamicTypeSize.large, .xxLarge, .accessibility5] {
            let v = BidOverlayView(zoom: z).environmentObject(h.store).environmentObject(h.actions).environment(\.dynamicTypeSize, type)
            let s = fit(v, width: band.width)
            XCTAssertLessThanOrEqual(s.height, band.height, "\(type)")
            XCTAssertLessThanOrEqual(s.width, band.width + 0.5, "\(type)")
            let one = fit(BidOverlayView().environmentObject(h.store).environmentObject(h.actions).environment(\.dynamicTypeSize, type),
                          width: band.width)
            XCTAssertGreaterThan(s.height, one.height + 20, "\(type): the cells grew")
        }
    }

    /// My seat's row at zoom: HSI's slot and the voice button keep their scene slots (in points).
    func testSeatRowSlotsFollowTheZoom() {
        let z = TableLayout.maxZoom
        let slot = fit(SeatRowHSISlot(value: 99.9, zoom: z).fixedSize(), width: 600)
        XCTAssertEqual(slot.width, TableLayout.hsiSize.width * z, accuracy: 0.5)
        let (size, chrome) = Self.ipad(1032, 1376)
        let L = TableLayout(size: size, chrome: chrome)
        XCTAssertEqual(L.seatRow.mode, .row)
        // the voice button's slot starts where HSI's slot plus the spacing end, in points
        let hsi = L.window(L.seatRow.hsi), voice = L.window(L.seatRow.voice)
        XCTAssertEqual(voice.minX - hsi.minX, (TableLayout.hsiSize.width + TableLayout.seatRowSpacing) * z, accuracy: 0.001)
    }

    // MARK: the chrome a zoom is chosen for

    /// `zoomTopBar` covers the score bar on every pane that may zoom, in every fixture's state,
    /// at every type size (the bar caps its type at xLarge), so the measured bar never exceeds
    /// the worst case the zoom was chosen for (which would move the zoom mid-game).
    func testTheScoreBarFitsTheZoomsTopBar() throws {
        var tallest: CGFloat = 0
        for fx in ["presence-mixed", "trick-mid-lead3", "bidding-mid", "spectator-mid-hand", "tournament-game", "lazy-at-seat", "between-tricks"] {
            let h = ReplayHarness()
            h.store.apply(.snapshot(try T.snapshot(fx), .rejoin, hints: nil))
            for width in [CGFloat(700), 744, 834, 1032, 1376] {
                for type in [DynamicTypeSize.large, .xLarge, .xxxLarge, .accessibility5] {
                    let bar = fit(ScoreBarView().environmentObject(h.store).environment(\.dynamicTypeSize, type), width: width).height
                    XCTAssertLessThanOrEqual(bar, TableLayout.zoomTopBar, "\(fx) \(width) \(type)")
                    tallest = max(tallest, bar)
                }
            }
        }
        print("[Zoom] the tallest score bar: \(tallest) pt (zoomTopBar \(TableLayout.zoomTopBar))")
    }

    /// The scene takes SwiftUI's chrome from every view pass, the latest of a burst, on the next
    /// main-queue turn (GameSKScene.takeChrome): presence-mixed's table kept the bar's first,
    /// wrapped 109.5 pt and the banner's first 109 pt because the onChange that should have
    /// carried 71 / 123.5 pt fired twice in a frame and SwiftUI dropped it.
    func testTheSceneTakesTheLatestChromeOfABurst() throws {
        let h = ReplayHarness()
        let size = CGSize(width: 834, height: 1210)
        var first = TableLayoutTests.chrome(TableLayoutTests.insets(32, 0, 20, 0), topBar: 109.5, corner: CGSize(width: 80, height: 50.5))
        first.banner = 109
        let s = scene(h, size: size, chrome: first)
        h.store.apply(.snapshot(try T.snapshot("presence-mixed"), .rejoin, hints: nil))
        XCTAssertEqual(s.layout.chrome.topBar, 109.5 / s.layout.zoom, accuracy: 0.001)
        var last = first
        last.topBar = 71
        last.banner = 123.5
        var mid = first
        mid.topBar = 90
        s.takeChrome(mid)
        s.takeChrome(last)
        XCTAssertEqual(s.chrome, first, "never during the view pass")
        let turn = expectation(description: "the main queue's next turn")
        DispatchQueue.main.async { turn.fulfill() }
        wait(for: [turn], timeout: 2)
        XCTAssertEqual(s.chrome, last)
        XCTAssertEqual(s.layout, TableLayout(size: size, chrome: last))
        XCTAssertNotNil(s.layout.disconnectBanner(height: 123.5 / s.layout.zoom, spectating: false), "the banner has its spot")
        // an unchanged chrome is a no-op
        let before = s.relayoutCount
        s.takeChrome(last)
        let again = expectation(description: "again")
        DispatchQueue.main.async { again.fulfill() }
        wait(for: [again], timeout: 2)
        XCTAssertEqual(s.relayoutCount, before)
    }
}
