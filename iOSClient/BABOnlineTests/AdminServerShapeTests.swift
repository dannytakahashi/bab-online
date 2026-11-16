import XCTest
@testable import BAB_Online

/// The admin panel's models and words against the server's own answers
/// (`AdminServerAnswers`, recorded from the real handlers): every action's reply is read
/// through the same code as on the wire, and a scripted server that replays them drives
/// the panel end to end. A field renamed on the server, or read under the wrong key here,
/// fails this; the fixtures written by hand (UIFixture+Admin) cannot show that.
@MainActor
final class AdminServerShapeTests: XCTestCase {
    private let answers = AdminServerAnswers.all()

    private func res(_ key: String, file: StaticString = #filePath, line: UInt = #line) -> AdminResponse {
        guard let dict = answers[key] else {
            XCTFail("no recorded answer \(key)", file: file, line: line)
            return AdminResponse([:])
        }
        return AdminResponse(dict)
    }

    func testEveryRecordedAnswerIsThere() {
        XCTAssertEqual(answers.count, 28)
        let actions = Set(answers.values.compactMap { $0["action"] as? String })
        // searchPlayers is not used by the panel (nor by the web's)
        XCTAssertEqual(actions, Set(AdminAction.allCases.map(\.rawValue)), "every action the panel sends has a recorded answer")
    }

    func testPlayersRows() {
        let before = res("listPlayers")
        XCTAssertTrue(before.ok)
        let rows = AdminPlayer.list(before.body["players"])
        XCTAssertEqual(rows.count, (before.body["players"] as? [Any])?.count, "no row dropped")
        XCTAssertEqual(rows.map(\.username), ["bea", "Dee", "Old", "Cy", "Bea", "Owner"])
        XCTAssertEqual(before.int("total"), 6)
        let owner = rows.first { $0.username == "Owner" }!
        XCTAssertTrue(owner.isAdmin)
        XCTAssertTrue(owner.online)
        XCTAssertEqual(owner.gamesPlayed, 4)
        XCTAssertNotNil(owner.createdAt)
        XCTAssertNotNil(owner.lastSeenAt)
        let bea = rows.first { $0.username == "Bea" }!
        XCTAssertEqual([bea.gamesPlayed, bea.botGamesPlayed], [2, 3])
        XCTAssertFalse(bea.isTombstone, "mergedInto: null is a live account")
        XCTAssertNil(bea.heldUntil, "heldUntil: null is sent on every row")
        XCTAssertNil(bea.renameUnfinished)
        let old = rows.first { $0.username == "Old" }!
        XCTAssertEqual(old.mergedInto, "Bea")
        XCTAssertFalse(old.isHeldName)
        XCTAssertEqual(AdminCopy.tombstoneNote(old), "merged into Bea")

        // after a merge, a rename and a delete: the three kinds of old name
        let after = AdminPlayer.list(res("listPlayersAfter").body["players"])
        let byName = Dictionary(uniqueKeysWithValues: after.map { ($0.username, $0) })
        XCTAssertEqual(AdminCopy.tombstoneNote(byName["Dee"]!), "renamed to Deanna")
        XCTAssertEqual(AdminCopy.tombstoneNote(byName["Cy"]!), "merged into Bea")
        XCTAssertTrue(byName["bea"]!.isHeldName, "a deleted account's name is held")
        XCTAssertEqual(byName["bea"]!.mergedInto, "[deleted]")
        XCTAssertNotNil(byName["bea"]!.heldUntil)
        XCTAssertEqual([byName["Bea"]!.gamesPlayed, byName["Bea"]!.botGamesPlayed], [7, 4], "the merged stats")
        XCTAssertNil(byName["Old"], "the deleted old name is gone")
    }

    func testResetLinkSignOutAndDuplicates() {
        let link = res("createResetLink")
        XCTAssertEqual(link.string("username"), "Bea")
        XCTAssertEqual(link.string("token").count, 43)
        XCTAssertNotNil(AdminDates.parse(link.body["expiresAt"]))

        let out = res("signOutEverywhere")
        XCTAssertEqual(AdminCopy.signedOut(out.string("username"), revoked: out.int("revokedSessions"), disconnected: out.int("disconnected")),
                       "Bea is signed out: 1 saved session(s) revoked, 1 live connection(s) closed.")

        let groups = AdminDuplicate.groups(res("findDuplicates").body["groups"])
        XCTAssertEqual(groups.map { $0.map(\.username) }, [["Bea", "bea"]])
        XCTAssertEqual(AdminCopy.duplicateLine(groups[0]), "Bea (2 games, 3 bot), bea (0 games, 0 bot)")
    }

    func testMergePlanAndResult() {
        let answer = res("planMerge")
        XCTAssertEqual(answer.string("planHash").count, 64)
        let plan = AdminMergePlan(answer.body["plan"])
        XCTAssertEqual(plan.target, "Bea")
        XCTAssertEqual(plan.sources, ["Cy"])
        XCTAssertTrue(plan.errors.isEmpty)
        XCTAssertEqual(plan.warnings.count, 1)
        XCTAssertEqual(plan.accounts.map(\.role), ["target", "source", "result"])
        XCTAssertEqual(plan.accounts.map(\.username), ["Bea", "Cy", "Bea"])
        XCTAssertEqual(plan.accounts[1].note, "stats will be added")
        XCTAssertNil(plan.accounts[2].createdAt)
        XCTAssertEqual(plan.accounts[2].stats.gamesPlayed, 7)
        XCTAssertEqual(plan.accounts[2].stats.wins, 5)
        XCTAssertEqual(plan.accounts[2].stats.totalPoints, 700)
        XCTAssertEqual(plan.accounts[2].botStats.gamesPlayed, 4)
        XCTAssertEqual(plan.statChanges.map(AdminCopy.statChange), [
            "wins: 1 → 5", "losses: 1 → 2", "gamesPlayed: 2 → 7", "totalPoints: 200 → 700", "totalTricksTaken: 16 → 56", "totalSets: 1 → 2",
        ])
        XCTAssertEqual(plan.botStatChanges.count, 5)
        XCTAssertNil(plan.profilePicFrom)
        XCTAssertEqual(plan.targetBlockedUsers?.after, ["Dee"])
        XCTAssertEqual(plan.gameRecords.map(\.gameId), ["g1", "g2"])
        XCTAssertNotNil(plan.gameRecords[0].completedAt)
        XCTAssertEqual(plan.reports.count, 2)
        XCTAssertEqual(plan.reports[0].newReported, "Bea")
        XCTAssertNil(plan.reports[0].newReporter)
        XCTAssertEqual(plan.otherUsersBlocks.first?.after, ["Bea"])
        XCTAssertEqual(plan.retire, ["Cy"])
        XCTAssertEqual(plan.changeCount, 8)
        XCTAssertEqual(AdminCopy.planLines(plan).prefix(4), [
            "Bea's block list: [] → [Dee]", "Game records to re-point: 2", "Reports to re-point: 2", "Other players' block lists to update: 1",
        ])

        let refused = AdminMergePlan(res("planMergeErrors").body["plan"])
        XCTAssertEqual(refused.errors, ["Target \"Old\" was itself merged into \"Bea\". Merge into \"Bea\" instead."])
        XCTAssertTrue(refused.accounts.isEmpty)
        XCTAssertEqual(refused.changeCount, 0)

        XCTAssertEqual(res("applyMergeStale").error, "stale_plan")
        XCTAssertEqual(res("applyMergeBadConfirm").error, "invalid")
        XCTAssertEqual(res("applyMergeBadConfirm").message, "Type the kept account's name, Bea, exactly to confirm.")
        let result = AdminMergeResult(res("applyMerge").body["result"])
        XCTAssertEqual(AdminCopy.mergedLines(result), [
            "Kept: Bea", "Stats merged from: Cy", "Retired: Cy", "Game records: 2, reports: 2, other block lists: 1", "Signed out: 0 live connection(s)",
        ])
    }

    func testReportsAdminsAndAudit() {
        let open = AdminReport.list(res("listReports").body["reports"])
        XCTAssertEqual(open.map(\.reason), ["rude", "spam"])
        XCTAssertTrue(open.allSatisfy(\.isOpen))
        XCTAssertEqual(open[1].context, "chat line")
        XCTAssertEqual(open[0].id.count, 24, "the id resolveReport sends back")
        XCTAssertNotNil(open[0].createdAt)
        let closed = AdminReport.list(res("listReportsAfter").body["reports"])[0]
        XCTAssertEqual(closed.status, "resolved")
        XCTAssertEqual(closed.resolvedBy, "Owner")
        XCTAssertEqual(closed.note, "warned them")
        XCTAssertNotNil(closed.resolvedAt)
        XCTAssertTrue(AdminCopy.reportResolution(closed).contains("Owner"))
        XCTAssertEqual(res("resolveReportAgain").message, "That report was already resolved by Owner.")

        let admins = AdminRoleEntry.list(res("listAdmins").body["admins"])
        XCTAssertEqual(admins.map(\.username), ["Dee", "Owner"])
        XCTAssertNotNil(admins[0].adminSince)
        XCTAssertNil(admins[1].adminSince, "the first admin (set by the script) has no date")
        XCTAssertEqual(res("setAdminLast").error, "last_admin")
        XCTAssertEqual(res("setAdmin").body["changed"] as? Bool, true)

        let page = res("listAudit")
        let entries = AdminAuditEntry.list(page.body["entries"])
        XCTAssertEqual(entries.count, 5)
        XCTAssertEqual(page.body["hasMore"] as? Bool, true)
        XCTAssertEqual(entries[0].action, "deleteAccount")
        XCTAssertEqual(entries[0].result, "failed")
        XCTAssertEqual(entries[0].actor, "Owner")
        XCTAssertEqual(entries[0].target, "Nobody")
        XCTAssertNotNil(entries[0].at)
        XCTAssertNotNil(entries[0].detail)
        // the cursor: the time exactly as sent (Joi's iso date) and the 24-hex id
        XCTAssertTrue(entries[4].atRaw.hasSuffix("Z"))
        XCTAssertEqual(entries[4].id.count, 24)
        let next = AdminAuditEntry.list(res("listAuditPage2").body["entries"])
        XCTAssertTrue(Set(next.map(\.id)).isDisjoint(with: entries.map(\.id)), "the next page starts after the cursor")
        XCTAssertNil(next.first { $0.action == "listAdmins" }?.target, "target: null")
    }

    func testRenameDeleteAndRefusals() {
        XCTAssertEqual(AdminCopy.renamed(res("renameAccount")),
                       "Dee is now called Deanna: 0 live connection(s) signed out; they sign in again as Deanna with the same password.")
        XCTAssertEqual(res("renameTaken").message, "That name is taken.")
        XCTAssertEqual(res("renameTaken").error, "refused")
        XCTAssertEqual(AdminCopy.oldNameDeleted(res("deleteTombstone")), "The old name Old is deleted and free again. Bea is unchanged.")
        XCTAssertEqual(AdminCopy.accountDeleted(res("deleteAccount")),
                       "bea is deleted: 0 game record update(s) to [deleted], 0 report(s) marked, 0 live connection(s) closed.")
        XCTAssertEqual(res("deleteBadConfirm").error, "invalid")
        XCTAssertEqual(res("deleteMissing").error, "not_found")
        XCTAssertEqual(res("deleteAdminRefused").message, "\"Dee\" is an admin. Remove their admin first, then delete the account.")
        let forbidden = res("forbidden")
        XCTAssertTrue(forbidden.isForbidden)
        XCTAssertEqual(forbidden.message, "Not available.")
    }

    /// The panel itself over the recorded answers, in the order they were recorded.
    func testThePanelReadsTheServersAnswersEndToEnd() async {
        let admin = AdminState(notifications: NotificationCenter())
        admin.username = { "Owner" }
        admin.origin = { "https://bab.invalid" }
        var lost: String?
        admin.accessLost = { lost = $0 }
        var next: [AdminAction: [String]] = [
            .listPlayers: ["listPlayers", "listPlayersAfter"], .planMerge: ["planMerge"], .applyMerge: ["applyMerge"],
            .listReports: ["listReports", "listReportsAfter"], .resolveReport: ["resolveReport"], .listAdmins: ["listAdmins"],
            .listAudit: ["listAudit", "listAuditPage2"], .createResetLink: ["createResetLink"],
        ]
        var sentArgs: [AdminAction: [String: Any]] = [:]
        let answers = answers
        admin.requester = { action, args in
            sentArgs[action] = args
            guard var keys = next[action], !keys.isEmpty else { return .success(AdminResponse(answers["forbidden"]!)) }
            let key = keys.removeFirst()
            next[action] = keys
            return .success(AdminResponse(answers[key]!))
        }
        admin.open()
        await admin.tabOpened(.players)
        XCTAssertEqual(admin.roster?.players.count, 6)
        XCTAssertEqual(admin.roster?.total, 6)
        XCTAssertTrue(admin.isSelf("Owner"))
        await admin.createResetLink("Bea")
        XCTAssertEqual(admin.resetLink?.url, "https://bab.invalid/reset#" + String(repeating: "T", count: 43))
        XCTAssertNotNil(admin.resetLink?.expiresAt)

        admin.tab = .merge
        admin.mergeKeep = "Bea"
        admin.mergeSources = "Cy"
        await admin.previewMerge()
        XCTAssertEqual(admin.status, .init(text: "Preview ready: 8 change(s).", kind: .info))
        await admin.applyMerge(typed: "Bea")
        XCTAssertEqual(sentArgs[.applyMerge]?["planHash"] as? String, String(repeating: "ab", count: 32), "the previewed plan's hash goes back")
        XCTAssertEqual(admin.mergeResult?.retired, ["Cy"])

        admin.tab = .reports
        await admin.loadReports()
        await admin.closeReport(admin.reports![0], as: "resolved", note: "warned them")
        XCTAssertEqual(sentArgs[.resolveReport]?["id"] as? String, "6afa863cbcddd6fff3bf7b68")
        XCTAssertEqual(admin.reports?.first?.status, "resolved", "reloaded")

        admin.tab = .audit
        await admin.loadAudit()
        await admin.loadAudit(append: true)
        XCTAssertEqual(sentArgs[.listAudit]?["before"] as? String, "2026-11-16T04:27:40.153Z")
        XCTAssertEqual(sentArgs[.listAudit]?["beforeId"] as? String, "6afa863cbcddd6fff3bf7b7d")
        XCTAssertEqual(admin.audit?.count, 10)

        // the server's forbidden answer, exactly as sent: the panel closes, the entry hides
        admin.tab = .admins
        await admin.loadAdmins()
        XCTAssertNotNil(admin.admins)
        await admin.findDuplicates()
        XCTAssertFalse(admin.isPresented)
        XCTAssertEqual(lost, "Admin access is not available on this connection.")
        XCTAssertNil(admin.roster)
    }
}
