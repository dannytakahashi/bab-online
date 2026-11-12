import XCTest
import SpriteKit
@testable import BAB_Online

/// Records every move with the node's position when the move starts.
final class RecordingMoveAnimator: Animator {
    private let instant = InstantAnimator()
    var moves: [(name: String, from: CGPoint, to: CGPoint)] = []
    func move(_ node: SKNode, to point: CGPoint, duration: TimeInterval, completion: (() -> Void)?) {
        moves.append((node.name ?? "?", node.position, point))
        instant.move(node, to: point, duration: duration, completion: completion)
    }
    func collect(_ nodes: [SKNode], to point: CGPoint, completion: @escaping () -> Void) { instant.collect(nodes, to: point, completion: completion) }
    func pop(_ node: SKNode) { instant.pop(node) }
    func fadeAndRemove(_ node: SKNode, after delay: TimeInterval) { instant.fadeAndRemove(node, after: delay) }
    func run(_ node: SKNode, _ action: SKAction, final: (SKNode) -> Void) { instant.run(node, action, final: final) }
}

/// Regressions found in the item 23 review (scene, reducer, coordinator).
@MainActor
final class ReviewRegressionTests: XCTestCase {
    static let size = CGSize(width: 466, height: 678)

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    private func makeScene(_ h: ReplayHarness, animator: Animator, size: CGSize = CGSize(width: 466, height: 678),
                           chrome: TableChrome = .init()) -> GameSKScene {
        let scene = GameSKScene(size: size)
        scene.animator = animator
        scene.chrome = chrome
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        return scene
    }

    private func dealt(_ h: ReplayHarness) {
        h.store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        h.store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        h.store.apply(T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
                                              "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1]))
        h.store.apply(T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A"), T.card("hearts", "2"), T.card("clubs", "K")],
                                         "trump": T.card("diamonds", "5"), "score1": 0, "score2": 0, "dealer": 4, "position": 1, "currentHand": 3, "seq": 2]))
    }

    private func r(_ p: CGPoint) -> String { String(format: "(%.1f,%.1f)", p.x, p.y) }

    // MARK: scene

    /// A cardPlayed that confirms my card after the 0.25 s submit fly ended must not fly it in again.
    func testLateAckDoesNotReflyMyOwnCard() throws {
        let rec = RecordingMoveAnimator()
        let h = ReplayHarness()
        let scene = makeScene(h, animator: rec)
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        let card = Card(suit: .clubs, rank: .ten)
        XCTAssertTrue(h.actions.play(card))
        let name = TrickAreaNode.spriteName(1, card)
        let sprite = try XCTUnwrap(scene.trickArea.sprite(named: name))
        XCTAssertEqual(r(sprite.position), r(scene.layout.trickSlot(.bottom)), "the submit fly has finished")
        let before = rec.moves.count
        h.handler.handle(event: "cardPlayed", payload: [["card": T.card("clubs", "10"), "position": 1, "trump": false, "seq": h.store.state.sync.lastSeq! + 1]])
        XCTAssertEqual(rec.moves.dropFirst(before).filter { $0.name == name }.map { "\($0.from)" }, [], "the confirmed card flew again")
        XCTAssertTrue(scene.trickArea.sprite(named: name) === sprite)
        // An opponent's card still flies in from its seat
        let next = h.store.state.sync.lastSeq! + 1
        h.handler.handle(event: "cardPlayed", payload: [["card": T.card("clubs", "J"), "position": 2, "trump": false, "seq": next]])
        let opp = TrickAreaNode.spriteName(2, Card(suit: .clubs, rank: .jack))
        let g = scene.layout
        let rel = Positions.getRelative(target: 2, from: 1)
        XCTAssertEqual(rec.moves.filter { $0.name == opp }.map { "\(r($0.from))->\(r($0.to))" }, ["\(r(g.trickEntry(rel)))->\(r(g.trickSlot(rel)))"])
    }

    /// A card lifted outside my play window (here: on my bid turn) is lowered when the window opens.
    func testALiftFromBiddingNeedsTwoTapsInThePlayWindow() throws {
        let h = ReplayHarness()
        let scene = makeScene(h, animator: InstantAnimator())
        dealt(h)
        h.store.apply(T.ev("updateTurn", ["currentTurn": 1]))
        XCTAssertEqual(h.store.myTurn, .choosing(.bid))
        let card = Card(suit: .hearts, rank: .two)
        try XCTUnwrap(scene.handNode.sprite(for: card.id)).onTap?(card)
        XCTAssertEqual(scene.handNode.liftedCardId, card.id, "lifting to look is allowed")
        XCTAssertTrue(h.actions.bid("1"))
        h.store.apply(T.ev("bidReceived", ["bid": 1, "position": 1, "bidArray": [1, NSNull(), NSNull(), NSNull()], "seq": 3]))
        h.store.apply(T.ev("bidReceived", ["bid": 0, "position": 2, "bidArray": [1, 0, NSNull(), NSNull()], "seq": 4]))
        h.store.apply(T.ev("bidReceived", ["bid": 0, "position": 3, "bidArray": [1, 0, 0, NSNull()], "seq": 5]))
        h.store.apply(T.ev("bidReceived", ["bid": 0, "position": 4, "bidArray": [1, 0, 0, 0], "seq": 6]))
        h.store.apply(T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 7]))
        h.store.apply(T.ev("updateTurn", ["currentTurn": 1]))
        XCTAssertEqual(h.store.myTurn, .choosing(.play))
        XCTAssertNil(scene.handNode.liftedCardId, "the play window starts unlifted")
        let sprite = try XCTUnwrap(scene.handNode.sprite(for: card.id))
        XCTAssertFalse(sprite.isLifted)
        XCTAssertEqual(sprite.position.y, 0, "lowered to its slot")
        let sent = h.emitter.sent.count
        sprite.onTap?(card)
        XCTAssertEqual(h.emitter.sent.count, sent, "one tap only lifts")
        sprite.onTap?(card)
        XCTAssertEqual(h.emitter.sent.count, sent + 1, "the second tap plays")
    }

    /// My own chat line gets no bubble over my hand (the log has it); others' lines still do.
    func testMyOwnChatBubbleNeverCoversMyHand() throws {
        let h = ReplayHarness()
        let scene = makeScene(h, animator: HoldingAnimator())
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        let me = try XCTUnwrap(h.store.state.table.viewer.position)
        h.store.apply(T.ev("chatMessage", ["username": "me", "message": "good luck everyone, have fun!", "position": me, "type": "player", "seq": h.store.state.sync.lastSeq! + 1]))
        XCTAssertNil(scene.transientLayer.childNode(withName: "chat.\(me)"))
        XCTAssertTrue(h.store.log.entries.contains { $0.message == "good luck everyone, have fun!" })
        let other = me % 4 + 1
        h.store.apply(T.ev("chatMessage", ["username": "x", "message": "gl", "position": other, "type": "player", "seq": h.store.state.sync.lastSeq! + 1]))
        let bubble = try XCTUnwrap(scene.transientLayer.childNode(withName: "chat.\(other)"))
        let bf = bubble.calculateAccumulatedFrame()
        let bubbleRect = CGRect(origin: scene.transientLayer.convert(bf.origin, to: scene), size: bf.size)
        for s in scene.handNode.sprites.values {
            let r = CGRect(origin: scene.handNode.convert(s.frame.origin, to: scene), size: s.frame.size)
            XCTAssertFalse(r.intersects(bubbleRect), "seat \(other)'s bubble over my \(s.card.id)")
        }
    }

    /// Bid bubbles (up for the whole bidding) clear every seat's avatar, glow and name label.
    /// Real node frames at the TableLayout positions; also the bottom seat (mine,
    /// a spectator's seat 1..4), the bid band and the corner buttons.
    func testBidBubblesClearTheSeatNames() {
        var sizes: [(CGSize, TableChrome)] = []
        for size in [Self.size, CGSize(width: 375, height: 667), CGSize(width: 669, height: 951), CGSize(width: 1024, height: 1366)] {
            sizes.append((size, TableChrome()))
            sizes.append((size, TableLayoutTests.chrome()))
        }
        for (size, ins) in TableLayoutTests.scopeSizes { sizes.append((size, TableLayoutTests.chrome(ins))) }
        for (size, chrome) in sizes {
            let g = TableLayout(size: size, chrome: chrome)
            let root = SKNode()
            func frame(_ n: SKNode) -> CGRect { n.calculateAccumulatedFrame() }
            for rel in [Positions.RelativePosition.top, .left, .right, .bottom] {
                let seat = OpponentHandNode(position: rel, username: "WWWWWWWWWWWW")  // 12 wide characters: truncated to the layout's width
                seat.position = g.seatAnchor(rel)
                seat.showTurnGlow()
                seat.showSpeakingGlow()
                root.addChild(seat)
                let bubbleNode = BidBubbleNode(bid: "4B")
                bubbleNode.position = g.bubbleAnchor(rel)
                root.addChild(bubbleNode)
                let bubble = frame(bubbleNode)
                let glow = seat.convert(frame(seat.children.first { $0.role == "glow.turn" }!), to: root)
                let nameLabel = seat.children.compactMap { $0 as? SKLabelNode }.first!
                let name = seat.convert(frame(nameLabel), to: root)
                XCTAssertLessThanOrEqual(name.width, TableLayout.nameMaxWidth + 0.5, "\(size) \(rel): the name is truncated")
                XCTAssertFalse(bubble.intersects(glow), "\(size) \(rel): bubble over the avatar / glow")
                XCTAssertFalse(bubble.intersects(name), "\(size) \(rel): bubble over the name")
                let cardNode = SKSpriteNode(color: .white, size: TableLayout.cardSize)
                cardNode.setScale(g.trickSpriteScale)
                cardNode.position = g.trickSlot(rel)
                root.addChild(cardNode)
                let card = frame(cardNode)
                XCTAssertFalse(bubble.intersects(card), "\(size) \(rel): bubble over the trick card")
                for c in g.cornerRects {
                    XCTAssertFalse(bubble.intersects(c), "\(size) \(rel): bubble under a corner button")
                    XCTAssertFalse(frame(seat).intersects(c), "\(size) \(rel): seat under a corner button")
                }
                if rel != .bottom {
                    // my bubble and the bid panel are on screen together; the others' bubbles must clear it
                    XCTAssertFalse(bubble.intersects(g.bidBand), "\(size) \(rel): bubble under the bid panel")
                    XCTAssertFalse(frame(seat).intersects(g.bidBand), "\(size) \(rel): seat under the bid panel")
                    XCTAssertFalse(bubble.intersects(g.bubbleRect(.bottom)), "\(size) \(rel): bubble over mine")
                } else {
                    XCTAssertFalse(bubble.intersects(g.trickRect(.left)), "\(size): my bubble over the left card")
                }
            }
        }
    }

    /// At gameEnd the final table stays behind GameEndView (opponents and history).
    func testGameEndKeepsTheLastTable() throws {
        let h = ReplayHarness()
        let scene = makeScene(h, animator: InstantAnimator())
        h.store.apply(.snapshot(try T.snapshot("hand-resolving"), .rejoin, hints: nil))
        let before = SceneDump.dump(scene)
        XCTAssertFalse(scene.opponentManager.nodes.isEmpty)
        h.store.apply(T.ev("gameEnd", ["winningTeam": 1, "team1Score": 100, "team2Score": 50, "tournamentId": NSNull(),
                                       "seq": h.store.state.sync.lastSeq! + 1]))
        XCTAssertEqual(h.store.phase, .ended)
        XCTAssertEqual(SceneDump.dump(scene), before)
        // ...and the next game's draw clears it
        h.store.apply(.local(.enterGameContext(gameId: "next", tournamentId: nil)))
        XCTAssertTrue(scene.opponentManager.nodes.isEmpty)
    }

    /// A scene reset stops what flies in transient (the collect's completion
    /// is released, never run later against a newer collect).
    func testResetStopsTransientActions() throws {
        let h = ReplayHarness()
        let scene = makeScene(h, animator: LiveAnimator())  // never ticks: no SKView in a window
        h.store.apply(.snapshot(try T.snapshot("trick-resolving"), .rejoin, hints: nil))
        h.handler.handle(event: "trickComplete", payload: [["winner": 2, "seq": h.store.state.sync.lastSeq! + 1]])
        let flying = scene.transientLayer.children
        XCTAssertEqual(flying.count, 4)
        XCTAssertTrue(flying.allSatisfy { $0.hasActions() })
        XCTAssertEqual(scene.trickArea.collectingCount, 1)
        h.store.apply(.snapshot(try T.snapshot("between-tricks"), .requested("again"), hints: nil))
        XCTAssertTrue(scene.transientLayer.children.isEmpty)
        XCTAssertEqual(scene.trickArea.collectingCount, 0)
        XCTAssertTrue(flying.allSatisfy { !$0.hasActions() && $0.parent == nil })
    }

    // MARK: reducer

    /// replayPresenceTo re-sends playerDisconnected for resignable seats: a setter, never a downgrade.
    func testPlayerDisconnectedNeverDowngradesAResignableOrAwaySeat() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": 3, "username": "P", "seq": 3]))
        XCTAssertEqual(s.players.seats[3]?.presence, .grace)
        TableReducer.reduce(&s, T.ev("resignationAvailable", ["position": 3, "username": "P", "seq": 4]))
        XCTAssertEqual(s.players.seats[3]?.presence, .resignable)
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": 3, "username": "P"]))  // private replay
        XCTAssertEqual(s.players.seats[3]?.presence, .resignable)
        s.players.seats[2]?.presence = .away
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": 2, "username": "L"]))
        XCTAssertEqual(s.players.seats[2]?.presence, .away)
        TableReducer.reduce(&s, T.ev("playerReconnected", ["position": 3, "username": "P", "seq": 5]))
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": 3, "username": "P", "seq": 6]))
        XCTAssertEqual(s.players.seats[3]?.presence, .grace, "a fresh drop after a return is grace again")
    }

    /// Entering a game context makes me an entrant (the server's role until seating).
    func testEnteringAGameIsEntrantUntilSeated() {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "me", playerId: "sid-me")))
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        XCTAssertEqual(s.table.viewer.role, .entrant)
        XCTAssertEqual(s.myTurn, .waiting)
        s = T.dealtState()
        XCTAssertEqual(s.table.viewer.role, .seat)
    }

    /// A null reply to another request (an ack resync) still flushes a pending gap buffer.
    func testANullAckReplyFlushesAPendingGapBuffer() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "1", "0", "0"], "lead": 2, "seq": 3]))
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "4"), "position": 2, "trump": false, "seq": 5]))
        XCTAssertEqual(s.sync.resyncId, "gap-1")
        TableReducer.reduce(&s, T.ev("stateSnapshot", ["snapshot": NSNull(), "reason": "not_in_game", "requestId": "ack-9"]))
        XCTAssertEqual(s.sync.buffered, [])
        XCTAssertNil(s.sync.resyncId)
        XCTAssertEqual(s.table.phase.trick.count, 1)
    }

    // MARK: coordinator

    /// A gap request suppressed behind an unanswered one goes out when that one lapses.
    func testASuppressedGapRequestIsSentLater() throws {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        let card = try XCTUnwrap(TableRenderModel(h.store.state).hand.flatMap { hand in hand.cards.first { hand.legalIds.contains($0.id) } })
        XCTAssertTrue(h.actions.play(card))
        h.store.apply(.local(.transportError(handler: "playCard")))  // ack-1 in flight
        XCTAssertEqual(h.emitter.snapshotRequests, ["ack-1"])
        let seq = h.store.state.sync.lastSeq!
        h.handler.handle(event: "chatMessage", payload: [["username": "x", "message": "m", "position": 2, "type": "player", "seq": seq + 2]])
        XCTAssertEqual(h.store.state.sync.resyncId, "gap-1")
        XCTAssertEqual(h.emitter.snapshotRequests, ["ack-1"], "debounced behind ack-1")
        // ack-1 is never answered (its own retry re-arms the in-flight window once)
        h.clock.advance(AckPolicy.timeout + 0.1)
        h.clock.advance(AckPolicy.timeout + 0.1)
        XCTAssertTrue(h.emitter.snapshotRequests.contains("gap-1"), "\(h.emitter.snapshotRequests)")
    }
}
