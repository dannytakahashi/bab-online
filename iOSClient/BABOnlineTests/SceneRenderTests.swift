import XCTest
import SpriteKit
@testable import BAB_Online

struct StubAvatarLoader: AvatarLoading {
    func load(_ picNumber: Int, completion: @escaping (UIImage?) -> Void) {}
}

/// Holds collect completions until released (the #187 collect gate).
final class HoldingAnimator: Animator {
    private let instant = InstantAnimator()
    var heldCollects: [() -> Void] = []
    var heldFades: [SKNode] = []
    func move(_ node: SKNode, to point: CGPoint, duration: TimeInterval, completion: (() -> Void)?) { instant.move(node, to: point, duration: duration, completion: completion) }
    func collect(_ nodes: [SKNode], to point: CGPoint, completion: @escaping () -> Void) { heldCollects.append { nodes.forEach { $0.removeFromParent() }; completion() } }
    func pop(_ node: SKNode) { instant.pop(node) }
    func fadeAndRemove(_ node: SKNode, after delay: TimeInterval) { heldFades.append(node) }
    func run(_ node: SKNode, _ action: SKAction, final: (SKNode) -> Void) { instant.run(node, action, final: final) }
}

@MainActor
final class SceneRenderTests: XCTestCase {
    static let size = CGSize(width: 466, height: 678)

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    /// A scene built offscreen (an SKView that is never in a window).
    func makeScene(_ h: ReplayHarness, animator: Animator = InstantAnimator(), chrome: TableChrome = .init()) -> GameSKScene {
        let scene = GameSKScene(size: Self.size)
        scene.animator = animator
        scene.chrome = chrome
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: Self.size)))
        return scene
    }

    func fixtureScene(_ name: String) throws -> (ReplayHarness, GameSKScene) {
        let h = ReplayHarness()
        let scene = makeScene(h)
        h.store.apply(.snapshot(try T.snapshot(name), .rejoin, hints: nil))
        return (h, scene)
    }

    // 1
    func testRenderIsIdempotentForEveryFixture() throws {
        let names = try FixtureLoader.v2Names()
        let (hb, sb) = try fixtureScene("trick-mid-lead3")
        _ = hb
        for name in names {
            let (h, scene) = try fixtureScene(name)
            let a = SceneDump.dump(scene)
            scene.render(TableRenderModel(h.store.state))
            XCTAssertEqual(SceneDump.dump(scene), a, "\(name): render twice")
            // A -> B -> A
            let b = TableRenderModel(sb.gameState!.state)
            scene.render(b)
            scene.render(TableRenderModel(h.store.state))
            let c = SceneDump.dump(scene)
            XCTAssertEqual(c, a, "\(name): A -> B -> A: only before \(Set(a).subtracting(c)); only after \(Set(c).subtracting(a))")
        }
    }

    // 2: Done-when (b). Also after EVERY recorded event: a no-op re-render
    // changes nothing (so each entrance / exit animation ended where the
    // reconcile puts it), nothing is left in transient and no collect is open
    // (InstantAnimator finishes everything at once)
    func testLiveReplayTreeEqualsFixtureRenderAtEveryCheckpoint() throws {
        var compared = 0
        var events = 0
        for game in try RecordedGame.all() {
            for viewer in game.viewers {
                let log = game.logs[viewer.label] ?? []
                let live = ReplayHarness(viewer: viewer)
                let liveScene = makeScene(live)
                var next = 0
                var failures = 0
                var eventFailures = 0
                for check in game.checks(for: viewer.label) {
                    while next < check.afterIndex {
                        let e = log[next]
                        try live.apply(e)
                        next += 1
                        guard e.dir == "s2c" else { continue }
                        events += 1
                        let after = SceneDump.dump(liveScene)
                        liveScene.renderLatest()
                        let again = SceneDump.dump(liveScene)
                        let transient = liveScene.transientLayer.children.count, collecting = liveScene.trickArea.collectingCount
                        if (after != again || transient + collecting != 0) && eventFailures < 2 {
                            eventFailures += 1
                            let d = zip(after, again).first { $0.0 != $0.1 }
                            XCTFail("\(game.name)/\(viewer.label) after #\(e.i) \(e.event): transient \(transient), collecting \(collecting); a re-render changed \(d.map { "\($0.0)  ->  \($0.1)" } ?? (after == again ? "nothing" : "the line count"))")
                        }
                    }
                    let fresh = ReplayHarness(viewer: viewer)
                    let freshScene = makeScene(fresh)
                    let snap = try TableSnapshot.decode(check.snapshot, strict: true)
                    let pics = LegacySeatHints(pics: live.store.players.seats.mapValues(\.pic))
                    fresh.store.apply(.snapshot(snap, .requested("fixture"), hints: pics))
                    let a = SceneDump.dump(liveScene), b = SceneDump.dump(freshScene)
                    if a != b && failures < 2 {
                        failures += 1
                        let diff = zip(a, b).enumerated().first { $0.element.0 != $0.element.1 }
                        XCTFail("\(game.name)/\(viewer.label) after #\(check.afterIndex): \(a.count) vs \(b.count) lines; first diff: \(diff.map { "\($0.element.0)  <>  \($0.element.1)" } ?? "length")")
                    }
                    compared += 1
                }
            }
        }
        XCTAssertGreaterThan(compared, 300)
        XCTAssertGreaterThan(events, 5000)
    }

    // 3
    func testLiveAnimationsConverge() throws {
        let window = UIWindow(frame: CGRect(origin: .zero, size: Self.size))
        if let ws = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first { window.windowScene = ws }
        let view = SKView(frame: window.bounds)
        window.addSubview(view)
        window.isHidden = false
        defer { window.isHidden = true }

        let game = try RecordedGame("events-bots-s12")
        let viewer = game.viewer("seat1")
        let log = game.logs["seat1"]!
        let h = ReplayHarness(viewer: viewer)
        let scene = GameSKScene(size: Self.size)
        scene.animator = LiveAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        view.presentScene(scene)
        scene.speed = 20
        // Skip only when SpriteKit demonstrably does not tick in this host
        let probe = SKNode()
        var ticked = false
        scene.addChild(probe)
        probe.run(SKAction.sequence([SKAction.wait(forDuration: 0.1), SKAction.run { ticked = true }]))
        let probeDeadline = Date().addingTimeInterval(3)
        while !ticked && Date() < probeDeadline { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        probe.removeFromParent()
        if !ticked { throw XCTSkip("SpriteKit actions do not run in the hosted test window") }
        // One hand: up to the first handComplete checkpoint
        let check = try XCTUnwrap(game.checks(for: "seat1").first { ($0.snapshot["stage"] as? String) == "HAND_RESOLVING" })
        for e in log.prefix(check.afterIndex) {
            try h.apply(e)
            RunLoop.main.run(until: Date().addingTimeInterval(0.002))
        }
        let deadline = Date().addingTimeInterval(3)
        func busy() -> Bool {
            scene.trickArea.collectingCount > 0 || !scene.transientLayer.children.isEmpty
                || scene.trickArea.children.contains { $0.hasActions() } || scene.handNode.children.contains { $0.hasActions() }
        }
        while busy() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        // SpriteKit ticks (the probe ran), so anything still busy is a real
        // regression: a collect gate that never releases (#187), a stuck sprite
        XCTAssertFalse(busy(), "did not converge: collectingCount \(scene.trickArea.collectingCount), transient \(scene.transientLayer.children.map { $0.name ?? "?" }), trick sprites with actions \(scene.trickArea.children.filter { $0.hasActions() }.count), hand sprites with actions \(scene.handNode.children.filter { $0.hasActions() }.count)")
        let fresh = ReplayHarness(viewer: viewer)
        let freshScene = makeScene(fresh)
        fresh.store.apply(.snapshot(try TableSnapshot.decode(check.snapshot, strict: true), .requested("f"), hints: nil))
        XCTAssertEqual(SceneDump.dump(scene), SceneDump.dump(freshScene))
    }

    // 4: 22.DW
    func testRelaunchMidTrickThenCollectLeavesNoGhosts() throws {
        let (h, scene) = try fixtureScene("trick-resolving")
        XCTAssertEqual(scene.trickArea.cardCount, 4)
        let seq = h.store.state.sync.lastSeq! + 1
        h.handler.handle(event: "trickComplete", payload: [["winner": 2, "seq": seq]])
        XCTAssertEqual(scene.trickArea.cardCount, 0)
        XCTAssertEqual(scene.trickArea.collectingCount, 0)
        XCTAssertTrue(scene.transientLayer.children.isEmpty)
    }

    private func myWinningTrick(_ h: ReplayHarness) {
        // seat 1 (me) leads the spades ace and wins; then it is my lead again
        h.store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        h.store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        let s = T.dealtState(hand: [T.card("spades", "A"), T.card("hearts", "2"), T.card("clubs", "K")], size: 3)
        _ = s
        h.store.apply(T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
                                              "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1]))
        h.store.apply(T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A"), T.card("hearts", "2"), T.card("clubs", "K")],
                                         "trump": T.card("diamonds", "5"), "score1": 0, "score2": 0, "dealer": 4, "position": 1, "currentHand": 3, "seq": 2]))
        h.store.apply(T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 3]))
    }

    // 5
    func testATapDuringTheCollectIsIgnored() throws {
        let holding = HoldingAnimator()
        let h = ReplayHarness()
        let scene = makeScene(h, animator: holding)
        myWinningTrick(h)
        XCTAssertTrue(h.actions.play(Card(suit: .spades, rank: .ace)))
        h.store.apply(T.ev("cardPlayed", ["card": T.card("spades", "A"), "position": 1, "trump": false, "seq": 4]))
        for (i, p) in [2, 3, 4].enumerated() {
            h.store.apply(T.ev("cardPlayed", ["card": T.card("spades", String(i + 2)), "position": p, "trump": false, "seq": 5 + i]))
        }
        h.store.apply(T.ev("trickComplete", ["winner": 1, "seq": 8]))
        h.store.apply(T.ev("updateTurn", ["currentTurn": 1]))
        XCTAssertEqual(h.store.myTurn, .choosing(.play))
        XCTAssertTrue(scene.trickManager.isCollecting)
        let sent = h.emitter.sent.count
        let card = Card(suit: .hearts, rank: .two)
        XCTAssertEqual(scene.handNode.sprite(for: card.id)?.isLegal, false, "dimmed while the trick flies")
        scene.cardManager.handleCardPlay(card)
        XCTAssertEqual(h.emitter.sent.count, sent, "gated")
        holding.heldCollects.forEach { $0() }
        XCTAssertFalse(scene.trickManager.isCollecting)
        XCTAssertEqual(scene.handNode.sprite(for: card.id)?.isLegal, true, "the collect completion re-renders")
        scene.cardManager.handleCardPlay(card)
        XCTAssertEqual(h.emitter.sent.count, sent + 1)
    }

    // 6 + ActionCoordinatorTests 11
    func testMyTrickCardIsTheTappedHandSpriteAndComesBackOnRollback() throws {
        let (h, scene) = try fixtureScene("trick-mid-lead3")
        let hand = TableRenderModel(h.store.state).hand!
        let card = try XCTUnwrap(hand.cards.first { hand.legalIds.contains($0.id) })
        let handSprite = try XCTUnwrap(scene.handNode.sprite(for: card.id))
        XCTAssertTrue(h.actions.play(card))
        let trickSprite = try XCTUnwrap(scene.trickArea.sprite(named: TrickAreaNode.spriteName(1, card)))
        XCTAssertTrue(trickSprite === handSprite, "one sprite: the tapped hand card flies to the trick")
        XCTAssertNil(scene.handNode.sprite(for: card.id))
        h.handler.handle(event: "actionRejected", payload: [["action": "play", "reason": "illegal_card", "snapshot": try FixtureLoader.v2Snapshot("trick-mid-lead3")]])
        XCTAssertTrue(scene.handNode.sprite(for: card.id) === handSprite, "the same sprite back in the hand")
        XCTAssertNil(scene.trickArea.sprite(named: TrickAreaNode.spriteName(1, card)))
    }

    // 7
    func testNodeIdentitiesAndTheLiftedCardSurviveRenders() throws {
        let (h, scene) = try fixtureScene("trick-mid-lead3")
        let hand = TableRenderModel(h.store.state).hand!
        let card = try XCTUnwrap(hand.cards.first { hand.legalIds.contains($0.id) })
        let sprite = try XCTUnwrap(scene.handNode.sprite(for: card.id))
        sprite.onTap?(card)  // first tap lifts
        XCTAssertEqual(scene.handNode.liftedCardId, card.id)
        let opponents = scene.opponentManager.nodes.mapValues { ObjectIdentifier($0) }
        let handNode = ObjectIdentifier(scene.handNode)
        h.store.apply(T.ev("chatMessage", ["username": "x", "message": "hi", "position": 3, "type": "player", "seq": h.store.state.sync.lastSeq! + 1]))
        scene.render(TableRenderModel(h.store.state))
        XCTAssertEqual(scene.opponentManager.nodes.mapValues { ObjectIdentifier($0) }, opponents)
        XCTAssertEqual(ObjectIdentifier(scene.handNode), handNode)
        XCTAssertTrue(scene.handNode.sprite(for: card.id) === sprite)
        XCTAssertEqual(scene.handNode.liftedCardId, card.id)
    }

    // 8
    func testTrickZFollowsPlayOrder() throws {
        let (_, scene) = try fixtureScene("trick-resolving")
        let byZ = scene.trickArea.cardSprites.sorted { $0.zPosition < $1.zPosition }.map { $0.name! }
        let snap = try T.snapshot("trick-resolving")
        XCTAssertEqual(byZ, snap.trick.cards.map { TrickAreaNode.spriteName($0.position, $0.card) })
        XCTAssertEqual(snap.trick.cards.first?.position, snap.trick.leadPosition)
    }

    // 9
    func testBidBubblesForBiddingMid() throws {
        let (_, scene) = try fixtureScene("bidding-mid")
        XCTAssertEqual(Set(scene.bidsLayer.children.compactMap(\.name)), ["bid.2", "bid.3"])
    }

    // 10
    func testTurnGlowIsOnAfterAResetRender() throws {
        let (h, scene) = try fixtureScene("between-tricks")  // seat 2 on turn
        XCTAssertEqual(scene.opponentManager.nodes[2]?.hasTurnGlow, true)
        h.store.apply(.snapshot(try T.snapshot("between-tricks"), .requested("again"), hints: nil))
        XCTAssertEqual(scene.opponentManager.nodes[2]?.hasTurnGlow, true)
        XCTAssertEqual(scene.opponentManager.nodes.values.filter(\.hasTurnGlow).count, 1)
    }

    // 11
    func testChatBubbleAppearsInTransient() throws {
        let h = ReplayHarness()
        let holding = HoldingAnimator()
        let scene = makeScene(h, animator: holding)
        h.store.apply(.snapshot(try T.snapshot("between-tricks"), .rejoin, hints: nil))
        h.store.apply(T.ev("chatMessage", ["username": "x", "message": "nice", "position": 3, "type": "player", "seq": h.store.state.sync.lastSeq! + 1]))
        XCTAssertNotNil(scene.transientLayer.childNode(withName: "chat.3"))
        h.store.apply(T.ev("chatMessage", ["username": "fan", "message": "go", "position": NSNull(), "isSpectator": true, "type": "spectator", "seq": h.store.state.sync.lastSeq! + 1]))
        // a spectator's line (isSpectator, no seat) goes by the spectator badge, not over a seat
        XCTAssertEqual(Set(scene.transientLayer.children.compactMap(\.name).filter { $0.hasPrefix("chat.") }), ["chat.3", "chat.spectator"])
    }

    func testSpectatorAndResizeKeepOpponentNodes() throws {
        let (h, scene) = try fixtureScene("spectator-mid-hand")
        XCTAssertEqual(scene.opponentManager.nodes.count, 4)
        XCTAssertTrue(scene.handNode.sprites.isEmpty)
        let ids = scene.opponentManager.nodes.mapValues { ObjectIdentifier($0) }
        scene.size = CGSize(width: 669, height: 951)  // Duo unfolded
        XCTAssertEqual(scene.opponentManager.nodes.mapValues { ObjectIdentifier($0) }, ids)
        XCTAssertEqual(scene.opponentManager.nodes[3]?.position, TableLayout(size: scene.size, chrome: scene.chrome).seatAnchor(.top))
        _ = h
    }
}
