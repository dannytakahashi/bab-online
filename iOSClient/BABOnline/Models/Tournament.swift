import Foundation

struct TournamentPlayer: Identifiable, Equatable {
    let id: String          // socket ID
    let username: String
    var pic: String?
    var isReady: Bool
    var isCreator: Bool

    static func from(_ dict: [String: Any]) -> TournamentPlayer? {
        guard let username = dict["username"] as? String else { return nil }
        let id = dict["socketId"] as? String ?? dict["id"] as? String ?? UUID().uuidString
        let pic: String?
        if let s = dict["pic"] as? String { pic = s }
        else if let n = dict["pic"] as? Int { pic = String(n) }
        else { pic = nil }
        let isReady = dict["ready"] as? Bool ?? dict["isReady"] as? Bool ?? false
        let isCreator = dict["isCreator"] as? Bool ?? false
        return TournamentPlayer(id: id, username: username, pic: pic, isReady: isReady, isCreator: isCreator)
    }
}

struct TournamentScoreEntry: Identifiable, Equatable {
    let id: String
    let username: String
    let totalScore: Int
    let roundScores: [Int]

    static func from(_ dict: [String: Any]) -> TournamentScoreEntry? {
        guard let username = dict["username"] as? String else { return nil }
        let totalScore = dict["totalScore"] as? Int ?? 0
        let roundScores = dict["roundScores"] as? [Int] ?? []
        return TournamentScoreEntry(id: username, username: username, totalScore: totalScore, roundScores: roundScores)
    }
}

struct TournamentActiveGame: Identifiable, Equatable {
    let id: String          // game ID
    let humanPlayers: [String]
    let botCount: Int
    let status: String

    static func from(_ dict: [String: Any]) -> TournamentActiveGame? {
        guard let id = dict["gameId"] as? String else { return nil }
        let humanPlayers = dict["humanPlayers"] as? [String] ?? []
        let botCount = dict["botCount"] as? Int ?? 0
        let status = dict["status"] as? String ?? "active"
        return TournamentActiveGame(id: id, humanPlayers: humanPlayers, botCount: botCount, status: status)
    }
}

struct TournamentSummary: Identifiable, Equatable {
    let id: String
    let name: String
    let playerCount: Int
    let phase: String
    let currentRound: Int
    let totalRounds: Int
    let creatorUsername: String

    static func from(_ dict: [String: Any]) -> TournamentSummary? {
        guard let id = dict["id"] as? String else { return nil }
        let name = dict["name"] as? String ?? "Tournament"
        let playerCount = dict["playerCount"] as? Int ?? 0
        let phase = dict["phase"] as? String ?? "lobby"
        let currentRound = dict["currentRound"] as? Int ?? 0
        let totalRounds = dict["totalRounds"] as? Int ?? 4
        let creatorUsername = dict["creatorUsername"] as? String ?? ""
        return TournamentSummary(id: id, name: name, playerCount: playerCount, phase: phase, currentRound: currentRound, totalRounds: totalRounds, creatorUsername: creatorUsername)
    }
}
