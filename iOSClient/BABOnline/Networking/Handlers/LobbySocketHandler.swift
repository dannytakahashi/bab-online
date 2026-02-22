import Foundation

/// Handles lobby and main room socket events.
final class LobbySocketHandler {
    private let socket: SocketService
    private let mainRoomState: MainRoomState
    private let lobbyState: LobbyState
    private let appState: AppState
    private let gameState: GameState

    init(socket: SocketService, mainRoomState: MainRoomState, lobbyState: LobbyState, appState: AppState, gameState: GameState) {
        self.socket = socket
        self.mainRoomState = mainRoomState
        self.lobbyState = lobbyState
        self.appState = appState
        self.gameState = gameState
    }

    func register() {
        // MARK: - Main Room

        socket.on(SocketEvents.Server.mainRoomJoined) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.mainRoomState.onlineCount = dict["onlineCount"] as? Int ?? 0
                if let messages = dict["recentMessages"] as? [[String: Any]] {
                    self.mainRoomState.messages = messages.compactMap { ChatMessage.from($0) }
                }
                print("[Lobby] Joined main room")
            }
        }

        socket.on(SocketEvents.Server.mainRoomMessage) { [weak self] data, _ in
            guard let dict = data.first as? [String: Any],
                  let msg = ChatMessage.from(dict) else { return }
            DispatchQueue.main.async {
                self?.mainRoomState.messages.append(msg)
            }
        }

        socket.on(SocketEvents.Server.mainRoomPlayerJoined) { [weak self] data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                if let count = dict["onlineCount"] as? Int {
                    self?.mainRoomState.onlineCount = count
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
            }
        }

        // MARK: - Lobby

        socket.on(SocketEvents.Server.lobbyCreated) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let lobbyId = dict["lobbyId"] as? String ?? ""
                self.lobbyState.lobbyId = lobbyId
                self.lobbyState.lobbyName = dict["lobbyName"] as? String ?? ""
                self.gameState.gameId = lobbyId

                if let players = dict["players"] as? [[String: Any]] {
                    self.lobbyState.players = players.compactMap { LobbyPlayer.from($0) }
                }
                self.appState.screen = .gameLobby
                print("[Lobby] Created lobby: \(lobbyId)")
            }
        }

        socket.on(SocketEvents.Server.lobbyJoined) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let lobbyId = dict["lobbyId"] as? String ?? ""
                self.lobbyState.lobbyId = lobbyId
                self.lobbyState.lobbyName = dict["lobbyName"] as? String ?? dict["name"] as? String ?? ""
                self.gameState.gameId = lobbyId

                if let players = dict["players"] as? [[String: Any]] {
                    self.lobbyState.players = players.compactMap { LobbyPlayer.from($0) }
                }
                self.appState.screen = .gameLobby
                print("[Lobby] Joined lobby: \(lobbyId)")
            }
        }

        socket.on(SocketEvents.Server.lobbyPlayerJoined) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any],
                  let player = LobbyPlayer.from(dict) else { return }
            DispatchQueue.main.async {
                if !self.lobbyState.players.contains(where: { $0.username == player.username }) {
                    self.lobbyState.players.append(player)
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
                self?.lobbyState.messages.append(msg)
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
                _ = dict  // data available if needed
                self.appState.screen = .game
            }
        }
    }
}
