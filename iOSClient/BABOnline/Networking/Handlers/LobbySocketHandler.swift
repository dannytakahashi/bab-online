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
            // Get Your Bid (additive `mode`): three seats from the draw on
            if GameMode.from(dict?["mode"]) == .gyb { store.apply(.local(.setMode(.gyb))) }
        }
    }

    /// leftLobby: the main room. A lobby a game's end kept behind its score screen (play
    /// again, `LobbyReturn`; e.g. the same player's other device took the seat) is only
    /// forgotten: the results stay up and Return to Lobby goes to the main room as before.
    @MainActor
    static func applyLeftLobby(lobbyState: LobbyState, appState: AppState) {
        let keptBehindResults = lobbyState.returnFromGameId != nil && appState.screen == .game
        lobbyState.reset()
        if keptBehindResults {
            print("[Lobby] Left the lobby kept behind the score screen")
            return
        }
        appState.screen = .mainRoom
        print("[Lobby] Left lobby")
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
        // a restore's re-spectate refused (1.2.2 (12); the game ended while away): off the table
        if dict["handler"] as? String == SocketEvents.Client.joinAsSpectator, let gameId = SpectateRejoin.pendingGameId {
            print("[Lobby] Re-spectate refused (\(gameId)): \(dict["message"] as? String ?? "?")")
            SpectateRejoin.pendingGameId = nil
            guard appState.screen == .game, gameState.gameId == gameId else { return true }
            GameSocketHandler.leaveTable(gameState: gameState, appState: appState, tournamentId: nil)
            if !RestartNotices.shared.lost() {
                socket.serverError = ServerErrorNotice(message: SpectateRejoin.refusedMessage)
            }
            return true
        }
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

        // The online count and list: a name came online (mainRoomPlayerJoined) or went
        // offline (mainRoomPlayerLeft, read from the build after 1.2.3 (24); before it a
        // player who left stayed listed until the next join). Both carry the whole list.
        for event in [SocketEvents.Server.mainRoomPlayerJoined, SocketEvents.Server.mainRoomPlayerLeft] {
            socket.on(event) { [weak self] data, _ in
                guard let dict = data.first as? [String: Any] else { return }
                DispatchQueue.main.async {
                    guard let self else { return }
                    Self.applyOnlineList(dict, to: self.mainRoomState)
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
                // (a lobby a game's end kept behind its score screen is replaced: LobbyReturn)
                self.lobbyState.returnFromGameId = nil
                self.gameState.apply(.local(.enterLobby(lobbyId: lobbyId)))

                // lobbyCreated from joinLobby names the held seats (additive; absent: none)
                self.lobbyState.applyLobby(dict, isBlocked: { self.safetyState.isBlocked($0) })
                self.appState.screen = .gameLobby
                print("[Lobby] Created lobby: \(lobbyId)")
            }
        }

        // Play again (1.2.2 (12)): back in the lobby after the game, the score screen kept up
        socket.on(SocketEvents.Server.lobbyReturn) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                LobbyReturn.receive(dict, lobbyState: self.lobbyState, appState: self.appState, gameState: self.gameState,
                                    isBlocked: { self.safetyState.isBlocked($0) })
            }
        }

        socket.on(SocketEvents.Server.lobbyPlayerJoined) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                // a player back in a held seat is no longer reconnecting
                self.lobbyState.applyPlayers(from: dict, namesHeldSeats: false)
            }
        }

        socket.on(SocketEvents.Server.lobbyPlayerLeft) { [weak self] data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                guard let lobbyState = self?.lobbyState else { return }
                // a family lobby's event lists everyone (`members`, 1.2.2 (12)) and may name a new host
                if dict["members"] != nil {
                    lobbyState.applyPlayers(from: dict, namesHeldSeats: false)
                    return
                }
                if let username = dict["username"] as? String {
                    lobbyState.setPlayers(lobbyState.players.filter { $0.username != username })
                }
                if let players = dict["players"] as? [[String: Any]] {
                    lobbyState.setPlayers(players.compactMap { LobbyPlayer.from($0) })
                }
            }
        }

        socket.on(SocketEvents.Server.playerReadyUpdate) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                // Server sends full players array (replace the entire list); every
                // playerReadyUpdate names the held seats while there are any
                self.lobbyState.applyPlayers(from: dict, namesHeldSeats: true)
                print("[Lobby] Players updated: \(self.lobbyState.players.map { $0.username })")
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
                guard let self else { return }
                Self.applyLeftLobby(lobbyState: self.lobbyState, appState: self.appState)
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

extension LobbySocketHandler {
    /// mainRoomPlayerJoined / mainRoomPlayerLeft: the server's count and list replace ours
    /// (each key only when present and of the right type). Called on the main queue.
    static func applyOnlineList(_ dict: [String: Any], to state: MainRoomState) {
        if let count = dict["onlineCount"] as? Int { state.onlineCount = count }
        if let users = dict["onlineUsers"] as? [String] { state.onlineUsers = users }
    }
}
