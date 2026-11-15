import Foundation

/// Handles tournament-related socket events.
final class TournamentSocketHandler {
    private let socket: SocketService
    private let tournamentState: TournamentState
    private let gameState: GameState
    private let appState: AppState
    private let safetyState: SafetyState

    /// The table part of tournamentGameAssignment (also driven by the replay
    /// tests): the tournament context goes on the table so game end knows to return here.
    @MainActor
    static func routeGameAssignment(_ dict: [String: Any], to store: GameState) {
        if let gameId = dict["gameId"] as? String {
            store.apply(.local(.enterGameContext(gameId: gameId, tournamentId: dict["tournamentId"] as? String)))
        }
    }

    init(socket: SocketService, tournamentState: TournamentState, gameState: GameState, appState: AppState, safetyState: SafetyState) {
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
    /// tournament never flashes up; the leaveTournament behind it leaves it again).
    /// Internal for TournamentRejoinTests.
    @MainActor
    func handleTournamentJoined(_ dict: [String: Any]) {
        if let abandoned = tournamentState.abandonedRejoinTournamentId {
            tournamentState.abandonedRejoinTournamentId = nil
            RestartNotices.shared.survived()
            print("[Tournament] Abandoned tournament re-entry answered: \(abandoned)")
            return
        }
        let rejoined = tournamentState.rejoiningTournamentId != nil
        tournamentState.rejoiningTournamentId = nil
        tournamentState.loadFromServerState(dict)
        tournamentState.messages.removeAll { safetyState.isBlocked($0.username) }
        if rejoined {
            // joined again as a new member (not ready), or reattached: the server's flag
            let me = socket.authState?.username
            tournamentState.isReady = tournamentState.players.first { $0.username == me }?.isReady ?? false
        }
        appState.screen = .tournamentLobby
        RestartNotices.shared.survived()  // the tournament is still there after a reconnect
        print("[Tournament] Joined tournament: \(tournamentState.tournamentId)")
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
            DispatchQueue.main.async {
                if let playersArr = dict["players"] as? [[String: Any]] {
                    self.tournamentState.players = playersArr.compactMap { TournamentPlayer.from($0) }
                }
            }
        }

        socket.on(SocketEvents.Server.tournamentPlayerLeft) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let playersArr = dict["players"] as? [[String: Any]] {
                    self.tournamentState.players = playersArr.compactMap { TournamentPlayer.from($0) }
                }
                // Handle creator transfer
                if let newCreator = dict["newCreator"] as? String {
                    self.tournamentState.creatorUsername = newCreator
                }
            }
        }

        socket.on(SocketEvents.Server.tournamentReadyUpdate) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let playersArr = dict["players"] as? [[String: Any]] {
                    self.tournamentState.players = playersArr.compactMap { TournamentPlayer.from($0) }
                }
            }
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
            DispatchQueue.main.async {
                self.tournamentState.reset()
                self.appState.screen = .mainRoom
                LobbyEmitter.joinMainRoom()
                print("[Tournament] Tournament cancelled by host")
            }
        }
    }
}
