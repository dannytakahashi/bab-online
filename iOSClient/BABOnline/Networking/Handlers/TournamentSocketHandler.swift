import Foundation

/// Handles tournament-related socket events.
final class TournamentSocketHandler {
    private let socket: SocketService
    private let tournamentState: TournamentState
    private let gameState: GameState
    private let appState: AppState
    private let safetyState: SafetyState
    /// Voice's room changes (iOS 1.2.6, TournamentVoice); the tests pass a silent manager.
    private let voice: @MainActor () -> VoiceChatManager

    /// The table part of tournamentGameAssignment (also driven by the replay
    /// tests): the tournament context goes on the table so game end knows to return here.
    @MainActor
    static func routeGameAssignment(_ dict: [String: Any], to store: GameState) {
        if let gameId = dict["gameId"] as? String {
            store.apply(.local(.enterGameContext(gameId: gameId, tournamentId: dict["tournamentId"] as? String)))
        }
    }

    init(socket: SocketService, tournamentState: TournamentState, gameState: GameState, appState: AppState, safetyState: SafetyState,
         voice: @escaping @MainActor () -> VoiceChatManager = { .shared }) {
        self.voice = voice
        self.socket = socket
        self.tournamentState = tournamentState
        self.gameState = gameState
        self.appState = appState
        self.safetyState = safetyState
    }

    /// A refusal of the joinTournament a restore sent for the tournament lobby on screen
    /// (gone, begun without this player, a rate limit): back to the main room with one short
    /// message. Any other failure is not ours (false). Internal for TournamentRejoinTests.
    @MainActor
    func handleRejoinRefused(_ dict: [String: Any]) -> Bool {
        guard dict["handler"] as? String == SocketEvents.Client.joinTournament else { return false }
        let message = dict["message"] as? String
        if let abandoned = tournamentState.abandonedRejoinTournamentId {
            // left already (TournamentRejoin.abandon): its leaveTournament does the rest
            print("[Tournament] Abandoned tournament re-entry refused (\(abandoned)): \(message ?? "?")")
            tournamentState.abandonedRejoinTournamentId = nil
            return true
        }
        guard let tournamentId = tournamentState.rejoiningTournamentId else { return false }
        print("[Tournament] Tournament re-entry refused (\(tournamentId)): \(message ?? "?")")
        tournamentState.reset()
        appState.screen = .mainRoom
        // the server sends the main room after most refusals, not after a rate limit or
        // "Already in a tournament"; a second mainRoomJoined is harmless
        LobbyEmitter.joinMainRoom()
        TournamentRejoin.showFailure(message, socket: socket)
        return true
    }

    /// tournamentJoined: the lobby, unless it answers a re-entry left already (dropped, so the
    /// tournament never flashes up; the leaveTournament behind it leaves it again). Another
    /// tournament's answer is a later request's (the stream is ordered): the abandoned one's
    /// never came, so it is shown. Internal for TournamentRejoinTests.
    @MainActor
    func handleTournamentJoined(_ dict: [String: Any]) {
        if let abandoned = tournamentState.abandonedRejoinTournamentId {
            tournamentState.abandonedRejoinTournamentId = nil
            if dict["tournamentId"] as? String == abandoned {
                RestartNotices.shared.survived()
                print("[Tournament] Abandoned tournament re-entry answered: \(abandoned)")
                return
            }
        }
        let rejoined = tournamentState.rejoiningTournamentId != nil
        tournamentState.rejoiningTournamentId = nil
        tournamentState.loadFromServerState(dict)
        tournamentState.messages.removeAll { safetyState.isBlocked($0.username) }
        // the server put this socket in the tournament voice room: the old room's calls end
        // before its announcements (which follow this event) arrive; an SFU session in this
        // tournament's room waits for the roster that follows (a reconnect resumes it)
        voice().changeRoom(keepSfuFor: dict["tournamentId"] as? String)
        if rejoined {
            // joined again as a new member (not ready), or reattached: the server's flag
            let me = socket.authState?.username
            tournamentState.isReady = tournamentState.players.first { $0.username == me }?.isReady ?? false
        }
        appState.screen = .tournamentLobby
        RestartNotices.shared.survived()  // the tournament is still there after a reconnect
        print("[Tournament] Joined tournament: \(tournamentState.tournamentId)")
    }

    /// tournamentPlayerJoined: the members, and the scoreboard with the joiner's row
    /// (additive 2026-11-11; an older server sends none and the board stays).
    @MainActor
    func handlePlayerJoined(_ dict: [String: Any]) {
        if let playersArr = dict["players"] as? [[String: Any]] {
            tournamentState.players = playersArr.compactMap { TournamentPlayer.from($0) }
        }
        if let scoreboardArr = dict["scoreboard"] as? [[String: Any]] {
            tournamentState.scoreboard = scoreboardArr.compactMap { TournamentScoreEntry.from($0) }
        }
    }

    /// tournamentPlayerLeft: the members, and a host change (the host left, or was idle:
    /// reason 'hostIdle', where nobody left) with the web's toast.
    @MainActor
    func handlePlayerLeft(_ dict: [String: Any]) {
        // only for a tournament this app is in: a late copy after I left (or after a cancel)
        // must not announce a host in the main room or write into the reset state
        guard !tournamentState.tournamentId.isEmpty else { return }
        if let playersArr = dict["players"] as? [[String: Any]] {
            tournamentState.players = playersArr.compactMap { TournamentPlayer.from($0) }
        }
        guard let newCreator = dict["newCreator"] as? String else { return }
        let changed = newCreator != tournamentState.creatorUsername
        tournamentState.creatorUsername = newCreator
        // a finished tournament has nothing left to host: no toast in its final lobby (the web's
        // isTournamentFinished guard)
        if changed && tournamentState.phase != "complete" {
            socket.serverError = ServerErrorNotice(message: TournamentNotice.hostChanged(to: newCreator, me: socket.authState?.username),
                                                   kind: .info)
        }
    }

    /// tournamentReadyUpdate: the members, and between rounds whether the ready deadline
    /// passed (additive 2026-11-15; absent: unchanged).
    @MainActor
    func handleReadyUpdate(_ dict: [String: Any]) {
        if let playersArr = dict["players"] as? [[String: Any]] {
            tournamentState.players = playersArr.compactMap { TournamentPlayer.from($0) }
        }
        if let passed = dict["readyDeadlinePassed"] as? Bool {
            tournamentState.readyDeadlinePassed = passed
        }
    }

    /// tournamentSettingsUpdated {totalRounds, by} (iOS 1.2.7; TournamentRounds): the host set
    /// the number of rounds in the lobby. The round line, the scoreboard's columns and the host's
    /// picker follow it; the system line ("kim set the tournament to 3 rounds.") comes as a
    /// tournamentMessage. Only for a tournament this app is in.
    @MainActor
    func handleSettingsUpdated(_ dict: [String: Any]) {
        guard !tournamentState.tournamentId.isEmpty else { return }
        tournamentState.applyTotalRounds(dict["totalRounds"])
    }

    /// tournamentVoiceStatus {admitted, cap} (iOS 1.2.7, the clientHello cap
    /// `tournamentVoiceStatus`; TournamentVoice.fullNote): past the room's cap this member waits in
    /// line, unlisted, so voice never starts; the lobby's header says "Voice is full (N people)"
    /// until the server lets it in (admitted true, its voicePeerList right behind) or the screen
    /// goes. Only on the tournament lobby screen (the web's rule).
    @MainActor
    func handleVoiceStatus(_ dict: [String: Any]) {
        voice().meshRoomSeen()  // only a mesh room sends it (SFU step 1)
        guard appState.screen == .tournamentLobby, !tournamentState.tournamentId.isEmpty,
              let admitted = dict["admitted"] as? Bool else { return }
        if admitted {
            tournamentState.voiceFullCap = nil
        } else {
            let wasWaiting = tournamentState.voiceFullCap != nil
            // a cap outside 2...20 still says "Voice is full" (TournamentVoice.fullNote)
            tournamentState.voiceFullCap = TournamentVoice.roomCap(dict["cap"]) ?? 0
            if !wasWaiting { A11y.announce(TournamentVoice.fullNote(cap: tournamentState.voiceFullCap)) }
        }
    }

    /// sfuRoster (VOICE_SFU=tournament; SFU step 1): this tournament room is an SFU room. The
    /// transport takes it (SfuVoice), and its line is the over-cap notice's: "Voice is full
    /// (N people)" while waiting (N = the roster's cap), gone once admitted or out. Only for this
    /// app's tournament, the notice only on its lobby screen (the web's rule).
    @MainActor
    func handleSfuRoster(_ dict: [String: Any]) {
        guard let roster = SfuRoster.from(dict) else { return }
        guard roster.tournamentId == tournamentState.tournamentId else {
            voice().sfuRoomGone(why: "a roster for another tournament")
            return
        }
        voice().applySfuRoster(roster)
        switch roster.status {
        case .waiting:
            guard appState.screen == .tournamentLobby else { return }
            let wasWaiting = tournamentState.voiceFullCap != nil
            tournamentState.voiceFullCap = roster.cap.flatMap { $0 > 0 ? $0 : nil } ?? 0
            if !wasWaiting { A11y.announce(TournamentVoice.fullNote(cap: tournamentState.voiceFullCap)) }
        case .admitted, .out:
            tournamentState.voiceFullCap = nil
        }
    }

    /// tournamentCancelled: the main room, with the web's toast (a cancel mid-round sends
    /// abortGame first, so this also explains the table closing).
    @MainActor
    func handleCancelled() {
        // only for a tournament this app is in (the event goes to the tournament's room)
        let wasIn = !tournamentState.tournamentId.isEmpty
        tournamentState.reset()
        appState.screen = .mainRoom
        LobbyEmitter.joinMainRoom()
        if wasIn { socket.serverError = ServerErrorNotice(message: TournamentNotice.cancelled, kind: .info) }
        print("[Tournament] Tournament cancelled by host")
    }

    /// A cutForABuck* event (iOS 1.2.7 (41)): the one cut state, whatever screen is up (the score
    /// screen's strip reads it too). Only for a tournament this app is in (a late copy after I left
    /// must not bring a cut into the reset state). Internal for CutForABuckTests.
    @MainActor
    func handleCut(_ event: String, _ dict: [String: Any], now: Date = Date()) {
        guard !tournamentState.tournamentId.isEmpty, let type = CutState.Event.of(wireName: event) else { return }
        tournamentState.applyCut(type, dict, now: now)
    }

    /// tournamentComplete: the final standings, the winners and, when a cut ran, its result; this
    /// build shows them in the lobby itself (TournamentFinalView), with the chat and voice.
    @MainActor
    func handleComplete(_ dict: [String: Any]) {
        tournamentState.phase = "complete"
        tournamentState.readyDeadlinePassed = false
        if let scoreboardArr = dict["scoreboard"] as? [[String: Any]] {
            tournamentState.scoreboard = scoreboardArr.compactMap { TournamentScoreEntry.from($0) }
        }
        tournamentState.winners = dict["winners"] as? [String] ?? []
        // each round's tables and teams so far (additive 2026-11-25; absent: kept)
        tournamentState.applyPairings(dict["pairings"])
        // Cut for a buck's result (absent: no cut ran, or it ended before a winner)
        tournamentState.cutResult = CutResult.from(dict["cutForABuck"])
        tournamentState.cut = nil
    }

    func register() {
        // every connection registers again: the newest handler answers
        socket.claimTournamentServerError = { [weak self] dict in self?.handleRejoinRefused(dict) ?? false }

        // an abandoned re-entry's answer came before this (one ordered stream)
        socket.on(SocketEvents.Server.mainRoomJoined) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.tournamentState.abandonedRejoinTournamentId = nil
                self?.voice().sfuRoomGone(why: "the main room")  // no SFU room there (no sfuLeave)
            }
        }

        // MARK: - Tournament Created / Joined

        socket.on(SocketEvents.Server.tournamentCreated) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.tournamentState.loadFromServerState(dict)
                self.tournamentState.messages.removeAll { self.safetyState.isBlocked($0.username) }
                self.voice().changeRoom()  // the tournament voice room (TournamentVoice)
                self.appState.screen = .tournamentLobby
                print("[Tournament] Created tournament: \(self.tournamentState.tournamentId)")
            }
        }

        socket.on(SocketEvents.Server.tournamentJoined) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self.handleTournamentJoined(dict) }
        }

        // MARK: - Player Updates

        socket.on(SocketEvents.Server.tournamentPlayerJoined) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self.handlePlayerJoined(dict) }
        }

        socket.on(SocketEvents.Server.tournamentPlayerLeft) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self.handlePlayerLeft(dict) }
        }

        socket.on(SocketEvents.Server.tournamentReadyUpdate) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self.handleReadyUpdate(dict) }
        }

        socket.on(SocketEvents.Server.tournamentSettingsUpdated) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self.handleSettingsUpdated(dict) }
        }

        socket.on(SocketEvents.Server.tournamentVoiceStatus) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self.handleVoiceStatus(dict) }
        }

        socket.on(SocketEvents.Server.sfuRoster) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self.handleSfuRoster(dict) }
        }

        // MARK: - Chat

        socket.on(SocketEvents.Server.tournamentMessage) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let msg = ChatMessage.from(dict), !self.safetyState.isBlocked(msg.username) {
                    self.tournamentState.messages.append(msg)
                }
            }
        }

        // MARK: - Round Flow

        socket.on(SocketEvents.Server.tournamentRoundStart) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.tournamentState.phase = "round_active"
                self.tournamentState.readyDeadlinePassed = false
                if let round = dict["roundNumber"] as? Int {
                    self.tournamentState.currentRound = round
                }
                if let total = dict["totalRounds"] as? Int {
                    self.tournamentState.totalRounds = total
                }
                // each round's tables and teams so far (additive 2026-11-25; absent: kept)
                self.tournamentState.applyPairings(dict["pairings"])
                print("[Tournament] Round \(self.tournamentState.currentRound) started")
            }
        }

        socket.on(SocketEvents.Server.tournamentGameAssignment) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                // off the tournament voice room to this round's table (TournamentVoice); its
                // line too (the server says nothing when a seat takes a member out of it)
                self.voice().changeRoom()
                self.tournamentState.voiceFullCap = nil
                Self.routeGameAssignment(dict, to: self.gameState)
                print("[Tournament] Game assigned: \(dict["gameId"] as? String ?? "")")
            }
        }

        socket.on(SocketEvents.Server.tournamentGameComplete) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let gamesArr = dict["activeGames"] as? [[String: Any]] {
                    self.tournamentState.activeGames = gamesArr.compactMap { TournamentActiveGame.from($0) }
                }
                // each round's tables and teams so far (additive 2026-11-25; absent: kept)
                self.tournamentState.applyPairings(dict["pairings"])
                if let scoreboardArr = dict["scoreboard"] as? [[String: Any]] {
                    self.tournamentState.scoreboard = scoreboardArr.compactMap { TournamentScoreEntry.from($0) }
                }
                if let round = dict["currentRound"] as? Int {
                    self.tournamentState.currentRound = round
                }
            }
        }

        socket.on(SocketEvents.Server.tournamentRoundComplete) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.tournamentState.phase = "between_rounds"
                self.tournamentState.isReady = false
                // each round's tables and teams so far (additive 2026-11-25; absent: kept)
                self.tournamentState.applyPairings(dict["pairings"])
                // a new between-rounds wait starts its own deadline (a rolled-back start
                // sends tournamentReadyUpdate with the flag right after this)
                self.tournamentState.readyDeadlinePassed = false
                if let scoreboardArr = dict["scoreboard"] as? [[String: Any]] {
                    self.tournamentState.scoreboard = scoreboardArr.compactMap { TournamentScoreEntry.from($0) }
                }
                if let round = dict["currentRound"] as? Int {
                    self.tournamentState.currentRound = round
                }
                // Reset player ready states
                for i in self.tournamentState.players.indices {
                    self.tournamentState.players[i].isReady = false
                }
                print("[Tournament] Round \(self.tournamentState.currentRound) complete")
            }
        }

        socket.on(SocketEvents.Server.tournamentComplete) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.handleComplete(dict)
                print("[Tournament] Tournament complete")
            }
        }

        // MARK: - Cut for a buck (iOS 1.2.7 (41))

        for type in CutState.Event.allCases {
            let event = type.wireName
            socket.on(event) { [weak self] data, _ in
                guard let self, let dict = data.first as? [String: Any] else { return }
                DispatchQueue.main.async { self.handleCut(event, dict) }
            }
        }

        // MARK: - Leave / Reconnect

        socket.on(SocketEvents.Server.tournamentLeft) { [weak self] _, _ in
            guard let self else { return }
            DispatchQueue.main.async {
                self.voice().sfuRoomGone(why: "tournamentLeft")  // the room is gone (no sfuLeave)
                self.tournamentState.reset()
                self.appState.screen = .mainRoom
                LobbyEmitter.joinMainRoom()
                RestartNotices.shared.lost()  // a server restart took it (shown only after a serverShutdown)
                print("[Tournament] Left tournament")
            }
        }

        socket.on(SocketEvents.Server.tournamentCancelled) { [weak self] _, _ in
            guard let self else { return }
            DispatchQueue.main.async { self.handleCancelled() }
        }
    }
}
