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

    static func from(_ dict: [String: Any]) -> LeaderboardEntry? {
        guard let username = dict["username"] as? String else { return nil }
        return LeaderboardEntry(
            id: username,
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
            avgHSI: dict["avgHSI"] as? Double ?? 0
        )
    }
}
