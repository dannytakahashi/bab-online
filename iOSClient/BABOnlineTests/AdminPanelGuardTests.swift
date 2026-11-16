import XCTest
import UIKit
@testable import BAB_Online

/// The admin panel's guards (iOS 1.2.2), each against a scripted server whose answers can
/// be held back: closing forgets everything, the reset link is covered when the app leaves
/// the front and survives a change of section, one request at a time where two would
/// repeat an action or a page (Load more, Resolve / Dismiss, Merge accounts, Reset link),
/// the panel cannot be closed by hand while a change waits, it does not open without the
/// flag, a load's failure is said only in its own section, and a reload failing after an
/// action that worked keeps the action's message.
@MainActor
final class AdminPanelGuardTests: XCTestCase {
    /// Records every request; answers at once from `answers`, or when `release` is called
    /// for the actions in `held`.
    private final class Server {
        var calls: [(action: AdminAction, args: [String: Any])] = []
        var answers: (AdminAction, [String: Any]) -> AdminApi.Outcome = { _, _ in .failure(.timeout) }
        var held: Set<AdminAction> = []
        private var waiting: [(AdminAction, CheckedContinuation<Void, Never>)] = []

        func count(_ a: AdminAction) -> Int { calls.filter { $0.action == a }.count }
        func waitingCount(_ a: AdminAction) -> Int { waiting.filter { $0.0 == a }.count }

        func answer(_ action: AdminAction, _ args: [String: Any]) async -> AdminApi.Outcome {
            calls.append((action, args))
            if held.contains(action) {
                await withCheckedContinuation { waiting.append((action, $0)) }
            }
            return answers(action, args)
        }

        func release(_ action: AdminAction) {
            let mine = waiting.filter { $0.0 == action }
            waiting.removeAll { $0.0 == action }
            mine.forEach { $0.1.resume() }
        }

        /// Nothing stays held (a test's end: a request a broken guard let through).
        func releaseAll() {
            held = []
            let all = waiting
            waiting = []
            all.forEach { $0.1.resume() }
        }
    }

    /// A second tap: started and given time to reach the server, never waited for (a
    /// guard that let it through would leave it held; the count says so, with no hang).
    private func tap(_ op: @escaping @MainActor () async -> Void) async {
        Task { await op() }
        try? await Task.sleep(nanoseconds: 40_000_000)
    }

    private func settle(until done: () -> Bool) async {
        for _ in 0..<400 {
            if done() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("never settled")
    }

    private func ok(_ action: AdminAction, _ fields: [String: Any] = [:]) -> AdminApi.Outcome {
        .success(AdminResponse(fields.merging(["requestId": "r", "action": action.rawValue, "ok": true]) { a, _ in a }))
    }

    private func row(_ name: String, admin: Bool = false) -> [String: Any] {
        ["username": name, "createdAt": "2026-11-01T10:00:00.000Z", "online": false, "gamesPlayed": 3, "botGamesPlayed": 0, "isAdmin": admin]
    }

    private func audit(_ ids: [String], at: String = "2026-11-10T00:00:00.000Z") -> [[String: Any]] {
        ids.map { ["id": $0, "at": at, "action": "setAdmin", "result": "ok"] }
    }

    private let token = String(String(repeating: "guard-", count: 8).prefix(43))

    /// Players, reports, audit, a plan and a reset link, all answering.
    private func server() -> Server {
        let s = Server()
        s.answers = { [unowned self] action, args in
            switch action {
            case .listPlayers: return self.ok(action, ["players": [self.row("ivy", admin: true), self.row("kim")], "total": 2])
            case .listReports: return self.ok(action, ["reports": [["id": "r1", "reporter": "kim", "reported": "hal", "reason": "x", "status": "open"]]])
            case .listAdmins: return self.ok(action, ["admins": [["username": "ivy"]]])
            case .listAudit: return self.ok(action, ["entries": self.audit(args["beforeId"] == nil ? ["e1", "e2"] : ["e2", "e3"]), "hasMore": args["beforeId"] == nil])
            case .createResetLink: return self.ok(action, ["username": args["username"] ?? "", "token": self.token, "expiresAt": "2026-11-16T10:00:00.000Z"])
            case .planMerge:
                return self.ok(action, ["plan": ["target": args["target"] ?? "", "sources": args["sources"] ?? [], "errors": [String](),
                                                 "retire": args["sources"] ?? [], "changeCount": 3], "planHash": String(repeating: "0f", count: 32)])
            case .applyMerge: return self.ok(action, ["result": ["target": "Alan", "retired": ["alan2"]]])
            case .resolveReport: return self.ok(action, ["report": ["id": "r1", "status": args["status"] ?? ""]])
            case .deleteAccount, .signOutEverywhere, .setAdmin, .renameAccount: return self.ok(action, ["username": args["username"] ?? ""])
            default: return .failure(.timeout)
            }
        }
        return s
    }

    private func panel(_ server: Server, notifications: NotificationCenter = NotificationCenter()) -> AdminState {
        let admin = AdminState(notifications: notifications)
        admin.username = { "ivy" }
        admin.origin = { "https://bab.invalid" }
        admin.requester = { action, args in await server.answer(action, args) }
        admin.open()
        return admin
    }

    // MARK: - Closing forgets

    func testClosingForgetsEverythingThePanelHeld() async {
        let s = server()
        let admin = panel(s)
        await admin.loadPlayers()
        await admin.loadReports()
        await admin.loadAdmins()
        await admin.loadAudit()
        admin.mergeKeep = "Alan"
        admin.mergeSources = "alan2"
        await admin.previewMerge()
        await admin.createResetLink("kim")
        XCTAssertNotNil(admin.roster)
        XCTAssertNotNil(admin.reports)
        XCTAssertNotNil(admin.admins)
        XCTAssertNotNil(admin.audit)
        XCTAssertNotNil(admin.plan)
        XCTAssertNotNil(admin.resetLink)

        admin.close()
        XCTAssertFalse(admin.isPresented)
        XCTAssertNil(admin.roster, "no account list behind a closed panel")
        XCTAssertNil(admin.reports)
        XCTAssertNil(admin.admins)
        XCTAssertNil(admin.audit)
        XCTAssertFalse(admin.auditHasMore)
        XCTAssertNil(admin.plan)
        XCTAssertFalse(admin.hasPreview)
        XCTAssertNil(admin.planNote)
        XCTAssertNil(admin.duplicates)
        XCTAssertNil(admin.resetLink)
        XCTAssertNil(admin.status)
        XCTAssertEqual(admin.mergeKeep, "")
        XCTAssertEqual(admin.mergeSources, "")

        // a sheet swiped away has already cleared isPresented when its onDismiss closes
        admin.open()
        await admin.loadPlayers()
        admin.isPresented = false
        admin.close()
        XCTAssertNil(admin.roster, "the swipe's close forgets too")
    }

    // MARK: - The reset link

    func testTheResetLinkIsCoveredAsSoonAsTheAppLeavesTheFront() async {
        let center = NotificationCenter()
        let admin = panel(server(), notifications: center)
        await admin.createResetLink("kim")
        XCTAssertFalse(admin.linkCovered)
        center.post(name: UIApplication.willResignActiveNotification, object: nil)
        XCTAssertTrue(admin.linkCovered, "set in the notification itself, before the app switcher's snapshot")
        XCTAssertNotNil(admin.resetLink, "covered, not forgotten: it is shown once")
        center.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertFalse(admin.linkCovered)
    }

    func testAResetLinkThatArrivesOnAnotherSectionIsStillShownAndOnlyOneIsMade() async {
        let s = server()
        s.held = [.createResetLink]
        let admin = panel(s)
        let first = Task { await admin.createResetLink("kim") }
        await settle { s.waitingCount(.createResetLink) == 1 }
        XCTAssertTrue(admin.makingLink, "the rows' menus wait: nothing else takes the sheet's place")
        XCTAssertEqual(admin.changing, 1, "the panel cannot be closed by hand meanwhile")
        await tap { await admin.createResetLink("kim") }
        await tap { await admin.createResetLink("ivy") }
        XCTAssertEqual(s.count(.createResetLink), 1, "a second link would cancel the one on its way")

        admin.tab = .audit
        s.release(.createResetLink)
        await first.value
        XCTAssertEqual(admin.resetLink?.url, "https://bab.invalid/reset#\(token)", "kept for the panel's sheet, whatever section shows")
        XCTAssertFalse(admin.makingLink)
        XCTAssertEqual(admin.changing, 0)
        XCTAssertEqual(admin.tab, .audit)
        s.releaseAll()
    }

    // MARK: - One at a time

    func testLoadMoreTwiceAsksOnceAndNeverRepeatsARow() async {
        let s = server()
        let admin = panel(s)
        await admin.loadAudit()
        XCTAssertEqual(admin.audit?.map(\.id), ["e1", "e2"])
        s.held = [.listAudit]
        let a = Task { await admin.loadAudit(append: true) }
        await settle { s.waitingCount(.listAudit) == 1 }
        await tap { await admin.loadAudit(append: true) }  // the second tap
        await tap { await admin.loadAudit() }              // a pull to refresh racing it
        XCTAssertEqual(s.count(.listAudit), 2, "one first page, one Load more")
        s.releaseAll()
        await a.value
        // the page overlaps the rows shown (e2): a row id is never listed twice
        XCTAssertEqual(admin.audit?.map(\.id), ["e1", "e2", "e3"])
        XCTAssertEqual(Set(admin.audit!.map(\.id)).count, admin.audit!.count)
        XCTAssertFalse(admin.auditHasMore)
    }

    func testLoadMoreWithoutACursorAsksNothing() async {
        let s = server()
        s.answers = { [unowned self] action, _ in self.ok(action, ["entries": self.audit(["e1"], at: ""), "hasMore": true]) }
        let admin = panel(s)
        await admin.loadAudit()
        await admin.loadAudit(append: true)
        XCTAssertEqual(s.count(.listAudit), 1, "no time on the oldest row: page one is not asked for again")
        XCTAssertEqual(admin.audit?.map(\.id), ["e1"])
    }

    func testResolveTwiceSendsOnceAndTheNoteIsCappedAsTheServerCounts() async {
        let s = server()
        let admin = panel(s)
        await admin.loadReports()
        let report = admin.reports![0]
        s.held = [.resolveReport]
        let first = Task { await admin.closeReport(report, as: "resolved", note: String(repeating: "😀", count: 400)) }
        await settle { s.waitingCount(.resolveReport) == 1 }
        XCTAssertEqual(admin.closingReports, ["r1"], "its buttons are off")
        await tap { await admin.closeReport(report, as: "dismissed", note: "") }
        XCTAssertEqual(s.count(.resolveReport), 1)
        s.releaseAll()
        await first.value
        XCTAssertTrue(admin.closingReports.isEmpty)
        XCTAssertEqual(admin.status, .init(text: "Report resolved.", kind: .success))
        let note = s.calls.first { $0.action == .resolveReport }?.args["note"] as? String ?? ""
        XCTAssertEqual(note.utf16.count, 500, "500 UTF-16 units, as Joi counts")
        XCTAssertEqual(note.count, 250, "whole characters only")

        XCTAssertEqual(AdminCopy.reportNote("  fine  "), "fine")
        XCTAssertEqual(AdminCopy.reportNote(String(repeating: "n", count: 499) + "😀"), String(repeating: "n", count: 499), "never half a character")
    }

    func testMergeAccountsTwiceSendsOnceAndTheNamesHoldMeanwhile() async {
        let s = server()
        let admin = panel(s)
        admin.mergeKeep = "Alan"
        admin.mergeSources = "alan2"
        await admin.previewMerge()
        s.held = [.applyMerge]
        let first = Task { await admin.applyMerge(typed: "Alan") }
        await settle { s.waitingCount(.applyMerge) == 1 }
        XCTAssertTrue(admin.applyingMerge)
        XCTAssertEqual(admin.changing, 1)
        // the section was left and opened again (the view's own state is gone): still one merge
        admin.tab = .players
        admin.tab = .merge
        await tap { await admin.applyMerge(typed: "Alan") }
        await tap { await admin.previewMerge() }
        XCTAssertEqual(s.count(.applyMerge), 1)
        XCTAssertEqual(s.count(.planMerge), 1)
        XCTAssertNotNil(admin.plan, "the preview stays until the answer")
        s.releaseAll()
        await first.value
        XCTAssertFalse(admin.applyingMerge)
        XCTAssertEqual(admin.status, .init(text: "Merged into Alan.", kind: .success))
        XCTAssertNil(admin.plan)
    }

    // MARK: - Opening

    func testThePanelDoesNotOpenWithoutTheFlag() {
        let admin = AdminState(notifications: NotificationCenter())
        var flag = false
        admin.isAdmin = { flag }
        admin.open()
        XCTAssertFalse(admin.isPresented, "the flag dropped while the Account sheet was closing")
        flag = true
        admin.open()
        XCTAssertTrue(admin.isPresented)
    }

    func testTheAccountChangingUnderThePanelClosesIt() async {
        let auth = AuthState()
        auth.username = "ivy"
        auth.isAdmin = true
        let admin = AdminState(notifications: NotificationCenter())
        admin.attach(socket: SocketService.shared, auth: auth)
        defer { SocketService.shared.claimAdminServerError = nil }
        let s = server()
        admin.requester = { action, args in await s.answer(action, args) }
        admin.open()
        await admin.loadPlayers()
        XCTAssertNotNil(admin.roster)

        // another account on the same connection: the flag never read false in between
        s.held = [.listReports]
        let load = Task { await admin.loadReports() }
        await settle { s.waitingCount(.listReports) == 1 }
        auth.username = "jon"
        XCTAssertFalse(admin.isPresented, "closed by the state itself, not by a view")
        XCTAssertNil(admin.roster)
        admin.open()
        s.release(.listReports)
        await load.value
        XCTAssertNil(admin.reports, "ivy's answer is not jon's")

        auth.isAdmin = false
        XCTAssertFalse(admin.isPresented)
        admin.open()
        XCTAssertFalse(admin.isPresented, "no flag, no panel")
    }

    // MARK: - The status line

    func testALoadFailingAfterItsSectionWasLeftSaysNothingInTheNextOne() async {
        let s = server()
        let admin = panel(s)
        admin.tab = .reports
        s.held = [.listReports]
        s.answers = { _, _ in .failure(.timeout) }
        let load = Task { await admin.loadReports() }
        await settle { s.waitingCount(.listReports) == 1 }
        admin.tab = .merge
        admin.say("Preview ready: 3 change(s).")
        s.release(.listReports)
        await load.value
        XCTAssertEqual(admin.status?.text, "Preview ready: 3 change(s).", "the line belongs to the section on screen")

        // in its own section it is said
        admin.tab = .reports
        s.held = []
        await admin.loadReports()
        XCTAssertEqual(admin.status, .init(text: AdminCopy.noAnswer, kind: .error))
    }

    func testAReloadFailingAfterAnActionThatWorkedKeepsItsMessage() async {
        let s = server()
        let admin = panel(s)
        await admin.loadPlayers()
        let kim = admin.roster!.players.first { $0.username == "kim" }!
        let answers = s.answers
        s.answers = { action, args in action == .listPlayers ? .failure(.timeout) : answers(action, args) }

        s.held = [.listPlayers]
        let res = await admin.submitDelete(kim, typed: "kim")
        XCTAssertEqual(res?.ok, true, "the sheet has its answer while the list is still reloading")
        await settle { s.waitingCount(.listPlayers) == 1 }
        XCTAssertEqual(admin.status?.kind, .success)
        let said = admin.status?.text ?? ""
        s.release(.listPlayers)
        await settle { admin.status?.text != said }
        XCTAssertEqual(admin.status, .init(text: said + " The list could not be refreshed: pull down to reload it.", kind: .success),
                       "not 'No answer…' alone: that reads as the delete failing")

        s.held = []
        await admin.signOutEverywhere("kim")
        XCTAssertEqual(admin.status?.kind, .success)
        XCTAssertTrue(admin.status?.text.hasPrefix("kim is signed out") ?? false, admin.status?.text ?? "")
        XCTAssertTrue(admin.status?.text.hasSuffix(AdminCopy.listNotRefreshed) ?? false)
    }

    func testOnlyChangesHoldThePanelOpen() async {
        XCTAssertEqual(Set(AdminAction.allCases.filter(\.changesSomething)),
                       [.createResetLink, .signOutEverywhere, .applyMerge, .resolveReport, .setAdmin, .deleteAccount, .renameAccount])
        let s = server()
        s.held = [.listPlayers, .setAdmin]
        let admin = panel(s)
        let load = Task { await admin.loadPlayers() }
        await settle { s.waitingCount(.listPlayers) == 1 }
        XCTAssertEqual(admin.inFlight, 1)
        XCTAssertEqual(admin.changing, 0, "a list on its way does not hold the panel")
        let change = Task { await admin.setAdmin("kim", true) }
        await settle { s.waitingCount(.setAdmin) == 1 }
        XCTAssertEqual(admin.changing, 1)
        s.held = []
        s.release(.setAdmin)
        s.release(.listPlayers)
        await change.value
        await load.value
        XCTAssertEqual(admin.changing, 0)
        XCTAssertEqual(admin.inFlight, 0)
    }
}
