#if DEBUG
import SwiftUI

/// Tournament extras for iOS 1.2.7 (41) in fixture mode (no socket, no server):
/// - `tournament-rounds`: the tournament lobby before Begin, me (ivy) the host unless `-uiHost
///   <name>`, four members with their empty scoreboard rows (as tournamentPlayerJoined sends them),
///   `-uiRounds <1...5>` the count at the start (default 4). A pick sends setTournamentRounds,
///   shown in "fixture.sent" as `setTournamentRounds:<n>` and answered as the server does: the
///   system line "ivy set the tournament to 3 rounds." 0.3 s later (`-uiRoundsRefuse YES`: the
///   server's refusal toast and its count back instead, as a hand-off race would).
///   `-uiSettingsFrom <host>:<n>`: 1.5 s after launch that host's tournamentSettingsUpdated
///   reaches me (a member), with its system line.
/// - `-uiVoiceFull <cap>` on any tournament lobby fixture: the over-cap notice (s2c
///   tournamentVoiceStatus {admitted: false, cap}); `-uiVoiceAdmit <seconds>`: then
///   `{admitted: true}` that long after launch.
/// - Any tournament lobby fixture: `-uiHost <name>`, `-uiMeReady YES|NO`, `-uiAllReady YES`
///   (`seedTournamentRoles`); Ready / Unready / Begin / Cancel / Leave show in "fixture.sent" by
///   their event names, and Ready / Unready update my row as the server's answer would.
/// - Any tournament lobby fixture: `-uiHandOffOnAlert <name>`: 3 s after Leave / Cancel
///   Tournament / Stop Watching's confirmation alert opens, the host role passes to that member (as
///   tournamentPlayerLeft's `newCreator` would), once: Cancel's alert goes, Leave's says the new
///   consequence in place.
extension UIFixture {
    static weak var fixtureTournament: TournamentState?

    @MainActor
    static func seedTournamentRounds(_ appState: AppState, tournament: TournamentState, auth: AuthState) {
        auth.username = "ivy"
        let host = UserDefaults.standard.string(forKey: "uiHost") ?? "ivy"
        let names = ["kim", "ivy", "hal", "jon"]
        tournament.tournamentId = "t1"
        tournament.name = "Sunday Cup"
        tournament.phase = "lobby"
        tournament.creatorUsername = host
        tournament.totalRounds = TournamentRounds.count(UserDefaults.standard.integer(forKey: "uiRounds"))
            ?? TournamentRounds.defaultCount
        tournament.players = names.map {
            TournamentPlayer(id: "sid-\($0)", username: $0, pic: nil, isReady: $0 == "kim" || $0 == "hal",
                             isCreator: $0 == host, connected: true)
        }
        tournament.scoreboard = names.sorted().map { TournamentScoreEntry(id: $0, username: $0, totalScore: 0, roundScores: []) }
        tournament.messages = [
            ChatMessage(username: "kim", message: "how many rounds tonight?", type: .player, timestamp: Date().addingTimeInterval(-90)),
            ChatMessage(username: "hal", message: "3 is plenty", type: .player, timestamp: Date().addingTimeInterval(-60)),
        ]
        appState.screen = .tournamentLobby
        if let from = UserDefaults.standard.string(forKey: "uiSettingsFrom") {
            let parts = from.split(separator: ":").map(String.init)
            if parts.count == 2, let n = Int(parts[1]) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    // what TournamentSocketHandler.handleSettingsUpdated does, then the room's line
                    if tournament.applyTotalRounds(n) { systemLine(TournamentRounds.changedLine(by: parts[0], to: n), in: tournament) }
                }
            }
        }
    }

    /// Any tournament lobby fixture: `-uiVoiceFull <cap>` / `-uiVoiceAdmit <seconds>`.
    @MainActor
    static func seedTournamentExtras(_ tournament: TournamentState) {
        fixtureTournament = tournament
        guard let raw = UserDefaults.standard.string(forKey: "uiVoiceFull"), let cap = Int(raw) else { return }
        tournament.voiceFullCap = TournamentVoice.roomCap(cap) ?? 0
        let admit = UserDefaults.standard.double(forKey: "uiVoiceAdmit")
        if admit > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + admit) { tournament.voiceFullCap = nil }
        }
    }

    /// setTournamentRounds in fixture mode: the "fixture.sent" entry, answered as the server does.
    static func tournamentRoundsSent(_ data: [String: Any]) -> String {
        let n = data["totalRounds"] as? Int
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            guard let tournament = fixtureTournament, let n else { return }
            if UserDefaults.standard.bool(forKey: "uiRoundsRefuse") {
                SocketService.shared.serverError = ServerErrorNotice(message: "Only the host can change the number of rounds")
                tournament.totalRounds = TournamentRounds.defaultCount
                return
            }
            systemLine(TournamentRounds.changedLine(by: tournament.creatorUsername, to: n), in: tournament)
        }
        return "setTournamentRounds:\(n.map(String.init) ?? "-")"
    }

    /// My username in a tournament lobby fixture (the ready emulation's row).
    static var fixtureMe: String?

    /// Any tournament lobby fixture: `-uiHost <name>` makes that member the host (the lobby and
    /// between-rounds fixtures; `tournament-rounds` / `tournament-deadline` read it themselves),
    /// `-uiMeReady YES|NO` sets my ready flag (my row and the button), `-uiAllReady YES` readies
    /// every connected member (the host's Begin).
    @MainActor
    static func seedTournamentRoles(_ tournament: TournamentState, me: String?) {
        fixtureMe = me
        let d = UserDefaults.standard
        if let host = d.string(forKey: "uiHost"), tournament.players.contains(where: { $0.username == host }) {
            tournament.creatorUsername = host
            tournament.players = tournament.players.map { var p = $0; p.isCreator = p.username == host; return p }
        }
        if d.bool(forKey: "uiAllReady") {
            tournament.players = tournament.players.map { var p = $0; if p.connected { p.isReady = true }; return p }
        }
        if let raw = d.string(forKey: "uiMeReady") {
            let ready = raw == "YES"
            tournament.players = tournament.players.map { var p = $0; if p.username == me { p.isReady = ready }; return p }
        }
        if let mine = tournament.players.first(where: { $0.username == me }) { tournament.isReady = mine.isReady }
    }

    /// The tournament lobby's sends in fixture mode ("fixture.sent": tournamentReady,
    /// tournamentUnready, beginTournament, beginNextRound, cancelTournament, leaveTournament);
    /// ready / unready are answered as the server's tournamentReadyUpdate (my row follows).
    static func tournamentActionSent(_ event: String) -> String? {
        let ready: Bool?
        switch event {
        case SocketEvents.Client.tournamentReady: ready = true
        case SocketEvents.Client.tournamentUnready: ready = false
        case SocketEvents.Client.beginTournament, SocketEvents.Client.beginNextRound,
             SocketEvents.Client.cancelTournament, SocketEvents.Client.leaveTournament: ready = nil
        default: return nil
        }
        if let ready {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                guard let tournament = fixtureTournament else { return }
                let me = fixtureMe
                tournament.players = tournament.players.map { var p = $0; if p.username == me { p.isReady = ready }; return p }
            }
        }
        return event
    }

    private static var handOffDriven = false

    /// The tournament lobby's confirmation alert opened (`-uiHandOffOnAlert <name>`).
    @MainActor
    static func tournamentConfirmPresented() {
        guard isActive, !handOffDriven, let to = UserDefaults.standard.string(forKey: "uiHandOffOnAlert") else { return }
        handOffDriven = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {  // after the test read the first words
            guard let tournament = fixtureTournament, tournament.players.contains(where: { $0.username == to }) else { return }
            tournament.creatorUsername = to
            tournament.players = tournament.players.map { var p = $0; p.isCreator = p.username == to; return p }
        }
    }

    private static func systemLine(_ text: String, in tournament: TournamentState) {
        tournament.messages.append(ChatMessage(username: "System", message: text, type: .system, timestamp: Date()))
    }
}
#endif
