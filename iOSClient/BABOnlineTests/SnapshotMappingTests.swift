import XCTest
@testable import BAB_Online

/// state(from: snapshot) per contract fixture (R5).
final class SnapshotMappingTests: XCTestCase {
    func testTrickMidLead3KeepsPlayOrder() throws {
        let s = try T.state(fixture: "trick-mid-lead3")
        guard case .playing(let p) = s.table.phase else { return XCTFail("\(s.table.phase.kind)") }
        XCTAssertEqual(p.lead, 3)
        XCTAssertEqual(p.trick.map(\.position), [3, 4])
        XCTAssertEqual(s.myTurn, .choosing(.play))
        XCTAssertEqual(s.table.trickNo, 1)
    }

    func testPresenceMixedDerivesDisconnected() throws {
        let s = try T.state(fixture: "presence-mixed")
        XCTAssertEqual(s.players.disconnected, [1: "sid", 2: "quin"])
        XCTAssertEqual(s.players.resignationOffer?.position, 1)
        XCTAssertEqual(s.players.seats[3]?.controller, .lazyBot)
    }

    func testLazyViewersAreReadOnlyWithAHand() throws {
        for name in ["lazy-at-seat", "lazy-watcher"] {
            let s = try T.state(fixture: name)
            XCTAssertEqual(s.table.viewer.role, .lazyWatcher, name)
            XCTAssertTrue(s.isReadOnly, name)
            XCTAssertFalse(s.table.hand.isEmpty, name)
            XCTAssertEqual(s.myTurn, .waiting, name)
            XCTAssertNotNil(TableRenderModel(s).hand, name)
        }
    }

    func testSpectatorMidHand() throws {
        let s = try T.state(fixture: "spectator-mid-hand")
        XCTAssertEqual(s.table.viewer.role, .spectator)
        XCTAssertEqual(s.table.viewer.viewPosition, 1)
        XCTAssertTrue(s.table.hand.isEmpty)
        let m = TableRenderModel(s)
        XCTAssertNil(m.hand)
        XCTAssertEqual(m.opponents.map(\.position), [1, 2, 3, 4])
    }

    func testTeamsAnnouncedIsADrawStage() throws {
        let s = try T.state(fixture: "teams-announced")
        guard case .draw(let d) = s.table.phase else { return XCTFail("\(s.table.phase.kind)") }
        XCTAssertEqual(d.stage, .teamsAnnounced)
        XCTAssertEqual(d.teams?.team1.count, 2)
        XCTAssertNil(s.table.deal)
    }

    func testHandResolvingShowsNoBidOverlay() throws {
        let s = try T.state(fixture: "hand-resolving")
        XCTAssertEqual(s.table.phase.kind, .handResolving)
        XCTAssertFalse(s.table.phase.isBidding)
        XCTAssertEqual(s.myTurn, .waiting)
        XCTAssertTrue(s.table.phase.showsTable)
    }

    func testTrickResolvingHasFourCardsAndNoTurn() throws {
        let s = try T.state(fixture: "trick-resolving")
        XCTAssertEqual(s.table.phase.trick.count, 4)
        XCTAssertNil(s.table.phase.turn)
    }

    func testActionRejectedKeepsThePriorLog() throws {
        var prev = try T.state(fixture: "trick-mid-lead3")
        prev.log.entries.append(ChatMessage(username: "x", message: "keep me"))
        let next = try T.state(fixture: "action-rejected", previous: prev, source: .rejected)
        XCTAssertEqual(next.log.entries.map(\.message), prev.log.entries.map(\.message))
        // another game: the (empty) snapshot log wins
        prev.table.gameId = "other"
        XCTAssertEqual(try T.state(fixture: "action-rejected", previous: prev, source: .rejected).log.entries, [])
    }

    func testCustomPicsAreKeptForPartialSnapshots() throws {
        let full = try T.state(fixture: "trick-mid-lead3")
        let customSeat = try XCTUnwrap(full.players.seats.values.first { if case .custom = $0.pic { return true }; return false })
        let partial = try T.snapshot("trick-mid-lead3") { raw in
            raw["partial"] = ["customPics"]
            var seats = raw["seats"] as! [[String: Any]]
            for i in seats.indices where seats[i]["hasCustomPic"] as? Bool == true { seats[i]["customPic"] = NSNull() }
            raw["seats"] = seats
        }
        let kept = TableReducer.state(from: partial, hints: nil, previous: full, source: .requested("gap-1"))
        XCTAssertEqual(kept.players.seats[customSeat.position]?.pic, customSeat.pic)
        // cold start (nothing held): the v1 payload's players[].pic
        let hinted = TableReducer.state(from: partial, hints: LegacySeatHints(pics: [customSeat.position: .custom("data:x")]), previous: nil, source: .rejoin)
        XCTAssertEqual(hinted.players.seats[customSeat.position]?.pic, .custom("data:x"))
    }

    func testApplyingToADirtyStateEqualsAFreshState() throws {
        for name in try FixtureLoader.v2Names() {
            let snap = try T.snapshot(name)
            var dirty = T.dealtState()
            dirty.table.gameId = "some-other-game"
            dirty.log.entries.append(ChatMessage(username: "x", message: "old"))
            TableReducer.reduce(&dirty, .snapshot(snap, .requested("x"), hints: nil))
            let fresh = TableReducer.state(from: snap, hints: nil, previous: nil, source: .requested("x"))
            XCTAssertEqual(dirty.table.gameId, fresh.table.gameId, name)
            var a = dirty.table, b = fresh.table
            a.me = Identity(); b.me = Identity()
            XCTAssertEqual(a, b, name)
            XCTAssertEqual(dirty.scores, fresh.scores, name)
            XCTAssertEqual(dirty.players, fresh.players, name)
            XCTAssertEqual(dirty.log.entries.map(\.message), fresh.log.entries.map(\.message), name)
            XCTAssertEqual(dirty.sync.lastSeq, snap.seq, name)
        }
    }

    func testRainbowsComeFromTheSnapshot() throws {
        let snap = try T.snapshot("between-tricks") { $0["rainbows"] = ["team1": 1, "team2": 2] }
        let s = TableReducer.state(from: snap, hints: nil, previous: nil, source: .rejoin)
        XCTAssertEqual(s.scores.rainbows, TeamPair(team1: 1, team2: 2))
    }
}
