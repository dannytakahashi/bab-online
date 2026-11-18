#if DEBUG
import Foundation

/// The admin panel in fixture mode (no socket): `-uiAdmin <mode>` makes the fixture user
/// (ivy) an admin, so the Account sheet shows its Admin entry, and answers the panel's
/// requests here, 0.25 s later, with wire-shaped replies (server/socket/adminHandlers.js)
/// that go through the same reading as the server's (`AdminResponse`, AdminModels). The
/// roster, reports, admins and audit log are kept in memory and change the way the server
/// changes them, so an action's result shows in the reloaded list. Without `-uiAdmin`
/// nobody is an admin (no entry). Modes:
/// `ok` (or YES), `capped` (the list says it shows the newest of more), `forbidden` (every
/// request refused: the panel closes and the entry hides), `silent` (no answer),
/// `rateLimited` (the request limit), `stale` (applyMerge answers stale_plan).
/// `-uiAdminLinkDelay <seconds>` answers createResetLink that much later (the others
/// stay at 0.25 s): time to change section before the link lands.
/// Fixed refusals in every mode: deleting `hal` (in a game), renaming to a taken name,
/// removing the last admin. Each request shows in the "fixture.sent" probe as
/// `admin:<action>[:<name>]` (never a link or token).
extension UIFixture {
    static let adminMode: String? = isActive ? UserDefaults.standard.string(forKey: "uiAdmin") : nil

    @MainActor
    static func seedAdmin(_ admin: AdminState, auth: AuthState) {
        guard let mode = adminMode else { return }
        auth.isAdmin = true
        auth.isAuthenticated = true  // the toast layer (ContentView) is mounted for a signed-in user
        ServerErrorToast.visibleSeconds = 20
        let linkDelay = UserDefaults.standard.double(forKey: "uiAdminLinkDelay")
        let backend = AdminFixtureBackend(mode: mode, linkDelay: linkDelay > 0 ? linkDelay : 0.25, me: { [weak auth] in auth?.username ?? "ivy" })
        admin.username = { [weak auth] in auth?.username ?? "" }
        admin.accessLost = { [weak auth] message in
            auth?.isAdmin = false
            SocketService.shared.serverError = ServerErrorNotice(message: message)
        }
        admin.isAdmin = { [weak auth] in auth?.isAdmin ?? false }
        admin.requester = { action, args in await backend.answer(action, args) }
    }
}

/// The server's side of the admin panel for UI fixtures and screenshots.
@MainActor
final class AdminFixtureBackend {
    private let mode: String
    private let linkDelay: TimeInterval
    private let me: () -> String
    private var players: [[String: Any]]
    private var reports: [[String: Any]]
    private var audit: [[String: Any]]
    private var serial = 0

    private static func iso(_ ago: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date().addingTimeInterval(-ago))
    }
    private static let day: TimeInterval = 86400

    init(mode: String, linkDelay: TimeInterval, me: @escaping () -> String) {
        self.mode = mode
        self.linkDelay = linkDelay
        self.me = me
        func live(_ name: String, created: Double, seen: Double?, online: Bool = false, games: Int, bot: Int = 0,
                  admin: Bool = false, unfinished: String? = nil) -> [String: Any] {
            ["username": name, "createdAt": Self.iso(created * Self.day), "lastSeenAt": seen.map { Self.iso($0 * Self.day) } ?? NSNull(),
             "online": online, "gamesPlayed": games, "botGamesPlayed": bot, "isAdmin": admin, "mergedInto": NSNull(),
             "renamed": false, "renameUnfinished": unfinished ?? NSNull()]
        }
        func tomb(_ name: String, into: String, created: Double, renamed: Bool = false, heldDays: Double? = nil) -> [String: Any] {
            var row: [String: Any] = ["username": name, "createdAt": Self.iso(created * Self.day), "lastSeenAt": NSNull(), "online": false,
                                      "gamesPlayed": 0, "botGamesPlayed": 0, "isAdmin": false, "mergedInto": into, "renamed": renamed,
                                      "renameUnfinished": NSNull()]
            if let heldDays { row["heldUntil"] = Self.iso(-heldDays * Self.day) }
            return row
        }
        // newest first, as the server lists them
        players = [
            live("AlanB", created: 1, seen: 0.5, games: 1, bot: 1),
            live("alan2", created: 3, seen: 2, games: 4),
            tomb("ghost", into: "[deleted]", created: 6, heldDays: 24),
            live("max", created: 9, seen: 1, games: 12, bot: 5, unfinished: "maxx"),
            tomb("oldpat", into: "pat", created: 14, renamed: true),
            live("Christopher Johnson1", created: 20, seen: 4, games: 6),
            live("hal", created: 31, seen: 0, online: true, games: 38, bot: 2),
            tomb("kim2", into: "kim", created: 40),
            live("pat", created: 55, seen: 12, games: 3),
            live("jon", created: 80, seen: 3, games: 25, bot: 7, admin: true),
            live("kim", created: 120, seen: 0, online: true, games: 42, bot: 3),
            live("Alan", created: 200, seen: 30, games: 30, bot: 2),
            live("ivy", created: 240, seen: 0, online: true, games: 51, bot: 9, admin: true),
        ]
        reports = [
            ["id": String(format: "%024x", 9001), "reporter": "kim", "reported": "hal", "reason": "Abusive chat",
             "context": "hal: (three messages removed by the filter)", "createdAt": Self.iso(0.1 * Self.day), "status": "open",
             "resolvedBy": NSNull(), "resolvedAt": NSNull(), "note": NSNull(), "reporterDeleted": false, "reportedDeleted": false],
            ["id": String(format: "%024x", 9002), "reporter": "pat", "reported": "ghost", "reason": "Offensive name",
             "context": "", "createdAt": Self.iso(7 * Self.day), "status": "open",
             "resolvedBy": NSNull(), "resolvedAt": NSNull(), "note": NSNull(), "reporterDeleted": false, "reportedDeleted": true],
            ["id": String(format: "%024x", 9003), "reporter": "jon", "reported": "max", "reason": "Stalling every hand",
             "context": "", "createdAt": Self.iso(20 * Self.day), "status": "dismissed",
             "resolvedBy": "ivy", "resolvedAt": Self.iso(19 * Self.day), "note": "Slow connection, not stalling", "reporterDeleted": false,
             "reportedDeleted": false],
        ]
        let actions = ["createResetLink", "signOutEverywhere", "planMerge", "setAdmin", "resolveReport", "listPlayers"]
        audit = (0..<60).map { i in
            let action = actions[i % actions.count]
            let forbidden = action == "listPlayers"
            return ["id": String(format: "%024x", 1000 - i), "at": Self.iso(Double(i) * 0.4 * Self.day),
                    "actor": forbidden ? "max" : (i % 2 == 0 ? "ivy" : "jon"), "action": action,
                    "target": forbidden ? NSNull() : ["kim", "hal", "pat"][i % 3] as Any,
                    "result": forbidden ? "forbidden" : (i % 7 == 3 ? "failed" : "ok"),
                    "detail": forbidden ? "not an admin" : (i % 7 == 3 ? "server error" : "entry \(i + 1)")]
        }
    }

    // MARK: Answering

    func answer(_ action: AdminAction, _ args: [String: Any]) async -> AdminApi.Outcome {
        record(action, args)
        try? await Task.sleep(nanoseconds: UInt64((action == .createResetLink ? linkDelay : 0.25) * 1_000_000_000))
        switch mode {
        case "silent": return .failure(.timeout)
        case "rateLimited": return .failure(.rateLimited)
        case "forbidden": return .success(reply(action, fail("forbidden", "Not available.")))
        default: return .success(reply(action, run(action, args)))
        }
    }

    private func record(_ action: AdminAction, _ args: [String: Any]) {
        let name = args["username"] as? String ?? args["target"] as? String
        let message = "admin:\(action.rawValue)" + (name.map { ":\($0)" } ?? "")
        let probe = TableDebugProbe.shared
        probe.sent = probe.sent == "-" ? message : probe.sent + "|" + message
    }

    private func reply(_ action: AdminAction, _ fields: [String: Any]) -> AdminResponse {
        serial += 1
        var dict = fields
        dict["requestId"] = "fixture-\(serial)"
        dict["action"] = action.rawValue
        return AdminResponse(dict)
    }

    private func ok(_ fields: [String: Any]) -> [String: Any] { fields.merging(["ok": true]) { a, _ in a } }
    private func fail(_ error: String, _ message: String) -> [String: Any] { ["ok": false, "error": error, "message": message] }
    private func notFound(_ name: String) -> [String: Any] { fail("not_found", "No account is named \"\(name)\" (names are case-sensitive).") }

    private func index(_ name: String) -> Int? { players.firstIndex { $0["username"] as? String == name } }
    private func isTombstone(_ row: [String: Any]) -> Bool { row["mergedInto"] is String }

    private func log(_ action: String, target: String?, detail: String, result: String = "ok") {
        serial += 1
        audit.insert(["id": String(format: "%024x", 5000 + serial), "at": Self.iso(0), "actor": me(), "action": action,
                      "target": target ?? NSNull() as Any, "result": result, "detail": detail], at: 0)
    }

    private func run(_ action: AdminAction, _ args: [String: Any]) -> [String: Any] {
        let username = args["username"] as? String ?? ""
        switch action {
        case .listPlayers:
            return ok(["players": players, "total": players.count + (mode == "capped" ? 320 : 0), "limit": 500])

        case .createResetLink:
            guard index(username) != nil else { return notFound(username) }
            log("createResetLink", target: username, detail: "link valid for 24 hours")
            // 43 characters like the server's, made here from a plain word: not a secret
            let token = String(String(repeating: "fixture-", count: 6).prefix(43))
            return ok(["username": username, "token": token, "expiresAt": Self.iso(-Self.day)])

        case .signOutEverywhere:
            guard let i = index(username) else { return notFound(username) }
            let wasOnline = players[i]["online"] as? Bool ?? false
            players[i]["online"] = false
            log("signOutEverywhere", target: username, detail: "2 saved session(s) revoked")
            return ok(["username": username, "revokedSessions": 2, "disconnected": wasOnline ? 1 : 0])

        case .setAdmin:
            guard let i = index(username) else { return notFound(username) }
            let on = args["isAdmin"] as? Bool ?? false
            let admins = players.filter { $0["isAdmin"] as? Bool == true }
            if !on, admins.count == 1, admins[0]["username"] as? String == username {
                return fail("last_admin", "\"\(username)\" is the only admin. Make someone else an admin first.")
            }
            let changed = (players[i]["isAdmin"] as? Bool ?? false) != on
            players[i]["isAdmin"] = on
            log("setAdmin", target: username, detail: on ? "made admin" : "admin removed")
            return ok(["username": username, "isAdmin": on, "changed": changed])

        case .listAdmins:
            let rows = players.filter { $0["isAdmin"] as? Bool == true }
                .map { ["username": $0["username"] ?? "", "adminSince": $0["createdAt"] ?? NSNull()] }
            return ok(["admins": rows])

        case .deleteAccount:
            guard let i = index(username) else { return notFound(username) }
            guard args["confirm"] as? String == username else {
                return fail("invalid", "Type the account's name, \(username), exactly to confirm.")
            }
            let counts: [String: Any] = ["gameRecords": 0, "reports": 0, "blockLists": 0, "resetLinks": 0, "tombstones": 0, "signedOut": 0]
            if let kept = players[i]["mergedInto"] as? String {
                players.remove(at: i)
                log("deleteAccount", target: username, detail: "tombstone deleted; the name is free")
                return ok(counts.merging(["username": username, "kind": "tombstone", "mergedInto": kept]) { _, b in b })
            }
            if username == "hal" {
                return fail("refused", "\"hal\" is in a game right now. Wait until it finishes and delete again.")
            }
            let games = players[i]["gamesPlayed"] as? Int ?? 0
            let online = players[i]["online"] as? Bool ?? false
            // the name is held 30 days, as the server leaves it
            players[i] = ["username": username, "createdAt": players[i]["createdAt"] ?? NSNull(), "lastSeenAt": NSNull(), "online": false,
                          "gamesPlayed": 0, "botGamesPlayed": 0, "isAdmin": false, "mergedInto": "[deleted]", "renamed": false,
                          "renameUnfinished": NSNull(), "heldUntil": Self.iso(-30 * Self.day)]
            log("deleteAccount", target: username, detail: "account deleted: \(games) game record update(s) to [deleted]")
            return ok(counts.merging(["username": username, "kind": "account", "mergedInto": NSNull(), "gameRecords": games,
                                      "reports": 1, "signedOut": online ? 1 : 0]) { _, b in b })

        case .renameAccount:
            let newName = args["newName"] as? String ?? ""
            let counts: [String: Any] = ["gameRecords": 12, "reports": 1, "otherUsersBlocks": 2, "chainedTombstones": 0, "adminSetBy": 0,
                                         "resetLinks": 0, "revokedSessions": 2, "signedOut": 1]
            guard args["confirm"] as? String == newName, !newName.isEmpty else {
                return fail("invalid", "Type the new name\(newName.isEmpty ? "" : ", \(newName),") exactly to confirm.")
            }
            // Finish rename: the old name of an unfinished rename, to the account's name
            if let j = index(newName), players[j]["renameUnfinished"] as? String == username {
                players[j]["renameUnfinished"] = NSNull()
                log("renameAccount", target: username, detail: "renamed \(username) -> \(newName) (finished)")
                return ok(counts.merging(["username": username, "newName": newName, "resumed": true, "oldNameKept": true]) { _, b in b })
            }
            guard let i = index(username) else { return notFound(username) }
            if players.contains(where: { ($0["username"] as? String)?.lowercased() == newName.lowercased() }) {
                return fail("refused", "That name is taken.")
            }
            if newName.count < 2 || newName.count > 20 {
                return fail("refused", "Username must be 2-20 characters.")
            }
            players[i]["username"] = newName
            players[i]["online"] = false
            players.insert(["username": username, "createdAt": Self.iso(0), "lastSeenAt": NSNull(), "online": false, "gamesPlayed": 0,
                            "botGamesPlayed": 0, "isAdmin": false, "mergedInto": newName, "renamed": true,
                            "renameUnfinished": NSNull()], at: 0)
            log("renameAccount", target: username, detail: "renamed \(username) -> \(newName)")
            return ok(counts.merging(["username": username, "newName": newName, "resumed": false, "oldNameKept": true]) { _, b in b })

        case .listReports:
            let openOnly = args["status"] as? String != "all"
            return ok(["reports": reports.filter { !openOnly || $0["status"] as? String == "open" }])

        case .resolveReport:
            guard let i = reports.firstIndex(where: { $0["id"] as? String == args["id"] as? String }) else {
                return fail("not_found", "That report does not exist.")
            }
            let status = args["status"] as? String ?? "resolved"
            reports[i]["status"] = status
            reports[i]["resolvedBy"] = me()
            reports[i]["resolvedAt"] = Self.iso(0)
            reports[i]["note"] = args["note"] as? String ?? ""
            log("resolveReport", target: reports[i]["reported"] as? String, detail: "report \(status)")
            return ok(["report": reports[i]])

        case .listAudit:
            let limit = args["limit"] as? Int ?? 50
            var rows = audit
            if let before = args["beforeId"] as? String, let i = audit.firstIndex(where: { $0["id"] as? String == before }) {
                rows = Array(audit[(i + 1)...])
            }
            return ok(["entries": Array(rows.prefix(limit)), "hasMore": rows.count > limit])

        case .findDuplicates:
            func entry(_ name: String) -> [String: Any]? {
                index(name).flatMap { isTombstone(players[$0]) ? nil : players[$0] }.map {
                    ["username": name, "gamesPlayed": $0["gamesPlayed"] ?? 0, "botGamesPlayed": $0["botGamesPlayed"] ?? 0,
                     "createdAt": $0["createdAt"] ?? NSNull()]
                }
            }
            let groups = [["Alan", "alan2", "AlanB"]].map { $0.compactMap(entry) }.filter { $0.count > 1 }
            return ok(["groups": groups])

        case .planMerge:
            return ok(["plan": plan(args), "planHash": String(repeating: "ab", count: 32)])

        case .applyMerge:
            let target = args["target"] as? String ?? ""
            let sources = args["sources"] as? [String] ?? []
            guard args["confirm"] as? String == target else {
                return fail("invalid", "Type the kept account's name, \(target), exactly to confirm.")
            }
            if mode == "stale" {
                return fail("stale_plan", "These accounts changed since the preview. Preview again before merging.")
            }
            var games = 0, bot = 0
            for s in sources {
                guard let i = index(s) else { continue }
                games += players[i]["gamesPlayed"] as? Int ?? 0
                bot += players[i]["botGamesPlayed"] as? Int ?? 0
                players[i]["mergedInto"] = target
                players[i]["gamesPlayed"] = 0
                players[i]["botGamesPlayed"] = 0
                players[i]["online"] = false
                players[i]["lastSeenAt"] = NSNull()
            }
            if let t = index(target) {
                players[t]["gamesPlayed"] = (players[t]["gamesPlayed"] as? Int ?? 0) + games
                players[t]["botGamesPlayed"] = (players[t]["botGamesPlayed"] as? Int ?? 0) + bot
            }
            log("applyMerge", target: target, detail: "merged \(sources.joined(separator: ", "))")
            return ok(["result": ["target": target, "statsMerged": sources, "retired": sources, "gameRecords": games + bot, "reports": 1,
                                  "otherUsersBlocks": 1, "chainedTombstones": 0, "profilePic": false, "signedOut": 1]])
        }
    }

    /// planView's shape (server/admin/mergeView.js): errors for a name that cannot be merged,
    /// else the accounts, the stat and bot-stat changes and what is re-pointed.
    private func plan(_ args: [String: Any]) -> [String: Any] {
        let target = args["target"] as? String ?? ""
        let sources = args["sources"] as? [String] ?? []
        var view: [String: Any] = ["target": target, "sources": sources, "errors": [String](), "warnings": [String](),
                                   "accounts": [Any](), "statChanges": [Any](), "botStatChanges": [Any](), "profilePicFrom": NSNull(),
                                   "targetBlockedUsers": NSNull(), "gameRecords": [Any](), "reports": [Any](), "otherUsersBlocks": [Any](),
                                   "chainedTombstones": [Any](), "retire": [String](), "changeCount": 0]
        var errors: [String] = []
        for name in [target] + sources {
            guard let i = index(name) else { errors.append("No account is named \"\(name)\" (names are case-sensitive)."); continue }
            if let kept = players[i]["mergedInto"] as? String, name == target {
                errors.append("Target \"\(name)\" is itself merged into \"\(kept)\". Merge into \"\(kept)\" instead.")
            }
            if players[i]["isAdmin"] as? Bool == true, name != target {
                errors.append("Source \"\(name)\" is an admin. Remove their admin first.")
            }
        }
        if !errors.isEmpty {
            view["errors"] = errors
            return view
        }
        func stats(_ games: Int) -> [String: Any] {
            ["gamesPlayed": games, "wins": games / 2, "losses": games - games / 2 - games / 10, "draws": games / 10, "totalPoints": games * 180]
        }
        func games(_ name: String, _ key: String) -> Int { index(name).flatMap { players[$0][key] as? Int } ?? 0 }
        let live = sources.filter { n in index(n).map { !isTombstone(players[$0]) } ?? false }
        let tGames = games(target, "gamesPlayed"), tBot = games(target, "botGamesPlayed")
        let addGames = live.reduce(0) { $0 + games($1, "gamesPlayed") }, addBot = live.reduce(0) { $0 + games($1, "botGamesPlayed") }
        var accounts: [[String: Any]] = [["role": "target", "username": target, "createdAt": players[index(target)!]["createdAt"] ?? NSNull(),
                                          "stats": stats(tGames), "botStats": stats(tBot), "note": NSNull()]]
        for s in sources {
            let merged = !live.contains(s)
            let g = games(s, "gamesPlayed"), b = games(s, "botGamesPlayed")
            accounts.append(["role": "source", "username": s, "createdAt": players[index(s)!]["createdAt"] ?? NSNull(), "stats": stats(g),
                             "botStats": stats(b),
                             "note": merged ? "already merged, skipped" : (g + b > 0 ? "stats will be added" : "no stats to add")])
        }
        accounts.append(["role": "result", "username": target, "createdAt": NSNull(), "stats": stats(tGames + addGames),
                         "botStats": stats(tBot + addBot), "note": NSNull()])
        view["accounts"] = accounts
        func changes(_ before: Int, _ after: Int) -> [[String: Any]] {
            guard before != after else { return [] }
            let b = stats(before), a = stats(after)
            return ["gamesPlayed", "wins", "losses", "draws", "totalPoints"].compactMap { k in
                (b[k] as? Int) == (a[k] as? Int) ? nil : ["key": k, "before": b[k] ?? 0, "after": a[k] ?? 0]
            }
        }
        view["statChanges"] = changes(tGames, tGames + addGames)
        view["botStatChanges"] = changes(tBot, tBot + addBot)
        let recordCount = live.isEmpty ? 0 : min(addGames + addBot, 23)
        view["gameRecords"] = (0..<recordCount).map { i -> [String: Any] in
            let s = live[i % live.count]
            return ["gameId": "game-\(100 + i)", "completedAt": Self.iso(Double(i + 1) * Self.day),
                    "before": ["team1": [s, "kim"], "team2": ["hal", "jon"]], "after": ["team1": [target, "kim"], "team2": ["hal", "jon"]]]
        }
        if let first = live.first {
            view["reports"] = [["id": String(format: "%024x", 9004), "reporter": first, "reported": "hal", "newReporter": target, "newReported": NSNull()]]
            view["otherUsersBlocks"] = [["username": "pat", "before": [first], "after": [target]]]
            view["targetBlockedUsers"] = ["before": [String](), "after": ["max"]]
            view["warnings"] = ["\(first) signed in 2 days ago: tell the player to use \(target) from now on."]
        }
        view["retire"] = live
        view["changeCount"] = live.isEmpty ? 0 : live.count * 2 + recordCount + 3
        return view
    }
}
#endif
