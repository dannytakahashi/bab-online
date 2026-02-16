import Foundation

/// State for a game lobby.
final class LobbyState: ObservableObject {
    @Published var lobbyId: String = ""
    @Published var lobbyName: String = ""
    @Published var players: [LobbyPlayer] = []
    @Published var messages: [ChatMessage] = []
    @Published var isReady: Bool = false

    var playerCount: Int { players.count }
    var isFull: Bool { players.count >= 4 }

    func reset() {
        lobbyId = ""
        lobbyName = ""
        players = []
        messages = []
        isReady = false
    }
}
