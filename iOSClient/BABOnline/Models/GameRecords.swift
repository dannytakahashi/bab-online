import Foundation

/// `recordsResponse` (profileHandlers fillRecords; $defs.recordsPeriod): highest / lowest
/// team score, biggest win and most / least bags for All Time, This Year and This Month
/// (server-local year and month), plus the total game count and each period's game count
/// (`periodGames`, additive 2026-11-14; 1.2.1 build 9) and each period's superlatives
/// (`superlatives`, additive 2026-11-20; owner-approved titles such as "Bag Boy"). Decoded field by field and
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
        /// The period's superlatives in the server's order (empty: none, or a server from before
        /// them). Rendered generically, so a title this build does not know shows the same way.
        var superlatives: [Superlative] = []
    }

    /// One superlative (`recordsPeriod.superlatives[]`, additive 2026-11-20): a title the server
    /// names (`id` "bagBoy", title "Bag Boy"), its human winners (ties: up to 3, alphabetical)
    /// and a detail line ("2.4 bags a game"; the server appends " (+2 more)" for a longer tie). The client never reads
    /// `id` for anything but identity, so a future title needs no client release.
    struct Superlative: Equatable, Identifiable {
        let id: String
        let title: String
        let names: [String]
        let detail: String

        /// The winners as the row shows them.
        var namesLine: String { names.joined(separator: ", ") }

        /// What VoiceOver reads for the row.
        var spoken: String {
            ([title, namesLine] + (detail.isEmpty ? [] : [detail])).joined(separator: ", ")
        }

        /// One entry, leniently: it needs a title and at least one name (a non-empty string);
        /// `id` falls back to the title, `detail` to "" when missing or not a string. Anything
        /// else (not an object, no title, no names) is nil and skipped, never failing the reply.
        static func from(_ any: Any?) -> Superlative? {
            guard let d = any as? [String: Any], let title = StatsWire.string(d["title"]) else { return nil }
            let names = (StatsWire.strings(d["names"]) ?? []).filter { !$0.isEmpty }
            guard !names.isEmpty else { return nil }
            return Superlative(id: StatsWire.string(d["id"]) ?? title, title: title, names: names,
                               detail: StatsWire.string(d["detail"]) ?? "")
        }

        /// A period's list: entries that decode, in order; a repeated id keeps its first entry
        /// (ids identify the rows). Not an array: none.
        static func list(_ any: Any?) -> [Superlative] {
            var seen = Set<String>()
            return (any as? [Any] ?? []).compactMap(from).filter { seen.insert($0.id).inserted }
        }
    }

    /// The total (all-time) number of recorded games; nil when the reply has none.
    var totalGames: Int?
    /// A period with no recorded game is absent.
    var periods: [Period: PeriodRecords] = [:]
    /// Each period's game count (`periodGames`); a count missing or not a non-negative number
    /// is absent.
    var periodGames: [Period: Int] = [:]

    /// How many games `period` holds: its `periodGames` count, else (a server from before
    /// periodGames) `totalGames` for All Time only; nil when not known (the count is not shown).
    /// The owner (2026-11-14): the one total read the same whichever period was selected.
    func games(in period: Period) -> Int? {
        if let n = periodGames[period] { return n }
        return period == .allTime ? totalGames : nil
    }

    /// No recorded game: an all-time count of 0, or no count and no period with a game.
    var isEmpty: Bool {
        if let n = games(in: .allTime) { return n == 0 }
        return periods.isEmpty
    }

    /// A successful reply's records, or nil when the reply is not `success: true`.
    /// Fields this build does not know (a bot game's `withBots`, bot seat markers) are ignored.
    /// A reply without `records` decodes to three empty periods.
    static func from(response dict: [String: Any]) -> GameRecords? {
        guard dict["success"] as? Bool == true else { return nil }
        var out = GameRecords()
        if let total = StatsWire.int(dict["totalGames"]), total >= 0 { out.totalGames = total }
        if let counts = dict["periodGames"] as? [String: Any] {
            for p in Period.allCases {
                if let n = StatsWire.int(counts[p.rawValue]), n >= 0 { out.periodGames[p] = n }
            }
        }
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
            leastBags: team(d["leastBags"], key: "bags"),
            superlatives: Superlative.list(d["superlatives"])
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
