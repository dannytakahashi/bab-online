#if DEBUG
import SwiftUI
import SpriteKit

/// Fixture mode (roadmap item 26), DEBUG builds only: `-uiFixture <name>`
/// (read through UserDefaults' argument domain) seeds the app from a contract
/// v2 snapshot (`v2/<name>.json`, bundled in Debug only) or from the
/// `UI_FIXTURE_SNAPSHOT` environment JSON, and the app never connects (no
/// socket, no voice, avatars show initials). Screen fixtures (`main-room`,
/// `game-lobby`, `tournament-lobby`, `tournament-round` (round 3 in play: the
/// scoreboard and two active tables), `tournament-between` (round 2 complete),
/// `sign-in`, `register`; `-uiOffline YES` shows them connecting) seed static rows instead.
/// `-uiSplash YES` / `-uiSplashFrame <seconds>` show the boot splash, `-uiPhrase <n>` picks
/// the sign-in's phrase. 1.2.2 parity screens: `main-room-cards` (the lobby
/// cards: member names, Rejoin on a full lobby that seats me, Full, in-progress games with
/// hand / score / watchers), `game-lobby-reconnecting` (a held seat's "Reconnecting…"),
/// `tournament-deadline` (between rounds past the ready deadline, me the host: "Start with
/// ready players", "Sitting out"; `-uiHost <name>` makes another member the host),
/// `tournament-results` (the final lobby, TournamentFinalView, with every round and the round markers;
/// `-uiPlainResults YES`: no markers, as an older server). `-uiInfoToast "<message>"` raises
/// the neutral toast (a new host, a cancelled tournament) and `-uiVoicePanel YES` opens the
/// voice panel over `game-lobby` with two players (their volume sliders). `game-lobby-bots` is the game lobby with two bots
/// that are not ready (my seat ready): there removeBot and addBot change the list the way
/// the server answers them (`emulateLobby`) and show in "fixture.sent" as `removeBot:<id>` / `addBot`.
/// `-uiFold book|tabletop` simulates a fold region (FoldReader) for screenshots; `-uiFoldAt <f>`
/// moves it off the window's centre by f of the window (book + right, tabletop + down).
/// `-uiLobbyName "<title>"` (or the environment's `UI_FIXTURE_LOBBY_NAME`, which keeps an
/// apostrophe: XCUITest's launch arguments read "iosplay1's" as a quote) renames a
/// game-lobby fixture's lobby (the header's fit).
/// `-uiLeaveDrive settle|hold` drives the Leave alert's reopen (`leaveAlertPresented`), and
/// the chat messages the app sends show in the "fixture.sent" probe (`recordSent`).
enum UIFixture {
    static let name: String? = UserDefaults.standard.string(forKey: "uiFixture")
    static var isActive: Bool { name != nil }

    enum Fold: String { case book, tabletop }
    /// Synthetic 20 pt division at the window center (screenshots only; the real API is FoldReader's).
    static let fold: Fold? = UserDefaults.standard.string(forKey: "uiFold").flatMap(Fold.init(rawValue:))
    /// `-uiFoldAt <f>`: the synthetic division's centre f of the window's width (book, + right) or
    /// height (tabletop, + down) off the window's centre, at most 0.4 either way (default 0). The
    /// centred 20 pt fold is the open Duo's; a phone's window ignores it (TableLayout.foldIgnored:
    /// a book split crowds the seats, a tabletop one leaves no room), so the UI tests that check
    /// what keeps off a fold move it to where that window's layout keeps it (TableParityUITests).
    static let foldAt: CGFloat = min(0.4, max(-0.4, CGFloat(Double(UserDefaults.standard.string(forKey: "uiFoldAt") ?? "") ?? 0)))

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

    /// `-uiVoice YES`: my seat's row (and the game lobby's header) shows the voice button as if
    /// voice were on (fixture mode never starts voice; screenshots and the seat-row and lobby
    /// header UI tests).
    static let showsVoiceButton: Bool = isActive && UserDefaults.standard.bool(forKey: "uiVoice")

    /// `-uiVoicePanel YES`: the game lobby opens the voice panel (fixture mode never starts voice).
    static let showsVoicePanel: Bool = isActive && UserDefaults.standard.bool(forKey: "uiVoicePanel")

    /// `-uiSpectatorVoice muted|denied|full` on a spectator table (`draw-spectator`,
    /// `spectator-mid-hand`, `game-end-spectator`): the pill's voice button as a spectator joins
    /// voice, muted ("Unmute microphone"; a tap unmutes, in fixture mode only the button), after
    /// a refused mic (headphones, "Listening only (no mic access)"), or "Voice is full (8
    /// people)". A long press opens the panel, with a player and a watcher.
    static let spectatorVoice: String? = isActive ? UserDefaults.standard.string(forKey: "uiSpectatorVoice") : nil
    /// The pill's voice button is up (`-uiSpectatorVoice muted|denied`).
    static var showsSpectatorVoiceButton: Bool { spectatorVoice == "muted" || spectatorVoice == "denied" }

    /// `-uiVoiceTip YES` with a voice button (`-uiVoice YES`, `-uiSpectatorVoice muted|denied`): the
    /// voice panel tip may show (VoicePanelTip; fixture mode never shows it otherwise), and stays
    /// 60 s. `-uiVoiceTipFresh YES` clears its seen flag first (a fresh install); without it a
    /// second launch finds the flag the first one set.
    static let showsVoiceTip: Bool = isActive && UserDefaults.standard.bool(forKey: "uiVoiceTip")
    static let voiceTipFresh: Bool = isActive && UserDefaults.standard.bool(forKey: "uiVoiceTipFresh")

    /// `-uiSplash YES`: a fixture launch shows the boot splash first, as a real launch does
    /// (fixture mode skips it otherwise). `-uiSplashFrame <seconds>` holds the splash at that
    /// moment of its animation (it never hands off: screenshots of the frames).
    static let showsSplash: Bool = isActive && (UserDefaults.standard.bool(forKey: "uiSplash") || splashFrame != nil)
    static let splashFrame: TimeInterval? = isActive ? UserDefaults.standard.string(forKey: "uiSplashFrame").flatMap(Double.init) : nil
    /// `-uiReduceMotion YES` also gives the splash its Reduce Motion form (the system setting
    /// cannot be set from a launch argument).
    static let splashReduceMotion: Bool = isActive && UserDefaults.standard.bool(forKey: "uiReduceMotion")

    /// `-uiPhrase <index>`: the sign-in's phrase by the logo is SplashPhrases.all[index]
    /// (screenshots of the longest one) instead of a random one.
    static let phraseIndex: Int? = isActive ? UserDefaults.standard.string(forKey: "uiPhrase").flatMap(Int.init) : nil

    static let screenFixtures: Set<String> = ["main-room", "main-room-empty", "main-room-cards", "game-lobby", "game-lobby-bots",
                                              "game-lobby-family", "game-lobby-family-full", "main-room-family",
                                              "game-lobby-reconnecting", "tournament-lobby", "tournament-round",
                                              "tournament-between", "tournament-deadline", "tournament-results", "tournament-pairings", "tournament-cut",
                                              "tournament-rounds", "update-required", "sign-in", "register"]

    @MainActor
    static func seed(_ store: GameState, _ appState: AppState, mainRoom: MainRoomState, lobby: LobbyState,
                     tournament: TournamentState, auth: AuthState) {
        guard let name else { return }
        seed(fixture: name, store, appState, mainRoom: mainRoom, lobby: lobby, tournament: tournament, auth: auth)
        // `game-end-tournament -uiCut "<n> <stage>"`: the score screen's Cut for a buck strip (UIFixture+Cut)
        seedCutOnScoreScreen(store, tournament: tournament)
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
        if showsSpectatorVoiceButton {
            // a player and a watcher in the panel (the watcher's name is on the badge's list)
            VoiceChatManager.shared.peerInfos = [
                "sid-p": VoiceChatManager.PeerInfo(username: "ivy"),
                "sid-w": VoiceChatManager.PeerInfo(username: "lou"),
            ]
        }
        // Get Your Bid (UIFixture+GetYourBid.swift): its table, lobby and main-room fixtures
        if seedGyb(name, store, appState, mainRoom: mainRoom, lobby: lobby, auth: auth) {
            print("[UIFixture] seeded Get Your Bid \(name)")
            return
        }
        if screenFixtures.contains(name) {
            seedScreen(name, appState, mainRoom: mainRoom, lobby: lobby, tournament: tournament, auth: auth)
            // iOS 1.2.7's tournament extras: the over-cap notice, the rounds' answers (UIFixture+Tournament)
            seedTournamentExtras(tournament)
            if name.hasPrefix("tournament-") { seedTournamentRoles(tournament, me: auth.username) }
            // `-uiLobbyName "<title>"` / UI_FIXTURE_LOBBY_NAME: a game lobby's title (the header's
            // fit at a real lobby's name)
            if let title = ProcessInfo.processInfo.environment["UI_FIXTURE_LOBBY_NAME"]
                ?? UserDefaults.standard.string(forKey: "uiLobbyName") { lobby.lobbyName = title }
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
            if drawTeams, drawStates.contains(name) || name == "draw-in-progress" { editDrawTeams(name, &snapDict) }
            editFaults(&snapDict)
            editSeatBadges(&snapDict)  // -uiSeatBadges (UIFixture+SeatBadges.swift)
            editAssistHand(&snapDict)
            editAsSpectator(&snapDict)
            let snap = try TableSnapshot.decode(snapDict, strict: true)
            seededSnapshot = snapDict
            let me = spectatorName ?? snap.seats.first { $0.position == snap.viewer.position }?.username ?? drawer
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
            if gameEndStates[name] != nil, lobbyReturnMode != "lost" {
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
            seedAssist(store, auth: auth)
            seedTutorial(store, auth: auth)
            seedWatchedHint(store, auth: auth)
            seedShoulder(store, auth: auth)
            seedFaults(store, snap)
            seedSeatBadges(store, snap)
            seedWatchers(store, snap)  // -uiWatchers (UIFixture+Watchers.swift)
            seedSpeakingSpectators()  // -uiSpeakingSpectators (UIFixture+Watchers.swift)
            appState.screen = .game
            if lobbyReturnMode != nil, gameEndStates[name] != nil, let gameId = snapDict["gameId"] as? String {
                seedLobbyReturn(gameId: gameId, me: me ?? "viewer", seats: snap.seats.compactMap(\.username),
                                store, appState, lobby: lobby)
            }
            print("[UIFixture] seeded \(name): phase \(store.phase)")
        } catch {
            print("[UIFixture] \(name): \(error)")
        }
    }

    // MARK: - Play again (1.2.2 (12), PlayAgainUITests)

    /// `-uiLobbyReturn YES` on `game-end` / `game-end-spectator`: 0.5 s after the gameEnd the
    /// server's lobbyReturn arrives (`LobbyReturn.receive`): the lobby "Family night" with me
    /// as its host, two other players of the table (the first a returning row, "Not back
    /// yet"), a bot, and an expected older-app player, "grandpa" (4 members + 1 expected). `-uiLobbyReturn lost`: the same with no
    /// gameEnd (held in the seq gate for good): the app enters the lobby after
    /// `LobbyReturn.gameEndWait`. releaseLobbyHold shows in "fixture.sent" as
    /// `releaseLobbyHold:<name>` and the place goes 0.3 s later, as the server's list does.
    static let lobbyReturnMode: String? = isActive ? UserDefaults.standard.string(forKey: "uiLobbyReturn") : nil
    /// `-uiOnResults YES` with `-uiLobbyReturn`: the second other player (kim) and I still read
    /// the results (`members[].onResults`, as the server sends every moved row at the return):
    /// kim's row says "Still on the results", mine never does.
    static let onResultsMode = isActive && UserDefaults.standard.bool(forKey: "uiOnResults")

    @MainActor
    private static func seedLobbyReturn(gameId: String, me: String, seats: [String], _ store: GameState, _ appState: AppState,
                                        lobby: LobbyState) {
        fixtureLobby = lobby
        let others = Array(seats.filter { $0 != me }.prefix(2))
        var members: [[String: Any]] = [["socketId": "sid-\(me)", "username": me, "ready": false, "playing": true]]
        if onResultsMode { members[0]["onResults"] = true }
        for (i, u) in others.enumerated() {
            var m: [String: Any] = ["socketId": i == 0 ? "away:fixture-\(u)" : "sid-\(u)", "username": u, "ready": false, "playing": true]
            if i == 0 { m["reconnecting"] = true; m["returning"] = true }
            if i == 1, onResultsMode { m["onResults"] = true }
            members.append(m)
        }
        members.append(["socketId": "bot:fixture-1", "username": "\u{1F916} Bot", "ready": false, "playing": false, "isBot": true])
        let payload: [String: Any] = [
            "lobbyId": "00000000-0000-4000-8000-0000000000aa", "name": "Family night",
            "players": Array(members.prefix(4)), "members": members,
            "messages": [["username": others.last ?? "kim", "message": "gg! again?", "timestamp": Date().timeIntervalSince1970 * 1000]],
            "host": me, "settings": ["spectatorsCanTalk": true], "capacity": 8, "expected": ["grandpa"],
            "lastGame": ["gameId": gameId, "score": ["team1": 312, "team2": 287], "playerStats": [String: Any](), "position": NSNull()],
        ]
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            LobbyReturn.receive(payload, lobbyState: lobby, appState: appState, gameState: store, isBlocked: { _ in false },
                                leaveLobby: { print("[UIFixture] lobbyReturn: leaveLobby") })
        }
    }

    /// The server's answer to "Don't wait" (playAgain.releaseLobbyHold): the hold's row or the
    /// expected name goes.
    private static func emulateRelease(_ username: String) {
        guard lobbyReturnMode != nil, let lobby = fixtureLobby else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            lobby.players.removeAll { $0.username == username && $0.returning }
            lobby.reconnecting.remove(username)
            lobby.expected.removeAll { $0 == username }
        }
    }

    // MARK: - 1.2.2 table states (TableParityUITests)

    /// `-uiIdleOffer <position>`: the tournament table's idle-seat offer for that seat, as the
    /// server sends it (private resignationAvailable with `idle: true`).
    /// `-uiReject <reason>`: 1 s after the table is up, the server refuses my action
    /// (actionRejected `{action: play, reason}`): the toast with the reason, held 60 s.
    /// `-uiDealer <position>`: that seat dealt this hand (the snapshot's dealer otherwise).
    /// `-uiHandNo <n>`: the deal is hand n (the snapshot's deal.handNo; its cards unchanged):
    /// the card backs take that hand's colour (CardBackColour; probe `table.extras` back=).
    /// `-uiToasts YES`: the toast layer is up and holds a toast 60 s (a tap on a dimmed card).
    /// `-uiBidClock <seconds>`: the bid clock runs for the seat on turn (`-uiBidClockSeat <pos>`:
    /// that seat instead), as the server's running event, with the countdown showing exactly
    /// that many seconds and held there (the store's clock frozen; `-uiBidClockLive YES` lets it
    /// run down). Fixture mode is silent, so no tune plays.
    @MainActor
    private static func seedTableExtras(_ store: GameState, _ snap: TableSnapshot, auth: AuthState) {
        let defaults = UserDefaults.standard
        let dealer = Int(defaults.string(forKey: "uiDealer") ?? "").flatMap { (1...4).contains($0) ? $0 : nil }
        let handNo = Int(defaults.string(forKey: "uiHandNo") ?? "").flatMap { (1...13).contains($0) ? $0 : nil }
        if dealer != nil || handNo != nil, var dict = seededSnapshot, var deal = dict["deal"] as? [String: Any] {
            if let dealer { deal["dealer"] = dealer }
            if let handNo { deal["handNo"] = handNo }
            dict["deal"] = deal
            if let edited = try? TableSnapshot.decode(dict, strict: true) {
                seededSnapshot = dict
                store.apply(.snapshot(edited, .rejoin, hints: nil))
            }
        }
        if let secs = Int(defaults.string(forKey: "uiBidClock") ?? ""), secs > 0 {
            if !defaults.bool(forKey: "uiBidClockLive") {
                let frozen = store.clockNow()
                store.clockNow = { frozen }
            }
            let pos = Int(defaults.string(forKey: "uiBidClockSeat") ?? "").flatMap { (1...4).contains($0) ? $0 : nil } ?? snap.turn?.position ?? 1
            // inMs - the countdown's margin = exactly `secs` on the pill
            let inMs = secs * 1000 + Int(BidCountdownModel.uiMargin * 1000)
            _ = store.apply(serverEvent: "bidClock", payload: [[
                "gameId": snap.gameId, "position": pos, "running": true, "inMs": inMs, "durationMs": 30000,
            ] as [String: Any]])
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
        // deal's fly-in plays (probe "table.deal"); `-uiDealSize <n>` deals n cards instead
        // (HandSequence: 10 is hand 2, a blue deck and blue backs); its hsiValues give my seat
        // `-uiDealHSI <v>` (172.4 by default), shown "HSI --" until HSIScale.revealDelay later;
        // `-uiReduceMotion YES` pins Reduce Motion on (Theme.Motion.reduceMotionOverride)
        if defaults.bool(forKey: "uiReduceMotion") { Theme.Motion.reduceMotionOverride = true }
        if defaults.bool(forKey: "uiDeal") {
            let size = Int(defaults.string(forKey: "uiDealSize") ?? "").flatMap { (1...13).contains($0) ? $0 : nil } ?? 13
            let dealHSI = Double(defaults.string(forKey: "uiDealHSI") ?? "") ?? 172.4
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
                let ranks = ["A", "K", "Q", "J", "10", "9", "8"]
                let thirteen: [[String: Any]] = (ranks.map { ["suit": "spades", "rank": $0] } + ranks.prefix(6).map { ["suit": "hearts", "rank": $0] })
                let cards = Array(thirteen.prefix(size))
                var payload: [String: Any] = [
                    "gameId": snap.gameId, "hand": cards, "trump": ["suit": "clubs", "rank": "5"], "score1": 0, "score2": 0,
                    "dealer": 4, "currentHand": size, "seq": (store.state.sync.lastSeq ?? snap.seq) + 1,
                    "playerInfo": snap.seats.map { ["position": $0.position, "username": $0.username ?? "P\($0.position)"] as [String: Any] },
                ]
                // every seat's, mine `dealHSI`
                var hsi: [String: Double] = ["1": 101.5, "2": 118.0, "3": 133.0, "4": 96.0]
                if let pos = snap.viewer.position { hsi[String(pos)] = dealHSI }
                payload["hsiValues"] = hsi
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
    static var seededSnapshot: [String: Any]?

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
            // -uiAssist YES: the server's private answer to /help (UIFixture+Assist)
            if m == AssistRules.command { answerHelpLater() }
            // -uiTutorial YES: the server's answer to /tutorial (UIFixture+Tutorial)
            if m == TutorialRules.command || m.hasPrefix(TutorialRules.command + " ") { answerTutorialLater(m) }
        case SocketEvents.Client.removeBot where name == "game-lobby-bots":
            message = "removeBot:\(data["botSocketId"] as? String ?? "-")"
        case SocketEvents.Client.addBot where name == "game-lobby-bots":
            message = "addBot"
        case SocketEvents.Client.blockUser, SocketEvents.Client.unblockUser, SocketEvents.Client.reportUser:
            message = profileSent(event, data)  // answered as the server does (UIFixture+Profile)
        case SocketEvents.Client.lobbyReturnSeen:
            message = "lobbyReturnSeen"
        case SocketEvents.Client.createLobby:
            // New Game's choice (GybLobbyUITests): the game it asked for
            message = (data["mode"] as? String).map { "createLobby:\($0)" } ?? "createLobby"
        case SocketEvents.Client.watchHand:
            // -uiShoulder: answered as the server does (UIFixture+Shoulder)
            message = "watchHand:\((data["position"] as? Int).map(String.init) ?? "null")"
            answerWatchLater(data)
        case SocketEvents.Client.releaseLobbyHold:
            let username = data["username"] as? String ?? "-"
            message = "releaseLobbyHold:\(username)"
            emulateRelease(username)
        case SocketEvents.Client.cutForABuckDraw:
            // answered as the server does (UIFixture+Cut)
            message = "cutForABuckDraw:\(data["round"] as? Int ?? 0):\((data["slot"] as? Int).map(String.init) ?? "null")"
            emulateCutDraw(data)
        case SocketEvents.Client.setTournamentRounds:
            // answered as the server does (UIFixture+Tournament)
            message = tournamentRoundsSent(data)
        case SocketEvents.Client.tournamentReady, SocketEvents.Client.tournamentUnready,
             SocketEvents.Client.beginTournament, SocketEvents.Client.beginNextRound,
             SocketEvents.Client.cancelTournament, SocketEvents.Client.leaveTournament:
            guard let sent = tournamentActionSent(event) else { return }
            message = sent
        case SocketEvents.Client.setSpectatorsCanTalk:
            // this build has no switch (2026-11-18); a send would show here
            message = "setSpectatorsCanTalk"
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
        guard name == "game-lobby-bots", event == SocketEvents.Client.removeBot || event == SocketEvents.Client.addBot,
              let lobby = fixtureLobby else { return }
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
    /// `-uiDrawTeams YES` on a draw state (and `draw-in-progress`): a tournament table's planned
    /// teams (snapshot draw.teams), so the draw is for first deal with the teams under the title:
    /// fay & gus vs 🤖 Mike & eve in plan order (draw-teams' teamsAnnounced; draw-long's long
    /// names for eve and gus).
    static let drawTeams: Bool = isActive && UserDefaults.standard.bool(forKey: "uiDrawTeams")

    private static func editDrawTeams(_ name: String, _ snap: inout [String: Any]) {
        guard var draw = snap["draw"] as? [String: Any] else { return }
        let (third, fourth) = name == "draw-long" ? ("JoAnn Jameson", "Christopher Johnson1") : ("eve", "gus")
        let p = { (u: String, bot: Bool) -> [String: Any] in ["username": u, "isBot": bot] }
        draw["teams"] = [[p("fay", false), p(fourth, false)], [p("🤖 Mike", true), p(third, false)]]
        snap["draw"] = draw
    }
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
        case "game-lobby-family", "game-lobby-family-full":
            // a family lobby (1.2.2 (12)) as the server sends it to a capable member
            // (GameManager.lobbyWire: players = the first 4, members = everyone): 6 humans and
            // a bot that sits out (no human seat needs it). `-family`: kim and hal readied
            // (Playing); `-family-full`: kim, hal, jon and ora hold the table, so I (ivy) and
            // max will watch. Me the host unless `-uiHost <name>`.
            let full = name == "game-lobby-family-full"
            let host = UserDefaults.standard.string(forKey: "uiHost") ?? "ivy"
            let readied = full ? ["kim", "hal", "jon", "ora"] : ["kim", "hal"]
            let members: [[String: Any]] = ["ivy", "kim", "hal", "jon", "ora", "max", "🤖 Bot"].map { u in
                let bot = u.hasPrefix("🤖")
                var m: [String: Any] = ["socketId": bot ? "bot:fixture-1" : "sid-\(u)", "username": u,
                                        "ready": readied.contains(u), "playing": readied.contains(u)]
                if bot { m["isBot"] = true }
                return m
            }
            lobby.lobbyId = "l1"
            lobby.lobbyName = "Family night"
            lobby.applyPlayers(from: [
                "lobbyId": "l1", "players": Array(members.prefix(4)).map { $0.filter { $0.key != "playing" } },
                "members": members, "host": host, "settings": ["spectatorsCanTalk": true], "capacity": 8,
            ], namesHeldSeats: true)
            lobby.messages = chat
            fixtureLobby = lobby
            appState.screen = .gameLobby
        case "main-room-family":
            // the main-room cards of family lobbies: 6 of 8 with me as member 6 (Join), a full
            // 8/8 that still holds my seat as member 7 (Rejoin), a capacity-4 lobby with a
            // legacy member that is full (Full)
            let six = ["kim", "hal", "jon", "ora", "max", "ivy"], eight = ["pat", "ned", "sam", "tia", "uma", "vic", "ivy", "wes"]
            mainRoom.lobbies = [
                Lobby(id: "l1", name: "Family night", players: six.prefix(4).map { player($0) }, playerCount: 4,
                      memberCount: 6, capacity: 8, memberUsernames: six),
                Lobby(id: "l2", name: "Cousins", players: eight.prefix(4).map { player($0) }, playerCount: 4,
                      memberCount: 8, capacity: 8, memberUsernames: eight),
                Lobby(id: "l3", name: "Old phones", players: ["abe", "bea", "cal", "dot"].map { player($0) }, playerCount: 4,
                      memberCount: 4, capacity: 4, memberUsernames: ["abe", "bea", "cal", "dot"]),
            ]
            mainRoom.messages = chat
            mainRoom.onlineCount = 12
            mainRoom.onlineUsers = ["ivy", "kim", "hal"]
            appState.screen = .mainRoom
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
        case "tournament-rounds":
            // the host's Rounds picker before Begin (UIFixture+Tournament)
            seedTournamentRounds(appState, tournament: tournament, auth: auth)
        case "tournament-pairings":
            // round 3 in play (owner 2026-11-25: partners shown openly): ivy's partners so far are a
            // bot (round 1), nobody (sat out round 2) and a 20-character name (round 3); a long name
            // on the other team too. `-uiSpectator YES`: a tournament spectator (every round's tables).
            let long1 = "Christopher Johnson1", long2 = "Alexandra Montgomery"
            let names = ["kim", "ivy", "hal", "jon", "ora", "max", long1, long2]
            tournament.tournamentId = "t1"
            tournament.name = "Sunday Cup"
            tournament.phase = "round_active"
            tournament.currentRound = 3
            tournament.creatorUsername = "kim"
            tournament.isSpectator = UserDefaults.standard.bool(forKey: "uiSpectator")
            if tournament.isSpectator { auth.username = "lou" }
            tournament.players = names.map {
                TournamentPlayer(id: "sid-\($0)", username: $0, pic: nil, isReady: false, isCreator: $0 == "kim", connected: true)
            }
            let rounds: [[Int]] = [[142, 88], [120, -20], [97, 64], [-40, 152], [76, 49], [55, 31], [31, 18], [-12, 7]]
            tournament.scoreboard = zip(names, rounds)
                .map { TournamentScoreEntry(id: $0, username: $0, totalScore: $1.reduce(0, +), roundScores: $1) }
                .sorted { $0.totalScore > $1.totalScore }
            tournament.pairings = TournamentRoundPairings.list([
                ["roundNumber": 1, "tables": [
                    ["gameId": "g1", "teams": [["ivy", NSNull()], ["kim", NSNull()]]],
                    ["gameId": "g2", "teams": [["hal", "jon"], ["ora", "max"]]],
                    ["gameId": "g3", "teams": [[long1, NSNull()], [long2, NSNull()]]],
                ]],
                ["roundNumber": 2, "tables": [
                    ["gameId": "g4", "teams": [["kim", "hal"], ["jon", long1]]],
                    ["gameId": "g5", "teams": [["ora", long2], ["max", NSNull()]]],
                ]],
                ["roundNumber": 3, "tables": [
                    ["gameId": NSNull(), "teams": [[long2, "kim"], ["ivy", long1]]],
                    ["gameId": NSNull(), "teams": [["hal", NSNull()], ["jon", "ora"]]],
                    ["gameId": NSNull(), "teams": [["max", NSNull()], [NSNull(), NSNull()]]],
                ]],
            ] as [Any]) ?? []
            tournament.activeGames = [
                TournamentActiveGame(id: "g6", humanPlayers: ["ivy", long1, long2, "kim"], botCount: 0, status: "active"),
                TournamentActiveGame(id: "g7", humanPlayers: ["hal", "jon", "ora"], botCount: 1, status: "active"),
            ]
            tournament.messages = chat + messages([("System", "Round 3 has begun")])
            appState.screen = .tournamentLobby
        case "update-required":
            // the upgrade gate's update screen (s2c updateRequired) over the main room, signed in
            auth.isAuthenticated = true
            mainRoom.messages = chat
            appState.screen = .mainRoom
            UpdateRequiredState.shared.receive([
                "message": "Update required. Please update BAB Online in the App Store. You'll stay signed in.",
                "url": "https://apps.apple.com/app/id6759510890",
            ])
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
        case "tournament-cut":
            // Cut for a buck (`-uiCut "<n> <stage>"`, UIFixture+Cut)
            seedCut(appState, tournament: tournament, auth: auth)
        case "register":
            SocketService.shared.isConnected = !UserDefaults.standard.bool(forKey: "uiOffline")
            appState.screen = .register
        default:
            // no socket in fixture mode: show the connected form (emits go nowhere), not the
            // spinner (`-uiOffline YES`: the "Connecting to server..." form)
            SocketService.shared.isConnected = !UserDefaults.standard.bool(forKey: "uiOffline")
            appState.screen = .signIn
        }
    }
}

/// No network in fixture mode: every avatar shows its initial, unless `UI_FIXTURE_AVATARS`
/// names a folder with the stock art (`profile<N>.png`, the repo's client/assets: screenshots).
struct FixtureAvatarLoader: AvatarLoading {
    func load(_ picNumber: Int, completion: @escaping (PlatformImage?) -> Void) {
        completion(UIFixture.avatarFolder.flatMap { PlatformImage(contentsOfFile: "\($0)/profile\(picNumber).png") })
    }
}

/// What the fixture UI tests read through accessibility probes:
/// "ui.pose", "table.layoutCheck", "table.state", "table.extras", "table.zoom", "table.deal", "table.bidClock".
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
    /// The seats as drawn (Get Your Bid's three-seat table, GybTableUITests): "seats=3 1:left 2:right
    /// trick=2:left,3:right clear=ok|over:<a>/<b>,..." (each opponent seat's slot by position, each
    /// trick card's slot, and whether any two of the seats' footprints, the trick cards and my hand overlap).
    @Published var tableSeats = "-"
    /// The avatar badges (SeatBadgeNode, TableLayout+Badges.swift): "<pos>:bulb|cap|- <x y w h>
    /// clear=ok|over:<what>;... pops=<n> pop=scale|fade|-" per seat with an avatar, by position (the
    /// drawn badge's frame in the pane's points and what of the layout's badge keeps it covers;
    /// "<pos>:-" for none), the lightbulb pops shown and the latest one's kind.
    @Published var tableBadges = "-"
    /// The table's zoom (TableLayout.zoom, "1.00" ... "1.40"): the UI tests scale their point limits by it.
    @Published var tableZoom = "-"
    /// The over-the-shoulder view (UIFixture+Shoulder): "watch=<pos|-> paused=<0|1> hand=<n>
    /// seats=<pos>:<x>,<y>;..." (each seat avatar's centre in the pane's points, for a tap).
    @Published var tableShoulder = "-"
    /// The watching pill's avatar badge (WatchingPill, SeatBadgeChip): "<bulb|cap|-> chip=<x y w h|->
    /// avatar=<x y w h> text=<x y w h> pill=<x y w h> pops=<n> pop=scale|fade|-", global points
    /// ("-": no pill); pops counts the chip's pops this launch (BadgePop), pop the last one's kind.
    @Published var shoulderBadge = "-"
    var shoulderBadgeKind: String? { didSet { updateShoulderBadge() } }
    var shoulderBadgeFrames: [String: CGRect] = [:] { didSet { updateShoulderBadge() } }
    private var pillPops = 0
    private var lastPillPop = "-"

    func notePillPop(fade: Bool) {
        pillPops += 1
        lastPillPop = fade ? "fade" : "scale"
        updateShoulderBadge()
    }

    private func updateShoulderBadge() {
        guard let kind = shoulderBadgeKind else {
            if shoulderBadge != "-" { shoulderBadge = "-" }
            return
        }
        func r(_ key: String) -> String {
            guard key != "chip" || kind != "-", let f = shoulderBadgeFrames[key] else { return "-" }
            return String(format: "%.1f %.1f %.1f %.1f", f.minX, f.minY, f.width, f.height)
        }
        let text = "\(kind) chip=\(r("chip")) avatar=\(r("avatar")) text=\(r("text")) pill=\(r("pill")) pops=\(pillPops) pop=\(lastPillPop)"
        if text != shoulderBadge { shoulderBadge = text }
    }
    /// Where my mic is (UIFixture+SelfSpeaking): "at=bar|felt|- symbol=<sf symbol> tint=red|green|-".
    @Published var tableVoice = "-"
    /// The spectator badge's speaking outline (SpectatorBadgeView, SpeakingWatchers):
    /// "lit=<0|1> names=<a,b|-> unnamed=<n>"; "-" while no badge shows.
    @Published var spectatorsSpeaking = "-"
    /// The window's size classes ("compact/regular" = h/v), recorded with the pose.
    @Published var sizeClasses = "-"
    /// The system's vertical bar edge ("trailing" / "leading"), "-" where none is used.
    @Published var verticalBar = "-"
    /// The chat messages sent, "|"-joined ("-": none; UIFixture.recordSent).
    @Published var sent = "-"
    /// The live deal (GameSKScene.dealIn): "deals=1 cards=52 mode=fly peak=52 decks=red hinges=ok
    /// flying=52 fading=0 deck=1 deckBack=red hinge=ok fold=kept" (deals shown; the latest one's cards and
    /// kind, fly or Reduce Motion's fade; over that deal's refreshes, the most cards in flight at
    /// once, the deck colours and the hinge readings seen while its deck was up ("-": none);
    /// then now: cards still in a flight or a fade, the deck up or not, its colour and hinge, and
    /// the layout's fold: kept (TableLayout keeps to it, so `hinge` is ok / over), ignored (no room:
    /// `hinge` is "-") or "-" (none in the scene's chrome, e.g. a docked book split)).
    /// The "now" part is only what the last refresh saw, and any render refreshes it: the HSI
    /// reveal 1 s into a deal, after the first cards land (0.9 s) and the deck is gone (0.87 s),
    /// shows "flying=40 deck=0". The deal's first refresh is queued by dealIn itself, which has
    /// every card in flight and the deck up by then, so `peak` / `decks` / `hinges` hold the
    /// whole deal whenever the probe is read.
    @Published var tableDeal = "-"
    /// The deal (`dealsShown`) the `peak` / `decks` / `hinges` above are for, and their values.
    private var dealSeenFor = 0, dealPeak = 0, dealDecks = Set<String>(), dealHinges = Set<String>()
    /// My /help answer on the table (AssistCardView's hint, TableReducer+Assist):
    /// "card=<id> bid=<b> frame=<x y w h> clear=ok|over:<what>|- keeps=<what>|- seats=ok|over:<what>|-" from the scene's
    /// ringed hand card, the bid panel's ringed bid, the card's frame in the pane's points, what
    /// it covers of what it keeps clear of, and those (my bid clock, my seat's row, the fold:
    /// AssistLayout.Keeps; "-": no card, nothing).
    @Published var tableAssist = "card=- bid=- frame=- clear=- keeps=- seats=-"
    var assistParts = "card=- bid=-" { didSet { updateAssist() } }
    /// The /help card's frame in the pane's points (GameContainerView).
    var assistFrame: CGRect? { didSet { updateAssist() } }
    /// What the card keeps clear of (AssistLayout.Keeps.probe).
    var assistKeeps: [String: CGRect] = [:] { didSet { updateAssist(); updateTutorial() } }
    /// The other seats' parts (AssistLayout.Keeps.seats: "seat<n>" avatar and name, "bubble<n>",
    /// "dealer<n>"): the probe's "seats=ok|over:<what>" (what of them the cards cover).
    var assistSeats: [String: CGRect] = [:] { didSet { updateAssist() } }
    /// The tutorial's switch: "chip=bar clear=ok ask=-" (the vertical bar's item), or
    /// "chip=corner [beside ]<x y w h> clear=ok|over:<what> ask=<x y w h>|-" (TutorialCornerButton: its frame
    /// in the pane's points against what the column keeps clear of, AssistLayout.Keeps, and the
    /// lightbulb's frame as the column knows it), else "chip=- clear=-"; then " pin=<x y w h>|-":
    /// the tip's title row pinned at a short column's top.
    @Published var tableTutorial = "chip=- clear=- pin=-"
    var tutorialChipFrame: CGRect? { didSet { updateTutorial() } }
    /// The switch is the vertical bar's item (GameContainerView.tutorialBarToggle): the probe's
    /// "chip=bar clear=ok" (the bar is the system's column, beside the table).
    var tutorialInBar = false { didSet { updateTutorial() } }
    /// The switch is the corner's button (GameContainerView.showsCornerTutorial).
    var tutorialInCorner = false { didSet { updateTutorial() } }
    /// The corner button sits beside the log's, not under it (TableLayout.tutorialBeside): the
    /// probe's "chip=corner beside ...".
    var tutorialBeside = false { didSet { updateTutorial() } }
    /// The tip's title row pinned at a short column's top (GameContainerView.pinnedTipHead):
    /// the probe's " pin=<x y w h>|-".
    var tutorialPinFrame: CGRect? { didSet { updateTutorial() } }

    private func updateTutorial() {
        var text = "chip=- clear=-"
        if tutorialInBar {
            text = "chip=bar clear=ok ask=-"
        } else if tutorialInCorner, let f = tutorialChipFrame {
            let over = assistKeeps.filter { $0.value.intersection(f.insetBy(dx: 0.5, dy: 0.5)).isNull == false }.keys.sorted()
            let ask = assistKeeps["ask"].map { String(format: "%.1f %.1f %.1f %.1f", $0.minX, $0.minY, $0.width, $0.height) } ?? "-"
            text = (tutorialBeside ? "chip=corner beside " : "chip=corner ")
                + String(format: "%.1f %.1f %.1f %.1f", f.minX, f.minY, f.width, f.height)
                + " clear=\(over.isEmpty ? "ok" : "over:" + over.joined(separator: ",")) ask=\(ask)"
        }
        text += " pin=" + (tutorialPinFrame.map { String(format: "%.1f %.1f %.1f %.1f", $0.minX, $0.minY, $0.width, $0.height) } ?? "-")
        if text != tableTutorial { tableTutorial = text }
    }

    private func updateAssist() {
        let frame = assistFrame.map { String(format: "%.1f %.1f %.1f %.1f", $0.minX, $0.minY, $0.width, $0.height) } ?? "-"
        var clear = "-"
        if let f = assistFrame {
            // a shared edge is not a cover (half a point of rounding)
            let over = assistKeeps.filter { $0.value.intersection(f.insetBy(dx: 0.5, dy: 0.5)).isNull == false }.keys.sorted()
            clear = over.isEmpty ? "ok" : "over:" + over.joined(separator: ",")
        }
        var seats = "-"
        if let f = assistFrame {
            let over = assistSeats.filter { $0.value.intersection(f.insetBy(dx: 0.5, dy: 0.5)).isNull == false }.keys.sorted()
            seats = over.isEmpty ? "ok" : "over:" + over.joined(separator: ",")
        }
        let kept = assistKeeps.keys.sorted().joined(separator: ",")
        let text = "\(assistParts) frame=\(frame) clear=\(clear) keeps=\(kept.isEmpty ? "-" : kept) seats=\(seats)"
        if text != tableAssist { tableAssist = text }
    }
    /// The lightbulb on my play turn (AssistLayout.askFrame): "frame=<x y w h> clear=ok|over:<what>
    /// keeps=<pips,hsi,voice,spectators>|-" (its tap square in the pane's points, what it covers,
    /// what of my seat's row it keeps clear of); "-": no lightbulb on the table.
    @Published var tableAssistAsk = "-"
    /// The lightbulb is the vertical bar's item (GameContainerView.askBarButton): the probe's
    /// "bar on" (enabled) / "bar off" (greyed); nil: not in the bar.
    var assistAskInBar: Bool? { didSet { updateAssistAsk() } }
    var assistAsk: (frame: CGRect, problems: [String], keeps: [String])? { didSet { updateAssistAsk() } }
    private func updateAssistAsk() {
        var text = "-"
        if let inBar = assistAskInBar {
            text = inBar ? "bar on" : "bar off"
        } else if let a = assistAsk {
            let f = a.frame
            text = String(format: "frame=%.1f %.1f %.1f %.1f", f.minX, f.minY, f.width, f.height)
                + " clear=\(a.problems.isEmpty ? "ok" : "over:" + a.problems.joined(separator: ","))"
                + " keeps=\(a.keeps.isEmpty ? "-" : a.keeps.sorted().joined(separator: ","))"
        }
        if text != tableAssistAsk { tableAssistAsk = text }
    }
    /// The bidder's countdown (BidClockPill) against the table, in the pane's points:
    /// "x y w h seats=ok|over:<what> fold=ok|over|-" ("-": no countdown shown).
    @Published var bidClock = "-"
    /// What the countdown must keep off (GameContainerView, the pane's points): each opponent's
    /// seat (glow and name), its bid bubble and its card backs, and the fold.
    var tableKeeps: [String: CGRect] = [:] { didSet { updateBidClock() } }
    var tableFold: CGRect? { didSet { updateBidClock() } }
    var bidClockFrame: CGRect? { didSet { updateBidClock() } }

    private func updateBidClock() {
        guard let f = bidClockFrame else { if bidClock != "-" { bidClock = "-" }; return }
        let over = tableKeeps.filter { $0.value.intersects(f) }.keys.sorted()
        let fold = tableFold.map { $0.intersects(f) ? "over" : "ok" } ?? "-"
        let text = String(format: "%.1f %.1f %.1f %.1f", f.minX, f.minY, f.width, f.height)
            + " seats=\(over.isEmpty ? "ok" : "over:" + over.joined(separator: ",")) fold=\(fold)"
        if text != bidClock { bidClock = text }
    }

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
        // back: the colour the fans' sprites are drawn in (red / blue; mixed: not one colour; -: no backs)
        let textures = seats.flatMap { $0.value.fanNode.children.compactMap { ($0 as? SKSpriteNode)?.texture } }
        let colours = Set(textures.map { t in [CardBackColour.red, .blue].first { CardFanNode.backTexture($0) === t }?.rawValue ?? "other" })
        let back = colours.count > 1 ? "mixed" : colours.first ?? "-"
        let state = "lifted=\(lifted) hand=\(scene.handNode.sprites.count) trick=\(scene.trickArea.cardCount) didMove=\(scene.didMoveCount)"
        let extras = "fans=\(fans) back=\(back) dealer=\(dealer)"
        if extras != tableExtras { tableExtras = extras }
        let seatsText = seatsProbe(scene)
        if seatsText != tableSeats { tableSeats = seatsText }
        let badges = badgesProbe(scene)
        if badges != tableBadges { tableBadges = badges }
        if check != layoutCheck { layoutCheck = check }
        if state != tableState { tableState = state }
        let dealing = Array(scene.handNode.sprites.values) as [SKNode] + scene.opponentManager.nodes.values.flatMap { $0.fanNode.children }
        let flying = dealing.filter { $0.deal?.flies == true }.count, fading = dealing.filter { $0.deal?.flies == false }.count
        // while the deck is up: its backs' colour (deckBack=red / blue / mixed) and whether it
        // keeps off the fold (hinge=ok / over; "-": no deck, or no fold the layout keeps to)
        let deckTextures = scene.dealDeck?.children.compactMap { ($0 as? SKSpriteNode)?.texture } ?? []
        let deckColours = Set(deckTextures.map { t in
            [CardBackColour.red, .blue].first { CardTextureGenerator.cardBackTexture(colour: $0) === t }?.rawValue ?? "other"
        })
        let deckBack = deckColours.count > 1 ? "mixed" : deckColours.first ?? "-"
        // the fold in the layout's (scene) units: a zoomed table's scene is the pane / zoom
        let keptFold = scene.layout.foldIgnored ? nil : scene.layout.chrome.fold
        let fold = scene.layout.chrome.fold == nil ? "-" : keptFold == nil ? "ignored" : "kept"
        let hinge = scene.dealDeck.flatMap { deck in
            keptFold.map { deck.calculateAccumulatedFrame().intersects($0) ? "over" : "ok" }
        } ?? "-"
        if scene.dealsShown != dealSeenFor { (dealSeenFor, dealPeak, dealDecks, dealHinges) = (scene.dealsShown, 0, [], []) }
        dealPeak = max(dealPeak, flying)
        if scene.dealDeck != nil {
            dealDecks.insert(deckBack)
            dealHinges.insert(hinge)
        }
        let seen = { (s: Set<String>) in s.isEmpty ? "-" : s.sorted().joined(separator: ",") }
        let deal = "deals=\(scene.dealsShown) cards=\(scene.lastDeal.cards) mode=\(scene.lastDeal.mode) "
            + "peak=\(dealPeak) decks=\(seen(dealDecks)) hinges=\(seen(dealHinges)) flying=\(flying) fading=\(fading) "
            + "deck=\(scene.dealDeck == nil ? 0 : 1) deckBack=\(deckBack) hinge=\(hinge) fold=\(fold)"
        if deal != tableDeal { tableDeal = deal }
        let zoom = String(format: "%.2f", L.zoom)
        if zoom != tableZoom { tableZoom = zoom }
        let ringed = scene.handNode.sprites.values.filter(\.isSuggested).map(\.card.id).sorted().joined(separator: ",")
        let assist = "card=\(ringed.isEmpty ? "-" : ringed) bid=\(scene.gameState?.suggestedBid ?? "-")"
        if assist != assistParts { assistParts = assist }
    }
}

extension TableDebugProbe {
    /// "table.badges" from the drawn nodes: each badge's frame (scene coordinates, then the pane's
    /// points) checked against what the layout keeps it off.
    func badgesProbe(_ scene: GameSKScene) -> String {
        guard let model = scene.lastModel, model.showsTable else { return "-" }
        let L = scene.layout
        // the layout's keeps and the eyes as drawn (they keep off the badges)
        let eyes = scene.opponentManager.nodes.values.compactMap { n -> (String, CGRect)? in
            guard let e = n.watchChip(make: false), !e.isHidden else { return nil }
            let s = TableLayout.watchChipSize(count: e.count)
            return ("eye", CGRect(x: n.position.x + e.position.x - s.width / 2, y: n.position.y + e.position.y - s.height / 2,
                                  width: s.width, height: s.height))
        }
        let keeps = L.badgeKeeps(spectating: model.hand == nil) + eyes
        let seats = scene.opponentManager.nodes.sorted { $0.key < $1.key }.map { pos, node -> String in
            guard let badge = node.badgeNode(make: false), let b = badge.badge, !badge.isHidden else { return "\(pos):-" }
            let d = TableLayout.seatBadge
            let c = CGPoint(x: node.position.x + badge.position.x, y: node.position.y + badge.position.y)
            let rect = CGRect(x: c.x - d / 2, y: c.y - d / 2, width: d, height: d)
            let over = L.badgeProblems(rect, seat: node.relativePosition, keeps: keeps)
            let w = L.window(rect)
            return "\(pos):\(b.rawValue) " + String(format: "%.1f %.1f %.1f %.1f", w.minX, w.minY, w.width, w.height)
                + " clear=" + (over.isEmpty ? "ok" : "over:" + over.joined(separator: ","))
        }
        return seats.joined(separator: ";") + " pops=\(scene.badgePops) pop=\(scene.lastBadgePop)"
    }
}

extension TableDebugProbe {
    /// "table.seats" (see `tableSeats`).
    func seatsProbe(_ scene: GameSKScene) -> String {
        guard let model = scene.lastModel, model.showsTable else { return "-" }
        let L = scene.layout
        let seats = scene.opponentManager.nodes.sorted { $0.key < $1.key }
        var boxes: [(String, CGRect)] = seats.map { ("seat\($0.key)", L.seatFootprint($0.value.relativePosition)) }
        let trick = model.trick.map { c -> String in
            let rel = Positions.getRelative(target: c.position, from: model.viewPosition, seats: model.seats)
            boxes.append(("trick\(c.position)", L.trickRect(rel)))
            return "\(c.position):\(rel.rawValue)"
        }
        if !scene.handNode.sprites.isEmpty {
            let f = scene.handNode.calculateAccumulatedFrame()
            boxes.append(("hand", f.insetBy(dx: 1, dy: 1)))
        }
        var over: [String] = []
        for (i, a) in boxes.enumerated() {
            for b in boxes[(i + 1)...] where a.1.insetBy(dx: 0.5, dy: 0.5).intersects(b.1.insetBy(dx: 0.5, dy: 0.5)) {
                over.append("\(a.0)/\(b.0)")
            }
        }
        return "seats=\(model.seats) " + seats.map { "\($0.key):\($0.value.relativePosition.rawValue)" }.joined(separator: " ")
            + " trick=" + (trick.isEmpty ? "-" : trick.joined(separator: ","))
            + " clear=" + (over.isEmpty ? "ok" : "over:" + over.joined(separator: ","))
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
            dot("table.seats", probe.tableSeats)
            dot("table.badges", probe.tableBadges)
            dot("fixture.sent", probe.sent)
            dot("table.zoom", probe.tableZoom)
            dot("table.deal", probe.tableDeal)
            dot("table.bidClock", probe.bidClock)
            dot("table.assist", probe.tableAssist)
            dot("table.assistAsk", probe.tableAssistAsk)
            dot("table.tutorial", probe.tableTutorial)
            dot("table.shoulder", probe.tableShoulder)
            dot("table.shoulderBadge", probe.shoulderBadge)
            dot("table.voice", probe.tableVoice)
            dot("table.spectatorsSpeaking", probe.spectatorsSpeaking)
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

/// "splash.logo": where the boot splash draws its logo, in global points ("x y w h", one
/// decimal), so a UI test can hold it to the sign-in logo's frame (the splash itself is one
/// full-screen VoiceOver element). A 1x1 dot like FixtureProbes', shown in fixture mode only.
struct SplashLogoProbe: View {
    let frame: CGRect

    var body: some View {
        Rectangle()
            .fill(Color.black)
            .frame(width: 1, height: 1)
            .opacity(0.01)
            .accessibilityElement()
            .accessibilityLabel("splash.logo")
            .accessibilityIdentifier("splash.logo")
            .accessibilityValue(String(format: "%.1f %.1f %.1f %.1f", frame.minX, frame.minY, frame.width, frame.height))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .allowsHitTesting(false)
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
