import Foundation

/// State for the main room screen.
final class MainRoomState: ObservableObject {
    @Published var lobbies: [Lobby] = []
    @Published var inProgressGames: [Lobby] = []
    @Published var messages: [ChatMessage] = []
    @Published var onlineCount: Int = 0
    @Published var onlineUsers: [String] = []
    @Published var tournaments: [TournamentSummary] = []
    /// The unsent chat line (not @Published: it only seeds a recreated chat
    /// view, so a rotation or fold keeps what was typed).
    var chatDraft = ""

    func reset() {
        chatDraft = ""
        lobbies = []
        inProgressGames = []
        messages = []
        onlineCount = 0
        onlineUsers = []
        tournaments = []
    }
}
