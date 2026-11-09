import Foundation

/// Handles chat-related socket events.
final class ChatSocketHandler {
    private let socket: SocketService
    private let gameState: GameState
    private let safetyState: SafetyState

    init(socket: SocketService, gameState: GameState, safetyState: SafetyState) {
        self.socket = socket
        self.gameState = gameState
        self.safetyState = safetyState
    }

    func register() {
        socket.on(SocketEvents.Server.chatMessage) { [weak self] data, _ in
            guard let self else { return }
            DispatchQueue.main.async {
                let username = (data.first as? [String: Any])?["username"] as? String ?? ""
                // Always to the store: a blocked line is not shown but its seq still counts (R2)
                self.gameState.apply(serverEvent: SocketEvents.Server.chatMessage, payload: data,
                                     chatBlocked: self.safetyState.isBlocked(username),
                                     chatMine: username == self.gameState.username)
            }
        }
    }
}
