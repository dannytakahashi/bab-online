import XCTest
@preconcurrency import WebRTC
@testable import BAB_Online

/// Family lobbies of up to 8 and spectator voice (1.2.2, build 12; the server's PR A:
/// GameManager.lobbyWire / getAllLobbies({wide}), server/voice/gameVoice.js). Every payload
/// here is shaped as the server sends it to a socket with the casualSpectators cap, and
/// each additive key is also left out (an older server: today's behavior).
final class FamilyLobbyTests: XCTestCase {
    private func member(_ u: String, ready: Bool = false, playing: Bool? = false, bot: Bool = false, held: Bool = false) -> [String: Any] {
        var m: [String: Any] = ["socketId": bot ? "bot:\(u)" : "sid-\(u)", "username": u, "ready": ready]
        if let playing { m["playing"] = playing }
        if bot { m["isBot"] = true }
        if held { m["reconnecting"] = true }
        return m
    }

    // MARK: - Main-room cards (Lobby)

    func testFamilyCardCountsEveryMemberAndRejoinsMemberSeven() throws {
        let eight = ["pat", "ned", "sam", "tia", "uma", "vic", "ivy", "wes"]
        let dict: [String: Any] = ["id": "l2", "name": "Cousins", "playerCount": 4, "maxPlayers": 4,
                                   "players": eight.prefix(4).map { ["username": $0, "ready": false] },
                                   "createdAt": 1, "memberCount": 8, "capacity": 8, "memberUsernames": eight]
        let lobby = try XCTUnwrap(Lobby.from(dict))
        XCTAssertEqual(lobby.countText, "8/8")
        XCTAssertEqual(lobby.action(for: "ivy"), .rejoin, "member 7 is named by memberUsernames, not players")
        XCTAssertEqual(lobby.action(for: "kim"), .full)
        XCTAssertTrue(lobby.memberNames.contains("wes"))

        var six = dict
        six["memberCount"] = 6
        six["memberUsernames"] = Array(eight.prefix(6))
        let open = try XCTUnwrap(Lobby.from(six))
        XCTAssertEqual(open.countText, "6/8")
        XCTAssertEqual(open.action(for: "kim"), .join, "below its capacity a family lobby is open")
    }

    func testCapacityFourCardIsFullAndALegacyEntryReadsAsToday() throws {
        let four = ["abe", "bea", "cal", "dot"]
        let capped = try XCTUnwrap(Lobby.from(["id": "l3", "name": "Old phones", "playerCount": 4, "maxPlayers": 4,
                                               "players": four.map { ["username": $0, "ready": true] },
                                               "memberCount": 4, "capacity": 4, "memberUsernames": four]))
        XCTAssertEqual(capped.countText, "4/4")
        XCTAssertEqual(capped.action(for: "kim"), .full, "a legacy member keeps the lobby at 4")
        XCTAssertEqual(capped.action(for: "cal"), .rejoin)

        // an older server (no additive keys): exactly the 1.2.2 card
        let legacy = try XCTUnwrap(Lobby.from(["id": "l1", "name": "x", "playerCount": 3,
                                               "players": ["a", "b", "c"].map { ["username": $0, "ready": false] }]))
        XCTAssertNil(legacy.capacity)
        XCTAssertEqual(legacy.countText, "3/4")
        XCTAssertEqual(legacy.action(for: "z"), .join)
        XCTAssertEqual(legacy.memberNames, "a, b, c")
        // out-of-range values are ignored, never trusted
        let odd = try XCTUnwrap(Lobby.from(["id": "l9", "name": "x", "playerCount": 2, "players": [], "capacity": 12]))
        XCTAssertEqual(odd.seatsTotal, 4)
    }

    // MARK: - The lobby (LobbyState)

    func testSixMembersFromMembersWithStatusesHostAndSettings() {
        let state = LobbyState()
        let members = [member("ivy"), member("kim", ready: true, playing: true), member("hal", ready: true, playing: true),
                       member("jon"), member("ora"), member("max"), member("🤖 Bot", playing: false, bot: true)]
        state.applyPlayers(from: ["lobbyId": "l1", "players": Array(members.prefix(4)), "members": members,
                                  "host": "ivy", "settings": ["spectatorsCanTalk": true], "capacity": 8], namesHeldSeats: true)
        XCTAssertEqual(state.players.count, 7, "members, not the first 4")
        XCTAssertEqual(state.capacity, 8)
        XCTAssertTrue(state.hasSettings)
        XCTAssertEqual(state.host, "ivy")
        XCTAssertTrue(state.isHost("ivy"))
        XCTAssertFalse(state.isHost("kim"))
        XCTAssertEqual(state.readyAtTable, 2)
        XCTAssertFalse(state.tableFull)
        XCTAssertFalse(state.isFull)
        let status = { (u: String) in LobbySeatStatus.of(state.players.first { $0.username == u }!, in: state.players) }
        XCTAssertEqual(status("kim"), .playing)
        XCTAssertNil(status("jon"), "may still take a seat")
        XCTAssertEqual(status("🤖 Bot"), .sittingOut)
        XCTAssertFalse(state.tableFullWithout("ivy"))

        // the table fills without ivy and max: they will watch, Ready is refused
        let full = [member("ivy"), member("kim", ready: true, playing: true), member("hal", ready: true, playing: true),
                    member("jon", ready: true, playing: true), member("ora", ready: true, playing: true), member("max"),
                    member("🤖 Bot", playing: false, bot: true)]
        state.applyPlayers(from: ["lobbyId": "l1", "players": Array(full.prefix(4)), "members": full,
                                  "host": "ivy", "settings": ["spectatorsCanTalk": false], "capacity": 8], namesHeldSeats: true)
        XCTAssertTrue(state.tableFull)
        XCTAssertEqual(state.readyAtTable, 4)
        XCTAssertEqual(status("ivy"), .willWatch)
        XCTAssertEqual(status("jon"), .playing)
        XCTAssertTrue(state.tableFullWithout("ivy"))
        XCTAssertFalse(state.tableFullWithout("jon"))
        XCTAssertFalse(state.spectatorsCanTalk, "the host's switch")

        // the host left: the role passed on (lobbyPlayerLeft carries members and host)
        state.applyPlayers(from: ["lobbyId": "l1", "players": [], "members": Array(full.dropFirst()), "host": "kim",
                                  "leftUsername": "ivy", "needsMorePlayers": false], namesHeldSeats: false)
        XCTAssertEqual(state.host, "kim")
        XCTAssertEqual(state.players.count, 6)
        XCTAssertFalse(state.spectatorsCanTalk, "settings kept when an event leaves them out")
    }

    func testHeldSeatsComeFromEachMember() {
        let state = LobbyState()
        let members = (1...6).map { member("p\($0)", held: $0 == 6) }
        state.applyPlayers(from: ["lobbyId": "l1", "players": Array(members.prefix(4)), "members": members, "capacity": 8,
                                  "settings": ["spectatorsCanTalk": true]], namesHeldSeats: true)
        XCTAssertEqual(state.reconnecting, ["p6"], "member 6 is held although players stops at 4")
        XCTAssertTrue(state.isReconnecting(state.players[5]))
    }

    func testALegacyPayloadLeavesTheLobbyAsToday() {
        let state = LobbyState()
        // as an older server sends them: no playing
        let players = [member("ivy", ready: true, playing: nil), member("kim", playing: nil), member("🤖 Bot", ready: true, playing: nil, bot: true)]
        state.applyPlayers(from: ["lobbyId": "l1", "players": players], namesHeldSeats: true)
        XCTAssertEqual(state.players.count, 3)
        XCTAssertEqual(state.capacity, 4)
        XCTAssertFalse(state.hasSettings, "no Voice section without the family keys")
        XCTAssertNil(state.host)
        XCTAssertNil(LobbySeatStatus.of(state.players[0], in: state.players))
        XCTAssertEqual(state.readyAtTable, 2)
        state.capacity = 8
        state.reset()
        XCTAssertEqual(state.capacity, 4)
        XCTAssertTrue(state.spectatorsCanTalk)
    }

    // MARK: - The lobby header's count (LobbyCount, LobbyHeaderProbe)

    func testTheHeaderCountIsTheWebsWordsAndVoiceOverHearsItInFull() {
        let state = LobbyState()
        let members = ["ivy", "kim", "hal", "jon"].enumerated().map { member($0.1, ready: $0.0 < 2, playing: $0.0 < 2) }
        state.applyPlayers(from: ["lobbyId": "l1", "players": members, "members": members, "host": "ivy", "capacity": 8,
                                  "settings": ["spectatorsCanTalk": true]], namesHeldSeats: true)
        let count = LobbyCount(state)
        XCTAssertEqual(count.text, "Players 4/8 \u{00B7} Ready 2/4", "GameLobby.js's header")
        XCTAssertEqual(count.parts, ["Players 4/8", "Ready 2/4"])
        XCTAssertEqual(count.spoken, "4 of 8 players, 2 of 4 ready")

        // an older server (no family keys): the count alone, out of 4
        let legacy = LobbyState()
        legacy.applyPlayers(from: ["lobbyId": "l1", "players": [member("ivy", ready: true, playing: nil)]], namesHeldSeats: true)
        XCTAssertEqual(LobbyCount(legacy).text, "Players 1/4")
        XCTAssertEqual(LobbyCount(legacy).spoken, "1 of 4 players")
    }

    func testTheHeaderProbeCatchesACutOffOrCoveredCount() {
        let box = CGRect(x: 0, y: 0, width: 370, height: 44)
        let fits: [String: CGRect] = [
            "form.stacked": box, "leave": CGRect(x: 0, y: 12, width: 60, height: 20),
            "title": CGRect(x: 130, y: 2, width: 120, height: 22), "titleIdeal": CGRect(x: 130, y: 2, width: 120, height: 22),
            "count.0": CGRect(x: 120, y: 26, width: 140, height: 16), "countIdeal.0": CGRect(x: 120, y: 26, width: 140, height: 16),
            "mic": CGRect(x: 326, y: 0, width: 44, height: 44),
        ]
        XCTAssertEqual(LobbyHeaderProbe.check(fits, container: box), "stacked ok")

        // build 12 on an iPhone 17: "4/8 · Rea..." (the count squeezed below its full width)
        var cut = fits
        cut["count.0"] = CGRect(x: 120, y: 26, width: 90, height: 16)
        XCTAssertTrue(LobbyHeaderProbe.check(cut, container: box).contains("count.0 cut off (90 of 140 pt)"))

        var covered = fits
        covered["count.0"] = CGRect(x: 300, y: 10, width: 140, height: 16)
        let check = LobbyHeaderProbe.check(covered, container: box)
        XCTAssertTrue(check.contains("count.0 outside"), check)
        XCTAssertTrue(check.contains("count.0 overlaps mic"), check)

        var twoForms = fits
        twoForms["form.row"] = box
        XCTAssertTrue(LobbyHeaderProbe.check(twoForms, container: box).hasPrefix("row+stacked: 2 forms"))

        // a wrapped title is not cut off; a one-line one is
        var squeezedTitle = fits
        squeezedTitle["title"] = CGRect(x: 130, y: 2, width: 80, height: 22)
        XCTAssertTrue(LobbyHeaderProbe.check(squeezedTitle, container: box).contains("title cut off"))
        squeezedTitle["form.wrapped"] = squeezedTitle.removeValue(forKey: "form.stacked")
        XCTAssertEqual(LobbyHeaderProbe.check(squeezedTitle, container: box), "wrapped ok")
    }

    func testFourMemberFamilyLobbyShowsNoStatuses() {
        let state = LobbyState()
        let members = ["a", "b", "c", "d"].map { member($0, ready: true, playing: true) }
        state.applyPlayers(from: ["lobbyId": "l1", "players": members, "members": members, "host": "a", "capacity": 8,
                                  "settings": ["spectatorsCanTalk": true]], namesHeldSeats: true)
        XCTAssertFalse(state.tableFull, "a lobby of 4 is not a family table")
        XCTAssertNil(LobbySeatStatus.of(state.players[0], in: state.players))
    }

    // MARK: - Restore: watch the casual game again

    @MainActor
    func testRestoreRouteSpectatesTheCasualGameOnScreen() throws {
        XCTAssertEqual(RestoreRoute.of([:], screen: .game, lobbyId: "", spectatingGameId: "g1"), .spectate(gameId: "g1"))
        XCTAssertEqual(RestoreRoute.of(["activeGameId": "g2"], screen: .game, lobbyId: "", spectatingGameId: "g1"),
                       .rejoinGame(gameId: "g2"), "the server's game pointer wins")
        XCTAssertEqual(RestoreRoute.of([:], screen: .mainRoom, lobbyId: "", spectatingGameId: "g1"), .mainRoom)
        XCTAssertEqual(RestoreRoute.of([:], screen: .game, lobbyId: ""), .mainRoom, "nothing to watch")

        let store = GameState()
        let snap = try TableSnapshot.decode(try FixtureLoader.v2Snapshot("spectator-mid-hand"), strict: true)
        store.apply(.snapshot(snap, .rejoin, hints: nil))
        XCTAssertTrue(store.isSpectator)
        XCTAssertEqual(SpectateRejoin.rememberedId(store, screen: .game), store.gameId ?? "-")
        XCTAssertEqual(SpectateRejoin.rememberedId(store, screen: .mainRoom), "")

        let seat = GameState()
        seat.apply(.snapshot(try TableSnapshot.decode(try FixtureLoader.v2Snapshot("bidding-mid"), strict: true), .rejoin, hints: nil))
        XCTAssertEqual(SpectateRejoin.rememberedId(seat, screen: .game), "", "a seat owner has the server's pointer")
        let tournament = GameState()
        tournament.apply(.snapshot(try TableSnapshot.decode(try FixtureLoader.v2Snapshot("tournament-game"), strict: true), .rejoin, hints: nil))
        XCTAssertEqual(SpectateRejoin.rememberedId(tournament, screen: .game), "")
    }

    // MARK: - An extra lands on the spectator table

    /// A lobby extra never gets allPlayersReady: spectatorJoined (full state at CREATED, as
    /// lobbyHandlers.startExtras sends it) puts it on the table as a spectator, and the room's
    /// startDraw then shows it the draw (no deck: it never draws).
    @MainActor
    func testAnExtraWatchesFromCreatedThroughTheDraw() throws {
        let store = GameState()
        store.apply(.local(.enterLobby(lobbyId: "l1")))
        var snap = try FixtureLoader.v2Snapshot("created-countdown")
        snap["viewer"] = ["role": "spectator", "position": NSNull(), "ownerView": NSNull(), "canAct": false]
        let gameId = try XCTUnwrap(snap["gameId"] as? String)
        let seq = snap["seq"] as? Int ?? 0
        guard case .success(let ev) = store.apply(serverEvent: "spectatorJoined", payload: [["gameId": gameId, "snapshot": snap]]),
              case .spectatorState = ev.event else { return XCTFail("spectatorJoined with a snapshot is the spectator's full state") }
        XCTAssertTrue(store.isSpectator)
        XCTAssertEqual(store.gameId, gameId)
        XCTAssertEqual(store.table.phase.kind, .waiting)
        _ = store.apply(serverEvent: "startDraw", payload: [["seq": seq + 1]])
        XCTAssertEqual(store.phase, .draw)
        XCTAssertTrue(store.isSpectator, "still watching: no Draw for an extra")
        XCTAssertFalse(store.hasDrawn)
    }
}

// MARK: - voiceSettings routing

@MainActor
final class VoiceSettingsRoutingTests: XCTestCase {
    private func manager() -> VoiceChatManager {
        VoiceChatManager(hooks: .init(requestRecordPermission: { true }, configureAudioSession: {},
                                      sendOffer: { _, _, _ in }, sendAnswer: { _, _ in }),
                         iceStore: IceServerStore(timeout: 0.05, emit: { _ in }))
    }

    private func settings(_ role: String, canTalk: Bool, on: Bool = true, canChange: Bool = false, game: String = "g1") -> [String: Any] {
        ["gameId": game, "host": "ivy", "spectatorsCanTalk": on, "role": role, "canTalk": canTalk, "canChange": canChange]
    }

    func testDecoding() {
        XCTAssertEqual(VoiceSettings.from(settings("spectator", canTalk: false))?.role, .spectator)
        XCTAssertEqual(VoiceSettings.from(["gameId": "g", "host": NSNull(), "spectatorsCanTalk": true, "role": "none",
                                           "canTalk": false, "canChange": false])?.host, nil)
        XCTAssertNil(VoiceSettings.from(settings("referee", canTalk: false)), "an unknown role is not acted on")
        XCTAssertNil(VoiceSettings.from(["role": "player"]))
    }

    func testAMainRoomSpectatorStartsListenOnlyWithNoPrompt() {
        let m = manager(), store = GameState()
        var started = 0
        VoiceSocketHandler.applyVoiceSettings(settings("spectator", canTalk: true), manager: m, gameState: store,
                                              start: { _ in started += 1 }, notify: { _ in XCTFail("no toast") })
        XCTAssertEqual(started, 1, "voice starts for the spectator")
        XCTAssertTrue(m.talkAllowed)
        XCTAssertFalse(m.wantsMic, "listen-only until Tap to talk")
        XCTAssertEqual(m.settings?.role, .spectator)
    }

    func testTalkTurnedOffTellsTheSpectatorOnce() {
        let m = manager(), store = GameState()
        var notes: [String] = []
        let apply = { (d: [String: Any]) in
            VoiceSocketHandler.applyVoiceSettings(d, manager: m, gameState: store, start: { _ in }, notify: { notes.append($0) })
        }
        apply(settings("spectator", canTalk: true))
        apply(settings("spectator", canTalk: false, on: false))
        XCTAssertFalse(m.talkAllowed)
        XCTAssertEqual(notes, [VoiceCopy.talkOff])
        apply(settings("spectator", canTalk: false, on: false))
        XCTAssertEqual(notes.count, 1, "an unchanged value says nothing")
        XCTAssertEqual(m.tapToTalk(), VoiceCopy.talkOff, "Tap to talk explains why not")
    }

    /// The switch is ON but this game lets spectators only listen (a stranger at a table of
    /// legacy players: server mayTalk has no capable controller): the toast does not blame the host.
    func testTapToTalkBlamesTheHostOnlyWhenTheSwitchIsOff() {
        let m = manager(), store = GameState()
        VoiceSocketHandler.applyVoiceSettings(settings("spectator", canTalk: false, on: true), manager: m, gameState: store,
                                              start: { _ in }, notify: { _ in XCTFail("nothing was turned off") })
        XCTAssertFalse(m.talkAllowed)
        XCTAssertEqual(m.tapToTalk(), VoiceCopy.listenOnlyHere)
        XCTAssertNotEqual(VoiceCopy.listenOnlyHere, VoiceCopy.talkOff)
    }

    func testAPlayerMutesTheSpectatorsWhileTalkIsOff() {
        let m = manager(), store = GameState()
        store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        _ = store.apply(serverEvent: "spectatorsUpdated", payload: [["gameId": "g1", "spectators": [["username": "lou"]], "count": 1]])
        XCTAssertEqual(store.watching.spectators.map(\.username), ["lou"])
        m.peerInfos = ["s-lou": .init(username: "lou"), "s-kim": .init(username: "kim")]
        defer { m.peerInfos = [:] }
        VoiceSocketHandler.applyVoiceSettings(settings("player", canTalk: true, on: false, canChange: true), manager: m,
                                              gameState: store, start: { _ in XCTFail("a player's voice is started by the table") },
                                              notify: { _ in })
        XCTAssertEqual(m.forcedMuted, ["lou"])
        XCTAssertTrue(m.isEffectivelyMuted("s-lou"))
        XCTAssertFalse(m.isEffectivelyMuted("s-kim"))
        XCTAssertEqual(m.settings?.canChange, true, "the panel shows the switch")
        m.unmutePeer("s-lou")
        XCTAssertTrue(m.isEffectivelyMuted("s-lou"), "my unmute does not lift the forced one")
        VoiceSocketHandler.applyVoiceSettings(settings("player", canTalk: true, on: true), manager: m, gameState: store,
                                              start: { _ in }, notify: { _ in })
        XCTAssertEqual(m.forcedMuted, [])
        XCTAssertFalse(m.isEffectivelyMuted("s-lou"))
    }

    func testVoiceFullAndAnotherGamesCopy() {
        let m = manager(), store = GameState()
        store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        VoiceSocketHandler.applyVoiceSettings(settings("none", canTalk: false), manager: m, gameState: store,
                                              start: { _ in XCTFail("no slot, no voice") }, notify: { _ in })
        XCTAssertEqual(m.settings?.role, VoiceSettings.Role.none)
        VoiceSocketHandler.applyVoiceSettings(settings("spectator", canTalk: true, game: "g9"), manager: m, gameState: store,
                                              start: { _ in XCTFail("another game's settings") }, notify: { _ in })
        XCTAssertEqual(m.settings?.gameId, "g1")
    }

    func testShutdownForgetsTheGameAndItsBuffers() {
        let m = manager()
        m.connectToPeer("s1", username: "kim")  // voice is not up: buffered
        m.handleOffer(fromSocketId: "s2", offer: RTCSessionDescription(type: .offer, sdp: "v=0"), username: "hal")
        XCTAssertEqual(m.bufferedCount, 2)
        m.settings = VoiceSettings(gameId: "g1", host: nil, spectatorsCanTalk: false, role: .spectator, canTalk: false, canChange: false)
        m.setDesiredMode(canTalk: false, wantsMic: false)
        m.shutdown()
        XCTAssertEqual(m.bufferedCount, 0, "an inactive shutdown clears the buffers too (they grew forever)")
        XCTAssertNil(m.settings)
        XCTAssertTrue(m.talkAllowed)
        XCTAssertTrue(m.wantsMic)
    }
}

// MARK: - Listen-only on real WebRTC connections

/// Two managers negotiate in-process with real RTCPeerConnections (the hooks capture the SDP
/// instead of a socket; no audio session, no network beyond ICE gathering).
@MainActor
final class SpectatorVoiceManagerTests: XCTestCase {
    final class Wire {
        var offers: [(to: String, sdp: RTCSessionDescription)] = []
        var answers: [(to: String, sdp: RTCSessionDescription)] = []
        var prompts = 0
    }

    private var managers: [VoiceChatManager] = []

    override func tearDown() async throws {
        for m in managers { m.shutdown() }
        managers = []
    }

    private func make(_ wire: Wire, permission: @escaping @MainActor () async -> Bool = { true }) -> VoiceChatManager {
        let m = VoiceChatManager(hooks: .init(requestRecordPermission: { wire.prompts += 1; return await permission() },
                                              configureAudioSession: {},
                                              sendOffer: { to, sdp, _ in wire.offers.append((to, sdp)) },
                                              sendAnswer: { to, sdp in wire.answers.append((to, sdp)) }),
                                 iceStore: IceServerStore(timeout: 0.05, emit: { _ in }))
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

    /// The direction of the first audio m-section.
    private func audioDirection(_ sdp: RTCSessionDescription) -> String? {
        let lines = sdp.sdp.components(separatedBy: "\r\n")
        guard let start = lines.firstIndex(where: { $0.hasPrefix("m=audio") }) else { return nil }
        for line in lines[(start + 1)...] {
            if line.hasPrefix("m=") { break }
            for d in ["sendrecv", "sendonly", "recvonly", "inactive"] where line == "a=\(d)" { return d }
        }
        return nil
    }

    func testAnActiveSessionReoffersListenOnlyAndBackKeepingThePeersMute() async throws {
        let wa = Wire(), wb = Wire()
        let a = make(wa), b = make(wb)
        try await a.initialize()
        try await b.initialize()
        XCTAssertTrue(a.isActive)
        XCTAssertFalse(a.isListenOnly)

        a.connectToPeer("B", username: "bob")
        try await waitUntil("A's first offer") { wa.offers.count == 1 }
        XCTAssertEqual(audioDirection(wa.offers[0].sdp), "sendrecv")
        b.handleOffer(fromSocketId: "A", offer: wa.offers[0].sdp, username: "amy")
        try await waitUntil("B's answer") { wb.answers.count == 1 }
        b.mutePeer("A")
        b.setPeerVolume("A", 1.5)
        a.handleAnswer(fromSocketId: "B", answer: wb.answers[0].sdp)
        try await waitUntil("A stable") { a.signalingState(of: "B") == .stable }

        // the host turned spectator talk off: the next offer receives only
        a.setDesiredMode(canTalk: false, wantsMic: true)
        XCTAssertTrue(a.isListenOnly)
        try await waitUntil("A's listen-only re-offer") { wa.offers.count == 2 }
        XCTAssertEqual(audioDirection(wa.offers[1].sdp), "recvonly")
        b.handleOffer(fromSocketId: "A", offer: wa.offers[1].sdp, username: "amy")
        try await waitUntil("B's answer to the re-offer") { wb.answers.count == 2 }
        XCTAssertEqual(audioDirection(wb.answers[1].sdp), "sendonly", "the player keeps sending; nothing comes back")
        XCTAssertEqual(b.peerInfos["A"]?.isMuted, true, "the replacement call keeps B's mute")
        XCTAssertEqual(b.peerInfos["A"]?.volume, 1.5)

        // back on while that offer waits for its answer: the re-offer waits (no stale answer)
        a.setDesiredMode(canTalk: true, wantsMic: true)
        try await waitUntil("the mic back") { !a.isListenOnly }
        XCTAssertTrue(a.isReofferPending("B"))
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(wa.offers.count, 2, "no offer over one in flight")
        a.handleAnswer(fromSocketId: "B", answer: wb.answers[1].sdp)
        try await waitUntil("A's talking re-offer after the answer") { wa.offers.count == 3 }
        XCTAssertEqual(audioDirection(wa.offers[2].sdp), "sendrecv")
        XCTAssertFalse(a.isReofferPending("B"))
    }

    /// The host turns spectator talk OFF then ON: a spectator who had muted themselves stays
    /// muted (the new track is made disabled); only "Tap to talk" or their own unmute turns it on.
    func testASelfMuteSurvivesTalkOffAndOn() async throws {
        let w = Wire()
        let a = make(w)
        try await a.initialize()
        a.connectToPeer("P", username: "pat")
        try await waitUntil("the offer") { w.offers.count == 1 }
        a.toggleSelfMute()
        XCTAssertTrue(a.isSelfMuted)
        XCTAssertEqual(a.localTrackEnabled, false)

        a.setDesiredMode(canTalk: false, wantsMic: true)
        XCTAssertTrue(a.isListenOnly)
        XCTAssertNil(a.localTrackEnabled, "listen-only: no track")
        XCTAssertTrue(a.isSelfMuted, "the mute is kept while listening")

        a.setDesiredMode(canTalk: true, wantsMic: true)
        try await waitUntil("the mic back") { !a.isListenOnly }
        XCTAssertEqual(a.localTrackEnabled, false, "the new track respects the self-mute")
        XCTAssertTrue(a.isSelfMuted)
        a.toggleSelfMute()
        XCTAssertEqual(a.localTrackEnabled, true, "their own unmute turns it on")
    }

    /// A voiceSettings ON during the background keep-alive makes the track disabled; the
    /// foreground turns it on (unless self-muted).
    func testATrackMadeInTheBackgroundStaysOffUntilTheForeground() async throws {
        let w = Wire()
        let a = make(w)
        a.setDesiredMode(canTalk: false, wantsMic: true)
        try await a.initialize()
        XCTAssertTrue(a.isListenOnly)
        a.handleBackground()
        defer { a.handleForeground() }
        a.setDesiredMode(canTalk: true, wantsMic: true)
        try await waitUntil("the mic back") { !a.isListenOnly }
        XCTAssertEqual(a.localTrackEnabled, false, "no live mic while the app is in the background")
        XCTAssertFalse(a.isSelfMuted)
        a.handleForeground()
        XCTAssertEqual(a.localTrackEnabled, true)
    }

    /// "Tap to talk" is the person asking to talk: it starts unmuted even after a mute.
    func testTapToTalkStartsUnmuted() async throws {
        let w = Wire()
        let a = make(w)
        try await a.initialize()
        a.toggleSelfMute()
        a.setDesiredMode(canTalk: true, wantsMic: false)  // e.g. back to listening by choice
        XCTAssertTrue(a.isListenOnly)
        XCTAssertNil(a.tapToTalk())
        try await waitUntil("the mic") { !a.isListenOnly }
        XCTAssertFalse(a.isSelfMuted)
        XCTAssertEqual(a.localTrackEnabled, true)
    }

    func testAModeChangeDuringThePermissionPromptIsApplied() async throws {
        let w = Wire()
        var release: CheckedContinuation<Bool, Never>?
        let a = make(w, permission: { await withCheckedContinuation { release = $0 } })
        let start = Task { @MainActor in try await a.initialize() }
        try await waitUntil("the prompt") { release != nil }
        a.setDesiredMode(canTalk: false, wantsMic: true)  // voiceSettings while the prompt is up
        release?.resume(returning: true)
        try await start.value
        XCTAssertTrue(a.isActive)
        XCTAssertTrue(a.isListenOnly, "the start read the latest mode before making its track")
        XCTAssertEqual(w.prompts, 1, "no second prompt or start")
        a.connectToPeer("P", username: "pat")
        try await waitUntil("the offer") { w.offers.count == 1 }
        XCTAssertEqual(audioDirection(w.offers[0].sdp), "recvonly")
    }

    func testARefusedMicListensAndFlushesWhatWaited() async throws {
        let w = Wire()
        let a = make(w, permission: { false })
        a.connectToPeer("P", username: "pat")  // a peer list during the prompt: buffered
        XCTAssertEqual(a.bufferedCount, 1)
        try await a.initialize()
        XCTAssertTrue(a.isActive, "voice runs without the mic (it used to stay off and buffer forever)")
        XCTAssertTrue(a.micPermissionDenied)
        XCTAssertTrue(a.isListenOnly)
        try await waitUntil("the flushed offer") { w.offers.count == 1 }
        XCTAssertEqual(audioDirection(w.offers[0].sdp), "recvonly")
        XCTAssertEqual(a.bufferedCount, 0)

        // a listen-only answer carries no track
        let w2 = Wire()
        let talker = make(w2)
        try await talker.initialize()
        talker.connectToPeer("A", username: "amy")
        try await waitUntil("a talking offer") { w2.offers.count == 1 }
        a.handleOffer(fromSocketId: "T", offer: w2.offers[0].sdp, username: "tim")
        try await waitUntil("the listen-only answer") { w.answers.count == 1 }
        XCTAssertEqual(audioDirection(w.answers[0].sdp), "recvonly")
    }

    func testAMainRoomSpectatorAsksForTheMicOnlyOnTap() async throws {
        let w = Wire()
        let a = make(w)
        a.setDesiredMode(canTalk: true, wantsMic: false)
        try await a.initialize()
        XCTAssertEqual(w.prompts, 0, "Spectate never prompts for the mic")
        XCTAssertTrue(a.isListenOnly)
        XCTAssertNil(a.tapToTalk())
        try await waitUntil("the mic") { !a.isListenOnly }
        XCTAssertEqual(w.prompts, 1)
        a.connectToPeer("P", username: "pat")
        try await waitUntil("the offer") { w.offers.count == 1 }
        XCTAssertEqual(audioDirection(w.offers[0].sdp), "sendrecv")
    }

    func testAMuteIsKeptByUsernameAcrossANewCall() async throws {
        let w = Wire()
        let a = make(w)
        try await a.initialize()
        a.connectToPeer("s1", username: "kim")
        a.mutePeer("s1")
        XCTAssertEqual(a.savedMute(for: "kim"), true)
        a.removePeer("s1")
        XCTAssertNil(a.peerInfos["s1"])
        a.connectToPeer("s2", username: "kim")  // kim back on a new socket
        XCTAssertEqual(a.peerInfos["s2"]?.isMuted, true)
        a.unmutePeer("s2")
        XCTAssertEqual(a.savedMute(for: "kim"), false)
        a.forgetVolumes()
        XCTAssertNil(a.savedMute(for: "kim"), "sign-out forgets mutes with the volumes")
    }
}
