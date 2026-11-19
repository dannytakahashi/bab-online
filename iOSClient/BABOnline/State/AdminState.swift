import Foundation
import Combine
import UIKit

/// The admin panel (iOS 1.2.2; the web's client/src/ui/screens/AdminPanel.js): what each
/// section shows and every action, over `AdminApi`. The Account sheet's Admin entry shows
/// only while `AuthState.isAdmin` (display only: the server authorizes every request from
/// the database). A `forbidden` answer, or removing one's own admin, closes the panel and
/// hides the entry (`accessLost`). One status line says the last result or error, as the
/// web's does; a refusal of a typed confirmation stays in its own sheet (`quiet`).
///
/// Opened fresh every time (`open`), and emptied when it closes (`close`: the accounts,
/// reports, audit rows and merge plan do not stay in memory behind a closed panel or a
/// signed-out app). An answer that lands after the panel closed is dropped (`session`).
@MainActor
final class AdminState: ObservableObject {
    /// The app's panel (MainRoomView presents it, ContentView closes it off the main room).
    static let shared = AdminState()

    struct Status: Equatable {
        enum Kind { case info, success, error }
        let text: String
        let kind: Kind
    }

    enum ReportFilter: String, CaseIterable, Identifiable {
        case open, all
        var id: String { rawValue }
        var title: String { self == .open ? "Open" : "All" }
    }

    @Published var isPresented = false
    @Published var tab: AdminTab = .players
    @Published private(set) var status: Status?
    /// Requests waiting for their answer (the panel shows a spinner).
    @Published private(set) var inFlight = 0
    /// Requests that change something (or make a reset link) and still wait: the panel
    /// cannot be closed by hand meanwhile, so their result is not lost unseen.
    @Published private(set) var changing = 0

    // Players
    @Published private(set) var roster: AdminRoster?
    @Published var playerFilter = ""
    @Published var playerSort = AdminPlayerSort.newestFirst
    /// The one-time link on screen, in memory only; nil as soon as its sheet closes.
    @Published var resetLink: AdminResetLink?
    /// A createResetLink waits for its answer: the rows' menus and the other dialogs wait
    /// too, so the link's sheet (AdminPanelView, over any section) can always come up. The
    /// server has already cancelled the player's earlier link by then.
    @Published private(set) var makingLink = false
    /// The app is not in front: the link's sheet covers the link (the app switcher's
    /// snapshot). Set from UIKit's notifications, which arrive before the snapshot.
    @Published private(set) var linkCovered = false

    // Reports
    @Published var reportFilter: ReportFilter = .open
    @Published private(set) var reports: [AdminReport]?
    /// Reports whose Resolve / Dismiss waits for its answer (their buttons are off).
    @Published private(set) var closingReports: Set<String> = []

    // Admins
    @Published private(set) var admins: [AdminRoleEntry]?

    // Audit
    @Published private(set) var audit: [AdminAuditEntry]?
    @Published private(set) var auditHasMore = false
    private var loadingAudit = false

    // Merge
    @Published var mergeKeep = "" { didSet { if mergeKeep != oldValue { mergeNamesChanged() } } }
    @Published var mergeSources = "" { didSet { if mergeSources != oldValue { mergeNamesChanged() } } }
    @Published private(set) var duplicates: [[AdminDuplicate]]?
    @Published private(set) var plan: AdminMergePlan?
    /// A line in place of the plan (the names changed, a stale or partly applied merge).
    @Published private(set) var planNote: String?
    @Published private(set) var mergeResult: AdminMergeResult?
    /// An applyMerge waits for its answer: no second one, and the names stay as previewed.
    @Published private(set) var applyingMerge = false
    /// What the preview on screen was made from: applyMerge sends exactly this back.
    private var preview: (target: String, sources: [String], planHash: String)?

    // MARK: Wiring

    let api: AdminApi
    /// One request (AdminApi; UI fixtures and tests answer it themselves).
    var requester: (AdminAction, [String: Any]) async -> AdminApi.Outcome = { _, _ in .failure(.offline) }
    /// The signed-in name ("you", the self checks).
    var username: () -> String = { "" }
    /// Admin access is gone: hide the entry and say `message` (a toast).
    var accessLost: (String) -> Void = { _ in }
    /// The reset link's origin (the server this app talks to).
    var origin: () -> String = { ServerConfig.baseURL }
    /// `AuthState.isAdmin`: the panel does not open without it (display only, as the entry).
    var isAdmin: () -> Bool = { true }

    private var session = 0
    /// Opened and not yet emptied by `close`.
    private var live = false
    private var renameStoppedPartway = false
    private var subscriptions: Set<AnyCancellable> = []
    private var appPhase: Set<AnyCancellable> = []

    init(api: AdminApi? = nil, notifications: NotificationCenter = .default) {
        self.api = api ?? AdminApi()
        // UIKit posts these on the main thread, before the app switcher's snapshot is taken
        // (scenePhase read inside a sheet can lag behind it)
        for (name, covered) in [(UIApplication.willResignActiveNotification, true), (UIApplication.didBecomeActiveNotification, false)] {
            notifications.publisher(for: name).sink { [weak self] _ in
                MainActor.assumeIsolated { self?.linkCovered = covered }
            }.store(in: &appPhase)
        }
    }

    /// The live wiring (BABOnlineApp): requests go out on the app's socket only while it is
    /// connected and signed in; the request limit's serverError and a lost connection fail
    /// what waits.
    func attach(socket: SocketService, auth: AuthState) {
        api.send = { [weak socket] payload in
            guard let socket, socket.isConnected, socket.canSendMainRoomActions else { return false }
            socket.emit(SocketEvents.Client.adminRequest, payload)
            return true
        }
        let api = api
        requester = { action, args in await api.request(action, args) }
        username = { [weak auth] in auth?.username ?? "" }
        isAdmin = { [weak auth] in auth?.isAdmin ?? false }
        accessLost = { [weak auth, weak socket] message in
            auth?.isAdmin = false
            socket?.serverError = ServerErrorNotice(message: message, kind: AdminCopy.toastKind(message))
        }
        socket.claimAdminServerError = { dict in api.handleServerError(dict) }
        subscriptions.removeAll()
        socket.$isConnected.removeDuplicates().sink { connected in
            if !connected { Task { @MainActor in api.connectionLost() } }
        }.store(in: &subscriptions)
        // The account changed under the panel (sign-out, forceLogout, another sign-in on the
        // same connection): close at once, here and not only from a view's onChange, so no
        // answer to the earlier account's request is taken for the next one.
        auth.$isAdmin.removeDuplicates().sink { [weak self] on in
            if !on { self?.close() }
        }.store(in: &subscriptions)
        auth.$username.removeDuplicates().dropFirst().sink { [weak self] _ in
            self?.close()
        }.store(in: &subscriptions)
    }

    // MARK: Open / close

    /// Nothing happens for an account without the flag (it dropped while the Account sheet
    /// was closing).
    func open() {
        guard isAdmin() else { return }
        reset()
        live = true
        isPresented = true
    }

    /// Sign-out, admin removed, leaving the main room, or the sheet dismissed: what waits
    /// is dropped and everything the panel held is forgotten.
    func close() {
        guard live || isPresented || resetLink != nil || api.pendingCount > 0 else { return }
        reset()
        live = false
        isPresented = false
        api.closeAll()
    }

    private func reset() {
        session += 1
        tab = .players
        status = nil
        roster = nil
        playerFilter = ""
        playerSort = .newestFirst
        resetLink = nil
        makingLink = false
        reportFilter = .open
        reports = nil
        closingReports = []
        admins = nil
        audit = nil
        auditHasMore = false
        loadingAudit = false
        preview = nil
        mergeKeep = ""
        mergeSources = ""
        duplicates = nil
        plan = nil
        planNote = nil
        mergeResult = nil
        applyingMerge = false
        renameStoppedPartway = false
    }

    private func loseAccess(_ message: String) {
        close()
        accessLost(message)
    }

    func say(_ text: String, _ kind: Status.Kind = .info) {
        status = text.isEmpty ? nil : Status(text: text, kind: kind)
    }

    /// One request. nil: no answer (said in the status line), the panel closed meanwhile,
    /// or `forbidden` (the panel closes). `quiet`: a refusal is left to the caller's own
    /// sheet, with no stale error behind it. `section`: a list load's failure is said only
    /// while its section is still the one on screen (the line belongs to the section shown).
    func call(_ action: AdminAction, _ args: [String: Any] = [:], quiet: Bool = false, section: AdminTab? = nil) async -> AdminResponse? {
        let mine = session
        let changes = action.changesSomething
        inFlight += 1
        if changes { changing += 1 }
        let outcome = await requester(action, args)
        inFlight -= 1
        if changes { changing -= 1 }
        guard mine == session, isPresented else { return nil }
        let shown = section == nil || section == tab
        switch outcome {
        case .failure(let why):
            if shown { say(AdminCopy.noAnswer(why), .error) }
            return nil
        case .success(let res):
            if res.isForbidden {
                loseAccess(AdminCopy.forbiddenToast)
                return nil
            }
            if !res.ok && !quiet && shown { say(res.message, .error) }
            return res
        }
    }

    /// A list reload after an action that worked: when the reload fails, the action's
    /// message stays and says so (not "No answer…" alone, which reads as the action failing).
    private func reload(_ load: () async -> Void) async {
        let done = status
        await load()
        guard let done, done.kind == .success, let now = status, now.kind == .error else { return }
        status = Status(text: done.text + " " + AdminCopy.listNotRefreshed, kind: .success)
    }

    /// The same, not waited for: the sheet that asked gets its answer first.
    private func reloadPlayersBehind() {
        let mine = session
        Task { [weak self] in
            guard let self, mine == self.session else { return }
            await self.reload { await self.loadPlayers(quiet: true) }
        }
    }

    /// A section came on screen: the last message belonged to the other one, and it loads.
    func tabOpened(_ tab: AdminTab) async {
        status = nil
        switch tab {
        case .players: await loadPlayers(quiet: true)
        case .reports: await loadReports()
        case .admins: await loadAdmins()
        case .audit: await loadAudit()
        case .merge: break
        }
    }

    // MARK: Players

    func isSelf(_ name: String) -> Bool { name == username() }

    /// The rows on screen: filtered, then sorted.
    var shownPlayers: [AdminPlayer] {
        guard let roster else { return [] }
        return playerSort.sorted(AdminPlayerFilter.apply(roster.players, playerFilter))
    }

    /// `quiet`: a refresh after an action keeps that action's message.
    func loadPlayers(quiet: Bool = false) async {
        guard let res = await call(.listPlayers, section: .players), res.ok else { return }
        let list = AdminPlayer.list(res.body["players"])
        let total = StatsWire.int(res.body["total"]).flatMap { $0 > 0 ? $0 : nil } ?? list.count
        roster = AdminRoster(players: list, total: total)
        if !quiet { say(AdminCopy.listed(list.count)) }
    }

    /// Show `name` in the list (a tombstone's kept account, a reported player).
    func showPlayer(_ name: String) {
        playerFilter = name
        tab = .players
    }

    /// A delete, rename or sign out everywhere cancels that player's open links.
    private func dropLink(of user: String) {
        if resetLink?.username == user { resetLink = nil }
    }

    func createResetLink(_ user: String) async {
        guard !makingLink else { return }
        let mine = session
        makingLink = true
        let answer = await call(.createResetLink, ["username": user])
        if mine == session { makingLink = false }
        guard let res = answer, res.ok else { return }
        let token = res.string("token")
        guard !token.isEmpty else { return say("The server sent no link. Try again.", .error) }
        let name = res.body["username"] as? String ?? user
        resetLink = AdminResetLink(username: name, url: AdminResetLink.url(origin: origin(), token: token),
                                   expiresAt: AdminDates.parse(res.body["expiresAt"]))
        say(AdminCopy.resetLinkMade(name), .success)
    }

    func signOutEverywhere(_ user: String) async {
        guard let res = await call(.signOutEverywhere, ["username": user]), res.ok else { return }
        let name = res.body["username"] as? String ?? user
        dropLink(of: name)
        say(AdminCopy.signedOut(name, revoked: res.int("revokedSessions"), disconnected: res.int("disconnected")), .success)
        await reload { await loadPlayers(quiet: true) }
    }

    /// Make or remove an admin. Removing oneself closes the panel and hides the entry.
    func setAdmin(_ user: String, _ on: Bool) async {
        let mine = isSelf(user)
        guard let res = await call(.setAdmin, ["username": user, "isAdmin": on]), res.ok else { return }
        say(AdminCopy.adminChanged(user, on: on), .success)
        if !on && mine {
            loseAccess(AdminCopy.noLongerAdmin)
            return
        }
        await reload { if tab == .admins { await loadAdmins() } else { await loadPlayers(quiet: true) } }
    }

    /// A rename that stopped partway: the same rename again finishes it (server: resumed).
    func finishRename(_ p: AdminPlayer) async {
        guard let from = p.renameUnfinished else { return }
        guard let res = await call(.renameAccount, ["username": from, "newName": p.username, "confirm": p.username]),
              res.ok else { return }
        say(AdminCopy.renameFinished(from: from, to: p.username, res), .success)
        await reload { await loadPlayers(quiet: true) }
    }

    /// false, with the reason in the status line: the server refuses renaming one's own
    /// account too (every device of it, this one included, is signed out before the answer).
    func canRename(_ p: AdminPlayer) -> Bool {
        if isSelf(p.username) {
            say(AdminCopy.renameSelfRefusal, .error)
            return false
        }
        renameStoppedPartway = false
        return true
    }

    /// The rename sheet's submit. ok: said here, and the list reloads behind the closing
    /// sheet; a refusal goes back to the sheet.
    func submitRename(_ p: AdminPlayer, newName: String, confirm: String) async -> AdminResponse? {
        let res = await call(.renameAccount, ["username": p.username, "newName": newName, "confirm": confirm], quiet: true)
        guard let res else { return nil }
        guard res.ok else {
            if res.error == "server" { renameStoppedPartway = true }
            return res
        }
        dropLink(of: res.string("username"))
        say(AdminCopy.renamed(res), .success)
        reloadPlayersBehind()
        return res
    }

    /// The rename sheet closed: a rename that stopped partway changed the list (its row now
    /// offers Finish rename) even though the sheet was cancelled.
    func renameSheetClosed() async {
        guard renameStoppedPartway else { return }
        renameStoppedPartway = false
        await loadPlayers(quiet: true)
    }

    /// What to type before deleting `p`; nil, with the reason in the status line, when the
    /// server would refuse anyway (saying so here spares typing the name).
    func deletePrompt(_ p: AdminPlayer) -> AdminTypedConfirm? {
        if let kept = p.mergedInto {
            return p.isHeldName ? AdminCopy.freeNameConfirm(p.username, heldUntil: p.heldUntil)
                : AdminCopy.deleteOldNameConfirm(p.username, kept: kept)
        }
        if isSelf(p.username) {
            say(AdminCopy.deleteSelfRefusal, .error)
            return nil
        }
        if p.isAdmin {
            say(AdminCopy.deleteAdminRefusal(p.username), .error)
            return nil
        }
        return AdminCopy.deleteAccountConfirm(p.username)
    }

    /// The typed confirmation's submit (an account, an old name or a held name: one action).
    func submitDelete(_ p: AdminPlayer, typed: String) async -> AdminResponse? {
        let res = await call(.deleteAccount, ["username": p.username, "confirm": typed], quiet: true)
        guard let res, res.ok else { return res }
        let name = res.body["username"] as? String ?? p.username
        if p.isHeldName {
            say(AdminCopy.nameFreed(name), .success)
        } else if p.isTombstone {
            say(AdminCopy.oldNameDeleted(res), .success)
        } else {
            dropLink(of: name)
            say(AdminCopy.accountDeleted(res), .success)
        }
        reloadPlayersBehind()
        return res
    }

    // MARK: Reports

    func loadReports() async {
        guard let res = await call(.listReports, ["status": reportFilter.rawValue], section: .reports), res.ok else { return }
        reports = AdminReport.list(res.body["reports"])
    }

    /// Resolve or dismiss an open report (`status`: resolved / dismissed) with an optional note.
    func closeReport(_ r: AdminReport, as status: String, note: String) async {
        guard !closingReports.contains(r.id) else { return }
        let mine = session
        closingReports.insert(r.id)
        let text = AdminCopy.reportNote(note)
        let answer = await call(.resolveReport, ["id": r.id, "status": status, "note": text])
        if mine == session { closingReports.remove(r.id) }
        guard let res = answer, res.ok else { return }
        say(AdminCopy.reportClosed(status), .success)
        await reload { await loadReports() }
    }

    // MARK: Admins

    func loadAdmins() async {
        guard let res = await call(.listAdmins, section: .admins), res.ok else { return }
        admins = AdminRoleEntry.list(res.body["admins"])
    }

    // MARK: Audit

    static let auditPage = 50

    /// The newest page, or (append) the page before the oldest row shown. One at a time (a
    /// second tap on Load more, or a refresh racing it, would add the same page twice), and
    /// a row already listed is never added again: the list's rows are identified by id.
    func loadAudit(append: Bool = false) async {
        guard !loadingAudit else { return }
        var args: [String: Any] = ["limit": Self.auditPage]
        if append {
            // no cursor (a row without its time): asking again would only repeat page one
            guard let oldest = audit?.last, !oldest.atRaw.isEmpty else { return }
            args["before"] = oldest.atRaw
            args["beforeId"] = oldest.id
        }
        let mine = session
        loadingAudit = true
        let answer = await call(.listAudit, args, section: .audit)
        if mine == session { loadingAudit = false }
        guard let res = answer, res.ok else { return }
        var seen = Set(append ? (audit ?? []).map(\.id) : [])
        let entries = AdminAuditEntry.list(res.body["entries"]).filter { seen.insert($0.id).inserted }
        audit = append ? (audit ?? []) + entries : entries
        auditHasMore = res.body["hasMore"] as? Bool ?? false
    }

    // MARK: Merge

    /// Editing either name spends the preview: what was previewed is no longer what is named.
    private func mergeNamesChanged() {
        guard preview != nil, !applyingMerge else { return }
        preview = nil
        plan = nil
        planNote = AdminCopy.mergeNamesChanged
    }

    var hasPreview: Bool { preview != nil }

    func findDuplicates() async {
        guard let res = await call(.findDuplicates), res.ok else { return }
        let groups = AdminDuplicate.groups(res.body["groups"])
        duplicates = groups
        if !groups.isEmpty { say(AdminCopy.duplicateGroups(groups.count)) }
    }

    /// A look-alike group's Use: the first name (most games) is kept, the rest merge into it.
    func use(_ group: [AdminDuplicate]) {
        guard !applyingMerge, let first = group.first else { return }
        preview = nil
        plan = nil
        planNote = nil
        mergeResult = nil
        mergeKeep = first.username
        mergeSources = group.dropFirst().map(\.username).joined(separator: ", ")
    }

    func previewMerge() async {
        guard !applyingMerge else { return }
        let target = mergeKeep.trimmingCharacters(in: .whitespaces)
        let sources = AdminCopy.mergeSources(mergeSources)
        guard !target.isEmpty, !sources.isEmpty else { return say(AdminCopy.mergeNamesNeeded, .error) }
        guard let res = await call(.planMerge, ["target": target, "sources": sources]), res.ok else { return }
        // the names edited while the preview was on its way: it is not theirs
        guard target == mergeKeep.trimmingCharacters(in: .whitespaces), sources == AdminCopy.mergeSources(mergeSources) else { return }
        let view = AdminMergePlan(res.body["plan"])
        preview = (target, sources, res.string("planHash"))
        plan = view
        planNote = nil
        mergeResult = nil
        say(AdminCopy.previewReady(view), view.errors.isEmpty ? .info : .error)
    }

    /// Apply the previewed merge: the plan's hash and the kept name typed exactly. A stale
    /// plan or a server failure spends the preview (the data changed, or the merge may be
    /// partly applied): preview again.
    func applyMerge(typed: String) async {
        guard !applyingMerge, let p = preview, let shown = plan, typed == shown.target else { return }
        let args: [String: Any] = ["target": p.target, "sources": p.sources, "planHash": p.planHash, "confirm": typed]
        let mine = session
        applyingMerge = true
        let answer = await call(.applyMerge, args)
        if mine == session { applyingMerge = false }
        guard let res = answer else { return }
        guard res.ok else {
            if res.error == "stale_plan" || res.error == "server" {
                preview = nil
                plan = nil
                planNote = res.message
            }
            return
        }
        let result = AdminMergeResult(res.body["result"])
        preview = nil
        plan = nil
        planNote = nil
        duplicates = nil  // its groups predate the merge
        mergeResult = result
        say(AdminCopy.merged(result.target), .success)
    }
}
