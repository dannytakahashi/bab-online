import Foundation

struct LeaderboardEntry: Identifiable {
    let id: String
    let username: String
    let profilePic: Int
    let gamesPlayed: Int
    let winRate: Double
    let pointsPerGame: Double
    let bidsPerGame: Double
    let tricksPerBid: Double
    let setRate: Double
    let drag: Double
    let faultsPerGame: Double
    let avgHSI: Double
    /// The server's population-average row (profileHandlers getLeaderboard): shown, never ranked.
    let isPopulation: Bool

    /// 1-based rank of the row at `index`, counting only player rows (the
    /// population row is unranked, like the web LeaderboardPage).
    static func rank(at index: Int, in rows: [LeaderboardEntry]) -> Int? {
        guard index < rows.count, !rows[index].isPopulation else { return nil }
        return rows[...index].filter { !$0.isPopulation }.count
    }

    static func from(_ dict: [String: Any]) -> LeaderboardEntry? {
        guard let username = dict["username"] as? String else { return nil }
        let isPopulation = dict["isPopulation"] as? Bool ?? false
        return LeaderboardEntry(
            // A player may be called "Population": keep the ids distinct
            id: isPopulation ? "\u{0}population" : username,
            username: username,
            profilePic: dict["profilePic"] as? Int ?? 1,
            gamesPlayed: dict["gamesPlayed"] as? Int ?? 0,
            winRate: dict["winRate"] as? Double ?? 0,
            pointsPerGame: dict["pointsPerGame"] as? Double ?? 0,
            bidsPerGame: dict["bidsPerGame"] as? Double ?? 0,
            tricksPerBid: dict["tricksPerBid"] as? Double ?? 0,
            setRate: dict["setRate"] as? Double ?? 0,
            drag: dict["drag"] as? Double ?? 0,
            faultsPerGame: dict["faultsPerGame"] as? Double ?? 0,
            avgHSI: dict["avgHSI"] as? Double ?? 0,
            isPopulation: isPopulation
        )
    }
}
