import Foundation

/// The admin panel's wire (contract c2s `adminRequest` / s2c `adminResponse`;
/// server/socket/adminHandlers.js): the actions this build sends and the reply rows it
/// reads. Every row is read from the reply's dictionary leniently (a missing or mistyped
/// key gets a default, an unknown key is ignored), so a server that adds fields never
/// breaks the panel. Nothing here is authority: the server checks the admin on every
/// request, from the database.
enum AdminAction: String, CaseIterable {
    case listPlayers, createResetLink, signOutEverywhere, findDuplicates, planMerge, applyMerge
    case listReports, resolveReport, listAdmins, setAdmin, listAudit, deleteAccount, renameAccount
}

/// One `adminResponse`: {requestId, action, ok: true, ...fields} or
/// {requestId, action, ok: false, error, message}.
struct AdminResponse {
    let requestId: String
    let action: String
    let ok: Bool
    /// forbidden / invalid / not_found / refused / last_admin / stale_plan / server (nil when ok).
    let error: String?
    /// The server's words for the admin (a failure's message; "" when ok).
    let message: String
    /// The whole reply (the action's fields).
    let body: [String: Any]

    init(_ dict: [String: Any]) {
        requestId = dict["requestId"] as? String ?? ""
        action = dict["action"] as? String ?? ""
        ok = dict["ok"] as? Bool ?? false
        error = ok ? nil : (dict["error"] as? String ?? "server")
        message = ok ? "" : (dict["message"] as? String ?? "Refused.")
        body = dict
    }

    /// The one uniform refusal: not an admin right now (the panel closes).
    var isForbidden: Bool { !ok && error == "forbidden" }

    func int(_ key: String) -> Int { StatsWire.int(body[key]) ?? 0 }
    func string(_ key: String) -> String { body[key] as? String ?? "" }
}

/// ISO times of the admin replies, shown the way the web panel shows them
/// (`toLocaleDateString` / `toLocaleString`: the device's short date, with or without the time).
enum AdminDates {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ any: Any?) -> Date? {
        guard let s = any as? String, !s.isEmpty else { return nil }
        return withFraction.date(from: s) ?? plain.date(from: s)
    }

    /// The day ("11/15/26"), "—" for none.
    static func day(_ date: Date?, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        guard let date else { return "—" }
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = timeZone
        f.dateStyle = .short
        f.timeStyle = .none
        return f.string(from: date)
    }

    /// The day and time ("11/15/26, 9:41 AM"), "—" for none.
    static func dateTime(_ date: Date?, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        guard let date else { return "—" }
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = timeZone
        f.dateStyle = .short
        f.timeStyle = .short
        return f.string(from: date)
    }
}

/// A Players row (server/admin/players.js `playerRow`).
struct AdminPlayer: Identifiable, Equatable {
    let username: String
    let createdAt: Date?
    let lastSeenAt: Date?
    let online: Bool
    /// Human games; bot games are counted apart.
    let gamesPlayed: Int
    let botGamesPlayed: Int
    let isAdmin: Bool
    /// A tombstone's kept account (merged into it, renamed to it, or "[deleted]" for a held name).
    let mergedInto: String?
    /// The tombstone is a rename's redirect, not a merged account.
    let renamed: Bool
    /// On a live account: the old name of its rename that stopped partway.
    let renameUnfinished: String?
    /// A deleted account's name hold: until when the name stays taken.
    let heldUntil: Date?

    var id: String { username }
    var isTombstone: Bool { mergedInto != nil }
    var isHeldName: Bool { isTombstone && heldUntil != nil }

    init?(_ any: Any?) {
        guard let d = any as? [String: Any], let name = d["username"] as? String, !name.isEmpty else { return nil }
        username = name
        createdAt = AdminDates.parse(d["createdAt"])
        lastSeenAt = AdminDates.parse(d["lastSeenAt"])
        online = d["online"] as? Bool ?? false
        gamesPlayed = StatsWire.int(d["gamesPlayed"]) ?? 0
        botGamesPlayed = StatsWire.int(d["botGamesPlayed"]) ?? 0
        isAdmin = d["isAdmin"] as? Bool ?? false
        mergedInto = StatsWire.string(d["mergedInto"])
        renamed = d["renamed"] as? Bool ?? false
        renameUnfinished = StatsWire.string(d["renameUnfinished"])
        heldUntil = AdminDates.parse(d["heldUntil"])
    }

    static func list(_ any: Any?) -> [AdminPlayer] {
        (any as? [Any] ?? []).compactMap { AdminPlayer($0) }
    }
}

/// The Players reply: the rows (newest first, capped by the server) and the true count.
struct AdminRoster: Equatable {
    let players: [AdminPlayer]
    let total: Int

    var isCapped: Bool { total > players.count }
}

/// A Reports row (server/admin/reports.js `reportRow`).
struct AdminReport: Identifiable, Equatable {
    let id: String
    let reporter: String
    let reported: String
    let reason: String
    let context: String
    let createdAt: Date?
    /// open / resolved / dismissed
    let status: String
    let resolvedBy: String?
    let resolvedAt: Date?
    let note: String?
    let reporterDeleted: Bool
    let reportedDeleted: Bool

    var isOpen: Bool { status == "open" }

    init?(_ any: Any?) {
        guard let d = any as? [String: Any], let id = d["id"] as? String, !id.isEmpty else { return nil }
        self.id = id
        reporter = d["reporter"] as? String ?? ""
        reported = d["reported"] as? String ?? ""
        reason = d["reason"] as? String ?? ""
        context = d["context"] as? String ?? ""
        createdAt = AdminDates.parse(d["createdAt"])
        let s = d["status"] as? String ?? "open"
        status = ["resolved", "dismissed"].contains(s) ? s : "open"
        resolvedBy = StatsWire.string(d["resolvedBy"])
        resolvedAt = AdminDates.parse(d["resolvedAt"])
        note = StatsWire.string(d["note"])
        reporterDeleted = d["reporterDeleted"] as? Bool ?? false
        reportedDeleted = d["reportedDeleted"] as? Bool ?? false
    }

    static func list(_ any: Any?) -> [AdminReport] {
        (any as? [Any] ?? []).compactMap { AdminReport($0) }
    }
}

/// An Admins row.
struct AdminRoleEntry: Identifiable, Equatable {
    let username: String
    let adminSince: Date?
    var id: String { username }

    init?(_ any: Any?) {
        guard let d = any as? [String: Any], let name = d["username"] as? String, !name.isEmpty else { return nil }
        username = name
        adminSince = AdminDates.parse(d["adminSince"])
    }

    static func list(_ any: Any?) -> [AdminRoleEntry] {
        (any as? [Any] ?? []).compactMap { AdminRoleEntry($0) }
    }
}

/// An Audit row (server/admin/audit.js `listAudit`).
struct AdminAuditEntry: Identifiable, Equatable {
    let id: String
    /// The time as sent: the page cursor sends it back unchanged.
    let atRaw: String
    let at: Date?
    let actor: String?
    let action: String
    let target: String?
    /// ok / failed / forbidden
    let result: String
    let detail: String?

    init?(_ any: Any?) {
        guard let d = any as? [String: Any], let id = d["id"] as? String, !id.isEmpty else { return nil }
        self.id = id
        atRaw = d["at"] as? String ?? ""
        at = AdminDates.parse(atRaw)
        actor = StatsWire.string(d["actor"])
        action = d["action"] as? String ?? ""
        target = StatsWire.string(d["target"])
        result = d["result"] as? String ?? "failed"
        detail = StatsWire.string(d["detail"])
    }

    static func list(_ any: Any?) -> [AdminAuditEntry] {
        (any as? [Any] ?? []).compactMap { AdminAuditEntry($0) }
    }
}

/// One name of a look-alike group (findDuplicates).
struct AdminDuplicate: Equatable {
    let username: String
    let gamesPlayed: Int
    let botGamesPlayed: Int

    init?(_ any: Any?) {
        guard let d = any as? [String: Any], let name = d["username"] as? String, !name.isEmpty else { return nil }
        username = name
        gamesPlayed = StatsWire.int(d["gamesPlayed"]) ?? 0
        botGamesPlayed = StatsWire.int(d["botGamesPlayed"]) ?? 0
    }

    /// Groups of two or more names (a group that lost its names in decoding is dropped).
    static func groups(_ any: Any?) -> [[AdminDuplicate]] {
        (any as? [Any] ?? []).map { ($0 as? [Any] ?? []).compactMap { AdminDuplicate($0) } }.filter { !$0.isEmpty }
    }
}

/// The merge preview (server/admin/mergeView.js `planView`: formatPlan's content as data).
struct AdminMergePlan: Equatable {
    struct Stats: Equatable {
        let gamesPlayed: Double, wins: Double, losses: Double, draws: Double, totalPoints: Double

        init(_ any: Any?) {
            let d = any as? [String: Any] ?? [:]
            gamesPlayed = StatsWire.number(d["gamesPlayed"]) ?? 0
            wins = StatsWire.number(d["wins"]) ?? 0
            losses = StatsWire.number(d["losses"]) ?? 0
            draws = StatsWire.number(d["draws"]) ?? 0
            totalPoints = StatsWire.number(d["totalPoints"]) ?? 0
        }
    }

    struct Account: Equatable, Identifiable {
        /// target / source / result
        let role: String
        let username: String
        let createdAt: Date?
        let stats: Stats
        let botStats: Stats
        let note: String?
        var id: String { "\(role):\(username)" }
    }

    struct StatChange: Equatable, Identifiable {
        let key: String
        let before: Double
        let after: Double
        var id: String { key }
    }

    struct BlockChange: Equatable {
        let before: [String]
        let after: [String]
    }

    struct Teams: Equatable {
        let team1: [String]
        let team2: [String]

        init(_ any: Any?) {
            let d = any as? [String: Any] ?? [:]
            team1 = StatsWire.strings(d["team1"]) ?? []
            team2 = StatsWire.strings(d["team2"]) ?? []
        }
    }

    struct GameRecord: Equatable {
        let gameId: String
        let completedAt: Date?
        let before: Teams
        let after: Teams
    }

    struct ReportChange: Equatable {
        let reporter: String
        let reported: String
        let newReporter: String?
        let newReported: String?
    }

    struct OtherBlocks: Equatable {
        let username: String
        let before: [String]
        let after: [String]
    }

    struct ChainedTombstone: Equatable {
        let username: String
        let before: String
    }

    let target: String
    let sources: [String]
    let errors: [String]
    let warnings: [String]
    let accounts: [Account]
    let statChanges: [StatChange]
    let botStatChanges: [StatChange]
    let profilePicFrom: String?
    let targetBlockedUsers: BlockChange?
    let gameRecords: [GameRecord]
    let reports: [ReportChange]
    let otherUsersBlocks: [OtherBlocks]
    let chainedTombstones: [ChainedTombstone]
    let retire: [String]
    let changeCount: Int

    init(_ any: Any?) {
        let d = any as? [String: Any] ?? [:]
        func rows(_ key: String) -> [[String: Any]] { (d[key] as? [Any] ?? []).compactMap { $0 as? [String: Any] } }
        func changes(_ key: String) -> [StatChange] {
            rows(key).map { StatChange(key: $0["key"] as? String ?? "", before: StatsWire.number($0["before"]) ?? 0,
                                       after: StatsWire.number($0["after"]) ?? 0) }
        }
        target = d["target"] as? String ?? ""
        sources = StatsWire.strings(d["sources"]) ?? []
        errors = StatsWire.strings(d["errors"]) ?? []
        warnings = StatsWire.strings(d["warnings"]) ?? []
        accounts = rows("accounts").map {
            Account(role: $0["role"] as? String ?? "source", username: $0["username"] as? String ?? "",
                    createdAt: AdminDates.parse($0["createdAt"]), stats: Stats($0["stats"]), botStats: Stats($0["botStats"]),
                    note: StatsWire.string($0["note"]))
        }
        statChanges = changes("statChanges")
        botStatChanges = changes("botStatChanges")
        profilePicFrom = StatsWire.string(d["profilePicFrom"])
        targetBlockedUsers = (d["targetBlockedUsers"] as? [String: Any]).map {
            BlockChange(before: StatsWire.strings($0["before"]) ?? [], after: StatsWire.strings($0["after"]) ?? [])
        }
        gameRecords = rows("gameRecords").map {
            GameRecord(gameId: $0["gameId"] as? String ?? "", completedAt: AdminDates.parse($0["completedAt"]),
                       before: Teams($0["before"]), after: Teams($0["after"]))
        }
        reports = rows("reports").map {
            ReportChange(reporter: $0["reporter"] as? String ?? "", reported: $0["reported"] as? String ?? "",
                         newReporter: StatsWire.string($0["newReporter"]), newReported: StatsWire.string($0["newReported"]))
        }
        otherUsersBlocks = rows("otherUsersBlocks").map {
            OtherBlocks(username: $0["username"] as? String ?? "", before: StatsWire.strings($0["before"]) ?? [],
                        after: StatsWire.strings($0["after"]) ?? [])
        }
        chainedTombstones = rows("chainedTombstones").map {
            ChainedTombstone(username: $0["username"] as? String ?? "", before: $0["before"] as? String ?? "")
        }
        retire = StatsWire.strings(d["retire"]) ?? []
        changeCount = StatsWire.int(d["changeCount"]) ?? 0
    }
}

/// What applyMerge did (`result`).
struct AdminMergeResult: Equatable {
    let target: String
    let statsMerged: [String]
    let retired: [String]
    let gameRecords: Int
    let reports: Int
    let otherUsersBlocks: Int
    let signedOut: Int

    init(_ any: Any?) {
        let d = any as? [String: Any] ?? [:]
        target = d["target"] as? String ?? ""
        statsMerged = StatsWire.strings(d["statsMerged"]) ?? []
        retired = StatsWire.strings(d["retired"]) ?? []
        gameRecords = StatsWire.int(d["gameRecords"]) ?? 0
        reports = StatsWire.int(d["reports"]) ?? 0
        otherUsersBlocks = StatsWire.int(d["otherUsersBlocks"]) ?? 0
        signedOut = StatsWire.int(d["signedOut"]) ?? 0
    }
}

/// A one-time reset link, shown once. Kept only in memory while its sheet is open; never
/// logged, never written to disk.
struct AdminResetLink: Identifiable, Equatable {
    let username: String
    let url: String
    let expiresAt: Date?
    var id: String { username }

    /// `<origin>/reset#<token>`: the token rides in the fragment, which is never sent with
    /// the page request (server/admin/CLAUDE.md, Password reset links).
    static func url(origin: String, token: String) -> String { "\(origin)/reset#\(token)" }
}
