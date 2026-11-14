import Foundation

/// `recordsResponse` (profileHandlers fillRecords; $defs.recordsPeriod): highest / lowest
/// team score, biggest win and most / least bags for All Time, This Year and This Month
/// (server-local year and month), plus the total game count. Decoded field by field and
/// optionally: a period that is null, missing or not an object has no games yet, and so
/// does a record that is null or lacks its core fields (the web's "No games yet").
struct GameRecords: Equatable {
    /// The three periods in the web's order.
    enum Period: String, CaseIterable, Identifiable {
        case allTime, thisYear, thisMonth
        var id: String { rawValue }
        /// The web's box titles.
        var title: String {
            switch self {
            case .allTime: return "All Time"
            case .thisYear: return "This Year"
            case .thisMonth: return "This Month"
            }
        }
    }

    /// A team's score or bag count and who played.
    struct TeamRecord: Equatable {
        let value: Double
        let players: [String]
    }

    struct WinRecord: Equatable {
        let margin: Double
        let winnerScore: Double
        let loserScore: Double
        let winnerPlayers: [String]
        let loserPlayers: [String]
    }

    struct PeriodRecords: Equatable {
        var highestScore: TeamRecord?
        var lowestScore: TeamRecord?
        var biggestWin: WinRecord?
        var mostBags: TeamRecord?
        var leastBags: TeamRecord?
    }

    /// The total number of recorded games; nil when the reply has none (the web then shows no line).
    var totalGames: Int?
    /// A period with no recorded game is absent.
    var periods: [Period: PeriodRecords] = [:]

    /// A successful reply's records, or nil when the reply is not `success: true`.
    /// A reply without `records` decodes to three empty periods.
    static func from(response dict: [String: Any]) -> GameRecords? {
        guard dict["success"] as? Bool == true else { return nil }
        var out = GameRecords()
        if let total = StatsWire.int(dict["totalGames"]), total >= 0 { out.totalGames = total }
        let records = dict["records"] as? [String: Any] ?? [:]
        for p in Period.allCases {
            if let period = records[p.rawValue] as? [String: Any] { out.periods[p] = periodRecords(period) }
        }
        return out
    }

    static func periodRecords(_ d: [String: Any]) -> PeriodRecords {
        PeriodRecords(
            highestScore: team(d["highestScore"], key: "score"),
            lowestScore: team(d["lowestScore"], key: "score"),
            biggestWin: win(d["biggestWin"]),
            mostBags: team(d["mostBags"], key: "bags"),
            leastBags: team(d["leastBags"], key: "bags")
        )
    }

    private static func team(_ any: Any?, key: String) -> TeamRecord? {
        guard let d = any as? [String: Any], let v = StatsWire.number(d[key]) else { return nil }
        return TeamRecord(value: v, players: StatsWire.strings(d["players"]) ?? [])
    }

    private static func win(_ any: Any?) -> WinRecord? {
        guard let d = any as? [String: Any], let margin = StatsWire.number(d["margin"]) else { return nil }
        return WinRecord(
            margin: margin,
            winnerScore: StatsWire.number(d["winnerScore"]) ?? 0,
            loserScore: StatsWire.number(d["loserScore"]) ?? 0,
            winnerPlayers: StatsWire.strings(d["winnerPlayers"]) ?? [],
            loserPlayers: StatsWire.strings(d["loserPlayers"]) ?? []
        )
    }
}

/// One record as the Records tab shows it: the web RecordsPage's createRecordEntry
/// (label, tone, value and the lines under it), or "No games yet".
struct RecordRow: Equatable, Identifiable {
    enum Tone: Equatable { case success, danger, warning, neutral }
    enum Line: Equatable {
        case plain(String)
        case winner(String)
        case loser(String)
    }

    let label: String
    let tone: Tone
    /// nil: "No games yet".
    let value: String?
    let lines: [Line]
    var id: String { label }

    /// What VoiceOver reads for the whole record.
    var spoken: String {
        guard let value else { return "\(label), no games yet" }
        let rest = lines.map { line -> String in
            switch line {
            case .plain(let s): return s
            case .winner(let s): return "winners " + s.dropFirst(3)
            case .loser(let s): return "losers " + s.dropFirst(3)
            }
        }
        return ([label, value] + rest).joined(separator: ", ")
    }

    /// The five rows of a period, in the web's order and labels.
    static func rows(_ p: GameRecords.PeriodRecords) -> [RecordRow] {
        [
            team("Highest Score", .success, p.highestScore, unit: "pts"),
            team("Lowest Score", .danger, p.lowestScore, unit: "pts"),
            win(p.biggestWin),
            team("Most Bags", .neutral, p.mostBags, unit: "bags"),
            team("Least Bags", .neutral, p.leastBags, unit: "bags"),
        ]
    }

    private static func names(_ players: [String]) -> String { players.joined(separator: " & ") }

    private static func team(_ label: String, _ tone: Tone, _ r: GameRecords.TeamRecord?, unit: String) -> RecordRow {
        guard let r else { return RecordRow(label: label, tone: tone, value: nil, lines: []) }
        return RecordRow(label: label, tone: tone, value: "\(StatsWire.display(r.value)) \(unit)", lines: [.plain(names(r.players))])
    }

    private static func win(_ w: GameRecords.WinRecord?) -> RecordRow {
        let label = "Biggest Win"
        guard let w else { return RecordRow(label: label, tone: .warning, value: nil, lines: []) }
        return RecordRow(label: label, tone: .warning, value: "\(StatsWire.display(w.margin)) pt margin", lines: [
            .plain("\(StatsWire.display(w.winnerScore)) - \(StatsWire.display(w.loserScore))"),
            .winner("W: \(names(w.winnerPlayers))"),
            .loser("L: \(names(w.loserPlayers))"),
        ])
    }
}
