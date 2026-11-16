import Foundation
import SwiftUI

/// Play again (owner 2026-11-16; iOS 1.2.3, build 12; server/socket/playAgain.js): at the end
/// of a casual game a lobby started, the server moves this socket back into a recreated copy
/// of that lobby (new id; same name, host, settings, chat and lobby bots; nobody ready) and
/// says so with the private, unsequenced `lobbyReturn`, right after its `gameEnd`.
///
/// The owner's rule: the score screen stays exactly as it is, for players and spectators,
/// for as long as they want. So `lobbyReturn` changes no screen: the lobby is only kept in
/// `LobbyState` (`returnFromGameId`), and its later events (members, ready flags, chat) keep
/// it current behind the results. The existing "Return to Lobby" button (label unchanged)
/// then enters that lobby instead of the main room (`enterOnReturn`), and voice keeps
/// running from the game into the lobby (`keepsVoice`), where everyone may talk.
///
/// `gameEnd` is sequenced and may wait in the seq gate while `lobbyReturn` does not: while the
/// table of that game has not ended, the return waits; if it still has not after
/// `gameEndWait` (5 s, the web's GAP_TIMEOUT_MS) there is no score screen to keep and the app
/// enters the lobby. With no table for that game (the main room, the lobby) it enters at once;
/// at another table or a tournament lobby (the server's membership rules make this
/// impossible) it sends leaveLobby so the server matches.
@MainActor
enum LobbyReturn {
    /// How long a return waits for its game's gameEnd to apply.
    static var gameEndWait: TimeInterval = 5

    /// Said to VoiceOver when the lobby comes up (the web's toast words).
    static func backInText(_ name: String) -> String {
        "Back in \u{201C}\(name)\u{201D}. Tap Ready when you want to play again."
    }

    /// `lobbyReturn`. `schedule` runs the fallback (tests replace it).
    static func receive(_ dict: [String: Any], lobbyState: LobbyState, appState: AppState, gameState: GameState,
                        isBlocked: (String) -> Bool,
                        leaveLobby: () -> Void = { LobbyEmitter.leaveLobby() },
                        schedule: (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, work in
                            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated { work() } }
                        }) {
        guard let lobbyId = dict["lobbyId"] as? String, !lobbyId.isEmpty else { return }
        let gameId = (dict["lastGame"] as? [String: Any])?["gameId"] as? String
        switch appState.screen {
        case .game:
            guard let gameId, let tableGame = gameState.gameId else {
                // no table to keep up (it was reset): straight into the lobby
                lobbyState.applyLobby(dict, isBlocked: isBlocked)
                enter(lobbyState: lobbyState, appState: appState, gameState: gameState)
                return
            }
            guard tableGame == gameId else {
                print("[Lobby] lobbyReturn for \(gameId) at another table (\(tableGame)): leaving that lobby")
                leaveLobby()
                return
            }
            lobbyState.applyLobby(dict, isBlocked: isBlocked)
            lobbyState.returnFromGameId = gameId
            print("[Lobby] Back in lobby \(lobbyId) after \(gameId): kept behind the score screen")
            guard gameState.phase != .ended else { return }
            // gameEnd still in the seq gate: keep waiting for it, but not forever
            schedule(gameEndWait) {
                guard appState.screen == .game, gameState.gameId == gameId, gameState.phase != .ended,
                      lobbyState.returnFromGameId == gameId, lobbyState.lobbyId == lobbyId else { return }
                print("[Lobby] No gameEnd for \(gameId) after \(gameEndWait) s: into the lobby")
                enter(lobbyState: lobbyState, appState: appState, gameState: gameState)
            }
        case .mainRoom, .gameLobby:
            lobbyState.applyLobby(dict, isBlocked: isBlocked)
            enter(lobbyState: lobbyState, appState: appState, gameState: gameState)
        case .tournamentLobby, .signIn, .register:
            print("[Lobby] lobbyReturn off any table (\(appState.screen)): leaving that lobby")
            leaveLobby()
        }
    }

    /// GameEndView's Return to Lobby: the lobby this game's end moved me back to, if any
    /// (true: entered; false: the button's old way, the main room).
    @discardableResult
    static func enterOnReturn(lobbyState: LobbyState, appState: AppState, gameState: GameState) -> Bool {
        guard let gameId = lobbyState.returnFromGameId, gameId == gameState.gameId, !lobbyState.lobbyId.isEmpty else {
            return false
        }
        enter(lobbyState: lobbyState, appState: appState, gameState: gameState)
        return true
    }

    /// The lobby screen for the lobby in `lobbyState`. From the table, voice carries on (the
    /// calls with the others who came back are kept by the server) in talk mode.
    static func enter(lobbyState: LobbyState, appState: AppState, gameState: GameState,
                      voice: VoiceChatManager? = nil) {
        let voice = voice ?? .shared
        let fromTable = appState.screen == .game
        lobbyState.returnFromGameId = nil
        gameState.reset()
        gameState.apply(.local(.enterLobby(lobbyId: lobbyState.lobbyId)))
        if fromTable {
            lobbyState.carriesVoice = true
            toLobbyVoice(voice)
        }
        appState.screen = .gameLobby
        AccessibilityNotification.Announcement(backInText(lobbyState.lobbyName)).post()
        print("[Lobby] Entered lobby \(lobbyState.lobbyId) after the game")
    }

    /// In the lobby everyone may talk: the game's settings and forced mutes go, the mic the
    /// person had stays theirs (a listen-only spectator who never tapped to talk keeps
    /// listening until a tap; one the host's switch held back talks again).
    static func toLobbyVoice(_ voice: VoiceChatManager) {
        voice.settings = nil
        voice.switchPending = nil
        voice.setForcedMuted([])
        voice.setDesiredMode(canTalk: true, wantsMic: voice.isActive ? voice.wantsMic : true)
    }

    /// GameContainerView's onDisappear: true (and the flag spent) when the table goes away
    /// for the lobby this game's end returned me to, so voice is not shut down. Any other way
    /// off the table, a stray lobbyCreated included, shuts it down as before.
    static func keepsVoice(lobbyState: LobbyState, appState: AppState) -> Bool {
        guard lobbyState.carriesVoice else { return false }
        lobbyState.carriesVoice = false
        return appState.screen == .gameLobby
    }
}
