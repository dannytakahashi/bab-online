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

struct GameEndData: Equatable {
    let winningTeam: Int
    let team1Score: Int
    let team2Score: Int
    let team1Players: [String]
    let team2Players: [String]
    let handHistory: [[String: Any]]
    /// gameEnd `playerStats`, one row per seat 1...4 that the payload has (the web's
    /// ScoreModal grid). Empty when an older server or a test payload sends none:
    /// GameEndView then shows no stats.
    var playerStats: [PlayerEndStats] = []

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
            for (posStr, value) in playerStats.sorted(by: { $0.key < $1.key }) {  // seat order, deterministic
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
                           team1Players: t1Players, team2Players: t2Players, handHistory: history,
                           playerStats: PlayerEndStats.rows(dict["playerStats"]))
    }
}

/// One seat's game totals from gameEnd `playerStats` (contract/src/s2c.js gameEnd:
/// `{username, totalBids, totalTricks, setsCaused, totalHSI, avgHSI}` by position).
/// Every field is optional: a missing or mistyped one shows as a dash, never drops the row.
struct PlayerEndStats: Equatable, Identifiable {
    let position: Int
    let username: String
    let totalBids: Int?
    let totalTricks: Int?
    /// "Faults" on the web: the sets this seat caused.
    let setsCaused: Int?
    let avgHSI: Double?

    var id: Int { position }
    var team: Int { Positions.getTeamNumber(position) }

    /// The web's grid: seats 1...4 in order, a seat the payload lacks skipped (ScoreModal.js).
    static func rows(_ raw: Any?) -> [PlayerEndStats] {
        guard let byPosition = raw as? [String: Any] else { return [] }
        return (1...4).compactMap { pos in
            guard let info = byPosition[String(pos)] as? [String: Any] else { return nil }
            return PlayerEndStats(position: pos, username: info["username"] as? String ?? "",
                                  totalBids: int(info["totalBids"]), totalTricks: int(info["totalTricks"]),
                                  setsCaused: int(info["setsCaused"]), avgHSI: number(info["avgHSI"]))
        }
    }

    private static func number(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }

    private static func int(_ v: Any?) -> Int? {
        guard let d = number(v), d == d.rounded(), abs(d) < 1e9 else { return nil }
        return Int(d)
    }

    /// avgHSI as the web prints it: the server rounds it to a whole number; anything
    /// else to one decimal. nil -> "–".
    static func format(_ v: Double?) -> String {
        guard let v else { return "–" }
        return v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v)
    }

    static func format(_ v: Int?) -> String { v.map(String.init) ?? "–" }

    /// VoiceOver reads one sentence per row (the header row is hidden from it).
    var accessibilityLabel: String {
        "\(username.isEmpty ? "Seat \(position)" : username), team \(team): "
            + "\(Self.format(totalBids)) bids, \(Self.format(totalTricks)) tricks, "
            + "\(Self.format(setsCaused)) faults, average HSI \(Self.format(avgHSI))"
    }
}

extension GameEndData {
    /// handHistory is opaque (`[String: Any]`) and display-only: equality ignores it.
    static func == (a: GameEndData, b: GameEndData) -> Bool {
        a.winningTeam == b.winningTeam && a.team1Score == b.team1Score && a.team2Score == b.team2Score
            && a.team1Players == b.team1Players && a.team2Players == b.team2Players
            && a.playerStats == b.playerStats
    }
}
