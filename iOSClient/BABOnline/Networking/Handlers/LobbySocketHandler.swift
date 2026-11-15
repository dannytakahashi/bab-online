import Foundation

/// Handles lobby and main room socket events.
final class LobbySocketHandler {
    private let socket: SocketService
    private let mainRoomState: MainRoomState
    private let lobbyState: LobbyState
    private let appState: AppState
    private let gameState: GameState
    private let safetyState: SafetyState

    /// The table part of allPlayersReady (also driven by the replay tests).
    /// 21.4: entering a game context resets the table (lobbyCreated carried the lobby id).
    @MainActor
    static func routeAllPlayersReady(_ dict: [String: Any]?, to store: GameState) {
        if let gameId = dict?["gameId"] as? String {
            store.apply(.local(.enterGameContext(gameId: gameId, tournamentId: nil)))
        }
    }

    init(socket: SocketService, mainRoomState: MainRoomState, lobbyState: LobbyState, appState: AppState, gameState: GameState, safetyState: SafetyState) {
        self.socket = socket
        self.mainRoomState = mainRoomState
        self.lobbyState = lobbyState
        self.appState = appState
        self.gameState = gameState
        self.safetyState = safetyState
    }

    /// A refusal of the joinLobby a restore sent (lobby gone, full, the seat expired): back to
    /// the main room with one short message. Any other failure is not ours (false).
    /// Internal for LobbyRejoinTests.
    @MainActor
    func handleRejoinRefused(_ dict: [String: Any]) -> Bool {
        guard dict["handler"] as? String == SocketEvents.Client.joinLobby else { return false }
        let message = dict["message"] as? String
        if let abandoned = lobbyState.abandonedRejoinLobbyId {
            // left already (LobbyRejoin.abandon): its joinMainRoom does the rest, nothing to say
            print("[Lobby] Abandoned lobby re-entry refused (\(abandoned)): \(message ?? "?")")
            lobbyState.abandonedRejoinLobbyId = nil
            return true
        }
        guard let lobbyId = lobbyState.rejoiningLobbyId else { return false }
        print("[Lobby] Lobby re-entry refused (\(lobbyId)): \(message ?? "?")")
        lobbyState.reset()
        appState.screen = .mainRoom
        LobbyEmitter.joinMainRoom()
        LobbyRejoin.showFailure(message, socket: socket)
        return true
    }

    func register() {
        // every connection registers again: the newest handler answers
        socket.claimServerError = { [weak self] dict in self?.handleRejoinRefused(dict) ?? false }

        // MARK: - Main Room

        socket.on(SocketEvents.Server.mainRoomJoined) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                // an abandoned re-entry's answer came before this (one ordered stream)
                self.lobbyState.abandonedRejoinLobbyId = nil
                self.mainRoomState.onlineCount = dict["onlineCount"] as? Int ?? 0
                if let users = dict["onlineUsers"] as? [String] {
                    self.mainRoomState.onlineUsers = users
                }
                // The server sends the replay under "messages" (and mirrors it
                // as "recentMessages" for app builds that read this key)
                if let messages = (dict["recentMessages"] ?? dict["messages"]) as? [[String: Any]] {
                    self.mainRoomState.messages = messages
                        .compactMap { ChatMessage.from($0) }
                        .filter { !self.safetyState.isBlocked($0.username) }
                }
                if let lobbies = dict["lobbies"] as? [[String: Any]] {
                    self.mainRoomState.lobbies = lobbies.compactMap { Lobby.from($0) }
                }
                if let inProgress = dict["inProgressGames"] as? [[String: Any]] {
                    self.mainRoomState.inProgressGames = inProgress.compactMap { Lobby.from($0) }
                }
                if let tournamentsArr = dict["tournaments"] as? [[String: Any]] {
                    self.mainRoomState.tournaments = tournamentsArr.compactMap { TournamentSummary.from($0) }
                }
                print("[Lobby] Joined main room")
            }
        }

        socket.on(SocketEvents.Server.mainRoomMessage) { [weak self] data, _ in
            guard let dict = data.first as? [String: Any],
                  let msg = ChatMessage.from(dict) else { return }
            DispatchQueue.main.async {
                guard let self, !self.safetyState.isBlocked(msg.username) else { return }
                self.mainRoomState.messages.append(msg)
            }
        }

        socket.on(SocketEvents.Server.mainRoomPlayerJoined) { [weak self] data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let count = dict["onlineCount"] as? Int {
                    self?.mainRoomState.onlineCount = count
                }
                if let users = dict["onlineUsers"] as? [String] {
                    self?.mainRoomState.onlineUsers = users
                }
            }
        }

        socket.on(SocketEvents.Server.lobbiesUpdated) { [weak self] data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let lobbies = dict["lobbies"] as? [[String: Any]] {
                    self?.mainRoomState.lobbies = lobbies.compactMap { Lobby.from($0) }
                }
                if let inProgress = dict["inProgressGames"] as? [[String: Any]] {
                    self?.mainRoomState.inProgressGames = inProgress.compactMap { Lobby.from($0) }
                }
                if let tournamentsArr = dict["tournaments"] as? [[String: Any]] {
                    self?.mainRoomState.tournaments = tournamentsArr.compactMap { TournamentSummary.from($0) }
                }
            }
        }

        // MARK: - Lobby

        socket.on(SocketEvents.Server.lobbyCreated) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let lobbyId = dict["lobbyId"] as? String ?? ""
                if self.lobbyState.abandonedRejoinLobbyId != nil {
                    // the seat came back after Leave: the joinMainRoom behind it leaves it again
                    // (leftLobby + mainRoomJoined), so the lobby never flashes up
                    self.lobbyState.abandonedRejoinLobbyId = nil
                    RestartNotices.shared.survived()
                    print("[Lobby] Abandoned lobby re-entry answered: \(lobbyId)")
                    return
                }
                if self.lobbyState.rejoiningLobbyId != nil {
                    // the restore's re-entry answered: the seat is ours again
                    self.lobbyState.rejoiningLobbyId = nil
                    RestartNotices.shared.survived()
                    print("[Lobby] Back in lobby: \(lobbyId)")
                }
                self.lobbyState.lobbyId = lobbyId
                self.lobbyState.lobbyName = dict["lobbyName"] as? String ?? dict["name"] as? String ?? ""
                self.gameState.apply(.local(.enterLobby(lobbyId: lobbyId)))

                if let players = dict["players"] as? [[String: Any]] {
                    self.lobbyState.players = players.compactMap { LobbyPlayer.from($0) }
                }
                if let messages = dict["messages"] as? [[String: Any]] {
                    self.lobbyState.messages = messages
                        .compactMap { ChatMessage.from($0) }
                        .filter { !self.safetyState.isBlocked($0.username) }
                }
                self.appState.screen = .gameLobby
                print("[Lobby] Created lobby: \(lobbyId)")
            }
        }

        socket.on(SocketEvents.Server.lobbyPlayerJoined) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let players = dict["players"] as? [[String: Any]] {
                    self.lobbyState.players = players.compactMap { LobbyPlayer.from($0) }
                }
            }
        }

        socket.on(SocketEvents.Server.lobbyPlayerLeft) { [weak self] data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let username = dict["username"] as? String {
                    self?.lobbyState.players.removeAll { $0.username == username }
                }
                if let players = dict["players"] as? [[String: Any]] {
                    self?.lobbyState.players = players.compactMap { LobbyPlayer.from($0) }
                }
            }
        }

        socket.on(SocketEvents.Server.playerReadyUpdate) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                // Server sends full players array — replace the entire list
                if let players = dict["players"] as? [[String: Any]] {
                    self.lobbyState.players = players.compactMap { LobbyPlayer.from($0) }
                    print("[Lobby] Players updated: \(self.lobbyState.players.map { $0.username })")
                }
            }
        }

        socket.on(SocketEvents.Server.lobbyMessage) { [weak self] data, _ in
            guard let dict = data.first as? [String: Any],
                  let msg = ChatMessage.from(dict) else { return }
            DispatchQueue.main.async {
                guard let self, !self.safetyState.isBlocked(msg.username) else { return }
                self.lobbyState.messages.append(msg)
            }
        }

        socket.on(SocketEvents.Server.leftLobby) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.lobbyState.reset()
                self?.appState.screen = .mainRoom
                print("[Lobby] Left lobby")
            }
        }

        socket.on(SocketEvents.Server.allPlayersReady) { [weak self] data, _ in
            guard let self else { return }
            let dict = data.first as? [String: Any]
            DispatchQueue.main.async {
                print("[Lobby] All players ready — transitioning to game")
                Self.routeAllPlayersReady(dict, to: self.gameState)
                self.appState.screen = .game
            }
        }
    }
}
