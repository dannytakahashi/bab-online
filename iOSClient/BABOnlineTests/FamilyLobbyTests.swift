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
        XCTAssertFalse(state.spectatorsCanTalk, "decoded as sent (an older server's switch; never shown)")

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
        // the ready count only (owner 2026-11-19: "Players 4/8 ·" went; GameLobby.js's header)
        let count = LobbyCount(state)
        XCTAssertEqual(count.text, "Ready 2/4", "GameLobby.js's header")
        XCTAssertEqual(count.spoken, "2 of 4 ready")
        XCTAssertFalse(count.text.contains("Players"))

        // an older server (no family keys): the same, every ready member out of 4
        let legacy = LobbyState()
        legacy.applyPlayers(from: ["lobbyId": "l1", "players": [member("ivy", ready: true, playing: nil), member("kim", ready: false, playing: nil)]],
                            namesHeldSeats: true)
        XCTAssertEqual(LobbyCount(legacy).text, "Ready 1/4")
        XCTAssertEqual(LobbyCount(legacy).spoken, "1 of 4 ready")
        // never more than the table's 4
        XCTAssertEqual(LobbyCount(ready: 4).text, "Ready 4/4")
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
        VoiceChatManager.silent()
    }

    private func settings(_ role: String, canTalk: Bool = true, on: Bool = true, canChange: Bool = false, game: String = "g1") -> [String: Any] {
        ["gameId": game, "host": "ivy", "spectatorsCanTalk": on, "role": role, "canTalk": canTalk, "canChange": canChange]
    }

    func testDecoding() {
        XCTAssertEqual(VoiceSettings.from(settings("spectator", canTalk: false))?.role, .spectator)
        XCTAssertEqual(VoiceSettings.from(["gameId": "g", "host": NSNull(), "spectatorsCanTalk": true, "role": "none",
                                           "canTalk": false, "canChange": false])?.host, nil)
        XCTAssertNil(VoiceSettings.from(settings("referee", canTalk: false)), "an unknown role is not acted on")
        XCTAssertNil(VoiceSettings.from(["role": "player"]))
    }

    /// Spectate starts voice, muted like every start (no prompt: the prompt is the first unmute's).
    func testASpectatorStartsVoiceMuted() {
        let m = manager(), store = GameState()
        var started = 0
        VoiceSocketHandler.applyVoiceSettings(settings("spectator"), manager: m, gameState: store, start: { _ in started += 1 })
        XCTAssertEqual(started, 1, "voice starts for the spectator")
        XCTAssertTrue(m.isSelfMuted)
        XCTAssertFalse(m.isListenOnly, "muted is not listen-only: a tap unmutes")
        XCTAssertEqual(m.settings?.role, .spectator)
    }

    /// Only the role is read: an older server's switch off (canTalk false, spectatorsCanTalk
    /// false, canChange true) changes nothing here; a player's voice is the table's to start.
    func testOnlyTheRoleIsRead() {
        let m = manager(), store = GameState()
        var started = 0
        VoiceSocketHandler.applyVoiceSettings(settings("spectator", canTalk: false, on: false, canChange: true), manager: m,
                                              gameState: store, start: { _ in started += 1 })
        XCTAssertEqual(started, 1)
        XCTAssertFalse(m.isListenOnly)
        VoiceSocketHandler.applyVoiceSettings(settings("player", on: false, canChange: true), manager: m, gameState: store,
                                              start: { _ in XCTFail("a player's voice is started by the table") })
        XCTAssertEqual(m.settings?.role, .player)
    }

    func testVoiceFullAndAnotherGamesCopy() {
        let m = manager(), store = GameState()
        store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        VoiceSocketHandler.applyVoiceSettings(settings("none", canTalk: false), manager: m, gameState: store,
                                              start: { _ in XCTFail("no slot, no voice") })
        XCTAssertEqual(m.settings?.role, VoiceSettings.Role.none)
        VoiceSocketHandler.applyVoiceSettings(settings("spectator", game: "g9"), manager: m, gameState: store,
                                              start: { _ in XCTFail("another game's settings") })
        XCTAssertEqual(m.settings?.gameId, "g1")
    }

    /// Any voiceSettings marks its game as one with casual voice (its watchers count as company,
    /// VoiceCompany.spectatorsInVoice); a shutdown keeps that, another game's copy does not set it.
    func testVoiceSettingsMarkTheCasualVoiceGame() {
        let m = manager(), store = GameState()
        store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        XCTAssertNil(m.casualVoiceGameId)
        VoiceSocketHandler.applyVoiceSettings(settings("spectator", game: "g9"), manager: m, gameState: store,
                                              start: { _ in XCTFail("another game's settings") })
        XCTAssertNil(m.casualVoiceGameId, "another game's copy")
        VoiceSocketHandler.applyVoiceSettings(settings("player", game: "g1"), manager: m, gameState: store,
                                              start: { _ in XCTFail("a player's voice is started by the table") })
        XCTAssertEqual(m.casualVoiceGameId, "g1")
        m.shutdown()
        XCTAssertNil(m.settings)
        XCTAssertEqual(m.casualVoiceGameId, "g1", "kept: the table still admits watchers")
    }

    func testShutdownForgetsTheGameAndItsBuffers() {
        let m = manager()
        m.connectToPeer("s1", username: "kim")  // voice is not up: buffered
        m.handleOffer(fromSocketId: "s2", offer: RTCSessionDescription(type: .offer, sdp: "v=0"), username: "hal")
        XCTAssertEqual(m.bufferedCount, 2)
        m.settings = VoiceSettings(gameId: "g1", host: nil, spectatorsCanTalk: true, role: .spectator, canTalk: true, canChange: false)
        m.shutdown()
        XCTAssertEqual(m.bufferedCount, 0, "an inactive shutdown clears the buffers too (they grew forever)")
        XCTAssertNil(m.settings)
        XCTAssertTrue(m.isSelfMuted)
    }

    /// The words this build shows; the switch's are gone (owner 2026-11-18).
    func testTheWords() {
        XCTAssertEqual(VoiceCopy.lobbyHint, "The first 4 to tap Ready play; everyone else watches and can talk")
        XCTAssertEqual(VoiceCopy.micDenied, "Microphone access denied. You can still listen.")
        XCTAssertEqual(VoiceCopy.noMic, "Listening only (no mic access)")
        XCTAssertEqual(VoiceCopy.noMicHint, "Double-tap to try the microphone again. Allow it for BAB Online in Settings first.")
        XCTAssertEqual(VoiceCopy.panelHint, "Touch and hold for the voice panel")
        XCTAssertEqual(VoiceCopy.voiceFull, "Voice is full (8 people)")
    }

    /// No source in the app sends the old switch, nor shows "can only listen".
    func testNothingSendsTheOldSwitch() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("BABOnline")
        let files = FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        XCTAssertGreaterThan(files.count, 50, "read the app sources from the checkout")
        var offenders: [String] = []
        for file in files where !["SocketEvents.swift", "UIFixture.swift"].contains(file.lastPathComponent) {
            let text = try String(contentsOf: file, encoding: .utf8)
            if text.contains("Client.setSpectatorsCanTalk") || text.contains("can only listen") {
                offenders.append(file.lastPathComponent)
            }
        }
        XCTAssertEqual(offenders, [])
    }
}

// MARK: - Muted start on real WebRTC connections

/// Two managers negotiate in-process with real RTCPeerConnections (the hooks capture the SDP
/// instead of a socket; no audio session, the silent audio device, no network beyond ICE
/// gathering). Owner 2026-11-18: "by default the mic should be muted and you can click to
/// unmute / activate mic".
@MainActor
final class MutedStartVoiceTests: XCTestCase {
    final class Wire {
        var offers: [(to: String, sdp: RTCSessionDescription)] = []
        var answers: [(to: String, sdp: RTCSessionDescription)] = []
        var prompts = 0
        var notes: [String] = []
        let device = SilentAudioDevice()
        /// iOS's record permission: allowed once a prompt said yes (`micAllowed` sets it first).
        var micAllowed = false
    }

    private var managers: [VoiceChatManager] = []

    override func tearDown() async throws {
        for m in managers { m.shutdown() }
        managers = []
    }

    private func make(_ wire: Wire, permission: @escaping @MainActor () async -> Bool = { true }) -> VoiceChatManager {
        let m = VoiceChatManager.silent(requestRecordPermission: {
                                            wire.prompts += 1
                                            let granted = await permission()
                                            if granted { wire.micAllowed = true }
                                            return granted
                                        },
                                        recordPermissionGranted: { wire.micAllowed },
                                        sendOffer: { to, sdp, _ in wire.offers.append((to, sdp)) },
                                        sendAnswer: { to, sdp in wire.answers.append((to, sdp)) },
                                        notify: { wire.notes.append($0) },
                                        audioDevice: wire.device)
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

    /// A and B in a call, both just started (muted, no mic).
    private func call(_ wa: Wire, _ wb: Wire) async throws -> (VoiceChatManager, VoiceChatManager) {
        let a = make(wa), b = make(wb)
        try await a.initialize()
        try await b.initialize()
        a.connectToPeer("B", username: "bob")
        try await waitUntil("A's offer") { wa.offers.count == 1 }
        b.handleOffer(fromSocketId: "A", offer: wa.offers[0].sdp, username: "amy")
        try await waitUntil("B's answer") { wb.answers.count == 1 }
        a.handleAnswer(fromSocketId: "B", answer: wb.answers[0].sdp)
        try await waitUntil("A stable") { a.signalingState(of: "B") == .stable }
        return (a, b)
    }

    /// Joining asks for nothing; every call is an ordinary sendrecv one carrying the local track
    /// DISABLED (never a sender without a track: WebRTC feeds such a send stream the capture
    /// unmuted, seen live on the simulator 2026-11-18), each side has the other's track, and
    /// playout starts.
    func testVoiceStartsMutedWithNoPromptAndStillHears() async throws {
        let wa = Wire(), wb = Wire()
        let (a, b) = try await call(wa, wb)
        XCTAssertEqual(wa.prompts + wb.prompts, 0, "joining voice never prompts")
        XCTAssertTrue(a.isActive && b.isActive)
        XCTAssertTrue(a.isSelfMuted && b.isSelfMuted, "muted at the start")
        XCTAssertFalse(a.isListenOnly)
        XCTAssertEqual(a.localTrackEnabled, false, "the track is there, disabled, before the first unmute")
        XCTAssertEqual(b.localTrackEnabled, false)
        XCTAssertTrue(a.sendsMic(to: "B") && b.sendsMic(to: "A"), "each call carries the (disabled) track")
        XCTAssertEqual(a.trackLessAudioSenders("B") + b.trackLessAudioSenders("A"), 0, "no sender without a track")
        XCTAssertEqual(audioDirection(wa.offers[0].sdp), "sendrecv", "an ordinary offer for every peer, shipped builds too")
        XCTAssertEqual(audioDirection(wb.answers[0].sdp), "sendrecv")
        XCTAssertTrue(wa.offers[0].sdp.sdp.contains("a=msid:stream0"), "a stream, so a peer's didAdd / ontrack fires")
        try await waitUntil("B has A's track") { b.hasRemoteTrack("A") }
        try await waitUntil("A has B's track") { a.hasRemoteTrack("B") }
        try await waitUntil("B plays out") { wb.device.playoutStarts > 0 }
        try await waitUntil("A plays out") { wa.device.playoutStarts > 0 }
    }

    /// The first unmute asks once and puts the mic on the call it already has: no new offer or
    /// answer, the call stays stable. Mute and unmute again ask nothing.
    func testTheFirstUnmuteAsksOnceAndSendsOnTheSameCall() async throws {
        let wa = Wire(), wb = Wire()
        let (a, b) = try await call(wa, wb)
        a.toggleSelfMute()
        try await waitUntil("A unmuted") { !a.isSelfMuted }
        XCTAssertEqual(wa.prompts, 1)
        XCTAssertEqual(a.localTrackEnabled, true)
        XCTAssertTrue(a.sendsMic(to: "B"), "the same track on the existing call's sender, now enabled")
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(wa.offers.count, 1, "no re-offer")
        XCTAssertEqual(wb.answers.count, 1)
        XCTAssertEqual(a.signalingState(of: "B"), .stable)
        XCTAssertEqual(b.signalingState(of: "A"), .stable)

        a.toggleSelfMute()
        XCTAssertTrue(a.isSelfMuted)
        XCTAssertEqual(a.localTrackEnabled, false, "a mute keeps the mic, disabled")
        a.toggleSelfMute()
        XCTAssertFalse(a.isSelfMuted, "the mic is there: unmuted at once")
        XCTAssertEqual(a.localTrackEnabled, true)
        XCTAssertEqual(wa.prompts, 1, "asked only once")

        // the answering side too
        b.toggleSelfMute()
        try await waitUntil("B unmuted") { !b.isSelfMuted }
        XCTAssertTrue(b.sendsMic(to: "A"))
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(wb.offers.count, 0, "the answerer re-offers nothing either")
        XCTAssertEqual(wb.answers.count, 1)
    }

    /// A call made once the mic is there carries it from its offer and its answer.
    func testACallAfterTheUnmuteCarriesTheMic() async throws {
        let wa = Wire(), wb = Wire()
        let a = make(wa), b = make(wb)
        try await a.initialize()
        try await b.initialize()
        a.toggleSelfMute()
        b.toggleSelfMute()
        try await waitUntil("both unmuted") { !a.isSelfMuted && !b.isSelfMuted }
        a.connectToPeer("B", username: "bob")
        try await waitUntil("A's offer") { wa.offers.count == 1 }
        XCTAssertEqual(audioDirection(wa.offers[0].sdp), "sendrecv")
        XCTAssertTrue(a.sendsMic(to: "B"))
        b.handleOffer(fromSocketId: "A", offer: wa.offers[0].sdp, username: "amy")
        try await waitUntil("B's answer") { wb.answers.count == 1 }
        XCTAssertEqual(audioDirection(wb.answers[0].sdp), "sendrecv")
        XCTAssertTrue(b.sendsMic(to: "A"))
        XCTAssertEqual(b.audioDirections(of: "A").count, 1, "one audio transceiver per call")
        XCTAssertEqual(a.trackLessAudioSenders("B") + b.trackLessAudioSenders("A"), 0)
    }

    /// A refused mic: muted, listen-only, the toast; the calls keep playing; a tap asks again,
    /// and a later grant puts the mic on the same calls.
    func testARefusedMicListensAndATapAsksAgain() async throws {
        let wa = Wire(), wb = Wire()
        var allow = false
        let a = make(wa, permission: { allow }), b = make(wb)
        try await a.initialize()
        try await b.initialize()
        a.connectToPeer("B", username: "bob")
        try await waitUntil("A's offer") { wa.offers.count == 1 }
        b.handleOffer(fromSocketId: "A", offer: wa.offers[0].sdp, username: "amy")
        try await waitUntil("B's answer") { wb.answers.count == 1 }
        a.handleAnswer(fromSocketId: "B", answer: wb.answers[0].sdp)

        a.toggleSelfMute()
        try await waitUntil("refused") { a.micPermissionDenied }
        XCTAssertTrue(a.isListenOnly)
        XCTAssertTrue(a.isSelfMuted)
        XCTAssertEqual(a.localTrackEnabled, false, "the track stays disabled")
        XCTAssertEqual(wa.notes, [VoiceCopy.micDenied])
        XCTAssertTrue(a.isActive, "voice runs on, listening")

        allow = true
        a.toggleSelfMute()
        try await waitUntil("granted on the second tap") { !a.isSelfMuted }
        XCTAssertEqual(wa.prompts, 2)
        XCTAssertFalse(a.isListenOnly)
        XCTAssertTrue(a.sendsMic(to: "B"))
        XCTAssertEqual(wa.offers.count, 1, "still no re-offer")
    }

    /// A tap while the prompt is up is a mute, and it wins: the granted mic comes muted.
    func testAMuteDuringThePromptWins() async throws {
        let w = Wire()
        var release: CheckedContinuation<Bool, Never>?
        let a = make(w, permission: { await withCheckedContinuation { release = $0 } })
        try await a.initialize()
        a.connectToPeer("P", username: "pat")
        try await waitUntil("the offer") { w.offers.count == 1 }
        a.toggleSelfMute()
        try await waitUntil("the prompt") { release != nil }
        XCTAssertTrue(a.micRequestInFlight)
        a.toggleSelfMute()  // changed their mind while the prompt is up
        a.toggleSelfMute()  // still a mute: no second prompt
        release?.resume(returning: true)
        try await waitUntil("the prompt answered") { !a.micRequestInFlight }
        XCTAssertEqual(w.prompts, 1)
        XCTAssertTrue(a.isSelfMuted, "the mute won")
        XCTAssertEqual(a.localTrackEnabled, false, "the granted mic comes muted")
        XCTAssertTrue(a.sendsMic(to: "P"))
        a.toggleSelfMute()
        XCTAssertEqual(a.localTrackEnabled, true, "the next unmute needs no prompt")
        XCTAssertEqual(w.prompts, 1)
    }

    /// Leaving while the prompt is up: no mic for the session that is gone.
    func testAShutdownDuringThePromptMakesNoMic() async throws {
        let w = Wire()
        var release: CheckedContinuation<Bool, Never>?
        let a = make(w, permission: { await withCheckedContinuation { release = $0 } })
        try await a.initialize()
        a.toggleSelfMute()
        try await waitUntil("the prompt") { release != nil }
        a.shutdown()
        release?.resume(returning: true)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNil(a.localTrackEnabled, "the session and its track are gone")
        XCTAssertTrue(a.isSelfMuted)
        XCTAssertFalse(a.isActive)
    }

    /// With the microphone not allowed any more at the next start (taken back in Settings), a
    /// manual unmute earlier does not carry: that session starts muted, as before 2026-11-19,
    /// and its first unmute asks.
    func testANewSessionStartsMutedWithoutTheMicAllowed() async throws {
        let w = Wire()
        let a = make(w)
        try await a.initialize()
        a.toggleSelfMute()
        try await waitUntil("unmuted") { !a.isSelfMuted }
        a.shutdown()
        w.micAllowed = false
        try await a.initialize()
        XCTAssertTrue(a.isSelfMuted)
        XCTAssertEqual(a.localTrackEnabled, false, "a new, disabled track")
        a.toggleSelfMute()
        try await waitUntil("unmuted again") { !a.isSelfMuted }
        XCTAssertEqual(w.prompts, 2, "that session's first unmute asks")
    }

    /// Owner 2026-11-19: "once you unmute in a session it should stay unmuted". The app run's
    /// first start is muted even with the mic allowed; after an unmute by hand every later start
    /// (a new lobby or table, voice back after company returns: shutdown or suspend, then
    /// initialize) starts unmuted with no prompt and its calls send the mic from the first offer.
    func testAfterAnUnmuteByHandTheNextSessionStartsUnmuted() async throws {
        let w = Wire()
        w.micAllowed = true  // allowed in an earlier app run
        let a = make(w)
        try await a.initialize()
        XCTAssertTrue(a.isSelfMuted, "the app run's first start is muted")
        XCTAssertEqual(a.localTrackEnabled, false)
        a.toggleSelfMute()
        try await waitUntil("unmuted") { !a.isSelfMuted }
        XCTAssertTrue(a.sessionUnmuted)
        a.shutdown()
        XCTAssertTrue(a.isSelfMuted, "muted while nothing runs")
        try await a.initialize()
        XCTAssertFalse(a.isSelfMuted, "a new lobby or table: unmuted")
        XCTAssertEqual(a.localTrackEnabled, true)
        a.toggleSelfMute()
        XCTAssertTrue(a.isSelfMuted, "the mic is allowed: a mute is immediate")
        a.toggleSelfMute()
        XCTAssertFalse(a.isSelfMuted, "and the unmute too")
        XCTAssertEqual(w.prompts, 1, "only the first unmute asked")
        // voice back after company returns (the gate's suspend, then a start)
        a.suspend()
        try await a.initialize()
        XCTAssertFalse(a.isSelfMuted)
        // the calls of that session send the enabled track from their first offer
        a.connectToPeer("B", username: "bob")
        try await waitUntil("A's offer") { w.offers.count == 1 }
        XCTAssertTrue(a.sendsMic(to: "B"))
        XCTAssertEqual(a.localTrackEnabled, true)
        XCTAssertEqual(audioDirection(w.offers[0].sdp), "sendrecv")
    }

    /// A mute by hand holds the same way: the next session starts muted, asks nothing, and its
    /// next unmute is immediate (the mic is allowed).
    func testAMuteByHandHoldsForTheNextSession() async throws {
        let w = Wire()
        let a = make(w)
        try await a.initialize()
        a.toggleSelfMute()
        try await waitUntil("unmuted") { !a.isSelfMuted }
        a.toggleSelfMute()
        XCTAssertTrue(a.isSelfMuted)
        XCTAssertFalse(a.sessionUnmuted)
        a.shutdown()
        try await a.initialize()
        XCTAssertTrue(a.isSelfMuted)
        XCTAssertEqual(a.localTrackEnabled, false)
        XCTAssertEqual(w.prompts, 1)
    }

    /// Sign Out (or forceLogout, a deleted account, a failed restore): the unmute by hand was
    /// that person's, so the next account's first start in this app run is muted with the mic
    /// allowed (iOS mic permission is per app); its first unmute asks as every session's does
    /// (iOS answers at once, with no prompt shown, once allowed).
    func testASignOutForgetsTheUnmuteForTheNextAccount() async throws {
        let w = Wire()
        w.micAllowed = true
        let a = make(w)
        try await a.initialize()
        a.toggleSelfMute()
        try await waitUntil("unmuted") { !a.isSelfMuted }
        XCTAssertTrue(a.sessionUnmuted)
        a.shutdown()
        a.forgetSessionMute()
        XCTAssertFalse(a.sessionUnmuted)
        try await a.initialize()
        XCTAssertTrue(a.isSelfMuted, "the next account starts muted")
        XCTAssertEqual(a.localTrackEnabled, false)
        a.toggleSelfMute()
        try await waitUntil("the next account unmutes") { !a.isSelfMuted }
        XCTAssertEqual(a.localTrackEnabled, true)
        XCTAssertTrue(a.sessionUnmuted, "its own choice now holds for its session")
    }

    /// A reconnect that kept voice running (a new socket id): the server listed a peer again
    /// (reconnectOwner, /active from the watch view) while the call with it was signaled from the
    /// old socket, which the peer dropped. The list makes a new call and offers from the new
    /// socket; the same list on the same socket changes nothing (live check 2026-11-19 on the web).
    func testAPeerListedAgainAfterAReconnectGetsANewCall() async throws {
        let w = Wire()
        var sid: String? = "sock-a"
        let a = VoiceChatManager.silent(sendOffer: { to, sdp, _ in w.offers.append((to, sdp)) },
                                        socketId: { sid },
                                        audioDevice: w.device)
        managers.append(a)
        try await a.initialize()
        a.connectToPeer("B", username: "bob")
        try await waitUntil("the first offer") { w.offers.count == 1 }
        a.connectToPeer("B", username: "bob")
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(w.offers.count, 1, "the same socket: already connected")
        sid = "sock-a2"
        a.connectToPeer("B", username: "bob")
        try await waitUntil("an offer from the new socket") { w.offers.count == 2 }
        XCTAssertEqual(w.offers[1].to, "B")
        XCTAssertTrue(a.sendsMic(to: "B"), "the new call carries the local track")
    }

    /// A refused unmute leaves nothing to resume; a mute during the prompt wins for the session.
    func testARefusalOrAMuteDuringThePromptLeavesTheSessionMuted() async throws {
        let w = Wire()
        let a = make(w, permission: { false })
        try await a.initialize()
        a.toggleSelfMute()
        try await waitUntil("refused") { a.micPermissionDenied }
        XCTAssertFalse(a.sessionUnmuted)

        let w2 = Wire()
        var release: CheckedContinuation<Bool, Never>?
        let b = make(w2, permission: { await withCheckedContinuation { release = $0 } })
        try await b.initialize()
        b.toggleSelfMute()
        try await waitUntil("the prompt") { release != nil }
        b.toggleSelfMute()  // a mute while it is up
        release?.resume(returning: true)
        try await waitUntil("answered") { !b.micRequestInFlight }
        XCTAssertTrue(b.isSelfMuted)
        XCTAssertFalse(b.sessionUnmuted)
        b.shutdown()
        try await b.initialize()
        XCTAssertTrue(b.isSelfMuted, "the next session too")
    }

    /// A resumed unmute while the app is in the background: the mic stays off until the
    /// foreground, then sends.
    func testAResumedUnmuteInTheBackgroundWaitsForTheForeground() async throws {
        let w = Wire()
        let a = make(w)
        try await a.initialize()
        a.toggleSelfMute()
        try await waitUntil("unmuted") { !a.isSelfMuted }
        a.shutdown()
        a.handleBackground()
        defer { a.handleForeground() }
        try await a.initialize()
        XCTAssertFalse(a.isSelfMuted)
        XCTAssertEqual(a.localTrackEnabled, false, "no live mic in the background")
        a.handleForeground()
        XCTAssertEqual(a.localTrackEnabled, true)
    }

    /// An unmute while the app is in the background (a voiceSettings-free path, but the same
    /// rule): the mic stays off until the foreground.
    func testAnUnmuteInTheBackgroundWaitsForTheForeground() async throws {
        let w = Wire()
        let a = make(w)
        try await a.initialize()
        a.handleBackground()
        defer { a.handleForeground() }
        a.toggleSelfMute()
        try await waitUntil("unmuted") { !a.isSelfMuted }
        XCTAssertEqual(a.localTrackEnabled, false, "no live mic while the app is in the background")
        a.handleForeground()
        XCTAssertEqual(a.localTrackEnabled, true)
    }

    /// iOS 1.2.2 (12) to 1.2.3 (15) offer recvonly while listen-only: answered sendonly with no
    /// track, and an unmute here then sends on that call with no renegotiation.
    func testAnOlderBuildsListenOnlyOfferIsAnsweredSendOnly() async throws {
        let w = Wire()
        let b = make(w)
        try await b.initialize()
        let factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                               decoderFactory: RTCDefaultVideoDecoderFactory(),
                                               audioDevice: SilentAudioDevice())
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        let old = try XCTUnwrap(factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil,
                                                                                                    optionalConstraints: nil), delegate: nil))
        defer { old.close() }
        let recv = RTCRtpTransceiverInit()
        recv.direction = .recvOnly
        old.addTransceiver(of: .audio, init: recv)
        var offer: RTCSessionDescription?
        old.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { sdp, _ in
            guard let sdp else { return }
            old.setLocalDescription(sdp) { _ in DispatchQueue.main.async { offer = sdp } }
        }
        try await waitUntil("the old build's offer") { offer != nil }
        XCTAssertEqual(audioDirection(offer!), "recvonly")
        b.handleOffer(fromSocketId: "OLD", offer: offer!, username: "lou")
        try await waitUntil("the answer") { w.answers.count == 1 }
        XCTAssertEqual(audioDirection(w.answers[0].sdp), "sendonly")
        XCTAssertEqual(b.trackLessAudioSenders("OLD"), 0)
        XCTAssertEqual(b.localTrackEnabled, false)
        b.toggleSelfMute()
        try await waitUntil("unmuted") { !b.isSelfMuted }
        XCTAssertTrue(b.sendsMic(to: "OLD"))
        XCTAssertEqual(w.offers.count, 0)
    }

    /// A replaced call (a restart, an older build's re-offer) keeps my mute and volume of that
    /// player; mutes are also kept by username across a new socket.
    func testAReplacedCallKeepsThePeersMuteAndVolume() async throws {
        let wa = Wire(), wb = Wire()
        let (a, b) = try await call(wa, wb)
        b.mutePeer("A")
        b.setPeerVolume("A", 1.5)
        a.removePeer("B")
        a.connectToPeer("B", username: "bob")
        try await waitUntil("A's new offer") { wa.offers.count == 2 }
        b.handleOffer(fromSocketId: "A", offer: wa.offers[1].sdp, username: "amy")
        try await waitUntil("B's answer") { wb.answers.count == 2 }
        XCTAssertEqual(b.peerInfos["A"]?.isMuted, true, "the replacement call keeps B's mute")
        XCTAssertEqual(b.peerInfos["A"]?.volume, 1.5)
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
