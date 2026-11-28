import SwiftUI
import Combine

/// The app's state objects, made once per process, and the socket's wiring: what every scene
/// is built from (`inject`), so a state object added later reaches every window.
///
/// The App holds it as one `@StateObject`; it re-publishes each object's `objectWillChange`, so
/// the App's scenes are re-evaluated whenever any of them changes, as when each object was the
/// App's own `@StateObject`.
@MainActor
final class AppGraph: ObservableObject {
    let appState: AppState
    let authState: AuthState
    let mainRoomState: MainRoomState
    let lobbyState: LobbyState
    let gameState: GameState
    let actions: ActionCoordinator
    let tournamentState: TournamentState
    let leaderboardState: LeaderboardState
    let recordsState: RecordsState
    let safetyState: SafetyState
    let profileState: ProfileState

    let socketService = SocketService.shared
    private var forwards: [AnyCancellable] = []

    init() {
        let store = GameState()
        let app = AppState(), auth = AuthState(), mainRoom = MainRoomState(), lobby = LobbyState(), tournament = TournamentState()
        let leaderboard = LeaderboardState(), records = RecordsState(), profile = ProfileState(), safety = SafetyState()
        #if DEBUG
        UIFixture.seed(store, app, mainRoom: mainRoom, lobby: lobby, tournament: tournament, auth: auth)
        UIFixture.seedStats(leaderboard: leaderboard, records: records)
        UIFixture.seedProfile(profile, safety: safety)
        UIFixture.seedPlayerSearch(PlayerSearchState.shared)
        UIFixture.seedBadgeAwards(auth: auth)
        UIFixture.seedAdmin(AdminState.shared, auth: auth)
        #endif
        leaderboardState = leaderboard
        recordsState = records
        profileState = profile
        safetyState = safety
        appState = app
        authState = auth
        mainRoomState = mainRoom
        lobbyState = lobby
        tournamentState = tournament
        gameState = store
        actions = ActionCoordinator(store: store)
        forward(appState); forward(authState); forward(mainRoomState); forward(lobbyState); forward(gameState)
        forward(actions); forward(tournamentState); forward(leaderboardState); forward(recordsState)
        forward(safetyState); forward(profileState)
    }

    private func forward<O: ObservableObject>(_ object: O) where O.ObjectWillChangePublisher == ObservableObjectPublisher {
        object.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &forwards)
    }

    func setupSocket() {
        // Hosted unit tests launch the whole app: never connect (a running dev
        // server plus the simulator keychain would sign in and play).
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { return }
        #if DEBUG
        if UIFixture.isActive { return }  // fixture mode: never connect
        #endif
        // Error reports (c2s clientError): an uncaught exception is saved for the next launch,
        // and the last launch's goes out after the first connect
        ErrorReporter.installExceptionHandler()
        ErrorReporter.shared.page = { [weak screens = appState] in screens.map { "\($0.screen)" } }
        ErrorReporter.shared.reportPendingCrash()
        socketService.authState = authState
        socketService.gameState = gameState
        // a dropped socket ends the bid clock's tune and countdown (no `stopped` can reach it)
        actions.watchConnection(socketService.$isConnected.receive(on: DispatchQueue.main))
        // what a serverShutdown would cost the player now (RestartNotice)
        let app = appState, store = gameState, tournament = tournamentState
        socketService.restartPlace = {
            RestartNotice.place(screen: app.screen, role: store.table.viewer.role, phase: store.phase,
                                inTournament: !tournament.tournamentId.isEmpty || store.tournamentId != nil,
                                tournamentComplete: tournament.phase == "complete")
        }
        // the admin panel's requests (only an admin's Account sheet shows its entry)
        AdminState.shared.attach(socket: socketService, auth: authState)
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
            recordsState: recordsState,
            safetyState: safetyState,
            profileState: profileState,
            adminApi: AdminState.shared.api
        )
        router.registerAll()
        socketService.eventRouter = router
    }
}

extension View {
    /// Every state object of `graph` in the environment (each scene's root).
    func inject(_ graph: AppGraph) -> some View {
        self
            .environmentObject(graph.appState)
            .environmentObject(graph.authState)
            .environmentObject(graph.mainRoomState)
            .environmentObject(graph.lobbyState)
            .environment(\.lobbyStateLink, LobbyStateLink(state: graph.lobbyState))
            .environmentObject(graph.gameState)
            .environmentObject(graph.actions)
            .environmentObject(graph.tournamentState)
            .environment(\.tournamentStateLink, TournamentStateLink(state: graph.tournamentState))
            .environmentObject(graph.leaderboardState)
            .environmentObject(graph.recordsState)
            .environmentObject(graph.safetyState)
            .environmentObject(graph.profileState)
            .environmentObject(graph.socketService)
    }
}
