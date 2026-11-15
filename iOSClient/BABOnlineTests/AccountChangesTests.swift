import XCTest
import SocketIO
@testable import BAB_Online

/// Account changes of 2026-11-15 (ship with the next iOS build, after 1.2.1 build 9):
/// a restoreSessionResponse marked `retryable` keeps the saved token and asks again with
/// backoff (1.2.0 forgets the token on any failure); Change Password in the Account sheet
/// (changePassword -> changePasswordResponse); the one-time passwordReset notice; the
/// 8-character rule for new passwords. A real SocketManager and the app's router against
/// FakeSocketIOServer for the wire parts.
final class AccountChangesTests: XCTestCase {
    private var service: SocketService { SocketService.shared }  // the app skips its socket under XCTest
    private var server: FakeSocketIOServer!
    private var auth: AuthState!
    private var app: AppState!
    private var router: SocketEventRouter!

    static let restored: [String: Any] = ["success": true, "username": "ivy", "blockedUsers": []]
    static let dbError: [String: Any] = ["success": false, "message": "Database error. Try again.", "retryable": true]
    static let mainRoomJoined: [String: Any] = ["messages": [], "lobbies": [], "onlineCount": 1, "onlineUsers": ["ivy"]]

    @MainActor
    override func setUpWithError() throws {
        server = FakeSocketIOServer()
        try server.start()
        auth = AuthState()
        auth.username = "ivy"
        auth.sessionToken = "fixture-restore"  // never saved: the restore only needs it set
        app = AppState()
        router = SocketEventRouter(socket: service, authState: auth, mainRoomState: MainRoomState(), lobbyState: LobbyState(),
                                   gameState: GameState(), appState: app, tournamentState: TournamentState(),
                                   leaderboardState: LeaderboardState(), recordsState: RecordsState(), safetyState: SafetyState())
        service.authState = auth
        service.eventRouter = router
        service.serverError = nil
    }

    @MainActor
    override func tearDown() {
        service.disconnect()
        service.serverURLOverride = nil
        service.authState = nil
        service.eventRouter = nil
        service.isConnected = false
        service.isSessionReady = false
        server.stop()
        server = nil
        super.tearDown()
    }

    private func wait(_ what: String, timeout: TimeInterval = 10, until done: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertTrue(done(), what)
    }

    private func spin(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func sent(_ name: String) -> [[String: Any]] {
        server.events.filter { $0.name == name }.map(\.payload)
    }

    private func connect() {
        service.serverURLOverride = server.url
        service.connect()
    }

    /// The restore answers come from `answers` in order (the last one repeats).
    private func scriptRestore(_ answers: [[String: Any]]) {
        var n = 0
        server.replies = { name, _ in
            switch name {
            case "restoreSession":
                defer { n += 1 }
                return [("restoreSessionResponse", answers[min(n, answers.count - 1)])]
            case "joinMainRoom": return [("mainRoomJoined", Self.mainRoomJoined)]
            default: return []
            }
        }
    }

    // MARK: - retryable restore

    /// Two passing failures, then the restore goes through: the same token every time, 1 s then
    /// 2 s apart, the toast's "Reconnecting..." flag up meanwhile, then the main room.
    @MainActor
    func testRetryableRestoreKeepsTheTokenAndRetriesWithBackoff() {
        scriptRestore([Self.dbError, Self.dbError, Self.restored])
        connect()
        wait("the first failure is retried") { self.auth.restoreRetrying }
        XCTAssertEqual(auth.sessionToken, "fixture-restore", "the saved token is kept")
        XCTAssertEqual(sent("restoreSession").count, 1)
        spin(0.7)
        XCTAssertEqual(sent("restoreSession").count, 1, "not before 1 s")
        wait("the second restore", timeout: 3) { self.sent("restoreSession").count == 2 }
        spin(1.2)
        XCTAssertEqual(sent("restoreSession").count, 2, "the next one 2 s later, not 1 s")
        wait("the third restore and the main room", timeout: 4) { self.app.screen == .mainRoom && !self.auth.restoreRetrying }
        XCTAssertEqual(sent("restoreSession").map { $0["sessionToken"] as? String }, Array(repeating: "fixture-restore", count: 3))
        XCTAssertTrue(auth.isAuthenticated)
        spin(2.5)
        XCTAssertEqual(sent("restoreSession").count, 3, "nothing more after the success")
    }

    /// Any other failure (no retryable): the token goes and the sign-in screen shows, as in 1.2.0.
    @MainActor
    func testOtherRestoreFailuresStillForgetTheToken() {
        scriptRestore([Self.dbError, ["success": false, "message": "Invalid session token"]])
        app.screen = .mainRoom
        connect()
        wait("the retry got its answer", timeout: 5) { self.auth.sessionToken.isEmpty }
        XCTAssertEqual(app.screen, .signIn)
        XCTAssertFalse(auth.restoreRetrying)
        spin(2.5)
        XCTAssertEqual(sent("restoreSession").count, 2, "no retry after a final failure")
    }

    func testRetryPolicy() {
        XCTAssertEqual((0..<8).map(RestoreRetry.delay(attempt:)), [1, 2, 4, 8, 16, 30, 30, 30])
        XCTAssertTrue(RestoreRetry.isRetryable(Self.dbError))
        XCTAssertFalse(RestoreRetry.isRetryable(["success": false, "message": "Invalid session token"]))
        XCTAssertFalse(RestoreRetry.isRetryable(["success": true, "retryable": true]))
        XCTAssertFalse(RestoreRetry.isRetryable(["success": false, "retryable": "yes"]))
    }

    // MARK: - Change Password

    /// The emitter's payload as the server reads it, and the reply on AuthState.
    @MainActor
    func testChangePasswordWireAndReply() {
        scriptRestore([Self.restored])
        server.replies = { name, payload in
            switch name {
            case "restoreSession": return [("restoreSessionResponse", Self.restored)]
            case "joinMainRoom": return [("mainRoomJoined", Self.mainRoomJoined)]
            case "changePassword":
                let ok = (payload["next"] as? String)?.count ?? 0 >= 8
                return [("changePasswordResponse", ["success": ok, "message": ok ? "Password changed. Your other devices were signed out." : "Password must be 8-100 characters."])]
            default: return []
            }
        }
        connect()
        wait("signed in") { service.isSessionReady }
        AuthEmitter.changePassword(current: "old-pass", new: "brand-new-pw")
        wait("the reply") { self.auth.changePasswordResult != nil }
        XCTAssertEqual(sent("changePassword").first?["current"] as? String, "old-pass")
        XCTAssertEqual(sent("changePassword").first?["next"] as? String, "brand-new-pw")
        XCTAssertEqual(auth.changePasswordResult?.success, true)
        XCTAssertEqual(auth.changePasswordResult?.message, "Password changed. Your other devices were signed out.")
        XCTAssertEqual(SocketEvents.Client.changePassword, "changePassword")
        XCTAssertEqual(SocketEvents.Server.changePasswordResponse, "changePasswordResponse")
    }

    func testPasswordRules() {
        XCTAssertEqual(PasswordRule.newPasswordProblem("1234567"), PasswordRule.tooShort)
        XCTAssertNil(PasswordRule.newPasswordProblem("12345678"))
        XCTAssertEqual(PasswordRule.newPasswordProblem(String(repeating: "x", count: 101)), PasswordRule.tooLong)
        XCTAssertNil(PasswordRule.changeProblem(current: "", new: "", again: ""), "empty fields only disable the button")
        XCTAssertEqual(PasswordRule.changeProblem(current: "pw", new: "short", again: ""), PasswordRule.tooShort)
        XCTAssertEqual(PasswordRule.changeProblem(current: "pw", new: "brand-new-pw", again: "brand-new-px"), PasswordRule.mismatch)
        XCTAssertEqual(PasswordRule.changeProblem(current: "same-password", new: "same-password", again: "same-password"), PasswordRule.unchanged)
        XCTAssertFalse(PasswordRule.canChange(current: "pw", new: "brand-new-pw", again: ""))
        XCTAssertTrue(PasswordRule.canChange(current: "pw", new: "brand-new-pw", again: "brand-new-pw"), "a short CURRENT password is fine")
    }

    // MARK: - passwordReset notice

    func testPasswordResetNoticeText() {
        let utc = TimeZone(identifier: "UTC")!
        let us = Locale(identifier: "en_US")
        XCTAssertEqual(PasswordResetNotice.text(["by": "link", "at": "2026-11-14T09:30:00.000Z"], locale: us, timeZone: utc),
                       "Your password was reset with a reset link on Nov 14. If that wasn't you, tell an admin.")
        XCTAssertEqual(PasswordResetNotice.text(["by": "admin", "at": "2026-11-14T09:30:00Z"], locale: us, timeZone: utc),
                       "An admin set a new password for your account on Nov 14. If you didn't ask for that, tell an admin.")
        XCTAssertEqual(PasswordResetNotice.text(["by": "link", "at": "nope"], locale: us, timeZone: utc),
                       "Your password was reset with a reset link. If that wasn't you, tell an admin.")
        XCTAssertNil(PasswordResetNotice.text(nil))
        XCTAssertNil(PasswordResetNotice.text(["by": "someone"]))
    }

    /// The notice on a restore's success lands on AuthState (ContentView shows it as an alert).
    @MainActor
    func testRestoreCarriesTheResetNotice() {
        var withNotice = Self.restored
        withNotice["passwordReset"] = ["by": "admin", "at": "2026-11-14T09:30:00.000Z"]
        scriptRestore([withNotice])
        connect()
        wait("restored") { self.app.screen == .mainRoom }
        XCTAssertEqual(auth.accountNotice?.hasPrefix("An admin set a new password for your account"), true)
        auth.accountNotice = nil
    }
}
