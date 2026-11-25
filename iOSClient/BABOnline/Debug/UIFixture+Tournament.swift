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

    private static func systemLine(_ text: String, in tournament: TournamentState) {
        tournament.messages.append(ChatMessage(username: "System", message: text, type: .system, timestamp: Date()))
    }
}
#endif
