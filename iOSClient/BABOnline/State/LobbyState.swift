import Foundation

/// State for a game lobby.
final class LobbyState: ObservableObject {
    @Published var lobbyId: String = ""
    @Published var lobbyName: String = ""
    @Published var players: [LobbyPlayer] = []
    @Published var messages: [ChatMessage] = []
    @Published var isReady: Bool = false
    /// Players whose seat the server holds while they reconnect (LOBBY_SEAT_GRACE_MS, 30 s):
    /// the additive `reconnecting` list on playerReadyUpdate / lobbyCreated (absent: none, or
    /// an older server). Their rows show "Reconnecting…" (web GameLobby.js).
    @Published var reconnecting: Set<String> = []
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
        reconnecting = []
        chatDraft = ""
        rejoiningLobbyId = nil
        rejoinSocketId = nil
        abandonedRejoinLobbyId = nil
    }

    /// The server's player list, with the web's held-seat rule (`updateLobbyPlayersList`):
    /// an event that names the held seats replaces the set (`reconnecting`; playerReadyUpdate
    /// passes [] when the field is absent, since every one carries it while a seat is held),
    /// a player back in their seat leaves it (`returned`: lobbyPlayerJoined.newPlayer), and
    /// so does anyone no longer in the list.
    func setPlayers(_ list: [LobbyPlayer], reconnecting names: [String]? = nil, returned: String? = nil) {
        players = list
        var held = names.map { Set($0) } ?? reconnecting
        if let returned { held.remove(returned) }
        held.formIntersection(list.map(\.username))
        if held != reconnecting { reconnecting = held }
    }

    /// A lobby event's `players` (none: nothing changes). `namesHeldSeats`: lobbyCreated and
    /// playerReadyUpdate carry `reconnecting` while a seat is held, so without the field no
    /// seat is; lobbyPlayerJoined names the player who came back (`newPlayer`).
    func applyPlayers(from dict: [String: Any], namesHeldSeats: Bool) {
        guard let list = dict["players"] as? [[String: Any]] else { return }
        setPlayers(list.compactMap { LobbyPlayer.from($0) },
                   reconnecting: namesHeldSeats ? (dict["reconnecting"] as? [String] ?? []) : nil,
                   returned: (dict["newPlayer"] as? [String: Any])?["username"] as? String)
    }

    /// A human seat that is not ready and is held for its player shows "Reconnecting…".
    func isReconnecting(_ player: LobbyPlayer) -> Bool {
        !player.isReady && !player.isBot && reconnecting.contains(player.username)
    }
}
