#if DEBUG
import Foundation

/// Get Your Bid fixtures (GybUITests; the shapes are the server's, from the recording
/// events-gyb-s19: a padded four-seat snapshot v2 with three seats, and the carrier's `gyb`).
/// The table ones go through the real carrier decode (`rejoinSuccess`, `spectatorJoined`), so
/// they are restored exactly as a rejoin or a spectate would be.
///
///   gyb-bidding     my bid turn as the dealer on the 6: kim bid 2, Mary 1, so 3 is my Forbidden Bid
///   gyb-playing     the 6 in play, kim led the K of hearts, Mary followed: my turn
///   gyb-spectator   the same table watched by a pure spectator (seats 1, 2, 3 round the table)
///   gyb-end         the game's end with each player's result (me 2nd); `-uiTie YES`: kim and I share it
///   gyb-lobby       a Get Your Bid lobby: me (ready) and a bot, one seat waiting, Add Bot
///   main-room-gyb   the main room with a Get Your Bid lobby and a Get Your Bid table in progress
extension UIFixture {
    static let gybTables: Set<String> = ["gyb-bidding", "gyb-playing", "gyb-spectator", "gyb-end"]
    static let gybScreens: Set<String> = ["gyb-lobby", "main-room-gyb"]

    /// Seeds a Get Your Bid fixture; false for any other name.
    @MainActor
    static func seedGyb(_ name: String, _ store: GameState, _ appState: AppState, mainRoom: MainRoomState,
                        lobby: LobbyState, auth: AuthState) -> Bool {
        if gybScreens.contains(name) {
            seedGybScreen(name, appState, mainRoom: mainRoom, lobby: lobby, auth: auth)
            return true
        }
        guard gybTables.contains(name) else { return false }
        let spectator = name == "gyb-spectator"
        let me = spectator ? "lou" : "ivy"
        store.apply(.local(.identity(username: me, playerId: spectator ? "sid-lou" : "sid-ivy")))
        auth.username = me
        let bidding = name == "gyb-bidding"
        let snap = gybSnapshot(bidding: bidding, spectator: spectator)
        let gyb: [String: Any] = [
            "scores": [26, 13, 11], "made": [2, 1, 1], "hands": 3,
            "forbidden": bidding ? NSNull() : ["position": 1, "bid": 3] as Any,
            "trickHistory": bidding ? [] : [
                ["winner": 2, "lead": 2, "cards": [["suit": "spades", "rank": "A"], ["suit": "spades", "rank": "4"], ["suit": "spades", "rank": "2"]]],
                ["winner": 1, "lead": 2, "cards": [["suit": "clubs", "rank": "9"], ["suit": "clubs", "rank": "3"], ["suit": "clubs", "rank": "K"]]],
            ] as [Any],
        ]
        let players: [[String: Any]] = gybSeats.map { ["position": $0.0, "username": $0.1, "pic": $0.2, "socketId": $0.0 == 1 ? "sid-ivy" : "bot:\($0.0)"] }
        let carrier: [String: Any] = spectator
            ? ["gameId": gybGameId, "players": players, "trump": gybTrump, "gyb": gyb, "snapshot": snap]
            : ["gameId": gybGameId, "players": players, "isLazy": false, "tournamentId": NSNull(), "gyb": gyb, "snapshot": snap]
        store.apply(serverEvent: spectator ? "spectatorJoined" : "rejoinSuccess", payload: [carrier])
        seededSnapshot = snap
        if name == "gyb-end" {
            let tie = UserDefaults.standard.bool(forKey: "uiTie")
            let scores = tie ? [83, 83, 26] : [62, 83, 26]
            var stats: [String: Any] = [:]
            for (pos, user, _) in gybSeats {
                stats[String(pos)] = ["username": user, "totalBids": 20 + pos, "totalTricks": 22 + pos, "setsCaused": 0, "totalHSI": 0, "avgHSI": 0] as [String: Any]
            }
            store.apply(serverEvent: "gameEnd", payload: [[
                "score": ["team1": 0, "team2": 0], "playerStats": stats, "tournamentId": NSNull(),
                "gyb": ["scores": scores, "winners": tie ? [1, 2] : [2], "made": [5, 8, 2], "hands": 13],
                "seq": (store.state.sync.lastSeq ?? 40) + 1,
            ] as [String: Any]])
        }
        appState.screen = .game
        return true
    }

    static let gybGameId = "00000000-0000-4000-8000-0000000000b3"
    static let gybTrump: [String: Any] = ["suit": "diamonds", "rank": "7"]
    /// (position, name, pic): me at 1, kim at 2 (left), a bot at 3 (right).
    static let gybSeats: [(Int, String, Int)] = [(1, "ivy", 11), (2, "kim", 12), (3, "\u{1F916} Mary", 39)]

    /// The snapshot v2 a Get Your Bid table sends: four-seat arrays padded (null bid, order
    /// ending in 4, 0 tricks), three seats, no HSI, an empty trickHistory (the carrier's gyb has it).
    static func gybSnapshot(bidding: Bool, spectator: Bool) -> [String: Any] {
        let card = { (s: String, r: String) -> [String: Any] in ["suit": s, "rank": r] }
        // my 6: two hearts to follow the K, the rest
        var hand = [card("hearts", "Q"), card("hearts", "5"), card("diamonds", "A"), card("clubs", "10"), card("spades", "8"), card("joker", "LO")]
        if !bidding { hand.removeLast(2) }  // two tricks played
        let seats: [[String: Any]] = gybSeats.map { pos, user, pic in
            let bot = pos == 3
            return ["position": pos, "username": user, "pic": pic, "hasCustomPic": false, "customPic": NSNull(),
                    "ownerUsername": bot ? NSNull() : user as Any, "controller": bot ? "bot" : "human",
                    "presence": bot ? "none" : "connected", "isBot": bot, "lazy": false, "offered": false,
                    "graceDeadline": NSNull(), "resignableAt": NSNull(),
                    "cardsInHand": bidding ? 6 : (pos == 1 ? 4 : 3)]
        }
        var snap: [String: Any] = [
            "v": 2, "gameId": gybGameId, "seq": 40, "serverTime": 1767268835850,
            "stage": bidding ? "BIDDING" : "PLAYING", "partial": [],
            "viewer": spectator
                ? ["role": "spectator", "position": NSNull(), "ownerView": NSNull(), "canAct": false]
                : ["role": "seat", "position": 1, "ownerView": "seat", "canAct": true],
            "hand": spectator ? NSNull() : hand as Any,
            "deal": ["handNo": 4, "handSize": 6, "dealer": 1, "bidder": 2, "dealSeq": 4],
            "trump": gybTrump, "trumpBroken": false,
            "turn": ["position": 1, "action": bidding ? "bid" : "play"],
            "bids": ["byPosition": bidding ? [NSNull(), "2", "1", NSNull()] : ["2", "2", "1", NSNull()],
                     "order": [2, 3, 1, 4], "teamBids": bidding ? NSNull() : ["team1": 3, "team2": 0] as Any,
                     "mults": ["team1": 1, "team2": 1]],
            "trick": bidding
                ? ["number": NSNull(), "leadPosition": NSNull(), "cards": []]
                : ["number": 3, "leadPosition": 2, "cards": [["position": 2, "card": card("hearts", "K")], ["position": 3, "card": card("hearts", "4")]]],
            // the team counts by seat parity (seats 1 and 3: team1), as the server keeps them
            "tricks": ["team1": bidding ? 0 : 1, "team2": bidding ? 0 : 1],
            "tricksByPosition": bidding ? [0, 0, 0, 0] : [1, 1, 0, 0],
            "trickHistory": [], "score": ["team1": 0, "team2": 0], "rainbows": ["team1": 0, "team2": 0], "hsi": NSNull(),
            "seats": seats, "entrants": NSNull(), "draw": NSNull(), "spectatorCount": spectator ? 1 : 0,
            "watching": ["spectators": spectator ? [["username": "lou", "pic": 7]] : [], "count": spectator ? 1 : 0],
            "tournament": NSNull(),
            "log": [["message": "Game started!", "type": "system", "position": NSNull(), "at": 1767268806066]],
            "resume": NSNull(),
        ]
        if !spectator { snap["viewer"] = ["role": "seat", "position": 1, "ownerView": "seat", "canAct": true] }
        return snap
    }

    @MainActor
    private static func seedGybScreen(_ name: String, _ appState: AppState, mainRoom: MainRoomState, lobby: LobbyState, auth: AuthState) {
        auth.username = "ivy"
        func player(_ u: String, ready: Bool = false, bot: Bool = false) -> LobbyPlayer {
            LobbyPlayer(id: bot ? "bot:\(u)" : "sid-\(u)", username: u, pic: nil, isReady: ready, isBot: bot)
        }
        switch name {
        case "gyb-lobby":
            lobby.applyLobby([
                "lobbyId": "l-gyb", "lobbyName": "Three of us", "mode": "gyb",
                "players": [["username": "ivy", "ready": true], ["username": "\u{1F916} Bot", "ready": false]],
                "members": [["socketId": "sid-ivy", "username": "ivy", "ready": true, "playing": true],
                            ["socketId": "bot:fixture-1", "username": "\u{1F916} Bot", "ready": false, "playing": true, "isBot": true]],
                "host": "ivy", "settings": ["spectatorsCanTalk": true], "capacity": 8,
                "messages": [["username": "kim", "message": "three-handed tonight?", "timestamp": Date().timeIntervalSince1970 * 1000]],
            ], isBlocked: { _ in false })
            lobby.isReady = true
            appState.screen = .gameLobby
        default:  // main-room-gyb
            mainRoom.lobbies = [
                Lobby.from(["id": "l-gyb", "name": "Three of us", "playerCount": 2, "maxPlayers": 4,
                            "players": [["username": "kim", "ready": false], ["username": "hal", "ready": true]],
                            "mode": "gyb", "seats": 3, "memberCount": 2, "capacity": 8, "memberUsernames": ["kim", "hal"]])!,
                Lobby(id: "l1", name: "Friday night", players: [player("jon")], playerCount: 1),
            ]
            mainRoom.inProgressGames = [
                Lobby.from(["gameId": "g-gyb", "players": [["position": 1, "username": "ora"], ["position": 2, "username": "max"],
                                                           ["position": 3, "username": "pat"]],
                            "currentHand": 5, "score": ["team1": 0, "team2": 0], "spectatorCount": 1, "mode": "gyb",
                            "scores": [26, 13, 0], "inProgress": true])!,
            ]
            mainRoom.onlineCount = 7
            mainRoom.onlineUsers = ["ivy", "kim", "hal", "jon", "ora", "max", "pat"]
            appState.screen = .mainRoom
        }
    }
}
#endif
