import Foundation

/// A profile's tournament history (owner 2026-11-25: "tournament history visible on profiles in
/// this release"; iOS 1.2.7 (41); server profileHandlers.tournamentProfile from the
/// `tournamentRecords` collection, contract `$defs.profileTournaments` / `tournamentResult`; web
/// reference `client/src/ui/components/TournamentHistory.js`). The profile reply's additive
/// `profile.tournaments {played, won, recent}` and `profile.cutForABuck {wins, played}`, the same
/// in every stats scope (a tournament is not a game). Read leniently (StatsWire style): a missing
/// or unreadable field counts 0, a bad recent entry is dropped, never the reply. Nothing is shown
/// for a player with no finished tournament and no cut (or a server without the fields).
struct TournamentHistory: Equatable {
    var played = 0
    var won = 0
    var cutWins = 0
    var cutPlayed = 0
    var recent: [Result] = []

    /// One finished tournament (server tournamentRecord.recentResult), newest first.
    struct Result: Equatable, Identifiable {
        let id: String
        let name: String
        let completedAt: Date?
        let totalRounds: Int
        let players: Int
        /// The player's place by total score (1 = a winner, ties share it); nil: not in the standings.
        let place: Int?
        let won: Bool
        let winners: [String]
        /// Who won Cut for a buck (nil: no cut ran). May be '[deleted]'.
        let cutWinner: String?
    }

    /// Nothing to show (the section is left out).
    var isEmpty: Bool { played == 0 && cutPlayed == 0 }

    /// The reply's `profile`; nil when it carries neither field (a server from before them).
    init?(profile: [String: Any]) {
        let t = profile["tournaments"] as? [String: Any]
        let cut = profile["cutForABuck"] as? [String: Any]
        guard t != nil || cut != nil else { return nil }
        played = Self.count(t?["played"])
        won = Self.count(t?["won"])
        cutWins = Self.count(cut?["wins"])
        cutPlayed = Self.count(cut?["played"])
        recent = (t?["recent"] as? [Any] ?? []).compactMap(Self.result).prefix(5).map { $0 }
    }

    init(played: Int = 0, won: Int = 0, cutWins: Int = 0, cutPlayed: Int = 0, recent: [Result] = []) {
        self.played = played
        self.won = won
        self.cutWins = cutWins
        self.cutPlayed = cutPlayed
        self.recent = recent
    }

    /// A whole count >= 0, else 0 (the web's `n`).
    private static func count(_ any: Any?) -> Int {
        guard let v = StatsWire.int(any), v >= 0 else { return 0 }
        return v
    }

    private static func result(_ any: Any?) -> Result? {
        guard let d = any as? [String: Any] else { return nil }
        let id = StatsWire.string(d["id"]) ?? ""
        let place = StatsWire.int(d["place"]).flatMap { $0 >= 1 ? $0 : nil }
        let winners = (d["winners"] as? [Any] ?? []).compactMap { StatsWire.string($0) }.filter { !$0.isEmpty }
        let cut = StatsWire.string(d["cutWinner"]).flatMap { $0.isEmpty ? nil : $0 }
        return Result(id: id.isEmpty ? UUID().uuidString : id, name: StatsWire.string(d["name"]) ?? "",
                      completedAt: (d["completedAt"] as? String).flatMap(Self.date), totalRounds: count(d["totalRounds"]),
                      players: count(d["players"]), place: place, won: d["won"] as? Bool == true, winners: winners,
                      cutWinner: cut)
    }

    private static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }
}

/// The words (the web's TOURNAMENT_HISTORY_COPY, with the owner's 2026-11-25 rule: "cut for a
/// buck" is lowercase mid-sentence, capitalised only where it starts a heading or a line).
enum TournamentHistoryCopy {
    static let title = "Tournaments"
    static let played = "Played"
    static let won = "Won"
    static let cut = "Cut for a buck"
    static let recent = "Recent results"
    static let wonCut = "Won cut for a buck"
    static func cutBy(_ name: String) -> String { "Cut for a buck: \(name)" }

    /// 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st (the web's ordinal).
    static func ordinal(_ k: Int) -> String {
        let tens = k % 100
        if (11...13).contains(tens) { return "\(k)th" }
        switch k % 10 {
        case 1: return "\(k)st"
        case 2: return "\(k)nd"
        case 3: return "\(k)rd"
        default: return "\(k)th"
        }
    }

    /// How the player did: "Won", "Won (tied)", "2nd of 6", or "Finished" (the web's resultLabel).
    static func resultLabel(_ r: TournamentHistory.Result) -> String {
        if r.won { return r.winners.count > 1 ? "Won (tied)" : "Won" }
        if let place = r.place { return ordinal(place) + (r.players > 0 ? " of \(r.players)" : "") }
        return "Finished"
    }

    /// "Nov 25, 2026 · 6 players · 3 rounds" (each part only when known).
    static func meta(_ r: TournamentHistory.Result, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        var parts: [String] = []
        if let d = r.completedAt {
            var style = Date.FormatStyle(date: .abbreviated, time: .omitted)
            style.locale = locale
            style.timeZone = timeZone
            parts.append(d.formatted(style))
        }
        if r.players > 0 { parts.append("\(r.players) players") }
        if r.totalRounds > 0 { parts.append(TournamentRounds.label(r.totalRounds)) }
        return parts.joined(separator: " · ")
    }

    /// The cut line under a result: "Won cut for a buck" for this player, else "Cut for a buck: kim".
    static func cutLine(_ r: TournamentHistory.Result, username: String) -> String? {
        guard let w = r.cutWinner else { return nil }
        return w == username ? wonCut : cutBy(w)
    }

    /// The Cut for a buck stat: "2 of 5" (wins of cuts played), only once a cut was played.
    static func cutStat(_ h: TournamentHistory) -> String? {
        h.cutPlayed > 0 ? "\(h.cutWins) of \(h.cutPlayed)" : nil
    }

    /// VoiceOver for one result: "Sunday Cup, 2nd of 6, Nov 25, 2026 · 6 players · 3 rounds, Cut for a buck: kim".
    static func spoken(_ r: TournamentHistory.Result, username: String) -> String {
        [r.name.isEmpty ? "Tournament" : r.name, resultLabel(r), meta(r), cutLine(r, username: username)]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}
