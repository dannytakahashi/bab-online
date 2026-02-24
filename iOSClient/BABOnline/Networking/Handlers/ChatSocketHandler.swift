import Foundation

/// Handles chat-related socket events.
final class ChatSocketHandler {
    private let socket: SocketService
    private let gameState: GameState

    init(socket: SocketService, gameState: GameState) {
        self.socket = socket
        self.gameState = gameState
    }

    func register() {
        socket.on(SocketEvents.Server.chatMessage) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async {
                let username = dict["username"] as? String ?? ""
                let message = dict["message"] as? String ?? ""
                let position = dict["position"] as? Int
                let type: ChatMessage.MessageType = (dict["type"] as? String) == "spectator" ? .spectator : .player

                let chatMsg = ChatMessage(username: username, message: message, type: type, position: position)
                self.gameState.gameLog.append(chatMsg)

                // Increment unread count for player/spectator messages
                if (type == .player || type == .spectator) && username != self.gameState.username {
                    self.gameState.unreadChatCount += 1
                }

                // Trigger chat bubble
                if let pos = position {
                    self.gameState.chatBubbleSubject.send((message: message, position: pos))
                }
            }
        }
    }
}
