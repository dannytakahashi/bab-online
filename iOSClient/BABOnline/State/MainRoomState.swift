import Foundation

/// State for the main room screen.
final class MainRoomState: ObservableObject {
    @Published var lobbies: [Lobby] = []
    @Published var inProgressGames: [Lobby] = []
    @Published var messages: [ChatMessage] = []
    @Published var onlineCount: Int = 0
    @Published var onlineUsers: [String] = []
    @Published var tournaments: [TournamentSummary] = []

    func reset() {
        lobbies = []
        inProgressGames = []
        messages = []
        onlineCount = 0
        onlineUsers = []
        tournaments = []
    }
}
