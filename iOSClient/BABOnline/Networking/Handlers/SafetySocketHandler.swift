import Foundation

/// Handles safety-related socket events: reportUserResponse, blockListUpdated.
final class SafetySocketHandler {
    private let socket: SocketService
    private let safetyState: SafetyState

    init(socket: SocketService, safetyState: SafetyState) {
        self.socket = socket
        self.safetyState = safetyState
    }

    func register() {
        socket.on(SocketEvents.Server.reportUserResponse) { [weak self] data, _ in
            guard let self else { return }
            let dict = data.first as? [String: Any]
            DispatchQueue.main.async {
                let success = dict?["success"] as? Bool ?? false
                if success {
                    self.safetyState.feedbackMessage = "Report submitted. Thank you."
                } else {
                    self.safetyState.feedbackMessage = dict?["message"] as? String ?? "Failed to submit report. Try again."
                }
                print("[Safety] Report response: success=\(success)")
            }
        }

        socket.on(SocketEvents.Server.blockListUpdated) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                Self.applyBlockListUpdated(dict, to: self.safetyState)
            }
        }
    }

    /// blockListUpdated: a success replaces the list; a failure keeps it and shows the
    /// server's message. `silent: true` (read from 1.2.2) marks a refresh the player did
    /// not ask for (an admin renamed someone on their list): the list is replaced with no
    /// alert, as the web skips its toast (client/src/main.js). Builds up to 1.2.1 build 9
    /// ignore the field and show the alert.
    static func applyBlockListUpdated(_ dict: [String: Any], to safetyState: SafetyState) {
        let success = dict["success"] as? Bool ?? false
        if success {
            safetyState.setBlockedUsers(dict["blockedUsers"] as? [String] ?? [])
            if dict["silent"] as? Bool != true {
                safetyState.feedbackMessage = "Block list updated."
            }
        } else {
            safetyState.feedbackMessage = dict["message"] as? String ?? "Failed to update block list. Try again."
        }
        print("[Safety] Block list updated: success=\(success)")
    }
}
