import Foundation

enum LobbyEmitter {
    private static var socket: SocketService { .shared }

    static func joinMainRoom() {
        socket.emit(SocketEvents.Client.joinMainRoom)
    }

    static func mainRoomChat(message: String) {
        socket.emit(SocketEvents.Client.mainRoomChat, ["message": message])
    }

    static func createLobby() {
        socket.emit(SocketEvents.Client.createLobby, [:])
    }

    static func joinLobby(lobbyId: String) {
        socket.emit(SocketEvents.Client.joinLobby, ["lobbyId": lobbyId])
    }

    static func leaveLobby() {
        socket.emit(SocketEvents.Client.leaveLobby)
    }

    static func lobbyChat(message: String) {
        socket.emit(SocketEvents.Client.lobbyChat, ["message": message])
    }

    static func playerReady() {
        socket.emit(SocketEvents.Client.playerReady)
    }

    static func playerUnready() {
        socket.emit(SocketEvents.Client.playerUnready)
    }

    static func addBot(personality: String = "mary") {
        socket.emit(SocketEvents.Client.addBot, ["personality": personality])
    }

    /// The server needs the bot's socket id (lobbyHandlers.removeBot); a
    /// payload-less removeBot is answered with an error.
    static func removeBot(botSocketId: String) {
        socket.emit(SocketEvents.Client.removeBot, ["botSocketId": botSocketId])
    }

    static func joinAsSpectator(gameId: String) {
        socket.emit(SocketEvents.Client.joinAsSpectator, ["gameId": gameId])
    }
}
