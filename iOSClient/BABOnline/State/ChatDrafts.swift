import Foundation

/// The unsent chat lines live in the state objects so a rotation or a fold
/// keeps them (item 27); they must not outlive their context. ContentView
/// calls this on every screen change:
/// - back to sign-in / register (sign-out, forced logout, account deletion):
///   every draft goes, so the next account on the device never sees one;
/// - leaving the game lobby (game start, leave): the lobby draft goes;
/// - leaving the tournament lobby for anything but its own game: the tournament draft goes;
/// - leaving the game (end, leave, abort): the game log draft goes.
enum ChatDrafts {
    @MainActor
    static func screenChanged(from old: AppState.Screen, to new: AppState.Screen,
                              mainRoom: MainRoomState, lobby: LobbyState, tournament: TournamentState, game: GameState) {
        guard old != new else { return }
        if new == .signIn || new == .register {
            mainRoom.chatDraft = ""
            lobby.chatDraft = ""
            tournament.chatDraft = ""
            game.chatDraft = ""
            return
        }
        if old == .gameLobby { lobby.chatDraft = "" }
        if old == .tournamentLobby && new != .game { tournament.chatDraft = "" }
        if old == .game { game.chatDraft = "" }
    }
}
