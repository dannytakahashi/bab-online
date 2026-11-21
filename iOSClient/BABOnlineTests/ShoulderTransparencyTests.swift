import XCTest
import SpriteKit
@testable import BAB_Online

/// Who watches which hand (docs/claude/spectators.md "Who watches which hand"): `shoulder` on the
/// spectator entries (snapshot `watching`, the private wide `spectatorsUpdated`), decoded
/// leniently into `WatchingList`, the seat eye (TableLayout+Watchers.swift, WatchChipNode) and
/// the badge list's "watching <player>" rows. With no `shoulder` nothing changes.
@MainActor
final class ShoulderTransparencyTests: XCTestCase {
    typealias Rel = Positions.RelativePosition

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    // MARK: wire

    /// contract/fixtures/shoulder/events.json, read from the checkout (one of each payload from a real game).
    private func shoulderFixture() throws -> [[String: Any]] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("contract/fixtures/shoulder/events.json"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(json["events"] as? [[String: Any]])
    }

    func testTheServersPayloadsDecodeStrictly() throws {
        let events = try shoulderFixture()
        let wide = try XCTUnwrap(events.first { $0["event"] as? String == "spectatorsUpdated" }?["data"] as? [String: Any])
        guard case .success(let ev) = ServerEvent.decode(name: "spectatorsUpdated", payload: [wide], strict: true),
              case .spectators(let p) = ev.event else { return XCTFail("spectatorsUpdated did not decode") }
        XCTAssertEqual(p.spectators?.first?.shoulder, 2)
        XCTAssertEqual(WatchingList(spectators: p.spectators ?? [], count: p.count ?? 0).spectators.first?.shoulder, 2)

        let reply = try XCTUnwrap(events.first { $0["event"] as? String == "stateSnapshot" }?["data"] as? [String: Any])
        let snap = try TableSnapshot.decode(try XCTUnwrap(reply["snapshot"]), strict: true)
        XCTAssertEqual(WatchingList(snap.watching).spectators.map(\.shoulder), [2])
    }

    func testAShoulderThisBuildCannotReadIsNoShoulder() {
        for bad: Any in ["2", ["position": 2], true, 2.5, NSNull()] {
            let payload: [String: Any] = ["gameId": "g1", "spectators": [["username": "zach", "pic": 3, "shoulder": bad], ["username": "yan", "pic": 4]], "count": 2]
            guard case .success(let ev) = ServerEvent.decode(name: "spectatorsUpdated", payload: [payload]),
                  case .spectators(let p) = ev.event else { XCTFail("\(bad): the list was lost"); continue }
            XCTAssertEqual(p.spectators?.map(\.username), ["zach", "yan"], "\(bad)")
            XCTAssertNil(p.spectators?.first?.shoulder, "\(bad)")
        }
        // strict (the contract fixture tests) still says so
        let mistyped: [String: Any] = ["gameId": "g1", "spectators": [["username": "zach", "pic": 3, "shoulder": "2"]], "count": 1]
        if case .success = ServerEvent.decode(name: "spectatorsUpdated", payload: [mistyped], strict: true) { XCTFail("strict decode took a string shoulder") }
        // the other fields are as strict as the generated synthesis was
        let noName: [String: Any] = ["gameId": "g1", "spectators": [["pic": 3, "shoulder": 2]], "count": 1]
        if case .success = ServerEvent.decode(name: "spectatorsUpdated", payload: [noName]) { XCTFail("an entry without a username decoded") }
    }

    func testAMistypedShoulderInASnapshotKeepsTheSnapshot() throws {
        var raw = try FixtureLoader.v2Snapshot("spectator-mid-hand")
        raw["watching"] = ["spectators": [["username": "zach", "pic": 3, "shoulder": "two"], ["username": "yan", "pic": 4, "shoulder": 3]], "count": 2]
        let snap = try TableSnapshot.decode(raw)
        XCTAssertEqual(WatchingList(snap.watching).spectators.map(\.shoulder), [nil, 3])
        XCTAssertThrowsError(try TableSnapshot.decode(raw, strict: true))
    }

    func testOnlyASeatIsAShoulder() {
        let list = WatchingList(spectators: [0, 1, 4, 5, -1].map { (v: Int) in TableSnapshot.Spectator(username: "u\(v)", pic: nil, avatarUrl: nil, shoulder: v) }
                                + [TableSnapshot.Spectator(username: "plain", pic: 2, avatarUrl: nil, shoulder: nil)], count: 6)
        XCTAssertEqual(list.spectators.map(\.shoulder), [nil, 1, 4, nil, nil, nil])
        XCTAssertEqual(list.watchersBySeat, [1: ["u1"], 4: ["u4"]])
    }

    // MARK: state

    func testTheLastListReceivedWins() throws {
        var s = T.dealtState()
        let plain: [[String: Any]] = [["username": "zach", "pic": 3], ["username": "yan", "pic": 4]]
        let wide: [[String: Any]] = [["username": "zach", "pic": 3, "shoulder": 3], ["username": "yan", "pic": 4, "shoulder": 1]]
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": plain, "count": 2]))
        XCTAssertEqual(s.players.watching.watchersBySeat, [:])
        // the room's plain copy, then the private wide one: the wide one stands
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": wide, "count": 2]))
        XCTAssertEqual(s.players.watching.watchersBySeat, [3: ["zach"], 1: ["yan"]])
        XCTAssertEqual(s.players.watching.count, 2)
        // the last watch ended: the list without shoulder
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": plain, "count": 2]))
        XCTAssertEqual(s.players.watching.watchersBySeat, [:])
        XCTAssertEqual(s.players.watching.spectators.map(\.username), ["zach", "yan"])
    }

    func testASnapshotCarriesWhoWatchesWhichHand() throws {
        let snap = try T.snapshot("trick-mid-lead3") { raw in
            raw["watching"] = ["spectators": [["username": "zach", "pic": 3, "shoulder": 2], ["username": "yan", "pic": 4, "shoulder": 2],
                                              ["username": "xena", "pic": 5]], "count": 3]
        }
        var s = TableState()
        TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))
        XCTAssertEqual(s.players.watching.watchersBySeat, [2: ["zach", "yan"]])
        XCTAssertEqual(TableRenderModel(s).watching.watchersBySeat, [2: ["zach", "yan"]])
        XCTAssertEqual(s.players.watchedSeatNames, [2: s.players.name(2)])
    }

    // MARK: words

    func testTheEyesWords() {
        XCTAssertEqual(WatchingList.watchLabel(["Zach"], player: "Alice", me: nil, mine: false), "Zach is watching Alice's hand")
        XCTAssertEqual(WatchingList.watchLabel(["Zach"], player: "Alice", me: "bob", mine: true), "Zach is watching your hand")
        XCTAssertEqual(WatchingList.watchLabel(["Zach", "Yan"], player: "Alice", me: nil, mine: false), "Zach and Yan are watching Alice's hand")
        XCTAssertEqual(WatchingList.watchLabel(["Zach", "Yan", "Xena"], player: "Alice", me: nil, mine: true), "Zach, Yan and Xena are watching your hand")
        XCTAssertEqual(WatchingList.watchLabel(["zach"], player: "Alice", me: "zach", mine: false), "You are watching Alice's hand")
        XCTAssertEqual(WatchingList.watchLabel(["yan", "zach"], player: "Alice", me: "zach", mine: false), "yan and You are watching Alice's hand")
        for label in [WatchingList.watchLabel(["Zach"], player: "Alice", me: nil, mine: true)] {
            XCTAssertFalse(label.lowercased().contains("team"), "names only, never team words")
        }
        XCTAssertNil(WatchingList.eyeCount(0))
        XCTAssertNil(WatchingList.eyeCount(1))
        XCTAssertEqual(WatchingList.eyeCount(2), "2")
        XCTAssertEqual(WatchingList.eyeCount(50), "50")
        XCTAssertEqual(WatchingList.eyeCount(120), "99+")
    }

    func testTheListsRows() {
        let names = [1: "Alice", 3: "Cat"]
        let w = { (u: String, s: Int?) in WatchingList.Watcher(username: u, pic: nil, avatarUrl: nil, shoulder: s) }
        XCTAssertEqual(WatchingList.rowText(w("Zach", 1), me: nil, seatName: { names[$0] }), "Zach · watching Alice")
        XCTAssertEqual(WatchingList.rowText(w("Zach", 1), me: "Zach", seatName: { names[$0] }), "Zach (you) · watching Alice")
        XCTAssertEqual(WatchingList.rowText(w("Zach", nil), me: nil, seatName: { names[$0] }), "Zach", "no shoulder: today's row")
        XCTAssertEqual(WatchingList.rowText(w("Zach", nil), me: "Zach", seatName: { names[$0] }), "Zach (you)")
        XCTAssertEqual(WatchingList.rowText(w("Zach", 2), me: nil, seatName: { names[$0] }), "Zach", "a seat with no name: just the name")
    }

    // MARK: layout

    func testTheEyeIsClearAtEveryListedSize() {
        var fallbacks: [String] = []
        for (name, size, chrome, _, _) in SeatExtrasTests.devices {
            for bar in Set([CGFloat(0), chrome.bottomBar]).sorted() {
                var c = chrome
                c.bottomBar = bar
                let L = TableLayout(size: size, chrome: c)
                for spectating in [false, true] {
                    let seats: [Rel] = spectating ? [.top, .left, .right, .bottom] : [.top, .left, .right]
                    let keeps = L.watchKeeps(spectating: spectating)
                    for r in seats {
                        for n in [1, 2, 12, 120] {
                            let chip = L.watchChip(r, count: n, spectating: spectating)
                            XCTAssertEqual(chip.size, TableLayout.watchChipSize(count: n))
                            let problems = L.watchProblems(chip, seat: r, keeps: keeps, spectating: spectating)
                            XCTAssertEqual(problems, [], "\(name) bar \(bar) spectating \(spectating) \(r) x\(n): \(chip)")
                            if chip != L.watchCandidates(r, count: n)[0] { fallbacks.append("\(name) \(r) x\(n)") }
                            // the dealer marker, the bid bubbles and the voice ring, by name
                            let a = L.seatAnchor(r)
                            for q in seats { XCTAssertFalse(TableLayout.overlaps(L.dealerChip(q), chip), "\(name) \(r): over \(q)'s dealer marker") }
                            for q in [Rel.top, .left, .right, .bottom] { XCTAssertFalse(TableLayout.overlaps(L.bubbleRect(q), chip), "\(name) \(r): over \(q)'s bid bubble") }
                            let nx = min(max(a.x, chip.minX), chip.maxX), ny = min(max(a.y, chip.minY), chip.maxY)
                            XCTAssertGreaterThanOrEqual(hypot(nx - a.x, ny - a.y), 30, "\(name) \(r): inside the voice ring / turn glow")
                        }
                    }
                }
            }
        }
        // most tables take the first spot; the list is printed for the record
        print("[watch] off the first spot: \(fallbacks.count) \(fallbacks.prefix(12))")
    }

    /// Every size and fold of the fans' fuzz: never on a dealer marker, a bid bubble or inside the
    /// voice ring / turn glow; anything else it covers is counted (a packed table may leave no clear spot).
    func testTheEyeKeepsOffTheSeatsChipsAtEverySizeAndFold() {
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
                        let keeps = L.watchKeeps(spectating: spectating)
                        for r in seats {
                            for n in [1, 2] {
                                total += 1
                                let chip = L.watchChip(r, count: n, spectating: spectating)
                                let problems = L.watchProblems(chip, seat: r, keeps: keeps, spectating: spectating)
                                if problems.isEmpty { clear += 1 }
                                for p in problems { covered[p, default: 0] += 1 }
                                let named = problems.filter { $0 == "avatar" || $0.hasPrefix("dealer.") || $0.hasPrefix("bubble.") }
                                XCTAssertEqual(named, [], "\(size) fold \(String(describing: c.fold)) spectating \(spectating) \(r) x\(n): \(chip)")
                            }
                        }
                    }
                }
            }
        }
        print("[watch] fuzz clear \(clear)/\(total); covered: \(covered.sorted { $0.value > $1.value }.prefix(8))")
        XCTAssertGreaterThan(clear, total * 9 / 10, "most of the fuzz is wholly clear")
    }

    func testMyEyeSitsAtMyHandsRightEnd() {
        for (name, size, chrome, _, _) in SeatExtrasTests.devices {
            let L = TableLayout(size: size, chrome: chrome)
            for cards in [0, 1, 2, 7, 13] {
                for n in [1, 2, 12] {
                    let chip = L.myWatchChip(handCount: cards, count: n)
                    XCTAssertGreaterThanOrEqual(chip.minY, L.handTop - 0.01, "\(name) \(cards): above the resting hand")
                    XCTAssertLessThanOrEqual(chip.maxY, L.liftTop + 0.01, "\(name) \(cards): inside the lift band")
                    XCTAssertGreaterThanOrEqual(chip.minX, L.safeRect.minX, "\(name) \(cards)")
                    XCTAssertLessThanOrEqual(chip.maxX, L.safeRect.maxX, "\(name) \(cards) x\(n)")
                    XCTAssertFalse(TableLayout.overlaps(L.myDealerChip(handCount: cards), chip), "\(name) \(cards): over my dealer marker")
                    XCTAssertFalse(TableLayout.overlaps(L.bidBand, chip), "\(name) \(cards)")
                    XCTAssertFalse(TableLayout.overlaps(L.seatRow.content, chip), "\(name) \(cards)")
                    if cards >= 2 {
                        let hand = TableLayoutTests.handRect(L, count: cards, lifted: false)
                        XCTAssertEqual(chip.maxX, min(hand.maxX, L.safeRect.maxX - 2), accuracy: 0.5, "\(name) \(cards): the hand's right end")
                    }
                }
            }
        }
    }

    // MARK: the scene

    private func makeScene(_ fixture: String, watching: [[String: Any]]? = nil) throws -> (ReplayHarness, GameSKScene) {
        let h = ReplayHarness()
        let snap = try T.snapshot(fixture) { raw in
            if let watching { raw["watching"] = ["spectators": watching, "count": watching.count] }
        }
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

    private func eyes(_ root: SKNode) -> [WatchChipNode] {
        var out: [WatchChipNode] = []
        root.enumerateChildNodes(withName: "//*") { n, _ in if let e = n as? WatchChipNode { out.append(e) } }
        if let e = root as? WatchChipNode { out.append(e) }
        return out
    }

    private func treeShape(_ scene: SKScene) -> [String] {
        var out: [String] = []
        scene.enumerateChildNodes(withName: "//*") { n, _ in out.append("\(type(of: n)) \(n.role ?? "-") \(n.position) \(n.isHidden)") }
        return out.sorted()  // siblings made from a dictionary come in any order
    }

    func testWithNoShoulderTheTableIsAsBefore() throws {
        for fixture in ["trick-mid-lead3", "spectator-mid-hand", "bidding-mid"] {
            let (_, before) = try makeScene(fixture)
            let plain: [[String: Any]] = [["username": "zach", "pic": 3], ["username": "yan", "pic": 4]]
            let (h, scene) = try makeScene(fixture, watching: plain)
            XCTAssertEqual(eyes(scene), [], fixture)
            XCTAssertEqual(SceneDump.dump(scene), SceneDump.dump(before), fixture)
            XCTAssertEqual(treeShape(scene), treeShape(before), "\(fixture): not one node more")
            // the room's plain copy again
            h.handler.handle(event: "spectatorsUpdated", payload: [["gameId": h.store.state.table.gameId ?? "", "spectators": plain, "count": 2]])
            XCTAssertEqual(eyes(scene), [], fixture)
            XCTAssertEqual(treeShape(scene), treeShape(before), fixture)
        }
    }

    func testAWatchedSeatShowsTheEyeWithItsCount() throws {
        let wide: [[String: Any]] = [["username": "zach", "pic": 3, "shoulder": 2], ["username": "yan", "pic": 4, "shoulder": 2],
                                     ["username": "xena", "pic": 5, "shoulder": 4], ["username": "wes", "pic": 6]]
        let (h, scene) = try makeScene("trick-mid-lead3", watching: wide)
        let me = try XCTUnwrap(h.store.state.table.viewer.position)
        XCTAssertNotEqual(me, 2)
        for (pos, node) in scene.opponentManager.nodes {
            let eye = node.watchChip(make: false)
            let n = pos == 2 ? 2 : pos == 4 ? 1 : 0
            if n == 0 {
                XCTAssertNil(eye, "seat \(pos)")
                continue
            }
            let chip = try XCTUnwrap(eye, "seat \(pos)")
            XCTAssertEqual(chip.count, n)
            XCTAssertFalse(chip.isHidden)
            let rect = scene.layout.watchChip(node.relativePosition, count: n, spectating: false)
            let anchor = scene.layout.seatAnchor(node.relativePosition)
            XCTAssertEqual(chip.position.x + anchor.x, rect.midX, accuracy: 0.01)
            XCTAssertEqual(chip.position.y + anchor.y, rect.midY, accuracy: 0.01)
            XCTAssertEqual(chip.children.contains { $0.role == "watch.count" }, n > 1, "the count past one")
        }
        XCTAssertNil(scene.watchChip(make: false), "my own hand is not watched")

        // the list without shoulder: the eyes go
        h.handler.handle(event: "spectatorsUpdated", payload: [["gameId": h.store.state.table.gameId ?? "", "spectators": [["username": "wes", "pic": 6]], "count": 1]])
        XCTAssertTrue(eyes(scene).allSatisfy(\.isHidden))
    }

    func testMyOwnWatchedHandShowsTheEyeByMyHand() throws {
        let snap = try T.snapshot("trick-mid-lead3")
        let me = try XCTUnwrap(snap.viewer.position)
        let (h, scene) = try makeScene("trick-mid-lead3", watching: [["username": "zach", "pic": 3, "shoulder": me]])
        let eye = try XCTUnwrap(scene.watchChip(make: false))
        XCTAssertEqual(eye.count, 1)
        XCTAssertEqual(eye.zPosition, -1, "under the hand's cards, as my dealer marker")
        let chip = scene.layout.myWatchChip(handCount: scene.lastModel?.hand?.cards.count ?? 0, count: 1)
        XCTAssertEqual(eye.position.x, chip.midX, accuracy: 0.01)
        XCTAssertEqual(eye.position.y, chip.midY, accuracy: 0.01)
        XCTAssertTrue(scene.opponentManager.nodes.values.allSatisfy { $0.watchChip(make: false) == nil })
        h.handler.handle(event: "spectatorsUpdated", payload: [["gameId": h.store.state.table.gameId ?? "", "spectators": [["username": "zach", "pic": 3, "shoulder": me], ["username": "yan", "pic": 4, "shoulder": me]], "count": 2]])
        XCTAssertEqual(scene.watchChip(make: false)?.count, 2)
    }

    func testASpectatorSeesEveryWatchedSeat() throws {
        let wide: [[String: Any]] = (1...4).map { ["username": "w\($0)", "pic": $0, "shoulder": $0] }
        let (_, scene) = try makeScene("spectator-mid-hand", watching: wide)
        XCTAssertEqual(scene.opponentManager.nodes.count, 4)
        for (pos, node) in scene.opponentManager.nodes { XCTAssertEqual(node.watchChip(make: false)?.count, 1, "seat \(pos)") }
        XCTAssertNil(scene.watchChip(make: false), "a spectator holds no hand")
    }
}
