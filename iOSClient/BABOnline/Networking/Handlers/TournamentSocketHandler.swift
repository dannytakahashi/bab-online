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
        // before its announcements (which follow this event) arrive
        voice().changeRoom()
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
        if changed {
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

    func register() {
        // every connection registers again: the newest handler answers
        socket.claimTournamentServerError = { [weak self] dict in self?.handleRejoinRefused(dict) ?? false }

        // an abandoned re-entry's answer came before this (one ordered stream)
        socket.on(SocketEvents.Server.mainRoomJoined) { [weak self] _, _ in
            DispatchQueue.main.async { self?.tournamentState.abandonedRejoinTournamentId = nil }
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
                print("[Tournament] Round \(self.tournamentState.currentRound) started")
            }
        }

        socket.on(SocketEvents.Server.tournamentGameAssignment) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                // off the tournament voice room to this round's table (TournamentVoice)
                self.voice().changeRoom()
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
                self.tournamentState.phase = "complete"
                self.tournamentState.readyDeadlinePassed = false
                if let scoreboardArr = dict["scoreboard"] as? [[String: Any]] {
                    self.tournamentState.scoreboard = scoreboardArr.compactMap { TournamentScoreEntry.from($0) }
                }
                self.tournamentState.winners = dict["winners"] as? [String] ?? []
                print("[Tournament] Tournament complete")
            }
        }

        // MARK: - Leave / Reconnect

        socket.on(SocketEvents.Server.tournamentLeft) { [weak self] _, _ in
            guard let self else { return }
            DispatchQueue.main.async {
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
