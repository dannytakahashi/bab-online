import XCTest
import SpriteKit
@testable import BAB_Online

/// The avatar badges (State/Table/SeatBadges.swift, TableLayout+Badges.swift, SeatBadgeNode): the
/// lightbulb from the live /help notice until the seat's turn is over, the graduation cap while
/// its tutorial is on (the live tag, the snapshot's seats[]), never on my own seat.
@MainActor
final class SeatBadgesTests: XCTestCase {
    typealias Rel = Positions.RelativePosition

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    override func tearDown() {
        Theme.Motion.reduceMotionOverride = nil
        super.tearDown()
    }

    private func notice(_ pos: Int, seq: Int, name: String = "L") -> TableEvent {
        T.ev("gameLogEntry", ["message": "\(name) used /help.", "type": "system", "seq": seq, "help": ["position": pos]])
    }

    private func tutorialLine(_ pos: Int, on: Bool, seq: Int) -> TableEvent {
        T.ev("gameLogEntry", ["message": on ? "L turned on the tutorial." : "L turned off the tutorial.", "type": "system",
                              "seq": seq, "tutorial": ["position": pos, "on": on]])
    }

    private func pops(_ fx: [TableEffect]) -> [Int] {
        fx.animations.compactMap { if case .helpBadge(let p) = $0 { return p } else { return nil } }
    }

    private func bulbs(_ s: TableState) -> [Int] { s.players.seats.filter { $0.value.askedHelp }.keys.sorted() }
    private func caps(_ s: TableState) -> [Int] { s.players.seats.filter { $0.value.tutorial }.keys.sorted() }

    /// T.dealtState (me at seat 1) with seat 2 on its bid turn and its /help notice in: seq 4 next.
    private func asked(_ pos: Int = 2) -> TableState {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": pos, "seq": 3]))
        let fx = TableReducer.reduce(&s, notice(pos, seq: 4))
        XCTAssertEqual(pops(fx), [pos], "the live notice pops its lightbulb once")
        XCTAssertEqual(bulbs(s), [pos])
        return s
    }

    // MARK: wire

    func testTheTutorialTagDecodesAndAWrongShapeLeavesAPlainRow() throws {
        let ev = try ServerEvent.decode(name: "gameLogEntry", payload: [[
            "message": "kim turned on the tutorial.", "type": "system", "seq": 9, "tutorial": ["position": 2, "on": true],
        ] as [String: Any]], strict: true).get()
        guard case .gameLogEntry(let p) = ev.event else { return XCTFail("\(ev.event)") }
        XCTAssertEqual(p.tutorial, .init(position: 2, on: true))
        XCTAssertEqual(ev.seq, 9)
        for odd: Any in ["on", ["position": "two", "on": true], ["position": 2, "on": "yes"], 7] {
            let e = try ServerEvent.decode(name: "gameLogEntry", payload: [[
                "message": "kim turned off the tutorial.", "type": "system", "seq": 10, "tutorial": odd,
            ] as [String: Any]], strict: true).get()
            guard case .gameLogEntry(let q) = e.event else { return XCTFail("\(e.event)") }
            XCTAssertNil(q.tutorial, "\(odd): a tag this build cannot read is absent")
            XCTAssertEqual(q.message, "kim turned off the tutorial.", "never a dropped line")
        }
        // a tag without `on`, or a position off the table, changes nothing
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("gameLogEntry", ["message": "x", "type": "system", "seq": 3, "tutorial": ["position": 2]]))
        TableReducer.reduce(&s, T.ev("gameLogEntry", ["message": "y", "type": "system", "seq": 4, "tutorial": ["position": 7, "on": true]]))
        TableReducer.reduce(&s, T.ev("gameLogEntry", ["message": "z", "type": "system", "seq": 5, "help": ["position": 0]]))
        XCTAssertEqual(caps(s), [])
        XCTAssertEqual(bulbs(s), [])
        XCTAssertEqual(s.log.entries.suffix(3).map(\.message), ["x", "y", "z"])
    }

    // MARK: the lightbulb

    func testTheNoticeSetsTheBulbOnceAndAReAskDoesNotPopAgain() {
        var s = asked()
        XCTAssertEqual(pops(TableReducer.reduce(&s, notice(2, seq: 5))), [], "already up: no second pop")
        XCTAssertEqual(bulbs(s), [2])
        XCTAssertTrue(s.log.entries.last!.isHelp, "the gold row as before")
    }

    func testTheSeatsBidOrCardClearsItsBulbOnly() {
        var s = asked()
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": 1, "position": 3, "seq": 5]))
        XCTAssertEqual(bulbs(s), [2], "another seat's bid leaves it")
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": 1, "position": 2, "seq": 6]))
        XCTAssertEqual(bulbs(s), [], "its own bid ends it")

        var p = T.dealtState()
        TableReducer.reduce(&p, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        for (i, pos) in [1, 2, 3, 4].enumerated() { TableReducer.reduce(&p, T.ev("bidReceived", ["bid": 1, "position": pos, "seq": 4 + i])) }
        TableReducer.reduce(&p, T.ev("doneBidding", ["bids": [1, 1, 1, 1], "lead": 2, "seq": 8]))
        TableReducer.reduce(&p, T.ev("updateTurn", ["currentTurn": 2, "seq": 9]))
        TableReducer.reduce(&p, notice(2, seq: 10))
        TableReducer.reduce(&p, T.ev("cardPlayed", ["card": T.card("clubs", "4"), "position": 3, "seq": 11]))
        XCTAssertEqual(bulbs(p), [2])
        TableReducer.reduce(&p, T.ev("cardPlayed", ["card": T.card("clubs", "3"), "position": 2, "seq": 12]))
        XCTAssertEqual(bulbs(p), [], "its card ends it")
    }

    func testAnUpdateTurnToAnotherSeatClearsIt() {
        var s = asked()
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 5]))
        XCTAssertEqual(bulbs(s), [2], "the same seat's turn again: still its open turn")
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 3, "seq": 6]))
        XCTAssertEqual(bulbs(s), [])
    }

    func testTheHandAndGameMovingOnClearIt() {
        let cases: [(String, TableEvent)] = [
            ("doneBidding", T.ev("doneBidding", ["bids": [1, 0, 1, 0], "lead": 3, "seq": 5])),
            ("handComplete", T.ev("handComplete", ["score": ["team1": 10, "team2": 0], "seq": 5])),
            ("destroyHands", T.ev("destroyHands", ["seq": 5])),
            ("gameStart", T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("diamonds", "5"),
                                             "score1": 0, "score2": 0, "dealer": 1, "position": 1, "currentHand": 1, "seq": 5])),
            ("gameEnd", T.ev("gameEnd", ["score": ["team1": 1, "team2": 0], "tournamentId": NSNull(), "seq": 5])),
            ("abortGame", T.ev("abortGame", ["seq": 5])),
            ("playerLazyMode", T.ev("playerLazyMode", ["position": 2, "botUsername": "Bot", "originalUsername": "L", "seq": 5])),
            ("playerResigned", T.ev("playerResigned", ["position": 2, "oldUsername": "L", "botUsername": "🤖 Bot", "seq": 5])),
            ("playerActiveMode", T.ev("playerActiveMode", ["position": 2, "username": "L", "seq": 5])),
        ]
        for (name, ev) in cases {
            var s = asked()
            TableReducer.reduce(&s, ev)
            XCTAssertEqual(bulbs(s), [], name)
        }
        // leaving the table: a fresh table
        var s = asked()
        TableReducer.reduce(&s, .local(.reset))
        XCTAssertEqual(bulbs(s), [])
    }

    func testABufferedNoticeSetsTheBulbWithoutThePop() throws {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "ivy", playerId: "ui")))
        TableReducer.reduce(&s, .snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        let seq = try XCTUnwrap(s.sync.lastSeq)
        // a gap: the notice waits behind the missing event, then the snapshot's catch-up applies it
        let fx1 = TableReducer.reduce(&s, notice(2, seq: seq + 2, name: "kim"))
        XCTAssertEqual(pops(fx1), [])
        XCTAssertEqual(bulbs(s), [])
        let snap = try T.snapshot("trick-mid-lead3") { $0["seq"] = seq + 1 }
        let fx2 = TableReducer.reduce(&s, .snapshot(snap, .requested(s.sync.resyncId ?? "gap"), hints: nil))
        XCTAssertEqual(bulbs(s), [2], "the live notice is state")
        XCTAssertEqual(pops(fx2), [], "a resync's catch-up never pops")
    }

    // MARK: the cap

    func testTheTutorialTagTurnsTheCapOnAndOff() {
        var s = T.dealtState()
        let fx = TableReducer.reduce(&s, tutorialLine(3, on: true, seq: 3))
        XCTAssertEqual(caps(s), [3])
        XCTAssertEqual(pops(fx), [], "the cap has no pop")
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 4]))
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": 1, "position": 3, "seq": 5]))
        TableReducer.reduce(&s, T.ev("playerLazyMode", ["position": 3, "botUsername": "Bot", "originalUsername": "P", "seq": 6]))
        XCTAssertEqual(caps(s), [3], "turns, bids and a lazy bot leave it: the owner's tutorial is on")
        TableReducer.reduce(&s, T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("diamonds", "5"),
                                                   "score1": 0, "score2": 0, "dealer": 1, "position": 1, "currentHand": 1, "seq": 7]))
        XCTAssertEqual(caps(s), [3], "a new deal too")
        TableReducer.reduce(&s, tutorialLine(3, on: false, seq: 8))
        XCTAssertEqual(caps(s), [])
    }

    func testCapWins() {
        var s = asked()
        TableReducer.reduce(&s, tutorialLine(2, on: true, seq: 5))
        XCTAssertEqual(SeatBadge.of(s.players.seats[2]), .cap)
        XCTAssertEqual(TableRenderModel(s).opponents.first { $0.position == 2 }?.badge, .cap)
        XCTAssertEqual(SeatBadge.of(nil), nil)
        XCTAssertEqual(SeatBadge.bulb.spokenSuffix, ", asked for help this turn")
        XCTAssertEqual(SeatBadge.cap.spokenSuffix, ", tutorial on")
    }

    func testAnotherOwnerInTheSeatLosesTheBadges() {
        var s = asked()
        TableReducer.reduce(&s, tutorialLine(3, on: true, seq: 5))
        TableReducer.reduce(&s, T.ev("positionUpdate", [
            "positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-q", "bot:r"],
            "usernames": [["username": "me"], ["username": "L"], ["username": "Q"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 6,
        ]))
        XCTAssertEqual(caps(s), [], "seat 3 is Q's now")
        XCTAssertEqual(bulbs(s), [2], "the same owner keeps its own")
    }

    // MARK: snapshots

    func testASnapshotSetsBothFromItsSeatsAndAbsentIsOff() throws {
        var s = asked()
        TableReducer.reduce(&s, tutorialLine(4, on: true, seq: 5))
        let snap = try T.snapshot("trick-mid-lead3") { raw in
            var seats = raw["seats"] as? [[String: Any]] ?? []
            for i in seats.indices where seats[i]["position"] as? Int == 3 { seats[i]["tutorial"] = true }
            for i in seats.indices where seats[i]["position"] as? Int == 4 { seats[i]["askedHelp"] = true }
            raw["seats"] = seats
        }
        var r = TableState()
        TableReducer.reduce(&r, .local(.identity(username: "ivy", playerId: "ui")))
        let fx = TableReducer.reduce(&r, .snapshot(snap, .rejoin, hints: nil))
        XCTAssertEqual(caps(r), [3])
        XCTAssertEqual(bulbs(r), [4])
        XCTAssertEqual(pops(fx), [], "a snapshot never pops")
        // the same game's full snapshot without the keys: both off
        let plain = try T.snapshot("trick-mid-lead3")
        TableReducer.reduce(&r, .snapshot(plain, .requested("again"), hints: nil))
        XCTAssertEqual(caps(r), [])
        XCTAssertEqual(bulbs(r), [])
        // the snapshot's stored tutorial line (plain, as the server stores it) toggles nothing
        let logged = try T.snapshot("trick-mid-lead3") { raw in
            var log = raw["log"] as? [[String: Any]] ?? []
            log.append(["message": "kim turned on the tutorial.", "type": "system", "position": NSNull(), "at": 1_767_268_800_000])
            log.append(["message": "kim used /help.", "type": "system", "position": NSNull(), "at": 1_767_268_800_001, "help": ["position": 2]])
            raw["log"] = log
        }
        let fx2 = TableReducer.reduce(&r, .snapshot(logged, .requested("log"), hints: nil))
        XCTAssertEqual(caps(r), [])
        XCTAssertEqual(bulbs(r), [], "a replayed notice is a gold row, never a lightbulb")
        XCTAssertEqual(pops(fx2), [])
    }

    // MARK: whose avatar

    func testNeverOnMyOwnSeat() throws {
        // seated: my own seat's flags (the server's word) draw nothing: I have no avatar
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        TableReducer.reduce(&s, notice(1, seq: 4, name: "me"))
        TableReducer.reduce(&s, tutorialLine(1, on: true, seq: 5))
        let m = TableRenderModel(s)
        XCTAssertFalse(m.opponents.contains { $0.position == 1 })
        XCTAssertTrue(m.opponents.allSatisfy { $0.badge == nil })
        // a lazy watcher's own seat too
        let lazy = try T.state(fixture: "lazy-watcher")
        let me = try XCTUnwrap(lazy.table.viewer.position)
        XCTAssertFalse(TableRenderModel(lazy).opponents.contains { $0.position == me })
        // a pure spectator sees every seat's
        let spec = try T.snapshot("spectator-mid-hand") { raw in
            var seats = raw["seats"] as? [[String: Any]] ?? []
            for i in seats.indices { seats[i][(seats[i]["position"] as? Int ?? 0) % 2 == 0 ? "tutorial" : "askedHelp"] = true }
            raw["seats"] = seats
        }
        let sm = TableRenderModel(TableReducer.state(from: spec, hints: nil, previous: nil, source: .spectate))
        XCTAssertEqual(sm.opponents.sorted { $0.position < $1.position }.map(\.badge), [.bulb, .cap, .bulb, .cap])
        // a watcher: the watched seat is the bottom hand, no avatar, so no badge
        let watched = try T.snapshot("spectator-mid-hand") { raw in
            var seats = raw["seats"] as? [[String: Any]] ?? []
            for i in seats.indices { seats[i]["tutorial"] = true }
            raw["seats"] = seats
            var v = raw["viewer"] as? [String: Any] ?? [:]
            v["shoulder"] = ["position": 2, "hand": [T.card("spades", "A"), T.card("hearts", "3")], "hsi": 90.0] as [String: Any]
            raw["viewer"] = v
        }
        let wm = TableRenderModel(TableReducer.state(from: watched, hints: nil, previous: nil, source: .watchReply))
        XCTAssertEqual(wm.watchedSeat, 2)
        XCTAssertEqual(wm.opponents.map(\.position).sorted(), [1, 3, 4])
        XCTAssertTrue(wm.opponents.allSatisfy { $0.badge == .cap })
    }

    // MARK: layout

    /// Every listed device, seated and spectating, with and without the pill and the banner (the
    /// fans' heights): the badge sits wholly clear (nothing of `badgeKeeps`, outside the rings, in
    /// the safe area), and a seat eye shown with it keeps off every badge. The disconnect banner
    /// (a grace period, an offer: it goes) may cover it where the seat has no other spot (a phone's
    /// banner sits over the partner itself, TableLayout+Banner.swift; the Duo's under its bar).
    func testTheBadgeIsClearAtEveryListedSize() {
        var fallbacks: [String] = []
        var checked = 0, underBanner = 0
        for (name, size, chrome, _, _) in SeatExtrasTests.devices {
            for bar in Set([CGFloat(0), chrome.bottomBar]).sorted() {
                for banner in [CGFloat(0), 31, 86, 141] {
                    var c = chrome
                    c.bottomBar = bar
                    c.banner = banner
                    let L = TableLayout(size: size, chrome: c)
                    for spectating in [false, true] {
                        let seats: [Rel] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
                        let keeps = L.badgeKeeps(spectating: spectating)
                        var badges: [CGRect] = []
                        for r in seats {
                            checked += 1
                            let chip = L.seatBadge(r, spectating: spectating)
                            badges.append(chip)
                            let tag = "\(name) bar \(bar) banner \(banner) spectating \(spectating) \(r): \(chip)"
                            XCTAssertEqual(chip.size, CGSize(width: TableLayout.seatBadge, height: TableLayout.seatBadge))
                            let a = L.seatAnchor(r)
                            let problems = L.badgeProblems(chip, seat: r, keeps: keeps)
                            if problems == ["banner"] { underBanner += 1 }
                            XCTAssertEqual(problems.filter { $0 != "banner" }, [], tag)
                            if banner == 0 { XCTAssertEqual(problems, [], tag) }
                            if chip != L.badgeCandidates(r)[0] { fallbacks.append("\(name) \(r)") }
                            // by name: every dealer marker and bid bubble, the fans, the name, the rings, the screen
                            for q in seats { XCTAssertFalse(TableLayout.overlaps(L.dealerChip(q), chip), "\(tag): over \(q)'s dealer marker") }
                            for q in [Rel.top, .left, .right, .bottom] { XCTAssertFalse(TableLayout.overlaps(L.bubbleRect(q), chip), "\(tag): over \(q)'s bid bubble") }
                            for (q, fan) in L.fans(spectating: spectating) ?? [:] { XCTAssertFalse(TableLayout.overlaps(fan, chip), "\(tag): over \(q)'s fan") }
                            XCTAssertGreaterThanOrEqual(hypot(chip.midX - a.x, chip.midY - a.y) - chip.width / 2, TableLayout.glowRadius,
                                                        "\(tag): inside the turn glow / voice ring")
                            XCTAssertTrue(L.safeRect.contains(chip), "\(tag): on screen")
                            XCTAssertLessThanOrEqual(chip.maxY, L.topLimit + 0.01, "\(tag): under the score bar")
                            XCTAssertFalse(TableLayout.overlaps(TableLayout.nameRect(a), chip), "\(tag): over the name")
                        }
                        // every seat badged and every hand watched: no eye on a badge
                        for r in seats {
                            for n in [1, 2] {
                                let eye = L.watchChip(r, count: n, spectating: spectating, badges: badges)
                                for b in badges { XCTAssertFalse(TableLayout.overlaps(b, eye), "\(name) bar \(bar) banner \(banner) spectating \(spectating) \(r) x\(n): the eye \(eye) on a badge \(b)") }
                            }
                        }
                    }
                }
            }
        }
        print("[badge] \(checked) placements; under the banner: \(underBanner); off the first spot: \(fallbacks.count) \(Array(Set(fallbacks)).sorted().prefix(24))")
    }

    /// The corner is the same on every seat of a plain table where it fits: the upper one away
    /// from the dealer marker (the phone and the iPad, seated).
    func testTheFirstSpotIsTheUpperCornerAwayFromTheDealerMarker() {
        for (name, size, chrome) in [("iPhone 17e", SeatExtrasTests.phone.0, SeatExtrasTests.phone.1),
                                     ("iPad Air 11 portrait", SceneLayoutTests.measured[1].0, SceneLayoutTests.measured[1].1)] {
            let L = TableLayout(size: size, chrome: chrome)
            for r in [Rel.top, .left, .right] {
                let first = L.badgeCandidates(r)[0], a = L.seatAnchor(r), dealer = L.dealerChip(r)
                XCTAssertGreaterThan(first.midY, a.y, "\(name) \(r): above the avatar's middle")
                XCTAssertNotEqual(first.midX < a.x, dealer.midX < a.x, "\(name) \(r): the side away from the dealer marker")
            }
        }
    }

    /// The fans' fuzz of sizes and folds: never on the rings, a dealer marker, a bid bubble; mostly wholly clear.
    func testTheBadgeKeepsOffTheSeatsChipsAtEverySizeAndFold() {
        var total = 0, clear = 0
        var covered: [String: Int] = [:]
        for w in stride(from: CGFloat(320), through: 1400, by: 36) {
            for h in stride(from: CGFloat(480), through: 1400, by: 44) {
                let size = CGSize(width: w, height: h)
                var chromes = [PolishLayoutTests.chrome(TableLayoutTests.insets(24, 0, 20, 0), bottomBar: 0, topBar: 75.5),
                               TableChrome(safeArea: TableLayoutTests.insets(0, 0, 34, 84), topBar: 84)]
                var book = chromes[0], tabletop = chromes[0]
                book.fold = CGRect(x: -10, y: -h / 2, width: 20, height: h)
                tabletop.fold = CGRect(x: -w / 2, y: -10, width: w, height: 20)
                chromes += [book, tabletop]
                for c in chromes {
                    let L = TableLayout(size: size, chrome: c)
                    for spectating in [false, true] {
                        let seats: [Rel] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
                        let keeps = L.badgeKeeps(spectating: spectating)
                        for r in seats {
                            total += 1
                            let chip = L.seatBadge(r, spectating: spectating)
                            let problems = L.badgeProblems(chip, seat: r, keeps: keeps)
                            if problems.isEmpty { clear += 1 }
                            for p in problems { covered[p, default: 0] += 1 }
                            let named = problems.filter { $0 == "avatar" || $0.hasPrefix("dealer.") || $0.hasPrefix("bubble.") }
                            XCTAssertEqual(named, [], "\(size) fold \(String(describing: c.fold)) spectating \(spectating) \(r): \(chip)")
                        }
                    }
                }
            }
        }
        print("[badge] fuzz clear \(clear)/\(total); covered: \(covered.sorted { $0.value > $1.value }.prefix(8))")
        XCTAssertGreaterThan(clear, total * 9 / 10, "most of the fuzz is wholly clear")
    }

    // MARK: the scene

    private func makeScene(_ fixture: String, edit: @escaping (inout [String: Any]) -> Void = { _ in }) throws -> (ReplayHarness, GameSKScene) {
        let h = ReplayHarness()
        let snap = try T.snapshot(fixture, edit: edit)
        let me = snap.seats.first { $0.position == snap.viewer.position }?.username
        h.store.apply(.local(.identity(username: me ?? "viewer", playerId: "sid-viewer")))
        h.store.apply(.snapshot(snap, .rejoin, hints: nil))
        let size = SeatExtrasTests.phone.0
        let scene = GameSKScene(size: size)
        scene.animator = InstantAnimator()
        scene.chrome = SeatExtrasTests.phone.1
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        return (h, scene)
    }

    private static func seats(_ flags: [Int: String]) -> (inout [String: Any]) -> Void {
        { raw in
            var seats = raw["seats"] as? [[String: Any]] ?? []
            for i in seats.indices { if let pos = seats[i]["position"] as? Int, let key = flags[pos] { seats[i][key] = true } }
            raw["seats"] = seats
        }
    }

    private func badges(_ scene: SKScene) -> [SeatBadgeNode] {
        var out: [SeatBadgeNode] = []
        scene.enumerateChildNodes(withName: "//*") { n, _ in if let b = n as? SeatBadgeNode { out.append(b) } }
        return out
    }

    private func treeShape(_ scene: SKScene) -> [String] {
        var out: [String] = []
        scene.enumerateChildNodes(withName: "//*") { n, _ in out.append("\(type(of: n)) \(n.role ?? "-") \(n.position) \(n.isHidden)") }
        return out.sorted()
    }

    func testWithNoBadgesTheTableIsAsBefore() throws {
        for fixture in ["trick-mid-lead3", "spectator-mid-hand", "bidding-mid"] {
            let (_, scene) = try makeScene(fixture)
            XCTAssertEqual(badges(scene), [], "\(fixture): not one node more")
            for node in scene.opponentManager.nodes.values {
                XCTAssertEqual(node.nameAccessibilityLabel, node.fullName, "\(fixture): the name alone")
            }
        }
    }

    func testTheSceneDrawsEachBadgeWhereTheLayoutPutsItAndSpeaksIt() throws {
        let (h, scene) = try makeScene("trick-mid-lead3", edit: Self.seats([2: "askedHelp", 3: "tutorial"]))
        let byPos = scene.opponentManager.nodes
        let kim = try XCTUnwrap(byPos[2]), hal = try XCTUnwrap(byPos[3]), jon = try XCTUnwrap(byPos[4])
        let model = try XCTUnwrap(scene.lastModel)
        for (node, kind) in [(kim, SeatBadge.bulb), (hal, .cap)] {
            let b = try XCTUnwrap(node.badgeNode(make: false))
            XCTAssertEqual(b.badge, kind)
            XCTAssertFalse(b.isHidden)
            XCTAssertTrue(b.children.contains { $0.role == "badge.\(kind.rawValue)" })
            let o = try XCTUnwrap(model.opponents.first { $0.position == node.position(in: model) })
            let rect = scene.layout.seatBadge(o, model: model)
            let anchor = scene.layout.seatAnchor(node.relativePosition)
            XCTAssertEqual(b.position.x + anchor.x, rect.midX, accuracy: 0.01)
            XCTAssertEqual(b.position.y + anchor.y, rect.midY, accuracy: 0.01)
            XCTAssertFalse(b.isAccessibilityElement, "drawn only")
        }
        XCTAssertNil(jon.badgeNode(make: false), "no badge: no node")
        XCTAssertEqual(kim.nameAccessibilityLabel, "kim, asked for help this turn")
        XCTAssertEqual(hal.nameAccessibilityLabel, "hal, tutorial on")
        XCTAssertEqual(jon.nameAccessibilityLabel, "jon")

        // the turn moves on to hal: kim's lightbulb goes (its node stays, hidden), the name alone again
        let seq = (h.store.state.sync.lastSeq ?? 0) + 1
        _ = h.store.apply(serverEvent: "updateTurn", payload: [["currentTurn": 3, "seq": seq] as [String: Any]])
        XCTAssertTrue(try XCTUnwrap(kim.badgeNode(make: false)).isHidden)
        XCTAssertEqual(kim.nameAccessibilityLabel, "kim")
        XCTAssertEqual(hal.nameAccessibilityLabel, "hal, tutorial on", "the cap stays")
    }

    func testTheLiveNoticePopsOnceAndReduceMotionFades() throws {
        for reduce in [false, true] {
            Theme.Motion.reduceMotionOverride = reduce
            let (h, scene) = try makeScene("trick-mid-lead3")
            let animator = CapturingAnimator()
            scene.animator = animator
            let seq = (h.store.state.sync.lastSeq ?? 0) + 1
            _ = h.store.apply(serverEvent: "gameLogEntry", payload: [["message": "kim used /help.", "type": "system", "seq": seq,
                                                                       "help": ["position": 2]] as [String: Any]])
            let b = try XCTUnwrap(scene.opponentManager.nodes[2]?.badgeNode(make: false))
            XCTAssertEqual(b.badge, .bulb)
            XCTAssertEqual(scene.badgePops, 1)
            XCTAssertEqual(scene.lastBadgePop, reduce ? "fade" : "scale")
            let runs = animator.runs.filter { $0.node === b }
            XCTAssertEqual(runs.count, 1, "one pop")
            XCTAssertEqual(runs[0].action.duration, SeatBadgeNode.popDuration, accuracy: 0.001)
            XCTAssertEqual(b.alpha, reduce ? 0 : 1, "Reduce Motion: a fade from nothing, no scale")
            XCTAssertEqual(b.xScale, 1)
            // the same notice again (a re-sent line): no second pop
            _ = h.store.apply(serverEvent: "gameLogEntry", payload: [["message": "kim used /help.", "type": "system", "seq": seq + 1,
                                                                       "help": ["position": 2]] as [String: Any]])
            XCTAssertEqual(animator.runs.filter { $0.node === b }.count, 1)
            XCTAssertEqual(scene.badgePops, 1)
            // my own seat's notice: nothing to pop (no avatar)
            _ = h.store.apply(serverEvent: "gameLogEntry", payload: [["message": "ivy used /help.", "type": "system", "seq": seq + 2,
                                                                       "help": ["position": 1]] as [String: Any]])
            XCTAssertEqual(scene.badgePops, 1)
            XCTAssertEqual(badges(scene).count, 1)
        }
    }

    func testASpectatorSeesEverySeatsBadgeAndARelayoutKeepsThemClear() throws {
        let (_, scene) = try makeScene("spectator-mid-hand", edit: Self.seats([1: "askedHelp", 2: "tutorial", 3: "askedHelp", 4: "tutorial"]))
        XCTAssertEqual(scene.opponentManager.nodes.count, 4)
        for (pos, node) in scene.opponentManager.nodes {
            XCTAssertEqual(node.badgeNode(make: false)?.badge, pos % 2 == 0 ? .cap : .bulb, "seat \(pos)")
        }
        // the iPad's layout: still where the layout says, and clear
        scene.size = SceneLayoutTests.measured[1].0
        scene.chrome = SceneLayoutTests.measured[1].1
        scene.relayout(animated: false)
        let model = try XCTUnwrap(scene.lastModel)
        let keeps = scene.layout.badgeKeeps(spectating: true)
        for node in scene.opponentManager.nodes.values {
            let b = try XCTUnwrap(node.badgeNode(make: false))
            let o = try XCTUnwrap(model.opponents.first { $0.rel == node.relativePosition })
            let rect = scene.layout.seatBadge(o, model: model)
            XCTAssertEqual(b.position.x + node.position.x, rect.midX, accuracy: 0.01)
            XCTAssertEqual(b.position.y + node.position.y, rect.midY, accuracy: 0.01)
            XCTAssertEqual(scene.layout.badgeProblems(rect, seat: node.relativePosition, keeps: keeps), [])
        }
    }
}

/// An animator that records what `run` is given and never finishes it (the pop's first frame).
final class CapturingAnimator: Animator {
    var runs: [(node: SKNode, action: SKAction)] = []
    func move(_ node: SKNode, to point: CGPoint, duration: TimeInterval, completion: (() -> Void)?) {
        node.position = point
        completion?()
    }
    func collect(_ nodes: [SKNode], to point: CGPoint, completion: @escaping () -> Void) {
        nodes.forEach { $0.removeFromParent() }
        completion()
    }
    func pop(_ node: SKNode) {}
    func fadeAndRemove(_ node: SKNode, after delay: TimeInterval) { node.removeFromParent() }
    func run(_ node: SKNode, _ action: SKAction, final: (SKNode) -> Void) { runs.append((node, action)) }
}

private extension OpponentHandNode {
    /// The seat's absolute position in `model`.
    func position(in model: TableRenderModel) -> Int? { model.opponents.first { $0.rel == relativePosition }?.position }
}
