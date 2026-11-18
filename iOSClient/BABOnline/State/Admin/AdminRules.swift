import Foundation

/// The admin panel's sections (the web panel's tabs, in its order).
enum AdminTab: String, CaseIterable, Identifiable {
    case players, merge, reports, admins, audit

    var id: String { rawValue }
    var title: String {
        switch self {
        case .players: return "Players"
        case .merge: return "Merge"
        case .reports: return "Reports"
        case .admins: return "Admins"
        case .audit: return "Audit"
        }
    }
}

/// The Players list's sort columns: the web table's (client/src/ui/screens/adminPlayers.js
/// PLAYER_COLUMNS), with the same labels and first directions.
enum AdminPlayerColumn: String, CaseIterable, Identifiable {
    case username, createdAt, lastSeenAt, gamesPlayed, botGamesPlayed, isAdmin, mergedInto

    var id: String { rawValue }

    var label: String {
        switch self {
        case .username: return "Player"
        case .createdAt: return "Created"
        case .lastSeenAt: return "Last seen"
        case .gamesPlayed: return "Games"
        case .botGamesPlayed: return "Bot games"
        case .isAdmin: return "Admin"
        case .mergedInto: return "Merged"
        }
    }

    /// The direction a column takes when it is first chosen.
    var defaultAscending: Bool { self == .username || self == .mergedInto }
}

struct AdminPlayerSort: Equatable {
    var column: AdminPlayerColumn
    var ascending: Bool

    /// Newest account first (the server's order).
    static let newestFirst = AdminPlayerSort(column: .createdAt, ascending: false)

    /// Choosing the sorted column again flips it; another column takes its own first direction.
    func choosing(_ c: AdminPlayerColumn) -> AdminPlayerSort {
        c == column ? AdminPlayerSort(column: c, ascending: !ascending) : AdminPlayerSort(column: c, ascending: c.defaultAscending)
    }

    private enum Value {
        case text(String), number(Double)
    }

    /// A row's sort value; nil sorts last in either direction.
    private func value(_ p: AdminPlayer) -> Value? {
        switch column {
        case .username: return .text(p.username.lowercased())
        case .createdAt: return p.createdAt.map { .number($0.timeIntervalSince1970) }
        // online now is the most recent
        case .lastSeenAt: return p.online ? .number(.greatestFiniteMagnitude) : p.lastSeenAt.map { .number($0.timeIntervalSince1970) }
        case .gamesPlayed: return p.isTombstone ? nil : .number(Double(p.gamesPlayed))
        case .botGamesPlayed: return p.isTombstone ? nil : .number(Double(p.botGamesPlayed))
        case .isAdmin: return .number(p.isAdmin ? 1 : 0)
        case .mergedInto: return p.mergedInto.map { .text($0.lowercased()) }
        }
    }

    /// A sorted copy; ties by name, so the order is stable and predictable.
    func sorted(_ list: [AdminPlayer]) -> [AdminPlayer] {
        list.sorted { a, b in
            let order: ComparisonResult
            switch (value(a), value(b)) {
            case (nil, nil): order = .orderedSame
            case (nil, _): return false
            case (_, nil): return true
            case let (.text(x)?, .text(y)?): order = x == y ? .orderedSame : (x < y ? .orderedAscending : .orderedDescending)
            case let (.number(x)?, .number(y)?): order = x == y ? .orderedSame : (x < y ? .orderedAscending : .orderedDescending)
            default: order = .orderedSame
            }
            if order != .orderedSame { return (order == .orderedAscending) == ascending }
            return a.username.localizedCompare(b.username) == .orderedAscending
        }
    }
}

enum AdminPlayerFilter {
    /// Rows whose name (or the account a tombstone points at) contains `text`, ignoring case.
    static func apply(_ list: [AdminPlayer], _ text: String) -> [AdminPlayer] {
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return list }
        return list.filter { $0.username.lowercased().contains(q) || ($0.mergedInto ?? "").lowercased().contains(q) }
    }
}

/// A yes / no question before an action (the web's confirmAction).
struct AdminConfirm: Equatable {
    let title: String
    let text: String
    let confirmLabel: String
    var danger = true
}

/// A destructive action that needs a name typed exactly (the web's openTypedConfirm).
struct AdminTypedConfirm: Equatable {
    let title: String
    var intro: String?
    let lines: [String]
    /// What must be typed, exactly (case and spaces included).
    let expected: String
    let confirmLabel: String

    func isReady(_ typed: String) -> Bool { typed == expected }
}

/// The panel's words: the web panel's (client/src/ui/screens/AdminPanel.js), so both
/// clients ask and answer the same way. "live connection(s)" etc. are the web's forms.
enum AdminCopy {
    static let forbiddenToast = "Admin access is not available on this connection."
    static let noLongerAdmin = "You are no longer an admin."
    static let rateLimited = "Too many admin requests in a minute. Wait a moment and try again."
    static let noAnswer = "No answer from the server. Check the connection and try again."

    static func noAnswer(_ why: AdminApi.NoAnswer) -> String { why == .rateLimited ? rateLimited : noAnswer }
    /// After an action's own message, when the list's reload got no answer.
    static let listNotRefreshed = "The list could not be refreshed: pull down to reload it."
    static let resetLinkSpoken = "On screen. Use Copy or Share to pass it on."
    static let resetLinkCovered = "Hidden while the app is not in front."

    private static func accounts(_ n: Int) -> String { "\(n) account\(n == 1 ? "" : "s")" }

    // MARK: Players

    static func listed(_ n: Int) -> String { "\(accounts(n)) listed." }

    static func capNote(_ roster: AdminRoster) -> String? {
        roster.isCapped ? "Showing the newest \(roster.players.count) of \(roster.total) accounts. Sorting and the filter cover only these." : nil
    }

    static func countLine(shown: Int, roster: AdminRoster, query: String) -> String {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let all = roster.players.count
        return q.isEmpty ? "\(accounts(all))\(roster.isCapped ? " (of \(roster.total))" : "")."
            : "\(shown) of \(accounts(all)) match \"\(q)\"."
    }

    static func emptyPlayers(query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "No accounts." : "No account matches the filter."
    }

    /// The Merged column's text for a tombstone row, nil for a live account.
    static func tombstoneNote(_ p: AdminPlayer) -> String? {
        guard let kept = p.mergedInto else { return nil }
        if p.isHeldName { return "deleted, name held until \(AdminDates.day(p.heldUntil))" }
        return "\(p.renamed ? "renamed to" : "merged into") \(kept)"
    }

    static func lastSeen(_ p: AdminPlayer) -> String {
        p.isTombstone ? "—" : (p.online ? "now" : AdminDates.dateTime(p.lastSeenAt))
    }

    static func resetLinkMade(_ user: String) -> String { "Reset link made for \(user)." }
    static func resetLinkNote(expiresAt: Date?) -> String {
        "Shown once: copy it now. It works once, until \(AdminDates.dateTime(expiresAt)). Making a new link cancels this one. Using it signs the player out everywhere."
    }
    static let linkCopied = "Link copied. Text it to the player."

    static func signOutConfirm(_ user: String) -> AdminConfirm {
        AdminConfirm(title: "Sign \(user) out everywhere?",
                     text: "Every device \(user) is signed in on goes back to the sign-in screen, including a game in progress (it continues without them until they sign in again).",
                     confirmLabel: "Sign out everywhere")
    }
    static func signedOut(_ user: String, revoked: Int, disconnected: Int) -> String {
        "\(user) is signed out: \(revoked) saved session(s) revoked, \(disconnected) live connection(s) closed."
    }

    static func adminConfirm(_ user: String, make: Bool, isSelf: Bool) -> AdminConfirm {
        make ? AdminConfirm(title: "Make \(user) an admin?",
                            text: "\(user) will be able to do everything in this panel, including adding and removing admins.",
                            confirmLabel: "Make admin", danger: false)
            : AdminConfirm(title: "Remove \(user)'s admin?",
                           text: isSelf ? "You will lose access to this panel at once." : "\(user) loses access to this panel at once.",
                           confirmLabel: "Remove admin")
    }
    static func adminChanged(_ user: String, on: Bool) -> String { on ? "\(user) is now an admin." : "\(user) is no longer an admin." }

    static func finishRenameConfirm(from: String, to: String) -> AdminConfirm {
        AdminConfirm(title: "Finish renaming \(from) to \(to)?",
                     text: "The rename stopped partway: \(to) is renamed, but games, reports and block lists may still say \(from). Finishing moves them to \(to) and keeps \(from) as an old name that redirects.",
                     confirmLabel: "Finish rename", danger: false)
    }
    static func renameFinished(from: String, to: String, _ res: AdminResponse) -> String {
        "The rename of \(from) to \(to) is finished: \(res.int("gameRecords")) game record update(s), \(res.int("reports")) report field(s), \(res.int("otherUsersBlocks")) block list(s) moved."
    }

    static let renameSelfRefusal = "You cannot rename your own account here: it would sign you out before you see the result. Ask another admin to rename it."
    static let renameRules = "2 to 20 letters (A-Z), numbers, spaces and _ - . ; it starts with a letter or number. It must not be taken, ignoring capital letters (old merged or renamed names count)."
    static func renameLines(_ user: String) -> [String] {
        [
            "\(user) is signed out everywhere (refused while they are in a game or tournament) and any open reset link is cancelled. They sign in again with the new name and the same password.",
            "Their games, stats, reports and block lists move to the new name.",
            "\(user) stays as a reserved old name. Signing in with it and the account's password tells them the new name; nobody else is told it (not a wrong password, a sign-up or a profile). Delete that old name later to free it.",
        ]
    }
    /// Rename: a new name, different from the old one, typed twice the same.
    static func renameReady(old: String, newName: String, again: String) -> Bool {
        let name = newName.trimmingCharacters(in: .whitespaces)
        return !name.isEmpty && name != old && again == name
    }
    static func renamed(_ res: AdminResponse) -> String {
        let old = res.string("username"), new = res.string("newName")
        let kept = (res.body["oldNameKept"] as? Bool ?? true) ? "" : " The old name \(old) was taken meanwhile, so it does not redirect."
        return "\(old) is now called \(new): \(res.int("signedOut")) live connection(s) signed out; they sign in again as \(new) with the same password.\(kept)"
    }

    static let deleteSelfRefusal = "To delete your own account, use Delete account on your profile (it asks for your password)."
    static func deleteAdminRefusal(_ user: String) -> String { "\(user) is an admin. Remove their admin first, then delete the account." }
    static func deleteAccountConfirm(_ user: String) -> AdminTypedConfirm {
        AdminTypedConfirm(title: "Delete \(user)?", intro: "This cannot be undone. Deleting the account:", lines: [
            "signs \(user) out everywhere; they can never sign in to it again;",
            "deletes their stats (and leaderboard row), pictures and saved sessions;",
            "shows their name as [deleted] in past games (the other players keep those games);",
            "keeps reports by or about them, marked deleted;",
            "removes them from other players' block lists and cancels any open reset link;",
            "deletes the old names merged into it, and holds the name \(user) for 30 days so nobody signs up with it at once (Free name… on its row frees it sooner).",
        ], expected: user, confirmLabel: "Delete account")
    }
    static func accountDeleted(_ res: AdminResponse) -> String {
        "\(res.string("username")) is deleted: \(res.int("gameRecords")) game record update(s) to [deleted], \(res.int("reports")) report(s) marked, \(res.int("signedOut")) live connection(s) closed."
    }

    static func deleteOldNameConfirm(_ user: String, kept: String) -> AdminTypedConfirm {
        AdminTypedConfirm(title: "Delete the old name \(user)?", lines: [
            "Only the name \(user) is removed. \(kept) is not changed (its games, stats and merge history stay).",
            "Signing in as \(user) will no longer say to use \(kept), and anyone can sign up as \(user).",
        ], expected: user, confirmLabel: "Delete name")
    }
    static func oldNameDeleted(_ res: AdminResponse) -> String {
        "The old name \(res.string("username")) is deleted and free again. \(res.string("mergedInto")) is unchanged."
    }

    static func freeNameConfirm(_ user: String, heldUntil: Date?) -> AdminTypedConfirm {
        AdminTypedConfirm(title: "Free the name \(user)?", lines: [
            "\(user) belonged to an account that was deleted. The name is held until \(AdminDates.day(heldUntil)) so nobody takes it at once.",
            "Freeing it lets anyone sign up as \(user) now. Other players' blocks and reports of the name stay.",
        ], expected: user, confirmLabel: "Free name")
    }
    static func nameFreed(_ user: String) -> String { "The name \(user) is free again." }

    // MARK: Reports

    static func reportClosed(_ status: String) -> String { "Report \(status)." }
    static func emptyReports(openOnly: Bool) -> String { openOnly ? "No open reports." : "No reports." }
    static func reportResolution(_ r: AdminReport) -> String {
        "\(r.status == "resolved" ? "Resolved" : "Dismissed") by \(r.resolvedBy ?? "?") \(AdminDates.dateTime(r.resolvedAt))\(r.note.map { ": \($0)" } ?? "")"
    }
    static let reportNoteLimit = 500

    /// The note as sent: trimmed, at most 500 UTF-16 units (the server's Joi counts a
    /// string's length that way, so 500 emoji would be refused), never half a character.
    static func reportNote(_ raw: String) -> String {
        var out = ""
        var units = 0
        for ch in raw.trimmingCharacters(in: .whitespacesAndNewlines) {
            units += ch.utf16.count
            if units > reportNoteLimit { break }
            out.append(ch)
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Admins

    static let adminsNote = "To make someone an admin, find them under Players."

    // MARK: Merge

    static let mergeNamesNeeded = "Name the account to keep and at least one account to merge into it."
    static let mergeNamesChanged = "The names changed: preview again."
    static let noDuplicates = "No look-alike names found."
    static func duplicateGroups(_ n: Int) -> String { "\(n) group(s) of look-alike names." }
    static func duplicateLine(_ group: [AdminDuplicate]) -> String {
        group.map { "\($0.username) (\($0.gamesPlayed) games, \($0.botGamesPlayed) bot)" }.joined(separator: ", ")
    }

    /// "alan2, AlanB , alan2" -> ["alan2", "AlanB"]: trimmed, empties dropped, first of each kept.
    static func mergeSources(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    static func planHeading(_ plan: AdminMergePlan) -> String { "Merge \(plan.sources.joined(separator: ", ")) into \(plan.target)" }
    static func previewReady(_ plan: AdminMergePlan) -> String {
        plan.errors.isEmpty ? "Preview ready: \(plan.changeCount) change(s)." : "The merge cannot be done: see the errors."
    }
    static func roleLabel(_ role: String) -> String {
        switch role {
        case "target": return "Keep"
        case "result": return "Result"
        default: return "Merge"
        }
    }
    static func statChange(_ c: AdminMergePlan.StatChange) -> String {
        "\(c.key): \(StatsWire.display(c.before)) → \(StatsWire.display(c.after))"
    }
    private static func list(_ names: [String]) -> String { "[\(names.joined(separator: ", "))]" }

    /// The plan's summary lines, in the web's order.
    static func planLines(_ plan: AdminMergePlan) -> [String] {
        var lines: [String] = []
        if let from = plan.profilePicFrom { lines.append("Profile photo: copy the custom photo from \(from) (\(plan.target) has none).") }
        if let b = plan.targetBlockedUsers { lines.append("\(plan.target)'s block list: \(list(b.before)) → \(list(b.after))") }
        lines.append("Game records to re-point: \(plan.gameRecords.count)")
        lines.append("Reports to re-point: \(plan.reports.count)")
        lines.append("Other players' block lists to update: \(plan.otherUsersBlocks.count)")
        if !plan.chainedTombstones.isEmpty {
            lines.append("Older merged accounts to re-point: " + plan.chainedTombstones.map { "\($0.username) (was → \($0.before))" }.joined(separator: ", "))
        }
        lines.append("Accounts to retire (can't sign in, name stays reserved): \(plan.retire.isEmpty ? "none (already retired)" : plan.retire.joined(separator: ", "))")
        return lines
    }

    static let gameRecordsShown = 20
    static func gameRecordLine(_ r: AdminMergePlan.GameRecord) -> String {
        "\(AdminDates.day(r.completedAt)) \(r.gameId): \(list(r.before.team1)) vs \(list(r.before.team2)) → \(list(r.after.team1)) vs \(list(r.after.team2))"
    }
    static func reportLine(_ r: AdminMergePlan.ReportChange) -> String {
        "Report: reporter \(r.reporter)\(r.newReporter.map { " → \($0)" } ?? ""), reported \(r.reported)\(r.newReported.map { " → \($0)" } ?? "")"
    }
    static func blocksLine(_ u: AdminMergePlan.OtherBlocks) -> String { "\(u.username) blocks: \(list(u.before)) → \(list(u.after))" }
    static func changeCount(_ plan: AdminMergePlan) -> String {
        plan.changeCount == 0 ? "Nothing to do. This merge is already complete." : "\(plan.changeCount) change(s) planned."
    }
    static func mergeConfirmNote(_ target: String) -> String {
        "This cannot be undone from the panel. The retired accounts are signed out and can no longer sign in; signing in as one of them names \(target)."
    }
    static func mergedLines(_ r: AdminMergeResult) -> [String] {
        [
            "Kept: \(r.target)",
            "Stats merged from: \(r.statsMerged.isEmpty ? "(none)" : r.statsMerged.joined(separator: ", "))",
            "Retired: \(r.retired.isEmpty ? "(none)" : r.retired.joined(separator: ", "))",
            "Game records: \(r.gameRecords), reports: \(r.reports), other block lists: \(r.otherUsersBlocks)",
            "Signed out: \(r.signedOut) live connection(s)",
        ]
    }
    static func merged(_ target: String) -> String { "Merged into \(target)." }
}

/// The display flag on signInResponse / restoreSessionResponse: present only when true.
enum AdminFlag {
    static func read(_ reply: [String: Any]) -> Bool { reply["isAdmin"] as? Bool == true }
}
