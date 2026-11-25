import SwiftUI

/// Voice in a tournament (owner 2026-11-24, iOS 1.2.6: "in a tournament nobody had voice even
/// with two humans at one table"; decisions: whole-table voice, and the tournament lobby and the
/// time between rounds are a voice room too). docs/claude/voice.md "iOS tournament voice";
/// server: server/voice/tournamentVoice.js.
///
/// Two rooms, one at a time:
/// - the table (`game:<id>`): as every game. The server announces the table's humans to each
///   other at the seating, right after positionUpdate; the table screen starts voice once
///   positionUpdate shows another human, or at once when one of them offers first
///   (`VoiceGate.peerOffered`).
/// - the tournament room (`tournament:<id>`): the members on the tournament lobby screen (the
///   lobby phase, between rounds, sitting a round out, back from a finished table, the
///   results), entered at tournamentCreated / tournamentJoined, left when seated at a round's
///   table. Only for a socket that sent the clientHello cap `tournamentVoice` (`cap`). The
///   tournament lobby wants voice (a member, never a spectator) and its company is who the
///   server announced there (`VoiceChatManager.tournamentPeers`), as on the web.
///
/// The room changes in the socket's event order, not at a screen's onAppear / onDisappear
/// (SwiftUI may run those after the new room's announcements arrived, and a teardown then would
/// drop them): tournamentCreated / tournamentJoined and tournamentGameAssignment end every call
/// and buffered signal of the old room (`VoiceChatManager.changeRoom`, wanted kept), the new
/// room's announcements follow, and the new screen's voice starts with its company (muted, or
/// unmuted after an unmute by hand this app run: session mute). The screens' exits only end
/// voice when the next screen is not a room of this tournament (`lobbyGone`, `tableGone`).
enum TournamentVoice {
    /// The clientHello cap (contract `$defs.clientCapTournamentVoice`, added on the
    /// voice/tournament branch; server/voice/tournamentVoice.js `CAP`). TODO(contract): the
    /// contract generator emits no Swift constant for caps today (every cap in
    /// `ClientHello.caps` is a literal, `ShoulderRules.cap` too); if the merged contract adds one
    /// to SocketEvents.swift, use it here.
    static let cap = "tournamentVoice"

    /// The tournament lobby wants voice: a member's (a spectator is not in the room).
    static func wantsVoice(_ tournament: TournamentState) -> Bool {
        !tournament.tournamentId.isEmpty && !tournament.isSpectator
    }

    /// What the tournament lobby reports to the gate: its `.onChange(of:initial:)` key, so the
    /// room change counts too, not only the company. A room change (`changeRoom`) clears the
    /// gate's word, and the lobby must say it again even when the company reads the same before
    /// and after: a reconnect with the lobby on screen (the restore's joinTournament answers
    /// tournamentJoined, the room's voicePeerList names the same members again, both before
    /// the next render, and the screen stays mounted) left the gate with no word, so voice
    /// never started and the buffered peers were never offered to (review 2026-11-24).
    @MainActor
    static func lobbyWord(_ voice: VoiceChatManager, me: String?) -> LobbyWord {
        LobbyWord(room: voice.roomChanges, company: voice.tournamentCompany(me: me))
    }

    struct LobbyWord: Equatable {
        /// `VoiceChatManager.roomChanges` (every room change, so every one is reported).
        var room: Int
        var company: Bool
    }

    /// The tournament lobby went away. To a table I sit at (its room change came with the
    /// round's tournamentGameAssignment): nothing more, the table's voice starts with its
    /// company. Anywhere else (the main room after Leave, a cancel or the results' Return; a
    /// table I only watch, which admits no spectator into voice): voice ends.
    @MainActor
    static func lobbyGone(screen: AppState.Screen, watching: Bool, voice: VoiceChatManager) {
        voice.clearCompany(from: .tournament)
        if screen == .game && !watching { return }
        voice.shutdown()
    }

    /// A table went away. Back in the tournament lobby as a member (its room change came with
    /// tournamentJoined, and the room's announcements may be buffered already): voice is kept
    /// wanted and nothing is torn down (true: the caller skips its shutdown). Else false.
    @MainActor
    static func tableGone(screen: AppState.Screen, tournament: TournamentState?, voice: VoiceChatManager) -> Bool {
        guard screen == .tournamentLobby, let tournament, wantsVoice(tournament) else { return false }
        voice.clearCompany(from: .table)
        voice.ensureStarted()
        return true
    }
}

/// The app's `TournamentState` for the table's onDisappear only (not observed: the tournament's
/// chat and scoreboard must not rebuild the table view; the `LobbyStateLink` pattern).
struct TournamentStateLink {
    let state: TournamentState?
}

private struct TournamentStateLinkKey: EnvironmentKey {
    static let defaultValue = TournamentStateLink(state: nil)
}

extension EnvironmentValues {
    /// Set at the root (BABOnlineApp); nil elsewhere.
    var tournamentStateLink: TournamentStateLink {
        get { self[TournamentStateLinkKey.self] }
        set { self[TournamentStateLinkKey.self] = newValue }
    }
}
