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
        // Server sends { score: { team1: N, team2: N }, playerStats: { "1": { username, ... }, ... } }
        var t1Score = dict["team1Score"] as? Int ?? 0
        var t2Score = dict["team2Score"] as? Int ?? 0

        // Parse nested score dict (actual server format)
        if let score = dict["score"] as? [String: Any] {
            t1Score = score["team1"] as? Int ?? t1Score
            t2Score = score["team2"] as? Int ?? t2Score
        }

        // Derive winning team from scores
        var winner = dict["winner"] as? Int ?? dict["winningTeam"] as? Int ?? 0
        if winner == 0 {
            winner = t1Score >= t2Score ? 1 : 2
        }

        // Parse team players from playerStats (positions 1,3 = team1; 2,4 = team2)
        var t1Players = dict["team1Players"] as? [String] ?? []
        var t2Players = dict["team2Players"] as? [String] ?? []

        if t1Players.isEmpty || t2Players.isEmpty,
           let playerStats = dict["playerStats"] as? [String: Any] {
            var team1Names: [String] = []
            var team2Names: [String] = []
            for (posStr, value) in playerStats {
                guard let pos = Int(posStr),
                      let info = value as? [String: Any],
                      let username = info["username"] as? String else { continue }
                if pos == 1 || pos == 3 {
                    team1Names.append(username)
                } else if pos == 2 || pos == 4 {
                    team2Names.append(username)
                }
            }
            if !team1Names.isEmpty { t1Players = team1Names }
            if !team2Names.isEmpty { t2Players = team2Names }
        }

        let history = dict["handHistory"] as? [[String: Any]] ?? []
        return GameEndData(winningTeam: winner, team1Score: t1Score, team2Score: t2Score,
                           team1Players: t1Players, team2Players: t2Players, handHistory: history)
    }
}
