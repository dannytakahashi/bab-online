import Foundation

/// The rule for every new password (server `setPassword.checkPasswordRule`, 2026-11-15): 8-100
/// characters. Existing shorter passwords still sign in; only sign-up and Change Password ask.
enum PasswordRule {
    static let minLength = 8
    static let maxLength = 100

    static let tooShort = "Use at least \(minLength) characters."
    static let tooLong = "Use at most \(maxLength) characters."
    static let mismatch = "The two new passwords do not match."
    static let unchanged = "Choose a new password that is different from the current one."

    /// Why a new password (sign-up) cannot be sent yet; nil when it can.
    static func newPasswordProblem(_ password: String) -> String? {
        if password.count < minLength { return tooShort }
        if password.count > maxLength { return tooLong }
        return nil
    }

    /// Why Change Password cannot be sent yet (nil = it can); `nil` too while a field is empty,
    /// which only disables the button.
    static func changeProblem(current: String, new: String, again: String) -> String? {
        guard !current.isEmpty, !new.isEmpty else { return nil }
        if let problem = newPasswordProblem(new) { return problem }
        if !again.isEmpty && again != new { return mismatch }
        if new == current { return unchanged }
        return nil
    }

    static func canChange(current: String, new: String, again: String) -> Bool {
        !current.isEmpty && !new.isEmpty && new == again && changeProblem(current: current, new: new, again: again) == nil
    }
}

/// A typed password as it is sent (iOS 1.2.2, the web's rule: SignIn.js, Register.js and
/// ProfilePage.js Change Password all `trim()`): without whitespace at its edges, so a password
/// set on one client signs in on the other. The server stores and compares what it is sent.
/// - New passwords (sign-up, Change Password's new one) are always sent trimmed.
/// - A password being checked (sign-in, Change Password's current one) is sent trimmed first;
///   when the server refuses it and what was typed had whitespace at an edge, the typed text
///   is sent once (`asTypedFallback`): an account whose password was set by iOS 1.2.1 or
///   earlier, which sent passwords as typed, may really have that space.
/// - Delete Account's password is sent as typed, as on the web.
enum PasswordEntry {
    static func sent(_ typed: String) -> String {
        typed.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `typed` when it differs from what `sent` gives (and that is not empty), else nil.
    static func asTypedFallback(_ typed: String) -> String? {
        let trimmed = sent(typed)
        return trimmed.isEmpty || trimmed == typed ? nil : typed
    }
}

/// restoreSessionResponse `retryable: true` (2026-11-15: a database error, or a name an admin
/// merge / rename / delete holds for a moment): the saved token is kept and the restore asked
/// again on the same socket after 1 s, doubling to 30 s (the server allows 10 a minute per socket).
enum RestoreRetry {
    static let minDelay: TimeInterval = 1
    static let maxDelay: TimeInterval = 30

    /// The wait before retry number `attempt` (0-based).
    static func delay(attempt: Int) -> TimeInterval {
        min(maxDelay, minDelay * pow(2, Double(max(0, min(attempt, 10)))))
    }

    /// A failed restoreSessionResponse the app should retry (the key is absent on every other failure).
    static func isRetryable(_ data: [String: Any]) -> Bool {
        (data["success"] as? Bool) != true && (data["retryable"] as? Bool) == true
    }
}

/// The one-time notice after a password reset: `passwordReset {by: "link" | "admin", at}` on the
/// next signInResponse / restoreSessionResponse (server `authHandlers.resetNoticeFor`).
enum PasswordResetNotice {
    static func text(_ notice: Any?, locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let dict = notice as? [String: Any], let by = dict["by"] as? String, by == "link" || by == "admin" else {
            return nil
        }
        let when = (dict["at"] as? String).flatMap { day($0, locale: locale, timeZone: timeZone) }.map { " on \($0)" } ?? ""
        return by == "link"
            ? "Your password was reset with a reset link\(when). If that wasn't you, tell an admin."
            : "An admin set a new password for your account\(when). If you didn't ask for that, tell an admin."
    }

    /// "Nov 14" for an ISO time; nil when it does not parse (or is the epoch: no real time).
    private static func day(_ iso: String, locale: Locale, timeZone: TimeZone) -> String? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date, date.timeIntervalSince1970 > 0 else { return nil }
        let out = DateFormatter()
        out.locale = locale
        out.timeZone = timeZone
        out.setLocalizedDateFormatFromTemplate("MMMd")
        return out.string(from: date)
    }
}

/// changePasswordResponse {success, message}, for the Account sheet.
struct ChangePasswordResult: Equatable {
    let id = UUID()
    let success: Bool
    let message: String
}
