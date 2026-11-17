import Foundation

struct Lobby: Identifiable, Equatable {
    let id: String
    let name: String
    var players: [LobbyPlayer]
    var playerCount: Int
    var isInProgress: Bool = false
    /// In-progress games only (`inProgressGame`: currentHand, score, spectatorCount, the
    /// players' positions), each read optionally: the web card's "Hand: N", the two teams'
    /// scores and "N watching".
    var progress: GameProgress? = nil
    /// Family lobbies (1.2.2, build 12; additive `$defs.lobby` keys the server sends only to a
    /// socket with the casualSpectators cap): every member's count (`playerCount` stays at
    /// most 4), how many the lobby may hold (8 while every human in it is capable, else 4)
    /// and every member's name. nil: an older server (at most 4; `players` is everyone).
    var memberCount: Int? = nil
    var capacity: Int? = nil
    var memberUsernames: [String]? = nil

    /// Everyone in the lobby: `memberCount` when the server sent it, else `playerCount`.
    var members: Int { memberCount ?? playerCount }
    /// How many the lobby may hold: `capacity` when sent, else 4.
    var seatsTotal: Int { capacity ?? 4 }
    /// The card's count: "3/8", "4/4".
    var countText: String { "\(members)/\(seatsTotal)" }

    /// The members' names, as the web's lobby card lists them (the main-room list carries
    /// no isBot: a bot shows under the server's "🤖 Bot" name there too): every member of
    /// a family lobby (`memberUsernames`), else `players` (at most 4).
    var memberNames: String { (memberUsernames ?? players.map(\.username)).joined(separator: ", ") }

    /// Is `username` a member here (a held seat included: the server keeps it in the list).
    /// `memberUsernames` also names members 5 to 8, whom `players` (at most 4) leaves out.
    func seats(_ username: String?) -> Bool {
        guard let username, !username.isEmpty else { return false }
        if let memberUsernames { return memberUsernames.contains(username) }
        return players.contains { $0.username == username }
    }

    /// The waiting lobby card's control, as the web's `lobbyActionButton` (MainRoom.js):
    /// Join below the lobby's capacity, Rejoin a full lobby that still seats me (joinLobby
    /// moves my seat to this socket), else a disabled Full.
    enum Action: Equatable { case join, rejoin, full }

    func action(for username: String?) -> Action {
        if members < seatsTotal { return .join }
        return seats(username) ? .rejoin : .full
    }

    static func from(_ dict: [String: Any]) -> Lobby? {
        guard let id = dict["id"] as? String ?? dict["lobbyId"] as? String ?? dict["gameId"] as? String else { return nil }

        // Name is optional — in-progress games don't have one, so generate from players
        let name: String
        if let n = dict["name"] as? String {
            name = n
        } else if let pArr = dict["players"] as? [[String: Any]] {
            let names = pArr.compactMap { $0["username"] as? String }
            if names.count == 4 {
                name = "\(names[0]) & \(names[2]) vs \(names[1]) & \(names[3])"
            } else {
                name = names.joined(separator: ", ")
            }
        } else {
            name = "Game \(id.prefix(4))"
        }

        let playerCount = dict["playerCount"] as? Int ?? (dict["players"] as? [[String: Any]])?.count ?? 0
        let isInProgress = dict["inProgress"] as? Bool ?? false

        var players: [LobbyPlayer] = []
        if let pArr = dict["players"] as? [[String: Any]] {
            players = pArr.compactMap { LobbyPlayer.from($0) }
        }

        return Lobby(id: id, name: name, players: players, playerCount: playerCount, isInProgress: isInProgress,
                     progress: GameProgress.from(dict),
                     memberCount: (dict["memberCount"] as? Int).map { max(0, $0) },
                     capacity: (dict["capacity"] as? Int).flatMap { (4...8).contains($0) ? $0 : nil },
                     memberUsernames: (dict["memberUsernames"] as? [Any])?.compactMap { $0 as? String })
    }
}

/// What the main room shows of a game in progress (`getInProgressGames`).
struct GameProgress: Equatable {
    var currentHand: Int?
    /// Team 1 is seats 1 and 3, team 2 seats 2 and 4.
    var team1Score: Int?
    var team2Score: Int?
    var team1Names: [String] = []
    var team2Names: [String] = []
    var spectatorCount: Int = 0

    /// nil when the entry carries none of it (a waiting lobby, an older server).
    static func from(_ dict: [String: Any]) -> GameProgress? {
        let score = dict["score"] as? [String: Any]
        var p = GameProgress(currentHand: dict["currentHand"] as? Int,
                             team1Score: score?["team1"] as? Int, team2Score: score?["team2"] as? Int,
                             spectatorCount: max(0, dict["spectatorCount"] as? Int ?? 0))
        for player in dict["players"] as? [[String: Any]] ?? [] {
            guard let name = player["username"] as? String, let position = player["position"] as? Int else { continue }
            if position == 1 || position == 3 { p.team1Names.append(name) } else if position == 2 || position == 4 { p.team2Names.append(name) }
        }
        let empty = p.currentHand == nil && p.team1Score == nil && p.team2Score == nil && p.spectatorCount == 0
        return empty ? nil : p
    }

    var handText: String? { currentHand.map { "Hand \($0)" } }
    /// "a/c: 120", as the web card (nil without a score or the team's names).
    func teamText(_ team: Int) -> String? {
        let names = team == 2 ? team2Names : team1Names
        guard let score = team == 2 ? team2Score : team1Score, !names.isEmpty else { return nil }
        return "\(names.joined(separator: "/")): \(score)"
    }
    var watchingText: String? { spectatorCount > 0 ? "\(spectatorCount) watching" : nil }

    /// VoiceOver: "Hand 5. a and c 120, b and d 85. 2 watching".
    var spokenSummary: String {
        var parts: [String] = []
        if let handText { parts.append(handText) }
        let teams = [(team1Names, team1Score), (team2Names, team2Score)].compactMap { names, score in
            score.flatMap { s in names.isEmpty ? nil : "\(names.joined(separator: " and ")) \(s)" }
        }
        if !teams.isEmpty { parts.append(teams.joined(separator: ", ")) }
        if let watchingText { parts.append(watchingText) }
        return parts.joined(separator: ". ")
    }
}

struct LobbyPlayer: Identifiable, Equatable {
    let id: String          // socket ID
    let username: String
    var pic: String?
    var isReady: Bool
    var isBot: Bool
    /// A family lobby's member (`members[].playing`, 1.2.2 (12)): seated at the table right now
    /// (the table bots and the first humans to ready, up to 4; every member of a lobby of 4
    /// or fewer). nil: an entry from `players` (an older server).
    var playing: Bool? = nil
    /// A place held for someone not back from the last game yet (`members[].returning`, play
    /// again, 1.2.2 (12)): a row with no socket ("Not back yet"; "Don't wait for <name>").
    var returning: Bool = false
    /// Back in the lobby, connected, but the app still shows the last game's results
    /// (`members[].onResults`, play again; the server's afterGame.unsettled: no
    /// lobbyReturnSeen yet): "Still on the results" on the others' screens.
    var onResults: Bool = false

    static func from(_ dict: [String: Any]) -> LobbyPlayer? {
        guard let username = dict["username"] as? String else { return nil }
        let id = dict["socketId"] as? String ?? dict["id"] as? String ?? UUID().uuidString
        let pic = picString(from: dict["pic"])
        let isReady = dict["isReady"] as? Bool ?? dict["ready"] as? Bool ?? false
        let isBot = dict["isBot"] as? Bool ?? false
        return LobbyPlayer(id: id, username: username, pic: pic, isReady: isReady, isBot: isBot,
                           playing: dict["playing"] as? Bool, returning: dict["returning"] as? Bool == true,
                           onResults: dict["onResults"] as? Bool == true)
    }

    /// The row says "Still on the results": someone else's human row, not ready, not held
    /// (a held row says "Not back yet" or "Reconnecting…").
    func showsOnResults(isCurrentUser: Bool, isReconnecting: Bool) -> Bool {
        onResults && !isCurrentUser && !isBot && !isReady && !returning && !isReconnecting
    }
}

/// What a family lobby's row says about its member (1.2.2 (12); the web's GameLobby rows):
/// "Playing" (seated at the table), "Will watch" (the table is full without them: they
/// spectate the game), "Sitting out" (a bot no human seat needs). nil: nothing to say (a
/// lobby of 4 or fewer, where everyone plays, or a human who may still take a seat).
enum LobbySeatStatus: String, Equatable {
    case playing = "Playing"
    case willWatch = "Will watch"
    case sittingOut = "Sitting out"

    /// `members`: the whole list; the statuses show only in a lobby of more than 4.
    static func of(_ player: LobbyPlayer, in members: [LobbyPlayer]) -> LobbySeatStatus? {
        guard members.count > 4, let playing = player.playing else { return nil }
        if playing { return .playing }
        if player.isBot { return .sittingOut }
        return tableFull(members) ? .willWatch : nil
    }

    /// Four members hold the table's seats (the server's `playing`).
    static func tableFull(_ members: [LobbyPlayer]) -> Bool {
        members.filter { $0.playing == true }.count >= 4
    }
}

// MARK: - Removing a bot (the web lobby's rules: client/src/ui/screens/GameLobby.js)

extension LobbyPlayer {
    /// Any human in a game lobby may remove a bot that is not ready, as on the web
    /// (`lobbyHandlers.removeBot` takes it from any member). Bots turn ready only
    /// when a human readies a full lobby (`setBotsReady`), and from then until the
    /// game starts (the LOBBY_START_MS hold, the countdown) every bot is ready, so
    /// the control is gone before the game can start. The server re-checks (a bot
    /// it no longer has answers `serverError` "Bot not found in lobby").
    var canBeRemoved: Bool { isBot && !isReady }

    /// The lobby's bot name without the server's "🤖 " prefix: "Bot", "Bot 2"
    /// (the personality stays hidden until the game starts, V1_REMOVALS #16).
    var botDisplayName: String {
        username.replacingOccurrences(of: "🤖", with: "").trimmingCharacters(in: .whitespaces)
    }

    /// The remove control's VoiceOver label: "Remove Bot 2" for the lobby's
    /// generic names, "Remove bot Mary" for any other bot name.
    var removeBotLabel: String {
        let name = botDisplayName
        if name.isEmpty { return "Remove bot" }
        return name.lowercased().hasPrefix("bot") ? "Remove \(name)" : "Remove bot \(name)"
    }

    /// My own ready flag in the server's list (nil: I am not in it). The lobby's
    /// Ready button follows it, as the web's does: removing a bot (or a player
    /// leaving) clears every ready flag on the server (`removeBotFromLobby`).
    static func readyFlag(of username: String?, in players: [LobbyPlayer]) -> Bool? {
        guard let username, !username.isEmpty else { return nil }
        return players.first { $0.username == username && !$0.isBot }?.isReady
    }
}
