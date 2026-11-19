import Foundation

/// The words and the look of the app's toasts (ServerErrorToast) where the server or a session
/// outcome says something to the player: the web's words where the web says something
/// (client/src/state/noticeText.js and main.js on branch web/toasts-help-faults; toast audit
/// 2026-11-18, "iOS gaps"). forceLogout's and abortGame's words below are
/// iOS's own words: the web shows no toast for them. `.error` is the amber "!" (a refusal),
/// `.info` the teal "i" (news, not a failure).
enum NoticeText {
    // MARK: serverError (SocketService.handleServerError)

    static let fallback = "Something went wrong. Try again."
    static let rateLimit = "Too many requests. Please slow down."
    static let signInAgain = "Please sign in again"
    static let chatTooLong = "That message is too long (500 characters max)."
    static let notAccepted = "That wasn't accepted. Try again."

    /// Refusals that are information, per handler (the server's exact text).
    static let infoRejections: [String: Set<String>] = [
        "playerReady": ["The table is full \u{2014} you'll watch this game"],
    ]

    /// The c2s chat events (their validation failure is the 500-character limit).
    static let chatHandlers: Set<String> = ["chatMessage", "lobbyChat", "mainRoomChat", "tournamentChat"]

    /// The toast for a server failure (`serverError {code, message, handler}` or the legacy
    /// `error {type, message, handler}`). Joi's validation text is developer text and never
    /// shown; the rate limit gets the web's wording; a refusal's own text is meant for the
    /// player (amber), except the information sent as a refusal (teal).
    static func serverError(_ dict: [String: Any]) -> ServerErrorNotice {
        let code = (dict["code"] as? String) ?? (dict["type"] as? String)
        let message = (dict["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let handler = dict["handler"] as? String
        switch code {
        case "validation", "VALIDATION_ERROR":
            return ServerErrorNotice(message: handler.map(chatHandlers.contains) == true ? chatTooLong : notAccepted)
        case "rateLimit", "RATE_LIMIT_ERROR":
            return ServerErrorNotice(message: rateLimit)
        case "AUTH_ERROR":
            return ServerErrorNotice(message: signInAgain)
        case "server":
            return ServerErrorNotice(message: fallback)
        default:
            guard let message else { return ServerErrorNotice(message: fallback) }
            let info = handler.flatMap { infoRejections[$0] }?.contains(message) == true
            return ServerErrorNotice(message: message, kind: info ? .info : .error)
        }
    }

    // MARK: session outcomes

    /// forceLogout (an admin, a password change or a rename elsewhere, another sign-in): shown
    /// on the sign-in screen (iOS only: the web goes to its sign-in screen without a toast).
    static let signedOut = "You were signed out. Sign in again to keep playing."

    /// abortGame's `reason` in the player's words; nil when another toast says it (a cancelled
    /// tournament has its own) or a server restart explains it.
    static func abortText(_ reason: String?) -> String? {
        switch reason {
        case "Tournament cancelled": return nil
        // only spectators get it: the last owner to leave is out of the room first
        // (seatLifecycle.leaveSeat, then maybeAbort), so not "everyone else"
        case "All players left": return "The game ended: every player left."
        case "All players disconnected": return "The game ended: every player disconnected."
        default: return "The game ended."
        }
    }

    /// voiceSettings role none at a casual game (the room is full: 8 people).
    static let voiceFull = "Voice is full (8 people). You can still watch and chat."
}
