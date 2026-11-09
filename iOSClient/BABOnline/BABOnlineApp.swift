import SwiftUI

@main
struct BABOnlineApp: App {
    @StateObject private var appState = AppState()
    @StateObject private var authState = AuthState()
    @StateObject private var mainRoomState = MainRoomState()
    @StateObject private var lobbyState = LobbyState()
    @StateObject private var gameState: GameState
    @StateObject private var actions: ActionCoordinator
    @StateObject private var tournamentState = TournamentState()
    @StateObject private var leaderboardState = LeaderboardState()
    @StateObject private var safetyState = SafetyState()
    @Environment(\.scenePhase) private var scenePhase
    /// True once the scene has actually reached `.background`. Control Center, the
    /// notification shade and system alerts (e.g. the mic permission prompt) only
    /// move the scene to `.inactive`, and must not tear down the socket.
    @State private var didEnterBackground = false

    private let socketService = SocketService.shared

    init() {
        let store = GameState()
        _gameState = StateObject(wrappedValue: store)
        _actions = StateObject(wrappedValue: ActionCoordinator(store: store))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appState)
                .environmentObject(authState)
                .environmentObject(mainRoomState)
                .environmentObject(lobbyState)
                .environmentObject(gameState)
                .environmentObject(actions)
                .environmentObject(tournamentState)
                .environmentObject(leaderboardState)
                .environmentObject(safetyState)
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
        // Hosted unit tests launch the whole app: never connect (a running dev
        // server plus the simulator keychain would sign in and play).
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { return }
        socketService.authState = authState
        socketService.gameState = gameState
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
            leaderboardState: leaderboardState,
            safetyState: safetyState
        )
        router.registerAll()
        socketService.eventRouter = router
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            // inactive -> active without a real background (Control Center, notification
            // shade, permission alert): the socket was never at risk, so leave it alone.
            // A reconnect here looks like a real disconnect to the server.
            guard didEnterBackground else { return }
            didEnterBackground = false

            // Restore voice mic state
            VoiceChatManager.shared.handleForeground()

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
            didEnterBackground = true

            // Mute voice mic for privacy while backgrounded
            VoiceChatManager.shared.handleBackground()

            print("[App] Backgrounded — starting socket keep-alive")
            socketService.beginBackgroundKeepAlive()
        default:
            break
        }
    }
}
