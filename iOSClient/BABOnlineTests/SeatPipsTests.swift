import XCTest
import SpriteKit
@testable import BAB_Online

/// Per-player trick pips (owner 2026-11-11; web #215 parity, the web's
/// client/src/table/seatPips*.test.js): replaying the recorded games, at every
/// live play checkpoint (PLAYING / TRICK_RESOLVING) each seat's pips match
/// what the server's own numbers give (its own bid and its tricksByPosition; a
/// bore seat the hand and its team's tricks), and the trick history's bid
/// totals and borders match the server's team totals (bids.teamBids: a bore is
/// the whole hand). Seated, after a rejoin (snapshot v2) and as a spectator;
/// in the store and on the real scene's nodes.
@MainActor
final class SeatPipsTests: XCTestCase {
    typealias Shown = [Int]  // slots, filled, over, bore (0 / 1)

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    /// The web's testing/replay.js expectedPips: {position: [slots, filled, over]} plus bore.
    static func expected(_ snap: [String: Any]) -> [Int: Shown] {
        let bids = (snap["bids"] as! [String: Any])["byPosition"] as! [Any]
        let size = ((snap["deal"] as? [String: Any])?["handSize"] as? Int) ?? 13
        let tricks = snap["tricks"] as! [String: Int]
        let byPos = snap["tricksByPosition"] as! [Int]
        let bore = { (b: Any) in ["B", "2B", "3B", "4B"].contains(b as? String ?? "") }
        var out: [Int: Shown] = [:]
        for p in 1...4 {
            let partner = (p + 1) % 4 + 1
            if bids[p - 1] is NSNull || bids[partner - 1] is NSNull { out[p] = [0, 0, 0, 0]; continue }
            let teamWon = p % 2 == 1 ? tricks["team1"]! : tricks["team2"]!
            let isBore = bore(bids[p - 1])
            let need = isBore ? size : Int(bids[p - 1] as! String)!
            let won = isBore ? teamWon : byPos[p - 1]
            let n = need + won > 0 ? min(13, max(need, won)) : 0
            out[p] = [n, min(won, need, n), max(0, min(won, n) - need), isBore && n > 0 ? 1 : 0]
        }
        return out
    }

    static func shown(_ p: SeatPips?) -> Shown {
        guard let p else { return [0, 0, 0, 0] }
        return [p.slots, p.filled, p.over, p.isBore ? 1 : 0]
    }

    static func shown(_ node: SeatPipsNode) -> Shown {
        let s = node.shown
        return [s.slots, s.filled, s.over, s.bore ? 1 : 0]
    }

    /// The server's team totals from the viewer's side, and the borders: (mine, theirs).
    static func expectedPiles(_ snap: [String: Any]) -> [Int] {
        let viewer = (snap["viewer"] as! [String: Any])["position"] as? Int ?? 1
        let tb = (snap["bids"] as! [String: Any])["teamBids"] as! [String: Int]
        let tricks = snap["tricks"] as! [String: Int]
        let one = viewer % 2 == 1
        let (mine, theirs) = one ? (tb["team1"]!, tb["team2"]!) : (tb["team2"]!, tb["team1"]!)
        let (won, oppWon) = one ? (tricks["team1"]!, tricks["team2"]!) : (tricks["team2"]!, tricks["team1"]!)
        return [mine, theirs, won >= mine ? 1 : 0, oppWon >= theirs ? 1 : 0]
    }

    struct Result { let index: Int; let bores: Int; let live: [Int: Shown]; let want: [Int: Shown]; let piles: [Int]; let wantPiles: [Int] }

    /// Replay `label` of `name` through the handlers into a live scene; compare at every live play checkpoint.
    func replay(_ name: String, _ label: String, size: CGSize = CGSize(width: 393, height: 852)) throws -> (results: [Result], bad: [Result]) {
        let game = try RecordedGame(name)
        let viewer = game.viewer(label)
        let h = ReplayHarness(viewer: viewer)
        let scene = GameSKScene(size: size)
        scene.animator = InstantAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        let log = game.logs[label] ?? []
        var next = 0
        var results: [Result] = []
        for check in game.checks(for: label) where !check.isFinal {
            while next < check.afterIndex { try h.apply(log[next]); next += 1 }
            guard let stage = check.snapshot["stage"] as? String, ["PLAYING", "TRICK_RESOLVING"].contains(stage),
                  check.snapshot["deal"] is [String: Any] else { continue }
            let model = TableRenderModel(h.store.state)
            var want = Self.expected(check.snapshot)
            var live: [Int: Shown] = [:]
            for (pos, node) in scene.opponentManager.nodes { live[pos] = Self.shown(node.pipsNode) }
            // my own seat: the box, once my bid bubble is gone (it shows my bid until the first card)
            if let me = h.store.state.table.viewer.position, model.hand != nil {
                live[me] = Self.shown(scene.myPipsNode)
                if model.bidBubbles[me] != nil { want[me] = [0, 0, 0, 0] }
            }
            // the store agrees with the scene
            for (pos, s) in live where model.bidBubbles[pos] == nil || pos != h.store.state.table.viewer.position {
                XCTAssertEqual(Self.shown(model.pips[pos]), s, "\(name)/\(label) #\(check.afterIndex) store vs scene seat \(pos)")
            }
            want = want.filter { live[$0.key] != nil }
            let hist = scene.trickManager.trickHistory
            let t = try XCTUnwrap(hist.totals, "\(name)/\(label) #\(check.afterIndex): no pile totals")
            let piles = [t.team, t.opp, hist.border("team") == .safe ? 1 : 0, hist.border("opp") == .safe ? 1 : 0]
            let bores = ((check.snapshot["bids"] as! [String: Any])["byPosition"] as! [Any]).filter { ["B", "2B", "3B", "4B"].contains($0 as? String ?? "") }.count
            results.append(Result(index: check.afterIndex, bores: bores, live: live, want: want, piles: piles, wantPiles: Self.expectedPiles(check.snapshot)))
        }
        return (results, results.filter { $0.live != $0.want || $0.piles != $0.wantPiles })
    }

    func describe(_ bad: [Result]) -> String {
        bad.prefix(3).map { "#\($0.index) live \($0.live) want \($0.want) piles \($0.piles) want \($0.wantPiles)" }.joined(separator: "; ")
    }

    // MARK: - replays

    func testSeatedHumansGameEverySeatAndTheBore() throws {
        let (results, bad) = try replay("events-humans-s13", "seat1")
        XCTAssertGreaterThan(results.count, 100)
        XCTAssertTrue(bad.isEmpty, describe(bad))
        // a bore hand was checked, with its ring filled from the team's tricks
        XCTAssertTrue(results.contains { r in r.bores > 0 && r.live.values.contains { $0[3] == 1 && $0[1] > 0 } })
        // partners showed different pips somewhere (per player, not per team)
        XCTAssertTrue(results.contains { $0.live[1] != nil && $0.live[3] != nil && $0.live[1] != $0.live[3] })
        // the opponents' bore totals the whole hand: their pile stays danger past the partner's bid
        let bore = results.filter { $0.bores > 0 }
        XCTAssertFalse(bore.isEmpty)
    }

    func testRejoinFromSnapshotKeepsEveryCount() throws {
        let game = try RecordedGame("events-bots-s12")
        let first = try XCTUnwrap(game.logs["seat1-rejoin"]?.first)
        XCTAssertEqual(first.event, "rejoinSuccess")
        let (results, bad) = try replay("events-bots-s12", "seat1-rejoin")
        XCTAssertGreaterThan(results.count, 50)
        XCTAssertTrue(bad.isEmpty, describe(bad))
        // the B + 2B hand: both opponents' rings show the hand size and the same team count
        let both = results.filter { $0.bores == 2 && ($0.live[2]?[0] ?? 0) > 0 }
        XCTAssertFalse(both.isEmpty)
        XCTAssertTrue(both.allSatisfy { $0.live[2] == $0.live[4] && $0.live[2]?[3] == 1 })
    }

    func testSpectatorSeesAllFourSeats() throws {
        let (results, bad) = try replay("events-bots-s12", "spectator")
        XCTAssertGreaterThan(results.count, 50)
        XCTAssertTrue(bad.isEmpty, describe(bad))
        XCTAssertTrue(results.contains { $0.bores > 0 })
        XCTAssertEqual(results.last.map { Set($0.live.keys) }, [1, 2, 3, 4])
    }

    func testEveryRecordedViewerMatchesInTheStore() throws {
        var compared = 0
        for game in try RecordedGame.all() {
            for viewer in game.viewers {
                let log = game.logs[viewer.label] ?? []
                var replay = ReducerReplay(viewer: viewer)
                var next = 0
                for check in game.checks(for: viewer.label) where !check.isFinal {
                    while next < check.afterIndex { try replay.apply(log[next]); next += 1 }
                    guard let stage = check.snapshot["stage"] as? String, ["PLAYING", "TRICK_RESOLVING"].contains(stage) else { continue }
                    let want = Self.expected(check.snapshot)
                    let live = SeatPips.all(replay.state)
                    for p in 1...4 {
                        XCTAssertEqual(Self.shown(live[p]), want[p], "\(game.name)/\(viewer.label) #\(check.afterIndex) seat \(p)")
                    }
                    compared += 1
                }
            }
        }
        XCTAssertGreaterThan(compared, 300)
    }

    // MARK: - a reload mid bore hand (the web's boreReload.test.js)

    func boreRejoin() throws -> TableSnapshot {
        let game = try RecordedGame("events-bots-s14")
        var rejoin = try XCTUnwrap(game.logs["seat1-rejoin"]?.first?.data as? [String: Any])
        var s = try XCTUnwrap(rejoin["snapshot"] as? [String: Any])
        XCTAssertEqual(s["stage"] as? String, "PLAYING")
        XCTAssertEqual((s["deal"] as? [String: Any])?["handSize"] as? Int, 4)
        var bids = s["bids"] as! [String: Any]
        bids["byPosition"] = ["B", "0", "2", "0"]
        bids["teamBids"] = ["team1": 4, "team2": 0]
        bids["mults"] = ["team1": 2, "team2": 1]
        s["bids"] = bids
        s["tricks"] = ["team1": 2, "team2": 0]
        s["tricksByPosition"] = [1, 0, 1, 0]
        s["trick"] = ["number": 3, "leadPosition": NSNull(), "cards": []] as [String: Any]
        s["hand"] = Array((s["hand"] as! [Any]).prefix(2))
        s["seats"] = (s["seats"] as! [[String: Any]]).map { var x = $0; x["cardsInHand"] = 2; return x }
        s["turn"] = ["position": 1, "action": "play"]
        s["trickHistory"] = []
        rejoin["snapshot"] = s
        return try TableSnapshot.decode(s, strict: true)
    }

    func testReloadMidBoreHand() throws {
        let h = ReplayHarness()
        let size = CGSize(width: 393, height: 852)
        let scene = GameSKScene(size: size)
        scene.animator = InstantAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        h.store.apply(.snapshot(try boreRejoin(), .rejoin, hints: nil))
        let model = TableRenderModel(h.store.state)
        // the pile counts the bore as the whole hand: danger at 2 of 4 (the bore as 0 read 2, safe)
        XCTAssertEqual(model.pileTotals, TeamPair(team1: 4, team2: 0))
        XCTAssertEqual(scene.trickManager.trickHistory.border("team"), .danger)
        XCTAssertEqual(scene.trickManager.trickHistory.border("opp"), .safe)
        // my bore box: the hand (4), my team's 2; my partner's own 1 of 2
        XCTAssertEqual(Self.shown(scene.myPipsNode), [4, 2, 0, 1])
        XCTAssertEqual(Self.shown(scene.opponentManager.nodes[3]!.pipsNode), [2, 1, 0, 0])
        XCTAssertEqual(model.pips[1]?.accessibilityLabel, "Team 2 of 4, bore")
        XCTAssertEqual(model.pips[3]?.accessibilityLabel, "1 of 2 tricks")
        // 0 bids: no slots
        XCTAssertNil(model.pips[2])
        XCTAssertNil(model.pips[4])
        // the score bar's totals
        XCTAssertEqual(h.store.bidTotals?.mine, 4)
        XCTAssertEqual(ScoreBarView.tricksText(2, of: 4), "Tricks: 2/4")
        // a re-render draws the same
        let before = SceneDump.dump(scene)
        scene.render(model)
        XCTAssertEqual(SceneDump.dump(scene), before)
    }

    // MARK: - unknown counts (a snapshot whose tricksByPosition does not add up)

    func testUnknownSeatCountsFallBackToHistoryThenTheTeam() throws {
        var snap = try boreRejoin()
        snap.bids.byPosition = ["3", "0", "1", "0"]
        snap.tricksByPosition = [0, 0, 0, 0]   // zeros that do not agree with team1's 2
        // history with both winners known: the seats' counts come from it
        let cards = snap.hand ?? []
        snap.trickHistory = [TableSnapshot.WonTrick(winner: 1, lead: 1, cards: cards), TableSnapshot.WonTrick(winner: 1, lead: 1, cards: cards)]
        XCTAssertEqual(TableReducer.seatTricks(snap), [2, 0, 0, 0])
        var s = TableReducer.state(from: snap, hints: nil, previous: nil, source: .rejoin)
        XCTAssertEqual(SeatPips.all(s)[1].map(Self.shown), [3, 2, 0, 0])
        // no history: unknown for team 1, so its seats show the team's 2 of the team's 4
        snap.trickHistory = []
        XCTAssertEqual(TableReducer.seatTricks(snap), [nil, 0, nil, 0])
        s = TableReducer.state(from: snap, hints: nil, previous: nil, source: .rejoin)
        let p1 = try XCTUnwrap(SeatPips.all(s)[1])
        XCTAssertEqual(Self.shown(p1), [4, 2, 0, 0])
        XCTAssertEqual(p1.accessibilityLabel, "Team 2 of 4 tricks")
        // a won trick after it stays unknown for that team (never a wrong own count), known ones count on
        TableReducer.reduce(&s, T.ev("trickComplete", ["winner": 2, "seq": (snap.seq) + 1]))
        XCTAssertEqual(s.scores.tricksByPosition, [nil, 1, nil, 0])
    }

    // MARK: - rules

    func testBidTotalsCountABoreAsTheHand() {
        XCTAssertEqual(BidTotals.tricks("B", handSize: 4), 4)
        XCTAssertEqual(BidTotals.tricks("4b", handSize: 13), 13)
        XCTAssertEqual(BidTotals.tricks("3", handSize: 4), 3)
        XCTAssertNil(BidTotals.tricks(nil, handSize: 4))
        XCTAssertNil(BidTotals.tricks("x", handSize: 4))
        XCTAssertEqual(BidTotals.teamTotal("B", "4", handSize: 12), 12)  // capped at the hand
        XCTAssertEqual(BidTotals.teamTotal("3", nil, handSize: 12), 3)
        XCTAssertEqual(BidTotals.hand(nil), 13)
        XCTAssertEqual(BidTotals.pileBorder(won: 4, total: 12), .danger)
        XCTAssertEqual(BidTotals.pileBorder(won: 12, total: 12), .safe)
    }

    func testSlotsFilledAndOver() {
        let zero = SeatPips(need: 0, won: 0, isBore: false, countsTeam: false)
        XCTAssertEqual(zero.slots, 0)                       // a 0 bid shows no slots
        let zeroWon = SeatPips(need: 0, won: 2, isBore: false, countsTeam: false)
        XCTAssertEqual(Self.shown(zeroWon), [2, 0, 2, 0])   // ... until it wins: over
        let over = SeatPips(need: 3, won: 5, isBore: false, countsTeam: false)
        XCTAssertEqual(Self.shown(over), [5, 3, 2, 0])
        XCTAssertEqual(over.accessibilityLabel, "5 of 3 tricks")
        let two = SeatPips(need: 3, won: 2, isBore: false, countsTeam: false)
        XCTAssertEqual(two.accessibilityLabel, "2 of 3 tricks")
        XCTAssertEqual(SeatPips(need: 10, won: 7, isBore: true, countsTeam: true).accessibilityLabel, "Team 7 of 10, bore")
        XCTAssertEqual(SeatPips(need: 13, won: 14, isBore: false, countsTeam: false).slots, 13)  // capped
        let node = SeatPipsNode(style: .ring)
        node.update(over, team: 2)
        XCTAssertEqual(Self.shown(node), [5, 3, 2, 0])
        node.update(nil, team: 2)
        XCTAssertEqual(Self.shown(node), [0, 0, 0, 0])
    }

    /// Ring dots stay inside the seat's glow rect; box dots inside my pips' box.
    func testPipGeometryFits() {
        let glow = TableLayout.glowRect(.zero)
        for n in 1...13 {
            for c in TableLayout.seatPipDots(n) {
                XCTAssertTrue(glow.insetBy(dx: 1, dy: 1).contains(CGRect(x: c.x - 2.5, y: c.y - 2.5, width: 5, height: 5)), "ring \(n)")
            }
            let box = TableLayout.rect(.zero, TableLayout.myPipsSize)
            let pill = TableLayout.myPipsPill(n)
            XCTAssertLessThanOrEqual(pill.width, box.width)
            XCTAssertLessThanOrEqual(pill.height, box.height)
            for c in TableLayout.myPipDots(n) { XCTAssertTrue(box.contains(CGRect(x: c.x - 2.5, y: c.y - 2.5, width: 5, height: 5)), "box \(n)") }
        }
        // the bore ring stays inside the glow too
        XCTAssertLessThanOrEqual(TableLayout.seatPipRadius + TableLayout.pipDot / 2 + 1.5 + 0.75, TableLayout.glowRadius)
    }
}
