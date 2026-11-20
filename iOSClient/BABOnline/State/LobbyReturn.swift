import Foundation
import SwiftUI

/// Play again (owner 2026-11-16; iOS 1.2.2, build 12; server/socket/playAgain.js): at the end
/// of a casual game a lobby started, the server moves this socket back into a recreated copy
/// of that lobby (new id; same name, host, settings, chat and lobby bots; nobody ready) and
/// says so with the private, unsequenced `lobbyReturn`, right after its `gameEnd`.
///
/// The owner's rule: the score screen stays exactly as it is, for players and spectators,
/// for as long as they want. So `lobbyReturn` changes no screen: the lobby is only kept in
/// `LobbyState` (`returnFromGameId`), and its later events (members, ready flags, chat) keep
/// it current behind the results. The existing "Return to Lobby" button (label unchanged)
/// then enters that lobby instead of the main room (`enterOnReturn`), and voice keeps
/// running from the game into the lobby (`keepsVoice`), where everyone may talk. Entering
/// tells the server (`lobbyReturnSeen`): until then it treats this socket as still on its
/// results (a drop is a 2-minute hold, not the 30 s reload grace; another device's main-room
/// join takes the seat; the next start of a lobby of more than 4 leaves it out with
/// leftLobby instead of making it a spectator, whose spectatorJoined would replace the results).
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

    /// The info toast when the lobby comes up (the web's words; toast audit 2026-11-18: it was
    /// spoken only): "Back in “X”. Tap Ready to play again.", or, when the others filled the
    /// table meanwhile (a family lobby: my Ready says "Table full — you'll watch"), "Back in
    /// “X”. The table is full; you'll watch this one."
    static func backInText(_ name: String, tableFull: Bool = false) -> String {
        let back = name.isEmpty ? "Back in your lobby." : "Back in \u{201C}\(name)\u{201D}."
        return tableFull ? "\(back) The table is full; you'll watch this one." : "\(back) Tap Ready to play again."
    }

    /// The toast, read at high priority: VoiceOver's own speech for the new screen (the
    /// Return to Lobby the person activated is gone, so focus moves into the lobby) would
    /// otherwise cut a default one off.
    static func backInNotice(_ name: String, tableFull: Bool = false) -> ServerErrorNotice {
        ServerErrorNotice(message: backInText(name, tableFull: tableFull), kind: .info, urgent: true)
    }

    /// The toast waits for the screen change (ContentView animates it over 0.3 s); posted in
    /// the same tick, the lobby did not exist yet.
    static let announceDelay: TimeInterval = 0.6

    /// Tells the server this socket left the results for the lobby (tests replace it).
    static var sendSeen: @MainActor () -> Void = { LobbyEmitter.lobbyReturnSeen() }
    /// Runs the announcement later and posts it (tests replace them).
    static var announceLater: (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, work in
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated { work() } }
    }
    static var post: @MainActor (ServerErrorNotice) -> Void = { SocketService.shared.serverError = $0 }

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
    static func enterOnReturn(lobbyState: LobbyState, appState: AppState, gameState: GameState,
                              voice: VoiceChatManager? = nil) -> Bool {
        guard let gameId = lobbyState.returnFromGameId, gameId == gameState.gameId, !lobbyState.lobbyId.isEmpty else {
            return false
        }
        enter(lobbyState: lobbyState, appState: appState, gameState: gameState, voice: voice)
        return true
    }

    /// The lobby screen for the lobby in `lobbyState`. From the table, voice carries on (the
    /// calls with the others who came back are kept by the server) with the person's mute as
    /// it was (toLobbyVoice).
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
        // the server has had this socket in the lobby since the game's end; now it knows the
        // person is looking at it (playAgain.settle)
        sendSeen()
        let lobbyId = lobbyState.lobbyId, name = lobbyState.lobbyName
        let me = SocketService.shared.authState?.username ?? gameState.username
        announceLater(announceDelay) { [weak appState, weak lobbyState] in
            guard appState?.screen == .gameLobby, let lobbyState, lobbyState.lobbyId == lobbyId else { return }
            post(backInNotice(name, tableFull: lobbyState.tableFullWithout(me)))
        }
        print("[Lobby] Entered lobby \(lobbyId) after the game")
    }

    /// Into the lobby: the game's voice settings go; the session, its calls and the person's
    /// mute carry on (owner 2026-11-19: "once you unmute in a session it should stay unmuted";
    /// build 16 to 1.2.3 (20) muted again here). The allowed mic and its track are kept.
    static func toLobbyVoice(_ voice: VoiceChatManager) {
        voice.settings = nil
    }

    /// GameContainerView's onDisappear: the table went away. Voice carries on into the lobby
    /// this game's end returned me to (`keepsVoice`: its calls and buffered signals stay);
    /// any other way off the table shuts it down. `lobbyState` nil (no link in the
    /// environment): shut down, as before 1.2.2 (12).
    static func tableGone(lobbyState: LobbyState?, appState: AppState, voice: VoiceChatManager) {
        if let lobbyState, keepsVoice(lobbyState: lobbyState, appState: appState) {
            print("[Voice] Kept into the lobby after the game")
            return
        }
        voice.shutdown()
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

/// The app's `LobbyState` for views that only use it inside callbacks (GameScreen's
/// onDisappear, GameEndView's Return to Lobby). Read as a plain environment value it does not
/// subscribe the view to the lobby's changes, as an @EnvironmentObject would: the lobby kept
/// behind the score screen publishes every chat line and ready flag, which then rebuilt the
/// whole table view (its SpriteView host) and the score card for nothing on screen.
struct LobbyStateLink {
    let state: LobbyState?
}

private struct LobbyStateLinkKey: EnvironmentKey {
    static let defaultValue = LobbyStateLink(state: nil)
}

extension EnvironmentValues {
    /// Set at the root (BABOnlineApp, PreviewFixtures); nil elsewhere (no play-again return).
    var lobbyStateLink: LobbyStateLink {
        get { self[LobbyStateLinkKey.self] }
        set { self[LobbyStateLinkKey.self] = newValue }
    }
}
