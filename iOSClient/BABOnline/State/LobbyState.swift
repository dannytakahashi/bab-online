import Foundation

/// State for a game lobby.
final class LobbyState: ObservableObject {
    @Published var lobbyId: String = ""
    @Published var lobbyName: String = ""
    @Published var players: [LobbyPlayer] = []
    @Published var messages: [ChatMessage] = []
    @Published var isReady: Bool = false
    /// The unsent chat line (survives a recreated view; not @Published).
    var chatDraft = ""
    /// The joinLobby a restore sent to take this lobby's seat back (`RestoreRoute.lobby`),
    /// until lobbyCreated or its refusal answers. The lobby's actions wait for it.
    @Published var rejoiningLobbyId: String?
    /// The socket that joinLobby went out on: one per socket.
    var rejoinSocketId: String?
    /// Bumped on every re-entry sent: the answer wait (`LobbyRejoin.answerWait`) acts only
    /// on its own one.
    var rejoinGeneration = 0
    /// A re-entry left before its answer (Leave, or the wait ran out; `LobbyRejoin.abandon`):
    /// its late lobbyCreated or refusal is dropped. Cleared by that answer, mainRoomJoined, or
    /// a restore on another socket (`rejoinSocketId` stays the abandoned one's).
    var abandonedRejoinLobbyId: String?

    var playerCount: Int { players.count }
    var isFull: Bool { players.count >= 4 }

    func reset() {
        lobbyId = ""
        lobbyName = ""
        players = []
        messages = []
        isReady = false
        chatDraft = ""
        rejoiningLobbyId = nil
        rejoinSocketId = nil
        abandonedRejoinLobbyId = nil
    }
}
