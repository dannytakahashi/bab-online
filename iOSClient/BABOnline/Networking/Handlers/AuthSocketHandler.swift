import Foundation

/// Handles auth-related socket events: signInResponse, signUpResponse, forceLogout, activeGameFound, deleteAccountResponse
final class AuthSocketHandler {
    private let socket: SocketService
    private let authState: AuthState
    private let appState: AppState
    private let gameState: GameState
    private let safetyState: SafetyState

    init(socket: SocketService, authState: AuthState, appState: AppState, gameState: GameState, safetyState: SafetyState) {
        self.socket = socket
        self.authState = authState
        self.appState = appState
        self.gameState = gameState
        self.safetyState = safetyState
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

                self.gameState.username = username
                self.gameState.playerId = self.socket.socketId

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
                }
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

                self.gameState.username = username

                self.appState.screen = .mainRoom
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

    private func handleRestoreSessionResponse(_ data: [String: Any]) {
        let success = data["success"] as? Bool ?? false

        DispatchQueue.main.async {
            if success {
                let username = data["username"] as? String ?? self.authState.username
                self.authState.username = username
                self.authState.isAuthenticated = true
                self.authState.error = nil

                self.gameState.username = username
                self.gameState.playerId = self.socket.socketId

                if let blocked = data["blockedUsers"] as? [String] {
                    self.safetyState.setBlockedUsers(blocked)
                }

                // Check if there's an active game to rejoin
                if let gameId = data["activeGameId"] as? String, !gameId.isEmpty {
                    print("[Auth] Session restored with active game: \(gameId)")
                    AuthEmitter.rejoinGame(gameId: gameId, username: username)
                } else if let tournamentId = data["activeTournamentId"] as? String, !tournamentId.isEmpty {
                    print("[Auth] Session restored with active tournament: \(tournamentId)")
                    TournamentEmitter.joinTournament(tournamentId: tournamentId)
                } else {
                    print("[Auth] Session restored for: \(username)")
                    self.appState.screen = .mainRoom
                    LobbyEmitter.joinMainRoom()
                }
            } else {
                let message = data["message"] as? String ?? "Session expired"
                print("[Auth] Session restore failed: \(message)")
                // Clear stale credentials and show sign-in
                self.authState.sessionToken = ""
                self.authState.saveCredentials()
                self.appState.screen = .signIn
            }
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
