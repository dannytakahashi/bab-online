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

    // Family lobbies (1.2.2, build 12): the additive keys of every lobby event, sent only to
    // a socket with the casualSpectators cap (GameManager.lobbyWire). `players` then holds
    // `members` (everyone, up to 8) instead of the first 4.
    /// How many the lobby may hold: 8 while every human in it is capable, else 4.
    @Published var capacity: Int = 4
    /// The lobby's host, "(host)" (nil: an older server, or a lobby with no human).
    @Published var host: String?
    /// settings.spectatorsCanTalk: always true since 2026-11-18 (no switch; read, never shown).
    @Published var spectatorsCanTalk: Bool = true
    /// A server that sends the family keys (`settings`): the lobby shows its voice line.
    @Published var hasSettings = false

    // Play again (1.2.2, build 12; server/socket/playAgain.js; `LobbyReturn`)
    /// The last game's older-app players whose place is saved without a row (`expected`, sent
    /// only while one stands: an event with `members` and no `expected` means none).
    @Published var expected: [String] = []
    /// The game whose end moved me back into this lobby (`lobbyReturn`) while that game's
    /// score screen is still up: its Return to Lobby enters this lobby instead of the main
    /// room. nil otherwise.
    @Published var returnFromGameId: String?
    /// Set by `LobbyReturn.enter` from the table: the game screen going away keeps voice
    /// running into the lobby (one shot; `LobbyReturn.keepsVoice` clears it).
    var carriesVoice = false

    /// The lobby's game (`mode` on every lobby event: 'gyb' for Get Your Bid; absent = the base
    /// game). Get Your Bid seats three: the family-lobby rules at 3, Add Bot up to 3.
    @Published var mode: GameMode = .classic
    /// Seats at the lobby's table (3 for Get Your Bid, else 4).
    var seats: Int { mode.seats }

    var playerCount: Int { players.count }
    var isFull: Bool { players.count >= capacity }
    /// Ready seats at the table, out of 4: ready members who play (every ready member of a
    /// lobby of 4 or fewer).
    var readyAtTable: Int { min(seats, players.filter { $0.isReady && $0.playing != false }.count) }
    /// The table has its 4 (3 for Get Your Bid: bots and the first to ready) in a bigger lobby.
    var tableFull: Bool { players.count > seats && LobbySeatStatus.tableFull(players, seats: seats) }

    /// My Ready would be refused: the table filled without me ("Table full — you'll watch").
    func tableFullWithout(_ username: String?) -> Bool {
        guard tableFull, let username else { return false }
        return players.first { $0.username == username && !$0.isBot }?.playing != true
    }

    func isHost(_ username: String?) -> Bool { username != nil && host == username }

    func reset() {
        lobbyId = ""
        lobbyName = ""
        mode = .classic
        players = []
        messages = []
        isReady = false
        reconnecting = []
        capacity = 4
        host = nil
        spectatorsCanTalk = true
        hasSettings = false
        expected = []
        returnFromGameId = nil
        carriesVoice = false
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
        // `members` (1.2.2 (12)): everyone, each held seat marked on its own entry; `players`
        // stops at 4 and names the held seats in `reconnecting`
        if let members = dict["members"] as? [[String: Any]] {
            let saved = dict["expected"] as? [String] ?? []
            if saved != expected { expected = saved }
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
        if let c = dict["capacity"] as? Int, (3...8).contains(c), c != capacity { capacity = c }
        // the mode rides on every lobby event of a Get Your Bid lobby (absent: kept, a lobby's
        // mode never changes; applyLobby sets it from lobbyCreated's body)
        if GameMode.from(dict["mode"]) == .gyb, mode != .gyb { mode = .gyb }
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

    /// lobbyCreated's body, also `lobbyReturn`'s lobby part: the id, the name, every member
    /// (held seats named), the chat (minus blocked senders), not ready.
    func applyLobby(_ dict: [String: Any], isBlocked: (String) -> Bool) {
        lobbyId = dict["lobbyId"] as? String ?? ""
        lobbyName = dict["lobbyName"] as? String ?? dict["name"] as? String ?? ""
        let newMode = GameMode.from(dict["mode"])
        if newMode != mode { mode = newMode }
        isReady = false
        applyPlayers(from: dict, namesHeldSeats: true)
        if let list = dict["messages"] as? [[String: Any]] {
            messages = list.compactMap { ChatMessage.from($0) }.filter { !isBlocked($0.username) }
        }
    }

    /// May send "Don't wait for <name>" (releaseLobbyHold): the host, or anyone present while
    /// the host is away (held), as the server allows (playAgain.releaseLobbyHold).
    func canRelease(_ username: String?) -> Bool {
        guard let username, players.contains(where: { $0.username == username && !$0.isBot && !$0.returning }) else { return false }
        if isHost(username) { return true }
        guard let host else { return false }
        return players.contains { $0.username == host && !$0.isBot && ($0.returning || reconnecting.contains(host)) }
    }

    /// Add Bot: below 4 members, counting the last game's saved places (the server refuses
    /// it while members + expected would reach 4).
    var canAddBot: Bool { players.count + expected.count < seats }
}
