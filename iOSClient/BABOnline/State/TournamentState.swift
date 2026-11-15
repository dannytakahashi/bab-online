import Foundation

/// State for the tournament lobby screen.
final class TournamentState: ObservableObject {
    @Published var tournamentId: String = ""
    @Published var name: String = ""
    @Published var phase: String = "lobby"      // lobby, round_active, between_rounds, complete
    @Published var currentRound: Int = 0
    @Published var totalRounds: Int = 4
    @Published var players: [TournamentPlayer] = []
    @Published var messages: [ChatMessage] = []
    @Published var scoreboard: [TournamentScoreEntry] = []
    @Published var winners: [String] = []
    @Published var activeGames: [TournamentActiveGame] = []
    @Published var creatorUsername: String = ""
    @Published var isSpectator: Bool = false
    @Published var isReady: Bool = false
    /// The unsent chat line (survives a recreated view; not @Published).
    var chatDraft = ""
    /// The joinTournament a restore sent for the tournament lobby on screen
    /// (`RestoreRoute.tournamentLobby`), until tournamentJoined or its refusal answers. The
    /// lobby's actions wait for it.
    @Published var rejoiningTournamentId: String?
    /// The socket that joinTournament went out on: one per socket.
    var rejoinSocketId: String?
    /// Bumped on every re-entry sent: the answer wait (`TournamentRejoin.answerWait`) acts
    /// only on its own one.
    var rejoinGeneration = 0
    /// A re-entry left before its answer (Leave, or the wait ran out; `TournamentRejoin.abandon`):
    /// its late tournamentJoined or refusal is dropped. Cleared by that answer, tournamentLeft,
    /// the next mainRoomJoined, or a restore on another socket (`rejoinSocketId` stays the abandoned one's).
    var abandonedRejoinTournamentId: String?

    func reset() {
        chatDraft = ""
        rejoiningTournamentId = nil
        rejoinSocketId = nil
        abandonedRejoinTournamentId = nil
        tournamentId = ""
        name = ""
        phase = "lobby"
        currentRound = 0
        totalRounds = 4
        players = []
        messages = []
        scoreboard = []
        winners = []
        activeGames = []
        creatorUsername = ""
        isSpectator = false
        isReady = false
    }

    func loadFromServerState(_ dict: [String: Any]) {
        tournamentId = dict["tournamentId"] as? String ?? ""
        name = dict["name"] as? String ?? ""
        phase = dict["phase"] as? String ?? "lobby"
        currentRound = dict["currentRound"] as? Int ?? 0
        totalRounds = dict["totalRounds"] as? Int ?? 4
        creatorUsername = dict["creatorUsername"] as? String ?? ""
        isSpectator = dict["isSpectator"] as? Bool ?? false

        if let playersArr = dict["players"] as? [[String: Any]] {
            players = playersArr.compactMap { TournamentPlayer.from($0) }
        }

        if let messagesArr = dict["messages"] as? [[String: Any]] {
            messages = messagesArr.compactMap { ChatMessage.from($0) }
        }

        if let scoreboardArr = dict["scoreboard"] as? [[String: Any]] {
            scoreboard = scoreboardArr.compactMap { TournamentScoreEntry.from($0) }
        }

        winners = dict["winners"] as? [String] ?? []

        if let gamesArr = dict["activeGames"] as? [[String: Any]] {
            activeGames = gamesArr.compactMap { TournamentActiveGame.from($0) }
        }
    }
}
