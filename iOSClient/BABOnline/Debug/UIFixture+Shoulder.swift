#if DEBUG
import Foundation

/// The over-the-shoulder view in fixture mode (ShoulderViewUITests; no server;
/// State/Table/Shoulder.swift). The fixture answers c2s watchHand as the server does
/// (server/socket/shoulderView.js): the reply is a stateSnapshot `reason: 'watchHand'` of the
/// seeded table with `viewer.shoulder {position, hand, hsi}` (the hand made up for that seat's
/// card count, never a card on the table), or none for a stop; every watchHand shows in
/// "fixture.sent" as `watchHand:<pos|null>`.
///
/// - `-uiShoulder auto|<seat>|table` turns the answering on, on a spectator table
///   (`spectator-mid-hand`, or any table fixture with `-uiAsSpectator YES`): `auto` the default
///   watch (the first human seat), `<seat>` the person's pick (an avatar tap right after the
///   join), `table` their Table view.
/// - `-uiAsSpectator YES`: the seeded snapshot's viewer is a pure spectator (role spectator, no
///   position, no hand, no HSI, no viewer.assist), as the server sends it to one;
///   `-uiSpectatorName <name>` signs the viewer in as that name (a seat owner's other device:
///   the own-seat rule).
/// - `-uiShoulderRefuse <reason>[:<ownPosition>]`: the first watchHand is refused with that
///   reason (watchHandRefused, the server's message), later ones answered.
/// - `-uiShoulderPause <s>`: s seconds after the first served watch, the room's pause line;
///   `-uiShoulderResume <s>`: the resume line s seconds after that (the re-sent watchHand is
///   answered as usual).
/// - `-uiShoulderHint YES`: after each served watch, the watched seat's mirrored hints as the
///   server copies them (assistHint `watched`): its rule tip and, on its turn, its /help answer.
/// - `-uiShoulderSpeaking YES`: every seat owner talks (voice peers, fixture only): the pill's ring.
extension UIFixture {
    static let shoulderMode: String? = isActive ? UserDefaults.standard.string(forKey: "uiShoulder") : nil
    static let asSpectator: Bool = isActive && UserDefaults.standard.bool(forKey: "uiAsSpectator")
    static let spectatorName: String? = isActive ? UserDefaults.standard.string(forKey: "uiSpectatorName") : nil
    static let shoulderRefusal: String? = isActive ? UserDefaults.standard.string(forKey: "uiShoulderRefuse") : nil
    static let shoulderPause: Double? = isActive ? UserDefaults.standard.string(forKey: "uiShoulderPause").flatMap(Double.init) : nil
    static let shoulderResume: Double? = isActive ? UserDefaults.standard.string(forKey: "uiShoulderResume").flatMap(Double.init) : nil
    static let shoulderHints: Bool = isActive && UserDefaults.standard.bool(forKey: "uiShoulderHint")
    static let shoulderSpeaking: Bool = isActive && UserDefaults.standard.bool(forKey: "uiShoulderSpeaking")

    @MainActor private static weak var shoulderStore: GameState?
    @MainActor private static var refused = false
    @MainActor private static var paused = false
    @MainActor private static var pauseScheduled = false

    /// The server's refusal words (server/socket/shoulderView.js REFUSALS).
    static let refusalMessages: [String: String] = [
        "not_spectating": "You are not watching this game.",
        "unavailable": "This table is paused or over. Try again in a moment.",
        "tournament": "Hands are hidden at tournament tables.",
        "not_dealt": "The cards have not been dealt yet.",
        "own_seat": "You have a seat at this table: you can watch only your own hand.",
    ]

    /// `-uiAsSpectator YES`: the viewer as the server sends a pure spectator its table.
    static func editAsSpectator(_ snap: inout [String: Any]) {
        guard asSpectator else { return }
        var v = snap["viewer"] as? [String: Any] ?? [:]
        v["role"] = "spectator"
        v["position"] = NSNull()
        v["ownerView"] = NSNull()
        v["canAct"] = false
        v.removeValue(forKey: "assist")
        snap["viewer"] = v
        snap["hand"] = NSNull()
        snap["hsi"] = NSNull()
        if var draw = snap["draw"] as? [String: Any] {
            draw["viewerDrawOrder"] = NSNull()
            snap["draw"] = draw
        }
        // the server lists every pure spectator, me too: the eye shows (a seat fixture lists none)
        var watching = snap["watching"] as? [String: Any] ?? [:]
        var list = watching["spectators"] as? [[String: Any]] ?? []
        let me = spectatorName ?? "viewer"
        if !list.contains(where: { $0["username"] as? String == me }) {
            list.append(["username": me, "pic": NSNull()])
            watching["spectators"] = list
            watching["count"] = max(list.count, watching["count"] as? Int ?? 0)
            snap["watching"] = watching
        }
    }

    @MainActor
    static func seedShoulder(_ store: GameState, auth: AuthState) {
        guard let mode = shoulderMode else { return }
        shoulderStore = store
        if shoulderSpeaking {
            var peers: [String: VoiceChatManager.PeerInfo] = [:]
            for (pos, seat) in store.players.seats where seat.controller == .human {
                peers["sid-\(pos)"] = VoiceChatManager.PeerInfo(username: seat.ownerUsername ?? seat.username ?? "")
            }
            VoiceChatManager.shared.peerInfos = peers
            VoiceChatManager.shared.speakingPeers = Set(peers.keys)
        }
        // the join's full state once the coordinator is listening (the re-send rule sends the
        // default watch), then the person's own pick, if any
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            MainActor.assumeIsolated {
                guard let snap = seededSnapshot else { return }
                var full = snap
                full["seq"] = store.state.sync.lastSeq ?? (snap["seq"] as? Int ?? 0)
                _ = store.apply(serverEvent: "stateSnapshot", payload: [["snapshot": full, "requestId": "fixture-join"] as [String: Any]])
                if mode == "table" {
                    store.apply(.local(.watchTableView))
                } else if let pos = Int(mode), (1...4).contains(pos) {
                    // after the default's answer, as a person's tap would come
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                        MainActor.assumeIsolated { store.apply(.local(.watchSeat(pos))) }
                    }
                }
            }
        }
    }

    /// A watchHand the app sent: answered 0.3 s later as the server does.
    static func answerWatchLater(_ data: [String: Any]) {
        guard shoulderMode != nil else { return }
        let position = data["position"] as? Int
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { MainActor.assumeIsolated { answerWatch(position) } }
    }

    @MainActor
    static func answerWatch(_ position: Int?) {
        guard let store = shoulderStore, var snap = seededSnapshot, let gameId = snap["gameId"] as? String else { return }
        if let rule = shoulderRefusal, !refused, position != nil {
            refused = true
            let parts = rule.split(separator: ":").map(String.init)
            var p: [String: Any] = ["gameId": gameId, "position": position.map { $0 as Any } ?? NSNull(), "reason": parts[0],
                                    "message": refusalMessages[parts[0]] ?? "Not now."]
            if parts.count > 1, let own = Int(parts[1]) { p["ownPosition"] = own }
            _ = store.apply(serverEvent: "watchHandRefused", payload: [p])
            if parts[0] == "unavailable" {
                // a paused table: it resumes after -uiShoulderResume seconds, if given
                paused = true
                if let resume = shoulderResume {
                    DispatchQueue.main.asyncAfter(deadline: .now() + resume) {
                        MainActor.assumeIsolated {
                            paused = false
                            systemLine(store, ShoulderRules.resumeLine)
                        }
                    }
                }
            }
            return
        }
        // a paused table serves nothing (the stop is done, unanswered)
        if paused { return }
        var viewer = snap["viewer"] as? [String: Any] ?? [:]
        if let pos = position {
            viewer["shoulder"] = ["position": pos, "hand": madeUpHand(snap, seat: pos), "hsi": 100.0 + Double(pos) * 11.25] as [String: Any]
        } else {
            viewer.removeValue(forKey: "shoulder")
        }
        snap["viewer"] = viewer
        // the list as the server keeps it: my entry carries the seat I watch (none for Table
        // view), and `-uiWatchers` entries stay (they would go with this reply's list otherwise)
        var watching = snap["watching"] as? [String: Any] ?? [:]
        let me = spectatorName ?? "viewer"
        var list = (watching["spectators"] as? [[String: Any]] ?? []).map { e -> [String: Any] in
            guard e["username"] as? String == me else { return e }
            var mine = e
            mine["shoulder"] = position.map { $0 as Any } ?? NSNull()
            return mine
        }
        if !list.contains(where: { $0["username"] as? String == me }) {
            list.append(["username": me, "pic": NSNull(), "shoulder": position.map { $0 as Any } ?? NSNull()])
        }
        if let spec = watchersSpec { list += watcherEntries(spec) }
        watching["spectators"] = list
        watching["count"] = max(list.count, watching["count"] as? Int ?? 0)
        snap["watching"] = watching
        snap["partial"] = ["log"]
        snap["seq"] = store.state.sync.lastSeq ?? (snap["seq"] as? Int ?? 0)
        _ = store.apply(serverEvent: "stateSnapshot", payload: [["snapshot": snap, "reason": "watchHand"] as [String: Any]])
        // `-uiBidClock`: the server's reply carries a running clock (snapshot bidClock); the
        // seeded table has none, so the fixture's clock runs on as it was
        if let secs = Int(UserDefaults.standard.string(forKey: "uiBidClock") ?? ""), secs > 0 {
            let seat = Int(UserDefaults.standard.string(forKey: "uiBidClockSeat") ?? "") ?? store.currentTurn ?? 1
            _ = store.apply(serverEvent: "bidClock", payload: [[
                "gameId": gameId, "position": seat, "running": true,
                "inMs": secs * 1000 + Int(BidCountdownModel.uiMargin * 1000), "durationMs": 30000,
            ] as [String: Any]])
        }
        guard let pos = position else { return }
        if shoulderHints { pushWatchedHints(store, seat: pos) }
        if let after = shoulderPause, !pauseScheduled {
            pauseScheduled = true
            DispatchQueue.main.asyncAfter(deadline: .now() + after) {
                MainActor.assumeIsolated {
                    paused = true
                    systemLine(store, ShoulderRules.pauseLine)
                    if let resume = shoulderResume {
                        DispatchQueue.main.asyncAfter(deadline: .now() + resume) {
                            MainActor.assumeIsolated {
                                paused = false
                                systemLine(store, ShoulderRules.resumeLine)
                            }
                        }
                    }
                }
            }
        }
    }

    @MainActor
    private static func systemLine(_ store: GameState, _ message: String) {
        _ = store.apply(serverEvent: "gameLogEntry", payload: [[
            "message": message, "type": "system", "seq": (store.state.sync.lastSeq ?? 0) + 1,
        ] as [String: Any]])
    }

    /// A hand for `seat`: its card count, no card already on the table or the trump.
    static func madeUpHand(_ snap: [String: Any], seat: Int) -> [[String: Any]] {
        let seats = snap["seats"] as? [[String: Any]] ?? []
        let count = seats.first { $0["position"] as? Int == seat }?["cardsInHand"] as? Int ?? 0
        var taken = Set<String>()
        func key(_ c: [String: Any]?) -> String? { c.flatMap { c in (c["suit"] as? String).map { "\($0)|\(c["rank"] ?? "")" } } }
        if let k = key(snap["trump"] as? [String: Any]) { taken.insert(k) }
        for t in ((snap["trick"] as? [String: Any])?["cards"] as? [[String: Any]]) ?? [] { if let k = key(t["card"] as? [String: Any]) { taken.insert(k) } }
        for h in (snap["trickHistory"] as? [[String: Any]]) ?? [] {
            for t in (h["cards"] as? [[String: Any]]) ?? [] { if let k = key(t["card"] as? [String: Any]) { taken.insert(k) } }
        }
        // each seat its own run through the deck, so two seats never share a card
        let suits = ["spades", "hearts", "diamonds", "clubs"]
        let ranks = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"]
        var deck: [[String: Any]] = []
        for (i, r) in ranks.enumerated() {
            for (j, s) in suits.enumerated() where (i * 4 + j) % 4 == seat - 1 { deck.append(["suit": s, "rank": r]) }
        }
        for (i, r) in ranks.enumerated() {
            for (j, s) in suits.enumerated() where (i * 4 + j) % 4 != seat - 1 { deck.append(["suit": s, "rank": r]) }
        }
        return Array(deck.filter { !taken.contains(key($0) ?? "") }.prefix(count))
    }

    /// The watched seat's hints as the server mirrors them (no note, no actions; its counts).
    @MainActor
    private static func pushWatchedHints(_ store: GameState, seat: Int) {
        let s = store.state
        let dealSeq = s.table.deal?.dealSeq ?? 1
        let bidding = s.table.phase.isBidding
        let stage = bidding ? "BIDDING" : "PLAYING"
        let bids = s.table.phase.bids?.byPosition.compactMap { $0 }.count ?? 0
        let cardIndex = AssistRules.cardIndex(s) ?? 0
        let key = "\(dealSeq)|\(stage)|\(s.table.phase.turn ?? 0)|\(bids)|\(cardIndex)"
        // only for the watched seat's own decision: the server mirrors the hints that seat is
        // given, on its own turn (bidding-mid with `auto` watches ora while ned bids: nothing)
        guard s.table.phase.turn == seat else { return }
        let name = s.players.name(seat)
        _ = store.apply(serverEvent: "assistHint", payload: [[
            "v": 1, "source": "tutorial", "kind": "tip", "tipId": bidding ? "T.bid" : "T.follow", "turnKey": key,
            "headline": bidding ? "Bidding" : "Following suit",
            "reasons": [bidding ? "Bid how many tricks you expect to win. Your bid adds to your partner's: together you must win at least that many."
                        : "Clubs were led: you must play a club if you have one."],
            "uses": 2, "freeUses": 3, "assisted": false, "counted": false, "watched": seat,
        ] as [String: Any]])
        let hand = s.table.hand
        var p: [String: Any] = [
            "v": 1, "source": "help", "turnKey": key, "uses": 2, "freeUses": 3, "assisted": false, "counted": true,
            "confidence": "clear", "watched": seat,
            "details": ["On average: this is worth about +12 over the next best."],
        ]
        if bidding {
            p["kind"] = "bid"; p["headline"] = "Bid 2"; p["suggest"] = ["bid": "2"]
            p["reasons"] = ["Your hand should win about 2.1 tricks.", "\(name)'s partner bids after you and adds their own tricks."]
        } else if let c = hand.first {
            p["kind"] = "card"; p["headline"] = "Play \(c.rank.rawValue)"; p["suggest"] = ["card": ["suit": c.suit.rawValue, "rank": c.rank.rawValue]]
            p["reasons"] = ["The lowest card that keeps your partner's trick."]
        } else {
            return
        }
        _ = store.apply(serverEvent: "assistHint", payload: [p])
    }
}
#endif
