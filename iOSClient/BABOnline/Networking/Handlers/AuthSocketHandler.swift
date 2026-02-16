import Foundation

/// Handles auth-related socket events: signInResponse, signUpResponse, forceLogout, activeGameFound
final class AuthSocketHandler {
    private let socket: SocketService
    private let authState: AuthState
    private let appState: AppState
    private let gameState: GameState

    init(socket: SocketService, authState: AuthState, appState: AppState, gameState: GameState) {
        self.socket = socket
        self.authState = authState
        self.appState = appState
        self.gameState = gameState
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

        socket.on(SocketEvents.Server.activeGameFound) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.handleActiveGameFound(dict)
        }
    }

    private func handleSignInResponse(_ data: [String: Any]) {
        let success = data["success"] as? Bool ?? false

        DispatchQueue.main.async {
            if success {
                let username = data["username"] as? String ?? ""
                self.authState.username = username
                self.authState.isAuthenticated = true
                self.authState.error = nil
                self.authState.saveCredentials()

                self.gameState.username = username
                self.gameState.playerId = self.socket.socketId

                self.appState.screen = .mainRoom
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
                self.authState.username = username
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
            self.appState.screen = .signIn
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
}
