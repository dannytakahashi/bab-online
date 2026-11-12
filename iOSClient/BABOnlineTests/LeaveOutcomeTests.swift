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
    private func outcome(_ others: [SeatState], me: SeatState? = nil, tournament: Bool = false) -> LeaveOutcome {
        var seats: [Int: SeatState] = [4: me ?? seat(4, .human, .connected)]
        for s in others { seats[s.position] = s }
        return LeaveOutcome.of(seats: seats, myPosition: 4, inTournament: tournament)
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
        // every presence the server counts (CONNECTED + isReturnable), under every owned controller
        let kept: [(SeatController, SeatPresence)] = [
            (.human, .connected), (.human, .grace), (.human, .resignable),
            (.lazyBot, .connected), (.lazyBot, .away), (.resignBot, .connected), (.resignBot, .away),
        ]
        for (controller, presence) in kept {
            let o = outcome([seat(1, .bot, .none), seat(2, controller, presence), seat(3, .bot, .none)])
            XCTAssertEqual(o, .botFinishes, "\(controller)/\(presence)")
            let t = outcome([seat(1, .bot, .none), seat(2, controller, presence), seat(3, .bot, .none)], tournament: true)
            XCTAssertEqual(t, .botFinishes, "tournament \(controller)/\(presence)")
        }
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
        XCTAssertEqual(s.leaveOutcome, .botFinishes, "a resigned owner may still come back (away)")
    }
}
