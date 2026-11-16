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
///   when the server answers that it is the wrong password (that message only) and what was
///   typed had whitespace at an edge, the typed text is sent once (`AsTypedRetry`): an account
///   whose password was set by iOS 1.2.1 or earlier, which sent passwords as typed, may really
///   have that space.
/// - Delete Account's password is sent as typed, as on the web.
enum PasswordEntry {
    /// signInResponse's wrong-name-or-password message and changePasswordResponse's wrong
    /// current password (server/socket/authHandlers.js; server/socket/__tests__/iosCopies.test.js
    /// holds these copies to the server's). Only these replies get the as-typed resend.
    static let signInRefused = "Invalid username or password!"
    static let wrongCurrentPassword = "Your current password is incorrect."

    /// ECMAScript's WhiteSpace and LineTerminator, the set JS `String.prototype.trim()` strips
    /// (Foundation's `.whitespacesAndNewlines` differs: it has U+0085 and lacks U+FEFF).
    static func isTrimmed(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
        default: return false
        }
    }

    static func sent(_ typed: String) -> String {
        let scalars = typed.unicodeScalars
        guard let first = scalars.firstIndex(where: { !isTrimmed($0) }),
              let last = scalars.lastIndex(where: { !isTrimmed($0) }) else { return "" }
        return String(scalars[first...last])
    }

    /// `typed` when it differs from what `sent` gives (and that is not empty), else nil.
    static func asTypedFallback(_ typed: String) -> String? {
        let trimmed = sent(typed)
        return trimmed.isEmpty || trimmed == typed ? nil : typed
    }

    /// Why the Change Password form cannot be sent yet, from the fields as typed (nil = it can,
    /// or a field is still empty). The new password must differ from the current one as typed:
    /// a current password with an edge space may be changed to the same text without it (the
    /// way an older iOS password becomes one the web can type).
    static func changeProblem(current: String, new: String, again: String) -> String? {
        let next = sent(new), repeated = sent(again)
        guard !sent(current).isEmpty, !next.isEmpty else { return nil }
        if let problem = PasswordRule.newPasswordProblem(next) { return problem }
        if !repeated.isEmpty && repeated != next { return PasswordRule.mismatch }
        if next == current { return PasswordRule.unchanged }
        return nil
    }

    static func canChange(current: String, new: String, again: String) -> Bool {
        !sent(current).isEmpty && !sent(new).isEmpty && sent(new) == sent(again)
            && changeProblem(current: current, new: new, again: again) == nil
    }
}

/// The one as-typed resend of a refused password check (PasswordEntry). Armed with everything
/// the resend sends, captured when the first request goes out (a field edited meanwhile changes
/// nothing); given only for the wrong-password reply and at most once; dropped by any other
/// reply, a timeout, a success or the form going away.
struct AsTypedRetry<Request> {
    private(set) var pending: Request?

    mutating func arm(_ request: Request?) { pending = request }
    mutating func clear() { pending = nil }

    /// A refusal arrived: the request to send now, or nil (show the refusal).
    mutating func resend(afterRefusal message: String?, wrongPassword: String) -> Request? {
        defer { pending = nil }
        return message == wrongPassword ? pending : nil
    }
}

struct SignInRequest: Equatable { let username: String; let password: String }
struct PasswordChangeRequest: Equatable { let current: String; let new: String }

enum PasswordChangePlan {
    /// What Change Password sends first and, if that is refused as the wrong current password,
    /// once more. The server refuses new == current before it checks the current one, so when
    /// the trimmed current password equals the new one (dropping an edge space), only the
    /// as-typed current password can be meant and it goes alone.
    static func make(current typed: String, new: String) -> (first: PasswordChangeRequest, fallback: PasswordChangeRequest?) {
        let next = PasswordEntry.sent(new), trimmed = PasswordEntry.sent(typed)
        guard let asTyped = PasswordEntry.asTypedFallback(typed) else {
            return (PasswordChangeRequest(current: trimmed, new: next), nil)
        }
        if trimmed == next { return (PasswordChangeRequest(current: asTyped, new: next), nil) }
        return (PasswordChangeRequest(current: trimmed, new: next), PasswordChangeRequest(current: asTyped, new: next))
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
