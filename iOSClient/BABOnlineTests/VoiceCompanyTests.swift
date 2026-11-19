import XCTest
@preconcurrency import WebRTC
@testable import BAB_Online

/// No voice alone (owner 2026-11-19; docs/claude/voice.md "No voice alone"): the rule (a pure
/// function of who is present: lobby members, seat owners, entrants, spectators), seatLeft, the
/// gate's start / grace / return, and the manager behind it (silent managers: nothing starts
/// alone, the grace suspends and keeps the table's settings, a newcomer's offer that came first
/// is answered at the start).
@MainActor
final class VoiceCompanyTests: XCTestCase {

    // MARK: - The rule

    private func member(_ name: String, bot: Bool = false, returning: Bool = false) -> LobbyPlayer {
        LobbyPlayer(id: "sid-\(name)", username: name, pic: nil, isReady: false, isBot: bot, returning: returning)
    }

    func testTheRuleCountsOtherHumansOnly() {
        XCTAssertFalse(VoiceCompany.hasCompany([], me: "me"))
        XCTAssertFalse(VoiceCompany.hasCompany([VoicePerson(username: "me")], me: "me"), "my own name (my other device)")
        XCTAssertFalse(VoiceCompany.hasCompany([VoicePerson(username: "me"), VoicePerson(username: "🤖 Mike", isBot: true)], me: "me"))
        XCTAssertFalse(VoiceCompany.hasCompany([VoicePerson(username: "amy", gone: true)], me: "me"), "left for good")
        XCTAssertFalse(VoiceCompany.hasCompany([VoicePerson(username: nil), VoicePerson(username: "")], me: "me"))
        XCTAssertTrue(VoiceCompany.hasCompany([VoicePerson(username: "me"), VoicePerson(username: "amy")], me: "me"))
        XCTAssertTrue(VoiceCompany.hasCompany([VoicePerson(username: "amy")], me: nil), "signed-in name unknown: anyone named counts")
    }

    func testLobby() {
        XCTAssertFalse(VoiceCompany.lobby([member("me")], me: "me"), "alone")
        XCTAssertFalse(VoiceCompany.lobby([member("me"), member("🤖 Bot", bot: true), member("🤖 Zach", bot: true)], me: "me"), "with bots")
        XCTAssertTrue(VoiceCompany.lobby([member("me"), member("amy")], me: "me"))
        XCTAssertTrue(VoiceCompany.lobby([member("me"), member("amy", returning: true)], me: "me"), "a play-again place kept counts")
        XCTAssertFalse(VoiceCompany.lobby([], me: "me"))
    }

    /// me (seat 1), bots L and R, human P (seat 3): the table's positionUpdate.
    private func seated(humanPartner: Bool = true) -> TableState {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "me", playerId: "sid-me")))
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        TableReducer.reduce(&s, T.ev("positionUpdate", [
            "positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", humanPartner ? "sid-p" : "bot:p", "bot:r"],
            "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4],
            "isBot": [false, true, !humanPartner, true], "seq": 1,
        ]))
        return s
    }

    func testTableBeforeSeatingIsNotKnown() {
        var s = TableState()
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        XCTAssertNil(VoiceCompany.table(s.players, me: "me"), "nothing says who sits here: hold")
        XCTAssertNil(VoiceCompany.people(table: s.players))
    }

    func testTableSeatOwners() {
        XCTAssertEqual(VoiceCompany.table(seated().players, me: "me"), true, "a human partner")
        XCTAssertEqual(VoiceCompany.table(seated(humanPartner: false).players, me: "me"), false, "a solo bot game")
        XCTAssertEqual(VoiceCompany.table(seated().players, me: "P"), true, "P sees me")
    }

    func testLazyResignedAndAwayOwnersCount() {
        var lazy = seated()
        TableReducer.reduce(&lazy, T.ev("playerLazyMode", ["position": 3, "botUsername": "Bot", "botPic": 5, "originalUsername": "P", "seq": 2]))
        XCTAssertEqual(VoiceCompany.table(lazy.players, me: "me"), true, "a lazy owner watching")

        var resigned = seated()
        TableReducer.reduce(&resigned, T.ev("playerResigned", ["position": 3, "oldUsername": "P", "botUsername": "Bot", "seq": 2]))
        XCTAssertEqual(resigned.players.seats[3]?.presence, .away)
        XCTAssertEqual(VoiceCompany.table(resigned.players, me: "me"), true, "a resigned owner may watch")

        var away = seated()
        TableReducer.reduce(&away, T.ev("playerDisconnected", ["position": 3, "username": "P", "seq": 2]))
        XCTAssertEqual(VoiceCompany.table(away.players, me: "me"), true, "a dropped owner in the grace")
    }

    func testSeatLeftIsUnsequencedAndRemovesTheOwner() throws {
        var s = seated()
        TableReducer.reduce(&s, T.ev("playerLazyMode", ["position": 3, "botUsername": "Bot", "botPic": 5, "originalUsername": "P", "seq": 2]))
        XCTAssertEqual(s.sync.lastSeq, 2)
        // another game's, another owner's, an empty seat's: ignored
        TableReducer.reduce(&s, T.ev("seatLeft", ["gameId": "g2", "position": 3, "username": "P"]))
        TableReducer.reduce(&s, T.ev("seatLeft", ["gameId": "g1", "position": 3, "username": "Q"]))
        TableReducer.reduce(&s, T.ev("seatLeft", ["gameId": "g1", "position": 9, "username": "P"]))
        XCTAssertEqual(VoiceCompany.table(s.players, me: "me"), true)
        let fx = TableReducer.reduce(&s, T.ev("seatLeft", ["gameId": "g1", "position": 3, "username": "P"]))
        XCTAssertEqual(s.players.seats[3]?.presence, .gone)
        XCTAssertEqual(s.players.seats[3]?.controller, .lazyBot, "the bot keeps the seat")
        XCTAssertEqual(VoiceCompany.table(s.players, me: "me"), false, "only bots left with me")
        XCTAssertEqual(s.sync.lastSeq, 2, "unsequenced: lastSeq unchanged")
        XCTAssertFalse(fx.contains { if case .gap = $0 { return true } else { return false } })
        // routed around the seq gate
        XCTAssertTrue(GameSocketHandler.events.contains(SocketEvents.Server.seatLeft))
        XCTAssertFalse(ContractSeq.events.contains("seatLeft"))
        let decoded = try ServerEvent.decode(name: "seatLeft", payload: [["gameId": "g1", "position": 3, "username": "P", "seq": 7] as [String: Any]]).get()
        XCTAssertNil(decoded.seq, "a seq on the payload is still never gated")
    }

    func testSpectatorsCount() {
        var s = seated(humanPartner: false)
        XCTAssertEqual(VoiceCompany.table(s.players, me: "me"), false)
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": [["username": "lou"]], "count": 1]))
        XCTAssertEqual(VoiceCompany.table(s.players, me: "me"), true, "a spectator watching my solo game")
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": [], "count": 0]))
        XCTAssertEqual(VoiceCompany.table(s.players, me: "me"), false, "they left")
        // more watching than the list names (it names at most 50)
        var many = seated(humanPartner: false)
        TableReducer.reduce(&many, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": [["username": "me"]], "count": 2]))
        XCTAssertEqual(VoiceCompany.table(many.players, me: "me"), true)
        // spectators are known before the seats are
        var early = TableState()
        TableReducer.reduce(&early, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        TableReducer.reduce(&early, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": [["username": "lou"]], "count": 1]))
        XCTAssertEqual(VoiceCompany.table(early.players, me: "me"), true)
    }

    func testSnapshots() throws {
        // the draw: no seats yet, the human entrants (3 humans and a bot)
        let draw = try T.state(fixture: "draw-in-progress")
        XCTAssertEqual(draw.players.entrantHumans, ["eve", "fay", "gus"])
        XCTAssertEqual(VoiceCompany.table(draw.players, me: "eve"), true)
        let soloDraw = try edited("draw-in-progress") { snap in
            snap["entrants"] = [["username": "eve", "isBot": false, "presence": "connected", "hasDrawn": false],
                                ["username": "fay", "isBot": false, "presence": "left", "hasDrawn": true],
                                ["username": "🤖 Mike", "isBot": true, "presence": "connected", "hasDrawn": true]]
        }
        XCTAssertEqual(VoiceCompany.table(soloDraw.players, me: "eve"), false, "a left entrant and a bot")
        // seated: grace / resignable / lazy owners count (presence-mixed: rae at seat 4)
        XCTAssertEqual(VoiceCompany.table(try T.state(fixture: "presence-mixed").players, me: "rae"), true)
        XCTAssertNil(try T.state(fixture: "presence-mixed").players.entrantHumans)
        // gone owners and native bots do not
        let gone = try edited("presence-mixed") { snap in
            var seats = snap["seats"] as! [[String: Any]]
            for i in seats.indices where seats[i]["ownerUsername"] as? String != "rae" {
                seats[i]["presence"] = "gone"
            }
            snap["seats"] = seats
        }
        XCTAssertEqual(VoiceCompany.table(gone.players, me: "rae"), false)
        // a spectator (lou) watching four humans; a lazy watcher (max) with others
        XCTAssertEqual(VoiceCompany.table(try T.state(fixture: "spectator-mid-hand").players, me: "lou"), true)
        XCTAssertEqual(VoiceCompany.table(try T.state(fixture: "lazy-watcher").players, me: "max"), true)
    }

    private func edited(_ name: String, _ edit: (inout [String: Any]) -> Void) throws -> TableState {
        TableReducer.state(from: try T.snapshot(name, edit: edit), hints: nil, previous: nil, source: .requested("t"))
    }

    func testTheScoreScreenOfAPlayAgainGameCountsTheLobby() {
        let table = seated().players
        XCTAssertEqual(VoiceCompany.tableScreen(table, gameId: "g1", returnFromGameId: nil, lobbyId: "", lobbyPlayers: [], me: "me"), true)
        XCTAssertEqual(VoiceCompany.tableScreen(table, gameId: "g1", returnFromGameId: "g1", lobbyId: "L2",
                                                lobbyPlayers: [member("me"), member("🤖 Bot", bot: true)], me: "me"),
                       false, "moved back into a lobby with only bots")
        XCTAssertEqual(VoiceCompany.tableScreen(seated(humanPartner: false).players, gameId: "g1", returnFromGameId: "g1", lobbyId: "L2",
                                                lobbyPlayers: [member("me"), member("P", returning: true)], me: "me"),
                       true, "a held place in the reopened lobby")
        XCTAssertEqual(VoiceCompany.tableScreen(table, gameId: "g1", returnFromGameId: "g0", lobbyId: "L2",
                                                lobbyPlayers: [member("me")], me: "me"), true, "another game's lobby: the table")
    }

    // MARK: - The gate

    @MainActor
    final class Timers {
        var pending: [(delay: TimeInterval, run: @MainActor () -> Void)] = []
        func fire() {
            let all = pending
            pending = []
            for t in all { t.run() }
        }
    }

    private func gate(_ timers: Timers, running: @escaping () -> Bool, start: @escaping () -> Void, suspend: @escaping () -> Void) -> VoiceGate {
        VoiceGate(isRunning: running, start: start, suspend: suspend, after: { delay, run in timers.pending.append((delay, run)) })
    }

    func testNothingStartsAloneAndAnArrivalStarts() {
        let timers = Timers()
        var running = false, starts = 0, suspends = 0
        let g = gate(timers, running: { running }, start: { starts += 1; running = true }, suspend: { suspends += 1; running = false })
        g.setCompany(false, from: .lobby)
        g.want()
        XCTAssertEqual(starts, 0, "alone with bots: never started")
        XCTAssertTrue(timers.pending.isEmpty, "nothing running, no grace")
        g.setCompany(true, from: .lobby)
        XCTAssertEqual(starts, 1, "another human arrived")
        g.setCompany(true, from: .lobby)
        g.update()
        XCTAssertEqual(starts, 1, "started once")
        XCTAssertEqual(suspends, 0)
    }

    func testNotWantedNeverStarts() {
        let timers = Timers()
        var starts = 0
        let g = gate(timers, running: { false }, start: { starts += 1 }, suspend: {})
        g.setCompany(true, from: .table)
        XCTAssertEqual(starts, 0, "no screen wants voice (the main room)")
        g.want()
        XCTAssertEqual(starts, 1)
    }

    func testTheLastOneLeavingStopsAfterTheGrace() {
        let timers = Timers()
        var running = false, suspends = 0
        let g = gate(timers, running: { running }, start: { running = true }, suspend: { suspends += 1; running = false })
        g.want()
        g.setCompany(true, from: .lobby)
        g.setCompany(false, from: .lobby)
        XCTAssertTrue(running, "still running during the grace")
        XCTAssertTrue(g.graceRunning)
        XCTAssertEqual(timers.pending.map(\.delay), [30])
        XCTAssertEqual(VoiceCompany.grace, 30)
        g.setCompany(false, from: .lobby)
        XCTAssertEqual(timers.pending.count, 1, "one grace")
        timers.fire()
        XCTAssertEqual(suspends, 1)
        XCTAssertFalse(running)
        XCTAssertTrue(g.wanted, "still wanted: the next arrival starts it again")
        g.setCompany(true, from: .lobby)
        XCTAssertTrue(running, "restarted (muted, as every start)")
    }

    func testAReturnWithinTheGraceKeepsTheSession() {
        let timers = Timers()
        var running = false, starts = 0, suspends = 0
        let g = gate(timers, running: { running }, start: { starts += 1; running = true }, suspend: { suspends += 1; running = false })
        g.want()
        g.setCompany(true, from: .lobby)
        g.setCompany(false, from: .lobby)
        g.setCompany(true, from: .lobby)  // back 15 s later
        XCTAssertFalse(g.graceRunning)
        timers.fire()  // the old timer runs out: spent
        XCTAssertEqual(suspends, 0, "no restart, no stop")
        XCTAssertEqual(starts, 1)
        // they leave again: a new full grace
        g.setCompany(false, from: .lobby)
        XCTAssertEqual(timers.pending.count, 1)
        timers.fire()
        XCTAssertEqual(suspends, 1)
    }

    func testUnknownHoldsAndScreensClearOnlyTheirOwnWord() {
        let timers = Timers()
        var running = false, starts = 0, suspends = 0
        let g = gate(timers, running: { running }, start: { starts += 1; running = true }, suspend: { suspends += 1; running = false })
        g.want()
        g.setCompany(true, from: .lobby)
        // into the table before its seating: not known, voice runs on
        g.setCompany(nil, from: .table)
        g.clearCompany(from: .lobby)  // the lobby went after the table spoke: no effect
        XCTAssertNil(g.company)
        XCTAssertEqual(g.current, .table)
        XCTAssertTrue(running)
        XCTAssertFalse(g.graceRunning)
        // the seats say: only bots
        g.setCompany(false, from: .table)
        XCTAssertTrue(g.graceRunning)
        // the grace runs out while the next screen does not know yet: nothing stops
        g.setCompany(nil, from: .table)
        timers.fire()
        XCTAssertEqual(suspends, 0)
        // not running and unknown: nothing starts
        running = false
        g.update()
        XCTAssertEqual(starts, 1)
        // a screen going away with no other word: not known
        g.setCompany(true, from: .lobby)
        g.clearCompany(from: .lobby)
        XCTAssertNil(g.current)
    }

    func testReleaseEndsTheGrace() {
        let timers = Timers()
        var running = false, suspends = 0
        let g = gate(timers, running: { running }, start: { running = true }, suspend: { suspends += 1 })
        g.want()
        g.setCompany(true, from: .lobby)
        g.setCompany(false, from: .lobby)
        g.release()
        running = false
        XCTAssertFalse(g.graceRunning)
        timers.fire()
        XCTAssertEqual(suspends, 0, "released (left the lobby): the shutdown already stopped it")
        g.setCompany(true, from: .lobby)
        XCTAssertFalse(running, "not wanted any more")
    }

    // MARK: - The manager

    private var managers: [VoiceChatManager] = []

    override func tearDown() async throws {
        for m in managers { m.shutdown() }
        managers = []
    }

    private func make(_ timers: Timers, answers: ((String, RTCSessionDescription) -> Void)? = nil,
                      offers: ((String, RTCSessionDescription) -> Void)? = nil) -> VoiceChatManager {
        let m = VoiceChatManager.silent(sendOffer: { to, sdp, _ in offers?(to, sdp) },
                                        sendAnswer: { to, sdp in answers?(to, sdp) },
                                        after: { delay, run in timers.pending.append((delay, run)) })
        managers.append(m)
        return m
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 10, _ condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > end { return XCTFail("timed out: \(what)") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func testTheManagerStartsOnlyWithCompanyAndSuspendsAfterTheGrace() async throws {
        let timers = Timers()
        let m = make(timers)
        m.setCompany(false, from: .table)
        m.ensureStarted()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(m.isActive, "alone with bots: no session")
        m.settings = VoiceSettings(gameId: "g1", host: nil, spectatorsCanTalk: true, role: .spectator, canTalk: true, canChange: false)

        m.setCompany(true, from: .table)
        try await waitUntil("started") { m.isActive }
        XCTAssertTrue(m.isSelfMuted, "muted on join")

        m.setCompany(false, from: .table)
        XCTAssertTrue(m.isActive, "the grace")
        XCTAssertEqual(timers.pending.map(\.delay), [VoiceCompany.grace])
        timers.fire()
        XCTAssertFalse(m.isActive, "stopped 30 s after the last other human left")
        XCTAssertEqual(m.settings?.role, .spectator, "the table's voice settings stay for the next start")

        m.setCompany(true, from: .table)
        try await waitUntil("started again") { m.isActive }
        XCTAssertTrue(m.isSelfMuted)

        m.shutdown()
        XCTAssertNil(m.settings, "a shutdown drops them")
        m.setCompany(true, from: .table)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(m.isActive, "released: nothing restarts")
    }

    func testSignalsBeforeVoiceRunsAreBufferedAndAnswered() async throws {
        let timers = Timers()
        var offers: [RTCSessionDescription] = []
        var answers: [(String, RTCSessionDescription)] = []
        let newcomer = make(timers, offers: { _, sdp in offers.append(sdp) })
        let me = make(timers, answers: { to, sdp in answers.append((to, sdp)) })
        me.setCompany(false, from: .lobby)
        me.ensureStarted()

        // the newcomer's start and offer beat my company update
        try await newcomer.initialize()
        newcomer.connectToPeer("ME", username: "me")
        try await waitUntil("the newcomer's offer") { offers.count == 1 }
        me.handleOffer(fromSocketId: "NEW", offer: offers[0], username: "amy")
        let candidate = RTCIceCandidate(sdp: "candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host", sdpMLineIndex: 0, sdpMid: "0")
        me.handleIceCandidate(fromSocketId: "NEW", candidate: candidate)
        me.handleIceCandidate(fromSocketId: "OTHER", candidate: candidate)  // no buffered offer: dropped
        XCTAssertEqual(me.bufferedCount, 1)
        XCTAssertEqual(me.bufferedCandidates(from: "NEW"), 1)
        XCTAssertEqual(me.bufferedCandidates(from: "OTHER"), 0)
        XCTAssertFalse(me.isActive)

        // the lobby update: someone is here
        me.setCompany(true, from: .lobby)
        try await waitUntil("my answer to the buffered offer") { answers.count == 1 }
        XCTAssertEqual(answers[0].0, "NEW")
        XCTAssertEqual(me.bufferedCount, 0)
        XCTAssertEqual(me.bufferedCandidates(from: "NEW"), 0, "added right after the offer")
        XCTAssertTrue(me.isSelfMuted)
    }

    func testANewerOfferReplacesTheBufferedOneAndALeavingPeerDropsItsSignals() {
        let m = make(Timers())
        let offer = RTCSessionDescription(type: .offer, sdp: "v=0")
        let candidate = RTCIceCandidate(sdp: "candidate:1 1 udp 1 192.0.2.1 1 typ host", sdpMLineIndex: 0, sdpMid: "0")
        m.handleOffer(fromSocketId: "A", offer: offer, username: "amy")
        m.handleIceCandidate(fromSocketId: "A", candidate: candidate)
        m.handleOffer(fromSocketId: "A", offer: offer, username: "amy")
        XCTAssertEqual(m.bufferedCount, 1, "the newer offer replaced the older")
        XCTAssertEqual(m.bufferedCandidates(from: "A"), 0, "with the older one's candidates")
        for _ in 0..<(VoiceChatManager.maxPendingCandidates + 5) { m.handleIceCandidate(fromSocketId: "A", candidate: candidate) }
        XCTAssertEqual(m.bufferedCandidates(from: "A"), VoiceChatManager.maxPendingCandidates, "bounded")
        m.connectToPeer("B", username: "bob")
        XCTAssertEqual(m.bufferedCount, 2)
        m.removePeer("A")
        XCTAssertEqual(m.bufferedCount, 1, "voicePeerLeft drops the buffered offer")
        XCTAssertEqual(m.bufferedCandidates(from: "A"), 0)
        m.removePeer("B")
        XCTAssertEqual(m.bufferedCount, 0, "and a buffered peer")
    }
}
