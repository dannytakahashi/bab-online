import XCTest
import SpriteKit
@testable import BAB_Online

/// iOS 1.2.3: the card back alternates red and blue by hand, as the web's (owner 2026-11-13;
/// cardFaces.js backFrameForHand, tableBack.js tableBackFrame, client/src/table/backColour*.test.js):
/// the draw for deal and hand 1 red, hand 2 blue, hand 3 red, ...; every back the table shows
/// (the opponents' fans) is the current hand's colour, and the switch comes with the next deal.
@MainActor
final class CardBackColourTests: XCTestCase {

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    // MARK: the rule

    /// The web's inputs (CardAtlas.test.js backFrameForHand): 1...13 alternate red / blue from
    /// red; no hand (0, nil, a negative) is red.
    func testTheRuleIsTheWebsBackFrameForHand() {
        let want: [CardBackColour] = (1...13).map { $0 % 2 == 0 ? .blue : .red }
        XCTAssertEqual((1...13).map { CardBackColour.forHand($0) }, want)
        XCTAssertEqual(Array(want.prefix(4)), [.red, .blue, .red, .blue])
        for none in [0, -1, -2, Int.min] { XCTAssertEqual(CardBackColour.forHand(none), .red, "\(none)") }
        XCTAssertEqual(CardBackColour.forHand(nil), .red)
        XCTAssertEqual(CardBackColour.draw, .red, "the draw for deal comes before hand 1")
        // the inks are the web's tokens (card.backRed / card.backBlue)
        XCTAssertEqual(Theme.CardBack.ink(.red), Theme.Palette.Card.backRed)
        XCTAssertEqual(Theme.CardBack.ink(.blue), Theme.Palette.Card.backBlue)
        XCTAssertEqual(CardArtTests.rgb(Theme.Palette.Card.backRed).0, 0xb2)
        XCTAssertEqual(CardArtTests.rgb(Theme.Palette.Card.backBlue).2, 0x9b)
    }

    /// The hand number is the deal's (HandSequence: 12 cards hand 1, 10 hand 2, ... 13 hand 13),
    /// the number the web counts, so the sequence of deals alternates.
    func testEachDealOfTheSequenceAlternates() {
        let colours = HandSequence.sizes.map { CardBackColour.forHand(HandSequence.handNo(forSize: $0)) }
        XCTAssertEqual(colours, (1...13).map { $0 % 2 == 0 ? .blue : .red })
    }

    // MARK: the model

    func testTheModelCarriesTheHandsColour() throws {
        // every fixture deal is hand 1: red
        for fixture in ["bidding-mid", "trick-mid-lead3", "spectator-mid-hand", "hand-resolving"] {
            XCTAssertEqual(TableRenderModel(try T.state(fixture: fixture)).back, .red, fixture)
        }
        // the draw (no deal yet): red
        XCTAssertEqual(TableRenderModel(try T.state(fixture: "draw-in-progress")).back, .red)
        // a rejoin or spectator join on hand 2 / 3 / 4: the snapshot's hand number
        for (handNo, want) in [(2, CardBackColour.blue), (3, .red), (4, .blue), (13, .red)] {
            for fixture in ["trick-mid-lead3", "spectator-mid-hand"] {
                let s = TableReducer.state(from: try T.snapshot(fixture) { Self.setHandNo(&$0, handNo) }, hints: nil, previous: nil, source: .requested("t"))
                XCTAssertEqual(TableRenderModel(s).back, want, "\(fixture) hand \(handNo)")
            }
        }
        // live: the colour switches with the next deal, a zero-bid redeal keeps it
        var s = T.dealtState(size: 12)
        XCTAssertEqual(TableRenderModel(s).back, .red)
        var seq = 3  // dealtState ends at seq 2
        func deal(_ size: Int) {
            TableReducer.reduce(&s, T.ev("gameStart", ["hand": [T.card("spades", "2")], "trump": T.card("clubs", "3"), "dealer": 1, "position": 1,
                                                       "currentHand": size, "score1": 0, "score2": 0, "seq": seq]))
            seq += 1
        }
        deal(10)
        XCTAssertEqual(TableRenderModel(s).back, .blue, "hand 2")
        deal(10)
        XCTAssertEqual(TableRenderModel(s).back, .blue, "a redeal of hand 2")
        deal(8)
        XCTAssertEqual(TableRenderModel(s).back, .red, "hand 3")
        deal(6)
        XCTAssertEqual(TableRenderModel(s).back, .blue, "hand 4")
    }

    /// The recorded real-server games, every viewer that saw the game from its first deal: after
    /// every event the table's back is the colour of the hand counted the web's way (one more
    /// at each gameStart, a redeal of the same size not), independently of HandSequence.
    func testEveryRecordedGameAlternatesByHand() throws {
        var seen: Set<CardBackColour> = []
        var checked = 0, viewers = 0, mostHands = 0
        for game in try RecordedGame.all() {
            for viewer in game.viewers {
                let h = ReplayHarness(viewer: viewer)
                var hands = 0, games = 0
                var lastSize: Int?
                var fromTheStart = true
                for e in game.logs[viewer.label] ?? [] {
                    if e.dir == "s2c", e.event == "gameStart", let size = (e.data as? [String: Any])?["currentHand"] as? Int {
                        if lastSize == nil && size != 12 { fromTheStart = false }
                        if lastSize == nil { games += 1 }
                        if size != lastSize { hands += 1 }
                        lastSize = size
                    }
                    // a game's end: the next game (a tournament's next round) starts at hand 1 again,
                    // as the web's GameState.reset sets handNo 0
                    if e.dir == "s2c", e.event == "gameEnd" { hands = 0; lastSize = nil }
                    try h.apply(e)
                    let model = TableRenderModel(h.store.state)
                    // a viewer that joined mid-game (a snapshot before any deal) is not counted
                    if model.showsTable && games == 0 { fromTheStart = false }
                    guard fromTheStart else { break }
                    if !model.showsTable {
                        XCTAssertEqual(model.back, .red, "\(game.name)/\(viewer.label) #\(e.i): off the table")
                        continue
                    }
                    if hands == 0 { continue }  // the finished game's table, behind its end screen
                    let want: CardBackColour = hands % 2 == 0 ? .blue : .red
                    XCTAssertEqual(model.back, want, "\(game.name)/\(viewer.label) #\(e.i): hand \(hands)")
                    seen.insert(model.back)
                    checked += 1
                }
                if fromTheStart && hands > 0 { viewers += 1 }
                mostHands = max(mostHands, hands)
            }
        }
        XCTAssertEqual(seen, [.red, .blue], "both colours shown")
        XCTAssertGreaterThan(viewers, 0)
        XCTAssertGreaterThanOrEqual(mostHands, 3, "a recording reaches hand 3")
        print("[CardBackColour] \(checked) table states over \(viewers) viewers, up to hand \(mostHands)")
    }

    // MARK: the scene

    static let iPad = (CGSize(width: 1032, height: 1376), PolishLayoutTests.chrome(TableLayoutTests.insets(24, 0, 20, 0), bottomBar: 0, topBar: 75.5))
    static let phone = (CGSize(width: 390, height: 844), PolishLayoutTests.chrome(TableLayoutTests.insets(47, 0, 34, 0), bottomBar: 0, topBar: 75.5))

    private func makeScene(_ fixture: String, _ device: (CGSize, TableChrome), edit: (inout [String: Any]) -> Void = { _ in }) throws -> (ReplayHarness, GameSKScene) {
        let h = ReplayHarness()
        let snap = try T.snapshot(fixture, edit: edit)
        let me = snap.seats.first { $0.position == snap.viewer.position }?.username
        h.store.apply(.local(.identity(username: me ?? "viewer", playerId: "sid-viewer")))
        h.store.apply(.snapshot(snap, .rejoin, hints: nil))
        let scene = GameSKScene(size: device.0)
        scene.animator = InstantAnimator()
        scene.chrome = device.1
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: device.0)))
        return (h, scene)
    }

    static func setHandNo(_ snap: inout [String: Any], _ handNo: Int) {
        var deal = snap["deal"] as! [String: Any]
        deal["handNo"] = handNo
        snap["deal"] = deal
    }

    /// Every fan sprite's colour (nil: a texture that is neither back), and how many there are.
    private func fanColours(_ scene: GameSKScene) -> (colours: Set<CardBackColour?>, sprites: Int) {
        let textures = scene.opponentManager.nodes.values.flatMap { $0.fanNode.children.compactMap { ($0 as? SKSpriteNode)?.texture } }
        let colours = Set(textures.map { t in [CardBackColour.red, .blue].first { CardFanNode.backTexture($0) === t } })
        return (colours, textures.count)
    }

    /// Live: hand 1's fans red, the next deal's blue, then red: the same fan nodes retextured
    /// (the count path redraws, the colour path retextures what is there).
    func testTheFansAlternateWithTheDeals() throws {
        for device in [Self.iPad, Self.phone] {
            let (h, scene) = try makeScene("bidding-mid", device)
            var shown = fanColours(scene)
            XCTAssertGreaterThan(shown.sprites, 0)
            XCTAssertEqual(shown.colours, [.red], "hand 1")
            var seq = (h.store.state.sync.lastSeq ?? 0) + 1
            let me = h.store.state.table.viewer.position ?? 1
            func deal(_ size: Int) {
                h.store.apply(T.ev("gameStart", ["hand": (0..<size).map { _ in T.card("spades", "2") }.enumerated().map { i, _ in
                    T.card(["spades", "hearts", "clubs", "diamonds"][i % 4], ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"][i / 4])
                }, "trump": T.card("clubs", "3"), "dealer": 2, "position": me, "currentHand": size, "score1": 0, "score2": 0, "seq": seq]))
                seq += 1
            }
            deal(10)
            shown = fanColours(scene)
            XCTAssertEqual(shown.colours, [.blue], "hand 2")
            XCTAssertEqual(shown.sprites, 30, "three fans of 10")
            XCTAssertTrue(scene.opponentManager.nodes.values.allSatisfy { $0.fanNode.colour == .blue })
            // idempotent: a second render of the same model changes nothing
            let dump = SceneDump.dump(scene)
            scene.renderLatest()
            XCTAssertEqual(SceneDump.dump(scene), dump)
            // a play shrinks a fan: the new children keep the hand's colour
            let lead = scene.opponentManager.nodes.keys.sorted()[0]
            h.store.apply(T.ev("doneBidding", ["bids": ["1", "1", "1", "1"], "lead": lead, "seq": seq])); seq += 1
            h.store.apply(T.ev("cardPlayed", ["card": T.card("spades", "3"), "position": lead, "trump": false, "seq": seq])); seq += 1
            shown = fanColours(scene)
            XCTAssertEqual(shown.colours, [.blue])
            XCTAssertEqual(shown.sprites, 29)
            deal(8)
            shown = fanColours(scene)
            XCTAssertEqual(shown.colours, [.red], "hand 3")
            XCTAssertEqual(shown.sprites, 24)
        }
    }

    /// The same count, another colour (a rejoin onto the next hand at the same size never
    /// happens live, but the node must not keep a stale back): the children are retextured.
    func testAFanRetexturesWhenOnlyTheColourChanges() {
        let fan = CardFanNode()
        fan.update(count: 5, colour: .red)
        let children = fan.children.map(ObjectIdentifier.init)
        XCTAssertTrue(fan.children.allSatisfy { ($0 as? SKSpriteNode)?.texture === CardFanNode.backTexture(.red) })
        fan.update(count: 5, colour: .blue)
        XCTAssertEqual(fan.children.map(ObjectIdentifier.init), children, "the same sprites")
        XCTAssertTrue(fan.children.allSatisfy { ($0 as? SKSpriteNode)?.texture === CardFanNode.backTexture(.blue) })
        fan.update(count: 3, colour: .blue)
        XCTAssertEqual(fan.children.count, 3)
        XCTAssertTrue(fan.children.allSatisfy { ($0 as? SKSpriteNode)?.texture === CardFanNode.backTexture(.blue) })
        fan.update(count: 0, colour: .red)
        XCTAssertTrue(fan.children.isEmpty)
        fan.update(count: 2, colour: .red)
        XCTAssertTrue(fan.children.allSatisfy { ($0 as? SKSpriteNode)?.texture === CardFanNode.backTexture(.red) })
        XCTAssertFalse(CardFanNode.backTexture(.red) === CardFanNode.backTexture(.blue))
        XCTAssertTrue(CardFanNode.backTexture(.blue) === CardFanNode.backTexture(.blue), "once per process")
    }

    /// A rejoin or a spectator join mid-game shows the hand's colour from its snapshot.
    func testARejoinOrSpectatorJoinShowsTheHandsColour() throws {
        for (fixture, handNo, want) in [("trick-mid-lead3", 2, CardBackColour.blue), ("trick-mid-lead3", 3, .red),
                                         ("spectator-mid-hand", 4, .blue), ("spectator-mid-hand", 1, .red)] {
            let (_, scene) = try makeScene(fixture, Self.iPad) { Self.setHandNo(&$0, handNo) }
            let shown = fanColours(scene)
            XCTAssertGreaterThan(shown.sprites, 0, fixture)
            XCTAssertEqual(shown.colours, [want], "\(fixture) hand \(handNo)")
        }
    }

    /// The blue fan back is the red one's size (one texture per colour, at the largest fan card's
    /// on-screen size), in the blue ink.
    func testTheBlueFanBackIsTheRedOnesSizeInBlue() {
        let red = CardFanNode.backTexture(.red), blue = CardFanNode.backTexture(.blue)
        XCTAssertEqual(red.size(), blue.size())
        let p = CardArtTests.Pixels(UIImage(cgImage: blue.cgImage()))
        let inkShare = Double(p.count(Theme.Palette.Card.backBlue, tol: 30)) / Double(p.w * p.h)
        XCTAssertGreaterThan(inkShare, 0.3, "blue ink share \(inkShare)")
        XCTAssertEqual(p.count(Theme.Palette.Card.backRed, tol: 30), 0, "no red ink")
    }
}
