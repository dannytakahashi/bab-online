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

    // Family lobbies (1.2.3, build 12): the additive keys of every lobby event, sent only to
    // a socket with the casualSpectators cap (GameManager.lobbyWire). `players` then holds
    // `members` (everyone, up to 8) instead of the first 4.
    /// How many the lobby may hold: 8 while every human in it is capable, else 4.
    @Published var capacity: Int = 4
    /// Who sets "Spectators can talk" (nil: an older server, or a lobby with no human).
    @Published var host: String?
    /// The host's "Spectators can talk" (default on).
    @Published var spectatorsCanTalk: Bool = true
    /// A server that sends the family keys (`settings`): the lobby shows its Voice section.
    @Published var hasSettings = false

    var playerCount: Int { players.count }
    var isFull: Bool { players.count >= capacity }
    /// Ready seats at the table, out of 4: ready members who play (every ready member of a
    /// lobby of 4 or fewer).
    var readyAtTable: Int { min(4, players.filter { $0.isReady && $0.playing != false }.count) }
    /// The table has its 4 (bots and the first to ready) in a lobby of more than 4.
    var tableFull: Bool { players.count > 4 && LobbySeatStatus.tableFull(players) }

    /// My Ready would be refused: the table filled without me ("Table full — you'll watch").
    func tableFullWithout(_ username: String?) -> Bool {
        guard tableFull, let username else { return false }
        return players.first { $0.username == username && !$0.isBot }?.playing != true
    }

    func isHost(_ username: String?) -> Bool { username != nil && host == username }

    func reset() {
        lobbyId = ""
        lobbyName = ""
        players = []
        messages = []
        isReady = false
        reconnecting = []
        capacity = 4
        host = nil
        spectatorsCanTalk = true
        hasSettings = false
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
        applyFamilyKeys(from: dict)
        // `members` (1.2.3): everyone, each held seat marked on its own entry; `players`
        // stops at 4 and names the held seats in `reconnecting`
        if let members = dict["members"] as? [[String: Any]] {
            setPlayers(members.compactMap { LobbyPlayer.from($0) },
                       reconnecting: members.compactMap { $0["reconnecting"] as? Bool == true ? $0["username"] as? String : nil })
            return
        }
        guard let list = dict["players"] as? [[String: Any]] else { return }
        setPlayers(list.compactMap { LobbyPlayer.from($0) },
                   reconnecting: namesHeldSeats ? (dict["reconnecting"] as? [String] ?? []) : nil,
                   returned: (dict["newPlayer"] as? [String: Any])?["username"] as? String)
    }

    /// `capacity`, `host`, `settings` of a lobby event (each kept when absent: an event of an
    /// older server, or one that does not carry them).
    func applyFamilyKeys(from dict: [String: Any]) {
        if let c = dict["capacity"] as? Int, (4...8).contains(c), c != capacity { capacity = c }
        if let h = dict["host"] as? String, h != host { host = h }
        if let settings = dict["settings"] as? [String: Any] {
            if !hasSettings { hasSettings = true }
            if let talk = settings["spectatorsCanTalk"] as? Bool, talk != spectatorsCanTalk { spectatorsCanTalk = talk }
        }
    }

    /// A human seat that is not ready and is held for its player shows "Reconnecting…".
    func isReconnecting(_ player: LobbyPlayer) -> Bool {
        !player.isReady && !player.isBot && reconnecting.contains(player.username)
    }
}
