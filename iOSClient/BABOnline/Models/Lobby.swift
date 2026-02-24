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
        let pic = dict["pic"] as? String
        let isReady = dict["isReady"] as? Bool ?? dict["ready"] as? Bool ?? false
        let isBot = dict["isBot"] as? Bool ?? false
        return LobbyPlayer(id: id, username: username, pic: pic, isReady: isReady, isBot: isBot)
    }
}
