import AVFoundation
import Combine
import XCTest
@testable import BAB_Online

/// The bid clock (owner 2026-11-18; contract/README.md "Bid clock", docs/ios-table-store.md
/// "Bid clock"): the unsequenced event's decoding and routing, the reducer's set / clear
/// rules and tune cues, the store's deadline, the tune controller (end-aligned, drift
/// tolerance, the timeout's ringing tail, sound and app state), SoundPlayer's tune gating,
/// the countdown model, the contract fixture, and the recorded game events-bidclock-s16.
@MainActor
final class BidClockTests: XCTestCase {
    static let gid = "g1"

    private func running(_ pos: Int, inMs: Int = 30000, durationMs: Int = 30000, gameId: String = BidClockTests.gid) -> TableEvent {
        T.ev("bidClock", ["gameId": gameId, "position": pos, "running": true, "inMs": inMs, "durationMs": durationMs])
    }

    private func stopped(_ pos: Int, _ reason: String, gameId: String = BidClockTests.gid) -> TableEvent {
        T.ev("bidClock", ["gameId": gameId, "position": pos, "running": false, "reason": reason])
    }

    private func cues(_ fx: [TableEffect]) -> [BidClockCue] {
        fx.compactMap { if case .bidClock(let c) = $0 { return c } else { return nil } }
    }

    /// Seat 1 ("me") dealt, my bid turn open.
    private func myTurn() -> TableState {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        return s
    }

    // MARK: - Wire

    func testBothVariantsDecodeAndAnUnknownReasonIsKept() throws {
        let run = try XCTUnwrap(try? ServerEvent.decode(name: "bidClock", payload: [[
            "gameId": "g1", "position": 2, "running": true, "inMs": 29990, "durationMs": 30000,
        ] as [String: Any]], strict: true).get())
        XCTAssertNil(run.seq)
        XCTAssertEqual(run.event, .bidClock(WirePayload.BidClock(gameId: "g1", position: 2, running: true, inMs: 29990, durationMs: 30000, reason: nil)))
        for (raw, reason) in [("bid", WirePayload.BidClock.Reason.bid), ("timeout", .timeout), ("turn", .turn), ("controller", .controller),
                              ("sleepy", .unknown("sleepy"))] {
            let stop = try ServerEvent.decode(name: "bidClock", payload: [["gameId": "g1", "position": 2, "running": false, "reason": raw] as [String: Any]]).get()
            guard case .bidClock(let p) = stop.event else { return XCTFail("\(stop.event)") }
            XCTAssertEqual(p.reason, reason)
            XCTAssertFalse(p.running)
        }
        // a seq on the payload (a future server) is still never gated
        let seqd = try ServerEvent.decode(name: "bidClock", payload: [["gameId": "g1", "position": 2, "running": false, "reason": "bid", "seq": 9] as [String: Any]]).get()
        XCTAssertNil(seqd.seq)
        // no position: a decode failure (resync), never a crash
        if case .success = ServerEvent.decode(name: "bidClock", payload: [["gameId": "g1", "running": true] as [String: Any]]) { XCTFail("no position") }
    }

    func testTheHandlerRegistersItAroundTheSeqGate() {
        XCTAssertTrue(GameSocketHandler.events.contains(SocketEvents.Server.bidClock))
        XCTAssertFalse(ContractSeq.events.contains("bidClock"))
        var s = myTurn()
        XCTAssertEqual(s.sync.lastSeq, 3)
        let fx = TableReducer.reduce(&s, running(1))
        XCTAssertEqual(s.sync.lastSeq, 3, "unsequenced: lastSeq unchanged")
        XCTAssertFalse(fx.contains { if case .gap = $0 { return true }; if case .dropped = $0 { return true }; return false })
        // the next room event (seq 4) applies: no gap was opened
        let next = TableReducer.reduce(&s, T.ev("gameLogEntry", ["message": "x", "type": "system", "seq": 4]))
        XCTAssertFalse(next.contains { if case .gap = $0 { return true } else { return false } })
        XCTAssertEqual(s.sync.lastSeq, 4)
        XCTAssertEqual(s.sync.buffered, [])
    }

    // MARK: - Reducer

    func testRunningSetsTheClockAndSyncsTheTune() {
        var s = myTurn()
        XCTAssertEqual(cues(TableReducer.reduce(&s, running(1, inMs: 29990))), [.sync])
        XCTAssertEqual(s.table.bidClock, BidClockState(position: 1, inMs: 29990, durationMs: 30000))
        XCTAssertTrue(s.table.bidTuneLive)
        XCTAssertEqual(s.myTurn, .choosing(.bid), "the clock changes nothing about my choice")
        // restated (a resume after /active): sync again, the new times
        XCTAssertEqual(cues(TableReducer.reduce(&s, running(1, inMs: 10000))), [.sync])
        XCTAssertEqual(s.table.bidClock?.inMs, 10000)
    }

    func testAnotherGamesOrAnUnusableClockIsIgnored() {
        var s = myTurn()
        XCTAssertEqual(TableReducer.reduce(&s, running(1, gameId: "other")), [])
        XCTAssertEqual(TableReducer.reduce(&s, T.ev("bidClock", ["gameId": BidClockTests.gid, "position": 1, "running": true])), [], "no times")
        XCTAssertEqual(TableReducer.reduce(&s, T.ev("bidClock", ["gameId": BidClockTests.gid, "position": 7, "running": true, "inMs": 1, "durationMs": 1])), [])
        XCTAssertNil(s.table.bidClock)
        // not bidding (the play): a stale running is dropped
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 2, "seq": 4]))
        XCTAssertEqual(TableReducer.reduce(&s, running(2)), [])
        XCTAssertNil(s.table.bidClock)
    }

    func testStoppedFadesExceptTheTimeoutWhichRingsAndTellsTheBidder() {
        var s = myTurn()
        TableReducer.reduce(&s, running(1))
        XCTAssertEqual(cues(TableReducer.reduce(&s, stopped(1, "bid"))), [.stop(.fade)])
        XCTAssertNil(s.table.bidClock)
        XCTAssertEqual(TableReducer.reduce(&s, stopped(1, "bid")), [], "nothing left to stop")

        TableReducer.reduce(&s, running(1))
        let fx = TableReducer.reduce(&s, stopped(1, "timeout"))
        XCTAssertEqual(cues(fx), [.stop(.ring)])
        XCTAssertTrue(fx.contains(.infoNotice("Time ran out: you bid 0")), "\(fx)")
        XCTAssertFalse(fx.contains { if case .notice = $0 { return true } else { return false } }, "news, not a refusal")
        // the bid 0 and the next turn that follow do not cut the ringing tail (C3)
        XCTAssertEqual(cues(TableReducer.reduce(&s, T.ev("gameLogEntry", ["message": "me ran out of time.", "type": "system", "seq": 4]))), [])
        XCTAssertEqual(cues(TableReducer.reduce(&s, T.ev("bidReceived", ["position": 1, "bid": "0", "bidArray": ["0", nil, nil, nil], "seq": 5]))), [])
        XCTAssertEqual(cues(TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 6]))), [])
        // but the game's end does
        XCTAssertTrue(s.table.bidTuneLive)
        XCTAssertEqual(cues(TableReducer.reduce(&s, T.ev("gameEnd", ["score": ["team1": 1, "team2": 0], "tournamentId": NSNull(), "seq": 7]))), [.stop(.hard)])
        XCTAssertFalse(s.table.bidTuneLive)
    }

    func testOnlyTheBidderHearsOfTheirTimeout() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 3]))
        TableReducer.reduce(&s, running(2))
        let fx = TableReducer.reduce(&s, stopped(2, "timeout"))
        XCTAssertEqual(cues(fx), [.stop(.ring)])
        XCTAssertFalse(fx.contains { if case .infoNotice = $0 { return true } else { return false } })
        // an unknown reason fades, as `turn`
        TableReducer.reduce(&s, running(2))
        XCTAssertEqual(cues(TableReducer.reduce(&s, stopped(2, "sleepy"))), [.stop(.fade)])
        // a stop for a seat whose clock this table does not run changes nothing
        TableReducer.reduce(&s, running(2))
        XCTAssertEqual(cues(TableReducer.reduce(&s, stopped(3, "bid"))), [])
        XCTAssertEqual(s.table.bidClock?.position, 2)
    }

    func testEverySequencedClearingEventEndsTheClock() {
        typealias Make = (inout Int) -> TableEvent
        let cases: [(String, Make, BidTuneStop)] = [
            ("bidReceived for the seat", { seq in seq += 1; return T.ev("bidReceived", ["position": 1, "bid": "2", "bidArray": ["2", nil, nil, nil], "seq": seq]) }, .fade),
            ("updateTurn to another seat", { seq in seq += 1; return T.ev("updateTurn", ["currentTurn": 2, "seq": seq]) }, .fade),
            ("doneBidding", { seq in seq += 1; return T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 2, "seq": seq]) }, .fade),
            ("destroyHands", { seq in seq += 1; return T.ev("destroyHands", ["seq": seq]) }, .fade),
            ("gameStart", { seq in seq += 1; return T.ev("gameStart", ["gameId": BidClockTests.gid, "hand": [T.card("spades", "A")], "trump": T.card("diamonds", "5"),
                                                                     "score1": 0, "score2": 0, "dealer": 1, "position": 1, "currentHand": 1, "seq": seq]) }, .fade),
            ("gameEnd", { seq in seq += 1; return T.ev("gameEnd", ["score": ["team1": 1, "team2": 0], "tournamentId": NSNull(), "seq": seq]) }, .hard),
            ("abortGame", { seq in seq += 1; return T.ev("abortGame", ["seq": seq]) }, .hard),
            ("leftGame", { _ in T.ev("leftGame", [:]) }, .hard),
            ("my socket dropped", { _ in .local(.connectionLost) }, .hard),
            ("a reset", { _ in .local(.reset) }, .hard),
            ("another game's context", { _ in .local(.enterGameContext(gameId: "g2", tournamentId: nil)) }, .hard),
        ]
        for (name, make, kind) in cases {
            var s = myTurn()
            TableReducer.reduce(&s, running(1))
            var seq = 3
            let fx = TableReducer.reduce(&s, make(&seq))
            XCTAssertEqual(cues(fx), [.stop(kind)], name)
            XCTAssertNil(s.table.bidClock, name)
        }
        // not cleared: another seat's bid, an updateTurn to the clock's own seat
        var s = myTurn()
        TableReducer.reduce(&s, running(1))
        XCTAssertEqual(cues(TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 4]))), [])
        XCTAssertEqual(cues(TableReducer.reduce(&s, T.ev("gameLogEntry", ["message": "x", "type": "system", "seq": 5]))), [])
        XCTAssertNotNil(s.table.bidClock)
        // a reset with nothing ever played sends nothing
        var quiet = myTurn()
        XCTAssertEqual(cues(TableReducer.reduce(&quiet, .local(.reset))), [])
        XCTAssertEqual(cues(TableReducer.reduce(&quiet, .local(.connectionLost))), [])
    }

    func testClearsReplayedFromAGapBufferStillStopTheTune() throws {
        // C9: a clear that comes back through catch-up must still stop the tune
        var s = myTurn()
        TableReducer.reduce(&s, running(1))
        TableReducer.reduce(&s, T.ev("bidReceived", ["position": 1, "bid": "2", "bidArray": ["2", nil, nil, nil], "seq": 5]))  // a gap (4 missing)
        XCTAssertNotNil(s.table.bidClock, "buffered, not applied")
        var fx: [TableEffect] = []
        TableReducer.flushBuffer(&s, &fx)
        XCTAssertEqual(cues(fx), [.stop(.fade)])
        XCTAssertNil(s.table.bidClock)
    }

    // MARK: - Snapshots

    func testASnapshotCarryingTheClockStartsTheTuneAndOneWithoutEndsIt() throws {
        let snap = try T.snapshot("bid-clock-running")
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "wes", playerId: "sid-wes")))
        XCTAssertEqual(cues(TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))), [.sync], "the documented exception: a snapshot may start the tune")
        XCTAssertEqual(s.table.bidClock, BidClockState(position: 2, inMs: 15000, durationMs: 30000))
        // the same clock restated (a gap resync): sync again, the tune decides it is in place
        XCTAssertEqual(cues(TableReducer.reduce(&s, .snapshot(snap, .requested("gap-1"), hints: nil))), [.sync])
        // the same game without it: the clock is over
        let without = try T.snapshot("bid-clock-running") { $0["bidClock"] = nil }
        XCTAssertEqual(cues(TableReducer.reduce(&s, .snapshot(without, .requested("gap-2"), hints: nil))), [.stop(.fade)])
        XCTAssertNil(s.table.bidClock)
        XCTAssertTrue(s.table.bidTuneLive, "a timeout's tail could still ring")
        // another game's snapshot: everything stops
        let other = try T.snapshot("bidding-mid") { $0["gameId"] = "00000000-0000-4000-8000-0000000000ff" }
        XCTAssertEqual(cues(TableReducer.reduce(&s, .snapshot(other, .rejoin, hints: nil))), [.stop(.hard)])
        XCTAssertFalse(s.table.bidTuneLive)
    }

    func testAnInvalidSnapshotClockIsDroppedNotTheSnapshot() throws {
        for bad in [["position": 9, "inMs": 1000, "durationMs": 30000], ["position": 2, "inMs": -1, "durationMs": 30000],
                    ["position": 2, "inMs": 1000, "durationMs": 0]] {
            let snap = try T.snapshot("bid-clock-running") { $0["bidClock"] = bad }
            var s = TableState()
            let fx = TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))
            XCTAssertEqual(cues(fx), [], "\(bad)")
            XCTAssertNil(s.table.bidClock)
            XCTAssertEqual(s.table.phase.kind, .bidding, "the snapshot applied")
        }
        // a snapshot of another stage never carries one; if it did, it is not shown
        let playing = try T.snapshot("trick-mid-lead3") { $0["bidClock"] = ["position": 2, "inMs": 1000, "durationMs": 30000] }
        var s = TableState()
        TableReducer.reduce(&s, .snapshot(playing, .rejoin, hints: nil))
        XCTAssertNil(s.table.bidClock)
    }

    func testTheContractFixtureDecodes() throws {
        let snap = try TableSnapshot.decode(try FixtureLoader.v2Snapshot("bid-clock-running"), strict: true)
        XCTAssertEqual(snap.bidClock, TableSnapshot.BidClock(position: 2, inMs: 15000, durationMs: 30000))
        // every other fixture leaves it out (present only while the clock runs)
        for name in try FixtureLoader.v2Names() where name != "bid-clock-running" {
            XCTAssertNil(try TableSnapshot.decode(try FixtureLoader.v2Snapshot(name), strict: true).bidClock, name)
        }
    }

    // MARK: - Store

    func testTheStoreMeasuresTheDeadlineFromReceipt() throws {
        let store = GameState()
        var t: TimeInterval = 100
        store.clockNow = { t }
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.local(.enterGameContext(gameId: BidClockTests.gid, tournamentId: nil)))
        _ = store.apply(serverEvent: "positionUpdate", payload: [[
            "positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
            "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1,
        ] as [String: Any]])
        _ = store.apply(serverEvent: "gameStart", payload: [["gameId": BidClockTests.gid, "hand": [T.card("spades", "A")], "trump": T.card("diamonds", "5"),
                                                             "score1": 0, "score2": 0, "dealer": 4, "position": 1, "currentHand": 1, "seq": 2] as [String: Any]])
        _ = store.apply(serverEvent: "updateTurn", payload: [["currentTurn": 1, "seq": 3] as [String: Any]])
        XCTAssertNil(store.bidCountdown)
        _ = store.apply(serverEvent: "bidClock", payload: [["gameId": BidClockTests.gid, "position": 1, "running": true, "inMs": 29990, "durationMs": 30000] as [String: Any]])
        XCTAssertEqual(store.bidCountdown?.position, 1)
        XCTAssertEqual(store.bidCountdown?.durationMs, 30000)
        XCTAssertEqual(try XCTUnwrap(store.bidCountdown?.deadline), 129.99, accuracy: 1e-9)
        // an unrelated event later keeps the deadline (not re-measured)
        t = 110
        _ = store.apply(serverEvent: "gameLogEntry", payload: [["message": "x", "type": "system", "seq": 4] as [String: Any]])
        XCTAssertEqual(try XCTUnwrap(store.bidCountdown?.deadline), 129.99, accuracy: 1e-9)
        // a restated clock is measured again from its own receipt
        _ = store.apply(serverEvent: "bidClock", payload: [["gameId": BidClockTests.gid, "position": 1, "running": true, "inMs": 10000, "durationMs": 30000] as [String: Any]])
        XCTAssertEqual(store.bidCountdown?.deadline, 120)
        // the timeout: gone, and the bidder's info toast
        _ = store.apply(serverEvent: "bidClock", payload: [["gameId": BidClockTests.gid, "position": 1, "running": false, "reason": "timeout"] as [String: Any]])
        XCTAssertNil(store.bidCountdown)
        XCTAssertEqual(store.notice?.text, "Time ran out: you bid 0")
        XCTAssertEqual(store.notice?.info, true)
    }

    // MARK: - Countdown model

    func testTheCountdownShowsWholeSecondsAheadOfTheDeadline() {
        let c = BidCountdown(position: 1, deadline: 100, durationMs: 30000)
        typealias D = BidCountdownModel.Display
        // 30 s from receipt: shown 0.75 s early, so 29.25 s -> "30"
        XCTAssertEqual(BidCountdownModel.display(c, mine: true, now: 70), D.seconds(30, low: false))
        XCTAssertEqual(BidCountdownModel.display(c, mine: true, now: 72.3), D.seconds(27, low: false))
        XCTAssertEqual(BidCountdownModel.display(c, mine: true, now: 88.25), D.seconds(11, low: false))
        XCTAssertEqual(BidCountdownModel.display(c, mine: true, now: 88.26), D.seconds(11, low: false))
        XCTAssertEqual(BidCountdownModel.display(c, mine: true, now: 89.25), D.seconds(10, low: true))
        XCTAssertEqual(BidCountdownModel.display(c, mine: true, now: 99.2), D.seconds(1, low: true))
        // at the margin: no number, the buttons refuse until the bid 0 lands
        XCTAssertEqual(BidCountdownModel.display(c, mine: true, now: 99.25), D.expired)
        XCTAssertEqual(BidCountdownModel.display(c, mine: true, now: 104.2), D.expired)
        // nothing came within the grace: bidding opens again
        XCTAssertEqual(BidCountdownModel.display(c, mine: true, now: 104.25), D.hidden)
        // never for someone else's clock / choice, never past the clock's own length
        XCTAssertEqual(BidCountdownModel.display(c, mine: false, now: 80), D.hidden)
        XCTAssertEqual(BidCountdownModel.display(nil, mine: true, now: 80), D.hidden)
        XCTAssertEqual(BidCountdownModel.display(BidCountdown(position: 1, deadline: 100, durationMs: 5000), mine: true, now: 50), D.seconds(5, low: true))
        XCTAssertEqual(BidCountdownModel.label(1), "Time to bid: 1 second")
        XCTAssertEqual(BidCountdownModel.label(27), "Time to bid: 27 seconds")
        XCTAssertEqual(BidCountdownModel.announcement(30), "30 seconds to bid")
    }

    func testVoiceOverHearsItTwicePerClock() {
        let c = BidCountdown(position: 1, deadline: 100, durationMs: 30000)
        func said(_ d: BidCountdownModel.Display, _ c: BidCountdown?) -> BidOverlayView.Announcement? {
            BidOverlayView.announcement(d, of: c)
        }
        let first = said(.seconds(30, low: false), c)
        XCTAssertEqual(first?.text, "30 seconds to bid")
        // the next seconds are the same announcement (no onChange): silent
        XCTAssertEqual(said(.seconds(29, low: false), c), first)
        let ten = said(.seconds(10, low: true), c)
        XCTAssertNotEqual(ten, first)
        XCTAssertEqual(ten?.text, "10 seconds to bid")
        XCTAssertEqual(said(.seconds(9, low: true), c), ten)
        // a snapshot restating the clock (rejoin, gap resync, actionRejected) rebuilds its
        // deadline from receipt: within BidCountdownModel.sameClock it is the same clock, silent
        var restated = c
        restated.deadline = 100 + BidCountdownModel.sameClock
        XCTAssertEqual(said(.seconds(9, low: true), restated), ten)
        restated.deadline = 100 - 0.2
        XCTAssertEqual(said(.seconds(9, low: true), restated), ten)
        // a new clock (a resume's top-up) or another seat's is a new announcement
        restated.deadline = 100 + BidCountdownModel.sameClock + 0.01
        XCTAssertNotEqual(said(.seconds(9, low: true), restated), ten)
        XCTAssertNotEqual(said(.seconds(30, low: false), BidCountdown(position: 1, deadline: 200, durationMs: 30000)), first)
        XCTAssertNotEqual(said(.seconds(30, low: false), BidCountdown(position: 3, deadline: 100, durationMs: 30000)), first)
        // none when nothing shows
        XCTAssertNil(said(.expired, c))
        XCTAssertNil(said(.seconds(3, low: true), nil))
    }

    // MARK: - The tune

    private func tune(_ player: FakeTunePlayer, left: @escaping () -> TimeInterval?) -> BidClockTune {
        BidClockTune(player: player, remaining: left)
    }

    func testTheTuneIsEndAlignedAndKeptWhenInPlace() {
        let clock = SoundClock()
        let p = FakeTunePlayer(clock)
        var deadline: TimeInterval? = 30
        let t = tune(p) { deadline.map { $0 - clock.t } }
        t.handle(.sync)
        XCTAssertEqual(p.calls, [.start(30)], "it ends with the clock")
        // a restatement 10 s later with the same deadline: kept
        clock.t = 10
        t.handle(.sync)
        XCTAssertEqual(p.calls, [.start(30)])
        // within 750 ms: kept (no stutter on a gap resync)
        deadline = 30.7
        t.handle(.sync)
        XCTAssertEqual(p.calls, [.start(30)])
        // further off: restarted at its place
        deadline = 32
        t.handle(.sync)
        XCTAssertEqual(p.calls, [.start(30), .start(22)])
        // the clock is over: a fade
        t.handle(.stop(.fade))
        XCTAssertEqual(p.calls.last, .stop(BidClockTune.fade))
        XCTAssertFalse(t.playing)
    }

    func testNotStartedWithUnderASecondLeft() {
        let clock = SoundClock()
        let p = FakeTunePlayer(clock)
        let t = tune(p) { 0.9 }
        t.handle(.sync)
        XCTAssertEqual(p.calls, [])
        let none = tune(p) { nil }
        none.handle(.sync)
        XCTAssertEqual(p.calls, [])
    }

    func testTheTimeoutRingsOutAndOnlyAHardStopOrANewClockCutsIt() {
        let clock = SoundClock()
        let p = FakeTunePlayer(clock)
        var deadline: TimeInterval? = 30
        let t = tune(p) { deadline.map { $0 - clock.t } }
        t.handle(.sync)
        clock.t = 29.9
        deadline = nil
        t.handle(.stop(.ring))
        XCTAssertEqual(p.calls, [.start(30)], "within its last moments: rings")
        XCTAssertTrue(t.ringing)
        // the bid 0's and the turn's fades do not touch it
        t.handle(.stop(.fade))
        t.handle(.sync)
        XCTAssertEqual(p.calls, [.start(30)])
        // the game's end does
        t.handle(.stop(.hard))
        XCTAssertEqual(p.calls, [.start(30), .stop(BidClockTune.fade)])
        XCTAssertFalse(t.ringing)

        // a timeout with more than ringMax left locally (the tune restarted late): cut
        let q = FakeTunePlayer(clock)
        clock.t = 0
        deadline = 30
        let u = tune(q) { deadline.map { $0 - clock.t } }
        u.handle(.sync)
        clock.t = 28
        u.handle(.stop(.ring))
        XCTAssertEqual(q.calls, [.start(30), .stop(BidClockTune.fade)])
        XCTAssertFalse(u.ringing)

        // a ringing tail and a new clock (the next seat's): the tail goes, the new one plays
        let r = FakeTunePlayer(clock)
        clock.t = 0
        deadline = 30
        let v = tune(r) { deadline.map { $0 - clock.t } }
        v.handle(.sync)
        clock.t = 29.5
        v.handle(.stop(.ring))
        deadline = 59.5
        v.handle(.sync)
        XCTAssertEqual(r.calls, [.start(30), .stop(0), .start(30)])
    }

    func testSoundOffOnAndTheBackgroundResync() {
        let clock = SoundClock()
        let p = FakeTunePlayer(clock)
        p.enabled = false
        let t = tune(p) { 30 - clock.t }
        t.handle(.sync)
        XCTAssertEqual(p.calls, [], "muted: refused")
        XCTAssertFalse(t.playing)
        // the sound comes back on 5 s in: picked up at its place
        clock.t = 5
        p.enabled = true
        t.sync()
        XCTAssertEqual(p.calls, [.start(25)])
        // muted mid-tune (SoundPlayer stops the output itself), then on again: restarted at its place
        p.silence()
        clock.t = 12
        t.sync()
        XCTAssertEqual(p.calls, [.start(25), .start(18)])
        // background: stopped at once; active again: back at its place
        t.backgrounded()
        XCTAssertEqual(p.calls.last, .stop(0))
        clock.t = 20
        t.sync()
        XCTAssertEqual(p.calls.last, .start(10))
    }

    func testTheCoordinatorRoutesTheCuesAndAConnectionDrop() {
        let store = GameState()
        let clock = SoundClock()
        store.clockNow = { clock.t }
        let p = FakeTunePlayer(clock)
        let center = NotificationCenter()
        let actions = ActionCoordinator(store: store, emitter: FakeEmitter(), clock: ManualClock(), sounds: RecordingSounds(),
                                        soundClock: ManualClock(), tunePlayer: p, notifications: center)
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.snapshot(try! T.snapshot("bid-clock-running"), .rejoin, hints: nil))
        XCTAssertEqual(p.calls, [.start(15)], "a rejoin snapshot resumes the tune at its place")
        // background / active
        center.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        XCTAssertEqual(p.calls.last, .stop(0))
        clock.t = 5
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertEqual(p.calls.last, .start(10))
        // inactive only (Notification Center, Control Center, the app switcher): silent too
        center.post(name: UIApplication.willResignActiveNotification, object: nil)
        XCTAssertEqual(p.calls.last, .stop(0))
        clock.t = 7
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertEqual(p.calls.last, .start(8))
        // my socket drops: the clock and the tune end (C4)
        let connected = PassthroughSubject<Bool, Never>()
        actions.watchConnection(connected)
        connected.send(true)
        connected.send(false)
        XCTAssertEqual(p.calls.last, .stop(BidClockTune.fade))
        XCTAssertNil(store.bidCountdown)
        XCTAssertNil(store.state.table.bidClock)
    }

    // MARK: - SoundPlayer's tune

    func testSoundPlayerGatesTheTuneLikeASound() {
        let suite = "BidClockTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let out = FakeTuneOutput()
        var active = true
        let session = FakeSession()
        let player = SoundPlayer(output: RecordingOutput(), session: session, tune: out, defaults: defaults,
                                 isAppActive: { active }, isVoiceActive: { false })
        var resyncs = 0
        let sub = player.tuneResync.sink { resyncs += 1 }
        defer { sub.cancel() }
        XCTAssertTrue(player.startTune(endingIn: 20))
        XCTAssertEqual(out.log, ["start 20.0 @0.35"])
        XCTAssertEqual(session.category, .ambient, "the ambient session first, as every sound")
        // volume follows mid-tune; 0 stops it; back up resyncs
        player.volume = 0.5
        XCTAssertEqual(out.log.last, "volume 0.5")
        player.volume = 0
        XCTAssertEqual(out.log.last, "stop 0.12")
        XCTAssertFalse(player.startTune(endingIn: 10), "volume 0")
        player.volume = 0.2
        XCTAssertEqual(resyncs, 1)
        // off stops it, on resyncs
        player.isEnabled = false
        XCTAssertEqual(out.log.last, "stop 0.12")
        XCTAssertFalse(player.startTune(endingIn: 10), "muted")
        player.isEnabled = true
        XCTAssertEqual(resyncs, 2)
        // never in the background
        active = false
        XCTAssertFalse(player.startTune(endingIn: 10))
        active = true
        XCTAssertTrue(player.startTune(endingIn: 10))
    }

    func testTheTuneIsBundledAndLastsTheClock() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bidclock", withExtension: "m4a"), "bidclock.m4a (Resources/Sounds)")
        let p = try AVAudioPlayer(contentsOf: url)
        // 30.000 s encoded; AAC priming may shift the decoded length by tens of ms (C11)
        XCTAssertEqual(p.duration, 30, accuracy: 0.1)
        XCTAssertFalse(SoundKind.allCases.flatMap(\.files).contains("bidclock"), "never in the two-per-file pool")
    }

    // MARK: - The recorded game (events-bidclock-s16, server/testUtils/iosScenarios.js)

    func testTheRecordedSeatHearsTimesOutBidsMidTuneAndResumesAfterARejoin() throws {
        let game = try RecordedGame("events-bidclock-s16")
        for label in ["seat1", "seat1-rejoin", "spectator"] {
            let viewer = game.viewer(label)
            let log = try XCTUnwrap(game.logs[label])
            let h = ReplayHarness(viewer: viewer)
            let p = FakeTunePlayer(nil)
            p.now = { h.clock.now }
            let tune = BidClockTune(player: p, remaining: { [store = h.store] in store.bidCountdown.map { $0.deadline - store.clockNow() } })
            // the harness's coordinator plays through the silent shared player; this one listens to the same effects
            var notices: [String] = []
            var countdowns: [(Int, BidCountdown?)] = []
            for (i, e) in log.enumerated() {
                let before = h.effects.count
                try h.apply(e)
                for fx in h.effects[before...] {
                    if case .bidClock(let cue) = fx { tune.handle(cue) }
                    if case .infoNotice(let text) = fx { notices.append(text) }
                }
                if e.event == "bidClock" || e.event == "rejoinSuccess" { countdowns.append((i, h.store.bidCountdown)) }
            }
            switch label {
            case "seat1":
                // the timeout: tune from the start, rings out, the toast, then the log line and my bid 0
                XCTAssertEqual(p.calls.first, .start(30), label)
                XCTAssertEqual(notices, ["Time ran out: you bid 0"], label)
                XCTAssertTrue(h.store.gameLog.contains { $0.message == "ios_kai ran out of time." })
                XCTAssertTrue(h.store.gameLog.contains { $0.message == "ios_kai bid 0" })
                // the mid-tune bid stops it with a fade (5 s into the second clock)
                XCTAssertTrue(p.calls.contains(.stop(BidClockTune.fade)), "\(p.calls)")
                XCTAssertEqual(countdowns.first?.1?.position, 2)
                XCTAssertEqual(try XCTUnwrap(countdowns.first?.1?.deadline), 50.39, accuracy: 1e-6)
            case "seat1-rejoin":
                // the rejoin snapshot carries the clock (11.9 s left): the tune resumes at its place, then my bid stops it
                XCTAssertEqual(countdowns.first?.0, 0)
                XCTAssertEqual(countdowns.first?.1?.position, 2)
                XCTAssertEqual(try XCTUnwrap(countdowns.first?.1?.deadline) - 163.85, 11.903, accuracy: 0.001)
                XCTAssertEqual(p.calls.prefix(2), [.start(11.903), .stop(BidClockTune.fade)], "\(p.calls)")
                XCTAssertEqual(notices, [], label)
            default:
                // the spectator hears every clock (three starts) and no toast
                XCTAssertEqual(p.calls.filter { if case .start = $0 { return true } else { return false } }.count, 3, "\(p.calls)")
                XCTAssertEqual(notices, [], label)
            }
            // seat1's recording ends as its socket drops mid-clock (its rejoin is the next viewer)
            if label != "seat1" { XCTAssertNil(h.store.bidCountdown, "\(label): no clock left at the end") }
            XCTAssertEqual(h.emitter.snapshotRequests, [], "\(label): the unsequenced event never needed a resync")
        }
    }
}

// MARK: - Fakes

/// A tune player on a test clock: what it was asked, and where the tune is.
@MainActor
final class FakeTunePlayer: TunePlaying {
    enum Call: Equatable, CustomStringConvertible {
        case start(TimeInterval), stop(TimeInterval)
        var description: String {
            switch self {
            case .start(let r): return "start(\(r))"
            case .stop(let f): return "stop(\(f))"
            }
        }
        static func == (a: Call, b: Call) -> Bool {
            switch (a, b) {
            case (.start(let x), .start(let y)), (.stop(let x), .stop(let y)): return abs(x - y) < 0.0005
            default: return false
            }
        }
    }

    var calls: [Call] = []
    var enabled = true
    var duration: TimeInterval = 30
    var now: () -> TimeInterval
    private var endsAt: TimeInterval?

    init(_ clock: SoundClock?) {
        now = { clock?.t ?? 0 }
    }

    var tuneTimeLeft: TimeInterval? {
        guard let e = endsAt else { return nil }
        let left = e - now()
        return left > 0 ? left : nil
    }
    var tuneDuration: TimeInterval? { duration }

    func startTune(endingIn remaining: TimeInterval) -> Bool {
        guard enabled else { return false }
        calls.append(.start(remaining))
        endsAt = now() + min(remaining, duration)
        return true
    }

    func stopTune(fade: TimeInterval) {
        calls.append(.stop(fade))
        endsAt = nil
    }

    /// The output went quiet on its own (SoundPlayer muted it): nothing recorded.
    func silence() { endsAt = nil }
}

@MainActor
final class FakeTuneOutput: TuneOutput {
    var log: [String] = []
    var timeLeft: TimeInterval? { nil }
    var duration: TimeInterval? { 30 }
    func start(endingIn remaining: TimeInterval, volume: Float) -> Bool {
        log.append("start \(remaining) @\(String(format: "%.2f", volume))")
        return true
    }
    func setVolume(_ volume: Float) { log.append("volume \(volume)") }
    func stop(fade: TimeInterval) { log.append("stop \(fade)") }
}
