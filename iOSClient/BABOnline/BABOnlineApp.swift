import SwiftUI

@main
struct BABOnlineApp: App {
    @StateObject private var appState = AppState()
    @StateObject private var authState = AuthState()
    @StateObject private var mainRoomState = MainRoomState()
    @StateObject private var lobbyState = LobbyState()
    @StateObject private var gameState = GameState()
    @StateObject private var tournamentState = TournamentState()
    @StateObject private var leaderboardState = LeaderboardState()
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
                .environmentObject(tournamentState)
                .environmentObject(leaderboardState)
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
            appState: appState,
            tournamentState: tournamentState,
            leaderboardState: leaderboardState
        )
        router.registerAll()
        socketService.eventRouter = router
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            if socketService.isBackgroundTaskActive {
                // Returned within the background keep-alive window (~30s).
                // Socket likely still connected — end the task and only reconnect if needed.
                print("[App] Foregrounded within keep-alive window")
                socketService.endBackgroundKeepAlive()
                if !socketService.isConnected {
                    print("[App] Socket disconnected during background — force reconnecting")
                    socketService.forceReconnect()
                }
            } else {
                // Background task expired or was never started — do a full reconnect.
                // iOS can silently kill the WebSocket without firing a disconnect event,
                // so `isConnected` is unreliable after a long background period.
                print("[App] Foregrounded after keep-alive expired — force reconnecting socket")
                socketService.forceReconnect()
            }
        case .background:
            print("[App] Backgrounded — starting socket keep-alive")
            socketService.beginBackgroundKeepAlive()
        default:
            break
        }
    }
}
