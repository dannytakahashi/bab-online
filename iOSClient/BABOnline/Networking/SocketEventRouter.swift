import Foundation

/// Routes incoming socket events to the appropriate handler.
/// Call `registerAll()` once after socket connects.
final class SocketEventRouter {
    private let socket: SocketService
    private let authHandler: AuthSocketHandler
    private let lobbyHandler: LobbySocketHandler
    private let gameHandler: GameSocketHandler
    private let chatHandler: ChatSocketHandler

    init(
        socket: SocketService,
        authState: AuthState,
        mainRoomState: MainRoomState,
        lobbyState: LobbyState,
        gameState: GameState,
        appState: AppState
    ) {
        self.socket = socket
        self.authHandler = AuthSocketHandler(socket: socket, authState: authState, appState: appState, gameState: gameState)
        self.lobbyHandler = LobbySocketHandler(socket: socket, mainRoomState: mainRoomState, lobbyState: lobbyState, appState: appState, gameState: gameState)
        self.gameHandler = GameSocketHandler(socket: socket, gameState: gameState, appState: appState)
        self.chatHandler = ChatSocketHandler(socket: socket, gameState: gameState)
    }

    func registerAll() {
        authHandler.register()
        lobbyHandler.register()
        gameHandler.register()
        chatHandler.register()
    }
}
