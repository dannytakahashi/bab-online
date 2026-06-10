import Foundation

/// Tracks the signed-in user's blocked users plus transient feedback from
/// report/block requests (App Store Guideline 1.2).
final class SafetyState: ObservableObject {
    @Published var blockedUsers: Set<String> = []
    @Published var feedbackMessage: String?

    func isBlocked(_ username: String) -> Bool {
        blockedUsers.contains(username)
    }

    func setBlockedUsers(_ usernames: [String]) {
        blockedUsers = Set(usernames)
    }

    func reset() {
        blockedUsers = []
        feedbackMessage = nil
    }
}
