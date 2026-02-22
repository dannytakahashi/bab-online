import Foundation

enum AuthEmitter {
    private static var socket: SocketService { .shared }

    static func signIn(username: String, password: String) {
        socket.emit(SocketEvents.Client.signIn, ["username": username, "password": password])
    }

    static func signUp(username: String, password: String) {
        socket.emit(SocketEvents.Client.signUp, ["username": username, "password": password])
    }

    static func restoreSession(username: String, sessionToken: String) {
        socket.emit(SocketEvents.Client.restoreSession, ["username": username, "sessionToken": sessionToken])
    }

    static func rejoinGame(gameId: String, username: String) {
        socket.emit(SocketEvents.Client.rejoinGame, ["gameId": gameId, "username": username])
    }
}
