#if DEBUG
import Foundation

/// The Stats sheet in fixture mode (no socket): its requests are answered here, 0.4 s later,
/// with wire-shaped replies that go through the same decoding as the server's
/// (LeaderboardState / RecordsState `apply`). `-uiStats` picks the answers:
/// `ok` (the default), `empty` (no players, no games), `error` (Database error),
/// `rateLimited` (the soft limit's reply), `silent` (never answers: the 10 s timeout),
/// `refreshFail` (the first answer of each tab ok, every later one an error).
/// Human games are answered as today's server does (no `scope` echo); Bots and All as the
/// scoped server does (`scope` echoed; bot games' records carry `withBots`). The saved scope
/// starts at Humans in fixture mode unless `-uiStatsKeepScope YES` (the persistence test).
extension UIFixture {
    static let statsMode: String = UserDefaults.standard.string(forKey: "uiStats") ?? "ok"

    static func seedStats(leaderboard: LeaderboardState, records: RecordsState) {
        guard isActive else { return }
        if !UserDefaults.standard.bool(forKey: "uiStatsKeepScope") {
            leaderboard.select(.human)
            records.select(.human)
        }
        var asked = (leaderboard: 0, records: 0)
        leaderboard.send = { [weak leaderboard] scope in
            asked.leaderboard += 1
            let reply = statsReply(leaderboard: true, scope: scope, attempt: asked.leaderboard)
            guard let reply else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { leaderboard?.apply(response: reply) }
        }
        records.send = { [weak records] scope in
            asked.records += 1
            let reply = statsReply(leaderboard: false, scope: scope, attempt: asked.records)
            guard let reply else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { records?.apply(response: reply) }
        }
    }

    private static func statsReply(leaderboard: Bool, scope: StatsScope, attempt: Int) -> [String: Any]? {
        var reply: [String: Any]
        switch statsMode {
        case "silent": return nil
        case "error": return ["success": false, "message": "Database error"]
        case "rateLimited": return ["success": false, "message": "Too many requests. Please wait a moment."]
        case "refreshFail" where attempt > 1: return ["success": false, "message": "Database error"]
        case "empty":
            reply = leaderboard ? ["success": true, "leaderboard": [Any]()]
                : ["success": true, "records": ["allTime": NSNull(), "thisYear": NSNull(), "thisMonth": NSNull()], "totalGames": 0]
        default:
            switch scope {
            case .human: reply = leaderboard ? leaderboardFixture : recordsFixture
            case .bots: reply = leaderboard ? botsLeaderboardFixture : botsRecordsFixture
            case .all: reply = leaderboard ? allLeaderboardFixture : allRecordsFixture
            }
        }
        if scope != .human { reply["scope"] = scope.rawValue }
        return reply
    }

    /// Bot games: two players and the population row.
    static let botsLeaderboardFixture: [String: Any] = [
        "success": true,
        "leaderboard": [
            ["username": "ora", "profilePic": 9, "gamesPlayed": 4, "winRate": 75.0, "pointsPerGame": 260.0,
             "bidsPerGame": 12.8, "tricksPerBid": 1.04, "setRate": 8.0, "drag": 30.0, "faultsPerGame": 0.0, "avgHSI": 8.4],
            ["username": "kim", "profilePic": 12, "gamesPlayed": 2, "winRate": 50.0, "pointsPerGame": 210.0,
             "bidsPerGame": 12.0, "tricksPerBid": 1.0, "setRate": 10.0, "drag": 45.0, "faultsPerGame": 0.5, "avgHSI": 7.9],
            ["username": "Population", "isPopulation": true, "gamesPlayed": 6, "winRate": 66.7, "pointsPerGame": 243.3,
             "bidsPerGame": 12.5, "tricksPerBid": 1.03, "setRate": 8.7, "drag": 35.0, "faultsPerGame": 0.2, "avgHSI": 8.2],
        ] as [Any],
    ]

    /// Human and bot games summed: the human rows with kim's two bot games added and ora's row.
    static let allLeaderboardFixture: [String: Any] = {
        var reply = leaderboardFixture
        var rows = reply["leaderboard"] as? [[String: Any]] ?? []
        if let i = rows.firstIndex(where: { $0["username"] as? String == "kim" }) { rows[i]["gamesPlayed"] = 44 }
        rows.insert((botsLeaderboardFixture["leaderboard"] as? [[String: Any]])?.first ?? [:], at: 1)
        reply["leaderboard"] = rows
        return reply
    }()

    /// Bot games: six this month (the server started counting them at its update).
    static let botsRecordsFixture: [String: Any] = {
        let month: [String: Any] = [
            "highestScore": ["score": 480, "players": ["ora", "🤖 Mary"], "withBots": true],
            "lowestScore": ["score": -60, "players": ["🤖 Lou", "🤖 Ann"], "withBots": true],
            "biggestWin": ["margin": 410, "winnerScore": 480, "loserScore": 70, "withBots": true,
                           "winnerPlayers": ["ora", "🤖 Mary"], "loserPlayers": ["🤖 Lou", "🤖 Ann"]],
            "mostBags": ["bags": 9, "players": ["kim", "🤖 Bo"], "withBots": true],
            "leastBags": ["bags": 1, "players": ["ora", "🤖 Mary"], "withBots": true],
        ]
        return ["success": true, "totalGames": 6, "records": ["allTime": month, "thisYear": month, "thisMonth": month]]
    }()

    static let allRecordsFixture: [String: Any] = {
        var reply = recordsFixture
        reply["totalGames"] = 1240
        return reply
    }()

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
