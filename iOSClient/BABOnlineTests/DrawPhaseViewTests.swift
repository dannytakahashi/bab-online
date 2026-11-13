import XCTest
import SwiftUI
@testable import BAB_Online

/// The draw for deal's layout and art (DrawPhaseView, owner 2026-11-12: "names too
/// close to card, icon not as nice, cards maybe not as high res"), hosted in a
/// window at phone, Duo, iPad sizes and read through DrawLayoutProbe.
@MainActor
final class DrawPhaseViewTests: XCTestCase {
    /// iPhone SE / 17e-class, 17e, Pro Max, the Duo closed, iPad 13 portrait and landscape.
    static let sizes = [CGSize(width: 375, height: 667), CGSize(width: 390, height: 844), CGSize(width: 440, height: 956),
                        CGSize(width: 466, height: 678), CGSize(width: 1032, height: 1376), CGSize(width: 1376, height: 1032)]

    enum Stage: String, CaseIterable { case start, mid, all, teams }

    /// The third and fourth drawers' names: the stock ones, or two that shrink in a phone's slot.
    static let stockNames = ("eve", "Bartholomew_Longname")
    static let longNames = ("JoAnn Jameson", "Christopher Johnson1")

    /// A store in the draw from the draw-in-progress fixture, the viewer fay (she drew
    /// first), or (`spectator`) a spectator, who has no draw of their own.
    private func store(_ stage: Stage, names: (String, String) = stockNames, spectator: Bool = false) throws -> GameState {
        let s = GameState()
        s.apply(.local(.identity(username: spectator ? "sam" : "fay", playerId: spectator ? "sid-sam" : "sid-fay")))
        let snap = try T.snapshot("draw-in-progress") { raw in
            var draw = raw["draw"] as! [String: Any]
            if spectator {
                draw["viewerDrawOrder"] = NSNull()  // as snapshotV2 sends a spectator
                var viewer = raw["viewer"] as! [String: Any]
                viewer["role"] = "spectator"
                raw["viewer"] = viewer
            }
            switch stage {
            case .start:
                draw["drawn"] = [Any]()
                draw["viewerDrawOrder"] = NSNull()
            case .mid:
                break
            case .all, .teams:
                draw["drawn"] = (draw["drawn"] as! [[String: Any]]) + [
                    ["drawOrder": 3, "username": names.0, "isBot": false, "card": T.card("diamonds", "7"), "position": NSNull()],
                    ["drawOrder": 4, "username": names.1, "isBot": false, "card": T.card("joker", "HI"), "position": NSNull()],
                ]
            }
            raw["draw"] = draw
        }
        s.apply(.snapshot(snap, .rejoin, hints: nil))
        return s
    }

    private var windows: [UIWindow] = []

    override func tearDown() {
        windows.forEach { $0.isHidden = true }
        windows = []
        super.tearDown()
    }

    /// Hosts DrawPhaseView at `size` and lets it settle (the 4th card's flip ends 1.4 s after it appears).
    @discardableResult
    private func host(_ s: GameState, _ size: CGSize, type: DynamicTypeSize = .large, teams: Bool = false) -> UIWindow {
        DrawLayoutProbe.record([:], container: .zero)
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        if let ws = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first { window.windowScene = ws }
        window.rootViewController = UIHostingController(rootView: DrawPhaseView().environmentObject(s).environment(\.dynamicTypeSize, type))
        window.isHidden = false
        windows.append(window)
        window.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(1.6))
        if teams {
            s.apply(T.ev("teamsAnnounced", ["team1": ["fay", "Bartholomew_Longname"], "team2": ["🤖 Mike", "eve"], "resumeInMs": 3000, "seq": 4]))
            RunLoop.main.run(until: Date().addingTimeInterval(1.6))  // 0.8 s + the 0.5 s fade
        }
        return window
    }

    private func tag(_ size: CGSize, _ stage: Stage, _ type: DynamicTypeSize) -> String { "\(Int(size.width))x\(Int(size.height)) \(stage) \(type)" }

    /// Each player's name sits at least Theme.Space.s3 (12 pt) above its card, at every
    /// size and text size (the 1.1 view had 8 pt: the owner's "names too close to card").
    func testNameSitsClearOfItsCard() throws {
        for size in Self.sizes {
            for type in [DynamicTypeSize.large, .xxxLarge, .accessibility5] {
                for stage in [Stage.mid, .all] {
                    host(try store(stage), size, type: type)
                    let f = DrawLayoutProbe.lastFrames
                    for i in 0..<4 {
                        let name = try XCTUnwrap(f["name.\(i)"], "name.\(i) \(tag(size, stage, type))")
                        let card = try XCTUnwrap(f["card.\(i)"], "card.\(i) \(tag(size, stage, type))")
                        XCTAssertGreaterThanOrEqual(card.minY - name.maxY, Theme.Space.s3 - 0.01, "slot \(i) \(tag(size, stage, type))")
                        XCTAssertGreaterThanOrEqual(name.minX, card.minX - Theme.Space.s3 / 2 - 0.5, "slot \(i): the name stays over its own card")
                        XCTAssertLessThanOrEqual(name.maxX, card.maxX + Theme.Space.s3 / 2 + 0.5, "slot \(i): the name stays over its own card")
                    }
                }
            }
        }
    }

    /// The four cards share one top edge whatever their names do: a long name shrinks
    /// (minimumScaleFactor) and its line with it, which must not lift its card (review
    /// 2026-11-12: "JoAnn Jameson" / "Christopher Johnson1" cards sat 3.5-4 pt higher).
    func testCardsShareOneTopEdge() throws {
        var sawShrunkName = false
        for size in Self.sizes {
            for type in [DynamicTypeSize.large, .xxxLarge, .accessibility5] {
                for names in [Self.stockNames, Self.longNames] {
                    host(try store(.all, names: names), size, type: type)
                    let f = DrawLayoutProbe.lastFrames
                    let what = "\(tag(size, .all, type)) \(names.1)"
                    let top = try XCTUnwrap(f["card.0"], what).minY
                    for i in 1..<4 {
                        let card = try XCTUnwrap(f["card.\(i)"], "card.\(i) \(what)")
                        XCTAssertEqual(card.minY, top, accuracy: 0.5, "card.\(i) \(what)")
                    }
                    let short = try XCTUnwrap(f["name.0"]).height, long = try XCTUnwrap(f["name.3"]).height
                    if long < short - 1 { sawShrunkName = true }
                    XCTAssertEqual(DrawLayoutProbe.lastCheck, "ok", what)
                }
            }
        }
        XCTAssertTrue(sawShrunkName, "some size shrinks a long name (else this test proves nothing)")
    }

    /// A spectator never draws (snapshotV2 sends them no viewerDrawOrder and the server
    /// ignores their `draw`): they see the draws arrive, never the deck or its button.
    func testSpectatorSeesTheDrawsNotTheDeck() throws {
        for stage in [Stage.start, .mid, .all] {
            let s = try store(stage, spectator: true)
            XCTAssertTrue(s.isSpectator)
            XCTAssertFalse(s.hasDrawn)
            host(s, CGSize(width: 390, height: 844))
            let f = DrawLayoutProbe.lastFrames
            XCTAssertNil(f["deck"], "\(stage): no deck for a spectator")
            XCTAssertNil(f["prompt"], "\(stage): no Tap to Draw")
            for i in 0..<4 { XCTAssertNotNil(f["card.\(i)"], "\(stage): slot \(i) shows") }
            XCTAssertEqual(DrawLayoutProbe.lastCheck, "ok", "\(stage)")
        }
        // a draw that arrives while they watch shows in its slot
        let s = try store(.mid, spectator: true)
        host(s, CGSize(width: 390, height: 844))
        XCTAssertEqual(s.drawResults.count, 2)
        s.apply(T.ev("playerDrew", ["username": "eve", "card": T.card("diamonds", "7"), "drawOrder": 3, "seq": 4]))
        XCTAssertEqual(s.drawResults.count, 3)
    }

    /// Nothing leaves the overlay's safe area or overlaps anything else, up to the
    /// largest Dynamic Type size, in all four stages (DrawLayoutProbe.check).
    func testNothingClippedAtTheLargestTextSize() throws {
        for size in Self.sizes {
            for type in [DynamicTypeSize.large, .accessibility5] {
                for stage in Stage.allCases {
                    host(try store(stage), size, type: type, teams: stage == .teams)
                    let f = DrawLayoutProbe.lastFrames
                    XCTAssertNotNil(f["title"], tag(size, stage, type))
                    if stage == .start {
                        XCTAssertNotNil(f["deck"], tag(size, stage, type))
                        XCTAssertNotNil(f["prompt"], tag(size, stage, type))
                    } else {
                        XCTAssertNotNil(f["card.3"], tag(size, stage, type))
                    }
                    if stage == .teams { XCTAssertNotNil(f["teams"], tag(size, stage, type)) }
                    XCTAssertEqual(DrawLayoutProbe.lastCheck, "ok", tag(size, stage, type))
                }
            }
        }
    }

    /// The cards on screen are CardTextureGenerator's bitmaps (the table's art), drawn no
    /// larger than they were rendered for, and the deck is its card back.
    func testCardsAreTheTablesArt() throws {
        let cards = [Card(suit: .clubs, rank: .jack), Card(suit: .hearts, rank: .king), Card(suit: .diamonds, rank: .seven), Card(suit: .joker, rank: .hi)]
        for size in [CGSize(width: 390, height: 844), CGSize(width: 1032, height: 1376)] {
            let window = host(try store(.all), size)
            let shot = snapshot(window)
            for (i, card) in cards.enumerated() {
                let r = try XCTUnwrap(DrawLayoutProbe.lastFrames["card.\(i)"], "card.\(i)")
                assertShows(CardTextureGenerator.image(for: card), in: r, of: shot, window: window, "\(card.id) at \(Int(size.width))")
            }
            window.isHidden = true
            let deckWindow = host(try store(.start), size)
            let deck = try XCTUnwrap(DrawLayoutProbe.lastFrames["deck"])
            // the top card of the deck: the art's size at the deck frame's top right (it is offset 2 pt per card)
            let m = DrawMetrics(width: DrawLayoutProbe.lastContainer.width)
            let top = CGRect(x: deck.maxX - m.card.width, y: deck.minY, width: m.card.width, height: m.card.height)
            assertShows(CardTextureGenerator.cardBackImage(), in: top, of: snapshot(deckWindow), window: deckWindow, "back at \(Int(size.width))")
        }
    }

    /// The art's pixels are never stretched past their size: the largest card shown is the hand card.
    func testCardsNeverSampleUp() {
        for width in stride(from: CGFloat(320), through: 1400, by: 10) {
            let m = DrawMetrics(width: width)
            XCTAssertLessThanOrEqual(m.card.width, TableLayout.maxCardPoints.width, "\(width)")
            XCTAssertLessThanOrEqual(m.card.height, TableLayout.maxCardPoints.height, "\(width)")
            XCTAssertLessThanOrEqual(4 * m.slotWidth, width - 2 * m.gutter + 0.01, "\(width): four slots fit")
        }
        let image = CardTextureGenerator.image(for: Card(suit: .spades, rank: .ace))
        XCTAssertEqual(image.size.width * image.scale, CardTextureGenerator.pixelSize().width)
        XCTAssertEqual(image.size, TableLayout.maxCardPoints, "the image is the hand card's size in points")
        XCTAssertTrue(image === CardTextureGenerator.image(for: Card(suit: .spades, rank: .ace)), "cached")
    }

    /// The draw's images are the textures' source bitmaps rendered once, not copied back
    /// out of SpriteKit: `SKTexture.cgImage()` costs 100x a render, on the main thread
    /// in the frame a card arrives (review 2026-11-12). With the textures already cached
    /// (as after prewarm), a new card's image costs about one render, and its pixels are
    /// the texture's.
    func testImagesAreRenderedNotReadBack() throws {
        let cards = Array(CardTextureGenerator.allCards.prefix(10))
        var render: [Double] = [], image: [Double] = []
        func time(_ work: () -> Void) -> Double {
            let t = CFAbsoluteTimeGetCurrent(); work(); return CFAbsoluteTimeGetCurrent() - t
        }
        for card in cards + cards {  // twice: the first pass warms the code paths
            _ = CardTextureGenerator.texture(for: card)
            CardTextureGenerator.removeImagesForTesting()
            render.append(time { _ = CardTextureGenerator.renderFaceForTesting(card) })
            image.append(time { _ = CardTextureGenerator.image(for: card) })
        }
        func median(_ xs: [Double]) -> Double { xs.suffix(cards.count).sorted()[cards.count / 2] }
        print("[DrawArt] image(for:) median \(median(image) * 1000) ms, a render \(median(render) * 1000) ms")
        XCTAssertLessThan(median(image), 3 * median(render) + 0.002, "a new card's image is one render, not a SpriteKit readback")

        // the same pixels the table's texture shows
        let card = Card(suit: .hearts, rank: .king)
        let mine = try XCTUnwrap(CardTextureGenerator.image(for: card).cgImage)
        let table = CardTextureGenerator.texture(for: card).cgImage()
        XCTAssertEqual(mine.width, table.width)
        XCTAssertEqual(mine.height, table.height)
        let n = (mine.width, mine.height)
        let a = pixels(mine, size: n), b = pixels(table, size: n)
        let off = stride(from: 0, to: a.count, by: 4).filter { p in (0..<4).contains { abs(Int(a[p + $0]) - Int(b[p + $0])) > 2 } }.count
        XCTAssertEqual(off, 0, "the image's pixels are the texture's")
    }

    /// The flips and the teams keep the timings SHIPPED_IOS_FLOORS was measured against.
    func testTeamsShowAfterTheirDelay() throws {
        let s = try store(.all)
        host(s, CGSize(width: 390, height: 844))
        XCTAssertNil(DrawLayoutProbe.lastFrames["teams"])
        s.apply(T.ev("teamsAnnounced", ["team1": ["fay", "eve"], "team2": ["🤖 Mike", "Bartholomew_Longname"], "resumeInMs": 3000, "seq": 4]))
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        XCTAssertNil(DrawLayoutProbe.lastFrames["teams"], "not before 0.8 s")
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        XCTAssertNotNil(DrawLayoutProbe.lastFrames["teams"], "shown from 0.8 s")
    }

    // MARK: pixels

    private func snapshot(_ window: UIWindow) -> CGImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = window.screen.scale
        format.preferredRange = .standard
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        return image.cgImage!
    }

    /// RGBA bytes of `image` drawn into `size` pixels.
    private func pixels(_ image: CGImage, size: (Int, Int)) -> [UInt8] {
        var buf = [UInt8](repeating: 0, count: size.0 * size.1 * 4)
        let ctx = CGContext(data: &buf, width: size.0, height: size.1, bitsPerComponent: 8, bytesPerRow: size.0 * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: size.0, height: size.1))
        return buf
    }

    /// The screen at `rect` (overlay space) shows `art`: at most 2 % of the pixels inside
    /// the card's rounded corners differ by more than 64 in a channel (resampling only).
    private func assertShows(_ art: UIImage, in rect: CGRect, of shot: CGImage, window: UIWindow, _ what: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        let scale = window.screen.scale
        let origin = DrawLayoutProbe.lastContainer.origin
        let inset = rect.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: rect.width * 0.08, dy: rect.width * 0.08)
        let px = CGRect(x: inset.minX * scale, y: inset.minY * scale, width: inset.width * scale, height: inset.height * scale).integral
        guard let crop = shot.cropping(to: px) else { return XCTFail("\(what): no pixels at \(px)", file: file, line: line) }
        // the art's same inner part, resampled to the crop's pixels
        let full = art.cgImage!
        let k = CGFloat(full.width) / rect.width
        let artInner = CGRect(x: rect.width * 0.08 * k, y: rect.width * 0.08 * k, width: inset.width * k, height: inset.height * k).integral
        let ref = full.cropping(to: artInner)!
        let n = (crop.width, crop.height)
        let a = pixels(crop, size: n), b = pixels(ref, size: n)
        var off = 0
        for p in stride(from: 0, to: a.count, by: 4) where (0..<3).contains(where: { abs(Int(a[p + $0]) - Int(b[p + $0])) > 64 }) {
            off += 1
        }
        let share = Double(off) / Double(n.0 * n.1)
        print("[DrawArt] \(what): \(String(format: "%.2f", share * 100))% of \(n.0)x\(n.1) px differ")
        XCTAssertLessThan(share, 0.02, "\(what): \(Int(share * 1000) / 10)% of the pixels are not the generator's art", file: file, line: line)
    }
}
