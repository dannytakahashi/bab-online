import Foundation

enum ChatEmitter {
    private static var socket: SocketService { .shared }

    static func sendMessage(_ message: String) {
        socket.emit(SocketEvents.Client.chatMessage, ["message": message])
    }
}
