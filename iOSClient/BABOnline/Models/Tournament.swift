import Foundation

struct TournamentPlayer: Identifiable, Equatable {
    let id: String          // socket ID
    let username: String
    var pic: String?
    var isReady: Bool
    var isCreator: Bool
    var connected: Bool

    static func from(_ dict: [String: Any]) -> TournamentPlayer? {
        guard let username = dict["username"] as? String else { return nil }
        let id = dict["socketId"] as? String ?? dict["id"] as? String ?? UUID().uuidString
        let pic = picString(from: dict["pic"])
        let isReady = dict["ready"] as? Bool ?? dict["isReady"] as? Bool ?? false
        let isCreator = dict["isCreator"] as? Bool ?? false
        let connected = dict["connected"] as? Bool ?? true
        return TournamentPlayer(id: id, username: username, pic: pic, isReady: isReady, isCreator: isCreator, connected: connected)
    }
}

struct TournamentScoreEntry: Identifiable, Equatable {
    let id: String
    let username: String
    let totalScore: Int
    let roundScores: [Int]
    /// How a round's score came about, by round index (0-based), from the additive
    /// `roundDetails` rows (server 2026-11-15, Tournament scoring); a normal table has none.
    var roundFlags: [Int: TournamentRoundFlag] = [:]

    static func from(_ dict: [String: Any]) -> TournamentScoreEntry? {
        guard let username = dict["username"] as? String else { return nil }
        let totalScore = dict["totalScore"] as? Int ?? 0
        let roundScores = dict["roundScores"] as? [Int] ?? []
        var flags: [Int: TournamentRoundFlag] = [:]
        for detail in dict["roundDetails"] as? [[String: Any]] ?? [] {
            guard let round = detail["roundNumber"] as? Int, round >= 1, let flag = TournamentRoundFlag.of(detail) else { continue }
            flags[round - 1] = flag
        }
        return TournamentScoreEntry(id: username, username: username, totalScore: totalScore, roundScores: roundScores, roundFlags: flags)
    }

    /// "142", "-40†", or "-" for a round with no score yet.
    func cellText(round index: Int) -> String {
        guard index >= 0, index < roundScores.count else { return "-" }
        return "\(roundScores[index])\(roundFlags[index]?.marker ?? "")"
    }

    /// VoiceOver: "1. kim, 230 points. Round 1: 142. Round 2: 88, sat out".
    func spokenSummary(rank: Int? = nil, totalRounds: Int) -> String {
        var parts = ["\(rank.map { "\($0). " } ?? "")\(username), \(totalScore) points"]
        for index in 0..<max(0, totalRounds) where index < roundScores.count {
            let note = roundFlags[index].map { ", \($0.spoken)" } ?? ""
            parts.append("Round \(index + 1): \(roundScores[index])\(note)")
        }
        return parts.joined(separator: ". ")
    }
}

/// A round score that did not come from a finished table (`roundDetails` flags, all
/// additive and optional): the table was aborted (everyone at it scores the running
/// score), this player left it (min(running, 0)), or the player missed the round (the
/// round's lowest score).
enum TournamentRoundFlag: String, Equatable, CaseIterable {
    case aborted, left, missed

    /// `left` rows carry `aborted` too: the more specific one wins.
    static func of(_ detail: [String: Any]) -> TournamentRoundFlag? {
        if detail["missed"] as? Bool == true { return .missed }
        if detail["left"] as? Bool == true { return .left }
        if detail["aborted"] as? Bool == true { return .aborted }
        return nil
    }

    var marker: String {
        switch self {
        case .aborted: return "*"
        case .left: return "\u{2020}"
        case .missed: return "\u{2021}"
        }
    }

    /// The legend under the results table.
    var legend: String {
        switch self {
        case .aborted: return "table ended early"
        case .left: return "left the table"
        case .missed: return "sat out (round\u{2019}s lowest score)"
        }
    }

    var spoken: String {
        switch self {
        case .aborted: return "table ended early"
        case .left: return "left the table"
        case .missed: return "sat out"
        }
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
