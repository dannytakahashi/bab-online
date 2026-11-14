import Foundation

/// One row of `leaderboardResponse.leaderboard` (profileHandlers fillLeaderboard): a
/// player's derived stats, or the population-average row. Every field but the
/// username is optional on the wire here: a missing or garbled one reads as 0.
struct LeaderboardEntry: Identifiable, Equatable {
    let id: String
    let username: String
    let profilePic: Int
    /// What AvatarImageView loads: the row's `/avatar/...` URL (avatarUrls, the
    /// clientHello avatarUrl cap) else the stock picture number; nil for the population row.
    let pictureKey: String?
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

    /// A row, or nil without a username. `avatarUrls` is the reply's username -> `/avatar/` map.
    static func from(_ dict: [String: Any], avatarUrls: [String: String] = [:]) -> LeaderboardEntry? {
        guard let username = StatsWire.string(dict["username"]) else { return nil }
        let isPopulation = dict["isPopulation"] as? Bool ?? false
        let pic = StatsWire.int(dict["profilePic"]) ?? 1
        // a legacy (cap-less) reply carries the custom picture inline as a data URL, which the
        // SwiftUI avatar cache does not load: the stock picture then
        let custom = avatarUrls[username] ?? StatsWire.string(dict["customProfilePic"])
        let avatarPath = custom.flatMap { HTTPAvatarLoader.isAvatarPath($0) ? $0 : nil }
        func d(_ key: String) -> Double { StatsWire.number(dict[key]) ?? 0 }
        return LeaderboardEntry(
            // A player may be called "Population": keep the ids distinct
            id: isPopulation ? "\u{0}population" : username,
            username: username,
            profilePic: pic,
            pictureKey: isPopulation ? nil : avatarPath ?? String(pic),
            gamesPlayed: StatsWire.int(dict["gamesPlayed"]) ?? 0,
            winRate: d("winRate"),
            pointsPerGame: d("pointsPerGame"),
            bidsPerGame: d("bidsPerGame"),
            tricksPerBid: d("tricksPerBid"),
            setRate: d("setRate"),
            drag: d("drag"),
            faultsPerGame: d("faultsPerGame"),
            avgHSI: d("avgHSI"),
            isPopulation: isPopulation
        )
    }

    /// The rows of a successful `leaderboardResponse` (rows without a username dropped), or nil
    /// when the reply is not a success with a `leaderboard` array.
    static func rows(fromResponse dict: [String: Any]) -> [LeaderboardEntry]? {
        guard dict["success"] as? Bool == true, let rows = dict["leaderboard"] as? [Any] else { return nil }
        var urls: [String: String] = [:]
        for (name, url) in dict["avatarUrls"] as? [String: Any] ?? [:] {
            if let url = url as? String { urls[name] = url }
        }
        return rows.compactMap { ($0 as? [String: Any]).flatMap { from($0, avatarUrls: urls) } }
    }
}

/// A sortable leaderboard column: the web LeaderboardPage's COLUMNS (same order, labels,
/// formats and preferred directions). The web shows no Faults/Game column, so neither does iOS.
enum LeaderboardColumn: String, CaseIterable, Identifiable {
    case gamesPlayed, winRate, pointsPerGame, bidsPerGame, tricksPerBid, setRate, drag, avgHSI

    var id: String { rawValue }

    /// The web's header label.
    var title: String {
        switch self {
        case .gamesPlayed: return "Games"
        case .winRate: return "Win %"
        case .pointsPerGame: return "Pts/Game"
        case .bidsPerGame: return "Bids/Game"
        case .tricksPerBid: return "Tricks/Bid"
        case .setRate: return "Set %"
        case .drag: return "Drag"
        case .avgHSI: return "HSI"
        }
    }

    /// What VoiceOver says for the column.
    var spokenTitle: String {
        switch self {
        case .gamesPlayed: return "Games played"
        case .winRate: return "Win rate"
        case .pointsPerGame: return "Points per game"
        case .bidsPerGame: return "Bids per game"
        case .tricksPerBid: return "Tricks per bid"
        case .setRate: return "Set rate"
        case .drag: return "Drag"
        case .avgHSI: return "Hand strength index"
        }
    }

    /// The direction a first tap sorts by (the web's defaultAscending: lower is better
    /// for tricks per bid, set rate and drag).
    var defaultAscending: Bool {
        switch self {
        case .tricksPerBid, .setRate, .drag: return true
        default: return false
        }
    }

    func value(_ e: LeaderboardEntry) -> Double {
        switch self {
        case .gamesPlayed: return Double(e.gamesPlayed)
        case .winRate: return e.winRate
        case .pointsPerGame: return e.pointsPerGame
        case .bidsPerGame: return e.bidsPerGame
        case .tricksPerBid: return e.tricksPerBid
        case .setRate: return e.setRate
        case .drag: return e.drag
        case .avgHSI: return e.avgHSI
        }
    }

    /// The web's formatStatValue: integer, percent (1 decimal + "%"), ratio (2), decimal (1).
    func format(_ e: LeaderboardEntry) -> String {
        switch self {
        case .gamesPlayed: return "\(e.gamesPlayed)"
        case .winRate, .setRate: return String(format: "%.1f%%", value(e))
        case .tricksPerBid: return String(format: "%.2f", value(e))
        default: return String(format: "%.1f", value(e))
        }
    }
}

/// The leaderboard's sort, as the web's: Win % descending at first; tapping the sorted
/// column flips its direction, another column sorts in that column's preferred direction.
/// The population row sorts with the players (by its own averages) and is never ranked.
struct LeaderboardSort: Equatable {
    var column: LeaderboardColumn = .winRate
    var ascending = false

    mutating func select(_ c: LeaderboardColumn) {
        if c == column {
            ascending.toggle()
        } else {
            column = c
            ascending = c.defaultAscending
        }
    }

    /// Stable: ties keep the server's order (win rate descending), like the web's Array.sort.
    func sorted(_ rows: [LeaderboardEntry]) -> [LeaderboardEntry] {
        rows.enumerated().sorted { a, b in
            let x = column.value(a.element), y = column.value(b.element)
            if x != y { return ascending ? x < y : x > y }
            return a.offset < b.offset
        }.map(\.element)
    }
}

/// Lenient reads of the stats replies' JSON values (JSONSerialization: NSNumber, NSString, NSNull).
enum StatsWire {
    /// A finite number (never a JSON boolean), or a numeric string.
    static func number(_ any: Any?) -> Double? {
        if let n = any as? NSNumber {
            guard CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
            return n.doubleValue
        }
        if let s = any as? String, let d = Double(s), d.isFinite { return d }
        return nil
    }

    static func int(_ any: Any?) -> Int? {
        number(any).flatMap { abs($0) < 1e15 ? Int($0.rounded()) : nil }
    }

    static func string(_ any: Any?) -> String? {
        guard let s = any as? String, !s.isEmpty else { return nil }
        return s
    }

    /// An array of names (non-strings dropped), or nil when it is not an array.
    static func strings(_ any: Any?) -> [String]? {
        (any as? [Any]).map { $0.compactMap { $0 as? String } }
    }

    /// A number as the web prints it with `${n}`: no decimals when whole.
    static func display(_ n: Double) -> String {
        if n == n.rounded(), abs(n) < 1e15 { return String(Int(n)) }
        return String(n)
    }
}
