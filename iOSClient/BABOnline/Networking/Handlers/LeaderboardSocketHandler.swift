import Foundation

final class LeaderboardSocketHandler {
    private let socket: SocketService
    private let leaderboardState: LeaderboardState

    init(socket: SocketService, leaderboardState: LeaderboardState) {
        self.socket = socket
        self.leaderboardState = leaderboardState
    }

    func register() {
        socket.on(SocketEvents.Server.leaderboardResponse) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.leaderboardState.isLoading = false

                guard let success = dict["success"] as? Bool, success,
                      let entries = dict["leaderboard"] as? [[String: Any]] else {
                    self.leaderboardState.error = dict["message"] as? String ?? "Failed to load leaderboard"
                    return
                }

                self.leaderboardState.entries = entries.compactMap { LeaderboardEntry.from($0) }
                self.leaderboardState.error = nil
            }
        }
    }
}
