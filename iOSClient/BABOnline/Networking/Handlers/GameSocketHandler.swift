import Foundation

/// Game-phase socket events: decode, apply to the table store, then navigate
/// exactly as before. All table state lives in GameState (TableReducer).
final class GameSocketHandler {
    private let socket: SocketService
    private let gameState: GameState
    private let appState: AppState

    /// Every event this handler routes into the store (SeqCoverageTests).
    static let events: [String] = [
        SocketEvents.Server.positionUpdate, SocketEvents.Server.startDraw, SocketEvents.Server.youDrew,
        SocketEvents.Server.playerDrew, SocketEvents.Server.playerAssigned, SocketEvents.Server.teamsAnnounced,
        SocketEvents.Server.createUI, SocketEvents.Server.gameStart, SocketEvents.Server.bidReceived,
        SocketEvents.Server.doneBidding, SocketEvents.Server.updateTurn, SocketEvents.Server.cardPlayed,
        SocketEvents.Server.actionRejected, SocketEvents.Server.trickComplete, SocketEvents.Server.handComplete,
        SocketEvents.Server.destroyHands, SocketEvents.Server.gameEnd, SocketEvents.Server.rainbow,
        SocketEvents.Server.abortGame, SocketEvents.Server.playerDisconnected,
        SocketEvents.Server.playerReconnected, SocketEvents.Server.resignationAvailable, SocketEvents.Server.playerResigned,
        SocketEvents.Server.gameLogEntry, SocketEvents.Server.rejoinSuccess, SocketEvents.Server.rejoinFailed,
        SocketEvents.Server.spectatorJoined, SocketEvents.Server.playerLazyMode, SocketEvents.Server.playerActiveMode,
        SocketEvents.Server.leftGame, SocketEvents.Server.restorePlayerState, SocketEvents.Server.stateSnapshot,
        // unsequenced: ServerEvent decodes it with seq nil, so it goes around the seq gate
        SocketEvents.Server.spectatorsUpdated,
    ]

    init(socket: SocketService, gameState: GameState, appState: AppState) {
        self.socket = socket
        self.gameState = gameState
        self.appState = appState
    }

    func register() {
        for name in Self.events {
            // One FIFO hop to main per event, as every handler did before
            socket.on(name) { [weak self] data, _ in
                DispatchQueue.main.async { self?.handle(event: name, payload: data) }
            }
        }
    }

    /// Test seam: the whole path of one raw event.
    @MainActor
    func handle(event name: String, payload: [Any]) {
        let savedTournamentId = gameState.tournamentId
        guard case .success(let ev) = gameState.apply(serverEvent: name, payload: payload) else { return }

        switch ev.event {
        case .startDraw, .gameStart:
            appState.screen = .game
        case .rejoinSuccess:
            appState.screen = .game
            // 21.14: a seat owner (or its lazy watcher) talks again after a rejoin;
            // reconnectOwner sends the peer list, buffered while voice starts
            if gameState.table.viewer.holdsSeat { VoiceChatManager.shared.ensureStarted() }
            RestartNotices.shared.survived()
            print("[Game] Rejoin success")
        case .rejoinFailed(let p):
            print("[Game] Rejoin failed: \(p.reason ?? "Rejoin failed")")
            RestartNotices.shared.lost()  // after a serverShutdown: the game ended with the restart
            // Don't navigate away if we're already in a game (a duplicate rejoin whose first succeeded)
            if appState.screen != .game {
                appState.screen = .mainRoom
                LobbyEmitter.joinMainRoom()
            }
        case .abortGame:
            if savedTournamentId != nil {
                TournamentEmitter.returnToTournament()
            } else {
                appState.screen = .mainRoom
            }
        case .leftGame:
            if savedTournamentId != nil {
                TournamentEmitter.returnToTournament()
            } else {
                appState.screen = .mainRoom
                LobbyEmitter.joinMainRoom()
            }
        case .spectatorState:
            appState.screen = .game
            RestartNotices.shared.survived()
            print("[Game] Joined as spectator")
        case .stateSnapshot(let p) where p.snapshot == nil:
            // not_in_game: after a serverShutdown, the game is gone
            RestartNotices.shared.lost()
        case .restorePlayerState:
            appState.screen = .game
            print("[Game] Player state restored")
        default:
            break
        }
    }
}
