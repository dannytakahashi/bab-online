import XCTest
@testable import BAB_Online

/// The admin panel (iOS 1.2.2): the transport (`AdminApi`: requestId matching, timeout,
/// offline refusal, the rate-limit fail-fast, a lost connection), the reply rows
/// (AdminModels, read leniently), the Players sort and filter (the web's rules), the words
/// and confirmations (the web's), and the panel's logic (`AdminState`) against a scripted
/// server: forbidden closes the panel and hides the entry, self-removal too, typed
/// confirmations, the reset link (never in a message), merge preview / apply / stale plan.
@MainActor
final class AdminPanelTests: XCTestCase {
    // MARK: - Helpers

    /// Lets the main actor's queued tasks run until `done` (or about a second).
    private func settle(_ what: String = "settled", until done: () -> Bool = { false }, rounds: Int = 200) async {
        for _ in 0..<rounds {
            if done() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    private func response(_ fields: [String: Any], ok: Bool = true, action: String = "x") -> AdminResponse {
        AdminResponse(fields.merging(["requestId": "r", "action": action, "ok": ok]) { a, _ in a })
    }

    private static func playerRow(_ name: String, created: String? = "2026-11-01T10:00:00.000Z", seen: String? = nil, online: Bool = false,
                                  games: Int = 0, bot: Int = 0, admin: Bool = false, into: String? = nil, renamed: Bool = false,
                                  unfinished: String? = nil, held: String? = nil) -> [String: Any] {
        var row: [String: Any] = ["username": name, "createdAt": created ?? NSNull() as Any, "lastSeenAt": seen ?? NSNull() as Any,
                                  "online": online, "gamesPlayed": games, "botGamesPlayed": bot, "isAdmin": admin,
                                  "mergedInto": into ?? NSNull() as Any, "renamed": renamed, "renameUnfinished": unfinished ?? NSNull() as Any]
        if let held { row["heldUntil"] = held }
        return row
    }

    /// A scripted server for AdminState: records every request, answers from `answers`.
    private final class Script {
        var calls: [(action: AdminAction, args: [String: Any])] = []
        var answers: (AdminAction, [String: Any]) -> AdminApi.Outcome = { _, _ in .failure(.timeout) }
        func count(_ a: AdminAction) -> Int { calls.filter { $0.action == a }.count }
        func last(_ a: AdminAction) -> [String: Any]? { calls.last { $0.action == a }?.args }
    }

    private func ok(_ action: AdminAction, _ fields: [String: Any] = [:]) -> AdminApi.Outcome {
        .success(AdminResponse(fields.merging(["requestId": "r", "action": action.rawValue, "ok": true]) { a, _ in a }))
    }

    private func refused(_ action: AdminAction, _ error: String, _ message: String) -> AdminApi.Outcome {
        .success(AdminResponse(["requestId": "r", "action": action.rawValue, "ok": false, "error": error, "message": message]))
    }

    /// An open panel signed in as ivy over `script`, with the roster below.
    private func panel(_ script: Script, lost: @escaping (String) -> Void = { _ in }) -> AdminState {
        let admin = AdminState()
        admin.username = { "ivy" }
        admin.origin = { "https://bab.invalid" }
        admin.accessLost = lost
        admin.requester = { action, args in
            script.calls.append((action, args))
            return script.answers(action, args)
        }
        admin.open()
        return admin
    }

    private static let roster: [[String: Any]] = [
        playerRow("ivy", online: true, games: 51, admin: true),
        playerRow("kim", seen: "2026-11-10T08:00:00.000Z", games: 42, bot: 3),
        playerRow("jon", games: 25, admin: true),
        playerRow("kim2", into: "kim"),
        playerRow("ghost", into: "[deleted]", held: "2026-12-15T00:00:00.000Z"),
    ]

    private func rosterAnswers(_ script: Script, extra: @escaping (AdminAction, [String: Any]) -> AdminApi.Outcome? = { _, _ in nil }) {
        script.answers = { [unowned self] action, args in
            if let r = extra(action, args) { return r }
            if action == .listPlayers { return self.ok(.listPlayers, ["players": Self.roster, "total": Self.roster.count, "limit": 500]) }
            return .failure(.timeout)
        }
    }

    // MARK: - Transport

    func testAnswersAreMatchedByRequestId() async {
        let api = AdminApi(timeout: 5, rateLimitGrace: 5)
        var sent: [[String: Any]] = []
        api.send = { sent.append($0); return true }
        let first = Task { await api.request(.listAdmins) }
        let second = Task { await api.request(.createResetLink, ["username": "kim"]) }
        await settle { sent.count == 2 }
        XCTAssertEqual(sent.count, 2)
        let ids = sent.compactMap { $0["requestId"] as? String }
        XCTAssertEqual(Set(ids).count, 2, "every request has its own id")
        XCTAssertTrue(ids.allSatisfy { !$0.isEmpty && $0.count <= 64 }, "the contract's requestId length")
        XCTAssertEqual(sent.first { $0["action"] as? String == "createResetLink" }?["args"] as? [String: String], ["username": "kim"])
        XCTAssertNotNil(sent.first { $0["action"] as? String == "listAdmins" }?["args"] as? [String: Any], "args is always an object")

        // an answer nobody waits for is dropped; the second request's answer comes first
        api.handleResponse(["requestId": "adm-other", "action": "listAdmins", "ok": true])
        XCTAssertEqual(api.pendingCount, 2)
        let secondId = sent.first { $0["action"] as? String == "createResetLink" }?["requestId"] as? String ?? ""
        let firstId = sent.first { $0["action"] as? String == "listAdmins" }?["requestId"] as? String ?? ""
        api.handleResponse(["requestId": secondId, "action": "createResetLink", "ok": true, "username": "kim"])
        api.handleResponse(["requestId": firstId, "action": "listAdmins", "ok": false, "error": "forbidden", "message": "Not available."])
        let a = await first.value, b = await second.value
        guard case .success(let ra) = a, case .success(let rb) = b else { return XCTFail("both answered") }
        XCTAssertTrue(ra.isForbidden)
        XCTAssertEqual(ra.message, "Not available.")
        XCTAssertTrue(rb.ok)
        XCTAssertEqual(rb.string("username"), "kim")
        XCTAssertEqual(api.pendingCount, 0)
    }

    func testARequestThatCannotGoOutFailsAtOnceAsOffline() async {
        let api = AdminApi(timeout: 5, rateLimitGrace: 5)
        api.send = { _ in false }
        let started = Date()
        let r = await api.request(.listPlayers)
        XCTAssertEqual(r.failure, .offline)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertEqual(api.pendingCount, 0)
    }

    func testNoAnswerTimesOut() async {
        let api = AdminApi(timeout: 0.15, rateLimitGrace: 5)
        api.send = { _ in true }
        let r = await api.request(.listPlayers)
        XCTAssertEqual(r.failure, .timeout)
        // the late answer does nothing
        api.handleResponse(["requestId": "adm-late", "ok": true])
        XCTAssertEqual(api.pendingCount, 0)
    }

    func testTheRateLimitErrorFailsWhatWaitsAfterTheGrace() async {
        let api = AdminApi(timeout: 5, rateLimitGrace: 0.15)
        api.send = { _ in true }
        XCTAssertFalse(api.handleServerError(["code": "rateLimit", "handler": "adminRequest"]), "nothing waiting: not claimed (a toast)")
        let task = Task { await api.request(.listAudit) }
        await settle { api.pendingCount == 1 }
        XCTAssertFalse(api.handleServerError(["code": "rateLimit", "handler": "joinLobby"]), "another handler's limit")
        XCTAssertFalse(api.handleServerError(["code": "validation", "handler": "adminRequest"]), "not the limit")
        let started = Date()
        XCTAssertTrue(api.handleServerError(["code": "rateLimit", "handler": "adminRequest", "message": "Too many requests"]))
        let r = await task.value
        XCTAssertEqual(r.failure, .rateLimited)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "well before the 5 s timeout")
    }

    func testAnAcceptedRequestStillAnswersInsideTheRateLimitGrace() async {
        let api = AdminApi(timeout: 5, rateLimitGrace: 1)
        var sent: [[String: Any]] = []
        api.send = { sent.append($0); return true }
        let task = Task { await api.request(.listAdmins) }
        await settle { sent.count == 1 }
        XCTAssertTrue(api.handleServerError(["code": "rateLimit", "handler": "adminRequest"]))
        api.handleResponse(["requestId": sent[0]["requestId"] ?? "", "action": "listAdmins", "ok": true, "admins": [Any]()])
        let r = await task.value
        XCTAssertNotNil(try? r.get(), "the answer wins over the pending rate-limit failure")
    }

    func testALostConnectionAndAClosedPanelFailWhatWaits() async {
        let api = AdminApi(timeout: 5, rateLimitGrace: 5)
        api.send = { _ in true }
        let one = Task { await api.request(.listPlayers) }
        await settle { api.pendingCount == 1 }
        api.connectionLost()
        let r1 = await one.value
        XCTAssertEqual(r1.failure, .offline)
        let two = Task { await api.request(.listPlayers) }
        await settle { api.pendingCount == 1 }
        api.closeAll()
        let r2 = await two.value
        XCTAssertEqual(r2.failure, .closed)
    }

    // MARK: - The display flag

    func testTheAdminFlagIsOnlyALiteralTrue() {
        XCTAssertTrue(AdminFlag.read(["success": true, "isAdmin": true]))
        XCTAssertFalse(AdminFlag.read(["success": true]))
        XCTAssertFalse(AdminFlag.read(["isAdmin": false]))
        XCTAssertFalse(AdminFlag.read(["isAdmin": "true"]))
        XCTAssertFalse(AdminFlag.read(["isAdmin": NSNull()]))
    }

    func testRestoreAndSignOutSetAndClearTheFlag() async {
        let auth = AuthState()
        auth.username = "ivy"
        let app = AppState()
        let handler = AuthSocketHandler(socket: SocketService.shared, authState: auth, appState: app, gameState: GameState(),
                                        safetyState: SafetyState(), lobbyState: LobbyState())
        handler.handleRestoreSessionResponse(["success": true, "username": "ivy", "isAdmin": true])
        await settle { auth.isAdmin }
        XCTAssertTrue(auth.isAdmin, "restoreSessionResponse isAdmin: true shows the entry")
        handler.handleRestoreSessionResponse(["success": true, "username": "ivy"])
        await settle { !auth.isAdmin }
        XCTAssertFalse(auth.isAdmin, "a restore without the key (the flag was removed) hides it")
        auth.isAdmin = true
        handler.handleRestoreSessionResponse(["success": false, "message": "Invalid session token"])
        await settle { !auth.isAdmin }
        XCTAssertFalse(auth.isAdmin, "a failed restore hides it")
        XCTAssertEqual(app.screen, .signIn)
        auth.isAdmin = true
        auth.clearCredentials()
        XCTAssertFalse(auth.isAdmin, "sign-out, forceLogout and account deletion all clear it")
        SocketService.shared.isSessionReady = false
    }

    // MARK: - Reply rows

    func testPlayerRowsAreReadLeniently() {
        let live = AdminPlayer(Self.playerRow("kim", seen: "2026-11-10T08:00:00Z", online: true, games: 42, bot: 3, admin: true, unfinished: "kimm"))
        XCTAssertEqual(live?.username, "kim")
        XCTAssertNotNil(live?.createdAt, "fractional seconds")
        XCTAssertNotNil(live?.lastSeenAt, "no fractional seconds")
        XCTAssertEqual(live?.gamesPlayed, 42)
        XCTAssertEqual(live?.botGamesPlayed, 3)
        XCTAssertEqual(live?.isAdmin, true)
        XCTAssertEqual(live?.renameUnfinished, "kimm")
        XCTAssertEqual(live?.isTombstone, false)

        let merged = AdminPlayer(Self.playerRow("kim2", into: "kim"))
        XCTAssertEqual(merged?.isTombstone, true)
        XCTAssertEqual(merged?.isHeldName, false)
        XCTAssertEqual(AdminCopy.tombstoneNote(merged!), "merged into kim")
        XCTAssertEqual(AdminCopy.tombstoneNote(AdminPlayer(Self.playerRow("old", into: "new", renamed: true))!), "renamed to new")
        let held = AdminPlayer(Self.playerRow("ghost", into: "[deleted]", held: "2026-12-15T00:00:00.000Z"))!
        XCTAssertTrue(held.isHeldName)
        XCTAssertTrue(AdminCopy.tombstoneNote(held)!.hasPrefix("deleted, name held until "))
        XCTAssertEqual(AdminCopy.lastSeen(held), "—")
        XCTAssertEqual(AdminCopy.lastSeen(live!), "now")

        // an older or newer server: missing keys default, unknown keys are ignored, junk rows are dropped
        let bare = AdminPlayer(["username": "pat", "somethingNew": ["x": 1]])
        XCTAssertEqual(bare?.gamesPlayed, 0)
        XCTAssertNil(bare?.createdAt)
        XCTAssertNil(bare?.mergedInto)
        XCTAssertEqual(AdminPlayer.list([["username": "a"], ["gamesPlayed": 3], "junk", ["username": ""]]).map(\.username), ["a"])
        XCTAssertEqual(AdminPlayer.list(nil), [])
    }

    func testResponsesReportsAuditAndPlanDecode() {
        let failure = AdminResponse(["requestId": "r1", "action": "setAdmin", "ok": false, "error": "last_admin", "message": "Only admin."])
        XCTAssertFalse(failure.ok)
        XCTAssertEqual(failure.error, "last_admin")
        XCTAssertFalse(failure.isForbidden)
        XCTAssertEqual(AdminResponse(["ok": false]).message, "Refused.", "the web's fallback")
        XCTAssertFalse(AdminResponse([:]).ok, "no ok is not ok")

        let report = AdminReport(["id": "abc", "reporter": "kim", "reported": "hal", "reason": "x", "context": "", "createdAt": "2026-11-10T08:00:00.000Z",
                                  "status": "resolved", "resolvedBy": "ivy", "resolvedAt": "2026-11-11T08:00:00.000Z", "note": "warned",
                                  "reporterDeleted": false, "reportedDeleted": true])!
        XCTAssertFalse(report.isOpen)
        XCTAssertTrue(report.reportedDeleted)
        XCTAssertTrue(AdminCopy.reportResolution(report).hasPrefix("Resolved by ivy "))
        XCTAssertTrue(AdminCopy.reportResolution(report).hasSuffix(": warned"))
        XCTAssertEqual(AdminReport(["id": "abc", "status": "whatever"])?.status, "open", "an unknown status reads as open, as the server maps it")

        let entry = AdminAuditEntry(["id": "e1", "at": "2026-11-10T08:00:00.123Z", "actor": NSNull(), "action": "setAdmin", "target": "kim",
                                     "result": "forbidden", "detail": NSNull()])!
        XCTAssertEqual(entry.atRaw, "2026-11-10T08:00:00.123Z", "the cursor sends the time back as it came")
        XCTAssertNil(entry.actor)
        XCTAssertNil(entry.detail)

        let plan = AdminMergePlan([
            "target": "Alan", "sources": ["alan2", "AlanB"], "errors": [String](), "warnings": ["w"],
            "accounts": [["role": "target", "username": "Alan", "createdAt": "2026-01-01T00:00:00.000Z",
                          "stats": ["gamesPlayed": 30, "wins": 15, "losses": 12, "draws": 3, "totalPoints": 5400],
                          "botStats": ["gamesPlayed": 2, "wins": 1, "losses": 1, "draws": 0, "totalPoints": 300], "note": NSNull()]],
            "statChanges": [["key": "gamesPlayed", "before": 30, "after": 35]],
            "botStatChanges": [["key": "gamesPlayed", "before": 2, "after": 3]],
            "profilePicFrom": "alan2", "targetBlockedUsers": ["before": [String](), "after": ["max"]],
            "gameRecords": [["gameId": "g1", "completedAt": NSNull(), "before": ["team1": ["alan2", "kim"], "team2": ["hal", "jon"]],
                             "after": ["team1": ["Alan", "kim"], "team2": ["hal", "jon"]]]],
            "reports": [["id": "r", "reporter": "alan2", "reported": "hal", "newReporter": "Alan", "newReported": NSNull()]],
            "otherUsersBlocks": [["username": "pat", "before": ["alan2"], "after": ["Alan"]]],
            "chainedTombstones": [["username": "al", "before": "alan2"]], "retire": ["alan2", "AlanB"], "changeCount": 9,
        ] as [String: Any])
        XCTAssertEqual(plan.accounts.first?.stats.totalPoints, 5400)
        XCTAssertEqual(plan.accounts.first?.botStats.gamesPlayed, 2)
        XCTAssertEqual(plan.botStatChanges.map(AdminCopy.statChange), ["gamesPlayed: 2 → 3"])
        XCTAssertEqual(AdminCopy.planHeading(plan), "Merge alan2, AlanB into Alan")
        XCTAssertEqual(AdminCopy.planLines(plan), [
            "Profile photo: copy the custom photo from alan2 (Alan has none).",
            "Alan's block list: [] → [max]",
            "Game records to re-point: 1",
            "Reports to re-point: 1",
            "Other players' block lists to update: 1",
            "Older merged accounts to re-point: al (was → alan2)",
            "Accounts to retire (can't sign in, name stays reserved): alan2, AlanB",
        ])
        XCTAssertEqual(AdminCopy.reportLine(plan.reports[0]), "Report: reporter alan2 → Alan, reported hal")
        XCTAssertEqual(AdminCopy.blocksLine(plan.otherUsersBlocks[0]), "pat blocks: [alan2] → [Alan]")
        XCTAssertTrue(AdminCopy.gameRecordLine(plan.gameRecords[0]).hasSuffix("g1: [alan2, kim] vs [hal, jon] → [Alan, kim] vs [hal, jon]"))
        XCTAssertEqual(AdminCopy.changeCount(plan), "9 change(s) planned.")
        // a plan with errors is only its errors (the server sends the rest empty)
        let refusedPlan = AdminMergePlan(["target": "Alan", "sources": ["jon"], "errors": ["Source \"jon\" is an admin."]])
        XCTAssertEqual(refusedPlan.errors.count, 1)
        XCTAssertEqual(AdminCopy.previewReady(refusedPlan), "The merge cannot be done: see the errors.")
        XCTAssertEqual(AdminCopy.changeCount(refusedPlan), "Nothing to do. This merge is already complete.")
        XCTAssertEqual(AdminDuplicate.groups([[["username": "Alan", "gamesPlayed": 30, "botGamesPlayed": 2], ["username": "alan2"]], "junk"]).map { $0.map(\.username) },
                       [["Alan", "alan2"]])
    }

    // MARK: - Players sort and filter (client/src/ui/screens/adminPlayers.js)

    func testSortAndFilterFollowTheWebTable() {
        let list = AdminPlayer.list([
            Self.playerRow("bob", created: "2026-11-03T00:00:00.000Z", seen: "2026-11-05T00:00:00.000Z", games: 5, bot: 1),
            Self.playerRow("Amy", created: "2026-11-01T00:00:00.000Z", online: true, games: 9, admin: true),
            Self.playerRow("cat", created: "2026-11-02T00:00:00.000Z", seen: "2026-11-09T00:00:00.000Z", games: 5),
            Self.playerRow("old", created: "2026-10-01T00:00:00.000Z", into: "Amy"),
            Self.playerRow("dan", created: nil, games: 0),
        ])
        func order(_ c: AdminPlayerColumn, _ asc: Bool) -> [String] { AdminPlayerSort(column: c, ascending: asc).sorted(list).map(\.username) }

        XCTAssertEqual(AdminPlayerSort.newestFirst.sorted(list).map(\.username), ["bob", "cat", "Amy", "old", "dan"], "newest first; no date last")
        XCTAssertEqual(order(.createdAt, true), ["old", "Amy", "cat", "bob", "dan"], "no date is last in either direction")
        XCTAssertEqual(order(.username, true), ["Amy", "bob", "cat", "dan", "old"], "names ignore case")
        XCTAssertEqual(order(.lastSeenAt, false), ["Amy", "cat", "bob", "dan", "old"], "online now is the most recent; never seen last")
        XCTAssertEqual(order(.gamesPlayed, false), ["Amy", "bob", "cat", "dan", "old"], "ties by name; a tombstone has no games (last)")
        XCTAssertEqual(order(.gamesPlayed, true), ["dan", "bob", "cat", "Amy", "old"], "the tombstone stays last ascending too")
        XCTAssertEqual(order(.botGamesPlayed, false).first, "bob")
        XCTAssertEqual(order(.isAdmin, false).first, "Amy")
        XCTAssertEqual(order(.mergedInto, true).first, "old", "tombstones first, the rest by name")

        // the sorted column flips; another column takes its own first direction
        let s = AdminPlayerSort.newestFirst
        XCTAssertEqual(s.choosing(.createdAt), AdminPlayerSort(column: .createdAt, ascending: true))
        XCTAssertEqual(s.choosing(.username), AdminPlayerSort(column: .username, ascending: true))
        XCTAssertEqual(s.choosing(.gamesPlayed), AdminPlayerSort(column: .gamesPlayed, ascending: false))
        XCTAssertEqual(AdminPlayerColumn.allCases.map(\.label), ["Player", "Created", "Last seen", "Games", "Bot games", "Admin", "Merged"])

        XCTAssertEqual(AdminPlayerFilter.apply(list, "  AM ").map(\.username), ["Amy", "old"], "the name, or the account a tombstone points at")
        XCTAssertEqual(AdminPlayerFilter.apply(list, "").count, 5)
        XCTAssertEqual(AdminPlayerFilter.apply(list, "zzz"), [])

        let roster = AdminRoster(players: list, total: 5)
        XCTAssertNil(AdminCopy.capNote(roster))
        XCTAssertEqual(AdminCopy.countLine(shown: 5, roster: roster, query: ""), "5 accounts.")
        XCTAssertEqual(AdminCopy.countLine(shown: 2, roster: roster, query: " am "), "2 of 5 accounts match \"am\".")
        let capped = AdminRoster(players: list, total: 812)
        XCTAssertEqual(AdminCopy.capNote(capped), "Showing the newest 5 of 812 accounts. Sorting and the filter cover only these.")
        XCTAssertEqual(AdminCopy.countLine(shown: 5, roster: capped, query: ""), "5 accounts (of 812).")
        XCTAssertEqual(AdminCopy.listed(1), "1 account listed.")
    }

    // MARK: - Confirmations are as strict as the web's

    func testTypedConfirmationsNeedTheExactName() {
        let spec = AdminCopy.deleteAccountConfirm("Kim Lee")
        XCTAssertEqual(spec.title, "Delete Kim Lee?")
        XCTAssertEqual(spec.confirmLabel, "Delete account")
        XCTAssertEqual(spec.lines.count, 6)
        XCTAssertTrue(spec.isReady("Kim Lee"))
        for wrong in ["", "kim lee", "Kim Lee ", " Kim Lee", "Kim  Lee", "KimLee", "Kim Le"] {
            XCTAssertFalse(spec.isReady(wrong), "\"\(wrong)\"")
        }
        XCTAssertEqual(AdminCopy.deleteOldNameConfirm("kim2", kept: "kim").confirmLabel, "Delete name")
        XCTAssertEqual(AdminCopy.deleteOldNameConfirm("kim2", kept: "kim").expected, "kim2")
        XCTAssertEqual(AdminCopy.freeNameConfirm("ghost", heldUntil: nil).title, "Free the name ghost?")

        // rename: a new name, different from the old one, typed twice (the first field is trimmed, the second is not)
        XCTAssertTrue(AdminCopy.renameReady(old: "alan2", newName: "Alan T", again: "Alan T"))
        XCTAssertTrue(AdminCopy.renameReady(old: "alan2", newName: " Alan T ", again: "Alan T"))
        XCTAssertFalse(AdminCopy.renameReady(old: "alan2", newName: "Alan T", again: "Alan T "))
        XCTAssertFalse(AdminCopy.renameReady(old: "alan2", newName: "Alan T", again: "alan t"))
        XCTAssertFalse(AdminCopy.renameReady(old: "alan2", newName: "alan2", again: "alan2"), "the same name")
        XCTAssertFalse(AdminCopy.renameReady(old: "alan2", newName: "  ", again: ""))
        XCTAssertEqual(AdminCopy.renameLines("alan2").count, 3)

        XCTAssertEqual(AdminCopy.signOutConfirm("kim"), AdminConfirm(
            title: "Sign kim out everywhere?",
            text: "Every device kim is signed in on goes back to the sign-in screen, including a game in progress (it continues without them until they sign in again).",
            confirmLabel: "Sign out everywhere"))
        XCTAssertFalse(AdminCopy.adminConfirm("kim", make: true, isSelf: false).danger)
        XCTAssertEqual(AdminCopy.adminConfirm("ivy", make: false, isSelf: true).text, "You will lose access to this panel at once.")
        XCTAssertEqual(AdminCopy.adminConfirm("jon", make: false, isSelf: false).text, "jon loses access to this panel at once.")
        XCTAssertEqual(AdminCopy.mergeSources(" alan2, AlanB ,, alan2 ,"), ["alan2", "AlanB"])
        XCTAssertEqual(AdminResetLink.url(origin: "https://bab.invalid", token: "abc"), "https://bab.invalid/reset#abc")
        XCTAssertEqual(AdminAction.allCases.count, 13)
    }

    func testAdminTrafficIsRedactedInTheDebugSocketLog() {
        let secret = ["fixture", "link", "value"].joined(separator: "-")
        let line = "Handling event: adminResponse with data: [{\"link\": \"\(secret)\"}]"
        XCTAssertFalse(RedactingSocketLogger.redact(line).contains(secret))
        XCTAssertFalse(RedactingSocketLogger.redact("Emitting: 42[\"adminRequest\",{\"action\":\"listPlayers\"}]").contains("listPlayers"))
    }

    // MARK: - The panel

    func testOpeningLoadsPlayersAndForbiddenClosesAndHidesTheEntry() async {
        let script = Script()
        rosterAnswers(script)
        var lost: [String] = []
        let admin = panel(script) { lost.append($0) }
        await admin.tabOpened(.players)
        XCTAssertEqual(admin.roster?.players.count, 5)
        XCTAssertNil(admin.status, "opening the tab is quiet")
        await admin.loadPlayers()
        XCTAssertEqual(admin.status, .init(text: "5 accounts listed.", kind: .info), "Refresh says the count")

        script.answers = { [unowned self] a, _ in self.refused(a, "forbidden", "Not available.") }
        await admin.tabOpened(.reports)
        XCTAssertFalse(admin.isPresented, "a forbidden answer closes the panel")
        XCTAssertEqual(lost, [AdminCopy.forbiddenToast])
        XCTAssertNil(admin.reports)
    }

    func testNoAnswerAndTheRateLimitAreSaidAndThePanelStaysOpen() async {
        let script = Script()
        let admin = panel(script)
        await admin.loadPlayers()
        XCTAssertEqual(admin.status, .init(text: "No answer from the server. Check the connection and try again.", kind: .error))
        script.answers = { _, _ in .failure(.rateLimited) }
        admin.tab = .admins  // a load's failure is said in its own section
        await admin.loadAdmins()
        XCTAssertEqual(admin.status, .init(text: "Too many admin requests in a minute. Wait a moment and try again.", kind: .error))
        script.answers = { _, _ in .failure(.offline) }
        admin.tab = .audit
        await admin.loadAudit()
        XCTAssertEqual(admin.status?.text, AdminCopy.noAnswer)
        XCTAssertTrue(admin.isPresented)
        XCTAssertEqual(admin.inFlight, 0)
    }

    func testAnAnswerAfterThePanelClosedIsDropped() async {
        let script = Script()
        let admin = AdminState()
        var release: CheckedContinuation<Void, Never>?
        admin.requester = { [unowned self] action, _ in
            await withCheckedContinuation { release = $0 }
            return self.ok(action, ["players": Self.roster, "total": 5])
        }
        _ = script
        admin.open()
        let load = Task { await admin.loadPlayers() }
        await settle { release != nil }
        admin.close()
        release?.resume()
        await load.value
        XCTAssertNil(admin.roster, "the closed panel takes no answer")
        XCTAssertNil(admin.status)
        XCTAssertEqual(admin.inFlight, 0)
    }

    func testResetLinkIsShownOnceAndNeverInAMessage() async {
        let script = Script()
        let token = String(String(repeating: "unit-", count: 9).prefix(43))
        rosterAnswers(script) { [unowned self] action, args in
            switch action {
            case .createResetLink: return self.ok(action, ["username": args["username"] ?? "", "token": token, "expiresAt": "2026-11-16T10:00:00.000Z"])
            case .signOutEverywhere: return self.ok(action, ["username": args["username"] ?? "", "revokedSessions": 2, "disconnected": 1])
            default: return nil
            }
        }
        let admin = panel(script)
        await admin.createResetLink("kim")
        XCTAssertEqual(admin.resetLink?.url, "https://bab.invalid/reset#\(token)")
        XCTAssertEqual(admin.resetLink?.username, "kim")
        XCTAssertNotNil(admin.resetLink?.expiresAt)
        XCTAssertEqual(admin.status, .init(text: "Reset link made for kim.", kind: .success))
        XCTAssertFalse(admin.status?.text.contains(token) ?? true, "the secret is never in a status line (VoiceOver reads it aloud)")
        XCTAssertEqual(script.last(.createResetLink) as? [String: String], ["username": "kim"])

        // signing that player out cancels the link on the server: the sheet's link goes
        await admin.signOutEverywhere("kim")
        XCTAssertNil(admin.resetLink)
        XCTAssertEqual(admin.status?.text, "kim is signed out: 2 saved session(s) revoked, 1 live connection(s) closed.")
        XCTAssertEqual(script.count(.listPlayers), 1, "the list reloads after the action")

        await admin.createResetLink("kim")
        XCTAssertNotNil(admin.resetLink)
        admin.close()
        XCTAssertNil(admin.resetLink, "closing the panel forgets the link")
    }

    func testRemovingMyOwnAdminClosesThePanelAndOthersReload() async {
        let script = Script()
        rosterAnswers(script) { [unowned self] action, args in
            action == .setAdmin ? self.ok(action, ["username": args["username"] ?? "", "isAdmin": args["isAdmin"] ?? false, "changed": true]) : nil
        }
        var lost: [String] = []
        let admin = panel(script) { lost.append($0) }
        await admin.setAdmin("kim", true)
        XCTAssertEqual(admin.status, .init(text: "kim is now an admin.", kind: .success))
        XCTAssertEqual(script.last(.setAdmin)?["isAdmin"] as? Bool, true)
        XCTAssertEqual(script.count(.listPlayers), 1)
        XCTAssertTrue(admin.isPresented)

        await admin.setAdmin("jon", false)
        XCTAssertEqual(admin.status?.text, "jon is no longer an admin.")
        XCTAssertTrue(lost.isEmpty)

        await admin.setAdmin("ivy", false)
        XCTAssertFalse(admin.isPresented, "removing my own admin closes the panel")
        XCTAssertEqual(lost, ["You are no longer an admin."])
    }

    func testTheLastAdminRefusalIsShown() async {
        let script = Script()
        script.answers = { [unowned self] a, _ in self.refused(a, "last_admin", "\"ivy\" is the only admin. Make someone else an admin first.") }
        var lost: [String] = []
        let admin = panel(script) { lost.append($0) }
        await admin.setAdmin("ivy", false)
        XCTAssertTrue(admin.isPresented)
        XCTAssertTrue(lost.isEmpty)
        XCTAssertEqual(admin.status, .init(text: "\"ivy\" is the only admin. Make someone else an admin first.", kind: .error))
    }

    func testDeleteGuardsAndTypedSubmit() async {
        let script = Script()
        rosterAnswers(script) { [unowned self] action, args in
            guard action == .deleteAccount else { return nil }
            let name = args["username"] as? String ?? ""
            if name == "kim" { return self.refused(action, "refused", "\"kim\" is in a game right now. Wait until it finishes and delete again.") }
            let tomb = name == "kim2" || name == "ghost"
            return self.ok(action, ["username": name, "kind": tomb ? "tombstone" : "account", "mergedInto": tomb ? "kim" : NSNull() as Any,
                                    "gameRecords": 7, "reports": 1, "signedOut": 2])
        }
        let admin = panel(script)
        await admin.loadPlayers(quiet: true)
        let players = admin.roster!.players
        func p(_ name: String) -> AdminPlayer { players.first { $0.username == name }! }

        // my own account and an admin: refused here, nothing to type, nothing sent
        XCTAssertNil(admin.deletePrompt(p("ivy")))
        XCTAssertEqual(admin.status, .init(text: AdminCopy.deleteSelfRefusal, kind: .error))
        XCTAssertNil(admin.deletePrompt(p("jon")))
        XCTAssertEqual(admin.status?.text, "jon is an admin. Remove their admin first, then delete the account.")
        XCTAssertEqual(script.count(.deleteAccount), 0)

        // a refusal goes back to the sheet (quiet: no stale error behind it)
        admin.say("")
        XCTAssertEqual(admin.deletePrompt(p("kim"))?.expected, "kim")
        let res = await admin.submitDelete(p("kim"), typed: "kim")
        XCTAssertEqual(res?.ok, false)
        XCTAssertEqual(res?.message, "\"kim\" is in a game right now. Wait until it finishes and delete again.")
        XCTAssertNil(admin.status, "the refusal is the sheet's to show")
        XCTAssertEqual(script.last(.deleteAccount) as? [String: String], ["username": "kim", "confirm": "kim"])

        // a tombstone and a held name use the same action, with their own words
        XCTAssertEqual(admin.deletePrompt(p("kim2"))?.title, "Delete the old name kim2?")
        _ = await admin.submitDelete(p("kim2"), typed: "kim2")
        XCTAssertEqual(admin.status, .init(text: "The old name kim2 is deleted and free again. kim is unchanged.", kind: .success))
        XCTAssertEqual(admin.deletePrompt(p("ghost"))?.confirmLabel, "Free name")
        _ = await admin.submitDelete(p("ghost"), typed: "ghost")
        XCTAssertEqual(admin.status?.text, "The name ghost is free again.")
        // behind the closing sheet: the sheet has its answer before the list reloads
        await settle { script.count(.listPlayers) == 3 }
        XCTAssertEqual(script.count(.listPlayers), 3, "one load, then one reload per success")
    }

    func testRenameRefusalsAndAPartialRename() async {
        let script = Script()
        var mode = "taken"
        rosterAnswers(script) { [unowned self] action, args in
            guard action == .renameAccount else { return nil }
            switch mode {
            case "taken": return self.refused(action, "refused", "That name is taken.")
            case "partial": return self.refused(action, "server", "\"kim\" is now called \"Kim L\" (signed out everywhere), but updating its games stopped partway.")
            default: return self.ok(action, ["username": args["username"] ?? "", "newName": args["newName"] ?? "", "resumed": mode == "finish",
                                             "oldNameKept": true, "gameRecords": 4, "reports": 1, "otherUsersBlocks": 2, "signedOut": 1])
            }
        }
        let admin = panel(script)
        await admin.loadPlayers(quiet: true)
        let kim = admin.roster!.players.first { $0.username == "kim" }!
        let me = admin.roster!.players.first { $0.username == "ivy" }!

        XCTAssertFalse(admin.canRename(me), "my own account: refused before the sheet")
        XCTAssertEqual(admin.status, .init(text: AdminCopy.renameSelfRefusal, kind: .error))
        XCTAssertTrue(admin.canRename(kim))

        let taken = await admin.submitRename(kim, newName: "jon", confirm: "jon")
        XCTAssertEqual(taken?.message, "That name is taken.")
        await admin.renameSheetClosed()
        XCTAssertEqual(script.count(.listPlayers), 1, "a plain refusal changed nothing: no reload")

        mode = "partial"
        let partial = await admin.submitRename(kim, newName: "Kim L", confirm: "Kim L")
        XCTAssertEqual(partial?.error, "server")
        await admin.renameSheetClosed()
        XCTAssertEqual(script.count(.listPlayers), 2, "a rename that stopped partway changed the list: reload when the sheet closes")
        await admin.renameSheetClosed()
        XCTAssertEqual(script.count(.listPlayers), 2, "once")

        mode = "ok"
        let done = await admin.submitRename(kim, newName: "Kim L", confirm: "Kim L")
        XCTAssertEqual(done?.ok, true)
        XCTAssertEqual(script.last(.renameAccount) as? [String: String], ["username": "kim", "newName": "Kim L", "confirm": "Kim L"])
        XCTAssertEqual(admin.status, .init(text: "kim is now called Kim L: 1 live connection(s) signed out; they sign in again as Kim L with the same password.", kind: .success))

        // Finish rename sends the same rename again: the old name, to the row's name
        mode = "finish"
        let max = AdminPlayer(Self.playerRow("max", unfinished: "maxx"))!
        await admin.finishRename(max)
        XCTAssertEqual(script.last(.renameAccount) as? [String: String], ["username": "maxx", "newName": "max", "confirm": "max"])
        XCTAssertEqual(admin.status?.text, "The rename of maxx to max is finished: 4 game record update(s), 1 report field(s), 2 block list(s) moved.")
    }

    func testReportsAndAuditPaging() async {
        let script = Script()
        script.answers = { [unowned self] action, args in
            switch action {
            case .listReports:
                return self.ok(action, ["reports": [["id": "r1", "reporter": "kim", "reported": "hal", "reason": "x", "status": "open"]]])
            case .resolveReport: return self.ok(action, ["report": ["id": "r1", "status": args["status"] ?? ""]])
            case .listAudit:
                let page2 = args["beforeId"] != nil
                return self.ok(action, ["entries": [["id": page2 ? "e2" : "e1", "at": page2 ? "2026-11-09T00:00:00.000Z" : "2026-11-10T00:00:00.000Z",
                                                     "action": "setAdmin", "result": "ok"]], "hasMore": !page2])
            default: return .failure(.timeout)
            }
        }
        let admin = panel(script)
        await admin.tabOpened(.reports)
        XCTAssertEqual(script.last(.listReports) as? [String: String], ["status": "open"])
        admin.reportFilter = .all
        await admin.loadReports()
        XCTAssertEqual(script.last(.listReports) as? [String: String], ["status": "all"])
        await admin.closeReport(admin.reports![0], as: "dismissed", note: "  " + String(repeating: "n", count: 600) + "  ")
        let sent = script.last(.resolveReport)
        XCTAssertEqual(sent?["id"] as? String, "r1")
        XCTAssertEqual(sent?["status"] as? String, "dismissed")
        XCTAssertEqual((sent?["note"] as? String)?.count, 500, "the server's limit")
        XCTAssertEqual(admin.status, .init(text: "Report dismissed.", kind: .success))
        XCTAssertEqual(script.count(.listReports), 3, "the list reloads")

        admin.showPlayer("hal")
        XCTAssertEqual(admin.tab, .players)
        XCTAssertEqual(admin.playerFilter, "hal")

        await admin.loadAudit()
        XCTAssertEqual(script.last(.listAudit)?["limit"] as? Int, 50)
        XCTAssertNil(script.last(.listAudit)?["before"])
        XCTAssertTrue(admin.auditHasMore)
        await admin.loadAudit(append: true)
        XCTAssertEqual(script.last(.listAudit)?["before"] as? String, "2026-11-10T00:00:00.000Z", "the cursor: the oldest row's time as sent")
        XCTAssertEqual(script.last(.listAudit)?["beforeId"] as? String, "e1")
        XCTAssertEqual(admin.audit?.map(\.id), ["e1", "e2"])
        XCTAssertFalse(admin.auditHasMore)
        await admin.loadAudit()
        XCTAssertEqual(admin.audit?.map(\.id), ["e1"], "Refresh starts over")
    }

    func testMergePreviewApplyAndStalePlan() async {
        let script = Script()
        let hash = String(repeating: "0f", count: 32)
        var applyAnswer = "stale"
        script.answers = { [unowned self] action, args in
            switch action {
            case .findDuplicates:
                return self.ok(action, ["groups": [[["username": "Alan", "gamesPlayed": 30, "botGamesPlayed": 2],
                                                    ["username": "alan2", "gamesPlayed": 4, "botGamesPlayed": 0],
                                                    ["username": "AlanB", "gamesPlayed": 1, "botGamesPlayed": 1]]]])
            case .planMerge:
                return self.ok(action, ["plan": ["target": args["target"] ?? "", "sources": args["sources"] ?? [], "errors": [String](),
                                                 "retire": args["sources"] ?? [], "changeCount": 7], "planHash": hash])
            case .applyMerge:
                if applyAnswer == "stale" {
                    return self.refused(action, "stale_plan", "These accounts changed since the preview. Preview again before merging.")
                }
                return self.ok(action, ["result": ["target": "Alan", "statsMerged": ["alan2"], "retired": ["alan2", "AlanB"], "gameRecords": 5,
                                                   "reports": 1, "otherUsersBlocks": 1, "signedOut": 2]])
            default: return .failure(.timeout)
            }
        }
        let admin = panel(script)

        await admin.previewMerge()
        XCTAssertEqual(admin.status, .init(text: AdminCopy.mergeNamesNeeded, kind: .error), "both names are needed")
        XCTAssertEqual(script.count(.planMerge), 0)

        await admin.findDuplicates()
        XCTAssertEqual(admin.status?.text, "1 group(s) of look-alike names.")
        XCTAssertEqual(AdminCopy.duplicateLine(admin.duplicates![0]), "Alan (30 games, 2 bot), alan2 (4 games, 0 bot), AlanB (1 games, 1 bot)")
        admin.use(admin.duplicates![0])
        XCTAssertEqual(admin.mergeKeep, "Alan")
        XCTAssertEqual(admin.mergeSources, "alan2, AlanB")

        await admin.previewMerge()
        XCTAssertEqual(script.last(.planMerge)?["target"] as? String, "Alan")
        XCTAssertEqual(script.last(.planMerge)?["sources"] as? [String], ["alan2", "AlanB"])
        XCTAssertEqual(admin.plan?.changeCount, 7)
        XCTAssertEqual(admin.status, .init(text: "Preview ready: 7 change(s).", kind: .info))

        // the kept name must be typed exactly: anything else sends nothing
        await admin.applyMerge(typed: "alan")
        await admin.applyMerge(typed: "Alan ")
        XCTAssertEqual(script.count(.applyMerge), 0)

        // editing a name spends the preview
        admin.mergeSources = "alan2"
        XCTAssertNil(admin.plan)
        XCTAssertFalse(admin.hasPreview)
        XCTAssertEqual(admin.planNote, "The names changed: preview again.")
        await admin.applyMerge(typed: "Alan")
        XCTAssertEqual(script.count(.applyMerge), 0, "no preview, no merge")

        // stale plan: the preview is thrown away with the server's message
        admin.mergeSources = "alan2, AlanB"
        await admin.previewMerge()
        await admin.applyMerge(typed: "Alan")
        let sent = script.last(.applyMerge)
        XCTAssertEqual(sent?["planHash"] as? String, hash, "exactly the previewed plan's hash")
        XCTAssertEqual(sent?["confirm"] as? String, "Alan")
        XCTAssertEqual(sent?["target"] as? String, "Alan")
        XCTAssertEqual(sent?["sources"] as? [String], ["alan2", "AlanB"])
        XCTAssertNil(admin.plan)
        XCTAssertFalse(admin.hasPreview)
        XCTAssertEqual(admin.planNote, "These accounts changed since the preview. Preview again before merging.")
        XCTAssertEqual(admin.status?.kind, .error)
        XCTAssertNil(admin.mergeResult)

        // preview again, then it goes through
        applyAnswer = "ok"
        await admin.previewMerge()
        await admin.applyMerge(typed: "Alan")
        XCTAssertEqual(admin.mergeResult?.retired, ["alan2", "AlanB"])
        XCTAssertEqual(admin.status, .init(text: "Merged into Alan.", kind: .success))
        XCTAssertNil(admin.plan)
        XCTAssertNil(admin.duplicates, "the groups predate the merge")
        XCTAssertEqual(AdminCopy.mergedLines(admin.mergeResult!), [
            "Kept: Alan", "Stats merged from: alan2", "Retired: alan2, AlanB",
            "Game records: 5, reports: 1, other block lists: 1", "Signed out: 2 live connection(s)",
        ])
        await admin.applyMerge(typed: "Alan")
        XCTAssertEqual(script.count(.applyMerge), 2, "a spent preview cannot be applied again")
    }

    func testAPlanWithErrorsOffersNothingToApply() async {
        let script = Script()
        script.answers = { [unowned self] action, _ in
            self.ok(action, ["plan": ["target": "Alan", "sources": ["jon"], "errors": ["Source \"jon\" is an admin. Remove their admin first."],
                                      "changeCount": 0], "planHash": String(repeating: "0f", count: 32)])
        }
        let admin = panel(script)
        admin.mergeKeep = "Alan"
        admin.mergeSources = "jon"
        await admin.previewMerge()
        XCTAssertEqual(admin.status, .init(text: "The merge cannot be done: see the errors.", kind: .error))
        XCTAssertEqual(admin.plan?.errors.count, 1)
    }

    func testOpeningAgainStartsFresh() async {
        let script = Script()
        rosterAnswers(script)
        let admin = panel(script)
        await admin.loadPlayers()
        admin.playerFilter = "kim"
        admin.tab = .audit
        admin.mergeKeep = "Alan"
        admin.close()
        // closing forgets, not only the next opening: nothing stays behind a closed panel
        XCTAssertNil(admin.roster)
        XCTAssertEqual(admin.playerFilter, "")
        XCTAssertEqual(admin.mergeKeep, "")
        XCTAssertNil(admin.status)
        admin.open()
        XCTAssertNil(admin.roster)
        XCTAssertEqual(admin.playerFilter, "")
        XCTAssertEqual(admin.tab, .players)
        XCTAssertEqual(admin.mergeKeep, "")
        XCTAssertNil(admin.status)
        XCTAssertNil(admin.planNote, "clearing the names of a closed panel is not 'the names changed'")
    }
}

private extension Result {
    var failure: Failure? {
        if case .failure(let f) = self { return f }
        return nil
    }
}
