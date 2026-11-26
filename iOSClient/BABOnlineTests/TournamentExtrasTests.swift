import XCTest
@preconcurrency import WebRTC
@testable import BAB_Online

/// iOS 1.2.7 (41) around Cut for a buck: the host's round count (#407's wire), the profile's
/// tournament history (#412), the over-cap voice notice (#406) and the speaking poll for the
/// tournament room of up to 20 people (19 calls).
@MainActor
final class TournamentExtrasTests: XCTestCase {
    private var managers: [VoiceChatManager] = []

    override func tearDown() async throws {
        for m in managers { m.shutdown() }
        managers = []
    }

    private func handler(_ state: TournamentState, _ app: AppState = AppState()) -> TournamentSocketHandler {
        TournamentSocketHandler(socket: SocketService.shared, tournamentState: state, gameState: GameState(),
                                appState: app, safetyState: SafetyState())
    }

    // MARK: - Rounds

    func testRoundCountsAreTheServersOneToFive() {
        XCTAssertEqual(TournamentRounds.counts, [1, 2, 3, 4, 5])
        XCTAssertEqual(TournamentRounds.defaultCount, 4)
        for n in 1...5 { XCTAssertEqual(TournamentRounds.count(n), n) }
        // what the server's Joi refuses is never taken from the wire either
        for bad: Any? in [0, 6, -1, 2.5, "3", nil, NSNull(), true, false, [3]] {
            XCTAssertNil(TournamentRounds.count(bad), "\(String(describing: bad))")
        }
        // JSON-parsed numbers (NSNumber), as the socket hands them over
        let parsed = try? JSONSerialization.jsonObject(with: Data(#"{"a":1,"b":true,"c":5.0}"#.utf8)) as? [String: Any]
        XCTAssertEqual(TournamentRounds.count(parsed?["a"]), 1, "1 is a count, not a boolean")
        XCTAssertNil(TournamentRounds.count(parsed?["b"]), "a JSON true is not 1 round")
        XCTAssertEqual(TournamentRounds.count(parsed?["c"]), 5)
    }

    func testTheRoundLineAndTheCardFollowTheCount() {
        XCTAssertEqual(TournamentRounds.label(1), "1 round")
        XCTAssertEqual(TournamentRounds.label(3), "3 rounds")
        XCTAssertEqual(TournamentRounds.roundLine(phase: "lobby", currentRound: 0, totalRounds: 3), "Waiting to start · 3 rounds")
        XCTAssertEqual(TournamentRounds.roundLine(phase: "lobby", currentRound: 0, totalRounds: 1), "Waiting to start · 1 round")
        XCTAssertEqual(TournamentRounds.roundLine(phase: "round_active", currentRound: 2, totalRounds: 3), "Round 2 of 3")
        XCTAssertEqual(TournamentRounds.roundLine(phase: "between_rounds", currentRound: 2, totalRounds: 5), "Round 2 of 5 complete")
        XCTAssertEqual(TournamentRounds.roundLine(phase: "complete", currentRound: 3, totalRounds: 3), "Tournament complete")
        XCTAssertEqual(TournamentRounds.lobbyCardLine(totalRounds: 2), "Waiting to start · 2 rounds")
        XCTAssertEqual(TournamentRounds.lobbyCardLine(totalRounds: 0), "Waiting to start", "an odd count: no number")
        XCTAssertEqual(TournamentRounds.changedLine(by: "kim", to: 1), "kim set the tournament to 1 round.")
        XCTAssertEqual(TournamentRounds.changedLine(by: "kim", to: 3), "kim set the tournament to 3 rounds.")
        XCTAssertEqual(TournamentRounds.columns(3), 1...3)
        XCTAssertEqual(TournamentRounds.columns(0), 1...1, "never 1...0, which traps")
    }

    func testOnlyTheHostSeesThePickerAndOnlyInTheLobby() {
        XCTAssertTrue(TournamentRounds.showsPicker(phase: "lobby", isCreator: true, isSpectator: false))
        XCTAssertFalse(TournamentRounds.showsPicker(phase: "lobby", isCreator: false, isSpectator: false), "a member")
        XCTAssertFalse(TournamentRounds.showsPicker(phase: "lobby", isCreator: true, isSpectator: true), "a spectator")
        for phase in ["round_active", "between_rounds", "complete", "cut"] {
            XCTAssertFalse(TournamentRounds.showsPicker(phase: phase, isCreator: true, isSpectator: false), phase)
        }
    }

    func testSettingsUpdatedSetsTheCountForTheTournamentImIn() {
        let state = TournamentState()
        let h = handler(state)
        // in no tournament (a late copy after leaving): nothing
        h.handleSettingsUpdated(["totalRounds": 2, "by": "kim"])
        XCTAssertEqual(state.totalRounds, 4)
        state.loadFromServerState(["tournamentId": "t1", "phase": "lobby", "totalRounds": 4, "isReady": true])
        state.isReady = true
        h.handleSettingsUpdated(["totalRounds": 2, "by": "kim"])
        XCTAssertEqual(state.totalRounds, 2)
        XCTAssertTrue(state.isReady, "ready flags are kept (the server keeps them)")
        h.handleSettingsUpdated(["totalRounds": 9, "by": "kim"])
        XCTAssertEqual(state.totalRounds, 2, "a count outside 1...5 is ignored")
        h.handleSettingsUpdated(["by": "kim"])
        XCTAssertEqual(state.totalRounds, 2)
        XCTAssertFalse(state.applyTotalRounds(2), "the same count: no change")
        XCTAssertTrue(state.applyTotalRounds(5))
        // a full state with an odd count takes the default; a reset too
        state.loadFromServerState(["tournamentId": "t1", "totalRounds": 0])
        XCTAssertEqual(state.totalRounds, 4)
        state.loadFromServerState(["tournamentId": "t1", "totalRounds": 1])
        XCTAssertEqual(state.totalRounds, 1)
        state.reset()
        XCTAssertEqual(state.totalRounds, 4)
    }

    func testTheContractListsTheEventsForSwift() {
        XCTAssertEqual(SocketEvents.Client.setTournamentRounds, "setTournamentRounds")
        XCTAssertEqual(SocketEvents.Server.tournamentSettingsUpdated, "tournamentSettingsUpdated")
        XCTAssertEqual(SocketEvents.Server.tournamentVoiceStatus, "tournamentVoiceStatus")
    }

    // MARK: - Voice is full

    func testTheCapIsSent() {
        let caps = ClientHello.payload(version: "1.2.7", build: "41")["caps"] as? [String]
        XCTAssertEqual(caps?.filter { $0 == "tournamentVoiceStatus" }.count, 1, "only a socket with the cap is told")
        XCTAssertEqual(TournamentVoice.statusCap, "tournamentVoiceStatus")
        XCTAssertLessThanOrEqual(caps?.count ?? 99, 16, "the contract's maxItems")
    }

    func testTheNoticeWords() {
        XCTAssertEqual(TournamentVoice.fullNote(cap: 8), "Voice is full (8 people)")
        XCTAssertEqual(TournamentVoice.fullNote(cap: 20), "Voice is full (20 people)")
        XCTAssertEqual(TournamentVoice.fullNote(cap: 0), "Voice is full")
        XCTAssertEqual(TournamentVoice.fullNote(cap: nil), "Voice is full")
        XCTAssertEqual(TournamentVoice.roomCap(12), 12)
        for bad: Any? in [1, 21, "8", true, nil, 2.5] { XCTAssertNil(TournamentVoice.roomCap(bad), "\(String(describing: bad))") }
    }

    func testVoiceStatusShowsWhileWaitingAndClearsWhenLetIn() {
        let state = TournamentState()
        let app = AppState()
        let h = handler(state, app)
        state.loadFromServerState(["tournamentId": "t1", "phase": "lobby"])
        // off the lobby screen (the web's rule): nothing
        app.screen = .mainRoom
        h.handleVoiceStatus(["admitted": false, "cap": 20])
        XCTAssertNil(state.voiceFullCap)
        app.screen = .tournamentLobby
        h.handleVoiceStatus(["admitted": false, "cap": 20])
        XCTAssertEqual(state.voiceFullCap, 20)
        // told again on a redraw: unchanged
        h.handleVoiceStatus(["admitted": false, "cap": 20])
        XCTAssertEqual(state.voiceFullCap, 20)
        h.handleVoiceStatus(["admitted": true, "cap": 20])
        XCTAssertNil(state.voiceFullCap, "let in")
        // an odd cap still says the room is full
        h.handleVoiceStatus(["admitted": false, "cap": "lots"])
        XCTAssertEqual(state.voiceFullCap, 0)
        XCTAssertEqual(TournamentVoice.fullNote(cap: state.voiceFullCap), "Voice is full")
        // a payload without admitted is not one
        h.handleVoiceStatus(["cap": 8])
        XCTAssertEqual(state.voiceFullCap, 0)
        state.reset()
        XCTAssertNil(state.voiceFullCap, "forgotten with the screen")
    }

    // MARK: - Tournament history

    private func result(_ overrides: [String: Any] = [:]) -> [String: Any] {
        var r: [String: Any] = ["id": "t1", "name": "Sunday Cup", "completedAt": "2026-11-24T21:15:00.000Z", "totalRounds": 3,
                                "players": 6, "place": 2, "won": false, "winners": ["kim"], "cutWinner": NSNull()]
        for (k, v) in overrides { r[k] = v }
        return r
    }

    func testHistoryIsReadLeniently() throws {
        let profile: [String: Any] = [
            "username": "ivy",
            "tournaments": ["played": 6, "won": 2, "recent": [
                result(["won": true, "place": 1, "winners": ["ivy", "kim"], "cutWinner": "ivy"]),
                "junk",
                result(["id": "t2", "place": NSNull(), "players": "x", "totalRounds": -1, "completedAt": "not a date"]),
                result(["id": "t3"]), result(["id": "t4"]), result(["id": "t5"]), result(["id": "t6"]),
            ]] as [String: Any],
            "cutForABuck": ["wins": 2, "played": 3],
        ]
        let h = try XCTUnwrap(TournamentHistory(profile: profile))
        XCTAssertEqual([h.played, h.won, h.cutWins, h.cutPlayed], [6, 2, 2, 3])
        XCTAssertEqual(h.recent.map(\.id), ["t1", "t2", "t3", "t4", "t5"], "a bad entry dropped, at most 5")
        XCTAssertEqual(h.recent[0].cutWinner, "ivy")
        XCTAssertNotNil(h.recent[0].completedAt)
        let odd = h.recent[1]
        XCTAssertNil(odd.place)
        XCTAssertNil(odd.completedAt)
        XCTAssertEqual([odd.players, odd.totalRounds], [0, 0])
        XCTAssertFalse(h.isEmpty)
        // a server from before the history: nil; zeros: empty (no section)
        XCTAssertNil(TournamentHistory(profile: ["username": "ivy"]))
        let zeros = try XCTUnwrap(TournamentHistory(profile: ["tournaments": ["played": 0, "won": 0, "recent": []],
                                                              "cutForABuck": ["wins": 0, "played": 0]]))
        XCTAssertTrue(zeros.isEmpty)
        // only a cut (a member who never finished a tournament can still have taken part in a cut? never
        // on this server, but the web shows the section then too)
        XCTAssertFalse(try XCTUnwrap(TournamentHistory(profile: ["cutForABuck": ["wins": 0, "played": 1]])).isEmpty)
        let junk = try XCTUnwrap(TournamentHistory(profile: ["tournaments": "x", "cutForABuck": ["wins": -3, "played": true]]))
        XCTAssertEqual([junk.played, junk.cutWins, junk.cutPlayed], [0, 0, 0])
    }

    func testHistoryWordsMatchTheWebs() throws {
        typealias C = TournamentHistoryCopy
        XCTAssertEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(C.ordinal),
                       ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"])
        func r(_ o: [String: Any]) throws -> TournamentHistory.Result {
            try XCTUnwrap(TournamentHistory(profile: ["tournaments": ["played": 1, "won": 0, "recent": [result(o)]]])?.recent.first)
        }
        XCTAssertEqual(C.resultLabel(try r(["won": true, "winners": ["ivy"]])), "Won")
        XCTAssertEqual(C.resultLabel(try r(["won": true, "winners": ["ivy", "kim"]])), "Won (tied)")
        XCTAssertEqual(C.resultLabel(try r([:])), "2nd of 6")
        XCTAssertEqual(C.resultLabel(try r(["players": 0])), "2nd")
        XCTAssertEqual(C.resultLabel(try r(["place": NSNull()])), "Finished")
        // the owner's rule (2026-11-25): lowercase mid-sentence, the capital only where the line starts
        XCTAssertEqual(C.cutLine(try r(["cutWinner": "ivy"]), username: "ivy"), "Won cut for a buck")
        XCTAssertEqual(C.cutLine(try r(["cutWinner": "kim"]), username: "ivy"), "Cut for a buck: kim")
        XCTAssertNil(C.cutLine(try r([:]), username: "ivy"))
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertEqual(C.meta(try r([:]), locale: Locale(identifier: "en_US"), timeZone: utc), "Nov 24, 2026 · 6 players · 3 rounds")
        XCTAssertEqual(C.meta(try r(["completedAt": NSNull(), "totalRounds": 1]), locale: Locale(identifier: "en_US"), timeZone: utc),
                       "6 players · 1 round")
        XCTAssertEqual(C.cutStat(TournamentHistory(played: 3, cutWins: 1, cutPlayed: 4)), "1 of 4")
        XCTAssertNil(C.cutStat(TournamentHistory(played: 3)), "no cut played: no cut stat")
        XCTAssertEqual(C.spoken(try r(["cutWinner": "kim", "completedAt": NSNull()]), username: "ivy"),
                       "Sunday Cup, 2nd of 6, 6 players · 3 rounds, Cut for a buck: kim")
        // never a money word or a team number in what the section says
        for text in [C.title, C.played, C.won, C.cut, C.recent, C.wonCut, C.cutBy("kim")] {
            XCTAssertNil(text.range(of: #"\$|dollar|money|Team \d"#, options: .regularExpression), text)
        }
    }

    func testTheProfileRepliesCarryTheHistory() throws {
        let reply: [String: Any] = ["success": true, "scope": "human", "profile": [
            "username": "kim", "profilePic": 3, "customProfilePic": NSNull(), "stats": [:],
            "tournaments": ["played": 3, "won": 1, "recent": [result([:])]], "cutForABuck": ["wins": 1, "played": 1],
        ] as [String: Any]]
        let p = try XCTUnwrap(PlayerProfile.from(response: reply))
        XCTAssertEqual(p.tournaments?.played, 3)
        XCTAssertEqual(p.tournaments?.cutPlayed, 1)

        // mine: kept from every success, whatever the scope; another account starts from nothing
        let state = ProfileState()
        state.sendOwn = { _ in }
        state.requestOwn(username: "kim", scope: .human)
        state.applyOwn(response: reply)
        XCTAssertEqual(state.ownTournaments?.won, 1)
        var bots = reply
        bots["scope"] = "bots"
        state.requestOwn(username: "kim", scope: .bots)
        state.applyOwn(response: bots)
        XCTAssertEqual(state.ownTournaments?.played, 3, "the same in every scope")
        state.requestOwn(username: "ora", scope: .human)
        XCTAssertNil(state.ownTournaments, "another account")

        // another player's
        state.sendPlayer = { _, _ in }
        state.view("kim", scope: .human)
        state.applyPlayer(response: reply)
        XCTAssertEqual(state.viewed?.tournaments?.recent.count, 1)
    }

    // MARK: - Speaking poll

    func testThePollSlowsPastEightCalls() {
        XCTAssertEqual(SpeakingPoll.interval(calls: 0), 0.1)
        XCTAssertEqual(SpeakingPoll.interval(calls: 8), 0.1, "the tournament room's default of 8 people: 7 calls")
        XCTAssertEqual(SpeakingPoll.interval(calls: 9), 0.2)
        XCTAssertEqual(SpeakingPoll.interval(calls: 19), 0.2, "a room of 20")
        XCTAssertGreaterThanOrEqual(SpeakingPoll.hold, 2 * SpeakingPoll.busyInterval, "two polls inside the hold")
    }

    func testLevelsComeFromTheRightStats() {
        func s(_ type: String, _ values: [String: NSObject]) -> (type: String, values: [String: NSObject]) { (type, values) }
        let audio = "audio" as NSString, video = "video" as NSString
        let inbound = [s("inbound-rtp", ["kind": audio, "audioLevel": NSNumber(value: 0.2)]),
                       s("inbound-rtp", ["kind": video, "audioLevel": NSNumber(value: 0.9)]),
                       s("codec", ["audioLevel": NSNumber(value: 0.8)]),
                       s("inbound-rtp", ["kind": audio])]
        XCTAssertEqual(SpeakingPoll.inboundLevel(inbound), 0.2, accuracy: 1e-6)
        XCTAssertEqual(SpeakingPoll.outboundLevel(inbound), 0)
        let outbound = [s("outbound-rtp", ["kind": audio, "audioLevel": NSNumber(value: 0.05)]),
                        s("media-source", ["kind": audio, "audioLevel": NSNumber(value: 0.3)])]
        XCTAssertEqual(SpeakingPoll.outboundLevel(outbound), 0.3, accuracy: 1e-6)
        XCTAssertEqual(SpeakingPoll.inboundLevel(outbound), 0)
        XCTAssertEqual(SpeakingPoll.inboundLevel([]), 0)
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 15, _ condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > end { return XCTFail("timed out: \(what)") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    /// A real in-process call (ToneAudioDevice: a tone into amy's microphone): bob's ring for
    /// amy and amy's own come from the per-receiver and per-sender stats, never a whole report.
    func testSpeakingIsSeenThroughEachCallsOwnStats() async throws {
        var offers: [RTCSessionDescription] = [], answers: [RTCSessionDescription] = []
        let da = ToneAudioDevice(), db = ToneAudioDevice()
        var amyRef: VoiceChatManager?, bobRef: VoiceChatManager?
        var amyCandidates: [RTCIceCandidate] = []
        var bobHasOffer = false
        let amy = VoiceChatManager.silent(sendOffer: { _, sdp, _ in offers.append(sdp) },
                                          sendIceCandidate: { _, c in
                                              if bobHasOffer { bobRef?.handleIceCandidate(fromSocketId: "A", candidate: c) }
                                              else { amyCandidates.append(c) }
                                          },
                                          audioDevice: da)
        let bob = VoiceChatManager.silent(sendAnswer: { _, sdp in answers.append(sdp) },
                                          sendIceCandidate: { _, c in amyRef?.handleIceCandidate(fromSocketId: "B", candidate: c) },
                                          audioDevice: db)
        amyRef = amy
        bobRef = bob
        managers = [amy, bob]
        try await amy.initialize()
        try await bob.initialize()
        XCTAssertEqual(amy.speakingPollPeriod, 0.1)
        amy.unmute()
        try await waitUntil("amy unmuted") { !amy.isSelfMuted }
        amy.connectToPeer("B", username: "bob")
        try await waitUntil("amy's offer") { offers.count == 1 }
        bob.handleOffer(fromSocketId: "A", offer: offers[0], username: "amy")
        bobHasOffer = true
        for c in amyCandidates { bob.handleIceCandidate(fromSocketId: "A", candidate: c) }
        try await waitUntil("bob's answer") { answers.count == 1 }
        amy.handleAnswer(fromSocketId: "B", answer: answers[0])
        try await waitUntil("bob plays amy's tone") { db.peakLevel > 0.02 }
        try await waitUntil("bob sees amy talking") { bob.speakingPeers.contains("A") }
        try await waitUntil("amy sees herself talking") { amy.isSelfSpeaking }
        XCTAssertGreaterThan(bob.speakingStatsRequests.receiver, 0)
        XCTAssertGreaterThan(amy.speakingStatsRequests.sender, 0)
        XCTAssertFalse(bob.speakingPeers.contains("self"))
        amy.mute()
        try await waitUntil("bob's ring goes off after the hold", timeout: 5) { !bob.speakingPeers.contains("A") }
        XCTAssertFalse(amy.isSelfSpeaking)
    }

    /// Nine calls (a room of 10) slow the poll to 200 ms; back to 100 ms at eight.
    func testNineCallsSlowThePoll() async throws {
        let m = VoiceChatManager.silent()
        managers = [m]
        try await m.initialize()
        XCTAssertEqual(m.speakingPollPeriod, 0.1)
        for i in 1...9 { m.connectToPeer("P\(i)", username: "p\(i)") }
        try await waitUntil("the poll slowed") { m.speakingPollPeriod == 0.2 }
        let sent = m.speakingStatsRequests.receiver
        try await Task.sleep(nanoseconds: 1_000_000_000)
        // at most one request in flight per call: never more than 9 calls x 5 polls in a second
        XCTAssertLessThanOrEqual(m.speakingStatsRequests.receiver - sent, 9 * 6)
        m.removePeer("P9")
        try await waitUntil("back to 100 ms") { m.speakingPollPeriod == 0.1 }
    }
}
