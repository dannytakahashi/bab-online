import XCTest
import SpriteKit
import Combine
@testable import BAB_Online

/// The over-the-shoulder view on iOS (State/Table/Shoulder.swift; the wire and the server's
/// rules: docs/claude/spectators.md "Over-the-shoulder view"; the web's
/// client/src/state/shoulder.test.js covers the same rules): when watchHand is sent (the
/// default, the person's pick, Table view, the own-seat rule, the re-send rule), the refusals,
/// the paused rule, the watched seat's hand (snapshot, deal, cardPlayed), the mirrored hints,
/// the transparency words, the server's own payloads (contract/fixtures/shoulder/events.json),
/// that a seat and a plain spectator are unchanged, and that a watcher can never bid, play,
/// ask /help or touch the tutorial on any input path.
@MainActor
final class ShoulderViewTests: XCTestCase {
    // spectator-mid-hand: PLAYING, seats ivy (1), kim (2), hal (3), jon (4), all human; seat 1 on
    // turn; trick: hal clubs 4, jon clubs 6; ivy and kim hold 12, hal and jon 11
    private let fixture = "spectator-mid-hand"

    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    // MARK: - Builders

    private func snapDict(_ name: String? = nil, edit: (inout [String: Any]) -> Void = { _ in }) throws -> [String: Any] {
        var raw = try FixtureLoader.v2Snapshot(name ?? fixture)
        edit(&raw)
        return raw
    }

    private func decode(_ raw: [String: Any]) throws -> TableSnapshot { try TableSnapshot.decode(raw, strict: true) }

    /// Cards for a seat's hand (distinct, `n` of them).
    private func cards(_ n: Int, suit: String = "hearts") -> [[String: Any]] {
        let ranks = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"]
        return Array(ranks.prefix(n)).map { T.card(suit, $0) }
    }

    /// A spectator ("viewer" unless `me`) at the fixture, joined by its full state (spectatorJoined).
    private func joined(_ name: String? = nil, me: String = "viewer", edit: (inout [String: Any]) -> Void = { _ in }) throws
        -> (TableState, [TableEffect]) {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: me, playerId: "sid-\(me)")))
        let raw = try snapDict(name) { r in
            var v = r["viewer"] as? [String: Any] ?? [:]
            v["role"] = "spectator"; v["position"] = NSNull(); v["canAct"] = false; v["ownerView"] = NSNull()
            v.removeValue(forKey: "assist")
            r["viewer"] = v
            r["hand"] = NSNull()
            r["hsi"] = NSNull()
            edit(&r)
        }
        let fx = TableReducer.reduce(&s, .snapshot(try decode(raw), .spectate, hints: nil))
        return (s, fx)
    }

    /// The server's watchHand reply: the same table with viewer.shoulder for `pos` (or none).
    private func reply(_ s: inout TableState, _ name: String? = nil, pos: Int?, hand: [[String: Any]]? = nil, hsi: Double? = 120.5,
                       seq: Int? = nil) throws -> [TableEffect] {
        let raw = try snapDict(name) { r in
            var v = r["viewer"] as? [String: Any] ?? [:]
            v["role"] = "spectator"; v["position"] = NSNull(); v["canAct"] = false; v["ownerView"] = NSNull()
            v.removeValue(forKey: "assist")
            if let pos { v["shoulder"] = ["position": pos, "hand": hand ?? cards(12), "hsi": hsi.map { $0 as Any } ?? NSNull()] as [String: Any] }
            r["viewer"] = v
            r["hand"] = NSNull()
            r["hsi"] = NSNull()
            r["partial"] = ["log"]
            if let seq { r["seq"] = seq }
        }
        return TableReducer.reduce(&s, T.ev("stateSnapshot", ["snapshot": raw, "reason": "watchHand"]))
    }

    /// A requestSnapshot reply (a full state) with or without viewer.shoulder.
    private func fullState(_ s: inout TableState, _ name: String? = nil, pos: Int? = nil, id: String = "gap-9") throws -> [TableEffect] {
        let raw = try snapDict(name) { r in
            var v = r["viewer"] as? [String: Any] ?? [:]
            v["role"] = "spectator"; v["position"] = NSNull(); v["canAct"] = false; v["ownerView"] = NSNull()
            v.removeValue(forKey: "assist")
            if let pos { v["shoulder"] = ["position": pos, "hand": cards(12), "hsi": 99.0] as [String: Any] }
            r["viewer"] = v
            r["hand"] = NSNull()
            r["hsi"] = NSNull()
        }
        return TableReducer.reduce(&s, T.ev("stateSnapshot", ["snapshot": raw, "requestId": id]))
    }

    private func watches(_ fx: [TableEffect]) -> [Int?] {
        fx.compactMap { if case .watchHand(_, let p) = $0 { return .some(p) } else { return nil } }
    }

    private func gid(_ s: TableState) -> String { s.table.gameId ?? "" }

    private func seq(_ s: TableState) -> Int { (s.sync.lastSeq ?? 0) + 1 }

    private func logLine(_ s: TableState, _ message: String) -> TableEvent {
        T.ev("gameLogEntry", ["message": message, "type": "system", "seq": seq(s)])
    }

    // MARK: - Wire and routes

    func testTheCapAndTheRoutes() {
        XCTAssertTrue(ClientHello.caps.contains("shoulderView"), "only a socket with the cap gets any shoulder data")
        XCTAssertEqual(ShoulderRules.cap, "shoulderView")
        XCTAssertTrue(GameSocketHandler.events.contains(SocketEvents.Server.watchHandRefused))
        XCTAssertEqual(SocketEvents.Server.watchHandRefused, "watchHandRefused")
        XCTAssertEqual(SocketEvents.Client.watchHand, "watchHand")
        XCTAssertFalse(ContractSeq.events.contains("watchHandRefused"), "private and unsequenced")
        let p = LiveGameEmitter.watchHandPayload(gameId: "g", position: nil)
        XCTAssertTrue(p["position"] is NSNull, "a stop sends position null")
        XCTAssertEqual(LiveGameEmitter.watchHandPayload(gameId: "g", position: 3)["position"] as? Int, 3)
    }

    /// The server's own payloads, one of each from a real game (contract/fixtures/shoulder/events.json).
    func testTheServersPayloadsDecodeAndApply() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("contract/fixtures/shoulder/events.json")
        let file = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let events = try XCTUnwrap(file["events"] as? [[String: Any]])
        func data(_ name: String) throws -> [String: Any] {
            try XCTUnwrap(events.first { $0["event"] as? String == name && $0["direction"] as? String == "s2c" }?["data"] as? [String: Any])
        }
        // the reply's viewer.shoulder (generated Swift: Viewer.shoulder)
        let reply = try data("stateSnapshot")
        let snap = try TableSnapshot.decode(try XCTUnwrap(reply["snapshot"] as? [String: Any]), strict: true)
        XCTAssertEqual(snap.viewer.shoulder?.position, 2)
        XCTAssertEqual(snap.viewer.shoulder?.hand.count, 12)
        XCTAssertNotNil(snap.viewer.shoulder?.hsi)
        XCTAssertNil(snap.viewer.position, "the wire never puts the watched seat in viewer.position")
        XCTAssertNil(snap.hand)

        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "sid", playerId: "sid-x")))
        var fx = TableReducer.reduce(&s, T.ev("stateSnapshot", reply))
        XCTAssertEqual(s.table.viewer.role, .spectator)
        XCTAssertEqual(s.table.viewer.watchedSeat, 2)
        XCTAssertEqual(s.table.viewer.viewPosition, 2)
        XCTAssertNil(s.table.viewer.position)
        XCTAssertEqual(s.table.hand.count, 12)
        XCTAssertEqual(s.table.hsi[2] ?? 0, 137.58, accuracy: 0.01)
        XCTAssertEqual(watches(fx), [], "the reply itself sends nothing")

        // the mirrored /help answer: shown read-only, headed, never counted
        fx = TableReducer.reduce(&s, T.ev("assistHint", try data("assistHint")))
        let advice = try XCTUnwrap(s.table.watchedAssist)
        XCTAssertEqual(advice.watched, 2)
        XCTAssertNil(s.table.assist, "never my own answer")
        XCTAssertFalse(s.log.entries.contains { $0.isPrivate }, "no row: not mine")
        XCTAssertTrue(fx.contains(.announce("Suggestion for pia: Bid 1. rex (your partner) bids after you and adds their own tricks. Bid 1 is worth about +35 on average, bid 2 about +34.")))

        // the wide spectator list (an entry's `shoulder`) decodes and applies as before
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", try data("spectatorsUpdated")))
        XCTAssertEqual(s.players.watching.spectators.map(\.username), ["sid"])
        XCTAssertEqual(s.players.watching.count, 1)

        // the next deal's spectator gameStart: the watched seat's new hand
        var deal = try data("gameStart")
        deal["seq"] = seq(s)
        fx = TableReducer.reduce(&s, T.ev("gameStart", deal))
        XCTAssertEqual(s.table.viewer.watchedSeat, 2)
        XCTAssertEqual(s.table.hand.count, 12)
        XCTAssertTrue(s.table.hand.contains(T.c("joker", "HI")))
        XCTAssertEqual(s.table.hsi, [2: 105.08333333333333])
        XCTAssertEqual(watches(fx), [], "the deal carries the wanted hand: nothing to ask")
        XCTAssertNil(s.table.watchedAssist, "a new deal ends the advice")

        // the refusal decodes (own_seat with ownPosition)
        let refused = try ServerEvent.decode(name: "watchHandRefused", payload: [try data("watchHandRefused")], strict: true).get()
        XCTAssertNil(refused.seq)
        guard case .watchHandRefused(let r) = refused.event else { return XCTFail("\(refused.event)") }
        XCTAssertEqual(r.reason, "own_seat")
        XCTAssertEqual(r.ownPosition, 1)
    }

    func testAMalformedDealShoulderIsDroppedNotTheDeal() throws {
        let ev = try ServerEvent.decode(name: "gameStart", payload: [[
            "gameId": "g", "hand": [Any](), "trump": T.card("clubs", "5"), "score1": 0, "score2": 0, "dealer": 1, "currentHand": 3,
            "seq": 4, "shoulder": ["position": 2, "hand": [["suit": "stars", "rank": "Z"]]],
        ] as [String: Any]], strict: false).get()
        guard case .gameStart(let p) = ev.event else { return XCTFail() }
        XCTAssertNotNil(p.shoulder)
        XCTAssertNil(p.shoulder?.value)
    }

    // MARK: - When watchHand is sent

    func testAFullStateWatchesTheFirstHumanSeatByDefault() throws {
        var (s, fx) = try joined()
        XCTAssertEqual(watches(fx), [1], "ivy, seat 1")
        XCTAssertEqual(s.table.watch.selected, 1)
        XCTAssertNil(s.table.viewer.watchedSeat, "nothing shown before the server serves it")

        // seat 1 a native bot: the next human
        (s, fx) = try joined { r in
            var seats = r["seats"] as! [[String: Any]]
            seats[0]["controller"] = "bot"; seats[0]["isBot"] = true; seats[0]["ownerUsername"] = NSNull(); seats[0]["presence"] = "none"
            r["seats"] = seats
        }
        XCTAssertEqual(watches(fx), [2])
        // nobody human: seat 1
        (s, fx) = try joined { r in
            r["seats"] = (r["seats"] as! [[String: Any]]).map { seat in
                var seat = seat
                seat["controller"] = "bot"; seat["isBot"] = true; seat["ownerUsername"] = NSNull(); seat["presence"] = "none"
                return seat
            }
        }
        XCTAssertEqual(watches(fx), [1])
        _ = s
    }

    func testTheReplyDrawsTheTableFromTheWatchedSeat() throws {
        var (s, _) = try joined()
        let fx = try reply(&s, pos: 2, hand: cards(12, suit: "spades"))
        XCTAssertEqual(watches(fx), [], "the reply is not a full state")
        XCTAssertEqual(s.table.viewer.role, .spectator, "still a spectator: nothing can act")
        XCTAssertFalse(s.table.viewer.holdsSeat, "holdsSeat starts voice for a seat owner: never a watcher")
        XCTAssertEqual(s.table.viewer.viewPosition, 2)
        XCTAssertEqual(s.table.hand.count, 12)
        XCTAssertEqual(s.table.hsi, [2: 120.5])
        XCTAssertEqual(s.myTurn, .waiting)
        XCTAssertTrue(s.isReadOnly)

        let m = TableRenderModel(s)
        XCTAssertFalse(m.isSpectator, "the seated layout")
        XCTAssertEqual(m.watchedSeat, 2)
        XCTAssertEqual(m.viewPosition, 2)
        XCTAssertEqual(m.opponents.map(\.position).sorted(), [1, 3, 4])
        XCTAssertEqual(m.opponents.first { $0.position == 4 }?.rel, .top, "the partner across")
        let hand = try XCTUnwrap(m.hand)
        XCTAssertTrue(hand.readOnly)
        XCTAssertFalse(hand.interactive)
        XCTAssertEqual(hand.legalIds, Set(hand.cards.map(\.id)), "bright: never dimmed")
        XCTAssertEqual(hand.blocked, [:])
        XCTAssertNil(m.trick.first { $0.provisional })
    }

    func testTheReSendRule() throws {
        var (s, _) = try joined()
        _ = try reply(&s, pos: 1)
        // a full state that serves the seat: nothing to send
        var fx = try fullState(&s, pos: 1)
        XCTAssertEqual(watches(fx), [])
        XCTAssertEqual(s.table.viewer.watchedSeat, 1)
        // one without viewer.shoulder (a reconnect on a new socket, a server restart): the view
        // goes and the wanted seat is asked for again
        fx = try fullState(&s)
        XCTAssertNil(s.table.viewer.watchedSeat)
        XCTAssertEqual(watches(fx), [1])
        // a requestSnapshot reply that serves another seat than the one wanted (picked 3)
        TableReducer.reduce(&s, .local(.watchSeat(3)))
        fx = try fullState(&s, pos: 3)
        XCTAssertEqual(watches(fx), [])
    }

    func testAnAvatarTapPicksTheSeatAndTableViewIsRemembered() throws {
        var (s, _) = try joined()
        _ = try reply(&s, pos: 1)
        XCTAssertEqual(ShoulderRules.tap(s, position: 1), .profile, "the watched seat itself: its profile")
        XCTAssertEqual(ShoulderRules.tap(s, position: 3), .watch)
        var fx = TableReducer.reduce(&s, .local(.watchSeat(3)))
        XCTAssertEqual(watches(fx), [3])
        XCTAssertEqual(s.table.me.watchChoices[gid(s)], .seat(3))
        _ = try reply(&s, pos: 3)
        XCTAssertEqual(s.table.viewer.watchedSeat, 3)
        // a reconnect's full state: the pick, not the default
        fx = try fullState(&s)
        XCTAssertEqual(watches(fx), [3])
        _ = try reply(&s, pos: 3)

        // Table view: the plain view at once, a stop sent, remembered for this game
        fx = TableReducer.reduce(&s, .local(.watchTableView))
        XCTAssertEqual(watches(fx), [nil])
        XCTAssertNil(s.table.viewer.watchedSeat)
        XCTAssertEqual(s.table.hand, [])
        XCTAssertEqual(s.table.hsi, [:])
        XCTAssertTrue(TableRenderModel(s).isSpectator)
        XCTAssertNil(TableRenderModel(s).hand)
        XCTAssertEqual(s.table.me.watchChoices[gid(s)], .table)
        _ = try reply(&s, pos: nil)
        fx = try fullState(&s)
        XCTAssertEqual(watches(fx), [], "Table view wins over every default")
        // a deal after Table view sends nothing either, and a stale shoulder is not shown
        var deal: [String: Any] = ["gameId": gid(s), "hand": [Any](), "trump": T.card("clubs", "5"), "score1": 0, "score2": 0,
                                   "dealer": 1, "currentHand": 10, "seq": seq(s),
                                   "shoulder": ["position": 3, "hand": cards(10), "hsi": 80.0] as [String: Any]]
        fx = TableReducer.reduce(&s, T.ev("gameStart", deal))
        XCTAssertEqual(watches(fx), [])
        XCTAssertNil(s.table.viewer.watchedSeat, "a deal sent before my stop landed is not shown")

        // remembered across leaving and watching the same game again (in memory)
        TableReducer.reduce(&s, .local(.reset))
        XCTAssertEqual(s.table.me.watchChoices.values.first, .table)
        let raw = try snapDict { r in
            var v = r["viewer"] as! [String: Any]
            v["role"] = "spectator"; v["position"] = NSNull(); v["canAct"] = false; v["ownerView"] = NSNull()
            r["viewer"] = v; r["hand"] = NSNull(); r["hsi"] = NSNull()
        }
        fx = TableReducer.reduce(&s, .snapshot(try decode(raw), .spectate, hints: nil))
        XCTAssertEqual(watches(fx), [])
        // a tap watches again
        fx = TableReducer.reduce(&s, .local(.watchSeat(2)))
        XCTAssertEqual(watches(fx), [2])
        deal["seq"] = seq(s)
        _ = deal
    }

    func testTheOwnSeatRule() throws {
        // kim (seat 2) on another device: only that seat
        var (s, fx) = try joined(me: "kim")
        XCTAssertEqual(watches(fx), [2])
        _ = try reply(&s, pos: 2)
        XCTAssertEqual(ShoulderRules.tap(s, position: 3), .profile, "another seat: its profile")
        XCTAssertEqual(watches(TableReducer.reduce(&s, .local(.watchSeat(3)))), [], "never another seat")
        XCTAssertEqual(ShoulderRules.watchableSeats(s), [])
        // Table view still wins: the rule limits which seat, it never forces a watch
        fx = TableReducer.reduce(&s, .local(.watchTableView))
        XCTAssertEqual(watches(fx), [nil])
        fx = try fullState(&s)
        XCTAssertEqual(watches(fx), [])
        XCTAssertEqual(ShoulderRules.tap(s, position: 2), .watch, "a tap on my own seat watches it again")
        XCTAssertEqual(watches(TableReducer.reduce(&s, .local(.watchSeat(2)))), [2])
    }

    func testTheOwnSeatRefusalSwitchesSilently() throws {
        var (s, _) = try joined()
        let gameId = gid(s)
        var fx = TableReducer.reduce(&s, T.ev("watchHandRefused", ["gameId": gameId, "position": 1, "reason": "own_seat",
                                                                  "message": "m", "ownPosition": 3]))
        XCTAssertEqual(watches(fx), [3])
        XCTAssertEqual(s.table.watch.ownSeat, 3)
        XCTAssertEqual(s.table.watch.selected, 3)
        // another game's refusal is not mine
        fx = TableReducer.reduce(&s, T.ev("watchHandRefused", ["gameId": "other", "position": 3, "reason": "tournament", "message": "m"]))
        XCTAssertFalse(s.table.watch.blocked)
        // after Table view: only noted
        TableReducer.reduce(&s, .local(.watchTableView))
        fx = TableReducer.reduce(&s, T.ev("watchHandRefused", ["gameId": gameId, "position": 1, "reason": "own_seat",
                                                              "message": "m", "ownPosition": 3]))
        XCTAssertEqual(watches(fx), [])
    }

    /// The draw's positionUpdate for the fixture's four (ivy, kim, hal, jon), kim's seat on `kimSocket`.
    private func positionUpdate(_ s: TableState, kimSocket: String) -> TableEvent {
        T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-ivy", kimSocket, "sid-hal", "sid-jon"],
                                "usernames": [["username": "ivy"], ["username": "kim"], ["username": "hal"], ["username": "jon"]],
                                "pics": [1, 2, 3, 4], "seq": seq(s)])
    }

    func testASecondDeviceSpectatingDuringTheDrawNeverTakesTheSeat() throws {
        // kim's phone spectates kim's own game in the draw; the seat is kim's other socket. The
        // draw's positionUpdate names "kim": this socket stays a spectator (no seat, no chime, no
        // live bid panel), and the first deal watches kim's own seat
        var (s, fx) = try joined(me: "kim") { r in r["deal"] = NSNull() }
        XCTAssertEqual(watches(fx), [])
        TableReducer.reduce(&s, positionUpdate(s, kimSocket: "sid-kim-laptop"))
        XCTAssertEqual(s.table.viewer.role, .spectator, "my username's seat on another device is not mine here")
        XCTAssertNil(s.table.viewer.position)
        XCTAssertFalse(s.table.viewer.holdsSeat)
        XCTAssertEqual(ShoulderRules.ownSeat(s), 2)
        fx = TableReducer.reduce(&s, T.ev("gameStart", ["gameId": gid(s), "hand": [Any](), "trump": T.card("clubs", "5"),
                                                        "score1": 0, "score2": 0, "dealer": 1, "currentHand": 12, "seq": seq(s)]))
        XCTAssertEqual(watches(fx), [2], "the own-seat watch")
        XCTAssertTrue(s.table.phase.isBidding)
        fx += TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": seq(s)]))
        XCTAssertFalse(fx.contains(.sound(.turn)), "no chime")
        TableReducer.reduce(&s, .local(.submitBid("2", reqId: 1)))
        XCTAssertNil(s.pending, "never a bid")

        // this socket's own id still seats it (the server put this socket in the seat)
        (s, _) = try joined(me: "kim") { r in r["deal"] = NSNull() }
        TableReducer.reduce(&s, positionUpdate(s, kimSocket: "sid-kim"))
        XCTAssertEqual(s.table.viewer.role, .seat)
        XCTAssertEqual(s.table.viewer.position, 2)
    }

    func testAnEntrantARejoinAndADrawReconnectStillTakeTheirSeat() throws {
        // an entrant (the room's draw, no snapshot yet): by username, as before
        for role in [ViewerRole.none, .entrant] {
            var s = TableState()
            TableReducer.reduce(&s, .local(.identity(username: "kim", playerId: "sid-new")))
            TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
            s.table.viewer.role = role
            TableReducer.reduce(&s, positionUpdate(s, kimSocket: "sid-old"))
            XCTAssertEqual(s.table.viewer.role, .seat, "\(role): my seat by username")
            XCTAssertEqual(s.table.viewer.position, 2)
        }
        // a rejoin or a draw-phase reconnect: the snapshot seats this socket; a positionUpdate
        // that still lists the old socket keeps the seat
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "kim", playerId: "sid-new")))
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        s.table.viewer.role = .seat
        s.table.viewer.position = 2
        TableReducer.reduce(&s, positionUpdate(s, kimSocket: "sid-old"))
        XCTAssertEqual(s.table.viewer.role, .seat)
        XCTAssertEqual(s.table.viewer.position, 2)
        // a lazy watcher of its own seat keeps it
        s.table.viewer.role = .lazyWatcher
        TableReducer.reduce(&s, positionUpdate(s, kimSocket: "sid-old"))
        XCTAssertTrue(s.table.viewer.holdsSeat)
        XCTAssertEqual(s.table.viewer.position, 2)
    }

    func testNeverAtATournamentTable() throws {
        // a spectator of a tournament table: nothing sent, every avatar a profile
        var (s, fx) = try joined("tournament-game")
        XCTAssertNotNil(s.table.tournamentId)
        XCTAssertEqual(watches(fx), [])
        XCTAssertFalse(ShoulderRules.allowed(s))
        XCTAssertEqual((1...4).map { ShoulderRules.tap(s, position: $0) }, [.profile, .profile, .profile, .profile])
        XCTAssertEqual(watches(TableReducer.reduce(&s, .local(.watchSeat(2)))), [])
        XCTAssertTrue(TableRenderModel(s).isSpectator)

        // a `tournament` refusal (a table whose tournament the client did not know): the view goes, nothing more
        (s, _) = try joined()
        _ = try reply(&s, pos: 1)
        fx = TableReducer.reduce(&s, T.ev("watchHandRefused", ["gameId": gid(s), "position": 2, "reason": "tournament", "message": "m"]))
        XCTAssertTrue(s.table.watch.blocked)
        XCTAssertNil(s.table.viewer.watchedSeat)
        XCTAssertEqual(watches(try fullState(&s)), [])
        XCTAssertEqual(ShoulderRules.tap(s, position: 2), .profile)
    }

    func testBeforeTheFirstDealItWaitsForTheDeal() throws {
        // a full state of the draw (no deal): nothing yet
        var (s, fx) = try joined { r in r["deal"] = NSNull() }
        XCTAssertEqual(watches(fx), [])
        XCTAssertTrue(s.table.watch.waitingDeal)
        XCTAssertEqual(ShoulderRules.tap(s, position: 2), .profile, "no hand to watch yet")
        // the first deal (the spectator variant, no shoulder): the default goes
        fx = TableReducer.reduce(&s, T.ev("gameStart", ["gameId": gid(s), "hand": [Any](), "trump": T.card("clubs", "5"),
                                                        "score1": 0, "score2": 0, "dealer": 4, "currentHand": 12, "seq": seq(s)]))
        XCTAssertEqual(watches(fx), [1])
        XCTAssertFalse(s.table.watch.waitingDeal)

        // a not_dealt refusal: waits, then the deal sends it again
        (s, _) = try joined()
        TableReducer.reduce(&s, T.ev("watchHandRefused", ["gameId": gid(s), "position": 1, "reason": "not_dealt", "message": "m"]))
        XCTAssertTrue(s.table.watch.waitingDeal)
    }

    func testEveryDealBringsTheWatchedHand() throws {
        var (s, _) = try joined()
        _ = try reply(&s, pos: 1)
        var fx = TableReducer.reduce(&s, T.ev("gameStart", [
            "gameId": gid(s), "hand": [Any](), "trump": T.card("clubs", "5"), "score1": 0, "score2": 0, "dealer": 1, "currentHand": 3,
            "seq": seq(s), "shoulder": ["position": 1, "hand": cards(3, suit: "diamonds"), "hsi": 88.0] as [String: Any],
        ]))
        XCTAssertEqual(watches(fx), [])
        XCTAssertEqual(s.table.hand.count, 3)
        XCTAssertEqual(s.table.hsi, [1: 88.0])
        XCTAssertTrue(s.table.hsiHeld, "the deal's HSI shows a beat later, as a seat's")
        XCTAssertTrue(fx.contains(.animate(.dealt(dealSeq: s.table.deal?.dealSeq ?? 0))), "dealt in as my own hand")
        // a deal without the hand while watching: no stale cards, and asked again
        fx = TableReducer.reduce(&s, T.ev("gameStart", [
            "gameId": gid(s), "hand": [Any](), "trump": T.card("clubs", "5"), "score1": 0, "score2": 0, "dealer": 2, "currentHand": 1,
            "seq": seq(s),
        ]))
        XCTAssertEqual(s.table.hand, [])
        XCTAssertEqual(s.table.viewer.watchedSeat, 1, "the view stays")
        XCTAssertEqual(watches(fx), [1])
    }

    func testTheWatchedSeatsCardLeavesItsHand() throws {
        var (s, _) = try joined()
        var hand = cards(11, suit: "spades")
        hand.append(T.card("clubs", "K"))
        _ = try reply(&s, pos: 1, hand: hand)
        XCTAssertEqual(s.table.hand.count, 12)
        // another seat's card: the watched hand is unchanged
        // (seat 1 is on turn; the trick has 3's and 4's cards: seat 1 plays the 3rd card)
        var fx = TableReducer.reduce(&s, T.ev("cardPlayed", ["position": 1, "card": T.card("clubs", "K"), "seq": seq(s)]))
        XCTAssertEqual(s.table.hand.count, 11)
        XCTAssertFalse(s.table.hand.contains(T.c("clubs", "K")))
        XCTAssertTrue(fx.contains { if case .animate(.cardPlayed(_, _, let byMe)) = $0 { return !byMe } else { return false } },
                      "never `byMe`: a watcher submits nothing")
        XCTAssertTrue(s.table.phase.trick.contains { $0.position == 1 })
        fx = TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": seq(s)]))
        fx = TableReducer.reduce(&s, T.ev("cardPlayed", ["position": 2, "card": T.card("clubs", "2"), "seq": seq(s)]))
        XCTAssertEqual(s.table.hand.count, 11)
        _ = fx
    }

    func testThePausedRule() throws {
        var (s, _) = try joined()
        _ = try reply(&s, pos: 1)
        // the room's pause line: the seat is held, no stale cards, drawn from it
        var fx = TableReducer.reduce(&s, logLine(s, ShoulderRules.pauseLine))
        XCTAssertEqual(watches(fx), [])
        XCTAssertTrue(s.table.watch.paused)
        XCTAssertEqual(s.table.viewer.shoulder, ShoulderSeat(position: 1, paused: true))
        XCTAssertEqual(s.table.viewer.watchedSeat, 1)
        XCTAssertFalse(s.table.viewer.watchesHand)
        XCTAssertEqual(s.table.hand, [])
        XCTAssertEqual(s.table.hsi, [:])
        let m = TableRenderModel(s)
        XCTAssertFalse(m.isSpectator, "still the seated layout")
        XCTAssertEqual(m.hand?.cards, [])
        // a full state without viewer.shoulder does NOT end the watch while paused; it asks again
        fx = try fullState(&s)
        XCTAssertEqual(s.table.viewer.shoulder, ShoulderSeat(position: 1, paused: true))
        XCTAssertEqual(watches(fx), [1])
        // a reply without it (a paused table serves nothing) keeps the selection too
        _ = try reply(&s, pos: nil)
        XCTAssertEqual(s.table.watch.selected, 1)
        XCTAssertEqual(s.table.viewer.shoulder?.paused, true)
        // "Game resumed.": sent again; the reply restores the hand
        fx = TableReducer.reduce(&s, logLine(s, ShoulderRules.resumeLine))
        XCTAssertEqual(watches(fx), [1])
        _ = try reply(&s, pos: 1)
        XCTAssertFalse(s.table.watch.paused)
        XCTAssertEqual(s.table.viewer.shoulder, ShoulderSeat(position: 1))
        XCTAssertEqual(s.table.hand.count, 12)

        // an `unavailable` refusal pauses too; a tap while paused holds the new seat
        fx = TableReducer.reduce(&s, T.ev("watchHandRefused", ["gameId": gid(s), "position": 2, "reason": "unavailable", "message": "m"]))
        XCTAssertTrue(s.table.watch.paused)
        XCTAssertEqual(s.table.viewer.shoulder, ShoulderSeat(position: 1, paused: true))
        fx = TableReducer.reduce(&s, .local(.watchSeat(3)))
        XCTAssertEqual(watches(fx), [3])
        XCTAssertEqual(s.table.viewer.shoulder, ShoulderSeat(position: 3, paused: true))
        // Table view while paused: the plain view at once (the server does the stop, unanswered)
        fx = TableReducer.reduce(&s, .local(.watchTableView))
        XCTAssertEqual(watches(fx), [nil])
        XCTAssertNil(s.table.viewer.shoulder)
        XCTAssertFalse(s.table.watch.paused)
    }

    func testNotSpectatingAndTheGamesEndDropTheView() throws {
        var (s, _) = try joined()
        _ = try reply(&s, pos: 1)
        TableReducer.reduce(&s, T.ev("watchHandRefused", ["gameId": gid(s), "position": 1, "reason": "not_spectating", "message": "m"]))
        XCTAssertNil(s.table.viewer.watchedSeat)
        XCTAssertNil(s.table.watch.selected)

        (s, _) = try joined()
        _ = try reply(&s, pos: 2)
        let fx = TableReducer.reduce(&s, T.ev("gameEnd", ["score": ["team1": 300, "team2": 200], "tournamentId": NSNull(), "seq": seq(s)]))
        XCTAssertEqual(watches(fx), [], "the server forgets the watch with the game")
        XCTAssertNil(s.table.viewer.watchedSeat, "the end screen is the plain spectator's")
        XCTAssertEqual(s.table.viewer.viewPosition, 1)
    }

    // MARK: - Mirrored hints

    /// bidding-mid as a spectator: seat 4 (ned) on its bid turn, bids B (seat 2) and 1 (seat 3) so far.
    private func watchingBidder() throws -> TableState {
        var (s, _) = try joined("bidding-mid")
        TableReducer.reduce(&s, .local(.watchSeat(4)))
        _ = try reply(&s, "bidding-mid", pos: 4)
        XCTAssertEqual(s.table.viewer.watchedSeat, 4)
        return s
    }

    private func watchedHint(_ kind: String = "bid", watched: Int = 4, key: String = "1|BIDDING|4|2|0", source: String = "help",
                             tipId: String? = nil) -> TableEvent {
        var p: [String: Any] = ["v": 1, "source": source, "kind": kind, "turnKey": key, "headline": kind == "tip" ? "Bidding" : "Bid 2",
                                "reasons": ["Your hand should take about 2 tricks."], "uses": 2, "freeUses": 3, "assisted": false,
                                "counted": true, "confidence": "clear", "watched": watched]
        if kind == "bid" { p["suggest"] = ["bid": "2"] }
        if let tipId { p["tipId"] = tipId }
        return T.ev("assistHint", p)
    }

    func testTheWatchedSeatsAdviceIsStoredReadOnlyAndNeverCountedForMe() throws {
        var s = try watchingBidder()
        let fx = TableReducer.reduce(&s, watchedHint())
        let h = try XCTUnwrap(s.table.watchedAssist)
        XCTAssertNil(s.table.assist)
        XCTAssertNil(s.table.assistUses, "the watched player's count is never mine")
        XCTAssertNil(h.note)
        XCTAssertEqual(h.actions, [])
        XCTAssertFalse(s.log.entries.contains { $0.isPrivate })
        XCTAssertTrue(fx.contains(.announce("Suggestion for ned: Bid 2. Your hand should take about 2 tricks.")))
        // the watched seat's own bid ends it
        TableReducer.reduce(&s, T.ev("bidReceived", ["position": 4, "bid": 2, "bidArray": [NSNull(), "B", 1, 2], "seq": seq(s)]))
        XCTAssertNil(s.table.watchedAssist)
    }

    func testOnlyTheWatchedSeatsLiveHintsShow() throws {
        var s = try watchingBidder()
        TableReducer.reduce(&s, watchedHint(watched: 2))
        XCTAssertNil(s.table.watchedAssist, "another seat's copy")
        TableReducer.reduce(&s, watchedHint(key: "1|BIDDING|4|1|0"))
        XCTAssertNil(s.table.watchedAssist, "not this turn's (one bid less)")
        TableReducer.reduce(&s, watchedHint("status"))
        XCTAssertNil(s.table.watchedAssist, "status lines are the asker's")
        // a plain spectator never shows one
        var (plain, _) = try joined("bidding-mid")
        TableReducer.reduce(&plain, watchedHint())
        XCTAssertNil(plain.table.watchedAssist)
        // a seat holder never treats a copy as its own (a copy never reaches a seat)
        var seat = T.dealtState()
        TableReducer.reduce(&seat, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        TableReducer.reduce(&seat, watchedHint(watched: 1, key: "1|BIDDING|1|0|0"))
        XCTAssertNil(seat.table.assist)
        XCTAssertNil(seat.table.watchedAssist)
    }

    func testTheWatchedSeatsTipShowsWithItsHeadingAndGoesWithASwitch() throws {
        var s = try watchingBidder()
        TableReducer.reduce(&s, watchedHint("tip", source: "tutorial", tipId: "T.bid"))
        let tip = try XCTUnwrap(s.table.watchedTip)
        XCTAssertEqual(tip.watched, 4)
        XCTAssertNil(s.table.tip, "never my own tip")
        XCTAssertFalse(s.log.entries.contains { $0.isPrivate }, "no row")
        // the welcome is never mirrored as a card
        TableReducer.reduce(&s, .local(.watchedHintDismissed(tip: true)))
        XCTAssertNil(s.table.watchedTip)
        TableReducer.reduce(&s, watchedHint("tip", source: "tutorial", tipId: "T.welcome"))
        XCTAssertNil(s.table.watchedTip)
        // my own tutorial going off never clears the watched player's
        TableReducer.reduce(&s, watchedHint("tip", source: "tutorial", tipId: "T.bid"))
        TableReducer.reduce(&s, T.ev("assistState", ["tutorial": false, "uses": 0, "freeUses": 3, "assisted": false]))
        XCTAssertNotNil(s.table.watchedTip)
        // a switch to another seat: its tips go
        TableReducer.reduce(&s, .local(.watchSeat(1)))
        _ = try reply(&s, "bidding-mid", pos: 1)
        XCTAssertNil(s.table.watchedTip)
    }

    // MARK: - A seat and a plain spectator are unchanged

    func testASeatsStateIsUnchanged() throws {
        let s = try T.state(fixture: "bidding-mid")
        XCTAssertNil(s.table.viewer.shoulder)
        XCTAssertEqual(s.table.watch, HandWatch())
        XCTAssertEqual(s.table.viewer.viewPosition, 4)
        XCTAssertEqual(s.table.viewer.watchedSeat, nil)
        var live = TableState()
        TableReducer.reduce(&live, .local(.identity(username: "ned", playerId: "sid-ned")))
        let fx = TableReducer.reduce(&live, .snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertEqual(watches(fx), [], "a seat never sends watchHand")
        XCTAssertEqual(live.table.hand.count, 12)
        // a stray gameStart.shoulder to a seat changes nothing (never sent to one)
        var seat = T.dealtState()
        let before = seat.table.hand
        TableReducer.reduce(&seat, T.ev("gameStart", [
            "gameId": "g1", "hand": [T.card("spades", "2")], "trump": T.card("clubs", "5"), "score1": 0, "score2": 0, "dealer": 1,
            "position": 1, "currentHand": 1, "seq": 3, "shoulder": ["position": 2, "hand": cards(1), "hsi": 1.0] as [String: Any],
        ]))
        XCTAssertNil(seat.table.viewer.shoulder)
        XCTAssertEqual(seat.table.hand, [T.c("spades", "2")])
        XCTAssertNotEqual(seat.table.hand, before)
        XCTAssertEqual(ShoulderRules.tap(seat, position: 2), .profile, "a seat's avatar tap opens a profile, as before")
        XCTAssertEqual(watches(TableReducer.reduce(&seat, .local(.watchSeat(2)))), [])
        XCTAssertEqual(watches(TableReducer.reduce(&seat, .local(.watchTableView))), [])
    }

    func testAPlainSpectatorsTableIsUnchangedUntilTheServerServesAHand() throws {
        let (s, _) = try joined()
        let m = TableRenderModel(s)
        XCTAssertTrue(m.isSpectator)
        XCTAssertEqual(m.opponents.map(\.position), [1, 2, 3, 4])
        XCTAssertNil(m.hand)
        XCTAssertEqual(m.viewPosition, 1)
        XCTAssertNil(m.watchedSeat)
        XCTAssertEqual(s.table.hand, [])
        // a lazy watcher is not a spectator: it never sends watchHand
        var lazy = TableState()
        TableReducer.reduce(&lazy, .local(.identity(username: "x", playerId: "sid-x")))
        let fx = TableReducer.reduce(&lazy, .snapshot(try T.snapshot("lazy-watcher"), .rejoin, hints: nil))
        XCTAssertEqual(watches(fx), [])
        XCTAssertNil(lazy.table.viewer.watchedSeat)
    }

    // MARK: - Nothing a watcher does can act

    func testAWatcherCanNeverBidPlayAskOrToggleTheTutorial() throws {
        let h = ReplayHarness()
        _ = h.actions  // the coordinator sends what the store asks for
        h.store.apply(.local(.identity(username: "viewer", playerId: "sid-viewer")))
        var raw = try snapDict("bidding-mid") { r in
            var v = r["viewer"] as! [String: Any]
            v["role"] = "spectator"; v["position"] = NSNull(); v["canAct"] = false; v["ownerView"] = NSNull()
            v.removeValue(forKey: "assist")
            r["viewer"] = v; r["hand"] = NSNull(); r["hsi"] = NSNull()
        }
        h.store.apply(.snapshot(try decode(raw), .spectate, hints: nil))
        XCTAssertEqual(h.emitter.sent, [.watch(h.store.gameId ?? "", 1)], "the default watch went out through the coordinator")
        h.emitter.sent = []
        // the watched seat (4) is the bidder: watching it, on "its" bid turn
        h.store.apply(.local(.watchSeat(4)))
        XCTAssertEqual(h.emitter.sent, [.watch(h.store.gameId ?? "", 4)])
        h.emitter.sent = []
        var v = raw["viewer"] as! [String: Any]
        v["shoulder"] = ["position": 4, "hand": cards(12), "hsi": 100.0] as [String: Any]
        raw["viewer"] = v
        raw["partial"] = ["log"]
        h.store.apply(serverEvent: "stateSnapshot", payload: [["snapshot": raw, "reason": "watchHand"]])
        XCTAssertEqual(h.store.watchedSeat, 4)
        XCTAssertEqual(h.store.currentTurn, 4)
        // the tutorial and a /help answer for the watched seat, as the server mirrors them
        h.store.apply(watchedHint())
        h.store.apply(watchedHint("tip", source: "tutorial", tipId: "T.bid"))
        XCTAssertNotNil(h.store.watchedAdvice)
        XCTAssertNotNil(h.store.watchedTip)

        let card = try XCTUnwrap(h.store.myCards.first)
        XCTAssertFalse(h.actions.bid("2"))
        XCTAssertFalse(h.actions.play(card))
        XCTAssertFalse(h.actions.askHelp(connected: true))
        XCTAssertFalse(h.actions.tutorialOn(connected: true))
        XCTAssertFalse(h.actions.tutorialOff(connected: true))
        // the reducer refuses a submission from anyone but my own seat too
        h.store.apply(.local(.submitBid("2", reqId: 9)))
        h.store.apply(.local(.submitPlay(card, reqId: 10)))
        XCTAssertNil(h.store.state.pending)
        XCTAssertFalse(h.store.showsAssistAsk)
        XCTAssertFalse(h.store.showsAssistBarItem, "no lightbulb or tutorial switch (the Duo's vertical bar included)")
        XCTAssertFalse(h.store.showsTutorialChip)
        XCTAssertNil(h.store.tutorialTip)
        XCTAssertNil(h.store.assistHint)
        XCTAssertTrue(h.store.isReadOnly)

        // the scene: the hand's sprites take no touch and no VoiceOver activation; a card tap
        // (and a lifted card's second tap) plays nothing
        let scene = GameSKScene(size: CGSize(width: 466, height: 678))
        scene.animator = InstantAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(x: 0, y: 0, width: 466, height: 678)))
        XCTAssertEqual(scene.handNode.sprites.count, 12)
        for sprite in scene.handNode.sprites.values {
            XCTAssertFalse(sprite.isUserInteractionEnabled, "\(sprite.card.id)")
            XCTAssertFalse(sprite.accessibilityActivate(), "VoiceOver's double tap does nothing")
            XCTAssertTrue(sprite.isLegal, "bright")
            XCTAssertEqual(sprite.accessibilityTraits, .none, "read as the card, not a button")
        }
        scene.cardManager.handleCardPlay(card)
        scene.cardManager.handleCardPlay(card)
        XCTAssertNil(scene.handNode.liftedCardId)
        XCTAssertEqual(h.emitter.sent, [], "no bid, play, chat (/help, /tutorial) or snapshot went out")

        // a tap on another avatar switches seats (watchHand), a tap on a seat's avatar opens a
        // profile only where watching is not allowed
        var names: [String] = []
        let sub = SeatTaps.subject.sink { names.append($0) }
        scene.seatTapped(position: 2, name: "max")
        XCTAssertEqual(h.emitter.sent, [.watch(h.store.gameId ?? "", 2)])
        XCTAssertEqual(names, [])
        h.emitter.sent = []
        sub.cancel()
    }

    func testTheWatchedPlayersChatBubbleShowsAtTheBottomSeat() throws {
        // a seat never sees its own line in a bubble (the log has it); a watcher's bottom seat is
        // the watched player's, whose lines show where a seated player's partner would see them
        let h = ReplayHarness()
        h.store.apply(.local(.identity(username: "viewer", playerId: "sid-viewer")))
        let raw = try snapDict { r in
            var v = r["viewer"] as! [String: Any]
            v["role"] = "spectator"; v["position"] = NSNull(); v["canAct"] = false; v["ownerView"] = NSNull()
            v.removeValue(forKey: "assist")
            v["shoulder"] = ["position": 1, "hand": self.cards(12), "hsi": 120.0] as [String: Any]
            r["viewer"] = v; r["hand"] = NSNull(); r["hsi"] = NSNull()
        }
        h.store.apply(serverEvent: "stateSnapshot", payload: [["snapshot": raw, "requestId": "gap-1"]])
        XCTAssertEqual(h.store.watchedSeat, 1)
        let size = CGSize(width: 466, height: 678)
        let scene = GameSKScene(size: size)
        scene.animator = HoldingAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        func say(_ pos: Int, _ name: String, _ text: String) {
            h.store.apply(T.ev("chatMessage", ["username": name, "message": text, "position": pos, "type": "player",
                                               "seq": (h.store.state.sync.lastSeq ?? 0) + 1]))
        }
        say(1, "ivy", "nice hand")
        let bubble = try XCTUnwrap(scene.transientLayer.childNode(withName: "chat.1"), "the watched player's bubble")
        let layout = scene.layout
        XCTAssertEqual(bubble.position.x, layout.chatPosition(.bottom, bubbleSize: bubble.calculateAccumulatedFrame().size).x, accuracy: 1,
                       "at the bottom seat's spot")
        XCTAssertLessThan(bubble.position.y, layout.seatAnchor(.left).y, "below the side seats: the bottom seat's")
        say(3, "hal", "gl")
        XCTAssertNotNil(scene.transientLayer.childNode(withName: "chat.3"), "the other seats' as before")
    }

    func testASeatsAvatarTapStillOpensTheProfile() throws {
        let h = ReplayHarness()
        _ = h.actions  // the coordinator sends what the store asks for
        h.store.apply(.local(.identity(username: "ned", playerId: "sid-ned")))
        h.store.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        let scene = GameSKScene(size: CGSize(width: 466, height: 678))
        scene.configure(gameState: h.store, actions: h.actions)
        var names: [String] = []
        let sub = SeatTaps.subject.sink { names.append($0) }
        scene.seatTapped(position: 2, name: "max")
        XCTAssertEqual(names, ["max"])
        XCTAssertEqual(h.emitter.sent, [])
        sub.cancel()
    }

    // MARK: - The watcher's own mic: above the eye, never in the watched seat's row

    func testTheWatchersMicSpotKeepsClearOnEveryDevice() {
        for (name, size, chrome, _, _) in SeatExtrasTests.devices {
            // a watcher's table always has a pill at the bottom
            var c = chrome
            if c.bottomBar == 0 { c.bottomBar = 54 }
            let L = TableLayout(size: size, chrome: c)
            guard !L.isDegraded else { continue }
            for bidding in [true, false] {
                let tag = "\(name) \(bidding ? "bidding" : "playing")"
                let mic = L.watcherVoiceSpot(bidding: bidding)
                let badge = L.spectatorBadge(spectating: false, watching: true, bidding: bidding)
                let o = { (a: CGRect, b: CGRect) in TableLayout.overlaps(a, b) }
                // one cluster: the mic directly above the eye, centred, the layout's gap between
                XCTAssertEqual(mic.midX, badge.midX, accuracy: 0.01, "\(tag): centred on the eye")
                XCTAssertEqual(mic.minY - badge.maxY, TableLayout.gap, accuracy: 0.01, "\(tag): right above the eye")
                // (an SE-size pane bidding under a two-line score bar has no clear spot: the
                // cluster may cover a seat's card backs there, nothing else)
                let problems = L.watcherClusterProblems(bidding: bidding)
                if size.height <= 667 {
                    XCTAssertEqual(problems.filter { !$0.hasPrefix("fan.") }, [], "\(tag): the cluster covers something")
                } else {
                    XCTAssertEqual(problems, [], "\(tag): the cluster covers something")
                }
                for part in [mic, badge] {
                    if bidding { XCTAssertFalse(o(part, L.bidBand), "\(tag): under the read-only bid sheet") }
                    XCTAssertFalse(o(part, L.seatRow.content), "\(tag): in the watched seat's row")
                    XCTAssertGreaterThanOrEqual(part.minY, L.liftTop - 0.01, "\(tag): on the hand")
                    XCTAssertTrue(L.safeRect.insetBy(dx: -0.5, dy: -0.5).contains(part), "\(tag): outside the safe area")
                    XCTAssertLessThanOrEqual(part.maxY, L.topLimit + 0.01, "\(tag): under the score bar")
                    for r in [Positions.RelativePosition.top, .left, .right] {
                        XCTAssertFalse(o(part, L.seatFootprint(r)), "\(tag): on the \(r) seat")
                        XCTAssertFalse(o(part, L.bubbleRect(r)), "\(tag): on the \(r) seat's bid bubble")
                        if !bidding { XCTAssertFalse(o(part, L.trickRect(r)), "\(tag): on the \(r) trick card") }
                    }
                }
            }
        }
        // a seat's and a plain spectator's badge are unchanged
        let (_, size, chrome, _, _) = SeatExtrasTests.devices[0]
        let L = TableLayout(size: size, chrome: chrome)
        XCTAssertEqual(L.spectatorBadge(spectating: false, watching: false, bidding: true), L.spectatorBadge(spectating: false))
        XCTAssertEqual(L.spectatorBadge(spectating: true, watching: true, bidding: false), L.spectatorBadge(spectating: true))
    }

    // MARK: - The watcher's GameState accessors

    func testOnlyASeatOwnerIsOfferedReplaceWithBot() throws {
        // the server refuses a non-player's forceResign ("Not a player in this game"), so a
        // spectator, a watcher too, never sees Replace with Bot; the seat owner does
        func offer(role: String, me: String, shoulder: Int? = nil) throws -> (ResignationOffer?, ResignationOffer?, Bool) {
            let h = ReplayHarness()
            h.store.apply(.local(.identity(username: me, playerId: "sid-\(me)")))
            let raw = try snapDict("bidding-mid") { r in
                var v = r["viewer"] as! [String: Any]
                if role == "spectator" {
                    v["role"] = "spectator"; v["position"] = NSNull(); v["canAct"] = false; v["ownerView"] = NSNull()
                    v.removeValue(forKey: "assist")
                    if let shoulder { v["shoulder"] = ["position": shoulder, "hand": self.cards(12), "hsi": 120.0] as [String: Any] }
                    r["hand"] = NSNull(); r["hsi"] = NSNull()
                }
                r["viewer"] = v
            }
            h.store.apply(serverEvent: "stateSnapshot", payload: [["snapshot": raw, "requestId": "gap-1"]])
            h.store.apply(serverEvent: "resignationAvailable", payload: [["position": 3, "username": "pat", "idle": true]])
            return (h.store.players.resignationOffer, h.store.resignationOffer, h.store.showsPresenceBanner)
        }
        let seat = try offer(role: "seat", me: "ned")
        XCTAssertEqual(seat.1, ResignationOffer(position: 3, username: "pat", idle: true), "my table: Replace with Bot")
        XCTAssertTrue(seat.2)
        for (label, shoulder) in [("a plain spectator", nil), ("a watcher", 4)] as [(String, Int?)] {
            let o = try offer(role: "spectator", me: "viewer", shoulder: shoulder)
            XCTAssertNotNil(o.0, "\(label): the offer is still known")
            XCTAssertNil(o.1, "\(label): never offered")
            XCTAssertFalse(o.2, "\(label): an idle seat shows no banner")
        }
    }

    func testTheStoresAccessorsForTheViews() throws {
        let h = ReplayHarness()
        _ = h.actions  // the coordinator sends what the store asks for
        h.store.apply(.local(.identity(username: "viewer", playerId: "sid-viewer")))
        var raw = try snapDict("bidding-mid") { r in
            var v = r["viewer"] as! [String: Any]
            v["role"] = "spectator"; v["position"] = NSNull(); v["canAct"] = false; v["ownerView"] = NSNull()
            v.removeValue(forKey: "assist")
            v["shoulder"] = ["position": 4, "hand": self.cards(12), "hsi": 133.25] as [String: Any]
            r["viewer"] = v; r["hand"] = NSNull(); r["hsi"] = NSNull(); r["partial"] = ["log"]
        }
        h.store.apply(serverEvent: "stateSnapshot", payload: [["snapshot": raw, "reason": "watchHand"]])
        XCTAssertEqual(h.store.watchedName, "ned")
        XCTAssertFalse(h.store.isPlainSpectator)
        XCTAssertEqual(h.store.myHSIReading, .value(133.25), "the watched seat's HSI in my seat's row")
        XCTAssertEqual(h.store.viewPosition, 4)
        // the score bar's sides read from the watched seat: ned's team first
        let sides = ScoreBarView.viewerTeams(position: h.store.watchedSeat ?? h.store.position, spectator: h.store.isPlainSpectator,
                                             usernames: h.store.players.seats.compactMapValues(\.username))
        XCTAssertEqual(sides.team?.joined, "ned/max")
        // the watched seat's clock (a running bidClock for seat 4)
        h.store.clockNow = { 100 }
        h.store.apply(serverEvent: "bidClock", payload: [["gameId": h.store.gameId ?? "", "position": 4, "running": true,
                                                          "inMs": 23_750, "durationMs": 30_000]])
        let c = try XCTUnwrap(h.store.watchedBidCountdown)
        XCTAssertEqual(BidCountdownModel.display(c, mine: true, now: 100), .seconds(23, low: false))
        // paused: no HSI, no clock, no tip
        h.store.apply(serverEvent: "gameLogEntry", payload: [["message": ShoulderRules.pauseLine, "type": "system",
                                                              "seq": (h.store.state.sync.lastSeq ?? 0) + 1]])
        XCTAssertTrue(h.store.watchPaused)
        XCTAssertNil(h.store.myHSIReading)
        XCTAssertNil(h.store.watchedBidCountdown)
        raw["seq"] = 0
    }
}
