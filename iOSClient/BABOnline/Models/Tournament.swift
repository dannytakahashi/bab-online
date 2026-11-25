import Foundation

struct TournamentPlayer: Identifiable, Equatable {
    let id: String          // socket ID
    let username: String
    var pic: String?
    var isReady: Bool
    var isCreator: Bool
    var connected: Bool

    static func from(_ dict: [String: Any]) -> TournamentPlayer? {
        guard let username = dict["username"] as? String else { return nil }
        let id = dict["socketId"] as? String ?? dict["id"] as? String ?? UUID().uuidString
        let pic = picString(from: dict["pic"])
        let isReady = dict["ready"] as? Bool ?? dict["isReady"] as? Bool ?? false
        let isCreator = dict["isCreator"] as? Bool ?? false
        let connected = dict["connected"] as? Bool ?? true
        return TournamentPlayer(id: id, username: username, pic: pic, isReady: isReady, isCreator: isCreator, connected: connected)
    }
}

struct TournamentScoreEntry: Identifiable, Equatable {
    let id: String
    let username: String
    let totalScore: Int
    let roundScores: [Int]
    /// How a round's score came about, by round index (0-based), from the additive
    /// `roundDetails` rows (server 2026-11-15, Tournament scoring); a normal table has none.
    var roundFlags: [Int: TournamentRoundFlag] = [:]

    static func from(_ dict: [String: Any]) -> TournamentScoreEntry? {
        guard let username = dict["username"] as? String else { return nil }
        let totalScore = dict["totalScore"] as? Int ?? 0
        let roundScores = dict["roundScores"] as? [Int] ?? []
        var flags: [Int: TournamentRoundFlag] = [:]
        for detail in dict["roundDetails"] as? [[String: Any]] ?? [] {
            guard let round = detail["roundNumber"] as? Int, round >= 1, let flag = TournamentRoundFlag.of(detail) else { continue }
            flags[round - 1] = flag
        }
        return TournamentScoreEntry(id: username, username: username, totalScore: totalScore, roundScores: roundScores, roundFlags: flags)
    }

    /// "142", "-40†", or "-" for a round with no score yet.
    func cellText(round index: Int) -> String {
        guard index >= 0, index < roundScores.count else { return "-" }
        return "\(roundScores[index])\(roundFlags[index]?.marker ?? "")"
    }

    /// VoiceOver: "1. kim, 230 points. Round 1: 142. Round 2: 88, sat out".
    func spokenSummary(rank: Int? = nil, totalRounds: Int) -> String {
        var parts = ["\(rank.map { "\($0). " } ?? "")\(username), \(totalScore) points"]
        for index in 0..<max(0, totalRounds) where index < roundScores.count {
            let note = roundFlags[index].map { ", \($0.spoken)" } ?? ""
            parts.append("Round \(index + 1): \(roundScores[index])\(note)")
        }
        return parts.joined(separator: ". ")
    }
}

/// A round score that did not come from a finished table (`roundDetails` flags, all
/// additive and optional): the table was aborted (everyone at it scores the running
/// score), this player left it (min(running, 0)), or the player missed the round (the
/// round's lowest score).
enum TournamentRoundFlag: String, Equatable, CaseIterable {
    case aborted, left, missed

    /// `left` rows carry `aborted` too: the more specific one wins.
    static func of(_ detail: [String: Any]) -> TournamentRoundFlag? {
        if detail["missed"] as? Bool == true { return .missed }
        if detail["left"] as? Bool == true { return .left }
        if detail["aborted"] as? Bool == true { return .aborted }
        return nil
    }

    var marker: String {
        switch self {
        case .aborted: return "*"
        case .left: return "\u{2020}"
        case .missed: return "\u{2021}"
        }
    }

    /// The legend under the results table.
    var legend: String {
        switch self {
        case .aborted: return "table ended early"
        case .left: return "left the table"
        case .missed: return "sat out (round\u{2019}s lowest score)"
        }
    }

    var spoken: String {
        switch self {
        case .aborted: return "table ended early"
        case .left: return "left the table"
        case .missed: return "sat out"
        }
    }
}

struct TournamentActiveGame: Identifiable, Equatable {
    let id: String          // game ID
    let humanPlayers: [String]
    let botCount: Int
    let status: String

    static func from(_ dict: [String: Any]) -> TournamentActiveGame? {
        guard let id = dict["gameId"] as? String else { return nil }
        let humanPlayers = dict["humanPlayers"] as? [String] ?? []
        let botCount = dict["botCount"] as? Int ?? 0
        let status = dict["status"] as? String ?? "active"
        return TournamentActiveGame(id: id, humanPlayers: humanPlayers, botCount: botCount, status: status)
    }
}

struct TournamentSummary: Identifiable, Equatable {
    let id: String
    let name: String
    let playerCount: Int
    let phase: String
    let currentRound: Int
    let totalRounds: Int
    let creatorUsername: String
    /// Cut for a buck is on (additive 2026-11-25; the phase reads 'round_active' for everyone).
    var cut = false

    static func from(_ dict: [String: Any]) -> TournamentSummary? {
        guard let id = dict["id"] as? String else { return nil }
        let name = dict["name"] as? String ?? "Tournament"
        let playerCount = dict["playerCount"] as? Int ?? 0
        let phase = dict["phase"] as? String ?? "lobby"
        let currentRound = dict["currentRound"] as? Int ?? 0
        let totalRounds = dict["totalRounds"] as? Int ?? 4
        let creatorUsername = dict["creatorUsername"] as? String ?? ""
        return TournamentSummary(id: id, name: name, playerCount: playerCount, phase: phase, currentRound: currentRound, totalRounds: totalRounds,
                                 creatorUsername: creatorUsername, cut: dict["cut"] as? Bool ?? false)
    }
}

/// One round's tables as the tournament events' `pairings` carry them (server
/// TournamentState.pairingsWire, owner 2026-11-25: partners are shown openly): each table's two
/// teams of two usernames, nil for a bot. Read leniently, as the web's `cleanPairings`: a round
/// without a round number >= 1 is dropped, a table without exactly 2 x 2 names (strings or
/// null) is dropped, never the whole list.
struct TournamentRoundPairings: Equatable {
    struct Table: Equatable {
        let gameId: String?
        /// [[a, b], [c, d]]: usernames, nil = a bot
        let teams: [[String?]]
    }

    let roundNumber: Int
    let tables: [Table]

    static func from(_ dict: [String: Any]) -> TournamentRoundPairings? {
        guard let round = dict["roundNumber"] as? Int, round >= 1, let rawTables = dict["tables"] as? [Any] else { return nil }
        let tables: [Table] = rawTables.compactMap { raw in
            guard let t = raw as? [String: Any], let rawTeams = t["teams"] as? [Any], rawTeams.count == 2 else { return nil }
            var teams: [[String?]] = []
            for rawTeam in rawTeams {
                guard let team = rawTeam as? [Any], team.count == 2 else { return nil }
                var names: [String?] = []
                for u in team {
                    if u is NSNull { names.append(nil) } else if let s = u as? String, !s.isEmpty { names.append(s) } else { return nil }
                }
                teams.append(names)
            }
            return Table(gameId: t["gameId"] as? String, teams: teams)
        }
        return TournamentRoundPairings(roundNumber: round, tables: tables)
    }

    /// The event's `pairings`, in round order; nil when the key is not an array (absent: an
    /// older server, the lobby phase, a 1-member tournament).
    static func list(_ any: Any?) -> [TournamentRoundPairings]? {
        guard let arr = any as? [Any] else { return nil }
        return arr.compactMap { ($0 as? [String: Any]).flatMap(from) }.sorted { $0.roundNumber < $1.roundNumber }
    }
}

/// The tournament screen's pairings in words, the web's client/src/ui/screens/tournamentPairings.js
/// (same words): the latest round's tables ("Round 2 pairings", my table first) and, for a member,
/// "Partners so far" (each round's partner: a name, "a bot", or "sat out"); a spectator gets every
/// round's tables instead. Teams are named by their players, never by number (owner rule): my own
/// team first as "You & ...". Not a whole-tournament chart: the server plans each round from who
/// is there, so only rounds already planned are shown.
enum TournamentPairingRules {
    /// The clientHello cap: the server sends `startDraw.teams` as a draw for first deal and seats a
    /// tournament table's draw honestly only when every human there has it (server
    /// tournamentPartners.PAIRINGS_CAP).
    static let cap = "tournamentPairings"
    static let aBot = "a bot"
    static let satOut = "sat out"

    struct Partner: Equatable { let roundNumber: Int; let partner: String }

    private static func contains(_ team: [String?], _ me: String?) -> Bool {
        guard let me, !me.isEmpty else { return false }
        return team.contains { $0 == me }
    }

    /// My table in a round, or nil.
    static func tableOf(_ round: TournamentRoundPairings, me: String?) -> TournamentRoundPairings.Table? {
        round.tables.first { $0.teams.contains { contains($0, me) } }
    }

    /// One team in words: "You & Hannah", "Ed & a bot", "two bots".
    static func teamWords(_ team: [String?], me: String?) -> String {
        if contains(team, me) {
            let other = team[0] == me ? team[1] : team[0]
            return "You & \(other ?? aBot)"
        }
        if team.allSatisfy({ $0 == nil }) { return "two bots" }
        return team.map { $0 ?? aBot }.joined(separator: " & ")
    }

    /// A table in words, my team first: "You & Hannah vs Danny & Clara", "Ed & a bot vs Fay & a
    /// bot", "You & a bot vs two bots".
    static func line(_ teams: [[String?]], me: String?) -> String {
        let at = teams.firstIndex { contains($0, me) }
        let ordered = (at ?? 0) > 0 ? [teams[at!]] + teams.enumerated().filter { $0.offset != at }.map(\.element) : teams
        return ordered.map { teamWords($0, me: me) }.joined(separator: " vs ")
    }

    /// The same table for VoiceOver ("and", "versus").
    static func spoken(_ teams: [[String?]], me: String?) -> String {
        var s = line(teams, me: me).replacingOccurrences(of: " & ", with: " and ").replacingOccurrences(of: " vs ", with: " versus ")
        if s.hasPrefix("You ") { s = "you " + s.dropFirst(4) }
        return s
    }

    /// My partner in each round so far: a username, "a bot", or "sat out" (no table of the
    /// round names me: I sat out, or my table never started).
    static func partnersSoFar(_ pairings: [TournamentRoundPairings], me: String) -> [Partner] {
        pairings.map { round in
            guard let table = tableOf(round, me: me), let team = table.teams.first(where: { contains($0, me) }) else {
                return Partner(roundNumber: round.roundNumber, partner: satOut)
            }
            let other = team[0] == me ? team[1] : team[0]
            return Partner(roundNumber: round.roundNumber, partner: other ?? aBot)
        }
    }

    /// The latest round with its tables, mine first (and whether one is mine).
    static func latestRound(_ pairings: [TournamentRoundPairings], me: String?) -> (round: TournamentRoundPairings, mine: Bool)? {
        guard let round = pairings.last else { return nil }
        guard let mine = tableOf(round, me: me) else { return (round, false) }
        let rest = round.tables.filter { $0 != mine }
        return (TournamentRoundPairings(roundNumber: round.roundNumber, tables: [mine] + rest), true)
    }

    /// Anything to show: a table with two members anywhere.
    static func hasPairings(_ pairings: [TournamentRoundPairings]) -> Bool {
        pairings.contains { $0.tables.contains { $0.teams.flatMap { $0 }.compactMap { $0 }.count >= 2 } }
    }
}
