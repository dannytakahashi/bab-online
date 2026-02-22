import SwiftUI

@main
struct BABOnlineApp: App {
    @StateObject private var appState = AppState()
    @StateObject private var authState = AuthState()
    @StateObject private var mainRoomState = MainRoomState()
    @StateObject private var lobbyState = LobbyState()
    @StateObject private var gameState = GameState()
    @Environment(\.scenePhase) private var scenePhase

    private let socketService = SocketService.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appState)
                .environmentObject(authState)
                .environmentObject(mainRoomState)
                .environmentObject(lobbyState)
                .environmentObject(gameState)
                .environmentObject(socketService)
                .onAppear {
                    setupSocket()
                }
                .onChange(of: scenePhase) { _, newPhase in
                    handleScenePhase(newPhase)
                }
        }
    }

    private func setupSocket() {
        socketService.authState = authState
        socketService.connect()

        // Register event router — stored on socketService so handlers stay alive
        let router = SocketEventRouter(
            socket: socketService,
            authState: authState,
            mainRoomState: mainRoomState,
            lobbyState: lobbyState,
            gameState: gameState,
            appState: appState
        )
        router.registerAll()
        socketService.eventRouter = router
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            // Reconnect socket when app comes to foreground
            if !socketService.isConnected {
                print("[App] Foregrounded — reconnecting socket")
                socketService.connect()
            }
        case .background:
            print("[App] Backgrounded")
        default:
            break
        }
    }
}
