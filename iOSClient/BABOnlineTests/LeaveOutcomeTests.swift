import XCTest
@testable import BAB_Online

/// Owner, 2026-11-12: "in a solo game with bots, if you click Leave on iOS you get a popup
/// saying you'll be replaced by a bot" — but the server ends that game (maybeAbort: no other
/// owner can return). The Leave alert and the /leave help now say what the server will do
/// (LeaveOutcome).
@MainActor
final class LeaveOutcomeTests: XCTestCase {

    // MARK: the predicate, seat by seat

    private func seat(_ pos: Int, _ controller: SeatController, _ presence: SeatPresence, owner: String? = nil) -> SeatState {
        SeatState(position: pos, username: owner ?? "P\(pos)", ownerUsername: controller == .bot ? nil : (owner ?? "p\(pos)"),
                  controller: controller, presence: presence, isBot: controller != .human)
    }

    /// Me at seat 4 (a human at the seat), seats 1-3 as given.
    private func outcome(_ others: [SeatState], me: SeatState? = nil, tournament: Bool = false, verified: Bool = false) -> LeaveOutcome {
        var seats: [Int: SeatState] = [4: me ?? seat(4, .human, .connected)]
        for s in others { seats[s.position] = s }
        return LeaveOutcome.of(seats: seats, myPosition: 4, inTournament: tournament, verified: verified)
    }

    func testThreeNativeBotsEndTheGame() {
        let o = outcome([seat(1, .bot, .none), seat(2, .bot, .none), seat(3, .bot, .none)])
        XCTAssertEqual(o, .endsGame)
    }

    func testAtATournamentTableItEndsThatTable() {
        let o = outcome([seat(1, .bot, .none), seat(2, .bot, .none), seat(3, .bot, .none)], tournament: true)
        XCTAssertEqual(o, .endsTournamentTable)
    }

    func testMyOwnSeatNeverCounts() {
        // me lazy (a bot plays my seat, I watch): still nobody else
        let o = outcome([seat(1, .bot, .none), seat(2, .bot, .none), seat(3, .bot, .none)], me: seat(4, .lazyBot, .connected))
        XCTAssertEqual(o, .endsGame)
    }

    func testAnotherOwnerHereOrReturnableKeepsTheGame() {
        // a human owner here or returnable (grace, resignable): every way they could leave is announced
        let kept: [(SeatController, SeatPresence)] = [(.human, .connected), (.human, .grace), (.human, .resignable)]
        for (controller, presence) in kept {
            for verified in [false, true] {
                let o = outcome([seat(1, .bot, .none), seat(2, controller, presence), seat(3, .bot, .none)], verified: verified)
                XCTAssertEqual(o, .botFinishes, "\(controller)/\(presence) verified \(verified)")
                let t = outcome([seat(1, .bot, .none), seat(2, controller, presence), seat(3, .bot, .none)], tournament: true, verified: verified)
                XCTAssertEqual(t, .botFinishes, "tournament \(controller)/\(presence) verified \(verified)")
            }
        }
        // a human beside a lazy owner: the human keeps it whatever the lazy owner did
        XCTAssertEqual(outcome([seat(1, .lazyBot, .connected), seat(2, .human, .connected), seat(3, .bot, .none)]), .botFinishes)
    }

    func testOwnersABotPlaysForAreUnsureUntilVerified() {
        // review L1: a lazy or resigned owner can leave for good with no event (only a snapshot
        // shows `gone`), so on their own they keep the game only once a snapshot says so
        let unsure: [(SeatController, SeatPresence)] = [
            (.lazyBot, .connected), (.lazyBot, .away), (.resignBot, .connected), (.resignBot, .away),
        ]
        for (controller, presence) in unsure {
            let others = [seat(1, .bot, .none), seat(2, controller, presence), seat(3, .bot, .none)]
            XCTAssertEqual(outcome(others), .unsure(inTournament: false), "\(controller)/\(presence)")
            XCTAssertEqual(outcome(others, tournament: true), .unsure(inTournament: true), "tournament \(controller)/\(presence)")
            XCTAssertEqual(outcome(others, verified: true), .botFinishes, "verified \(controller)/\(presence)")
            XCTAssertEqual(outcome(others, tournament: true, verified: true), .botFinishes, "verified tournament \(controller)/\(presence)")
        }
        // verified or not, no owner at all still ends it
        XCTAssertEqual(outcome([seat(1, .bot, .none), seat(2, .lazyBot, .gone), seat(3, .bot, .none)], verified: true), .endsGame)
    }

    func testOwnersWhoLeftForGoodDoNotCount() {
        let o = outcome([seat(1, .resignBot, .gone), seat(2, .lazyBot, .gone), seat(3, .bot, .none)])
        XCTAssertEqual(o, .endsGame)
    }

    func testAnUnknownTableKeepsTheBotMessage() {
        XCTAssertEqual(LeaveOutcome.of(seats: [:], myPosition: nil, inTournament: false), .botFinishes)
        XCTAssertEqual(outcome([seat(1, .bot, .none)]), .botFinishes, "two seats unknown")
    }

    // MARK: the words

    func testMessages() {
        XCTAssertEqual(LeaveOutcome.botFinishes.alertMessage, "A bot will finish your hand for you.")
        XCTAssertEqual(LeaveOutcome.endsGame.alertMessage, "You're the only player here, so leaving ends the game.")
        XCTAssertEqual(LeaveOutcome.endsTournamentTable.alertMessage,
                       "You're the only player at this table, so leaving ends its game with no score for this round. You stay in the tournament.")
        XCTAssertEqual(LeaveOutcome.unsure(inTournament: false).alertMessage,
                       "A bot will finish your hand for you, unless everyone else has left too: then leaving ends the game.")
        XCTAssertEqual(LeaveOutcome.unsure(inTournament: true).alertMessage,
                       "A bot will finish your hand for you, unless everyone else at this table has left too: then leaving ends its game with no score for this round. You stay in the tournament.")
        for o in [LeaveOutcome.endsGame, .endsTournamentTable] {
            XCTAssertFalse(o.alertMessage.localizedCaseInsensitiveContains("bot"), "\(o)")
            XCTAssertFalse(o.commandHelp.localizedCaseInsensitiveContains("bot"), "\(o)")
        }
    }

    func testSlashCommandHelp() {
        func leaveLine(_ list: [SlashCommand]) -> String? { list.first { $0.command == "/leave" }?.description }
        XCTAssertEqual(leaveLine(GameLogPanel.commands(pureSpectator: false, leave: .botFinishes)), "Leave the game (bot finishes for you)")
        XCTAssertEqual(leaveLine(GameLogPanel.commands(pureSpectator: false, leave: .endsGame)), "Leave and end the game (you're the only player)")
        XCTAssertEqual(leaveLine(GameLogPanel.commands(pureSpectator: false, leave: .endsTournamentTable)), "Leave and end this table's game (no score)")
        XCTAssertEqual(leaveLine(GameLogPanel.commands(pureSpectator: false, leave: .unsure(inTournament: false))),
                       "Leave the game (a bot takes over; ends it if you're the only player)")
        XCTAssertEqual(GameLogPanel.commands(pureSpectator: false, leave: .endsGame).map(\.command), ["/lazy", "/active", "/leave"])
        // a pure spectator's /leave only stops watching (it said "bot finishes for you")
        XCTAssertEqual(GameLogPanel.commands(pureSpectator: true, leave: .botFinishes),
                       [SlashCommand(command: "/leave", description: "Exit spectating")])
    }

    // MARK: from real table state (GameState.leaveOutcome)

    /// bidding-mid (me at seat 4, three humans) with seats 1-3 rewritten by `edit`.
    private func store(_ fixture: String = "bidding-mid", edit: ((inout [String: Any]) -> Void)? = nil) throws -> GameState {
        var raw = try FixtureLoader.v2Snapshot(fixture)
        if let edit {
            var seats = try XCTUnwrap(raw["seats"] as? [[String: Any]])
            for i in seats.indices { edit(&seats[i]) }
            raw["seats"] = seats
        }
        let store = GameState()
        store.apply(.snapshot(try TableSnapshot.decode(raw), .rejoin, hints: nil))
        return store
    }

    private static func make(_ seat: inout [String: Any], controller: String, presence: String) {
        seat["controller"] = controller
        seat["presence"] = presence
        if controller == "bot" { seat["ownerUsername"] = NSNull() }
        seat["isBot"] = controller != "human"
    }

    func testSoloBotGameFromASnapshot() throws {
        let s = try store { seat in
            if seat["position"] as? Int != 4 { Self.make(&seat, controller: "bot", presence: "none") }
        }
        XCTAssertEqual(s.position, 4)
        XCTAssertNil(s.tournamentId)
        XCTAssertEqual(s.leaveOutcome, .endsGame)
    }

    func testSoloTournamentTableFixture() throws {
        // tournament-game: me (seat 2) with three filler bots
        let s = try store("tournament-game")
        XCTAssertNotNil(s.tournamentId)
        XCTAssertEqual(s.leaveOutcome, .endsTournamentTable)
    }

    func testOtherHumansFixtures() throws {
        XCTAssertEqual(try store().leaveOutcome, .botFinishes, "bidding-mid: four humans")
        XCTAssertEqual(try store("presence-mixed").leaveOutcome, .botFinishes, "grace / resignable / lazy owners")
        XCTAssertEqual(try store("lazy-watcher").leaveOutcome, .botFinishes, "me lazy, others human")
    }

    func testEveryoneElseGoneEndsIt() throws {
        let s = try store { seat in
            if seat["position"] as? Int != 4 { Self.make(&seat, controller: "resignBot", presence: "gone") }
        }
        XCTAssertEqual(s.leaveOutcome, .endsGame)
    }

    func testPresenceEventsKeepItCurrent() throws {
        // seats 1 and 3 native bots, seat 2 a human who then drops: grace and resignable
        // owners may return, so the game goes on; resigned (a bot plays it, owner away) too
        let s = try store { seat in
            let pos = seat["position"] as? Int
            if pos == 1 || pos == 3 { Self.make(&seat, controller: "bot", presence: "none") }
        }
        XCTAssertEqual(s.leaveOutcome, .botFinishes)
        var seq = 14
        func event(_ name: String, _ data: [String: Any]) {
            seq += 1
            var d = data
            d["seq"] = seq
            _ = s.apply(serverEvent: name, payload: [d])
        }
        event("playerDisconnected", ["position": 2, "username": "bob"])
        XCTAssertEqual(s.players.seats[2]?.presence, .grace)
        XCTAssertEqual(s.leaveOutcome, .botFinishes)
        event("resignationAvailable", ["position": 2, "username": "bob"])
        XCTAssertEqual(s.leaveOutcome, .botFinishes)
        event("playerResigned", ["position": 2, "oldUsername": "bob", "botUsername": "🤖 Zach", "botPic": 3])
        XCTAssertEqual(s.players.seats[2]?.controller, .resignBot)
        // a resigned owner may still come back (away), or may have left unannounced
        XCTAssertEqual(s.leaveOutcome, .unsure(inTournament: false))
    }

    // MARK: Leave's snapshot check (review L1)

    /// bidding-mid with seats 1 and 3 native bots: me (4) and bob (2), two humans.
    private func twoHumans() throws -> ReplayHarness {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("bidding-mid") { raw in
            var seats = raw["seats"] as! [[String: Any]]
            for i in seats.indices where [1, 3].contains(seats[i]["position"] as? Int) {
                Self.make(&seats[i], controller: "bot", presence: "none")
            }
            raw["seats"] = seats
        }, .rejoin, hints: nil))
        XCTAssertEqual(h.store.leaveOutcome, .botFinishes)
        return h
    }

    /// The server's reply to "leave-N": bidding-mid as `twoHumans`, seat 2 as given.
    private func reply(_ h: ReplayHarness, seat2 controller: String, _ presence: String, requestId: String) throws {
        var raw = try FixtureLoader.v2Snapshot("bidding-mid")
        var seats = try XCTUnwrap(raw["seats"] as? [[String: Any]])
        for i in seats.indices {
            switch seats[i]["position"] as? Int {
            case 1, 3: Self.make(&seats[i], controller: "bot", presence: "none")
            case 2: Self.make(&seats[i], controller: controller, presence: presence)
            default: break
            }
        }
        raw["seats"] = seats
        raw["seq"] = 20
        h.handler.handle(event: "stateSnapshot", payload: [["snapshot": raw, "requestId": requestId]])
    }

    private func lazyMode(_ h: ReplayHarness, seq: Int) {
        h.handler.handle(event: "playerLazyMode", payload: [["position": 2, "botUsername": "🤖 Mike", "botPic": 4, "originalUsername": "max", "seq": seq]])
    }

    func testTheOtherHumansLeaveIsSettledByTheSnapshot() throws {
        // the review's scenario: bob's /leave reaches me only as playerLazyMode (lazyBot,
        // connected); the server has his seat gone, so my Leave ends the game
        let h = try twoHumans()
        lazyMode(h, seq: 15)
        XCTAssertEqual(h.store.players.seats[2]?.presence, .connected, "no event says gone")
        XCTAssertEqual(h.store.leaveOutcome, .unsure(inTournament: false), "never the plain bot message")
        h.store.apply(.local(.leaveAsked))
        XCTAssertEqual(h.emitter.snapshotRequests, ["leave-1"])
        XCTAssertEqual(h.store.players.leaveCheck, .pending(requestId: "leave-1"))
        XCTAssertEqual(h.store.leaveOutcome, .unsure(inTournament: false), "hedged until the reply")
        try reply(h, seat2: "lazyBot", "gone", requestId: "leave-1")
        XCTAssertEqual(h.store.players.seats[2]?.presence, .gone)
        XCTAssertEqual(h.store.leaveOutcome, .endsGame)
        XCTAssertEqual(h.store.leaveOutcome.alertMessage, "You're the only player here, so leaving ends the game.")
    }

    func testALazyOwnerStillWatchingIsVerified() throws {
        let h = try twoHumans()
        lazyMode(h, seq: 15)
        h.store.apply(.local(.leaveAsked))
        try reply(h, seat2: "lazyBot", "connected", requestId: "leave-1")
        XCTAssertEqual(h.store.players.leaveCheck, .verified)
        XCTAssertEqual(h.store.leaveOutcome, .botFinishes, "the snapshot says bob is still here")
        // the alert closes: the check ends and the next Leave asks again
        h.store.apply(.local(.leaveClosed))
        XCTAssertEqual(h.store.players.leaveCheck, .idle)
        XCTAssertEqual(h.store.leaveOutcome, .unsure(inTournament: false))
        h.store.apply(.local(.leaveAsked))
        XCTAssertEqual(h.emitter.snapshotRequests, ["leave-1", "leave-2"])
    }

    func testAnAlreadyLazyOwnersSilentLeave() throws {
        // bob lazy in my snapshot, then /leave: the server broadcasts nothing at all
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("bidding-mid") { raw in
            var seats = raw["seats"] as! [[String: Any]]
            for i in seats.indices {
                switch seats[i]["position"] as? Int {
                case 1, 3: Self.make(&seats[i], controller: "bot", presence: "none")
                case 2: Self.make(&seats[i], controller: "lazyBot", presence: "connected")
                default: break
                }
            }
            raw["seats"] = seats
        }, .rejoin, hints: nil))
        XCTAssertEqual(h.store.leaveOutcome, .unsure(inTournament: false))
        h.store.apply(.local(.leaveAsked))
        XCTAssertEqual(h.emitter.snapshotRequests, ["leave-1"])
        try reply(h, seat2: "lazyBot", "gone", requestId: "leave-1")
        XCTAssertEqual(h.store.leaveOutcome, .endsGame)
    }

    func testAnotherOwnersLazyModeWhileLeaveIsUpChecksAgain() throws {
        // bob /leave's while my verified alert is up: it shows only as playerLazyMode
        let h = try twoHumans()
        lazyMode(h, seq: 15)
        h.store.apply(.local(.leaveAsked))
        try reply(h, seat2: "lazyBot", "connected", requestId: "leave-1")
        XCTAssertEqual(h.store.leaveOutcome, .botFinishes)
        lazyMode(h, seq: 21)
        XCTAssertEqual(h.store.players.leaveCheck, .pending(requestId: "leave-2"))
        XCTAssertEqual(h.store.leaveOutcome, .unsure(inTournament: false), "no longer verified")
        XCTAssertEqual(h.emitter.snapshotRequests, ["leave-1", "leave-2"])
    }

    func testADefiniteOutcomeAsksForNothing() throws {
        // a human here (bob), or nobody at all: nothing to settle, no snapshot (no scene reset)
        let h = try twoHumans()
        h.store.apply(.local(.leaveAsked))
        XCTAssertEqual(h.store.players.leaveCheck, .settled, "up, nothing to ask")
        h.store.apply(.local(.leaveClosed))
        XCTAssertEqual(h.store.players.leaveCheck, .idle)
        let solo = ReplayHarness()
        solo.store.apply(.snapshot(try T.snapshot("tournament-game"), .rejoin, hints: nil))
        solo.store.apply(.local(.leaveAsked))
        XCTAssertEqual(solo.store.leaveOutcome, .endsTournamentTable)
        XCTAssertEqual(h.emitter.snapshotRequests + solo.emitter.snapshotRequests, [])
        // and with no Leave up, another owner's lazy mode asks for nothing either
        lazyMode(h, seq: 15)
        XCTAssertEqual(h.emitter.snapshotRequests, [])
    }

    // MARK: when the alert opens (LeaveAlertFlow; an open SwiftUI alert keeps its first message)

    func testAnUnsureLeaveWaitsForTheSnapshotThenOpensSettled() {
        var f = LeaveAlertFlow()
        XCTAssertEqual(f.tapped(check: .pending(requestId: "leave-1")), .wait(1), "not opened hedged at once")
        XCTAssertEqual(f.changed(outcome: .unsure(inTournament: false), check: .pending(requestId: "leave-1")), .none)
        XCTAssertEqual(f.changed(outcome: .endsGame, check: .verified), .present)
        f.presented(.endsGame)
        XCTAssertEqual(f.timedOut(wait: 1), .none, "the timeout after it opened does nothing")
        XCTAssertEqual(f.changed(outcome: .endsGame, check: .verified), .none)
        let (next, ends) = f.dismissed(check: .verified)
        XCTAssertEqual(next, .none)
        XCTAssertTrue(ends, "Cancel / Leave ends the check")
    }

    func testNoReplyOpensItHedgedAfterTheTimeout() {
        var f = LeaveAlertFlow()
        XCTAssertEqual(f.tapped(check: .pending(requestId: "leave-1")), .wait(1))
        XCTAssertEqual(f.timedOut(wait: 1), .present)
        f.presented(.unsure(inTournament: false))
        // the late reply changes the words: the open alert closes and reopens with them
        XCTAssertEqual(f.changed(outcome: .endsGame, check: .verified), .close)
        XCTAssertEqual(f.changed(outcome: .endsGame, check: .verified), .none, "one close")
        let (next, ends) = f.dismissed(check: .verified)
        XCTAssertEqual(next, .present)
        XCTAssertFalse(ends, "a reopen keeps the check")
    }

    func testADefiniteOutcomeOpensAtOnce() {
        var f = LeaveAlertFlow()
        XCTAssertEqual(f.tapped(check: .idle), .present)
        f.presented(.botFinishes)
        XCTAssertEqual(f.tapped(check: .idle), .none, "already open")
    }

    /// What GameContainerView's onChange handlers do: the flow fed from the store.
    private func changed(_ f: inout LeaveAlertFlow, _ h: ReplayHarness) -> LeaveAlertFlow.Step {
        f.changed(outcome: h.store.leaveOutcome, check: h.store.players.leaveCheck)
    }

    func testAnotherOwnerLeavingWhileItIsOpenReopensItSettled() throws {
        // review M1: Leave opened definite (bob human, a bot finishes), then bob /leave's: the
        // room sees only his playerLazyMode. The reducer must check again although the open
        // Leave needed no check, and the alert must end on "ends the game", never the hedge.
        let h = try twoHumans()
        var f = LeaveAlertFlow()
        h.store.apply(.local(.leaveAsked))
        XCTAssertEqual(h.emitter.snapshotRequests, [], "a definite outcome asks nothing")
        XCTAssertEqual(f.tapped(check: h.store.players.leaveCheck), .present)
        f.presented(h.store.leaveOutcome)
        XCTAssertEqual(f.shown, .botFinishes)
        lazyMode(h, seq: 15)
        XCTAssertEqual(h.emitter.snapshotRequests, ["leave-1"], "bob's lazy mode while Leave is up asks again")
        XCTAssertEqual(h.store.players.leaveCheck, .pending(requestId: "leave-1"))
        XCTAssertEqual(changed(&f, h), .wait(1), "the open alert holds for the reply, no hedged reopen")
        XCTAssertEqual(f.shown, .botFinishes)
        try reply(h, seat2: "lazyBot", "gone", requestId: "leave-1")
        XCTAssertEqual(h.store.leaveOutcome, .endsGame)
        XCTAssertEqual(changed(&f, h), .close)
        XCTAssertEqual(changed(&f, h), .none, "the second onChange: one close")
        let (next, ends) = f.dismissed(check: h.store.players.leaveCheck)
        XCTAssertEqual(next, .present, "reopens straight with the settled words")
        XCTAssertFalse(ends)
        f.presented(h.store.leaveOutcome)
        XCTAssertEqual(f.shown, .endsGame)
        XCTAssertEqual(f.shown?.alertMessage, "You're the only player here, so leaving ends the game.")
        XCTAssertEqual(f.timedOut(wait: 1), .none, "the hold's timer after the reply does nothing")
    }

    func testAnotherOwnerOnlyGoingLazyLeavesTheOpenAlertAlone() throws {
        // bob /lazy's (still watching) while my definite alert is up: the check says he is
        // still here, the words are the same, so the alert never closes
        let h = try twoHumans()
        var f = LeaveAlertFlow()
        h.store.apply(.local(.leaveAsked))
        XCTAssertEqual(f.tapped(check: h.store.players.leaveCheck), .present)
        f.presented(h.store.leaveOutcome)
        lazyMode(h, seq: 15)
        XCTAssertEqual(changed(&f, h), .wait(1))
        try reply(h, seat2: "lazyBot", "connected", requestId: "leave-1")
        XCTAssertEqual(h.store.leaveOutcome, .botFinishes)
        XCTAssertEqual(changed(&f, h), .none, "no flicker")
        XCTAssertEqual(f.timedOut(wait: 1), .none)
        XCTAssertEqual(f.shown, .botFinishes)
        XCTAssertTrue(f.dismissed(check: h.store.players.leaveCheck).ends)
    }

    func testAResignationWhileItIsOpenChecksAgain() throws {
        // bob drops and is resigned while my Leave is up (opened definite): a resigned owner
        // may leave unannounced, so the reducer asks, and the reply settles it
        let h = try twoHumans()
        h.store.apply(.local(.leaveAsked))
        h.handler.handle(event: "playerDisconnected", payload: [["position": 2, "username": "bob", "seq": 15]])
        h.handler.handle(event: "resignationAvailable", payload: [["position": 2, "username": "bob", "seq": 16]])
        XCTAssertEqual(h.emitter.snapshotRequests, [])
        h.handler.handle(event: "playerResigned", payload: [["position": 2, "oldUsername": "bob", "botUsername": "🤖 Zach", "botPic": 3, "seq": 17]])
        XCTAssertEqual(h.store.players.seats[2]?.controller, .resignBot)
        XCTAssertEqual(h.emitter.snapshotRequests, ["leave-1"])
        try reply(h, seat2: "resignBot", "away", requestId: "leave-1")
        XCTAssertEqual(h.store.leaveOutcome, .botFinishes, "verified: bob may still come back")
    }

    func testAHoldWithNoReplyReopensHedgedOnce() {
        var f = LeaveAlertFlow()
        XCTAssertEqual(f.tapped(check: .settled), .present)
        f.presented(.botFinishes)
        XCTAssertEqual(f.changed(outcome: .unsure(inTournament: false), check: .pending(requestId: "leave-1")), .wait(1))
        XCTAssertEqual(f.changed(outcome: .unsure(inTournament: false), check: .pending(requestId: "leave-1")), .none, "one hold")
        XCTAssertEqual(f.timedOut(wait: 1), .close, "no reply: stop showing the stale words")
        let (next, ends) = f.dismissed(check: .pending(requestId: "leave-1"))
        XCTAssertEqual(next, .present, "hedged at once, no second wait")
        XCTAssertFalse(ends)
        f.presented(.unsure(inTournament: false))
        // the late reply still settles it, with one more reopen
        XCTAssertEqual(f.changed(outcome: .endsGame, check: .verified), .close)
        XCTAssertEqual(f.dismissed(check: .verified).next, .present)
    }

    func testAStaleTimeoutOrAResetOpensNothing() {
        var f = LeaveAlertFlow()
        XCTAssertEqual(f.tapped(check: .pending(requestId: "leave-1")), .wait(1))
        XCTAssertEqual(f.changed(outcome: .botFinishes, check: .verified), .present)
        f.presented(.botFinishes)
        _ = f.dismissed(check: .verified)
        XCTAssertEqual(f.tapped(check: .pending(requestId: "leave-2")), .wait(2))
        XCTAssertEqual(f.timedOut(wait: 1), .none, "the first wait's timer")
        XCTAssertEqual(f.changed(outcome: .botFinishes, check: .idle), .none, "game over while waiting")
        XCTAssertEqual(f.timedOut(wait: 2), .none)
    }
}
