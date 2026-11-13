#if DEBUG
import Foundation

/// The Stats sheet in fixture mode (no socket): its requests are answered here, 0.4 s later,
/// with wire-shaped replies that go through the same decoding as the server's
/// (LeaderboardState / RecordsState `apply`). `-uiStats` picks the answers:
/// `ok` (the default), `empty` (no players, no games), `error` (Database error),
/// `rateLimited` (the soft limit's reply), `silent` (never answers: the 10 s timeout),
/// `refreshFail` (the first answer of each tab ok, every later one an error).
extension UIFixture {
    static let statsMode: String = UserDefaults.standard.string(forKey: "uiStats") ?? "ok"

    static func seedStats(leaderboard: LeaderboardState, records: RecordsState) {
        guard isActive else { return }
        var asked = (leaderboard: 0, records: 0)
        leaderboard.send = { [weak leaderboard] in
            asked.leaderboard += 1
            let reply = statsReply(leaderboard: true, attempt: asked.leaderboard)
            guard let reply else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { leaderboard?.apply(response: reply) }
        }
        records.send = { [weak records] in
            asked.records += 1
            let reply = statsReply(leaderboard: false, attempt: asked.records)
            guard let reply else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { records?.apply(response: reply) }
        }
    }

    private static func statsReply(leaderboard: Bool, attempt: Int) -> [String: Any]? {
        switch statsMode {
        case "silent": return nil
        case "error": return ["success": false, "message": "Database error"]
        case "rateLimited": return ["success": false, "message": "Too many requests. Please wait a moment."]
        case "refreshFail" where attempt > 1: return ["success": false, "message": "Database error"]
        case "empty":
            return leaderboard ? ["success": true, "leaderboard": [Any]()]
                : ["success": true, "records": ["allTime": NSNull(), "thisYear": NSNull(), "thisMonth": NSNull()], "totalGames": 0]
        default: return leaderboard ? leaderboardFixture : recordsFixture
        }
    }

    /// As profileHandlers sends it to a capable socket: rows sorted by win rate, the population
    /// row among them, customProfilePic null + avatarUrls, one row with only its name (decoded
    /// as zeros) and one without a name (dropped).
    static let leaderboardFixture: [String: Any] = {
        func row(_ u: String, _ pic: Int, _ g: Int, _ w: Double, _ ppg: Double, _ bpg: Double, _ tpb: Double,
                 _ set: Double, _ drag: Double, _ hsi: Double) -> [String: Any] {
            ["username": u, "profilePic": pic, "customProfilePic": NSNull(), "gamesPlayed": g, "winRate": w,
             "pointsPerGame": ppg, "bidsPerGame": bpg, "tricksPerBid": tpb, "setRate": set, "drag": drag,
             "faultsPerGame": 0.2, "avgHSI": hsi]
        }
        var population = row("Population", 1, 27, 52.2, 197.8, 11.9, 1.06, 12.7, 68.8, 8.0)
        population["isPopulation"] = true
        population.removeValue(forKey: "profilePic")
        population.removeValue(forKey: "customProfilePic")
        return [
            "success": true,
            "leaderboard": [
                row("Christopher Johnson1", 45, 6, 66.7, 246.7, 11.7, 1.06, 7.7, 36.7, 8.8),
                row("kim", 12, 42, 64.3, 225.0, 12.4, 1.05, 11.2, 58.1, 7.7),
                row("ivy", 31, 51, 58.8, 231.4, 12.5, 1.02, 11.6, 60.4, 8.1),
                row("max", 3, 12, 58.3, 220.8, 12.5, 0.99, 9.6, 50.8, 8.3),
                population,
                row("hal", 31, 38, 50.0, 187.4, 12.0, 1.03, 14.2, 77.6, 7.5),
                row("ned", 20, 30, 50.0, 193.3, 12.0, 1.03, 11.3, 62.7, 8.7),
                row("jon", 7, 25, 36.0, 156.0, 11.2, 1.07, 17.8, 104.0, 7.1),
                ["username": "pat"],
                ["gamesPlayed": 3],
            ] as [Any],
            "avatarUrls": ["kim": "/avatar/kim?v=3"],
        ]
    }()

    /// All three periods: This Year from legacy games (no bag records), This Month empty.
    static let recordsFixture: [String: Any] = [
        "success": true,
        "totalGames": 1234,
        "records": [
            "allTime": [
                "highestScore": ["score": 610, "players": ["kim", "ora"]],
                "lowestScore": ["score": -240, "players": ["jon", "pat"]],
                "biggestWin": ["margin": 705, "winnerScore": 610, "loserScore": -95,
                               "winnerPlayers": ["kim", "ora"], "loserPlayers": ["pat", "hal"]],
                "mostBags": ["bags": 15, "players": ["kim", "ora"]],
                "leastBags": ["bags": 0, "players": ["jon", "hal"]],
            ],
            "thisYear": [
                "highestScore": ["score": 545, "players": ["ora", "max"]],
                "lowestScore": ["score": -180, "players": ["jon", "hal"]],
                "biggestWin": ["margin": 440, "winnerScore": 260, "loserScore": -180,
                               "winnerPlayers": ["kim", "ned"], "loserPlayers": ["jon", "hal"]],
                "mostBags": NSNull(),
                "leastBags": NSNull(),
            ],
            "thisMonth": NSNull(),
        ] as [String: Any],
    ]
}
#endif
