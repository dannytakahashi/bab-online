#if DEBUG
import SwiftUI
import UIKit
import SpriteKit

/// Fixture mode (roadmap item 26), DEBUG builds only: `-uiFixture <name>`
/// (read through UserDefaults' argument domain) seeds the app from a contract
/// v2 snapshot (`v2/<name>.json`, bundled in Debug only) or from the
/// `UI_FIXTURE_SNAPSHOT` environment JSON, and the app never connects (no
/// socket, no voice, avatars show initials). Screen fixtures (`main-room`,
/// `game-lobby`, `tournament-lobby`, `tournament-round` (round 3 in play: the
/// scoreboard and two active tables), `tournament-between` (round 2 complete),
/// `sign-in`) seed static rows instead. 1.2.2 parity screens: `main-room-cards` (the lobby
/// cards: member names, Rejoin on a full lobby that seats me, Full, in-progress games with
/// hand / score / watchers), `game-lobby-reconnecting` (a held seat's "Reconnecting…"),
/// `tournament-deadline` (between rounds past the ready deadline, me the host: "Start with
/// ready players", "Sitting out"; `-uiHost <name>` makes another member the host),
/// `tournament-results` (the results overlay with every round and the round markers;
/// `-uiPlainResults YES`: no markers, as an older server). `-uiInfoToast "<message>"` raises
/// the neutral toast (a new host, a cancelled tournament) and `-uiVoicePanel YES` opens the
/// voice panel over `game-lobby` with two players (their volume sliders). `game-lobby-bots` is the game lobby with two bots
/// that are not ready (my seat ready): there removeBot and addBot change the list the way
/// the server answers them (`emulateLobby`) and show in "fixture.sent" as `removeBot:<id>` / `addBot`.
/// `-uiFold book|tabletop` simulates a fold region (FoldReader) for screenshots.
/// `-uiLeaveDrive settle|hold` drives the Leave alert's reopen (`leaveAlertPresented`), and
/// the chat messages the app sends show in the "fixture.sent" probe (`recordSent`).
enum UIFixture {
    static let name: String? = UserDefaults.standard.string(forKey: "uiFixture")
    static var isActive: Bool { name != nil }

    enum Fold: String { case book, tabletop }
    /// Synthetic 20 pt division at the window center (screenshots only; the real API is FoldReader's).
    static let fold: Fold? = UserDefaults.standard.string(forKey: "uiFold").flatMap(Fold.init(rawValue:))

    /// `-uiEffect rainbow|b|2b|3b|4b|ot|all`: effects held on the table (screenshots of the art).
    static let effect: String? = UserDefaults.standard.string(forKey: "uiEffect")

    /// `-uiChat "lou|that bore is still alive!;2|gl"`: chat lines held on the table
    /// (screenshots of the bubbles): `<name>|<text>` a spectator's, `<position>|<text>` a seat's.
    static let chat: [[String: Any]] = (UserDefaults.standard.string(forKey: "uiChat") ?? "")
        .split(separator: ";").compactMap { line in
            let parts = line.split(separator: "|", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { return nil }
            if let pos = Int(parts[0]), (1...4).contains(pos) {
                return ["username": "P\(pos)", "message": parts[1], "position": pos, "isSpectator": false]
            }
            return ["username": parts[0], "message": parts[1], "isSpectator": true]
        }

    /// `-uiVoice YES`: my seat's row shows the voice button as if voice were on (fixture mode
    /// never starts voice; screenshots and the seat-row UI tests).
    static let showsVoiceButton: Bool = isActive && UserDefaults.standard.bool(forKey: "uiVoice")

    /// `-uiVoicePanel YES`: the game lobby opens the voice panel (fixture mode never starts voice).
    static let showsVoicePanel: Bool = isActive && UserDefaults.standard.bool(forKey: "uiVoicePanel")

    static let screenFixtures: Set<String> = ["main-room", "main-room-empty", "main-room-cards", "game-lobby", "game-lobby-bots",
                                              "game-lobby-reconnecting", "tournament-lobby", "tournament-round",
                                              "tournament-between", "tournament-deadline", "tournament-results", "sign-in"]

    @MainActor
    static func seed(_ store: GameState, _ appState: AppState, mainRoom: MainRoomState, lobby: LobbyState,
                     tournament: TournamentState, auth: AuthState) {
        guard let name else { return }
        seed(fixture: name, store, appState, mainRoom: mainRoom, lobby: lobby, tournament: tournament, auth: auth)
    }

    /// Seeds the stores from the fixture `name` (also used by the #Preview blocks).
    @MainActor
    static func seed(fixture name: String, _ store: GameState, _ appState: AppState, mainRoom: MainRoomState, lobby: LobbyState,
                     tournament: TournamentState, auth: AuthState) {
        OpponentHandNode.avatarLoader = FixtureAvatarLoader()
        // no socket in fixture mode: signed in, unless `-uiSessionPending YES` (the moment
        // between a reconnect and the restore's answer: main-room actions wait)
        SocketService.shared.isSessionReady = !UserDefaults.standard.bool(forKey: "uiSessionPending")
        // `-uiForegroundProbe YES`: signed in, a foreground probe in flight (main-room actions
        // wait for its answer, with no Reconnecting toast)
        if UserDefaults.standard.bool(forKey: "uiForegroundProbe") { SocketService.shared.holdForegroundProbeForFixture() }
        // `-uiServerError "<message>"`: the server-error toast, shown once the screen is up
        if let message = UserDefaults.standard.string(forKey: "uiServerError") {
            // the toast layer is mounted for a signed-in user only (ContentView)
            auth.isAuthenticated = true
            ServerErrorToast.visibleSeconds = 60
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                SocketService.shared.serverError = ServerErrorNotice(message: message)
            }
        }
        // `-uiInfoToast "<message>"`: the neutral toast (a host change, a cancellation)
        if let message = UserDefaults.standard.string(forKey: "uiInfoToast") {
            auth.isAuthenticated = true
            ServerErrorToast.visibleSeconds = 60
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                SocketService.shared.serverError = ServerErrorNotice(message: message, kind: .info)
            }
        }
        if showsVoicePanel {
            VoiceChatManager.shared.peerInfos = [
                "sid-kim": VoiceChatManager.PeerInfo(username: "kim"),
                "sid-hal": VoiceChatManager.PeerInfo(username: "hal", isMuted: true, volume: 1.5),
            ]
        }
        if screenFixtures.contains(name) {
            seedScreen(name, appState, mainRoom: mainRoom, lobby: lobby, tournament: tournament, auth: auth)
            print("[UIFixture] seeded screen \(name)")
            return
        }
        do {
            let file = gameEndStates[name] ?? (drawStates.contains(name) ? "draw-in-progress" : name)
            var snapDict: [String: Any]
            if let env = ProcessInfo.processInfo.environment["UI_FIXTURE_SNAPSHOT"] {
                snapDict = try JSONSerialization.jsonObject(with: Data(env.utf8)) as? [String: Any] ?? [:]
            } else {
                guard let url = Bundle.main.url(forResource: file, withExtension: "json", subdirectory: "v2") else {
                    print("[UIFixture] missing v2/\(file).json"); return
                }
                let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
                snapDict = raw?["snapshot"] as? [String: Any] ?? [:]
            }
            // an entrant has no seat yet: the viewer is the entrant whose draw the snapshot names
            // (a spectator is none of them)
            let drawer = name == "draw-spectator" ? nil : (snapDict["draw"] as? [String: Any]).flatMap { d in
                (d["drawn"] as? [[String: Any]])?.first { $0["drawOrder"] as? Int == d["viewerDrawOrder"] as? Int }?["username"] as? String
            }
            if drawStates.contains(name) { editDraw(name, &snapDict) }
            let snap = try TableSnapshot.decode(snapDict, strict: true)
            seededSnapshot = snapDict
            let me = snap.seats.first { $0.position == snap.viewer.position }?.username ?? drawer
            store.apply(.local(.identity(username: me ?? "viewer", playerId: "ui-fixture")))
            auth.username = me ?? "viewer"
            store.apply(.snapshot(snap, .rejoin, hints: nil))
            if name == "draw-deal" {
                let gameId = snapDict["gameId"], seq = snap.seq
                // the deal ends the draw 6 s after launch (a UI test needs the draw on screen
                // first): the bidding-mid table (this game's id, so the screen is the same game
                // moving on), as a rejoin snapshot
                DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                    guard let url = Bundle.main.url(forResource: "bidding-mid", withExtension: "json", subdirectory: "v2"),
                          let data = try? Data(contentsOf: url),
                          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          var dealt = raw["snapshot"] as? [String: Any] else { print("[UIFixture] missing v2/bidding-mid.json"); return }
                    dealt["gameId"] = gameId
                    dealt["seq"] = seq + 1
                    guard let table = try? TableSnapshot.decode(dealt, strict: true) else { print("[UIFixture] bidding-mid did not decode"); return }
                    seededSnapshot = dealt
                    store.apply(.snapshot(table, .rejoin, hints: nil))
                }
            }
            if name == "draw-teams" {
                // live, as the server sends it: DrawPhaseView shows the teams 0.8 s after the event
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    _ = store.apply(serverEvent: "teamsAnnounced", payload: [[
                        "team1": ["fay", "gus"], "team2": ["🤖 Mike", "eve"], "resumeInMs": 3000, "seq": snap.seq + 1,
                    ] as [String: Any]])
                }
            }
            if gameEndStates[name] != nil {
                // gameEnd playerStats as the server sends them (gameHandlers.js: avgHSI rounded);
                // `-uiNoEndStats YES`: none, as an older server or a missing field
                let totals: [Int: (bids: Int, tricks: Int, faults: Int, hsi: Double)] = [
                    1: (23, 24, 1, 120), 2: (19, 17, 3, 104), 3: (21, 25, 0, 131), 4: (18, 18, 2, 97),
                ]
                var stats: [String: Any] = [:]
                for seat in snap.seats {
                    let t = totals[seat.position] ?? (0, 0, 0, 0)
                    stats[String(seat.position)] = [
                        "username": seat.username ?? "P\(seat.position)", "totalBids": t.bids, "totalTricks": t.tricks,
                        "setsCaused": t.faults, "totalHSI": t.hsi * 13, "avgHSI": t.hsi,
                    ] as [String: Any]
                }
                if UserDefaults.standard.bool(forKey: "uiNoEndStats") {
                    stats = stats.mapValues { ["username": ($0 as? [String: Any])?["username"] ?? ""] }
                }
                // `-uiTie YES`: equal final scores (TIE GAME)
                let tie = UserDefaults.standard.bool(forKey: "uiTie")
                store.apply(serverEvent: "gameEnd", payload: [[
                    "score": ["team1": 312, "team2": tie ? 312 : 287], "playerStats": stats,
                    "tournamentId": snap.tournament?.tournamentId ?? NSNull(), "seq": snap.seq + 1,
                ] as [String: Any]])
            }
            seedTableExtras(store, snap, auth: auth)
            appState.screen = .game
            print("[UIFixture] seeded \(name): phase \(store.phase)")
        } catch {
            print("[UIFixture] \(name): \(error)")
        }
    }

    // MARK: - 1.2.2 table states (TableParityUITests)

    /// `-uiIdleOffer <position>`: the tournament table's idle-seat offer for that seat, as the
    /// server sends it (private resignationAvailable with `idle: true`).
    /// `-uiReject <reason>`: 1 s after the table is up, the server refuses my action
    /// (actionRejected `{action: play, reason}`): the toast with the reason, held 60 s.
    /// `-uiDealer <position>`: that seat dealt this hand (the snapshot's dealer otherwise).
    /// `-uiToasts YES`: the toast layer is up and holds a toast 60 s (a tap on a dimmed card).
    @MainActor
    private static func seedTableExtras(_ store: GameState, _ snap: TableSnapshot, auth: AuthState) {
        let defaults = UserDefaults.standard
        if let pos = Int(defaults.string(forKey: "uiDealer") ?? ""), (1...4).contains(pos), var dict = seededSnapshot,
           var deal = dict["deal"] as? [String: Any] {
            deal["dealer"] = pos
            dict["deal"] = deal
            if let edited = try? TableSnapshot.decode(dict, strict: true) {
                seededSnapshot = dict
                store.apply(.snapshot(edited, .rejoin, hints: nil))
            }
        }
        if let pos = Int(defaults.string(forKey: "uiIdleOffer") ?? ""), (1...4).contains(pos) {
            let name = snap.seats.first { $0.position == pos }?.username ?? "P\(pos)"
            _ = store.apply(serverEvent: "resignationAvailable", payload: [["position": pos, "username": name, "idle": true] as [String: Any]])
        }
        if defaults.bool(forKey: "uiToasts") {
            auth.isAuthenticated = true  // the toast layer is mounted for a signed-in user only
            ServerErrorToast.visibleSeconds = 60
        }
        // `-uiDeal YES`: 8 s after launch (the UI test is reading the probe by then) the next
        // hand is dealt live (gameStart as the server sends it: 13 cards, dealer 4), so the
        // deal's fly-in plays (probe "table.deal");
        // `-uiReduceMotion YES` pins Reduce Motion on (Theme.Motion.reduceMotionOverride)
        if defaults.bool(forKey: "uiReduceMotion") { Theme.Motion.reduceMotionOverride = true }
        if defaults.bool(forKey: "uiDeal") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
                let ranks = ["A", "K", "Q", "J", "10", "9", "8"]
                let cards: [[String: Any]] = (ranks.map { ["suit": "spades", "rank": $0] } + ranks.prefix(6).map { ["suit": "hearts", "rank": $0] })
                var payload: [String: Any] = [
                    "gameId": snap.gameId, "hand": cards, "trump": ["suit": "clubs", "rank": "5"], "score1": 0, "score2": 0,
                    "dealer": 4, "currentHand": 13, "seq": (store.state.sync.lastSeq ?? snap.seq) + 1,
                    "playerInfo": snap.seats.map { ["position": $0.position, "username": $0.username ?? "P\($0.position)"] as [String: Any] },
                ]
                if let pos = snap.viewer.position, snap.viewer.role == .seat { payload["position"] = pos }
                _ = store.apply(serverEvent: "gameStart", payload: [payload])
            }
        }
        if let reason = defaults.string(forKey: "uiReject") {
            auth.isAuthenticated = true  // the toast layer is mounted for a signed-in user only
            ServerErrorToast.visibleSeconds = 60
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                _ = store.apply(serverEvent: "actionRejected", payload: [["action": "play", "reason": reason] as [String: Any]])
            }
        }
    }

    // MARK: - Leave alert reopen (LeaveAlertUITests)

    /// `-uiLeaveDrive settle|hold`: 2.5 s after the Leave alert first opens, the other human
    /// owner's /leave reaches the table the way the server sends it (`playerLazyMode` only), so the
    /// open alert checks again and LeaveAlertFlow closes and reopens it as in a live game.
    /// `settle` answers the check with a snapshot that has that seat gone (the settled reopen:
    /// "leaving ends the game"); `hold` never answers (the hold times out: the hedged reopen).
    static let leaveDrive: String? = isActive ? UserDefaults.standard.string(forKey: "uiLeaveDrive") : nil
    private static var leaveDriven = false
    /// The seeded snapshot, from which the `settle` reply is made.
    private static var seededSnapshot: [String: Any]?

    /// GameContainerView: the Leave alert opened.
    @MainActor
    static func leaveAlertPresented(_ store: GameState) {
        guard let drive = leaveDrive, !leaveDriven, var snap = seededSnapshot,
              var seats = snap["seats"] as? [[String: Any]],
              let mine = (snap["viewer"] as? [String: Any])?["position"] as? Int,
              let i = seats.firstIndex(where: { $0["controller"] as? String == "human" && $0["position"] as? Int != mine }),
              let pos = seats[i]["position"] as? Int, let owner = seats[i]["ownerUsername"] as? String else { return }
        leaveDriven = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {  // after the test read the first words
            _ = store.apply(serverEvent: "playerLazyMode", payload: [[
                "position": pos, "botUsername": "Fixture Bot", "botPic": 4, "originalUsername": owner,
                "seq": (store.state.sync.lastSeq ?? 0) + 1,
            ] as [String: Any]])
            guard drive == "settle", case .pending(let id) = store.players.leaveCheck else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                seats[i]["controller"] = "lazyBot"
                seats[i]["presence"] = "gone"
                seats[i]["isBot"] = true
                seats[i]["lazy"] = true
                seats[i]["username"] = "Fixture Bot"
                snap["seats"] = seats
                snap["seq"] = (store.state.sync.lastSeq ?? 0) + 1
                _ = store.apply(serverEvent: "stateSnapshot", payload: [["snapshot": snap, "requestId": id] as [String: Any]])
            }
        }
    }

    /// The chat messages the app sent ("fixture.sent"; fixture mode has no socket), so a UI
    /// test can tell that Leave Game sent /leave.
    static func recordSent(_ event: String, _ data: [String: Any]) {
        guard isActive else { return }
        let message: String
        switch event {
        case SocketEvents.Client.chatMessage:
            guard let m = data["message"] as? String else { return }
            message = m
        case SocketEvents.Client.removeBot where name == "game-lobby-bots":
            message = "removeBot:\(data["botSocketId"] as? String ?? "-")"
        case SocketEvents.Client.addBot where name == "game-lobby-bots":
            message = "addBot"
        case SocketEvents.Client.blockUser, SocketEvents.Client.unblockUser, SocketEvents.Client.reportUser:
            message = profileSent(event, data)  // answered as the server does (UIFixture+Profile)
        default:
            return
        }
        DispatchQueue.main.async {
            let probe = TableDebugProbe.shared
            probe.sent = probe.sent == "-" ? message : probe.sent + "|" + message
            emulateLobby(event, data)
        }
    }

    /// `game-lobby-bots`' lobby (no server in fixture mode).
    private static weak var fixtureLobby: LobbyState?

    /// The server's answer to removeBot / addBot in `game-lobby-bots`, as GameManager makes it
    /// (server PR #248): removeBotFromLobby takes the bot out and unreadies only the remaining
    /// bots (the humans keep their flags); addBotToLobby adds "🤖 Bot <n>" with the lowest free
    /// n, not ready, and leaves the flags alone.
    private static func emulateLobby(_ event: String, _ data: [String: Any]) {
        guard let lobby = fixtureLobby else { return }
        var players = lobby.players
        if event == SocketEvents.Client.removeBot {
            guard let id = data["botSocketId"] as? String, let i = players.firstIndex(where: { $0.id == id && $0.isBot }) else { return }
            players.remove(at: i)
            for j in players.indices where players[j].isBot { players[j].isReady = false }
        } else {
            guard players.count < 4 else { return }
            let taken = Set(players.filter(\.isBot).map(\.username))
            var n = 1
            while taken.contains(n > 1 ? "🤖 Bot \(n)" : "🤖 Bot") { n += 1 }
            botSerial += 1
            players.append(LobbyPlayer(id: "bot:fixture-\(botSerial)", username: n > 1 ? "🤖 Bot \(n)" : "🤖 Bot",
                                       pic: nil, isReady: false, isBot: true))
        }
        // the server's playerReadyUpdate lands a moment later
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { lobby.players = players }
    }
    private static var botSerial = 2

    /// Draw-for-deal states (DrawPhaseView screenshots and UI tests), built from
    /// `draw-in-progress` (2 of 4 drawn, the viewer fay among them): `draw-start`
    /// nobody has drawn, `draw-all` all four, `draw-teams` all four and then
    /// teamsAnnounced 3 s after launch (the overlay shows it 0.8 s after that and, in
    /// this fixture only, keeps it up: `holdsTeams`), `draw-long` all four with two
    /// names long enough to shrink (the cards must stay on one line), `draw-spectator`
    /// 2 of 4 drawn seen by a spectator (no deck: they never draw), `draw-deal` all four and
    /// then, 6 s after launch, the deal: the table in BIDDING (bidding-mid), as the phase change
    /// the corner buttons must not animate through (TableChromeAnimationTests).
    /// Game-end states (GameEndView: final score + each player's stats) and the snapshot each
    /// ends: `game-end` a seat's casual game, `game-end-spectator` a spectator's,
    /// `game-end-tournament` a tournament game (Return to Tournament).
    static let gameEndStates = ["game-end": "hand-resolving", "game-end-spectator": "spectator-mid-hand",
                                "game-end-tournament": "tournament-game"]

    static let drawStates: Set<String> = ["draw-start", "draw-all", "draw-teams", "draw-long", "draw-spectator", "draw-deal"]
    static var holdsTeams: Bool { name == "draw-teams" }

    private static func editDraw(_ name: String, _ snap: inout [String: Any]) {
        guard var draw = snap["draw"] as? [String: Any] else { return }
        if name == "draw-spectator" {
            // as the server sends it to a spectator: no draw of theirs (snapshotV2 viewerDrawOrder)
            draw["viewerDrawOrder"] = NSNull()
            snap["draw"] = draw
            var viewer = snap["viewer"] as? [String: Any] ?? [:]
            viewer["role"] = "spectator"
            snap["viewer"] = viewer
            return
        }
        let start = name == "draw-start"
        // 20 characters is the sign-up maximum; older accounts keep longer display names
        let (third, fourth) = name == "draw-long" ? ("JoAnn Jameson", "Christopher Johnson1") : ("eve", "gus")
        if start {
            draw["drawn"] = [Any]()
            draw["viewerDrawOrder"] = NSNull()
        } else {
            let more: [[String: Any]] = [
                ["drawOrder": 3, "username": third, "isBot": false, "card": ["suit": "diamonds", "rank": "7"], "position": NSNull()],
                ["drawOrder": 4, "username": fourth, "isBot": false, "card": ["suit": "joker", "rank": "HI"], "position": NSNull()],
            ]
            draw["drawn"] = (draw["drawn"] as? [[String: Any]] ?? []) + more
        }
        draw["deckRemaining"] = start ? 54 : 50
        snap["draw"] = draw
        snap["entrants"] = (snap["entrants"] as? [[String: Any]] ?? []).map { e in
            var e = e
            e["hasDrawn"] = !start
            if let u = e["username"] as? String { e["username"] = u == "eve" ? third : u == "gus" ? fourth : u }
            return e
        }
    }

    /// The first half sent about a day ago, the rest in the last minutes, so the
    /// screens show both kinds of time divider (ChatTimestamps).
    private static func messages(_ lines: [(String, String)]) -> [ChatMessage] {
        let now = Date(), half = lines.count / 2
        return lines.enumerated().map { i, line in
            let sent = i < half ? now.addingTimeInterval(-26 * 3600 + Double(i) * 60) : now.addingTimeInterval(-Double(lines.count - i) * 60)
            return ChatMessage(username: line.0, message: line.1, type: line.0 == "System" ? .system : .player, timestamp: sent)
        }
    }

    @MainActor
    private static func seedScreen(_ name: String, _ appState: AppState, mainRoom: MainRoomState, lobby: LobbyState,
                                   tournament: TournamentState, auth: AuthState) {
        auth.username = "ivy"
        let chat = messages([
            ("System", "Welcome to Back Alley Bridge!"), ("kim", "anyone up for a game?"), ("hal", "sure, joining the queue"),
            ("jon", "gg last round"), ("ivy", "that 4B was wild"), ("kim", "rematch?"),
        ])
        func player(_ u: String, ready: Bool = false, bot: Bool = false) -> LobbyPlayer {
            LobbyPlayer(id: "sid-\(u)", username: u, pic: nil, isReady: ready, isBot: bot)
        }
        switch name {
        case "main-room":
            mainRoom.lobbies = [
                Lobby(id: "l1", name: "Friday night", players: [player("kim"), player("hal")], playerCount: 2),
                Lobby(id: "l2", name: "Bots welcome", players: [player("jon")], playerCount: 1),
            ]
            mainRoom.inProgressGames = [
                Lobby(id: "g1", name: "ora & pat vs max & ned", players: [player("ora"), player("max"), player("pat"), player("ned")],
                      playerCount: 4, isInProgress: true),
            ]
            mainRoom.messages = chat
            mainRoom.onlineCount = 7
            mainRoom.onlineUsers = ["ivy", "kim", "hal", "jon", "ora", "max", "pat"]
            mainRoom.tournaments = [TournamentSummary(id: "t1", name: "Sunday Cup", playerCount: 6, phase: "lobby", currentRound: 0,
                                                      totalRounds: 4, creatorUsername: "kim")]
            appState.screen = .mainRoom
        case "main-room-cards":
            // every kind of card: an open lobby with its members, a full lobby that still
            // holds my seat (Rejoin), a full one that does not (Full), and two games in
            // progress (one with watchers, one as an older server sends it: no details)
            mainRoom.lobbies = [
                Lobby(id: "l1", name: "Friday night", players: [player("kim"), player("hal"), player("\u{1F916} Bot")], playerCount: 3),
                Lobby(id: "l2", name: "Ivy's table", players: [player("ivy"), player("jon"), player("ora"), player("max")], playerCount: 4),
                Lobby(id: "l3", name: "Regulars", players: [player("pat"), player("ned"), player("sam"), player("tia")], playerCount: 4),
            ]
            mainRoom.inProgressGames = [
                Lobby(id: "g1", name: "uma & wes vs vic & xan", players: [player("uma"), player("vic"), player("wes"), player("xan")],
                      playerCount: 4, isInProgress: true,
                      progress: GameProgress(currentHand: 5, team1Score: 120, team2Score: -85,
                                             team1Names: ["uma", "wes"], team2Names: ["vic", "xan"], spectatorCount: 2)),
                Lobby(id: "g2", name: "abe & cal vs bea & dot", players: [player("abe"), player("bea"), player("cal"), player("dot")],
                      playerCount: 4, isInProgress: true),
            ]
            mainRoom.messages = chat
            mainRoom.onlineCount = 12
            mainRoom.onlineUsers = ["ivy", "kim", "hal", "jon", "ora", "max", "pat"]
            appState.screen = .mainRoom
        case "main-room-empty":
            // no lobbies, games or tournaments: the empty state (four suits)
            mainRoom.messages = chat
            mainRoom.onlineCount = 1
            mainRoom.onlineUsers = ["ivy"]
            appState.screen = .mainRoom
        case "game-lobby":
            lobby.lobbyId = "l1"
            lobby.lobbyName = "Friday night"
            lobby.players = [player("ivy", ready: true), player("kim", ready: true), player("hal"), player("Mary", ready: true, bot: true)]
            lobby.messages = chat
            appState.screen = .gameLobby
        case "game-lobby-reconnecting":
            // hal dropped: the server holds the seat (30 s) and names him in `reconnecting`
            lobby.lobbyId = "l1"
            lobby.lobbyName = "Friday night"
            lobby.setPlayers([player("ivy", ready: true), player("kim", ready: true), player("hal"), player("Mary", ready: true, bot: true)],
                             reconnecting: ["hal"])
            lobby.messages = chat
            appState.screen = .gameLobby
        case "game-lobby-bots":
            // I readied, then added the bots: they are not ready, so each shows its remove control
            lobby.lobbyId = "l1"
            lobby.lobbyName = "Friday night"
            lobby.players = [player("ivy", ready: true), player("kim", ready: true),
                             LobbyPlayer(id: "bot:fixture-1", username: "🤖 Bot", pic: nil, isReady: false, isBot: true),
                             LobbyPlayer(id: "bot:fixture-2", username: "🤖 Bot 2", pic: nil, isReady: false, isBot: true)]
            lobby.messages = chat
            fixtureLobby = lobby
            // `-uiLobbyRejoin YES`: the restore's joinLobby is out and unanswered
            if UserDefaults.standard.bool(forKey: "uiLobbyRejoin") { lobby.rejoiningLobbyId = "l1" }
            appState.screen = .gameLobby
        case "tournament-lobby":
            tournament.tournamentId = "t1"
            tournament.name = "Sunday Cup"
            tournament.phase = "lobby"
            tournament.creatorUsername = "kim"
            tournament.players = ["kim", "ivy", "hal", "jon", "ora", "max"].enumerated().map {
                TournamentPlayer(id: "sid-\($0.element)", username: $0.element, pic: nil, isReady: $0.offset % 2 == 0,
                                 isCreator: $0.element == "kim", connected: true)
            }
            tournament.messages = chat
            appState.screen = .tournamentLobby
        case "tournament-round", "tournament-between":
            // 8 players (ned reconnecting); mid-round two tables still play, ivy's has finished
            let between = name == "tournament-between"
            let names = ["kim", "ivy", "hal", "jon", "ora", "max", "pat", "ned"]
            let rounds: [[Int]] = [[142, 88], [120, 131], [97, 64], [-40, 152], [76, 49], [55, -20], [31, 18], [-12, 7]]
            tournament.tournamentId = "t1"
            tournament.name = "Sunday Cup"
            tournament.phase = between ? "between_rounds" : "round_active"
            tournament.currentRound = between ? 2 : 3
            tournament.creatorUsername = "kim"
            tournament.players = names.enumerated().map {
                TournamentPlayer(id: "sid-\($0.element)", username: $0.element, pic: nil, isReady: between && $0.offset % 3 != 2,
                                 isCreator: $0.element == "kim", connected: $0.element != "ned")
            }
            tournament.scoreboard = zip(names, rounds)
                .map { TournamentScoreEntry(id: $0, username: $0, totalScore: $1.reduce(0, +), roundScores: $1) }
                .sorted { $0.totalScore > $1.totalScore }
            tournament.activeGames = between ? [] : [
                TournamentActiveGame(id: "g1", humanPlayers: ["ivy", "kim", "hal", "jon"], botCount: 0, status: "complete"),
                TournamentActiveGame(id: "g2", humanPlayers: ["ora", "max", "pat"], botCount: 1, status: "active"),
                TournamentActiveGame(id: "g3", humanPlayers: ["ned"], botCount: 3, status: "active"),
            ]
            tournament.messages = chat + messages([("System", between ? "Round 2 complete" : "Round 3 has begun"), ("hal", "gl all")])
            appState.screen = .tournamentLobby
        case "tournament-deadline":
            // between rounds, 2 minutes on: hal and max are not ready (they sit out), ned is
            // away; the host (me, unless `-uiHost`) may start with the ready players
            let host = UserDefaults.standard.string(forKey: "uiHost") ?? "ivy"
            let names = ["kim", "ivy", "hal", "jon", "ora", "max", "pat", "ned"]
            let rounds: [[Int]] = [[142, 88], [120, 131], [97, 64], [-40, 152], [76, 49], [55, -20], [31, 18], [-12, 7]]
            tournament.tournamentId = "t1"
            tournament.name = "Sunday Cup"
            tournament.phase = "between_rounds"
            tournament.currentRound = 2
            tournament.creatorUsername = host
            tournament.readyDeadlinePassed = true
            tournament.players = names.map {
                TournamentPlayer(id: "sid-\($0)", username: $0, pic: nil, isReady: !["hal", "max", "ned", host].contains($0),
                                 isCreator: $0 == host, connected: $0 != "ned")
            }
            tournament.scoreboard = zip(names, rounds)
                .map { TournamentScoreEntry(id: $0, username: $0, totalScore: $1.reduce(0, +), roundScores: $1) }
                .sorted { $0.totalScore > $1.totalScore }
            tournament.messages = chat + messages([("System", "Players who are not ready will sit out the next round.")])
            appState.screen = .tournamentLobby
        case "tournament-results":
            // all four rounds played: an aborted table (jon, ora), a leaver (max), two missed
            // rounds (ned), and a tie at the top
            let plain = UserDefaults.standard.bool(forKey: "uiPlainResults")
            let rows: [(String, [Int], [Int: TournamentRoundFlag])] = [
                ("kim", [142, 88, 110, 64], [:]), ("ivy", [120, 131, 97, 56], [:]), ("hal", [97, 64, 120, 31], [:]),
                ("jon", [-40, 152, 45, 88], [2: .aborted]), ("ora", [76, 49, 45, 102], [2: .aborted]),
                ("max", [55, -20, -30, 77], [2: .left]), ("pat", [31, 18, 66, 40], [:]), ("ned", [-12, 7, -30, 31], [2: .missed, 3: .missed]),
            ]
            tournament.tournamentId = "t1"
            tournament.name = "Sunday Cup"
            tournament.phase = "complete"
            tournament.currentRound = 4
            tournament.creatorUsername = "kim"
            tournament.players = rows.map {
                TournamentPlayer(id: "sid-\($0.0)", username: $0.0, pic: nil, isReady: false, isCreator: $0.0 == "kim", connected: true)
            }
            tournament.scoreboard = rows
                .map { TournamentScoreEntry(id: $0.0, username: $0.0, totalScore: $0.1.reduce(0, +), roundScores: $0.1, roundFlags: plain ? [:] : $0.2) }
                .sorted { $0.totalScore > $1.totalScore }
            tournament.winners = ["kim", "ivy"]
            tournament.messages = chat
            appState.screen = .tournamentLobby
        default:
            // no socket in fixture mode: show the connected form (emits go nowhere), not the spinner
            SocketService.shared.isConnected = true
            appState.screen = .signIn
        }
    }
}

/// No network in fixture mode: every avatar shows its initial, unless `UI_FIXTURE_AVATARS`
/// names a folder with the stock art (`profile<N>.png`, the repo's client/assets: screenshots).
struct FixtureAvatarLoader: AvatarLoading {
    func load(_ picNumber: Int, completion: @escaping (UIImage?) -> Void) {
        completion(UIFixture.avatarFolder.flatMap { UIImage(contentsOfFile: "\($0)/profile\(picNumber).png") })
    }
}

/// What the fixture UI tests read through accessibility probes:
/// "ui.pose", "table.layoutCheck", "table.state", "table.extras", "table.zoom", "table.deal".
@MainActor
final class TableDebugProbe: ObservableObject {
    static let shared = TableDebugProbe()

    @Published var window: CGSize = .zero
    @Published var insets = TableInsets.zero
    @Published var chrome = TableChrome()
    @Published var layoutCheck = "-"
    @Published var tableState = "-"
    /// 1.2.2: "fans=2:5,3:5,4:4 dealer=3" (card backs per seat, "-" where the table shows
    /// no fans; the dealer's seat, "me", or "-"). Its own probe: a rotation may gain or lose the fans.
    @Published var tableExtras = "-"
    /// The table's zoom (TableLayout.zoom, "1.00" ... "1.40"): the UI tests scale their point limits by it.
    @Published var tableZoom = "-"
    /// The window's size classes ("compact/regular" = h/v), recorded with the pose.
    @Published var sizeClasses = "-"
    /// The system's vertical bar edge ("trailing" / "leading"), "-" where none is used.
    @Published var verticalBar = "-"
    /// The chat messages sent, "|"-joined ("-": none; UIFixture.recordSent).
    @Published var sent = "-"
    /// The live deal (GameSKScene.dealIn): "deals=1 cards=52 mode=fly flying=52 fading=0 deck=1"
    /// (deals shown; the latest one's cards and kind, fly or Reduce Motion's fade; cards still
    /// in a flight or a fade now, the deck up or not).
    @Published var tableDeal = "-"

    var pose: String {
        let i = insets
        let fold = chrome.fold.map { "\(Int($0.width))x\(Int($0.height))@\(Int($0.minX)),\(Int($0.minY))" } ?? "-"
        return "\(Int(window.width))x\(Int(window.height)) \(Int(i.top))/\(Int(i.left))/\(Int(i.bottom))/\(Int(i.right)) "
            + "topBar \(Int(chrome.topBar)) fold \(fold) occlusions \(chrome.occlusions.count) sc \(sizeClasses) vbar \(verticalBar)"
    }

    /// The scene after a render or relayout: are the stable nodes inside the safe rect?
    func update(scene: GameSKScene) {
        let L = scene.layout
        let safe = L.safeRect.insetBy(dx: -1, dy: -1)
        var bad: [String] = []
        if scene.lastModel?.showsTable == true {
            var nodes: [SKNode] = Array(scene.opponentManager.nodes.values) + scene.bidsLayer.children
            nodes += scene.trickArea.cardSprites.filter { !$0.hasActions() }.map { $0 as SKNode }
            if !scene.handNode.sprites.isEmpty { nodes.append(scene.handNode) }
            if !scene.trickManager.trickHistory.children.isEmpty { nodes.append(scene.trickManager.trickHistory) }
            for n in nodes {
                let f = n.calculateAccumulatedFrame()
                let r: CGRect
                if let p = n.parent, p !== scene {
                    let a = p.convert(CGPoint(x: f.minX, y: f.minY), to: scene), b = p.convert(CGPoint(x: f.maxX, y: f.maxY), to: scene)
                    r = CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
                } else {
                    r = f
                }
                if !safe.contains(r) { bad.append("\(n.name ?? n.role ?? "?") \(r.integral)") }  // the seats and the history have roles
            }
        }
        let check = bad.isEmpty ? "ok" : bad.joined(separator: "; ")
        let lifted = scene.handNode.liftedCardId ?? "-"
        // fans: the card backs each seat shows, by position ("-": the table shows no fans)
        let seats = scene.opponentManager.nodes.sorted { $0.key < $1.key }
        let showsFans = scene.lastModel.map { scene.layout.fans(spectating: $0.hand == nil) != nil } ?? false
        let fans = showsFans ? seats.map { "\($0.key):\($0.value.fanNode.count)" }.joined(separator: ",") : "-"
        let dealer = seats.first { $0.value.dealerNode.isShown }.map { "\($0.key)" } ?? (scene.myDealerNode.isShown ? "me" : "-")
        let state = "lifted=\(lifted) hand=\(scene.handNode.sprites.count) trick=\(scene.trickArea.cardCount) didMove=\(scene.didMoveCount)"
        let extras = "fans=\(fans) dealer=\(dealer)"
        if extras != tableExtras { tableExtras = extras }
        if check != layoutCheck { layoutCheck = check }
        if state != tableState { tableState = state }
        let dealing = Array(scene.handNode.sprites.values) as [SKNode] + scene.opponentManager.nodes.values.flatMap { $0.fanNode.children }
        let flying = dealing.filter { $0.deal?.flies == true }.count, fading = dealing.filter { $0.deal?.flies == false }.count
        let deal = "deals=\(scene.dealsShown) cards=\(scene.lastDeal.cards) mode=\(scene.lastDeal.mode) flying=\(flying) fading=\(fading) deck=\(scene.dealDeck == nil ? 0 : 1)"
        if deal != tableDeal { tableDeal = deal }
        let zoom = String(format: "%.2f", L.zoom)
        if zoom != tableZoom { tableZoom = zoom }
    }
}

/// The fixture probes, 1x1 and nearly transparent, readable by XCUITest.
struct FixtureProbes: View {
    @ObservedObject var probe = TableDebugProbe.shared

    var body: some View {
        VStack(spacing: 0) {
            dot("ui.pose", probe.pose)
            dot("table.layoutCheck", probe.layoutCheck)
            dot("table.state", probe.tableState)
            dot("table.extras", probe.tableExtras)
            dot("fixture.sent", probe.sent)
            dot("table.zoom", probe.tableZoom)
            dot("table.deal", probe.tableDeal)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .allowsHitTesting(false)
    }

    private func dot(_ id: String, _ value: String) -> some View {
        Rectangle()
            .fill(Color.black)
            .frame(width: 1, height: 1)
            .opacity(0.01)
            .accessibilityElement()
            .accessibilityLabel(id)
            .accessibilityIdentifier(id)
            .accessibilityValue(value)
    }
}

/// Measures the window (size + safe-area insets) for "ui.pose".
struct FixtureWindowProbe: View {
    @Environment(\.horizontalSizeClass) private var h
    @Environment(\.verticalSizeClass) private var v

    private static func name(_ c: UserInterfaceSizeClass?) -> String {
        switch c {
        case .compact: return "compact"
        case .regular: return "regular"
        default: return "-"
        }
    }

    var body: some View {
        GeometryReader { p in
            let i = p.safeAreaInsets
            let full = CGSize(width: p.size.width + i.leading + i.trailing, height: p.size.height + i.top + i.bottom)
            Color.clear
                .onChange(of: "\(Self.name(h))/\(Self.name(v))", initial: true) { _, s in TableDebugProbe.shared.sizeClasses = s }
                .onChange(of: full, initial: true) { _, s in TableDebugProbe.shared.window = s }
                .onChange(of: TableInsets(top: i.top, left: i.leading, bottom: i.bottom, right: i.trailing), initial: true) { _, v in
                    TableDebugProbe.shared.insets = v
                }
        }
        .allowsHitTesting(false)
    }
}
#endif
