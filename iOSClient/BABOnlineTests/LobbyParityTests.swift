import XCTest
@testable import BAB_Online

/// iOS 1.2.2 lobby parity with the web (iOSClient/CLAUDE.md, "Lobby parity"): the tournament
/// ready deadline, held game-lobby seats, the host hand-off and cancellation toasts, the
/// results' round details, the joiner's scoreboard row, the main-room cards and the voice
/// panel's per-player volume. Every additive field is read optionally: each rule is also
/// checked against a payload without it (an older server).
final class LobbyParityTests: XCTestCase {
    private func member(_ name: String, ready: Bool = false, host: Bool = false, connected: Bool = true) -> TournamentPlayer {
        TournamentPlayer(id: "s-\(name)", username: name, pic: nil, isReady: ready, isCreator: host, connected: connected)
    }

    private func wireMember(_ name: String, ready: Bool = false, host: Bool = false) -> [String: Any] {
        ["socketId": "s-\(name)", "username": name, "pic": NSNull(), "ready": ready, "connected": true, "isCreator": host]
    }

    // MARK: - (a) Ready deadline

    func testBeginNeedsEveryConnectedMemberReadyBeforeTheDeadline() {
        let waiting = [member("kim", ready: true, host: true), member("ivy"), member("ned", connected: false)]
        for phase in ["lobby", "between_rounds"] {
            XCTAssertFalse(TournamentBegin.canBegin(phase: phase, deadlinePassed: false, players: waiting), phase)
        }
        let ready = [member("kim", ready: true, host: true), member("ivy", ready: true), member("ned", connected: false)]
        XCTAssertTrue(TournamentBegin.canBegin(phase: "lobby", deadlinePassed: false, players: ready))
        XCTAssertTrue(TournamentBegin.canBegin(phase: "between_rounds", deadlinePassed: false, players: ready))
        XCTAssertFalse(TournamentBegin.canBegin(phase: "lobby", deadlinePassed: false, players: []))
        XCTAssertEqual(TournamentBegin.label(phase: "lobby", deadlinePassed: false, players: waiting), "Begin Tournament")
        XCTAssertEqual(TournamentBegin.label(phase: "between_rounds", deadlinePassed: false, players: waiting), "Begin Next Round")
    }

    func testPastTheDeadlineBeginStartsWithTheReadyPlayers() {
        let waiting = [member("kim", host: true), member("ivy", ready: true), member("hal")]
        XCTAssertTrue(TournamentBegin.canBegin(phase: "between_rounds", deadlinePassed: true, players: waiting))
        XCTAssertEqual(TournamentBegin.label(phase: "between_rounds", deadlinePassed: true, players: waiting), "Start with ready players")
        // everyone ready: the ordinary Begin
        let ready = [member("kim", ready: true, host: true), member("ivy", ready: true)]
        XCTAssertEqual(TournamentBegin.label(phase: "between_rounds", deadlinePassed: true, players: ready), "Begin Next Round")
        // the flag means nothing before round 1 (the server sends it between rounds only)
        XCTAssertFalse(TournamentBegin.canBegin(phase: "lobby", deadlinePassed: true, players: waiting))
        XCTAssertEqual(TournamentBegin.label(phase: "lobby", deadlinePassed: true, players: waiting), "Begin Tournament")
    }

    func testSittingOutIsANotReadyConnectedMemberWhoIsNotTheHost() {
        func sits(_ p: TournamentPlayer, phase: String = "between_rounds", passed: Bool = true) -> Bool {
            TournamentBegin.sitsOut(p, phase: phase, deadlinePassed: passed)
        }
        XCTAssertTrue(sits(member("hal")))
        XCTAssertFalse(sits(member("hal", ready: true)))
        XCTAssertFalse(sits(member("kim", host: true)), "the host plays the round their Begin starts")
        XCTAssertFalse(sits(member("ned", connected: false)), "shown as reconnecting")
        XCTAssertFalse(sits(member("hal"), passed: false))
        XCTAssertFalse(sits(member("hal"), phase: "lobby"))
    }

    func testTheJoinedStateReadsTheDeadlineOptionally() {
        let state = TournamentState()
        var dict = TournamentRejoinTests.joined()
        dict["phase"] = "between_rounds"
        dict["readyDeadlinePassed"] = true
        state.loadFromServerState(dict)
        XCTAssertTrue(state.readyDeadlinePassed)
        dict["readyDeadlinePassed"] = nil  // an older server, or another phase
        state.loadFromServerState(dict)
        XCTAssertFalse(state.readyDeadlinePassed)
        state.readyDeadlinePassed = true
        state.reset()
        XCTAssertFalse(state.readyDeadlinePassed)
    }

    @MainActor
    private func handler(_ state: TournamentState, _ app: AppState = AppState()) -> TournamentSocketHandler {
        TournamentSocketHandler(socket: SocketService.shared, tournamentState: state, gameState: GameState(),
                                appState: app, safetyState: SafetyState())
    }

    @MainActor
    func testReadyUpdateSetsTheDeadlineAndKeepsItWhenAbsent() {
        let state = TournamentState()
        state.phase = "between_rounds"
        let h = handler(state)
        h.handleReadyUpdate(["players": [wireMember("kim", host: true), wireMember("ivy", ready: true)], "allReady": false])
        XCTAssertFalse(state.readyDeadlinePassed, "an older server never sends it")
        XCTAssertEqual(state.players.map(\.username), ["kim", "ivy"])
        h.handleReadyUpdate(["players": [wireMember("kim", host: true), wireMember("ivy", ready: true)], "allReady": false,
                             "readyDeadlinePassed": true])
        XCTAssertTrue(state.readyDeadlinePassed)
        h.handleReadyUpdate(["players": [wireMember("kim", host: true)], "allReady": false])
        XCTAssertTrue(state.readyDeadlinePassed, "absent: unchanged")
        h.handleReadyUpdate(["players": [wireMember("kim", host: true)], "allReady": false, "readyDeadlinePassed": false])
        XCTAssertFalse(state.readyDeadlinePassed)
    }

    // MARK: - (b) Held game-lobby seats

    private func seat(_ name: String, ready: Bool = false, bot: Bool = false) -> [String: Any] {
        ["socketId": "s-\(name)", "username": name, "pic": NSNull(), "ready": ready, "isBot": bot]
    }

    func testReconnectingFollowsTheWebsRule() {
        let lobby = LobbyState()
        // playerReadyUpdate names the held seat
        lobby.applyPlayers(from: ["lobbyId": "L1", "players": [seat("ivy", ready: true), seat("hal")], "reconnecting": ["hal"]],
                           namesHeldSeats: true)
        XCTAssertEqual(lobby.reconnecting, ["hal"])
        XCTAssertTrue(lobby.isReconnecting(lobby.players[1]))
        XCTAssertFalse(lobby.isReconnecting(lobby.players[0]))
        // lobbyPlayerJoined for someone else keeps it; for hal (back in the seat) clears it
        lobby.applyPlayers(from: ["players": [seat("ivy", ready: true), seat("hal"), seat("kim")], "newPlayer": seat("kim")],
                           namesHeldSeats: false)
        XCTAssertEqual(lobby.reconnecting, ["hal"])
        lobby.applyPlayers(from: ["players": [seat("ivy", ready: true), seat("hal"), seat("kim")], "newPlayer": seat("hal")],
                           namesHeldSeats: false)
        XCTAssertEqual(lobby.reconnecting, [])
        // a playerReadyUpdate without the field: no seat is held
        lobby.reconnecting = ["hal"]
        lobby.applyPlayers(from: ["lobbyId": "L1", "players": [seat("ivy", ready: true), seat("hal")]], namesHeldSeats: true)
        XCTAssertEqual(lobby.reconnecting, [])
    }

    func testAHeldSeatThatExpiresOrIsABotOrReadyIsNotReconnecting() {
        let lobby = LobbyState()
        lobby.applyPlayers(from: ["players": [seat("ivy"), seat("hal"), seat("Mary", bot: true)], "reconnecting": ["hal", "Mary", "gone"]],
                           namesHeldSeats: true)
        XCTAssertEqual(lobby.reconnecting, ["hal", "Mary"], "a name that is not seated is dropped")
        XCTAssertFalse(lobby.isReconnecting(lobby.players[2]), "never a bot")
        // the seat expired: lobbyPlayerLeft's list no longer has hal
        lobby.setPlayers(lobby.players.filter { $0.username != "hal" })
        XCTAssertFalse(lobby.reconnecting.contains("hal"))
        // an event with no players changes nothing
        lobby.applyPlayers(from: ["reconnecting": ["ivy"]], namesHeldSeats: true)
        XCTAssertEqual(lobby.players.count, 2)
        XCTAssertFalse(lobby.reconnecting.contains("ivy"))
        lobby.reconnecting = ["ivy"]
        lobby.reset()
        XCTAssertEqual(lobby.reconnecting, [])
    }

    // MARK: - (c) Host hand-off and cancellation

    @MainActor
    func testANewHostIsAnnouncedOnce() {
        let service = SocketService.shared
        let auth = AuthState()
        auth.username = "ivy"
        service.authState = auth
        service.serverError = nil
        defer { service.authState = nil; service.serverError = nil }
        let state = TournamentState()
        state.tournamentId = "T1"
        state.creatorUsername = "kim"
        let h = handler(state)

        // a member left, the host did not change: no toast
        h.handlePlayerLeft(["username": "hal", "players": [wireMember("kim", host: true), wireMember("ivy")], "newCreator": NSNull()])
        XCTAssertNil(service.serverError)
        XCTAssertEqual(state.creatorUsername, "kim")

        // the idle host handed the role to me (nobody left)
        h.handlePlayerLeft(["username": "kim", "players": [wireMember("kim"), wireMember("ivy", host: true)],
                            "newCreator": "ivy", "reason": "hostIdle"])
        XCTAssertEqual(state.creatorUsername, "ivy")
        XCTAssertEqual(service.serverError?.message, "You are now the tournament host")
        XCTAssertEqual(service.serverError?.kind, .info)
        XCTAssertEqual(state.players.count, 2)

        // the same host named again: nothing new to say
        service.serverError = nil
        h.handlePlayerLeft(["username": "hal", "players": [wireMember("ivy", host: true)], "newCreator": "ivy"])
        XCTAssertNil(service.serverError)

        // the host left and someone else took over
        h.handlePlayerLeft(["players": [wireMember("jon", host: true), wireMember("ivy")], "newCreator": "jon"])
        XCTAssertEqual(service.serverError?.message, "jon is now the tournament host")
        XCTAssertEqual(state.creatorUsername, "jon")

        // the tournament is over: a hand-off in the final lobby says nothing (as the web)
        service.serverError = nil
        state.phase = "complete"
        h.handlePlayerLeft(["players": [wireMember("ivy", host: true)], "newCreator": "ivy"])
        XCTAssertNil(service.serverError)
        XCTAssertEqual(state.creatorUsername, "ivy")
        state.phase = "lobby"

        // a late copy after I left (the state is reset): no toast in the main room, nothing written
        service.serverError = nil
        state.reset()
        h.handlePlayerLeft(["players": [wireMember("pat", host: true)], "newCreator": "pat"])
        XCTAssertNil(service.serverError)
        XCTAssertEqual(state.creatorUsername, "")
        XCTAssertTrue(state.players.isEmpty)
    }

    /// The results table goes side by side only when the name keeps its least width.
    func testTheResultsTableNeedsRoomForTheName() {
        // Large text, 4 rounds: 22 + 72 + 4 x 42 + 46 + 16 = 324
        XCTAssertEqual(TournamentResultsTable.wideWidth(rank: 22, round: 42, total: 46, name: 72, rounds: 4), 324)
        XCTAssertEqual(TournamentResultsTable.wideWidth(rank: 22, round: 42, total: 46, name: 72, rounds: 0), 156)
        XCTAssertEqual(TournamentResultsTable.wideWidth(rank: 22, round: 42, total: 46, name: 72, rounds: -1), 156)
    }

    @MainActor
    func testACancelledTournamentSaysSoInTheMainRoom() {
        let service = SocketService.shared
        service.serverError = nil
        defer { service.serverError = nil }
        let state = TournamentState()
        state.tournamentId = "T1"
        state.readyDeadlinePassed = true
        let app = AppState()
        app.screen = .tournamentLobby
        handler(state, app).handleCancelled()
        XCTAssertEqual(app.screen, .mainRoom)
        XCTAssertEqual(state.tournamentId, "")
        XCTAssertEqual(service.serverError?.message, "Tournament has been cancelled by the host")
        XCTAssertEqual(service.serverError?.kind, .info)
        // a stray event with no tournament on this device says nothing
        service.serverError = nil
        handler(TournamentState(), app).handleCancelled()
        XCTAssertNil(service.serverError)
    }

    func testANoticeIsAnErrorUnlessSaidOtherwise() {
        XCTAssertEqual(ServerErrorNotice(message: "Lobby is full").kind, .error)
    }

    // MARK: - (d) Round details

    func testRoundDetailsMarkAbortedLeftAndMissedRounds() throws {
        let row: [String: Any] = [
            "username": "max", "totalScore": 82, "roundScores": [55, -20, -30, 77],
            "roundDetails": [
                ["roundNumber": 1, "gameId": "g1", "position": 2, "teamScore": 55, "oppScore": 40, "partner": "ivy"],
                ["roundNumber": 2, "gameId": "g2", "position": 1, "teamScore": -20, "oppScore": 90, "partner": "Bot", "aborted": true],
                ["roundNumber": 3, "gameId": "g3", "position": 1, "teamScore": -30, "oppScore": 10, "partner": "kim", "aborted": true, "left": true],
                ["roundNumber": 4, "teamScore": 77, "missed": true],
            ],
        ]
        let entry = try XCTUnwrap(TournamentScoreEntry.from(row))
        XCTAssertEqual(entry.roundFlags, [1: .aborted, 2: .left, 3: .missed])
        XCTAssertEqual(entry.cellText(round: 0), "55")
        XCTAssertEqual(entry.cellText(round: 1), "-20*")
        XCTAssertEqual(entry.cellText(round: 2), "-30\u{2020}")
        XCTAssertEqual(entry.cellText(round: 3), "77\u{2021}")
        XCTAssertEqual(entry.cellText(round: 4), "-")
        XCTAssertEqual(entry.spokenSummary(rank: 7, totalRounds: 4),
                       "7. max, 82 points. Round 1: 55. Round 2: -20, table ended early. Round 3: -30, left the table. Round 4: 77, sat out")
        XCTAssertEqual(TournamentFlagLegend.flags(in: [entry]), [.aborted, .left, .missed])
    }

    func testAScoreboardWithoutRoundDetailsReadsAsBefore() throws {
        // an older server: no roundDetails; and rows whose details carry no usable round
        let plain = try XCTUnwrap(TournamentScoreEntry.from(["username": "kim", "totalScore": 230, "roundScores": [142, 88]]))
        XCTAssertEqual(plain.roundFlags, [:])
        XCTAssertEqual(plain.roundScores, [142, 88])
        XCTAssertEqual(plain.cellText(round: 1), "88")
        XCTAssertEqual(plain.cellText(round: 2), "-")
        let odd = try XCTUnwrap(TournamentScoreEntry.from([
            "username": "kim", "totalScore": 0, "roundScores": [0],
            "roundDetails": [["aborted": true], ["roundNumber": 0, "missed": true], ["roundNumber": "2", "left": true], "junk"],
        ]))
        XCTAssertEqual(odd.roundFlags, [:])
        XCTAssertEqual(TournamentFlagLegend.flags(in: [plain, odd]), [])
        // the memberwise form the fixtures and older tests use still means "no flags"
        XCTAssertEqual(TournamentScoreEntry(id: "kim", username: "kim", totalScore: 230, roundScores: [142, 88]), plain)
    }

    func testWinnersFallBackToEveryoneOnTheTopScore() {
        let board = [("kim", 404), ("ivy", 404), ("hal", 312)].map {
            TournamentScoreEntry(id: $0.0, username: $0.0, totalScore: $0.1, roundScores: [])
        }
        XCTAssertEqual(TournamentFinalView.winners(["ivy"], scoreboard: board), ["ivy"], "the server's list wins")
        XCTAssertEqual(TournamentFinalView.winners([], scoreboard: board), ["kim", "ivy"])
        XCTAssertEqual(TournamentFinalView.winners([], scoreboard: []), [])
    }

    // MARK: - (e) The joiner's scoreboard row

    @MainActor
    func testAJoinerIsOnTheScoreboardAtOnce() {
        let state = TournamentState()
        state.scoreboard = [TournamentScoreEntry(id: "kim", username: "kim", totalScore: 0, roundScores: [])]
        let h = handler(state)
        h.handlePlayerJoined(["username": "hal", "players": [wireMember("kim", host: true), wireMember("hal")],
                              "scoreboard": [["username": "kim", "totalScore": 0, "roundScores": [], "roundDetails": []],
                                             ["username": "hal", "totalScore": 0, "roundScores": [], "roundDetails": []]]])
        XCTAssertEqual(state.players.map(\.username), ["kim", "hal"])
        XCTAssertEqual(state.scoreboard.map(\.username), ["kim", "hal"])
        // an older server sends no scoreboard: the board stays as it was
        h.handlePlayerJoined(["username": "jon", "players": [wireMember("kim", host: true), wireMember("hal"), wireMember("jon")]])
        XCTAssertEqual(state.players.count, 3)
        XCTAssertEqual(state.scoreboard.map(\.username), ["kim", "hal"])
    }

    // MARK: - (f) Main-room cards

    func testAWaitingLobbyCardListsItsMembersAndOffersRejoinForMySeat() throws {
        let lobby = try XCTUnwrap(Lobby.from([
            "id": "L1", "name": "Friday night", "playerCount": 4, "maxPlayers": 4, "createdAt": 1,
            "players": [["username": "ivy", "ready": false], ["username": "kim", "ready": true],
                        ["username": "\u{1F916} Bot", "ready": false], ["username": "hal", "ready": false]],
        ]))
        XCTAssertEqual(lobby.memberNames, "ivy, kim, \u{1F916} Bot, hal")
        XCTAssertNil(lobby.progress)
        XCTAssertEqual(lobby.action(for: "ivy"), .rejoin)
        XCTAssertEqual(lobby.action(for: "zed"), .full)
        XCTAssertEqual(lobby.action(for: nil), .full)
        XCTAssertEqual(lobby.action(for: ""), .full)
        var open = lobby
        open.playerCount = 3
        XCTAssertEqual(open.action(for: "ivy"), .join, "an open lobby is a plain Join, as on the web")
        XCTAssertEqual(open.action(for: "zed"), .join)
    }

    func testAnInProgressCardReadsHandScoreAndWatchers() throws {
        let game = try XCTUnwrap(Lobby.from([
            "gameId": "G1", "currentHand": 5, "score": ["team1": 120, "team2": -85], "spectatorCount": 2,
            "players": [["position": 1, "username": "uma"], ["position": 2, "username": "vic"],
                        ["position": 3, "username": "wes"], ["position": 4, "username": "xan"]],
        ]))
        XCTAssertEqual(game.name, "uma & wes vs vic & xan")
        let progress = try XCTUnwrap(game.progress)
        XCTAssertEqual(progress.handText, "Hand 5")
        XCTAssertEqual(progress.teamText(1), "uma/wes: 120")
        XCTAssertEqual(progress.teamText(2), "vic/xan: -85")
        XCTAssertEqual(progress.watchingText, "2 watching")
        XCTAssertEqual(progress.spokenSummary, "Hand 5. uma and wes 120, vic and xan -85. 2 watching")
    }

    func testAnInProgressCardWithoutTheDetailsStaysAsBefore() throws {
        // nobody watching: no "0 watching"
        let quiet = try XCTUnwrap(Lobby.from([
            "gameId": "G1", "currentHand": 1, "score": ["team1": 0, "team2": 0], "spectatorCount": 0,
            "players": [["position": 1, "username": "uma"], ["position": 2, "username": "vic"]],
        ]))
        XCTAssertNil(quiet.progress?.watchingText)
        XCTAssertEqual(quiet.progress?.teamText(1), "uma: 0")
        // no fields at all: the card keeps its old "4/4 players" line
        let bare = try XCTUnwrap(Lobby.from(["gameId": "G2", "players": [["username": "a"], ["username": "b"], ["username": "c"], ["username": "d"]]]))
        XCTAssertNil(bare.progress)
        XCTAssertEqual(bare.playerCount, 4)
        // a score but no positions: no team line, the hand still shows
        let partial = try XCTUnwrap(GameProgress.from(["currentHand": 3, "score": ["team1": 10, "team2": 20], "players": [["username": "a"]]]))
        XCTAssertNil(partial.teamText(1))
        XCTAssertEqual(partial.handText, "Hand 3")
        XCTAssertEqual(partial.spokenSummary, "Hand 3")
    }

    // MARK: - (g) Per-player voice volume

    func testVolumeIsClampedToTheWebsRange() {
        XCTAssertEqual(VoiceVolume.clamp(1), 1)
        XCTAssertEqual(VoiceVolume.clamp(-0.5), 0)
        XCTAssertEqual(VoiceVolume.clamp(3), 2)
        XCTAssertEqual(VoiceVolume.clamp(.nan), 1)
        XCTAssertEqual(VoiceVolume.percentText(1), "100%")
        XCTAssertEqual(VoiceVolume.percentText(1.5), "150%")
        XCTAssertEqual(VoiceVolume.percentText(0), "0%")
        XCTAssertEqual(VoiceVolume.percentText(9), "200%")
    }

    @MainActor
    func testAPlayersVolumeIsKeptPerPlayer() {
        let voice = VoiceChatManager.shared
        let before = voice.peerInfos
        defer { voice.peerInfos = before }
        voice.peerInfos = ["s1": .init(username: "kim"), "s2": .init(username: "hal", isMuted: true)]
        XCTAssertEqual(voice.peerInfos["s1"]?.volume, 1)
        voice.setPeerVolume("s1", 1.5)
        voice.setPeerVolume("s2", 7)
        voice.setPeerVolume("nobody", 0.2)
        XCTAssertEqual(voice.peerInfos["s1"]?.volume, 1.5)
        XCTAssertEqual(voice.peerInfos["s2"]?.volume, 2, "clamped")
        XCTAssertEqual(voice.peerInfos["s2"]?.isMuted, true, "the volume never unmutes")
        XCTAssertNil(voice.peerInfos["nobody"])
        voice.setPeerVolume("s1", 0)
        XCTAssertEqual(voice.peerInfos["s1"]?.volume, 0)
        // kept by name for a later track, until sign-out
        XCTAssertEqual(voice.savedVolume(for: "kim"), 0)
        XCTAssertEqual(voice.savedVolume(for: "hal"), 2)
        voice.forgetVolumes()
        XCTAssertNil(voice.savedVolume(for: "kim"))
        XCTAssertNil(voice.savedVolume(for: "hal"))
    }
}
