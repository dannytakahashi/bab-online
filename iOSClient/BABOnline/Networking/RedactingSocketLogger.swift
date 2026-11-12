import Foundation
import SocketIO

/// Socket.IO-Client-Swift's transport log, opt-in and redacted (review note,
/// 2026-11-11): `.log(true)` printed every payload, including the TURN
/// username and credential of `voiceIceServers` and the sign-in / restore
/// payloads (passwords, session tokens).
///
/// - Off by default, Debug builds only: `-socketLog YES` (a launch argument,
///   so it lands in the arguments domain of UserDefaults) turns it on
///   (SocketService.connect). Release builds never install it, and the
///   library's own logger stays off (DefaultSocketLogger.log is false).
/// - Even then a line about voiceIceServers, signIn, signUp or restoreSession
///   (their requests and responses), or one that mentions a credential,
///   password or token, keeps only its text up to the payload: everything
///   from the first `[` or `{` (the packet's JSON) is replaced by `<redacted>`.
final class RedactingSocketLogger: SocketLogger {
    var log = true

    static let marker = "<redacted>"
    /// Lower-cased: events whose payloads carry secrets, and words that name one.
    static let sensitive = ["voiceiceservers", "signin", "signup", "restoresession", "credential", "password", "token"]

    /// `-socketLog YES` (Debug builds only, like `-serverURL`: release code reads no UserDefaults,
    /// README "Privacy manifest").
    static var isEnabled: Bool {
        #if DEBUG
        return UserDefaults.standard.bool(forKey: "socketLog")
        #else
        return false
        #endif
    }

    /// The line as it may be printed.
    static func redact(_ message: String) -> String {
        let lower = message.lowercased()
        guard sensitive.contains(where: { lower.contains($0) }) else { return message }
        guard let cut = message.firstIndex(where: { $0 == "[" || $0 == "{" }) else { return marker }
        return String(message[..<cut]) + marker
    }

    func log(_ message: @autoclosure () -> String, type: String) {
        guard log else { return }
        NSLog("LOG %@: %@", type, Self.redact(message()))
    }

    func error(_ message: @autoclosure () -> String, type: String) {
        guard log else { return }
        NSLog("ERROR %@: %@", type, Self.redact(message()))
    }
}
