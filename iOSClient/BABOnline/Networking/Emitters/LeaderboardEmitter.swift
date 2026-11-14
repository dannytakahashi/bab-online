import Foundation

/// The Stats sheet's requests (the server answers from its 60 s caches). Human games are asked
/// for with no payload, exactly as before scopes (every server answers that with human games);
/// bot games and all games with `{scope}` (`StatsScope.payload`).
enum LeaderboardEmitter {
    private static var socket: SocketService { .shared }

    static func getLeaderboard(scope: StatsScope) {
        emit(SocketEvents.Client.getLeaderboard, scope)
    }

    static func getRecords(scope: StatsScope) {
        emit(SocketEvents.Client.getRecords, scope)
    }

    private static func emit(_ event: String, _ scope: StatsScope) {
        if let payload = scope.payload {
            socket.emit(event, payload)
        } else {
            socket.emit(event)
        }
    }
}
