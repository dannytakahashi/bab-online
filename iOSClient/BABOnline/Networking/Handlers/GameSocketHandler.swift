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
        SocketEvents.Server.playerDrew, SocketEvents.Server.teamsAnnounced,
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

    /// Snapshot carriers that open the game screen when they apply.
    static let enteringCarriers: Set<String> = [
        SocketEvents.Server.rejoinSuccess, SocketEvents.Server.restorePlayerState, SocketEvents.Server.spectatorJoined,
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
        let troubleBefore = gameState.table.snapshotTrouble
        let hadTable = gameState.gameId != nil
        let decoded = gameState.apply(serverEvent: name, payload: payload)
        guard case .success(let ev) = decoded else {
            // the server put us at a table this build cannot show: open the game screen anyway,
            // where it says so and offers Leave (UnreadableTableView), never a silent main room
            if case .failure(.snapshot(let event, _, _)) = decoded, Self.enteringCarriers.contains(event) {
                appState.screen = .game
            }
            return
        }

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
            // a seq'd abortGame behind a table this build could not show was dropped or
            // buffered, not applied: reset here so no stale retry or count outlives the game
            if gameState.table.snapshotTrouble != .none { gameState.reset() }
            if savedTournamentId != nil {
                TournamentEmitter.returnToTournament()
            } else {
                appState.screen = .mainRoom
            }
        case .leftGame:
            // already off the table (UnreadableTableView's Leave fallback went on its own):
            // a late leftGame must not move the player again (e.g. out of the tournament)
            guard hadTable || appState.screen == .game else { break }
            if savedTournamentId != nil {
                TournamentEmitter.returnToTournament()
            } else {
                appState.screen = .mainRoom
                LobbyEmitter.joinMainRoom()
            }
        case .spectatorState:
            SpectateRejoin.pendingGameId = nil  // a restore's re-spectate answered (1.2.2 (12))
            appState.screen = .game
            RestartNotices.shared.survived()
            print("[Game] Joined as spectator")
        case .stateSnapshot(let p) where p.snapshot == nil:
            // not_in_game: after a serverShutdown, the game is gone
            RestartNotices.shared.lost()
            // and the table was one this build could not show (it may never have applied,
            // e.g. a rejoin from the main room): leave it rather than sit on it, unless a
            // gameEnd landed meanwhile (GameEndView has its own way out)
            if troubleBefore != .none, appState.screen == .game, gameState.phase != .ended {
                Self.leaveTable(gameState: gameState, appState: appState, tournamentId: savedTournamentId)
            }
        case .restorePlayerState:
            appState.screen = .game
            print("[Game] Player state restored")
        default:
            break
        }
    }

    /// Off a table the server no longer has us at, as leftGame does, the table reset first.
    @MainActor
    static func leaveTable(gameState: GameState, appState: AppState, tournamentId: String?) {
        gameState.reset()
        if tournamentId != nil {
            TournamentEmitter.returnToTournament()
        } else {
            appState.screen = .mainRoom
            LobbyEmitter.joinMainRoom()
        }
    }
}
