import Foundation

/// Where a successful restore (`restoreSessionResponse`) sends the app: the server's game
/// pointer, else its tournament pointer (a tournament that has begun), else the tournament
/// lobby on screen, else the game lobby on screen, else the main room (web
/// ClientSession.onSessionRestored, the same order).
///
/// The lobby: a new socket (a deploy, a network change, a slow wake-up) finds no game, and
/// the server holds the lobby seat for 30 s (`LOBBY_SEAT_GRACE_MS`) waiting for this
/// player's joinLobby, which takes the seat back in place (`takeOverLobbySeat`). Until
/// 2026-11-15 iOS went to the main room instead, the seat expired, and a lobby with only
/// its host in it was deleted. The joinMainRoom the main room sends must not follow: from
/// a socket in a lobby the server runs the Leave flow for it.
enum RestoreRoute: Equatable {
    case rejoinGame(gameId: String)
    case tournament(tournamentId: String)
    case tournamentLobby(tournamentId: String)
    case lobby(lobbyId: String)
    /// A pure spectator of a casual game (1.2.3): watch it again (`joinAsSpectator`), which
    /// also brings back its spectator voice. The server keeps no pointer for a spectator.
    case spectate(gameId: String)
    case mainRoom

    /// `tournamentId`: the tournament lobby the screen shows (`TournamentRejoin.rememberedId`).
    /// `spectatingGameId`: the casual game the table shows to a pure spectator
    /// (`SpectateRejoin.rememberedId`).
    static func of(_ data: [String: Any], screen: AppState.Screen, lobbyId: String,
                   tournamentId: String = "", spectatingGameId: String = "") -> RestoreRoute {
        if let id = data["activeGameId"] as? String, !id.isEmpty { return .rejoinGame(gameId: id) }
        if let id = data["activeTournamentId"] as? String, !id.isEmpty { return .tournament(tournamentId: id) }
        if screen == .game, !spectatingGameId.isEmpty { return .spectate(gameId: spectatingGameId) }
        // the server records activeTournamentId only at beginTournament, and a disconnect in
        // the lobby phase removes the member at once: join again (web: sessionStorage tournamentId)
        if screen == .tournamentLobby, !tournamentId.isEmpty { return .tournamentLobby(tournamentId: tournamentId) }
        // only the lobby screen: after allPlayersReady the old id may linger in LobbyState
        if screen == .gameLobby, !lobbyId.isEmpty { return .lobby(lobbyId: lobbyId) }
        return .mainRoom
    }

    /// The toast for a refused re-entry (the web's wording, main.js handleSocketError).
    /// "Lobby is full" too: the seat may still be held by the previous socket.
    static func lobbyRefusedMessage(_ serverMessage: String?) -> String {
        serverMessage == "Lobby not found" ? "The lobby closed while you were offline" : "Couldn't get back into the lobby"
    }

    /// The toast for a refused tournament re-entry (the web says "The tournament is no longer
    /// available" for all of them; these say which). "Tournament is not accepting players":
    /// it began while this player was out of it.
    static func tournamentRefusedMessage(_ serverMessage: String?) -> String {
        switch serverMessage {
        case "Tournament not found": return "The tournament closed while you were offline"
        case "Tournament is not accepting players": return "The tournament started without you"
        default: return "Couldn't get back into the tournament"
        }
    }
}

/// Watching a casual game again after a restore (`RestoreRoute.spectate`, 1.2.3): the
/// table stays on screen, `joinAsSpectator` goes out once per socket, and its
/// spectatorJoined answers (a full state: the table resyncs; voiceSettings follows, so
/// spectator voice comes back, listen-only until "Tap to talk"). A refusal ("Game not
/// found": the game ended meanwhile) leaves the table for the main room with a toast.
@MainActor
enum SpectateRejoin {
    /// The game whose re-spectate is unanswered, and the socket it went out on.
    static var pendingGameId: String?
    static var socketId: String?

    /// The game a restore should watch again: a pure spectator (not a lazy owner, who has
    /// the server's game pointer) at a casual table (no tournament) that has not ended.
    static func rememberedId(_ store: GameState, screen: AppState.Screen) -> String {
        guard screen == .game, store.isSpectator, !store.isLazy, store.tournamentId == nil,
              store.phase != .ended, let id = store.gameId else { return "" }
        return id
    }

    static let refusedMessage = "The game ended while you were offline"
}

/// Leaving a lobby whose re-entry is still unanswered: Leave, or the answer never came (the
/// server drops a parked socket's events while a sign-in is re-checked, supersededGate).
/// leaveLobby would not do: this socket may not be in the lobby yet, so the server refuses it
/// ("Not in a lobby") with no leftLobby and the screen is stranded (review 2026-11-15).
/// joinMainRoom is answered either way: plainly, or, once the joinLobby put the socket back
/// in, with the Leave flow. The joinLobby's own late answer is dropped.
@MainActor
enum LobbyRejoin {
    /// How long the restore's joinLobby may go unanswered on a connected socket.
    static var answerWait: TimeInterval = 15

    static func abandon(lobbyState: LobbyState, appState: AppState) {
        guard let lobbyId = lobbyState.rejoiningLobbyId else { return }
        print("[Lobby] Lobby re-entry abandoned (\(lobbyId))")
        let sid = lobbyState.rejoinSocketId
        lobbyState.reset()
        lobbyState.abandonedRejoinLobbyId = lobbyId
        lobbyState.rejoinSocketId = sid  // its answer comes only on that socket
        appState.screen = .mainRoom
        LobbyEmitter.joinMainRoom()
    }

    /// The one message for a re-entry that failed: the restart alert after a serverShutdown
    /// (within its window), else a toast.
    static func showFailure(_ serverMessage: String?, socket: SocketService) {
        if RestartNotices.shared.lost() { return }
        socket.serverError = ServerErrorNotice(message: RestoreRoute.lobbyRefusedMessage(serverMessage))
    }
}

/// The tournament lobby's re-entry after a restore (`RestoreRoute.tournamentLobby`), the
/// LobbyRejoin patterns: once per socket, an answer wait, Leave never strands, a late answer
/// is dropped. Leaving goes out as leaveTournament, which the server answers either way
/// (tournamentLeft + mainRoomJoined, also from a socket in no tournament) and which, behind a
/// joinTournament that put the socket back in, leaves it again.
@MainActor
enum TournamentRejoin {
    /// How long the restore's joinTournament may go unanswered on a connected socket.
    static var answerWait: TimeInterval = 15

    /// The tournament lobby on screen worth joining again: not a spectator's (joinTournament
    /// would make it an entrant) and not a finished one's results.
    static func rememberedId(_ state: TournamentState) -> String {
        state.isSpectator || state.phase == "complete" ? "" : state.tournamentId
    }

    static func abandon(tournamentState: TournamentState, appState: AppState) {
        guard let tournamentId = tournamentState.rejoiningTournamentId else { return }
        print("[Tournament] Tournament re-entry abandoned (\(tournamentId))")
        let sid = tournamentState.rejoinSocketId
        tournamentState.reset()
        tournamentState.abandonedRejoinTournamentId = tournamentId
        tournamentState.rejoinSocketId = sid  // its answer comes only on that socket
        appState.screen = .mainRoom
        TournamentEmitter.leaveTournament()
    }

    /// A create, join or spectate from the main room: an abandoned re-entry whose answers never
    /// came (dropped by the server, e.g. on a parked socket) must not swallow this one's.
    static func startFromMainRoom(_ tournamentState: TournamentState) {
        tournamentState.abandonedRejoinTournamentId = nil
    }

    /// The one message for a re-entry that failed: the restart alert after a serverShutdown
    /// (within its window), else a toast.
    static func showFailure(_ serverMessage: String?, socket: SocketService) {
        if RestartNotices.shared.lost() { return }
        socket.serverError = ServerErrorNotice(message: RestoreRoute.tournamentRefusedMessage(serverMessage))
    }
}
