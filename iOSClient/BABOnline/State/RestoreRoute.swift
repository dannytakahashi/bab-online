import Foundation

/// Where a successful restore (`restoreSessionResponse`) sends the app: the server's game
/// pointer, else its tournament pointer (a tournament that has begun), else the game lobby
/// on screen, else the main room (web ClientSession.onSessionRestored, the same order).
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
    case lobby(lobbyId: String)
    case mainRoom

    static func of(_ data: [String: Any], screen: AppState.Screen, lobbyId: String) -> RestoreRoute {
        if let id = data["activeGameId"] as? String, !id.isEmpty { return .rejoinGame(gameId: id) }
        if let id = data["activeTournamentId"] as? String, !id.isEmpty { return .tournament(tournamentId: id) }
        // only the lobby screen: after allPlayersReady the old id may linger in LobbyState
        if screen == .gameLobby, !lobbyId.isEmpty { return .lobby(lobbyId: lobbyId) }
        return .mainRoom
    }

    /// The toast for a refused re-entry (the web's wording, main.js handleSocketError).
    /// "Lobby is full" too: the seat may still be held by the previous socket.
    static func lobbyRefusedMessage(_ serverMessage: String?) -> String {
        serverMessage == "Lobby not found" ? "The lobby closed while you were offline" : "Couldn't get back into the lobby"
    }
}
