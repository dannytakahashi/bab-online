import Foundation

/// The Stats sheet's requests (no payload; the server answers from its 60 s caches).
enum LeaderboardEmitter {
    private static var socket: SocketService { .shared }

    static func getLeaderboard() {
        socket.emit(SocketEvents.Client.getLeaderboard)
    }

    static func getRecords() {
        socket.emit(SocketEvents.Client.getRecords)
    }
}
