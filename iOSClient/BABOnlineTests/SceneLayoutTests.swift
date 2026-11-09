import XCTest
import SpriteKit
import SwiftUI
@testable import BAB_Online

/// Item 25 done-when with real nodes: at every listed size and chrome the
/// rendered seats, bubbles, trick cards, hand, history, bid band and corner
/// buttons do not intersect and stay inside the safe rect.
@MainActor
final class SceneLayoutTests: XCTestCase {
    typealias Rel = Positions.RelativePosition

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    static var configs: [(CGSize, TableChrome)] {
        var out: [(CGSize, TableChrome)] = []
        for (size, ins) in TableLayoutTests.listedSizes {
            for topBar in [CGFloat(70), 84] { out.append((size, TableLayoutTests.chrome(ins, topBar: topBar))) }
        }
        return out
    }

    func makeScene(_ h: ReplayHarness, size: CGSize, chrome: TableChrome) -> GameSKScene {
        let scene = GameSKScene(size: size)
        scene.animator = InstantAnimator()
        scene.chrome = chrome
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        return scene
    }

    /// A node's accumulated frame in scene coordinates.
    func sceneFrame(_ n: SKNode, _ scene: SKScene) -> CGRect {
        let f = n.calculateAccumulatedFrame()
        guard let parent = n.parent, parent !== scene else { return f }
        let a = parent.convert(CGPoint(x: f.minX, y: f.minY), to: scene), b = parent.convert(CGPoint(x: f.maxX, y: f.maxY), to: scene)
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }

    struct Part { let name: String; let rect: CGRect }

    func overlaps(_ parts: [Part], exempt: (Part, Part) -> Bool = { _, _ in false }) -> [String] {
        var out: [String] = []
        for i in parts.indices {
            for j in (i + 1)..<parts.count where !exempt(parts[i], parts[j]) {
                let x = parts[i].rect.intersection(parts[j].rect)
                if !x.isNull && x.width > 0.5 && x.height > 0.5 { out.append("\(parts[i].name) x \(parts[j].name) \(x)") }
            }
        }
        return out
    }

    func outside(_ parts: [Part], _ L: TableLayout, allowAboveTop: Set<String> = []) -> [String] {
        let safe = L.safeRect.insetBy(dx: -0.5, dy: -0.5)
        return parts.compactMap { p in
            let r = p.rect
            if r.minX < safe.minX || r.maxX > safe.maxX || r.minY < safe.minY || r.maxY > safe.maxY { return "\(p.name) outside safe \(r)" }
            if r.maxY > L.topLimit + 0.5 && !allowAboveTop.contains(p.name) { return "\(p.name) above topLimit \(r)" }
            return nil
        }
    }

    /// Each seat as its two real parts: avatar + glows, and the name label.
    func seatParts(_ scene: GameSKScene) -> [Part] {
        scene.opponentManager.nodes.flatMap { pos, node -> [Part] in
            let label = node.children.first { $0 is SKLabelNode }!
            let glow = node.children.filter { !($0 is SKLabelNode) }
            let g = glow.map { sceneFrame($0, scene) }.reduce(CGRect.null) { $0.union($1) }
            return [Part(name: "seat.\(pos).avatar", rect: g), Part(name: "seat.\(pos).name", rect: sceneFrame(label, scene))]
        }
    }

    func cornerParts(_ L: TableLayout) -> [Part] { L.cornerRects.enumerated().map { Part(name: "corner\($0.offset)", rect: $0.element) } }

    static let names = ["WWWWWWWWWWWW", "Mmmmmmmmmmmm", "Wolfeschlege", "QQQQQQQQQQQQ"]

    // (A) a 13-card deal, 12-character names, glows on, three bids in, my bid turn
    func testBidTurnWithFullHand() throws {
        let cards = [("spades", "A"), ("spades", "K"), ("spades", "Q"), ("hearts", "J"), ("hearts", "10"), ("hearts", "9"), ("clubs", "8"),
                     ("clubs", "7"), ("clubs", "6"), ("diamonds", "5"), ("diamonds", "4"), ("diamonds", "3"), ("joker", "HI")]
        for (size, chrome) in Self.configs {
            let h = ReplayHarness()
            let scene = makeScene(h, size: size, chrome: chrome)
            h.store.apply(.local(.identity(username: Self.names[0], playerId: "sid-me")))
            h.store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
            h.store.apply(T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "sid-l", "sid-p", "sid-r"],
                                                  "usernames": Self.names.map { ["username": $0] }, "pics": [1, 2, 3, 4], "seq": 1]))
            h.store.apply(T.ev("gameStart", ["gameId": "g1", "hand": cards.map { T.card($0.0, $0.1) }, "trump": T.card("diamonds", "2"),
                                             "score1": 0, "score2": 0, "dealer": 1, "position": 1, "currentHand": 13, "seq": 2]))
            h.store.apply(T.ev("bidReceived", ["bid": 11, "position": 2, "bidArray": [NSNull(), 11, NSNull(), NSNull()], "seq": 3]))
            h.store.apply(T.ev("bidReceived", ["bid": 12, "position": 3, "bidArray": [NSNull(), 11, 12, NSNull()], "seq": 4]))
            h.store.apply(T.ev("bidReceived", ["bid": 10, "position": 4, "bidArray": [NSNull(), 11, 12, 10], "seq": 5]))
            h.store.apply(T.ev("updateTurn", ["currentTurn": 1]))
            XCTAssertEqual(h.store.myTurn, .choosing(.bid))
            scene.opponentManager.nodes.values.forEach { $0.showTurnGlow(); $0.showSpeakingGlow() }
            XCTAssertEqual(scene.bidsLayer.children.count, 3)
            let L = scene.layout
            let ordered = scene.handNode.sprites.values.sorted { $0.zPosition < $1.zPosition }
            XCTAssertEqual(ordered.count, 13)
            for lift in [ordered.first!, ordered.last!] {
                lift.onTap?(lift.card)
                scene.cardManager.apply(layout: L, animator: InstantAnimator())  // finish the lift
                XCTAssertTrue(lift.isLifted)
                let hand = sceneFrame(scene.handNode, scene)
                var parts = seatParts(scene) + cornerParts(L)
                parts += scene.bidManager.bubbles.map { Part(name: "bid.\($0.key)", rect: sceneFrame($0.value, scene)) }
                parts.append(Part(name: "hand", rect: hand))
                parts.append(Part(name: "bidBand", rect: L.bidBand))
                let tag = "\(size) topBar \(chrome.topBar)"
                XCTAssertEqual(overlaps(parts, exempt: sameSeatOrCorners), [], tag)
                XCTAssertEqual(outside(parts.filter { !$0.name.hasPrefix("corner") }, L, allowAboveTop: ["bidBand"]), [], tag)
                XCTAssertGreaterThanOrEqual(hand.minX, L.safeRect.minX + TableLayout.margin - 0.5, tag)
                XCTAssertLessThanOrEqual(hand.maxX, L.safeRect.maxX - TableLayout.margin + 0.5, tag)
                XCTAssertLessThanOrEqual(hand.maxY, L.liftTop + 0.5, tag)
            }
        }
    }

    // (B) trick resolving (4 cards) with an 11-card hand, and mid-trick with 12
    func testTrickWithHand() throws {
        for (size, chrome) in Self.configs {
            let h = ReplayHarness()
            let scene = makeScene(h, size: size, chrome: chrome)
            h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
            check(scene, "\(size) \(chrome.topBar) mid-trick", expectTrick: 2)
            XCTAssertTrue(h.actions.play(Card(suit: .clubs, rank: .ten)))
            h.handler.handle(event: "cardPlayed", payload: [["card": T.card("clubs", "10"), "position": 1, "trump": false, "seq": h.store.state.sync.lastSeq! + 1]])
            h.handler.handle(event: "cardPlayed", payload: [["card": T.card("clubs", "J"), "position": 2, "trump": false, "seq": h.store.state.sync.lastSeq! + 1]])
            check(scene, "\(size) \(chrome.topBar) resolving", expectTrick: 4)
        }
    }

    func check(_ scene: GameSKScene, _ tag: String, expectTrick: Int) {
        let L = scene.layout
        XCTAssertEqual(scene.trickArea.cardSprites.count, expectTrick, tag)
        var parts = seatParts(scene) + cornerParts(L)
        parts += scene.trickArea.cardSprites.map { Part(name: $0.name!, rect: sceneFrame($0, scene)) }
        if !scene.handNode.sprites.isEmpty { parts.append(Part(name: "hand", rect: sceneFrame(scene.handNode, scene))) }
        if !scene.trickManager.trickHistory.children.isEmpty {
            parts.append(Part(name: "history", rect: sceneFrame(scene.trickManager.trickHistory, scene)))
        }
        parts.append(Part(name: "accessory", rect: L.accessory))
        XCTAssertEqual(overlaps(parts, exempt: sameSeatOrCorners), [], tag)
        XCTAssertEqual(outside(parts.filter { !$0.name.hasPrefix("corner") }, L), [], tag)
    }

    /// A seat's avatar and its own name touch by design; the two corner obstacles may meet.
    func sameSeatOrCorners(_ a: Part, _ b: Part) -> Bool {
        if a.name.hasPrefix("corner") && b.name.hasPrefix("corner") { return true }
        let sa = a.name.split(separator: "."), sb = b.name.split(separator: ".")
        return sa.count == 3 && sb.count == 3 && sa[0] == "seat" && sb[0] == "seat" && sa[1] == sb[1]
    }

    // (C) spectator mid-hand (four seats, the bottom one on the hand baseline)
    func testSpectatorMidHand() throws {
        for (size, chrome) in Self.configs {
            for pill in [CGFloat(0), 45] {
                var c = chrome
                c.bottomBar = pill
                let h = ReplayHarness()
                let scene = makeScene(h, size: size, chrome: c)
                h.store.apply(.snapshot(try T.snapshot("spectator-mid-hand"), .rejoin, hints: nil))
                XCTAssertEqual(scene.opponentManager.nodes.count, 4)
                check(scene, "\(size) \(c.topBar) pill \(pill) spectator", expectTrick: 2)
                // the bottom seat's name clears the pill
                if let bottom = scene.opponentManager.nodes.values.first(where: { $0.relativePosition == .bottom }), pill > 0 {
                    XCTAssertGreaterThanOrEqual(sceneFrame(bottom, scene).minY, scene.layout.safeRect.minY + pill, "\(size) \(c.topBar)")
                }
            }
        }
    }

    // (D) a 40-character chat from each seat: inside safe, below topLimit, off the corners and my hand
    func testChatFromEverySeat() throws {
        let line = "Well played partner, that was a great tr"  // 40 characters
        XCTAssertEqual(line.count, 40)
        for (size, chrome) in Self.configs {
            for fixture in ["trick-mid-lead3", "spectator-mid-hand"] {
                let h = ReplayHarness()
                let scene = makeScene(h, size: size, chrome: chrome)
                scene.animator = HoldingAnimator()
                h.store.apply(.snapshot(try T.snapshot(fixture), .rejoin, hints: nil))
                let me = h.store.state.table.viewer.position
                for pos in 1...4 where pos != me {
                    h.store.apply(T.ev("chatMessage", ["username": "x\(pos)", "message": line, "position": pos, "type": "player",
                                                       "seq": h.store.state.sync.lastSeq! + 1]))
                    let node = try XCTUnwrap(scene.transientLayer.childNode(withName: "chat.\(pos)"), "\(fixture) seat \(pos)")
                    let r = sceneFrame(node, scene)
                    let L = scene.layout
                    let tag = "\(size) \(chrome.topBar) \(fixture) seat \(pos) \(r)"
                    XCTAssertTrue(L.safeRect.insetBy(dx: -0.5, dy: -0.5).contains(r), tag)
                    XCTAssertLessThanOrEqual(r.maxY, L.topLimit + 0.5, tag)
                    XCTAssertFalse(L.cornerRects.contains { $0.intersects(r) }, tag)
                    XCTAssertLessThanOrEqual(r.width, L.chatMaxWidth + 0.5, tag)
                    if !scene.handNode.sprites.isEmpty {
                        let hand = sceneFrame(scene.handNode, scene)
                        let lifted = CGRect(x: hand.minX, y: hand.minY, width: hand.width, height: max(hand.height, L.liftTop - hand.minY))
                        XCTAssertFalse(lifted.intersects(r), tag)
                    }
                }
            }
        }
    }

    // MARK: SwiftUI sizes (the bid band and the top bar the layout reserves)

    func fit<V: View>(_ v: V, width: CGFloat) -> CGSize {
        let host = UIHostingController(rootView: v)
        return host.sizeThatFits(in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
    }

    func testBidOverlayFitsTheBidBand() throws {
        let h = ReplayHarness()
        let cards = (2...10).map { T.card("spades", String($0)) } + [T.card("hearts", "J"), T.card("hearts", "Q"), T.card("hearts", "K"), T.card("hearts", "A")]
        XCTAssertEqual(cards.count, 13)
        h.store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        h.store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        h.store.apply(T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "a", "b", "c"],
                                              "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1]))
        h.store.apply(T.ev("gameStart", ["gameId": "g1", "hand": cards, "trump": T.card("diamonds", "2"), "score1": 0, "score2": 0,
                                         "dealer": 4, "position": 1, "currentHand": 13, "seq": 2]))
        h.store.apply(T.ev("updateTurn", ["currentTurn": 1]))
        XCTAssertEqual(h.store.myCards.count, 13)
        for type in [DynamicTypeSize.large, .xxLarge, .accessibility5] {
            let v = BidOverlayView().environmentObject(h.store).environmentObject(h.actions).environment(\.dynamicTypeSize, type)
            let s = fit(v, width: 340)
            XCTAssertLessThanOrEqual(s.height, 140, "\(type)")
            XCTAssertLessThanOrEqual(s.width, 340, "\(type)")
        }
    }

    func testScoreBarHeightIsCapped() throws {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        for width in [CGFloat(375), 466] {
            for type in [DynamicTypeSize.large, .xxLarge, .accessibility5] {
                let s = fit(ScoreBarView().environmentObject(h.store).environment(\.dynamicTypeSize, type), width: width)
                XCTAssertLessThanOrEqual(s.height, 84, "\(width) \(type)")
            }
        }
    }

    func testAccessoryFitsItsRect() {
        let row = fit(HStack(spacing: 6) { HSIBadge(value: 999.9); VoiceMuteButton(onLongPress: {}) }.fixedSize(), width: 400)
        XCTAssertLessThanOrEqual(row.width, TableLayout.accessoryRow.width)
        XCTAssertLessThanOrEqual(row.height, TableLayout.accessoryRow.height)
        let stack = fit(VStack(alignment: .leading, spacing: 6) { HSIBadge(value: 999.9); VoiceMuteButton(onLongPress: {}) }.fixedSize(), width: 400)
        XCTAssertLessThanOrEqual(stack.width, TableLayout.accessoryStack.width)
        XCTAssertLessThanOrEqual(stack.height, TableLayout.accessoryStack.height)
    }
}
