import XCTest
import SpriteKit
@testable import BAB_Online

/// Full relayout (item 25): a size change moves every node, in flight or not,
/// and leaves the same tree a fresh render at that size builds.
@MainActor
final class SceneResizeTests: XCTestCase {
    typealias Rel = Positions.RelativePosition

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    func makeScene(_ h: ReplayHarness, size: CGSize, chrome: TableChrome = .init(), animator: Animator = InstantAnimator()) -> GameSKScene {
        let scene = GameSKScene(size: size)
        scene.animator = animator
        scene.chrome = chrome
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        return scene
    }

    static let cycle = [CGSize(width: 466, height: 678), CGSize(width: 669, height: 951), CGSize(width: 951, height: 669),
                        CGSize(width: 1180, height: 820), CGSize(width: 820, height: 1180)]

    /// Replays one game, changing the size at every checkpoint, and compares the
    /// tree with a fresh render at that size; a no-op re-render after every event.
    private func replay(_ gameName: String, viewer label: String, sizes: [CGSize], chrome: TableChrome) throws -> Int {
        let game = try RecordedGame(gameName)
        let viewer = game.viewer(label)
        let log = game.logs[label] ?? []
        let live = ReplayHarness(viewer: viewer)
        let liveScene = makeScene(live, size: sizes[0], chrome: chrome)
        var next = 0, compared = 0, failures = 0, eventFailures = 0
        for (n, check) in game.checks(for: label).enumerated() {
            while next < check.afterIndex {
                let e = log[next]
                try live.apply(e)
                next += 1
                guard e.dir == "s2c" else { continue }
                let after = SceneDump.dump(liveScene)
                liveScene.renderLatest()
                let again = SceneDump.dump(liveScene)
                if after != again && eventFailures < 2 {
                    eventFailures += 1
                    XCTFail("\(gameName)/\(label) after #\(e.i) \(e.event): a re-render changed \(zip(after, again).first { $0.0 != $0.1 }.map { "\($0.0) -> \($0.1)" } ?? "the line count")")
                }
            }
            let size = sizes[n % sizes.count]
            liveScene.size = size
            XCTAssertEqual(liveScene.layout, TableLayout(size: size, chrome: chrome))
            let fresh = ReplayHarness(viewer: viewer)
            let freshScene = makeScene(fresh, size: size, chrome: chrome)
            let snap = try TableSnapshot.decode(check.snapshot, strict: true)
            fresh.store.apply(.snapshot(snap, .requested("fixture"), hints: LegacySeatHints(pics: live.store.players.seats.mapValues(\.pic))))
            let a = SceneDump.dump(liveScene), b = SceneDump.dump(freshScene)
            if a != b && failures < 2 {
                failures += 1
                let diff = zip(a, b).first { $0.0 != $0.1 }
                XCTFail("\(gameName)/\(label) after #\(check.afterIndex) at \(size): \(a.count) vs \(b.count) lines; first diff: \(diff.map { "\($0.0)  <>  \($0.1)" } ?? "length")")
            }
            compared += 1
        }
        return compared
    }

    func testResizeMidReplayEqualsFreshRender() throws {
        let compared = try replay("events-bots-s12", viewer: "seat1", sizes: Self.cycle, chrome: TableChrome())
        XCTAssertGreaterThan(compared, 20)
    }

    func testReplayWithDeviceChrome() throws {
        let chrome = TableChrome(safeArea: TableInsets(top: 59, left: 0, bottom: 34, right: 0), topBar: 70,
                                 cornerButton: CGSize(width: 96, height: 52))
        let compared = try replay("events-bots-s12", viewer: "seat1", sizes: [CGSize(width: 393, height: 852)], chrome: chrome)
        XCTAssertGreaterThan(compared, 20)
    }

    /// The iPad repro: rotating mid-hand with an opponent's card flying in, my
    /// card mid-lift and a bid bubble mid-pop puts everything at the new layout.
    func testRelayoutRetargetsInFlightMoves() throws {
        let landscape = CGSize(width: 1180, height: 820), portrait = CGSize(width: 820, height: 1180)
        let chrome = TableChrome(safeArea: TableInsets(top: 24, left: 0, bottom: 20, right: 0), topBar: 70, cornerButton: CGSize(width: 96, height: 52))
        // 1. trick: my card and an opponent's in flight (LiveAnimator offscreen never ticks), a card mid-lift
        let h = ReplayHarness()
        let scene = makeScene(h, size: landscape, chrome: chrome, animator: LiveAnimator())
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        XCTAssertTrue(h.actions.play(Card(suit: .clubs, rank: .ten)))
        h.handler.handle(event: "cardPlayed", payload: [["card": T.card("clubs", "10"), "position": 1, "trump": false, "seq": h.store.state.sync.lastSeq! + 1]])
        h.handler.handle(event: "cardPlayed", payload: [["card": T.card("clubs", "J"), "position": 2, "trump": false, "seq": h.store.state.sync.lastSeq! + 1]])
        let flying = scene.trickArea.cardSprites.filter { $0.action(forKey: "move") != nil }
        XCTAssertGreaterThanOrEqual(flying.count, 2, "my card and the opponent's are in flight")
        let liftCard = try XCTUnwrap(scene.handNode.sprites.values.first)
        liftCard.onTap?(liftCard.card)
        XCTAssertNotNil(liftCard.action(forKey: CardAnimations.liftKey))

        scene.size = portrait
        let L = scene.layout
        XCTAssertEqual(L, TableLayout(size: portrait, chrome: chrome))
        for s in scene.trickArea.cardSprites {
            let pos = Int(s.name!.split(separator: ".")[1])!
            XCTAssertEqual(s.position, L.trickSlot(Positions.getRelative(target: pos, from: 1)), s.name!)
            XCTAssertNil(s.action(forKey: "move"), s.name!)
            XCTAssertNil(s.action(forKey: "scale"), s.name!)
            XCTAssertEqual(s.frame.width, L.trickCardSize.width, accuracy: 0.01)
        }
        let slots = L.handSlots(count: scene.handNode.sprites.count)
        for s in scene.handNode.sprites.values {
            XCTAssertNil(s.action(forKey: CardAnimations.liftKey), s.card.id)
            XCTAssertNil(s.action(forKey: "move"), s.card.id)
            let slot = slots[Int(s.zPosition)]
            XCTAssertEqual(s.position, CGPoint(x: slot.x, y: s.isLifted ? LayoutConstants.cardLiftY : 0), s.card.id)
        }
        XCTAssertTrue(liftCard.isLifted)
        assertSeatsInside(scene)

        // 2. bidding: a bubble mid-pop
        let hb = ReplayHarness()
        let bidScene = makeScene(hb, size: landscape, chrome: chrome, animator: LiveAnimator())
        hb.store.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        bidScene.bidManager.pop(position: 2, animator: LiveAnimator())
        XCTAssertNotNil(bidScene.bidManager.bubbles[2]?.action(forKey: "pop"))
        bidScene.size = portrait
        let view = hb.store.state.table.viewer.viewPosition
        for (pos, node) in bidScene.bidManager.bubbles {
            XCTAssertEqual(node.position, bidScene.layout.bubbleAnchor(Positions.getRelative(target: pos, from: view)), "bid.\(pos)")
            XCTAssertNil(node.action(forKey: "move"))
        }
        XCTAssertNotNil(bidScene.bidManager.bubbles[2]?.action(forKey: "pop"), "the pop keeps going")
        assertSeatsInside(bidScene)
    }

    private func assertSeatsInside(_ scene: GameSKScene, file: StaticString = #filePath, line: UInt = #line) {
        let safe = scene.layout.safeRect.insetBy(dx: -0.5, dy: -0.5)
        for (pos, node) in scene.opponentManager.nodes {
            XCTAssertEqual(node.position, scene.layout.seatAnchor(node.relativePosition), "seat \(pos)", file: file, line: line)
            let f = node.calculateAccumulatedFrame()
            XCTAssertTrue(safe.contains(f), "seat \(pos) \(f) outside \(safe)", file: file, line: line)
        }
    }

    /// Chat bubbles, a rainbow and the OT badge (transient) follow a relayout.
    func testTransientFollowsRelayout() throws {
        let h = ReplayHarness()
        let scene = makeScene(h, size: CGSize(width: 1180, height: 820), animator: LiveAnimator())
        h.store.apply(.snapshot(try T.snapshot("between-tricks"), .rejoin, hints: nil))
        let me = h.store.state.table.viewer.viewPosition
        let other = me % 4 + 1
        h.store.apply(T.ev("chatMessage", ["username": "x", "message": "a fairly long chat line to wrap in two", "position": other,
                                           "type": "player", "seq": h.store.state.sync.lastSeq! + 1]))
        let chat = try XCTUnwrap(scene.transientLayer.childNode(withName: "chat.\(other)"))
        scene.effectsManager.showRainbow(position: other, myPosition: me)
        scene.effectsManager.showOverTrump()
        scene.effectsManager.showBoreBadge("2B")
        XCTAssertEqual(scene.effectsManager.live.count, 3)

        scene.size = CGSize(width: 820, height: 1180)
        let L = scene.layout
        let rel = Positions.getRelative(target: other, from: me)
        let entry = try XCTUnwrap(scene.chatManager.bubbles[other])
        XCTAssertEqual(chat.position, L.chatPosition(rel, bubbleSize: entry.size))
        XCTAssertTrue(L.safeRect.contains(TableLayout.rect(chat.position, entry.size)))
        XCTAssertLessThanOrEqual(TableLayout.rect(chat.position, entry.size).maxY, L.topLimit + 0.01)
        for e in scene.effectsManager.live {
            XCTAssertEqual(e.node.position, SKEffectsManager.point(e.anchor, in: L))
            let size: CGSize
            switch e.anchor {
            case .rainbow: size = TableLayout.rainbowSize
            case .bore: size = CGSize(width: 96, height: 96)  // 80 at its 1.2 peak
            case .overTrump: size = CGSize(width: TableLayout.overTrumpSize, height: TableLayout.overTrumpSize)
            }
            XCTAssertTrue(L.safeRect.insetBy(dx: -0.01, dy: -0.01).contains(TableLayout.rect(e.node.position, size)), "\(e.anchor)")
        }
    }

    /// The final table behind GameEndView relays out too.
    func testGameEndTableRelaysOut() throws {
        let h = ReplayHarness()
        let scene = makeScene(h, size: CGSize(width: 466, height: 678))
        h.store.apply(.snapshot(try T.snapshot("hand-resolving"), .rejoin, hints: nil))
        h.store.apply(T.ev("gameEnd", ["winningTeam": 1, "team1Score": 100, "team2Score": 50, "tournamentId": NSNull(),
                                       "seq": h.store.state.sync.lastSeq! + 1]))
        XCTAssertEqual(h.store.phase, .ended)
        XCTAssertFalse(scene.opponentManager.nodes.isEmpty)
        scene.size = CGSize(width: 669, height: 951)
        for node in scene.opponentManager.nodes.values {
            XCTAssertEqual(node.position, scene.layout.seatAnchor(node.relativePosition))
        }
        XCTAssertEqual(scene.handNode.position, scene.layout.handBaseline)
        XCTAssertEqual(scene.trickManager.trickHistory.position, scene.layout.historyOrigin)
        // and an unchanged layout is a no-op
        let dump = SceneDump.dump(scene)
        scene.relayout(animated: false)
        XCTAssertEqual(SceneDump.dump(scene), dump)
    }
}
