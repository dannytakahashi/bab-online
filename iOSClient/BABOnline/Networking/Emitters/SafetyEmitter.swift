import Foundation

/// Report/block emitters (App Store Guideline 1.2).
enum SafetyEmitter {
    private static var socket: SocketService { .shared }

    static func reportUser(username: String, reason: String, context: String? = nil) {
        var payload: [String: Any] = ["username": username, "reason": reason]
        if let context {
            payload["context"] = context
        }
        socket.emit(SocketEvents.Client.reportUser, payload)
    }

    static func blockUser(username: String) {
        socket.emit(SocketEvents.Client.blockUser, ["username": username])
    }

    static func unblockUser(username: String) {
        socket.emit(SocketEvents.Client.unblockUser, ["username": username])
    }
}
