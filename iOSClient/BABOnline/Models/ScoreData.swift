import Foundation

struct PlayedCard: Equatable {
    let card: Card
    let position: Int
}

struct TrickResult {
    let winner: Int
    let cards: [PlayedCard]
}

struct HandResult {
    let team1Score: Int
    let team2Score: Int
    let team1Tricks: Int
    let team2Tricks: Int
    let team1Bid: Int
    let team2Bid: Int
    let handNumber: Int
    var team1Rainbows: Int = 0
    var team2Rainbows: Int = 0
}

struct GameEndData {
    let winningTeam: Int
    let team1Score: Int
    let team2Score: Int
    let team1Players: [String]
    let team2Players: [String]
    let handHistory: [[String: Any]]

    static func from(_ dict: [String: Any]) -> GameEndData? {
        let winner = dict["winner"] as? Int ?? dict["winningTeam"] as? Int ?? 0
        let t1Score = dict["team1Score"] as? Int ?? 0
        let t2Score = dict["team2Score"] as? Int ?? 0
        let t1Players = dict["team1Players"] as? [String] ?? []
        let t2Players = dict["team2Players"] as? [String] ?? []
        let history = dict["handHistory"] as? [[String: Any]] ?? []
        return GameEndData(winningTeam: winner, team1Score: t1Score, team2Score: t2Score,
                           team1Players: t1Players, team2Players: t2Players, handHistory: history)
    }
}
