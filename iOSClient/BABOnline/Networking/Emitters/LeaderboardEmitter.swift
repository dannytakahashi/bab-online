import Foundation

enum LeaderboardEmitter {
    private static var socket: SocketService { .shared }

    static func getLeaderboard() {
        socket.emit(SocketEvents.Client.getLeaderboard)
    }
}
