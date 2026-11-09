import XCTest
import SpriteKit
@testable import BAB_Online

/// Roadmap item 28: card texture size and prewarm (duo-7), effect art and
/// bundle assets (duo-13), avatar loading (ios-7).
@MainActor
final class AssetEfficiencyTests: XCTestCase {
    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    override func tearDown() {
        AvatarTextureCache.resetForTesting()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
        super.tearDown()
    }

    // MARK: duo-7 card textures

    /// TableLayout never draws a card larger than `maxCardPoints` (the hand at s = 1;
    /// trick sprites are 0.8k), and reaches it on the item's devices.
    func testNoCardIsDrawnLargerThanMaxCardPoints() {
        let named: [CGSize] = [CGSize(width: 393, height: 852), CGSize(width: 466, height: 678), CGSize(width: 951, height: 669),
                               CGSize(width: 1180, height: 820), CGSize(width: 820, height: 1180), CGSize(width: 669, height: 951),
                               CGSize(width: 572, height: 669), CGSize(width: 375, height: 667), CGSize(width: 320, height: 568)]
        var sizes = named
        for w in stride(from: 320, through: 1400, by: 60) { for h in stride(from: 480, through: 1400, by: 80) { sizes.append(CGSize(width: w, height: h)) } }
        var chromes: [TableChrome] = [TableChrome(), TableChrome(safeArea: TableInsets(top: 0, left: 0, bottom: 34, right: 84), topBar: 75)]
        var tabletop = TableChrome(safeArea: TableInsets(top: 0, left: 0, bottom: 34, right: 0), topBar: 75)
        tabletop.fold = CGRect(x: 0, y: 314.5, width: 572, height: 40)
        chromes.append(tabletop)
        var minTrick = CGFloat.infinity
        for size in sizes {
            for chrome in chromes {
                let L = TableLayout(size: size, chrome: chrome)
                XCTAssertLessThanOrEqual(L.handScale, TableLayout.maxHandScale, "\(size)")
                XCTAssertLessThanOrEqual(L.trickSpriteScale, TableLayout.maxHandScale, "\(size)")
                minTrick = min(minTrick, L.trickSpriteScale)
            }
        }
        for size in named.prefix(4) {
            XCTAssertEqual(TableLayout(size: size).handScale, TableLayout.maxHandScale, "\(size): a full-size hand card")
        }
        XCTAssertEqual(TableLayout.maxCardPoints, CGSize(width: 100, height: 145))
        // the smallest static card (no mipmaps needed above ~0.5 of the texture)
        XCTAssertGreaterThanOrEqual(minTrick, 0.48 - 0.001)
        print("[Textures] smallest trick sprite scale \(minTrick)")
    }

    /// Measured, not estimated: every face's bitmap is the largest on-screen card in
    /// pixels (300 x 435 on 3x, 200 x 290 on 2x), 8-bit RGBA; the total is printed.
    func testCardTexturePixelSizeAndTotalBytes() {
        CardTextureGenerator.resetForTesting()
        defer { CardTextureGenerator.resetForTesting() }
        XCTAssertEqual(CardTextureGenerator.pixelSize(scale: 3), CGSize(width: 300, height: 435))
        XCTAssertEqual(CardTextureGenerator.pixelSize(scale: 2), CGSize(width: 200, height: 290))
        let scale = CardTextureGenerator.displayScale
        let want = CGSize(width: (100 * scale).rounded(.up), height: (145 * scale).rounded(.up))
        XCTAssertEqual(CardTextureGenerator.pixelSize(), want)
        XCTAssertEqual(CardTextureGenerator.allCards.count, 54)
        XCTAssertEqual(Set(CardTextureGenerator.allCards.map(\.id)).count, 54)
        var total = 0
        for card in CardTextureGenerator.allCards {
            let cg = CardTextureGenerator.texture(for: card).cgImage()
            XCTAssertEqual(cg.width, Int(want.width), card.id)
            XCTAssertEqual(cg.height, Int(want.height), card.id)
            XCTAssertEqual(cg.bitsPerPixel, 32, "\(card.id): 8-bit RGBA, not extended range")
            XCTAssertLessThan(cg.bytesPerRow, cg.width * 4 + 64, card.id)
            total += cg.bytesPerRow * cg.height
        }
        XCTAssertEqual(CardTextureGenerator.onDemandRenders, 54)
        let back = CardTextureGenerator.cardBackTexture().cgImage()
        XCTAssertEqual(back.width, Int(want.width))
        XCTAssertLessThanOrEqual(total, 54 * Int(want.width * want.height) * 4 + 54 * 64 * Int(want.height))
        print("[Textures] scale \(scale): 54 faces of \(Int(want.width))x\(Int(want.height)) px = \(total) bytes (\(String(format: "%.2f", Double(total) / 1_000_000)) MB)")
    }

    /// The deal never draws a face on the main thread once prewarm ran: a 13-card
    /// hand, a fixture trick and a whole recorded game (hand, adopted and fresh
    /// trick sprites, every deal) hit the cache.
    func testPrewarmRendersOffMainAndTheSceneHitsTheCache() throws {
        CardTextureGenerator.resetForTesting()
        defer { CardTextureGenerator.resetForTesting() }
        let done = expectation(description: "prewarm")
        CardTextureGenerator.prewarm { done.fulfill() }
        wait(for: [done], timeout: 60)
        XCTAssertEqual(CardTextureGenerator.prewarmRenders, 54)
        XCTAssertEqual(CardTextureGenerator.mainThreadRenders, 0, "prewarm draws off the main thread")
        for card in CardTextureGenerator.allCards { XCTAssertNotNil(CardTextureGenerator.cachedTexture(card.id), card.id) }
        // a second call does nothing more (once per process)
        let again = expectation(description: "again")
        CardTextureGenerator.prewarm { again.fulfill() }
        wait(for: [again], timeout: 5)
        XCTAssertEqual(CardTextureGenerator.prewarmRenders, 54)

        // a 13-card hand
        let h = ReplayHarness()
        let scene = makeScene(h)
        let cards = (2...10).map { T.card("spades", String($0)) } + [T.card("hearts", "J"), T.card("hearts", "Q"), T.card("joker", "HI"), T.card("joker", "LO")]
        h.store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        h.store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        h.store.apply(T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "a", "b", "c"],
                                              "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1]))
        h.store.apply(T.ev("gameStart", ["gameId": "g1", "hand": cards, "trump": T.card("diamonds", "2"), "score1": 0, "score2": 0,
                                         "dealer": 4, "position": 1, "currentHand": 13, "seq": 2]))
        XCTAssertEqual(scene.handNode.sprites.count, 13)
        for (id, sprite) in scene.handNode.sprites {
            XCTAssertTrue(sprite.texture === CardTextureGenerator.cachedTexture(id), "\(id): the prewarmed texture")
        }
        // a fixture trick (fresh trick sprites)
        let fh = ReplayHarness()
        let trickScene = makeScene(fh)
        fh.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        XCTAssertFalse(trickScene.trickArea.cardSprites.isEmpty)
        // a whole recorded game for its first viewer
        let game = try XCTUnwrap(try RecordedGame.all().first)
        let viewer = try XCTUnwrap(game.viewers.first)
        let live = ReplayHarness(viewer: viewer)
        let liveScene = makeScene(live)
        var created = 0
        for e in game.logs[viewer.label] ?? [] {
            try live.apply(e)
            created = max(created, liveScene.handNode.sprites.count)
        }
        XCTAssertGreaterThan(created, 0)
        XCTAssertEqual(CardTextureGenerator.onDemandRenders, 0, "every sprite found its face cached")
        XCTAssertEqual(CardTextureGenerator.mainThreadRenders, 0)
    }

    /// Before prewarm finishes the main thread renders on demand, and prewarm keeps
    /// that texture (one texture per card, whoever stored it first).
    func testOnDemandBeforePrewarmAndConcurrentAccess() {
        CardTextureGenerator.resetForTesting()
        defer { CardTextureGenerator.resetForTesting() }
        let first = CardTextureGenerator.allCards[0]
        let early = CardTextureGenerator.texture(for: first)
        XCTAssertEqual(CardTextureGenerator.onDemandRenders, 1)
        XCTAssertEqual(CardTextureGenerator.mainThreadRenders, 1)
        let done = expectation(description: "prewarm")
        CardTextureGenerator.prewarm { done.fulfill() }
        // the main thread asks for every face while prewarm runs
        var seen: [String: SKTexture] = [:]
        for card in CardTextureGenerator.allCards.reversed() { seen[card.id] = CardTextureGenerator.texture(for: card) }
        wait(for: [done], timeout: 60)
        XCTAssertTrue(CardTextureGenerator.cachedTexture(first.id) === early)
        for card in CardTextureGenerator.allCards {
            XCTAssertTrue(seen[card.id] === CardTextureGenerator.cachedTexture(card.id), "\(card.id): one texture per card")
            XCTAssertTrue(CardTextureGenerator.texture(for: card) === seen[card.id], card.id)
        }
        XCTAssertGreaterThanOrEqual(CardTextureGenerator.onDemandRenders + CardTextureGenerator.prewarmRenders, 54)
        XCTAssertLessThan(CardTextureGenerator.prewarmRenders, 54, "the face rendered early is not drawn again")
    }

    // MARK: duo-13 effect art and bundle assets

    /// Effects keep their art's aspect inside their box (no 80 x 80 squash of b.png / 3b.png).
    func testEffectSpritesKeepTheArtAspect() throws {
        let h = ReplayHarness()
        let scene = makeScene(h)
        scene.animator = LiveAnimator()  // an offscreen scene does not tick: the effects stay up
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        let me = TableRenderModel(h.store.state).viewPosition
        scene.effectsManager.showRainbow(position: me, myPosition: me)
        scene.effectsManager.showOverTrump()
        for level in ["B", "2B", "3B", "4B"] { scene.effectsManager.showBoreBadge(level) }
        XCTAssertEqual(scene.effectsManager.live.count, 6)
        for e in scene.effectsManager.live {
            let sprite = try XCTUnwrap(e.node as? SKSpriteNode)
            sprite.removeAllActions()
            sprite.setScale(1)  // size reads the scaled size; the effects start at 0 / 0.5
            let tex = try XCTUnwrap(sprite.texture)
            let t = tex.size()
            XCTAssertGreaterThan(t.width, 0)
            let box: CGSize
            switch e.anchor {
            case .rainbow: box = TableLayout.rainbowSize
            case .bore: box = SKEffectsManager.boreBox
            case .overTrump: box = CGSize(width: TableLayout.overTrumpSize, height: TableLayout.overTrumpSize)
            }
            XCTAssertEqual(sprite.size.width / sprite.size.height, t.width / t.height, accuracy: 0.001, "\(e.anchor)")
            XCTAssertLessThanOrEqual(sprite.size.width, box.width + 0.001)
            XCTAssertLessThanOrEqual(sprite.size.height, box.height + 0.001)
            XCTAssertTrue(abs(sprite.size.width - box.width) < 0.001 || abs(sprite.size.height - box.height) < 0.001, "\(e.anchor) \(sprite.size) \(t) fills its box")
        }
        // the bore art is registered as 3x (its pixels are ~3x its 80 pt box), the rainbow as 1x
        XCTAssertEqual(UIImage(named: "3b")?.scale, 3)
        XCTAssertEqual(UIImage(named: "ot")?.scale, 3)
        XCTAssertEqual(UIImage(named: "rainbow1")?.scale, 1)
    }

    /// The 64 x 64 card PNGs are gone (the faces are drawn); the launch screen uses
    /// LaunchBackground (no white flash before the dark UI).
    func testBundleAssets() throws {
        for name in ["ace_spades", "10_hearts", "card_back", "hi_joker"] { XCTAssertNil(UIImage(named: name), name) }
        let launch = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "UILaunchScreen") as? [String: Any])
        XCTAssertEqual(launch["UIColorName"] as? String, "LaunchBackground")
        XCTAssertNotNil(UIColor(named: "LaunchBackground"))
    }

    // MARK: ios-7 avatars

    final class HeldAvatarLoader: AvatarLoading {
        var pending: [(Int, (UIImage?) -> Void)] = []
        func load(_ picNumber: Int, completion: @escaping (UIImage?) -> Void) { pending.append((picNumber, completion)) }
        func answer(_ n: Int, _ image: UIImage?) {
            let mine = pending.filter { $0.0 == n }
            pending.removeAll { $0.0 == n }
            mine.forEach { $0.1(image) }
        }
        static func image(_ color: UIColor) -> UIImage {
            UIGraphicsImageRenderer(size: CGSize(width: 192, height: 192)).image { ctx in color.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 192, height: 192)) }
        }
    }

    func testAvatarFetchedOncePerPictureAndCached() {
        AvatarTextureCache.resetForTesting()
        let loader = HeldAvatarLoader()
        OpponentHandNode.avatarLoader = loader
        let a = OpponentHandNode(position: .left, username: "A", pic: "5")
        let b = OpponentHandNode(position: .top, username: "B", pic: "5")
        XCTAssertEqual(AvatarTextureCache.fetches, 1, "two seats, one picture, one fetch")
        XCTAssertEqual(loader.pending.count, 1)
        loader.answer(5, HeldAvatarLoader.image(.red))
        for n in [a, b] {
            XCTAssertEqual(n.avatarImageCount, 1)
            XCTAssertEqual(n.avatarCropNodeCount, 0)
        }
        XCTAssertTrue(a.avatarTexture === b.avatarTexture)
        // a seat built again (next game, new layout) shows it at once, no fetch
        let c = OpponentHandNode(position: .right, username: "C", pic: "5")
        XCTAssertEqual(c.avatarImageCount, 1)
        XCTAssertEqual(AvatarTextureCache.fetches, 1)
        // an unchanged picture never reloads
        c.update(name: "C", pic: "5", isTurn: false)
        XCTAssertEqual(AvatarTextureCache.fetches, 1)
        XCTAssertEqual(c.avatarImageCount, 1)
        // the texture is the pre-cut circle at the screen scale
        let tex = c.avatarTexture!
        XCTAssertEqual(tex.size(), CGSize(width: 40, height: 40))
        XCTAssertEqual(tex.cgImage().width, Int(40 * UIGraphicsImageRendererFormat.preferred().scale))
    }

    func testStaleAvatarLoadsAreDroppedAndNeverStack() {
        AvatarTextureCache.resetForTesting()
        let loader = HeldAvatarLoader()
        OpponentHandNode.avatarLoader = loader
        let n = OpponentHandNode(position: .left, username: "A", pic: "7")
        n.update(name: "A", pic: "8", isTurn: false)
        n.update(name: "A", pic: "7", isTurn: false)   // back: joins the first fetch of 7
        XCTAssertEqual(AvatarTextureCache.fetches, 2)
        loader.answer(7, HeldAvatarLoader.image(.red))   // two waiters: only the current generation applies
        XCTAssertEqual(n.avatarImageCount, 1)
        loader.answer(8, HeldAvatarLoader.image(.blue))  // late answer for a picture the seat no longer has
        XCTAssertEqual(n.avatarImageCount, 1)
        XCTAssertTrue(n.avatarTexture === AvatarTextureCache.cached("7"))
        // switching between cached pictures replaces the one sprite
        n.update(name: "A", pic: "8", isTurn: false)
        XCTAssertEqual(n.avatarImageCount, 1)
        XCTAssertTrue(n.avatarTexture === AvatarTextureCache.cached("8"))
        // no picture: the initial again
        n.update(name: "A", pic: nil, isTurn: false)
        XCTAssertEqual(n.avatarImageCount, 0)
        // a picture whose load fails is not cached; the seat keeps its initial
        n.update(name: "A", pic: "9", isTurn: false)
        loader.answer(9, nil)
        XCTAssertEqual(n.avatarImageCount, 0)
        XCTAssertNil(AvatarTextureCache.cached("9"))
    }

    func testDataURLAvatarIsCachedAndShownAtOnce() throws {
        AvatarTextureCache.resetForTesting()
        let png = try XCTUnwrap(HeldAvatarLoader.image(.green).pngData())
        let pic = "data:image/png;base64," + png.base64EncodedString()
        let a = OpponentHandNode(position: .left, username: "A", pic: pic)
        XCTAssertEqual(a.avatarImageCount, 1)
        let b = OpponentHandNode(position: .top, username: "B", pic: pic)
        XCTAssertTrue(a.avatarTexture === b.avatarTexture)
        XCTAssertEqual(AvatarTextureCache.fetches, 0)
    }

    // MARK: helpers

    func makeScene(_ h: ReplayHarness) -> GameSKScene {
        let size = CGSize(width: 466, height: 678)
        let scene = GameSKScene(size: size)
        scene.animator = InstantAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        return scene
    }
}
