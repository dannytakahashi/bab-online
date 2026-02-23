import Foundation

final class LeaderboardState: ObservableObject {
    @Published var entries: [LeaderboardEntry] = []
    @Published var isLoading = false
    @Published var error: String?

    func reset() {
        entries = []
        isLoading = false
        error = nil
    }
}
