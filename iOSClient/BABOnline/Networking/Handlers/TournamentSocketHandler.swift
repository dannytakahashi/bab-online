import Foundation

/// Handles tournament-related socket events.
final class TournamentSocketHandler {
    private let socket: SocketService
    private let tournamentState: TournamentState
    private let gameState: GameState
    private let appState: AppState

    init(socket: SocketService, tournamentState: TournamentState, gameState: GameState, appState: AppState) {
        self.socket = socket
        self.tournamentState = tournamentState
        self.gameState = gameState
        self.appState = appState
    }

    func register() {
        // MARK: - Tournament Created / Joined

        socket.on(SocketEvents.Server.tournamentCreated) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.tournamentState.loadFromServerState(dict)
                self.appState.screen = .tournamentLobby
                print("[Tournament] Created tournament: \(self.tournamentState.tournamentId)")
            }
        }

        socket.on(SocketEvents.Server.tournamentJoined) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.tournamentState.loadFromServerState(dict)
                self.appState.screen = .tournamentLobby
                print("[Tournament] Joined tournament: \(self.tournamentState.tournamentId)")
            }
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
                if let msg = ChatMessage.from(dict) {
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
                // Store tournament context on game state so game-end knows to return here
                if let tournamentId = dict["tournamentId"] as? String {
                    self.gameState.tournamentId = tournamentId
                }
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
                print("[Tournament] Left tournament")
            }
        }

        socket.on(SocketEvents.Server.activeTournamentFound) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let tournamentId = dict["tournamentId"] as? String {
                    TournamentEmitter.joinTournament(tournamentId: tournamentId)
                    print("[Tournament] Active tournament found, rejoining: \(tournamentId)")
                }
            }
        }
    }
}
