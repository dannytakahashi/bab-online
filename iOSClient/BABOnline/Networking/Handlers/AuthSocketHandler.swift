import Foundation

/// Handles auth-related socket events: signInResponse, signUpResponse, forceLogout, activeGameFound, deleteAccountResponse,
/// changePasswordResponse, updateRequired
final class AuthSocketHandler {
    private let socket: SocketService
    private let authState: AuthState
    private let appState: AppState
    private let gameState: GameState
    private let safetyState: SafetyState
    private let lobbyState: LobbyState
    private let tournamentState: TournamentState
    // a retryable restore failure's retries (RestoreRetry), per socket
    private var restoreRetryAttempt = 0
    private var restoreRetrySocketId: String?
    private var restoreRetryGeneration = 0

    init(socket: SocketService, authState: AuthState, appState: AppState, gameState: GameState, safetyState: SafetyState,
         lobbyState: LobbyState, tournamentState: TournamentState = TournamentState()) {
        self.socket = socket
        self.authState = authState
        self.appState = appState
        self.gameState = gameState
        self.safetyState = safetyState
        self.lobbyState = lobbyState
        self.tournamentState = tournamentState
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

        socket.on(SocketEvents.Server.changePasswordResponse) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            self.handleChangePasswordResponse(dict)
        }

        // the upgrade gate (2026-11-25): this build is too old for the server; the full-screen
        // update screen, the session kept
        socket.on(SocketEvents.Server.updateRequired) { data, _ in
            let dict = data.first as? [String: Any]
            DispatchQueue.main.async { UpdateRequiredState.shared.receive(dict) }
        }
    }

    /// Internal for AccountChangesTests.
    func handleChangePasswordResponse(_ data: [String: Any]) {
        let result = ChangePasswordResult(success: data["success"] as? Bool ?? false,
                                          message: data["message"] as? String ?? "Password change failed")
        DispatchQueue.main.async { self.authState.changePasswordResult = result }
    }

    /// A retryable restore failure: ask again on this socket after RestoreRetry.delay, with the
    /// saved token kept. A new socket restores by itself (SocketService on .connect) and starts over.
    @MainActor
    private func scheduleRestoreRetry() {
        let sid = socket.socketId
        if restoreRetrySocketId != sid {
            restoreRetrySocketId = sid
            restoreRetryAttempt = 0
        }
        let delay = RestoreRetry.delay(attempt: restoreRetryAttempt)
        restoreRetryAttempt += 1
        restoreRetryGeneration += 1
        let generation = restoreRetryGeneration
        authState.restoreRetrying = true
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.restoreRetryGeneration == generation, self.socket.socketId == sid,
                  self.socket.isConnected, self.authState.hasStoredSession else { return }
            print("[Auth] Retrying the session restore (attempt \(self.restoreRetryAttempt))")
            self.socket.emit(SocketEvents.Client.restoreSession,
                             ["username": self.authState.username, "sessionToken": self.authState.sessionToken])
        }
    }

    @MainActor
    private func stopRestoreRetry() {
        restoreRetryGeneration += 1
        restoreRetryAttempt = 0
        restoreRetrySocketId = nil
        authState.restoreRetrying = false
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
                self.stopRestoreRetry()
                if let notice = PasswordResetNotice.text(data["passwordReset"]) { self.authState.accountNotice = notice }
                self.authState.isAdmin = AdminFlag.read(data)

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
                self.authState.isAdmin = false  // a new account
                // a pending retry would restore again, now with the new account's token
                self.stopRestoreRetry()

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

    func handleForceLogout(_ data: [String: Any]?) {
        DispatchQueue.main.async {
            let reason = data?["reason"] as? String ?? "Logged out"
            print("[Auth] Force logout: \(reason)")
            self.stopRestoreRetry()
            self.authState.clearCredentials()
            VoiceChatManager.shared.forgetSessionMute()
            self.gameState.reset()
            self.safetyState.reset()
            self.appState.screen = .signIn
            // why the sign-in is back (iOS's own words: the web shows only its sign-in screen),
            // on the sign-in's own toast layer; VoiceOver hears it once the sign-in is up, at high
            // priority, so the new screen's speech does not cut it off
            self.socket.serverError = ServerErrorNotice(message: NoticeText.signedOut, kind: .info, urgent: true,
                                                        announceDelay: ServerErrorNotice.screenChangeDelay)
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
                self.stopRestoreRetry()
                if let notice = PasswordResetNotice.text(data["passwordReset"]) { self.authState.accountNotice = notice }
                self.authState.isAdmin = AdminFlag.read(data)

                self.gameState.apply(.local(.identity(username: username, playerId: self.socket.socketId)))

                if let blocked = data["blockedUsers"] as? [String] {
                    self.safetyState.setBlockedUsers(blocked)
                }

                // an abandoned re-entry's answer never comes on a new socket
                if self.lobbyState.abandonedRejoinLobbyId != nil, self.lobbyState.rejoinSocketId != self.socket.socketId {
                    self.lobbyState.abandonedRejoinLobbyId = nil
                    self.lobbyState.rejoinSocketId = nil
                }
                if self.tournamentState.abandonedRejoinTournamentId != nil,
                   self.tournamentState.rejoinSocketId != self.socket.socketId {
                    self.tournamentState.abandonedRejoinTournamentId = nil
                    self.tournamentState.rejoinSocketId = nil
                }

                // a lobby a game's end kept behind its score screen (play again, LobbyReturn) was
                // the old socket's: the restore goes to the main room as from any score screen,
                // and the server's joinMainRoom answer puts this socket back in that lobby
                // (playAgain.autoClaimTarget: lobbyCreated) while its place is held
                if self.lobbyState.returnFromGameId != nil { self.lobbyState.reset() }

                let route = RestoreRoute.of(data, screen: self.appState.screen, lobbyId: self.lobbyState.lobbyId,
                                            tournamentId: TournamentRejoin.rememberedId(self.tournamentState),
                                            spectatingGameId: SpectateRejoin.rememberedId(self.gameState, screen: self.appState.screen))
                if case .spectate = route {} else { SpectateRejoin.pendingGameId = nil }
                if case .tournamentLobby = route {} else { self.tournamentState.rejoiningTournamentId = nil }
                switch route {
                case .rejoinGame(let gameId):
                    print("[Auth] Session restored with active game: \(gameId)")
                    self.lobbyState.rejoiningLobbyId = nil
                    AuthEmitter.rejoinGame(gameId: gameId, username: username)
                case .tournament(let tournamentId):
                    print("[Auth] Session restored with active tournament: \(tournamentId)")
                    self.lobbyState.rejoiningLobbyId = nil
                    TournamentEmitter.joinTournament(tournamentId: tournamentId)
                case .tournamentLobby(let tournamentId):
                    // the tournament lobby stays on screen; tournamentJoined or the refusal
                    // (TournamentSocketHandler.handleRejoinRefused) answers
                    self.lobbyState.rejoiningLobbyId = nil
                    self.rejoinTournament(tournamentId)
                case .lobby(let lobbyId):
                    // the lobby stays on screen; lobbyCreated (the seat back) or the refusal
                    // (LobbySocketHandler.handleRejoinRefused) answers
                    self.rejoinLobby(lobbyId)
                case .spectate(let gameId):
                    // the table stays on screen; spectatorJoined (a full state) or the refusal
                    // (LobbySocketHandler.handleRejoinRefused) answers. The calls of the old
                    // socket are dead (its peers dropped them): voice starts over when the
                    // new socket's voiceSettings arrives
                    self.lobbyState.rejoiningLobbyId = nil
                    let sid = self.socket.socketId
                    if SpectateRejoin.pendingGameId == gameId, SpectateRejoin.socketId == sid, sid != nil {
                        print("[Auth] Re-spectate already sent on this socket")
                    } else {
                        print("[Auth] Session restored while spectating \(gameId): watching again")
                        SpectateRejoin.pendingGameId = gameId
                        SpectateRejoin.socketId = sid
                        VoiceChatManager.shared.shutdown()
                        LobbyEmitter.joinAsSpectator(gameId: gameId)
                    }
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
            } else if RestoreRetry.isRetryable(data), self.authState.hasStoredSession {
                // passing (a database error, an admin action holding the name): keep the token
                // and the screen, and ask again
                print("[Auth] Session restore failed, retrying: \(data["message"] as? String ?? "")")
                self.scheduleRestoreRetry()
            } else {
                let message = data["message"] as? String ?? "Session expired"
                print("[Auth] Session restore failed: \(message)")
                self.stopRestoreRetry()
                self.lobbyState.rejoiningLobbyId = nil
                self.tournamentState.rejoiningTournamentId = nil
                RestartNotices.shared.lost()
                self.authState.isAdmin = false
                // Clear stale credentials and show sign-in
                self.authState.sessionToken = ""
                self.authState.saveCredentials()
                VoiceChatManager.shared.forgetSessionMute()
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

    /// joinTournament for the tournament lobby on screen, once per socket (rejoinLobby's
    /// rules). The server reattaches a member it still has by username, else adds a new one
    /// while the tournament is in its lobby phase.
    @MainActor
    private func rejoinTournament(_ tournamentId: String) {
        let sid = socket.socketId
        if sid != nil, tournamentState.rejoiningTournamentId == tournamentId, tournamentState.rejoinSocketId == sid {
            print("[Auth] Tournament re-entry already sent on this socket")
            return
        }
        print("[Auth] Session restored in tournament lobby \(tournamentId): joining it again")
        tournamentState.rejoiningTournamentId = tournamentId
        tournamentState.rejoinSocketId = sid
        tournamentState.rejoinGeneration += 1
        let generation = tournamentState.rejoinGeneration
        TournamentEmitter.joinTournament(tournamentId: tournamentId)

        // unanswered on a socket that stayed connected (the event was dropped): out to the
        // main room as a refusal would go; disconnected meanwhile, the next restore sends its own
        DispatchQueue.main.asyncAfter(deadline: .now() + TournamentRejoin.answerWait) { [weak self] in
            guard let self, self.tournamentState.rejoinGeneration == generation,
                  self.tournamentState.rejoiningTournamentId == tournamentId, self.appState.screen == .tournamentLobby,
                  self.socket.isConnected, self.socket.socketId == sid else { return }
            print("[Auth] Tournament re-entry unanswered after \(TournamentRejoin.answerWait) s")
            TournamentRejoin.abandon(tournamentState: self.tournamentState, appState: self.appState)
            TournamentRejoin.showFailure(nil, socket: self.socket)
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
                VoiceChatManager.shared.forgetSessionMute()
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
