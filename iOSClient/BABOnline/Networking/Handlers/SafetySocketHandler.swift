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
                let success = dict["success"] as? Bool ?? false
                if success {
                    self.safetyState.setBlockedUsers(dict["blockedUsers"] as? [String] ?? [])
                    self.safetyState.feedbackMessage = "Block list updated."
                } else {
                    self.safetyState.feedbackMessage = dict["message"] as? String ?? "Failed to update block list. Try again."
                }
                print("[Safety] Block list updated: success=\(success)")
            }
        }
    }
}
