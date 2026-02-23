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
            // Always force reconnect when foregrounding. iOS can silently kill the
            // WebSocket without firing a disconnect event, so `isConnected` is unreliable.
            // forceReconnect() tears down and re-establishes the connection, which triggers
            // the .reconnect handler's restoreSession flow (handles both main room and
            // in-game rejoin).
            print("[App] Foregrounded — force reconnecting socket")
            socketService.forceReconnect()
        case .background:
            print("[App] Backgrounded")
        default:
            break
        }
    }
}
