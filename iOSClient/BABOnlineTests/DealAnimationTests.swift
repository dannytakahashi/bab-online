import XCTest
import SpriteKit
@testable import BAB_Online

/// The live deal's fly-in (GameSKScene.dealIn, LiveAnimator.deal): it plays for a live
/// gameStart only (never a snapshot, a rejoin or a buffered catch-up), fades in place under
/// Reduce Motion, follows a relayout, lands at once on a tap or a snapshot, and ends where
/// the render put every card.
@MainActor
final class DealAnimationTests: XCTestCase {
    /// An iPad-sized pane: the table shows every seat's card backs there.
    static let size = CGSize(width: 1024, height: 768)

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
        Theme.Motion.reduceMotionOverride = false
    }

    override func tearDown() {
        Theme.Motion.reduceMotionOverride = nil
        super.tearDown()
    }

    private static let thirteen: [[String: Any]] =
        ["A", "K", "Q", "J", "10", "9", "8"].map { T.card("spades", $0) } + ["A", "K", "Q", "J", "10", "9"].map { T.card("hearts", $0) }

    private func isDealt(_ a: TableAnimation) -> Bool { if case .dealt = a { return true } else { return false } }

    /// A scene that is never in a window: LiveAnimator's actions are set up but never tick.
    private func makeScene(_ h: ReplayHarness, animator: Animator = LiveAnimator()) -> GameSKScene {
        let scene = GameSKScene(size: Self.size)
        scene.animator = animator
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: Self.size)))
        return scene
    }

    private func seat(_ h: ReplayHarness) {
        h.store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        h.store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        h.store.apply(T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
                                              "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]],
                                              "pics": [1, 2, 3, 4], "seq": 1]))
    }

    private func deal(_ h: ReplayHarness, seq: Int = 2, size: Int = 13) {
        h.store.apply(T.ev("gameStart", ["gameId": "g1", "hand": Array(Self.thirteen.prefix(size)), "trump": T.card("clubs", "5"),
                                         "score1": 0, "score2": 0, "dealer": 4, "position": 1, "currentHand": size, "seq": seq]))
    }

    private func backs(_ scene: GameSKScene) -> [SKNode] {
        scene.opponentManager.nodes.values.flatMap { $0.fanNode.children }
    }

    // MARK: - Reducer: when a deal flies

    func testALiveGameStartDealsItsOwnDeal() {
        var s = T.dealtState()
        let fx = TableReducer.reduce(&s, T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("clubs", "5"),
                                                            "score1": 0, "score2": 0, "dealer": 1, "position": 1, "currentHand": 1, "seq": 3]))
        XCTAssertEqual(fx.animations.filter(isDealt), [.dealt(dealSeq: s.table.deal!.dealSeq)])
        XCTAssertEqual(s.table.deal?.dealSeq, 2)
        // a spectator's deal flies too (the card backs)
        var spec = TableState()
        let sfx = TableReducer.reduce(&spec, T.ev("gameStart", ["gameId": "g1", "trump": T.card("clubs", "5"), "score1": 0, "score2": 0,
                                                                "dealer": 4, "currentHand": 1, "seq": 2]))
        XCTAssertEqual(sfx.animations.filter(isDealt).count, 1)
    }

    func testNoSnapshotOrRejoinDeals() throws {
        for name in try FixtureLoader.v2Names() {
            let raw = try FixtureLoader.v2Snapshot(name)
            let snap = try TableSnapshot.decode(raw, strict: true)
            for source in [SnapshotSource.rejoin, .restore, .spectate, .rejected, .requested("r")] {
                var s = TableState()
                XCTAssertFalse(TableReducer.reduce(&s, .snapshot(snap, source, hints: nil)).animations.contains(where: isDealt), "\(name) \(source)")
            }
            var r = TableState()
            XCTAssertFalse(TableReducer.reduce(&r, T.ev("rejoinSuccess", ["snapshot": raw])).animations.contains(where: isDealt), name)
        }
    }

    func testABufferedDealReplayedByACatchUpDoesNotFly() throws {
        // after a snapshot
        let snap = try T.snapshot("trick-mid-lead3")
        var s = TableState()
        TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))
        TableReducer.reduce(&s, T.ev("gameStart", ["gameId": snap.gameId, "hand": [T.card("spades", "A")], "trump": T.card("clubs", "5"),
                                                   "score1": 0, "score2": 0, "dealer": 1, "position": 1, "currentHand": 1, "seq": snap.seq + 2]))
        XCTAssertEqual(s.sync.buffered.count, 1, "seq gap: the deal waits for the resync")
        let resync = try T.snapshot("trick-mid-lead3") { $0["seq"] = snap.seq + 1 }
        let fx = TableReducer.reduce(&s, .snapshot(resync, .requested(s.sync.resyncId ?? ""), hints: nil))
        XCTAssertEqual(s.table.hand.count, 1, "the buffered deal applied")
        XCTAssertFalse(fx.animations.contains(where: isDealt))
        // a lapsed resync's flush
        var f = T.dealtState()
        TableReducer.reduce(&f, T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("clubs", "5"),
                                                   "score1": 0, "score2": 0, "dealer": 1, "position": 1, "currentHand": 1, "seq": 4]))
        XCTAssertEqual(f.sync.buffered.count, 1)
        let flushed = TableReducer.reduce(&f, .local(.snapshotUnavailable(requestId: f.sync.resyncId)))
        XCTAssertEqual(f.table.hand.count, 1)
        XCTAssertFalse(flushed.animations.contains(where: isDealt))
    }

    // MARK: - Scene

    func testALiveDealFliesEveryCardFromTheDeck() {
        let h = ReplayHarness()
        let scene = makeScene(h)
        seat(h)
        deal(h)
        let hand = scene.handNode.sprites.values.sorted { $0.zPosition < $1.zPosition }
        XCTAssertEqual(hand.count, 13)
        let slots = scene.layout.handSlots(count: 13)
        for (i, s) in hand.enumerated() {
            let d = try? XCTUnwrap(s.deal)
            XCTAssertEqual(d?.flies, true)
            XCTAssertNotNil(s.action(forKey: Deal.key))
            XCTAssertTrue(s.isHidden, "waits hidden for its turn")
            XCTAssertEqual(d?.target ?? .zero, slots[i], "lands in its slot")
            XCTAssertEqual(s.position, slots[i], "rests in its slot until its flight starts")
        }
        // the flight starts at the deck, at the hand's card size
        let start = scene.dealStart(hand[0], width: LayoutConstants.cardWidth)
        XCTAssertEqual(start?.scale ?? 0, 1, accuracy: 0.0001)
        let origin = scene.convert(start!.point, from: scene.handNode)
        XCTAssertEqual(origin.x, scene.layout.dealOrigin.x, accuracy: 0.01)
        XCTAssertEqual(origin.y, scene.layout.dealOrigin.y, accuracy: 0.01)
        // every seat's backs fly too, from the deck at the hand card's size
        XCTAssertNotNil(scene.layout.fans(spectating: false), "this pane shows card backs")
        let b = backs(scene)
        XCTAssertEqual(b.count, 39)
        XCTAssertTrue(b.allSatisfy { $0.deal?.flies == true && $0.isHidden })
        if let back = b.first, let s = scene.dealStart(back, width: TableLayout.fanCard.width) {
            let worldWidth = TableLayout.fanCard.width * s.scale * back.parent!.xScale
            XCTAssertEqual(worldWidth, TableLayout.cardSize.width * scene.layout.handScale, accuracy: 0.01)
        }
        XCTAssertNotNil(scene.dealDeck, "the deck is up")
        XCTAssertEqual(scene.dealDeck?.position, scene.layout.dealOrigin)
    }

    /// The deck is the hand's colour, the fans' backs it deals (CardBackColour.forHand): hand 2
    /// (10 cards) blue, hand 1 (12) and hand 13 red, on the iPad's pane (with fans) and on a
    /// table with no room for fans (SeatExtrasTests.small: the deck alone shows a back).
    func testTheDeckIsTheHandsColourAsTheFansItDeals() {
        for (size, want) in [(10, CardBackColour.blue), (12, .red), (13, .red)] {
            for (pane, chrome) in [(Self.size, TableChrome()), SeatExtrasTests.small] {
                let h = ReplayHarness()
                let scene = GameSKScene(size: pane)
                scene.animator = LiveAnimator()
                scene.configure(gameState: h.store, actions: h.actions)
                scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: pane)))
                scene.chrome = chrome
                seat(h)
                deal(h, size: size)
                let tag = "hand of \(size), \(Int(pane.width)) pt"
                XCTAssertEqual(scene.lastModel?.back, want, tag)
                let deck = try? XCTUnwrap(scene.dealDeck, tag)
                let textures = (deck?.children ?? []).compactMap { ($0 as? SKSpriteNode)?.texture }
                XCTAssertEqual(textures.count, 3, tag)
                XCTAssertTrue(textures.allSatisfy { $0 === CardTextureGenerator.cardBackTexture(colour: want) }, tag)
                XCTAssertFalse(textures.contains { $0 === CardTextureGenerator.cardBackTexture(colour: want == .red ? .blue : .red) }, tag)
                // the fans it deals (where the pane shows them) are the same colour
                let fanBacks = backs(scene).compactMap { ($0 as? SKSpriteNode)?.texture }
                if pane == Self.size {
                    XCTAssertEqual(fanBacks.count, 3 * size, tag)
                } else {
                    XCTAssertNil(scene.layout.fans(spectating: false), "\(tag): no room for fans")
                }
                XCTAssertTrue(fanBacks.allSatisfy { $0 === CardFanNode.backTexture(want) }, tag)
            }
        }
    }

    /// On the Duo's folds (TableLayoutTests.reachableFolds: tabletop and undocked book, the
    /// layout's own fold handling) the deck sits on the cluster's page, off the hinge; a scene
    /// with that chrome puts it there and the deal lands where the render put every card.
    func testOnTheDuosFoldsTheDeckStaysOffTheHinge() {
        var checked = 0
        for (fold, size, ins, topBar) in TableLayoutTests.reachableFolds {
            let chrome = TableLayoutTests.chrome(ins, topBar: topBar, fold: fold)
            let L = TableLayout(size: size, chrome: chrome)
            let tag = "\(size) fold \(fold) topBar \(topBar)"
            XCTAssertFalse(L.foldIgnored, tag)
            // the deck: three backs at the hand's card size, each 1.5 pt up and right of the last
            let w = TableLayout.cardSize.width * L.handScale, hgt = TableLayout.cardSize.height * L.handScale
            let deck = CGRect(x: L.dealOrigin.x - w / 2, y: L.dealOrigin.y - hgt / 2,
                              width: w + 3 * L.handScale, height: hgt + 3 * L.handScale)
            XCTAssertFalse(deck.intersects(fold), "\(tag): deck \(deck) on the hinge")
            XCTAssertTrue(L.safeRect.contains(deck), "\(tag): deck \(deck) off the safe area")
            if fold.width > fold.height {
                XCTAssertGreaterThan(deck.minY, fold.maxY, "\(tag): tabletop, above the hinge with the cluster")
            }

            let h = ReplayHarness()
            let scene = GameSKScene(size: size)
            scene.animator = LiveAnimator()
            scene.configure(gameState: h.store, actions: h.actions)
            scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
            scene.chrome = chrome
            seat(h)
            deal(h)
            XCTAssertEqual(scene.layout, L, tag)
            XCTAssertEqual(scene.dealDeck?.position.x ?? .nan, L.dealOrigin.x, accuracy: 0.01, tag)
            XCTAssertEqual(scene.dealDeck?.position.y ?? .nan, L.dealOrigin.y, accuracy: 0.01, tag)
            let slots = L.handSlots(count: 13)
            for (i, s) in scene.handNode.sprites.values.sorted(by: { $0.zPosition < $1.zPosition }).enumerated() {
                XCTAssertEqual(s.deal?.target.x ?? .nan, slots[i].x, accuracy: 0.01, tag)
                XCTAssertEqual(s.deal?.target.y ?? .nan, slots[i].y, accuracy: 0.01, tag)
            }
            checked += 1
        }
        XCTAssertGreaterThanOrEqual(checked, 10)
    }

    func testReduceMotionFadesTheHandInPlace() {
        Theme.Motion.reduceMotionOverride = true
        let h = ReplayHarness()
        let scene = makeScene(h)
        seat(h)
        deal(h)
        let slots = scene.layout.handSlots(count: 13)
        for (i, s) in scene.handNode.sprites.values.sorted(by: { $0.zPosition < $1.zPosition }).enumerated() {
            XCTAssertEqual(s.deal?.flies, false)
            XCTAssertFalse(s.isHidden)
            XCTAssertEqual(s.alpha, 0, "fades in")
            XCTAssertEqual(s.position, slots[i], "never moves")
        }
        XCTAssertTrue(backs(scene).allSatisfy { $0.deal?.flies == false && !$0.isHidden })
        XCTAssertNil(scene.dealDeck, "no deck crossing nothing")
    }

    func testARejoinSnapshotShowsTheHandWithoutADeal() throws {
        let h = ReplayHarness()
        let scene = makeScene(h)
        h.store.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertFalse(scene.handNode.sprites.isEmpty)
        XCTAssertTrue(scene.handNode.sprites.values.allSatisfy { $0.deal == nil && $0.action(forKey: Deal.key) == nil && !$0.isHidden })
        XCTAssertTrue(backs(scene).allSatisfy { $0.deal == nil && !$0.isHidden })
        XCTAssertNil(scene.dealDeck)
    }

    func testASnapshotMidDealLandsEverything() throws {
        let h = ReplayHarness()
        let scene = makeScene(h)
        seat(h)
        deal(h)
        XCTAssertNotNil(scene.dealDeck)
        // a resync's snapshot of the same deal
        var raw = try FixtureLoader.v2Snapshot("bidding-mid")
        raw["seq"] = 3
        h.store.apply(.snapshot(try TableSnapshot.decode(raw, strict: true), .requested("r"), hints: nil))
        XCTAssertNil(scene.dealDeck)
        XCTAssertTrue(scene.handNode.sprites.values.allSatisfy { $0.deal == nil && !$0.isHidden && $0.alpha == 1 })
        XCTAssertTrue(backs(scene).allSatisfy { $0.deal == nil && !$0.isHidden })
    }

    func testARelayoutMidDealReaimsTheFlights() {
        let h = ReplayHarness()
        let scene = makeScene(h)
        seat(h)
        deal(h)
        let before = scene.layout
        scene.chrome = TableChrome(safeArea: TableInsets(top: 24, left: 0, bottom: 20, right: 0), topBar: 80,
                                   cornerButton: CGSize(width: 70, height: 44))
        XCTAssertNotEqual(scene.layout, before)
        let slots = scene.layout.handSlots(count: 13)
        for (i, s) in scene.handNode.sprites.values.sorted(by: { $0.zPosition < $1.zPosition }).enumerated() {
            XCTAssertEqual(s.deal?.target, slots[i], "the flight lands in the new slot")
            XCTAssertEqual(s.position, slots[i], "a card still waiting sits there")
            XCTAssertNotNil(s.action(forKey: Deal.key), "the deal goes on")
        }
        XCTAssertEqual(scene.dealDeck?.position, scene.layout.dealOrigin, "the deck follows the table")
    }

    func testATapMidDealLandsThatCardAndLiftsIt() {
        let h = ReplayHarness()
        let scene = makeScene(h)
        seat(h)
        deal(h)
        h.store.apply(T.ev("updateTurn", ["currentTurn": 2, "seq": 3]))
        let s = scene.handNode.sprites.values.sorted(by: { $0.zPosition < $1.zPosition })[3]
        let slot = scene.layout.handSlots(count: 13)[3]
        s.isLegal = true  // a card that may be picked up (the tap's path, not the rules)
        s.touchesBegan([], with: nil)
        XCTAssertNil(s.deal)
        XCTAssertNil(s.action(forKey: Deal.key))
        XCTAssertFalse(s.isHidden)
        XCTAssertEqual(scene.handNode.liftedCardId, s.card.id)
        // landed at its slot, then the lift (moveBy) starts from there
        XCTAssertEqual(s.position, slot)
    }

    func testANewDealLandsTheOldOne() {
        let h = ReplayHarness()
        let scene = makeScene(h)
        seat(h)
        deal(h)
        let firstDeck = scene.dealDeck
        // an all-zero redeal: destroyHands and the next gameStart in one tick
        h.store.apply(T.ev("destroyHands", ["seq": 3]))
        deal(h, seq: 4)
        XCTAssertNil(firstDeck?.parent, "one deck at a time")
        XCTAssertNotNil(scene.dealDeck)
        XCTAssertEqual(scene.handNode.sprites.count, 13)
        XCTAssertTrue(scene.handNode.sprites.values.allSatisfy { $0.deal?.flies == true })
    }

    func testInstantAnimatorShowsTheDealtTableAtOnce() {
        let h = ReplayHarness()
        let scene = makeScene(h, animator: InstantAnimator())
        seat(h)
        deal(h)
        XCTAssertNil(scene.dealDeck)
        XCTAssertTrue(scene.handNode.sprites.values.allSatisfy { $0.deal == nil && !$0.isHidden })
        XCTAssertTrue(backs(scene).allSatisfy { $0.deal == nil && !$0.isHidden })
    }

    /// In a window, SpriteKit runs the deal: the cards leave the deck and land in their slots.
    func testTheDealLandsWhereTheRenderPutsTheCards() throws {
        let window = UIWindow(frame: CGRect(origin: .zero, size: Self.size))
        if let ws = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first { window.windowScene = ws }
        let view = SKView(frame: window.bounds)
        window.addSubview(view)
        window.isHidden = false
        defer { window.isHidden = true }
        let h = ReplayHarness()
        let scene = GameSKScene(size: Self.size)
        scene.animator = LiveAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        view.presentScene(scene)
        var ticked = false
        let probe = SKNode()
        scene.addChild(probe)
        probe.run(SKAction.sequence([SKAction.wait(forDuration: 0.05), SKAction.run { ticked = true }]))
        let probeDeadline = Date().addingTimeInterval(3)
        while !ticked && Date() < probeDeadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        probe.removeFromParent()
        if !ticked { throw XCTSkip("SpriteKit actions do not run in the hosted test window") }

        seat(h)
        deal(h)
        // mid-deal: the first card has left the deck and is on its way
        let first = scene.handNode.sprites.values.min { $0.zPosition < $1.zPosition }!
        let slot = scene.layout.handSlots(count: 13)[0]
        let mid = Date().addingTimeInterval(3)
        while (first.isHidden || first.deal?.start == nil) && Date() < mid { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertFalse(first.isHidden)
        XCTAssertNotEqual(first.position, slot, "in flight, not yet in its slot")
        let deadline = Date().addingTimeInterval(5)
        func dealing() -> Bool {
            scene.dealDeck != nil || scene.handNode.sprites.values.contains { $0.deal != nil } || backs(scene).contains { $0.deal != nil }
        }
        while dealing() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        XCTAssertFalse(dealing(), "the deal ends")
        let slots = scene.layout.handSlots(count: 13)
        for (i, s) in scene.handNode.sprites.values.sorted(by: { $0.zPosition < $1.zPosition }).enumerated() {
            XCTAssertEqual(s.position.x, slots[i].x, accuracy: 0.01)
            XCTAssertEqual(s.position.y, slots[i].y, accuracy: 0.01)
            XCTAssertEqual(s.xScale, 1, accuracy: 0.0001)
            XCTAssertFalse(s.isHidden)
        }
        // the backs land in their fan slots, at their turn
        for seat in scene.opponentManager.nodes.values {
            let fan = TableLayout.fanSlots(count: seat.fanNode.count)
            for (i, b) in seat.fanNode.children.sorted(by: { $0.zPosition < $1.zPosition }).enumerated() {
                XCTAssertEqual(b.position.x, fan[i].center.x, accuracy: 0.01)
                XCTAssertEqual(b.position.y, fan[i].center.y, accuracy: 0.01)
                XCTAssertEqual(b.zRotation, fan[i].rotation, accuracy: 0.0001)
                XCTAssertEqual(b.xScale, 1, accuracy: 0.0001)
            }
        }
        // and the tree is the one a rejoin into this deal would show
        let fresh = ReplayHarness()
        let freshScene = makeScene(fresh, animator: InstantAnimator())
        seat(fresh)
        deal(fresh)
        XCTAssertEqual(SceneDump.dump(scene), SceneDump.dump(freshScene))
    }

    // MARK: - Timing

    func testTheDealsTimingIsTheWebs() {
        // CardManager.js: DEAL_DELAY_MS 200, dealMs() = slow * 2, dealStaggerMs() = dealStagger
        XCTAssertEqual(Deal.wait, 0.2)
        XCTAssertEqual(Deal.flight, 0.7, accuracy: 0.0001)
        XCTAssertEqual(Deal.stagger, 0.035, accuracy: 0.0001)
        // a 13-card hand has landed 1.32 s after gameStart: before any bot's first bid could
        // end the bidding (pacing.js SOLO BOT_FIRST_BID 600 ms + 3 x BOT_BID 550 ms), and
        // nothing waits for it meanwhile
        XCTAssertLessThan(Deal.wait + 12 * Deal.stagger + Deal.flight, 0.6 + 3 * 0.55)
    }

    func testTheEaseIsTheWebsEmphasizedCurve() {
        XCTAssertEqual(Deal.ease(0), 0)
        XCTAssertEqual(Deal.ease(1), 1)
        var last: CGFloat = 0
        for i in 1...100 {
            let y = Deal.ease(Double(i) / 100)
            XCTAssertGreaterThanOrEqual(y, last)
            last = y
        }
        // cubic-bezier(.2,.8,.2,1) is a strong ease-out: about 0.95 of the way at half time
        XCTAssertEqual(Deal.ease(0.5), 0.95, accuracy: 0.02)
    }
}
