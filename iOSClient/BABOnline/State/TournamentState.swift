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
    @Published var activeGames: [TournamentActiveGame] = []
    @Published var creatorUsername: String = ""
    @Published var isSpectator: Bool = false
    @Published var isReady: Bool = false

    func reset() {
        tournamentId = ""
        name = ""
        phase = "lobby"
        currentRound = 0
        totalRounds = 4
        players = []
        messages = []
        scoreboard = []
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

        if let gamesArr = dict["activeGames"] as? [[String: Any]] {
            activeGames = gamesArr.compactMap { TournamentActiveGame.from($0) }
        }
    }
}
