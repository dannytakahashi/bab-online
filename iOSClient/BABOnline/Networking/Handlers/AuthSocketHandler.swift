import Foundation

/// Handles auth-related socket events: signInResponse, signUpResponse, forceLogout, activeGameFound, deleteAccountResponse
final class AuthSocketHandler {
    private let socket: SocketService
    private let authState: AuthState
    private let appState: AppState
    private let gameState: GameState
    private let safetyState: SafetyState
    private let lobbyState: LobbyState

    init(socket: SocketService, authState: AuthState, appState: AppState, gameState: GameState, safetyState: SafetyState,
         lobbyState: LobbyState) {
        self.socket = socket
        self.authState = authState
        self.appState = appState
        self.gameState = gameState
        self.safetyState = safetyState
        self.lobbyState = lobbyState
    }

    func register() {
        socket.on(SocketEvents.Server.signInResponse) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.handleSignInResponse(dict)
        }

        socket.on(SocketEvents.Server.signUpResponse) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.handleSignUpResponse(dict)
        }

        socket.on(SocketEvents.Server.forceLogout) { [weak self] data, _ in
            guard let self else { return }
            let dict = data.first as? [String: Any]
            self.handleForceLogout(dict)
        }

        socket.on(SocketEvents.Server.restoreSessionResponse) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.handleRestoreSessionResponse(dict)
        }

        socket.on(SocketEvents.Server.activeGameFound) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.handleActiveGameFound(dict)
        }

        socket.on(SocketEvents.Server.deleteAccountResponse) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.handleDeleteAccountResponse(dict)
        }
    }

    private func handleSignInResponse(_ data: [String: Any]) {
        let success = data["success"] as? Bool ?? false

        DispatchQueue.main.async {
            if success {
                let username = data["username"] as? String ?? ""
                let sessionToken = data["sessionToken"] as? String ?? ""
                self.authState.username = username
                self.authState.sessionToken = sessionToken
                self.authState.isAuthenticated = true
                self.authState.error = nil
                self.authState.saveCredentials()

                self.gameState.apply(.local(.identity(username: username, playerId: self.socket.socketId)))

                if let blocked = data["blockedUsers"] as? [String] {
                    self.safetyState.setBlockedUsers(blocked)
                }

                // Check if there's an active game to rejoin (e.g. force-killed app)
                if let gameId = data["activeGameId"] as? String, !gameId.isEmpty {
                    print("[Auth] Signed in with active game: \(gameId)")
                    AuthEmitter.rejoinGame(gameId: gameId, username: username)
                } else if let tournamentId = data["activeTournamentId"] as? String, !tournamentId.isEmpty {
                    print("[Auth] Signed in with active tournament: \(tournamentId)")
                    TournamentEmitter.joinTournament(tournamentId: tournamentId)
                } else {
                    self.appState.screen = .mainRoom
                    LobbyEmitter.joinMainRoom()
                    RestartNotices.shared.lost()
                }
                self.socket.noteSessionEstablished()
                print("[Auth] Signed in as: \(username)")
            } else {
                let message = data["message"] as? String ?? "Sign in failed"
                self.authState.error = message
                print("[Auth] Sign in failed: \(message)")
            }
        }
    }

    private func handleSignUpResponse(_ data: [String: Any]) {
        let success = data["success"] as? Bool ?? false

        DispatchQueue.main.async {
            if success {
                let username = data["username"] as? String ?? ""
                let sessionToken = data["sessionToken"] as? String ?? ""
                self.authState.username = username
                self.authState.sessionToken = sessionToken
                self.authState.isAuthenticated = true
                self.authState.error = nil
                self.authState.saveCredentials()

                self.gameState.apply(.local(.identity(username: username, playerId: self.socket.socketId)))

                self.appState.screen = .mainRoom
                self.socket.noteSessionEstablished()
                print("[Auth] Registered as: \(username)")
            } else {
                let message = data["message"] as? String ?? "Registration failed"
                self.authState.error = message
                print("[Auth] Registration failed: \(message)")
            }
        }
    }

    private func handleForceLogout(_ data: [String: Any]?) {
        DispatchQueue.main.async {
            let reason = data?["reason"] as? String ?? "Logged out"
            print("[Auth] Force logout: \(reason)")
            self.authState.clearCredentials()
            self.gameState.reset()
            self.safetyState.reset()
            self.appState.screen = .signIn
        }
    }

    /// Internal for ForegroundReconnectTests.
    func handleRestoreSessionResponse(_ data: [String: Any]) {
        let success = data["success"] as? Bool ?? false

        DispatchQueue.main.async {
            if success {
                let username = data["username"] as? String ?? self.authState.username
                self.authState.username = username
                self.authState.isAuthenticated = true
                self.authState.error = nil

                self.gameState.apply(.local(.identity(username: username, playerId: self.socket.socketId)))

                if let blocked = data["blockedUsers"] as? [String] {
                    self.safetyState.setBlockedUsers(blocked)
                }

                // an abandoned re-entry's answer never comes on a new socket
                if self.lobbyState.abandonedRejoinLobbyId != nil, self.lobbyState.rejoinSocketId != self.socket.socketId {
                    self.lobbyState.abandonedRejoinLobbyId = nil
                    self.lobbyState.rejoinSocketId = nil
                }

                switch RestoreRoute.of(data, screen: self.appState.screen, lobbyId: self.lobbyState.lobbyId) {
                case .rejoinGame(let gameId):
                    print("[Auth] Session restored with active game: \(gameId)")
                    self.lobbyState.rejoiningLobbyId = nil
                    AuthEmitter.rejoinGame(gameId: gameId, username: username)
                case .tournament(let tournamentId):
                    print("[Auth] Session restored with active tournament: \(tournamentId)")
                    self.lobbyState.rejoiningLobbyId = nil
                    TournamentEmitter.joinTournament(tournamentId: tournamentId)
                case .lobby(let lobbyId):
                    // the lobby stays on screen; lobbyCreated (the seat back) or the refusal
                    // (LobbySocketHandler.handleRejoinRefused) answers
                    self.rejoinLobby(lobbyId)
                case .mainRoom:
                    print("[Auth] Session restored for: \(username)")
                    self.lobbyState.rejoiningLobbyId = nil
                    self.appState.screen = .mainRoom
                    LobbyEmitter.joinMainRoom()
                    // no game or tournament to go back to: after a serverShutdown, it ended
                    RestartNotices.shared.lost()
                }
                // after the follow-up emit: a tap from now on reaches the server behind it
                self.socket.noteSessionEstablished()
            } else {
                let message = data["message"] as? String ?? "Session expired"
                print("[Auth] Session restore failed: \(message)")
                self.lobbyState.rejoiningLobbyId = nil
                RestartNotices.shared.lost()
                // Clear stale credentials and show sign-in
                self.authState.sessionToken = ""
                self.authState.saveCredentials()
                self.appState.screen = .signIn
            }
        }
    }

    /// joinLobby for the lobby on screen, once per socket (a repeated restore answer on the
    /// same socket waits for the first one's reply).
    @MainActor
    private func rejoinLobby(_ lobbyId: String) {
        let sid = socket.socketId
        if sid != nil, lobbyState.rejoiningLobbyId == lobbyId, lobbyState.rejoinSocketId == sid {
            print("[Auth] Lobby re-entry already sent on this socket")
            return
        }
        print("[Auth] Session restored in lobby \(lobbyId): taking the seat back")
        lobbyState.rejoiningLobbyId = lobbyId
        lobbyState.rejoinSocketId = sid
        lobbyState.rejoinGeneration += 1
        let generation = lobbyState.rejoinGeneration
        LobbyEmitter.joinLobby(lobbyId: lobbyId)

        // no answer on a socket that stayed connected (the event was dropped): the actions
        // must not wait forever, so out to the main room as a refusal would go. Disconnected
        // meanwhile: the next socket's restore sends its own.
        DispatchQueue.main.asyncAfter(deadline: .now() + LobbyRejoin.answerWait) { [weak self] in
            guard let self, self.lobbyState.rejoinGeneration == generation,
                  self.lobbyState.rejoiningLobbyId == lobbyId, self.appState.screen == .gameLobby,
                  self.socket.isConnected, self.socket.socketId == sid else { return }
            print("[Auth] Lobby re-entry unanswered after \(LobbyRejoin.answerWait) s")
            LobbyRejoin.abandon(lobbyState: self.lobbyState, appState: self.appState)
            LobbyRejoin.showFailure(nil, socket: self.socket)
        }
    }

    private func handleActiveGameFound(_ data: [String: Any]) {
        DispatchQueue.main.async {
            let gameId = data["gameId"] as? String ?? ""
            print("[Auth] Active game found: \(gameId)")

            // Auto-rejoin the active game
            AuthEmitter.rejoinGame(gameId: gameId, username: self.authState.username)
        }
    }

    private func handleDeleteAccountResponse(_ data: [String: Any]) {
        let success = data["success"] as? Bool ?? false

        DispatchQueue.main.async {
            if success {
                // Mirror forceLogout cleanup — the server force-disconnects this
                // socket shortly after the response; with credentials cleared, the
                // auto-reconnect won't restore a session.
                print("[Auth] Account deleted")
                self.authState.clearCredentials()
                self.gameState.reset()
                self.safetyState.reset()
                self.appState.screen = .signIn
            } else {
                let message = data["message"] as? String ?? "Account deletion failed"
                self.authState.deleteAccountError = message
                print("[Auth] Account deletion failed: \(message)")
            }
        }
    }
}
