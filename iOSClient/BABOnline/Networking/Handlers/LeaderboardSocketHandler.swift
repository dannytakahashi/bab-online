import Foundation

/// `leaderboardResponse` -> LeaderboardState (decoding and failures: LeaderboardState.apply).
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
            DispatchQueue.main.async { self.leaderboardState.apply(response: dict) }
        }
    }
}
