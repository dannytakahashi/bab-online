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
    static let ipads: [(String, CGFloat, CGFloat, CGFloat)] = [
        ("iPad 13 portrait", 1032, 1376, 1.4), ("iPad 13 landscape", 1376, 1032, 1.4),
        ("iPad 11 portrait", 834, 1210, 1.4), ("iPad 11 landscape", 1210, 834, 1.15),
        ("iPad Air 11 portrait", 820, 1180, 1.4), ("iPad Air 11 landscape", 1180, 820, 1.15),
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

    /// A zoomed layout is zoom 1's table, larger: a full-size hand, the same trick scale,
    /// seat mode, seat-row form, bottom pill and fold handling, nothing degraded, and the
    /// disconnect banner's clear spot (where zoom 1 has one) kept.
    func testAZoomedTableKeepsItsShape() {
        var zoomed = 0
        for w in stride(from: CGFloat(700), through: 1400, by: 25) {
            for h in stride(from: CGFloat(700), through: 1400, by: 25) {
                for bottomBar in [CGFloat(0), 45] {
                    let (size, chrome) = Self.ipad(w, h, bottomBar: bottomBar)
                    let L = TableLayout(size: size, chrome: chrome), base = TableLayout.unzoomed(size: size, chrome: chrome)
                    let tag = "\(size) pill \(bottomBar)"
                    XCTAssertGreaterThanOrEqual(L.zoom, 1, tag)
                    XCTAssertLessThanOrEqual(L.zoom, TableLayout.maxZoom + 0.0001, tag)
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
                    if base.disconnectBanner(height: TableLayout.zoomBannerProbe, spectating: false) != nil {
                        XCTAssertNotNil(L.disconnectBanner(height: TableLayout.zoomBannerProbe / L.zoom, spectating: false), tag)
                    }
                    // the largest such zoom: one step more no longer keeps the shape
                    if L.zoom < TableLayout.maxZoom - 0.0001 {
                        let z = L.zoom + TableLayout.zoomStep
                        let next = TableLayout.unzoomed(size: CGSize(width: w / z, height: h / z), chrome: chrome.scaled(by: 1 / z))
                        let sameShape = !next.isDegraded && next.handScale == 1 && next.trickScale == base.trickScale && next.mode == base.mode
                            && next.seatRow.fits && next.seatRow.mode == base.seatRow.mode && (next.usedBottomBar > 0) == (base.usedBottomBar > 0)
                            && (base.disconnectBanner(height: TableLayout.zoomBannerProbe, spectating: false) == nil
                                || next.disconnectBanner(height: TableLayout.zoomBannerProbe / z, spectating: false) != nil)
                        XCTAssertFalse(sameShape, "\(tag): \(z) fits too")
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
}
