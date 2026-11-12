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
        return out + measured
    }

    /// The chrome measured in fixture mode (docs/ios-table-store.md table): the closed Duo and the iPad Air.
    static let measured: [(CGSize, TableChrome)] = [
        (CGSize(width: 466, height: 678), TableLayoutTests.chrome(TableLayoutTests.insets(0, 0, 34, 84), topBar: 75.333,
                                                                 corner: CGSize(width: 79.667, height: 50.333))),
        (CGSize(width: 820, height: 1180), TableLayoutTests.chrome(TableLayoutTests.insets(32, 0, 20, 0), topBar: 75.5,
                                                                  corner: CGSize(width: 80, height: 50.5))),
        (CGSize(width: 1180, height: 820), TableLayoutTests.chrome(TableLayoutTests.insets(32, 0, 20, 0), topBar: 75.5,
                                                                  corner: CGSize(width: 80, height: 50.5))),
    ]

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

    // (C2) a lazy player at the seat: a read-only hand with the green pill
    func testLazyAtSeatWithPill() throws {
        for (size, chrome) in Self.configs {
            var c = chrome
            c.bottomBar = 45
            let h = ReplayHarness()
            let scene = makeScene(h, size: size, chrome: c)
            h.store.apply(.snapshot(try T.snapshot("lazy-at-seat"), .rejoin, hints: nil))
            XCTAssertFalse(scene.handNode.sprites.isEmpty, "\(size)")
            check(scene, "\(size) \(c.topBar) lazy pill", expectTrick: scene.trickArea.cardSprites.count)
            let L = scene.layout
            if L.usedBottomBar > 0 {
                XCTAssertGreaterThanOrEqual(sceneFrame(scene.handNode, scene).minY, L.safeRect.minY + 45 - 0.5, "\(size) hand above the pill")
            }
        }
    }

    // (F) folds with the real nodes: whichever way the Duo's hinge runs, the trick cards and
    // every seat (a spectator's bottom seat included) stay off it; in tabletop pose the hand
    // and the bid panel's band sit below it and the table above it
    func testFoldsWithRealNodes() throws {
        var checked = 0
        for (fold, size, ins, topBar) in TableLayoutTests.reachableFolds {
            for fixture in ["trick-mid-lead3", "spectator-mid-hand", "bidding-mid", "lazy-at-seat"] {
                let pill: CGFloat = fixture == "spectator-mid-hand" || fixture == "lazy-at-seat" ? 45 : 0
                let chrome = TableChrome(safeArea: ins, topBar: topBar, cornerButton: CGSize(width: 80, height: 50.5), bottomBar: pill, fold: fold)
                let h = ReplayHarness()
                let scene = makeScene(h, size: size, chrome: chrome)
                h.store.apply(.snapshot(try T.snapshot(fixture), .rejoin, hints: nil))
                let L = scene.layout
                let tag = "\(size) fold \(fold) topBar \(topBar) \(fixture)"
                XCTAssertFalse(L.foldIgnored, tag)
                XCTAssertFalse(L.isDegraded, tag)
                for s in scene.trickArea.cardSprites {
                    XCTAssertFalse(sceneFrame(s, scene).intersects(fold), "\(tag) trick \(s.name!) on the fold")
                }
                for (pos, node) in scene.opponentManager.nodes {
                    XCTAssertFalse(sceneFrame(node, scene).intersects(fold), "\(tag) seat \(pos) (\(node.relativePosition)) on the fold")
                }
                for (pos, b) in scene.bidManager.bubbles {
                    XCTAssertFalse(sceneFrame(b, scene).intersects(fold), "\(tag) bid bubble \(pos) on the fold")
                }
                if fold.width > fold.height {
                    if !scene.handNode.sprites.isEmpty {
                        XCTAssertLessThanOrEqual(sceneFrame(scene.handNode, scene).maxY, fold.minY + 0.5, "\(tag) hand below the fold")
                        XCTAssertLessThanOrEqual(L.liftTop, fold.minY + 0.5, "\(tag) lifted card below the fold")
                    }
                    XCTAssertLessThanOrEqual(L.bidBand.maxY, fold.minY + 0.5, "\(tag) bid panel below the fold")
                    if !scene.trickManager.trickHistory.children.isEmpty {
                        XCTAssertGreaterThanOrEqual(sceneFrame(scene.trickManager.trickHistory, scene).minY, fold.maxY - 0.5, "\(tag) history above")
                    }
                }
                check(scene, tag, expectTrick: scene.trickArea.cardSprites.count)
                checked += 1
            }
        }
        XCTAssertEqual(checked, TableLayoutTests.reachableFolds.count * 4)
    }

    // (G) a redeal's handsDestroyed fades the cards where they are, at their size
    func testHandsDestroyedFadesInPlace() throws {
        let holding = HoldingAnimator()
        let h = ReplayHarness()
        let chrome = TableChrome(safeArea: TableLayoutTests.insets(20, 0, 0, 0), topBar: 70, cornerButton: CGSize(width: 96, height: 52), bottomBar: 45)
        let scene = makeScene(h, size: CGSize(width: 375, height: 667), chrome: chrome)
        scene.animator = holding
        h.store.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertLessThan(scene.layout.handScale, 1, "a scaled hand (the case that used to jump)")
        let before = Dictionary(uniqueKeysWithValues: scene.handNode.sprites.map { ($0.key, sceneFrame($0.value, scene)) })
        XCTAssertFalse(before.isEmpty)
        h.store.apply(T.ev("destroyHands", ["seq": h.store.state.sync.lastSeq! + 1]))
        XCTAssertTrue(scene.handNode.sprites.isEmpty)
        let fading = scene.transientLayer.children.compactMap { $0 as? CardSpriteNode }
        XCTAssertEqual(fading.count, before.count)
        for s in fading {
            let now = sceneFrame(s, scene), was = try XCTUnwrap(before[s.card.id])
            XCTAssertEqual(now.midX, was.midX, accuracy: 0.5, s.card.id)
            XCTAssertEqual(now.midY, was.midY, accuracy: 0.5, s.card.id)
            XCTAssertEqual(now.width, was.width, accuracy: 0.5, s.card.id)
            XCTAssertEqual(now.height, was.height, accuracy: 0.5, s.card.id)
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

    /// HSI and the voice button fit the seat row's slots (TableLayout+SeatRow.swift) at every Dynamic Type size.
    func testAccessoryFitsItsRect() {
        for type in [DynamicTypeSize.xSmall, .large, .xxxLarge, .accessibility5] {
            let hsi = fit(HSIBadge(value: 999.9).environment(\.dynamicTypeSize, type), width: 400)
            XCTAssertLessThanOrEqual(hsi.width, TableLayout.hsiSize.width, "\(type)")
            XCTAssertLessThanOrEqual(hsi.height, TableLayout.hsiSize.height, "\(type)")
            let voice = fit(VoiceMuteButton(onLongPress: {}).environment(\.dynamicTypeSize, type), width: 400)
            XCTAssertLessThanOrEqual(voice.width, TableLayout.voiceButtonSize, "\(type)")
            XCTAssertLessThanOrEqual(voice.height, TableLayout.voiceButtonSize, "\(type)")
            for mode in [TableLayout.SeatRow.Mode.row, .compact] {
                // the HStack the row draws: HSI then the button, within the row's HSI + voice slots
                let spacing = mode == .row ? TableLayout.seatRowSpacing : TableLayout.seatRowColumnSpacing
                let pair = fit(HStack(spacing: spacing) { HSIBadge(value: 999.9); VoiceMuteButton(onLongPress: {}) }
                                .environment(\.dynamicTypeSize, type).fixedSize(), width: 400)
                let R = TableLayout.seatRow(mode, CGRect(origin: .zero, size: TableLayout.seatRowSize(mode)), fits: true)
                XCTAssertLessThanOrEqual(pair.width, R.voice.maxX - R.hsi.minX + 0.01, "\(mode) \(type)")
            }
        }
        XCTAssertEqual(TableLayout.voiceButtonSize, Theme.hitTarget)
    }
}
