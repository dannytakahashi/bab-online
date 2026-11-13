import Foundation

struct Lobby: Identifiable, Equatable {
    let id: String
    let name: String
    var players: [LobbyPlayer]
    var playerCount: Int
    var isInProgress: Bool = false

    static func from(_ dict: [String: Any]) -> Lobby? {
        guard let id = dict["id"] as? String ?? dict["lobbyId"] as? String ?? dict["gameId"] as? String else { return nil }

        // Name is optional — in-progress games don't have one, so generate from players
        let name: String
        if let n = dict["name"] as? String {
            name = n
        } else if let pArr = dict["players"] as? [[String: Any]] {
            let names = pArr.compactMap { $0["username"] as? String }
            if names.count == 4 {
                name = "\(names[0]) & \(names[2]) vs \(names[1]) & \(names[3])"
            } else {
                name = names.joined(separator: ", ")
            }
        } else {
            name = "Game \(id.prefix(4))"
        }

        let playerCount = dict["playerCount"] as? Int ?? (dict["players"] as? [[String: Any]])?.count ?? 0
        let isInProgress = dict["inProgress"] as? Bool ?? false

        var players: [LobbyPlayer] = []
        if let pArr = dict["players"] as? [[String: Any]] {
            players = pArr.compactMap { LobbyPlayer.from($0) }
        }

        return Lobby(id: id, name: name, players: players, playerCount: playerCount, isInProgress: isInProgress)
    }
}

struct LobbyPlayer: Identifiable, Equatable {
    let id: String          // socket ID
    let username: String
    var pic: String?
    var isReady: Bool
    var isBot: Bool

    static func from(_ dict: [String: Any]) -> LobbyPlayer? {
        guard let username = dict["username"] as? String else { return nil }
        let id = dict["socketId"] as? String ?? dict["id"] as? String ?? UUID().uuidString
        let pic = picString(from: dict["pic"])
        let isReady = dict["isReady"] as? Bool ?? dict["ready"] as? Bool ?? false
        let isBot = dict["isBot"] as? Bool ?? false
        return LobbyPlayer(id: id, username: username, pic: pic, isReady: isReady, isBot: isBot)
    }
}

// MARK: - Removing a bot (the web lobby's rules: client/src/ui/screens/GameLobby.js)

extension LobbyPlayer {
    /// Any human in a game lobby may remove a bot that is not ready, as on the web
    /// (`lobbyHandlers.removeBot` takes it from any member). Bots turn ready only
    /// when a human readies a full lobby (`setBotsReady`), and from then until the
    /// game starts (the LOBBY_START_MS hold, the countdown) every bot is ready, so
    /// the control is gone before the game can start. The server re-checks (a bot
    /// it no longer has answers `serverError` "Bot not found in lobby").
    var canBeRemoved: Bool { isBot && !isReady }

    /// The lobby's bot name without the server's "🤖 " prefix: "Bot", "Bot 2"
    /// (the personality stays hidden until the game starts, V1_REMOVALS #16).
    var botDisplayName: String {
        username.replacingOccurrences(of: "🤖", with: "").trimmingCharacters(in: .whitespaces)
    }

    /// The remove control's VoiceOver label: "Remove Bot 2" for the lobby's
    /// generic names, "Remove bot Mary" for any other bot name.
    var removeBotLabel: String {
        let name = botDisplayName
        if name.isEmpty { return "Remove bot" }
        return name.lowercased().hasPrefix("bot") ? "Remove \(name)" : "Remove bot \(name)"
    }

    /// My own ready flag in the server's list (nil: I am not in it). The lobby's
    /// Ready button follows it, as the web's does: removing a bot (or a player
    /// leaving) clears every ready flag on the server (`removeBotFromLobby`).
    static func readyFlag(of username: String?, in players: [LobbyPlayer]) -> Bool? {
        guard let username, !username.isEmpty else { return nil }
        return players.first { $0.username == username && !$0.isBot }?.isReady
    }
}
