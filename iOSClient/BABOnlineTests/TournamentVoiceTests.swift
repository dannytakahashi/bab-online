import AVFoundation
import XCTest
@preconcurrency import WebRTC
@testable import BAB_Online

/// Tournament voice (owner 2026-11-24, iOS 1.2.6; docs/claude/voice.md "Tournament voice"): the
/// clientHello cap, who is in the tournament room (`VoiceCompany.tournament`, from the tournament
/// payloads), the room changes lobby -> table -> lobby -> next table -> results / cancel
/// (`TournamentVoice`, either onAppear / onDisappear order), a table offer that comes before
/// the seating (`VoiceGate.peerOffered`), and voice's audio session claimed only by a call, so
/// a session with nobody to talk to never changes the table sounds (`ownsAudioSession`).
@MainActor
final class TournamentVoiceTests: XCTestCase {

    // MARK: - The cap

    func testClientHelloSendsTheTournamentVoiceCap() {
        XCTAssertEqual(TournamentVoice.cap, "tournamentVoice")
        let caps = ClientHello.payload(version: "1.2.6", build: "40")["caps"] as? [String]
        XCTAssertEqual(caps?.contains("tournamentVoice"), true)
        XCTAssertEqual(caps?.filter { $0 == "tournamentVoice" }.count, 1)
        // the older caps stay (the server reads each on its own)
        for cap in ["avatarUrl", "casualSpectators", "playAgain", "assist", "tutorial", "shoulderView"] {
            XCTAssertEqual(caps?.contains(cap), true, cap)
        }
        XCTAssertLessThanOrEqual(caps?.count ?? 99, 16, "the contract's maxItems")
    }

    // MARK: - Who is in the tournament room

    func testTheRoomsCompanyIsWhoTheServerAnnounced() {
        XCTAssertFalse(VoiceCompany.tournament(announced: [], me: "me"), "nobody announced: alone")
        XCTAssertFalse(VoiceCompany.tournament(announced: ["me"], me: "me"), "my own name (another device)")
        XCTAssertTrue(VoiceCompany.tournament(announced: ["amy"], me: "me"))

        let m = VoiceChatManager.silent()
        managers.append(m)
        XCTAssertFalse(m.tournamentCompany(me: "me"))
        m.noteAnnounced("A", username: "amy")   // voicePeerList (I offer) or voicePeerJoined (she does)
        m.noteAnnounced("B", username: "bob")
        XCTAssertTrue(m.tournamentCompany(me: "me"))
        m.removePeer("A")                       // voicePeerLeft: seated at a table, left, dropped
        XCTAssertTrue(m.tournamentCompany(me: "me"), "bob is still here")
        m.removePeer("B")
        XCTAssertFalse(m.tournamentCompany(me: "me"))
        m.noteAnnounced("C", username: "cat")
        m.changeRoom()
        XCTAssertFalse(m.tournamentCompany(me: "me"), "a room change forgets the old room's people")
    }

    func testOnlyAMemberWantsTournamentVoice() {
        let t = TournamentState()
        XCTAssertFalse(TournamentVoice.wantsVoice(t), "no tournament")
        t.tournamentId = "t1"
        XCTAssertTrue(TournamentVoice.wantsVoice(t))
        t.isSpectator = true
        XCTAssertFalse(TournamentVoice.wantsVoice(t), "a spectator is not in the room")
    }

    /// tournamentJoined / tournamentCreated / tournamentGameAssignment change the room in the
    /// socket's event order: the old room's calls and buffered peers end before the new room's
    /// announcements (which follow those events) arrive.
    func testTheTournamentEventsChangeTheRoom() async throws {
        let m = VoiceChatManager.silent()
        managers.append(m)
        let tournament = TournamentState()
        let app = AppState()
        let handler = TournamentSocketHandler(socket: SocketService.shared, tournamentState: tournament, gameState: GameState(),
                                              appState: app, safetyState: SafetyState(), voice: { m })
        m.ensureStarted()
        m.setCompany(true, from: .table)
        try await waitUntil("voice at the table") { m.isActive }
        m.noteAnnounced("A", username: "amy")
        m.connectToPeer("A", username: "amy")

        handler.handleTournamentJoined(["tournamentId": "t1", "phase": "between_rounds", "players": [["username": "me"]]])
        XCTAssertEqual(app.screen, .tournamentLobby)
        XCTAssertFalse(m.isActive, "the table's calls ended")
        XCTAssertFalse(m.tournamentCompany(me: "me"))
        XCTAssertNil(m.gate.company, "no screen's word about the old room counts")
        XCTAssertTrue(m.gate.wanted, "still wanted: the tournament lobby's voice starts with its company")

        // the room's list right after (buffered: voice not running yet), then the lobby's word
        m.noteAnnounced("B", username: "bob")
        m.connectToPeer("B", username: "bob")
        XCTAssertEqual(m.bufferedCount, 1)
        // the table's onDisappear comes late (after the list): nothing is torn down
        XCTAssertTrue(TournamentVoice.tableGone(screen: .tournamentLobby, tournament: tournament, voice: m))
        XCTAssertEqual(m.bufferedCount, 1, "the room's list survives the table's exit")
        m.setCompany(m.tournamentCompany(me: "me"), from: .tournament)
        try await waitUntil("voice in the tournament room") { m.isActive }
        try await waitUntil("the buffered peer offered at the start") { m.bufferedCount == 0 }
    }

    /// SwiftUI's `.onChange(of:initial:)`: the action runs when a render sees a value other
    /// than the last render's (and once at the mount); values in between are never seen.
    @MainActor
    final class OnChangeProbe<Value: Equatable> {
        private var last: Value?
        func render(_ value: Value, _ action: (Value) -> Void) {
            guard last != value else { return }
            last = value
            action(value)
        }
    }

    /// A reconnect with the tournament lobby on screen (review 2026-11-24): the restore's
    /// joinTournament answers tournamentJoined (a room change: the calls and the announced
    /// members go) and the room's voicePeerList right after names the same members again, both
    /// handled before the next render. The lobby stays mounted (the screen was already
    /// `.tournamentLobby`), so only its onChange key tells the gate about the room again: a key
    /// that reads the same before and after (company true, true) left the gate with no word, so
    /// voice never started and nobody offered (the reconnected member is the one who must).
    func testAReconnectWithTheLobbyOnScreenStartsVoiceAgain() async throws {
        var offeredTo: [String] = []
        let m = VoiceChatManager.silent(sendOffer: { to, _, _ in offeredTo.append(to) })
        managers.append(m)
        let tournament = TournamentState()
        let app = AppState()
        let handler = TournamentSocketHandler(socket: SocketService.shared, tournamentState: tournament, gameState: GameState(),
                                              appState: app, safetyState: SafetyState(), voice: { m })
        let lobbyKey = OnChangeProbe<TournamentVoice.LobbyWord>()
        func render() {  // TournamentLobbyView's two onChange(initial:) handlers
            if TournamentVoice.wantsVoice(tournament) { m.ensureStarted() }
            lobbyKey.render(TournamentVoice.lobbyWord(m, me: "me")) { m.setCompany($0.company, from: .tournament) }
        }
        let joined: [String: Any] = ["tournamentId": "t1", "phase": "lobby", "players": [["username": "me"], ["username": "amy"]]]
        func announce(_ sid: String, _ name: String) {  // VoiceSocketHandler's voicePeerList
            m.noteAnnounced(sid, username: name)
            m.connectToPeer(sid, username: name)
        }

        // joined: the lobby mounts, amy is listed, voice starts and offers to her
        handler.handleTournamentJoined(joined)
        XCTAssertEqual(app.screen, .tournamentLobby)
        render()
        announce("A", "amy")
        render()
        try await waitUntil("voice in the tournament room") { m.isActive }
        try await waitUntil("amy offered to") { offeredTo == ["A"] }

        // the reconnect: tournamentJoined, then the same list, both before a render
        handler.handleTournamentJoined(joined)
        XCTAssertFalse(m.isActive, "the room change ended the old socket's calls")
        announce("A", "amy")
        render()
        try await waitUntil("voice in the tournament room again") { m.isActive }
        try await waitUntil("amy offered to again") { offeredTo == ["A", "A"] }
        XCTAssertEqual(m.bufferedCount, 0)
    }

    // MARK: - A table offer before the seating

    @MainActor
    final class Timers {
        var pending: [(delay: TimeInterval, run: @MainActor () -> Void)] = []
        func fire() {
            let all = pending
            pending = []
            for t in all { t.run() }
        }
    }

    func testAnOfferWhileTheTableIsNotKnownYetStartsVoice() {
        let timers = Timers()
        var running = false, starts = 0, suspends = 0
        let g = VoiceGate(isRunning: { running }, start: { starts += 1; running = true },
                          suspend: { suspends += 1; running = false },
                          after: { delay, run in timers.pending.append((delay, run)) })
        g.peerOffered()
        XCTAssertEqual(starts, 0, "not wanted (the main room)")
        g.want()
        g.setCompany(false, from: .table)
        g.peerOffered()
        XCTAssertEqual(starts, 0, "alone is known: an offer does not override it")
        g.setCompany(nil, from: .table)
        g.peerOffered()
        XCTAssertEqual(starts, 1, "the draw of a tournament table: the offerer is company")
        g.peerOffered()
        XCTAssertEqual(starts, 1, "running: once")
        // the seating says alone after all (an offer from a peer that left meanwhile): the grace
        g.setCompany(false, from: .table)
        XCTAssertEqual(timers.pending.map(\.delay), [VoiceCompany.grace])
        timers.fire()
        XCTAssertEqual(suspends, 1)
    }

    private var managers: [VoiceChatManager] = []

    override func tearDown() async throws {
        for m in managers { m.shutdown() }
        managers = []
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 10, _ condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > end { return XCTFail("timed out: \(what)") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    /// Item 2 of the tournament voice task: a table-mate's offer that arrives at the round start
    /// (before positionUpdate, which comes after the draw: up to ~35 s with the 30 s auto-draw,
    /// past the offerer's 20 s connect timer) is answered at once, not at the seating.
    func testATableMatesOfferBeforeTheSeatingIsAnsweredAtOnce() async throws {
        var offers: [RTCSessionDescription] = []
        var answers: [String] = []
        let peer = VoiceChatManager.silent(sendOffer: { _, sdp, _ in offers.append(sdp) })
        let me = VoiceChatManager.silent(sendAnswer: { to, _ in answers.append(to) })
        managers += [peer, me]
        // my table screen: wants voice, the draw has not said who sits here (nil)
        me.ensureStarted()
        me.setCompany(nil, from: .table)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(me.isActive, "nothing known yet: held")

        try await peer.initialize()
        peer.connectToPeer("ME", username: "me")
        try await waitUntil("the peer's offer") { offers.count == 1 }
        me.handleOffer(fromSocketId: "AMY", offer: offers[0], username: "amy")
        try await waitUntil("my answer, before any seating") { answers == ["AMY"] }
        XCTAssertTrue(me.isActive)
        XCTAssertTrue(me.isSelfMuted, "muted, as every start")
        XCTAssertEqual(me.bufferedCount, 0)

        // the seating (positionUpdate) then says amy is here: nothing restarts
        me.setCompany(true, from: .table)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(answers, ["AMY"])
    }

    // MARK: - Room changes

    /// lobby -> table -> lobby -> next table -> back -> main room, as the events and the screens
    /// run them, with the new screen's onAppear before (`appearFirst`) or after the old one's
    /// onDisappear.
    private func roomChanges(appearFirst: Bool) async throws {
        var offeredTo: [String] = []
        let m = VoiceChatManager.silent(sendOffer: { to, _, _ in offeredTo.append(to) })
        managers.append(m)
        let t = TournamentState()
        t.tournamentId = "t1"

        func showLobby() {  // TournamentLobbyView's onChange(initial:) of wantsVoice and company
            if TournamentVoice.wantsVoice(t) { m.ensureStarted() }
            m.setCompany(m.tournamentCompany(me: "me"), from: .tournament)
        }
        func lobbyGone(to screen: AppState.Screen) {
            TournamentVoice.lobbyGone(screen: screen, watching: false, voice: m)
        }
        func showTable() {  // GameContainerView's onAppear + TableVoiceCompany before seating
            m.ensureStarted()
            m.setCompany(nil, from: .table)
        }
        func tableGone() {  // GameContainerView's onDisappear
            m.clearCompany(from: .table)
            if !TournamentVoice.tableGone(screen: .tournamentLobby, tournament: t, voice: m) { m.shutdown() }
        }
        func toTable() {  // tournamentGameAssignment, allPlayersReady
            m.changeRoom()
            if appearFirst { showTable(); lobbyGone(to: .game) } else { lobbyGone(to: .game); showTable() }
        }
        func backToLobby(announce: [(String, String)]) {  // returnToTournament: tournamentJoined, then the list
            m.changeRoom()
            for (sid, name) in announce { m.noteAnnounced(sid, username: name); m.connectToPeer(sid, username: name) }
            if appearFirst { showLobby(); tableGone() } else { tableGone(); showLobby() }
        }

        // tournamentCreated: the room, then amy joins (voicePeerJoined)
        m.changeRoom()
        showLobby()
        XCTAssertFalse(m.isActive, "alone in the tournament lobby")
        m.noteAnnounced("A", username: "amy")
        m.setCompany(m.tournamentCompany(me: "me"), from: .tournament)
        try await waitUntil("voice in the tournament lobby") { m.isActive }

        // round 1: seated with amy (announced at seating, after positionUpdate)
        toTable()
        XCTAssertFalse(m.isActive, "the tournament room's calls ended at the assignment")
        m.setCompany(true, from: .table)
        try await waitUntil("voice at the table") { m.isActive }

        // back between rounds: the room lists bob
        backToLobby(announce: [("B", "bob")])
        try await waitUntil("voice in the tournament room again") { m.isActive }
        try await waitUntil("bob offered to") { offeredTo == ["B"] }

        // round 2, alone at a table with bots
        toTable()
        m.setCompany(false, from: .table)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(m.isActive, "no voice alone at the table")

        // back, alone in the room (the others still play): no voice
        backToLobby(announce: [])
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(m.isActive, "nobody announced")

        // the results' Return to the main room
        lobbyGone(to: .mainRoom)
        m.setCompany(true, from: .tournament)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(m.isActive, "released: nothing restarts in the main room")
    }

    func testRoomChangesWithTheNewScreenAppearingFirst() async throws {
        try await roomChanges(appearFirst: true)
    }

    func testRoomChangesWithTheOldScreenGoingFirst() async throws {
        try await roomChanges(appearFirst: false)
    }

    func testACancelOrWatchingATableEndsTournamentVoice() async throws {
        let m = VoiceChatManager.silent()
        managers.append(m)
        m.ensureStarted()
        m.setCompany(true, from: .tournament)
        try await waitUntil("started") { m.isActive }
        TournamentVoice.lobbyGone(screen: .mainRoom, watching: false, voice: m)  // tournamentCancelled
        XCTAssertFalse(m.isActive)
        m.setCompany(true, from: .table)
        XCTAssertFalse(m.isActive, "not wanted after a cancel")

        m.ensureStarted()
        m.setCompany(true, from: .tournament)
        try await waitUntil("started again") { m.isActive }
        // a member who watches another table: a tournament table admits no spectator into voice
        TournamentVoice.lobbyGone(screen: .game, watching: true, voice: m)
        m.setCompany(true, from: .table)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(m.isActive)

        // a tournament spectator's way back from a table: the table's own shutdown runs
        let spectator = TournamentState()
        spectator.tournamentId = "t1"
        spectator.isSpectator = true
        XCTAssertFalse(TournamentVoice.tableGone(screen: .tournamentLobby, tournament: spectator, voice: m))
        XCTAssertFalse(TournamentVoice.tableGone(screen: .mainRoom, tournament: TournamentState(), voice: m))
        XCTAssertFalse(TournamentVoice.tableGone(screen: .tournamentLobby, tournament: nil, voice: m))
    }

    // MARK: - The audio session belongs to a call

    func testTheAudioSessionIsClaimedByTheFirstCallAndReleasedAfterTheLast() async throws {
        var configures = 0, deactivates = 0
        var offers: [RTCSessionDescription] = []
        let me = VoiceChatManager.silent(sendOffer: { _, sdp, _ in offers.append(sdp) },
                                         configureAudioSession: { configures += 1 },
                                         deactivateAudioSession: { deactivates += 1 })
        managers.append(me)
        try await me.initialize()
        XCTAssertTrue(me.isActive)
        XCTAssertFalse(me.ownsAudioSession, "a voice start with nobody to talk to leaves the session alone")
        XCTAssertEqual(configures, 0)

        me.connectToPeer("AMY", username: "amy")
        XCTAssertTrue(me.ownsAudioSession, "the first call takes it, before its offer")
        XCTAssertEqual(configures, 1)
        me.connectToPeer("BOB", username: "bob")
        XCTAssertEqual(configures, 1, "once")

        me.removePeer("AMY")
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(me.ownsAudioSession, "bob's call still runs")
        me.removePeer("BOB")
        XCTAssertTrue(me.ownsAudioSession, "released a turn later (a restart closes and makes a call in one turn)")
        try await waitUntil("released") { !me.ownsAudioSession }
        XCTAssertEqual(deactivates, 1)
        XCTAssertTrue(me.isActive, "voice runs on (the grace, a newcomer's offer)")

        // a replaced offer closes and re-makes the call in one turn: never released between
        me.connectToPeer("CAT", username: "cat")
        XCTAssertEqual(configures, 2)
        try await waitUntil("cat's offer") { offers.count >= 3 }
        var otherOffers: [RTCSessionDescription] = []
        let offerer = VoiceChatManager.silent(sendOffer: { _, sdp, _ in otherOffers.append(sdp) })
        managers.append(offerer)
        try await offerer.initialize()
        offerer.connectToPeer("ME", username: "me")
        try await waitUntil("an offer from cat's new socket") { otherOffers.count == 1 }
        me.handleOffer(fromSocketId: "CAT", offer: otherOffers[0], username: "cat")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(me.ownsAudioSession)
        XCTAssertEqual(deactivates, 1, "no release around the replaced call")

        me.shutdown()
        XCTAssertFalse(me.ownsAudioSession)
        XCTAssertEqual(deactivates, 2)
        me.shutdown()
        XCTAssertEqual(deactivates, 2, "nothing to release twice")
    }

    func testAShutdownWithNoCallNeverTouchesTheSession() async throws {
        var configures = 0, deactivates = 0
        let me = VoiceChatManager.silent(configureAudioSession: { configures += 1 },
                                         deactivateAudioSession: { deactivates += 1 })
        managers.append(me)
        try await me.initialize()
        me.suspend()
        try await me.initialize()
        me.shutdown()
        XCTAssertEqual(configures, 0)
        XCTAssertEqual(deactivates, 0)
    }

    func testAFailedActivationStillCountsAsVoicesSession() async throws {
        struct Refused: Error {}
        let me = VoiceChatManager.silent(configureAudioSession: { throw Refused() })
        managers.append(me)
        try await me.initialize()
        me.connectToPeer("AMY", username: "amy")
        XCTAssertTrue(me.ownsAudioSession, "WebRTC sets the same session for the call's playout: sounds stay off it")
        XCTAssertTrue(me.isActive)
    }

    /// A refused activation (an offer during a cellular call: insufficient priority; or in the
    /// seconds after a background) is tried again (review 2026-11-24): at the next call's claim
    /// and at the foreground while a call runs, instead of never until every call closed.
    func testARefusedActivationIsTriedAgain() async throws {
        struct Refused: Error {}
        var refuse = true, configures = 0, deactivates = 0
        let me = VoiceChatManager.silent(configureAudioSession: {
            configures += 1
            if refuse { throw Refused() }
        }, deactivateAudioSession: { deactivates += 1 })
        managers.append(me)
        try await me.initialize()
        me.connectToPeer("AMY", username: "amy")
        XCTAssertEqual(configures, 1)
        XCTAssertTrue(me.ownsAudioSession)

        // the next call's claim tries again (still refused)
        me.connectToPeer("BOB", username: "bob")
        XCTAssertEqual(configures, 2, "a refused activation is tried again at the next claim")

        // back in the foreground with calls running: tried again, and it goes through
        refuse = false
        me.handleBackground()
        me.handleForeground()
        XCTAssertEqual(configures, 3, "the foreground tries again while a call runs")

        // through: no more tries
        me.connectToPeer("CAT", username: "cat")
        me.handleBackground()
        me.handleForeground()
        XCTAssertEqual(configures, 3, "once active, a claim or a foreground does not set it again")

        me.shutdown()
        XCTAssertEqual(deactivates, 1)
        XCTAssertFalse(me.ownsAudioSession)
    }

    /// The owner's report (2026-11-24): voice ran at a tournament table with nobody to talk to
    /// and every card sound went through voice's session. Now the sounds keep `.ambient` until a
    /// call starts, and get it back after the last call.
    func testTableSoundsKeepTheAmbientSessionUntilACallStarts() async throws {
        let session = FakeSession(category: .soloAmbient)
        let out = RecordingOutput()
        let clock = SoundClock()
        let voice = VoiceChatManager.silent()
        managers.append(voice)
        let defaults = UserDefaults(suiteName: "TournamentVoiceTests-\(UUID().uuidString)")!
        let sounds = SoundPlayer(output: out, session: session, defaults: defaults, isAppActive: { true },
                                 isVoiceActive: { voice.ownsAudioSession }, now: { clock.t })
        try await voice.initialize()
        sounds.play(.card)
        XCTAssertEqual(session.category, .ambient, "voice running with nobody: the sounds' own session")
        XCTAssertEqual(session.ambientCalls, 1)
        XCTAssertEqual(out.played.first?.volume ?? 0, SoundPlayer.defaultVolume, accuracy: 0.0001, "the base level, unchanged")

        voice.connectToPeer("AMY", username: "amy")
        session.category = .playAndRecord  // what voice's session would set
        let reads = session.categoryReads
        clock.t = 1
        sounds.play(.card)
        XCTAssertEqual(session.categoryReads, reads, "a call owns the session: not even read")

        voice.removePeer("AMY")
        try await waitUntil("released") { !voice.ownsAudioSession }
        clock.t = 2
        sounds.play(.card)
        XCTAssertEqual(session.category, .ambient, "the last call gone: ambient again")
        XCTAssertEqual(out.played.count, 3)
    }
}
