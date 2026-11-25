import XCTest
@testable import BAB_Online

/// /help on iOS (help plan 4.5; AssistHint.swift, TableReducer+Assist): the cap, the wire, the
/// reducer's show / park / clear rules (the web's), the render model's suggested card, the
/// lightbulb's coordinator path, and the words (footer, announcement, the command list).
@MainActor
final class AssistHintTests: XCTestCase {
    // dealtState: seat 1 ("me"), dealer 4, so I bid first; partner "P" at 3
    private let bidKey = "1|BIDDING|1|0|0"

    private func hint(_ kind: String, key: String? = nil, headline: String = "Bid 2", bid: String? = "2",
                      card: [String: Any]? = nil, uses: Int = 1, counted: Bool = true, note: String? = nil,
                      reasons: [String] = ["Your hand should take about 2 tricks.", "P (your partner) bid 1."],
                      confidence: String = "clear") -> TableEvent {
        var p: [String: Any] = ["v": 1, "source": "help", "kind": kind, "turnKey": key ?? bidKey, "headline": headline,
                                "reasons": reasons, "uses": uses, "freeUses": 3, "assisted": uses > 3, "counted": counted,
                                "confidence": confidence, "details": ["d1", "d2"]]
        if let bid, kind == "bid" { p["suggest"] = ["bid": bid] }
        if let card { p["suggest"] = ["card": card] }
        if let note { p["note"] = note }
        if kind == "status" { p["reasons"] = [String](); p.removeValue(forKey: "confidence") }
        return T.ev("assistHint", p)
    }

    /// My bid turn open (updateTurn seq 3).
    private func myBidTurn() -> TableState {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        return s
    }

    /// My play turn: bidding done (1 leads), a 3-card hand.
    private func myPlayTurn() -> TableState {
        var s = myBidTurn()
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": 1, "position": 1, "seq": 4]))
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": 0, "position": 2, "seq": 5]))
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": 1, "position": 3, "seq": 6]))
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": 0, "position": 4, "seq": 7]))
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": [1, 0, 1, 0], "lead": 1, "seq": 8]))
        XCTAssertEqual(s.myTurn, .choosing(.play))
        return s
    }

    private func privateRows(_ s: TableState) -> [String] { s.log.entries.filter(\.isPrivate).map(\.message) }

    // MARK: - Wire

    func testTheCapAndTheRoute() {
        XCTAssertTrue(ClientHello.caps.contains("assist"), "the server answers /help with assistHint only to a socket with the cap")
        XCTAssertEqual(ClientHello.payload()["caps"] as? [String], ["avatarUrl", "casualSpectators", "playAgain", "assist", "tutorial", "shoulderView", "tournamentVoice"])
        XCTAssertTrue(GameSocketHandler.events.contains(SocketEvents.Server.assistHint))
        XCTAssertFalse(ContractSeq.events.contains("assistHint"), "private and unsequenced")
    }

    func testDecodingIsLenientAndUnsequenced() throws {
        let ev = try ServerEvent.decode(name: "assistHint", payload: [[
            "v": 1, "kind": "card", "headline": "Lead A♣", "turnKey": "1|PLAYING|1|4|0", "seq": 12,
            "suggest": ["card": ["suit": "clubs", "rank": "A"]], "reasons": "not a list", "future": true,
        ] as [String: Any]], strict: true).get()
        XCTAssertNil(ev.seq, "never gated, whatever the payload says")
        guard case .assistHint(let w) = ev.event else { return XCTFail("\(ev.event)") }
        XCTAssertNil(w.reasons, "a field of the wrong type is absent, not a decode failure")
        let h = try XCTUnwrap(AssistHint(w))
        XCTAssertEqual(h.card, Card(suit: .clubs, rank: .ace))
        XCTAssertNil(AssistHint(WirePayload.AssistHint(v: 2, kind: "bid", headline: "x")), "another version is not ours")
        XCTAssertNil(AssistHint(WirePayload.AssistHint(kind: "tip", headline: "x")), "a tip only from the tutorial, with its tipId (TutorialTests)")
        XCTAssertNil(AssistHint(WirePayload.AssistHint(kind: "bid", headline: "")))
        let many = try XCTUnwrap(AssistHint(WirePayload.AssistHint(kind: "bid", headline: "Bid 1", reasons: ["a", "b", "c"],
                                                                   details: ["1", "2", "3", "4", "5"], suggest: .init(bid: "b"))))
        XCTAssertEqual(many.reasons, ["a", "b"])
        XCTAssertEqual(many.details.count, 4)
        XCTAssertEqual(many.bid, "B", "uppercased, as the bid panel's buttons")
    }

    // MARK: - Reducer: bid

    func testABidAnswerShowsRingsAndAnnounces() {
        var s = myBidTurn()
        XCTAssertTrue(AssistRules.showsAsk(s), "my bid turn: the lightbulb")
        let fx = TableReducer.reduce(&s, hint("bid"))
        XCTAssertEqual(s.table.assist?.headline, "Bid 2")
        XCTAssertEqual(s.table.assist?.bid, "2")
        XCTAssertEqual(privateRows(s), ["Help: Bid 2 (only you see this)"])
        XCTAssertTrue(fx.contains(.announce("Suggestion: Bid 2. P (your partner) bid 1.")))
        XCTAssertFalse(AssistRules.showsAsk(s), "the lightbulb hides while the card is up")
        XCTAssertNil(TableRenderModel(s).hand?.suggestedId, "a bid answer rings no card")
        XCTAssertEqual(s.table.assistUses, AssistUses(uses: 1, freeUses: 3, assisted: false, told: true))
        // the same turn's updateTurn again (a repeat) keeps it; my own bid ends it
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 4]))
        XCTAssertNotNil(s.table.assist)
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": 2, "position": 1, "seq": 5]))
        XCTAssertNil(s.table.assist)
        XCTAssertEqual(privateRows(s).count, 1)
    }

    func testMySubmitEndsItAndTheStoreRingsTheBid() {
        let store = GameState()
        var said: [String] = []
        store.announce = { said.append($0) }
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        let events: [TableEvent] = [
            .local(.enterGameContext(gameId: "g1", tournamentId: nil)),
            T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
                                    "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]],
                                    "pics": [1, 2, 3, 4], "seq": 1]),
            T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A"), T.card("hearts", "2"), T.card("clubs", "K")],
                               "trump": T.card("diamonds", "5"), "score1": 0, "score2": 0, "dealer": 4, "position": 1,
                               "currentHand": 3, "seq": 2]),
            T.ev("updateTurn", ["currentTurn": 1, "seq": 3]),
        ]
        for e in events { store.apply(e) }
        XCTAssertTrue(store.showsAssistAsk)
        store.apply(hint("bid"))
        XCTAssertEqual(store.suggestedBid, "2")
        XCTAssertEqual(store.assistHint?.headline, "Bid 2")
        XCTAssertEqual(said, ["Suggestion: Bid 2. P (your partner) bid 1."])
        store.apply(.local(.submitBid("3", reqId: 1)))
        XCTAssertNil(store.suggestedBid, "my bid is on its way: the ring goes")
        XCTAssertNil(store.assistHint)
    }

    func testAnotherSeatsTurnEndsAStatusAndAStaleAnswerIsHeldThenGivenUp() {
        var s = myBidTurn()
        // an answer for a turn the table has not reached (one more bid than I see): held
        TableReducer.reduce(&s, hint("bid", key: "1|BIDDING|1|1|0"))
        XCTAssertNil(s.table.assist)
        XCTAssertNotNil(s.table.parkedAssist)
        XCTAssertEqual(privateRows(s), [])
        // the turn moves on without it ever being live: its row says so
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": 1, "position": 1, "seq": 4]))
        XCTAssertNil(s.table.parkedAssist)
        XCTAssertEqual(privateRows(s), [AssistRules.lateLine])
        // a status reply off turn shows until the next turn change
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 5]))
        TableReducer.reduce(&s, hint("status", headline: "Not your turn yet: L is bidding."))
        XCTAssertEqual(s.table.assist?.kind, .status)
        XCTAssertFalse(AssistRules.showsAsk(s), "off turn: no lightbulb")
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 3, "seq": 6]))
        XCTAssertNil(s.table.assist, "a status reply ends at a turn change")
    }

    func testAHeldAnswerShowsWhenTheTurnCatchesUp() {
        var s = T.dealtState()
        // the answer arrives before the updateTurn that opens my turn (a held event)
        TableReducer.reduce(&s, hint("bid"))
        XCTAssertNotNil(s.table.parkedAssist)
        let fx = TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        XCTAssertEqual(s.table.assist?.bid, "2")
        XCTAssertNil(s.table.parkedAssist)
        XCTAssertTrue(fx.contains { if case .announce = $0 { return true } else { return false } })
    }

    func testAStatusWhileASuggestionIsUpIsAToast() {
        var s = myBidTurn()
        TableReducer.reduce(&s, hint("bid"))
        let fx = TableReducer.reduce(&s, hint("status", headline: "One moment: try again in a few seconds."))
        XCTAssertEqual(s.table.assist?.kind, .bid, "the suggestion stays")
        XCTAssertTrue(fx.contains(.notice("One moment: try again in a few seconds.")))
    }

    // MARK: - Reducer: card

    func testACardAnswerGlowsUntilMyCardIsPlayed() throws {
        var s = myPlayTurn()
        TableReducer.reduce(&s, hint("card", key: "1|PLAYING|1|4|0", headline: "Lead A♠", card: T.card("spades", "A")))
        XCTAssertEqual(TableRenderModel(s).hand?.suggestedId, "A_spades")
        // a resync snapshot of the same game keeps it while it is live (the render model rebuilds)
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 9]))
        XCTAssertEqual(TableRenderModel(s).hand?.suggestedId, "A_spades")
        TableReducer.reduce(&s, .local(.submitPlay(T.c("spades", "A"), reqId: 7)))
        XCTAssertNil(s.table.assist)
        XCTAssertNil(TableRenderModel(s).hand?.suggestedId)
    }

    func testACardAnswerForAnotherTrickIsHeld() {
        var s = myPlayTurn()
        TableReducer.reduce(&s, hint("card", key: "1|PLAYING|1|4|4", headline: "Play K♣", card: T.card("clubs", "K")))
        XCTAssertNil(s.table.assist, "cardIndex 4 is the second trick's: not this one")
        XCTAssertNotNil(s.table.parkedAssist)
    }

    func testEndsOfTheHandAndTheGame() {
        var s = myPlayTurn()
        TableReducer.reduce(&s, hint("card", key: "1|PLAYING|1|4|0", headline: "Lead A♠", card: T.card("spades", "A")))
        TableReducer.reduce(&s, T.ev("handComplete", ["score": ["team1": 10, "team2": 0], "team1Tricks": 2, "team2Tricks": 1, "seq": 9]))
        XCTAssertNil(s.table.assist, "hand end")
        var t = myPlayTurn()
        TableReducer.reduce(&t, hint("card", key: "1|PLAYING|1|4|0", headline: "Lead A♠", card: T.card("spades", "A")))
        TableReducer.reduce(&t, T.ev("playerLazyMode", ["position": 1, "botUsername": "Bot", "originalUsername": "me", "seq": 9]))
        XCTAssertNil(t.table.assist, "a bot plays my seat")
        var u = myPlayTurn()
        TableReducer.reduce(&u, hint("card", key: "1|PLAYING|1|4|9", headline: "x", card: T.card("spades", "A")))
        TableReducer.reduce(&u, T.ev("gameEnd", ["score": ["team1": 300, "team2": 0], "seq": 9]))
        XCTAssertNil(u.table.parkedAssist)
        XCTAssertEqual(privateRows(u), [], "game over: no row for a held answer")
        // on the game-end screen a status reply is a private row
        TableReducer.reduce(&u, hint("status", headline: "Nothing to suggest right now."))
        XCTAssertEqual(privateRows(u), ["Help: Nothing to suggest right now. (only you see this)"])
    }

    func testTheDrawsStatusIsAToastAndASpectatorsLeavesTheCount() throws {
        var s = TableState()
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        TableReducer.reduce(&s, T.ev("startDraw", ["seq": 1]))
        let fx = TableReducer.reduce(&s, hint("status", headline: "Suggestions are available once the game starts."))
        XCTAssertTrue(fx.contains(.infoNotice("Suggestions are available once the game starts.")))
        XCTAssertNil(s.table.assist)
        var w = try T.state(fixture: "spectator-mid-hand")
        TableReducer.reduce(&w, hint("status", headline: "/help is for players only.", uses: 0, counted: false))
        XCTAssertEqual(w.table.assist?.headline, "/help is for players only.", "the reply shows at the table")
        XCTAssertNil(w.table.assistUses, "a pure spectator's reply says nothing about uses")
        XCTAssertFalse(AssistRules.showsAsk(w), "spectators get no lightbulb")
    }

    func testUsesStartAtCreateUIAndFollowTheHints() {
        var s = TableState()
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        XCTAssertNil(s.table.assistUses, "unknown before the game (a relaunch, a rejoin)")
        XCTAssertEqual(AssistRules.helpDescription(s.table.assistUses), "Ask a bot for advice (after 3 free, this game counts as bot-assisted)")
        TableReducer.reduce(&s, T.ev("startDraw", ["seq": 1]))
        TableReducer.reduce(&s, T.ev("createUI", ["seq": 2]))
        XCTAssertEqual(AssistRules.helpDescription(s.table.assistUses), "Ask a bot for advice (0 of 3 free used)")
        XCTAssertEqual(AssistRules.helpDescription(AssistUses(uses: 2)), "Ask a bot for advice (2 of 3 free used)")
        XCTAssertEqual(AssistRules.helpDescription(AssistUses(uses: 3)), "Ask a bot for advice (the next one makes this game bot-assisted)")
        XCTAssertEqual(AssistRules.helpDescription(AssistUses(uses: 4, assisted: true)), "Ask a bot for advice (this game is bot-assisted for you)")
        // another game's snapshot forgets them; the same game's keeps them (a snapshot without
        // viewer.assist: an older server; with it, the snapshot's count: FaultRowsTests)
        let noAssist: (inout [String: Any]) -> Void = { raw in
            var v = raw["viewer"] as? [String: Any] ?? [:]
            v.removeValue(forKey: "assist")
            raw["viewer"] = v
        }
        var t = myBidTurn()
        TableReducer.reduce(&t, hint("bid", uses: 2))
        let same = try? T.snapshot("bidding-mid") { noAssist(&$0); $0["gameId"] = "g1" }
        if let same { TableReducer.reduce(&t, .snapshot(same, .requested("x"), hints: nil)) }
        XCTAssertEqual(t.table.assistUses?.uses, 2)
        if let other = try? T.snapshot("bidding-mid", edit: noAssist) { TableReducer.reduce(&t, .snapshot(other, .rejoin, hints: nil)) }
        XCTAssertNil(t.table.assistUses)
        XCTAssertNil(t.table.assist)
        if let other = try? T.snapshot("bidding-mid") { TableReducer.reduce(&t, .snapshot(other, .rejoin, hints: nil)) }
        XCTAssertEqual(t.table.assistUses, AssistUses(uses: 0, freeUses: 3, assisted: false, told: true), "the snapshot's viewer.assist")
    }

    // MARK: - A game with a native bot seat (owner 2026-11-19, "Unlimited, keep notice")

    func testANativeBotSeatMakesHelpFreeButALazyOrResignBotDoesNot() throws {
        var human = try T.state(fixture: "bidding-mid")
        XCTAssertFalse(AssistRules.isFreeHelpGame(human), "four human seats: the limit")
        // the seats decide only before the server has said (the fixture's viewer.assist has)
        human.table.assistUses = AssistUses()
        for c in [SeatController.lazyBot, .resignBot, .human, .unknown] {
            human.players.seats[2]?.controller = c
            XCTAssertFalse(AssistRules.isFreeHelpGame(human), "\(c): a human's seat")
        }
        human.players.seats[2]?.controller = .bot
        XCTAssertTrue(AssistRules.isFreeHelpGame(human), "a native bot seat")
        XCTAssertFalse(AssistRules.isFreeHelpGame(try T.state(fixture: "presence-mixed")), "a lazy bot keeps the limit")
        XCTAssertFalse(AssistRules.isFreeHelpGame(try T.state(fixture: "lazy-at-seat")), "my own lazy seat too")
        XCTAssertTrue(AssistRules.isFreeHelpGame(T.dealtState()), "an older server's positionUpdate (no nativeBot): bot: sockets are native bots")
        // the snapshot: viewer.assist.unlimited, and without it the seats alone
        let tournament = try T.state(fixture: "tournament-game")
        XCTAssertEqual(tournament.table.assistUses, AssistUses(uses: 0, freeUses: 3, assisted: false, unlimited: true, told: true))
        XCTAssertTrue(AssistRules.isFreeHelpGame(tournament))
        let bare = TableReducer.state(from: try T.snapshot("tournament-game") { raw in
            var v = raw["viewer"] as! [String: Any]
            v.removeValue(forKey: "assist")
            raw["viewer"] = v
        }, hints: nil, previous: nil, source: .rejoin)
        XCTAssertNil(bare.table.assistUses)
        XCTAssertTrue(AssistRules.isFreeHelpGame(bare), "before any hint or count: the table's filler bots")
        // the wire's flag alone (a table whose seats this build has not read yet)
        var told = TableState()
        told.table.assistUses = AssistUses(uses: 2, unlimited: true, told: true)
        XCTAssertTrue(AssistRules.isFreeHelpGame(told))
        // once the server has said, its word wins over the seats (as on the web)
        var said = T.dealtState()
        said.table.assistUses = AssistUses(uses: 2, told: true)
        XCTAssertFalse(AssistRules.isFreeHelpGame(said), "a hint without unlimited: the limit, whatever the seats")
        said.table.assistUses = AssistUses(uses: 0)
        XCTAssertTrue(AssistRules.isFreeHelpGame(said), "createUI's zero count: the seats decide")
    }

    /// A human who leaves during Tap to Draw is seated as a resign bot (server handleDrawComplete):
    /// positionUpdate's isBot is true for that seat, nativeBot false. The limit stays (server
    /// assistState.isFreeHelpGame counts only controller `bot`): the count, the 3rd-use warning.
    func testADrawPhaseLeaversResignBotKeepsTheLimit() throws {
        func table(nativeBot: [Bool]?) -> TableState {
            var s = TableState()
            TableReducer.reduce(&s, .local(.identity(username: "me", playerId: "sid-me")))
            TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
            var p: [String: Any] = [
                "positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:carol", "sid-p", "sid-r"],
                "usernames": [["username": "me"], ["username": "Rusty"], ["username": "P"], ["username": "R"]],
                "pics": [1, 2, 3, 4], "isBot": [false, true, false, false], "seq": 1,
            ]
            if let nativeBot { p["nativeBot"] = nativeBot }
            TableReducer.reduce(&s, T.ev("positionUpdate", p))
            TableReducer.reduce(&s, T.ev("createUI", ["seq": 2]))
            TableReducer.reduce(&s, T.ev("gameStart", [
                "gameId": "g1", "hand": [T.card("spades", "A"), T.card("hearts", "2"), T.card("clubs", "K")],
                "trump": T.card("diamonds", "5"), "score1": 0, "score2": 0, "dealer": 4, "position": 1, "currentHand": 3, "seq": 3,
            ]))
            TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 4]))
            return s
        }
        var s = table(nativeBot: [false, false, false, false])
        XCTAssertEqual(s.players.seats[2]?.controller, .resignBot, "a resign bot, not a native bot")
        XCTAssertEqual(s.players.seats[2]?.isBot, true, "still a bot at the seat")
        XCTAssertFalse(AssistRules.isFreeHelpGame(s))
        XCTAssertEqual(AssistRules.helpDescription(s.table.assistUses, free: AssistRules.isFreeHelpGame(s)),
                       "Ask a bot for advice (0 of 3 free used)")
        TableReducer.reduce(&s, hint("bid", uses: 3, note: UIFixture.assistWarning))
        XCTAssertEqual(s.table.assist?.note, UIFixture.assistWarning, "the 3rd-use warning stays")
        XCTAssertEqual(s.table.assist.flatMap(AssistRules.footer), "What our strongest bot would play \u{00B7} Help 3 of 3 free")
        XCTAssertEqual(AssistRules.helpDescription(s.table.assistUses, free: AssistRules.isFreeHelpGame(s)),
                       "Ask a bot for advice (the next one makes this game bot-assisted)")
        // the same seat as a native bot (lobby Add Bot): no limit shown
        let native = table(nativeBot: [false, true, false, false])
        XCTAssertEqual(native.players.seats[2]?.controller, .bot)
        XCTAssertTrue(AssistRules.isFreeHelpGame(native))
        XCTAssertEqual(AssistRules.helpDescription(native.table.assistUses, free: AssistRules.isFreeHelpGame(native)), "Ask a bot for advice")
        // an older server (no nativeBot): every bot seat is a native bot, as before
        XCTAssertEqual(table(nativeBot: nil).players.seats[2]?.controller, .bot)
    }

    func testNoCountOrLimitWordsInAGameWithANativeBotSeat() throws {
        func h(_ conf: String, uses: Int, counted: Bool = true) throws -> AssistHint {
            try XCTUnwrap(AssistHint(WirePayload.AssistHint(kind: "card", headline: "Play 9\u{2666}", reasons: ["Contract line", "Main reason"],
                                                            uses: uses, freeUses: 3, assisted: false, counted: counted,
                                                            confidence: conf, unlimited: true)))
        }
        XCTAssertTrue(try h("clear", uses: 1).unlimited, "decoded")
        XCTAssertFalse(try XCTUnwrap(AssistHint(WirePayload.AssistHint(kind: "bid", headline: "Bid 1"))).unlimited, "absent: the limit")
        let plain = "What our strongest bot would play"
        XCTAssertEqual(AssistRules.footer(try h("clear", uses: 1)), plain)
        XCTAssertEqual(AssistRules.footer(try h("clear", uses: 4)), plain, "past 3: still no count")
        XCTAssertEqual(AssistRules.footer(try h("clear", uses: 9)), plain)
        XCTAssertEqual(AssistRules.footer(try h("only", uses: 2)), plain, "a forced move: the same plain footer")
        XCTAssertEqual(AssistRules.footer(try h("clear", uses: 2, counted: false)), plain, "a re-ask: the same plain footer")
        XCTAssertEqual(AssistRules.footer(try h("quick", uses: 5)), AssistRules.footerQuick, "the Quick note alone")
        for u in [nil, AssistUses(), AssistUses(uses: 3), AssistUses(uses: 7, assisted: true)] as [AssistUses?] {
            XCTAssertEqual(AssistRules.helpDescription(u, free: true), "Ask a bot for advice")
        }
        XCTAssertEqual(AssistRules.helpDescription(AssistUses(uses: 5, unlimited: true)), "Ask a bot for advice", "the wire's flag alone")
        XCTAssertEqual(AssistRules.askLabel, "Ask a bot for advice", "the lightbulb, in every game")
        // the hint's own flag decides (the server's verdict, as on the web): without it, as sent;
        // with it, any note and assisted go
        let old = try XCTUnwrap(AssistHint(WirePayload.AssistHint(kind: "bid", headline: "Bid 2", uses: 4, freeUses: 3, assisted: true,
                                                                  counted: true, confidence: "clear",
                                                                  note: "This game now counts as bot-assisted for you.")))
        XCTAssertEqual(AssistRules.inFreeHelpGame(old), old, "no unlimited: as sent")
        var flagged = old
        flagged.unlimited = true
        let free = AssistRules.inFreeHelpGame(flagged)
        XCTAssertTrue(free.unlimited)
        XCTAssertNil(free.note)
        XCTAssertFalse(free.assisted)
        XCTAssertEqual(AssistRules.footer(free), plain)
        XCTAssertEqual(AssistRules.announcement(free), "Suggestion: Bid 2.")
        for text in [AssistRules.footer(free) ?? "", AssistRules.announcement(free),
                     AssistRules.helpDescription(AssistUses(uses: 4, assisted: true), free: true)] {
            for word in ["free", "unlimited", "bot-assisted", "of 3", "help 4"] {
                XCTAssertFalse(text.lowercased().contains(word), "\(text): \(word)")
            }
        }
    }

    func testTheReducerAndTheStoreInAGameWithANativeBotSeat() throws {
        // the hint says so (four humans at the table as this build knows it)
        let store = GameState()
        var said: [String] = []
        store.announce = { said.append($0) }
        store.apply(.local(.identity(username: "ned", playerId: "sid-ned")))
        store.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertEqual(store.helpDescription, "Ask a bot for advice (0 of 3 free used)", "four humans: the count")
        store.apply(T.ev("assistHint", UIFixture.assistPayload(store.state, uses: 4, free: true)))
        let shown = try XCTUnwrap(store.assistHint)
        XCTAssertTrue(shown.unlimited)
        XCTAssertNil(shown.note)
        XCTAssertFalse(shown.assisted)
        XCTAssertEqual(AssistRules.footer(shown), "What our strongest bot would play")
        XCTAssertEqual(store.state.table.assistUses, AssistUses(uses: 4, freeUses: 3, assisted: false, unlimited: true, told: true))
        XCTAssertEqual(store.helpDescription, "Ask a bot for advice")
        XCTAssertEqual(said.count, 1)
        XCTAssertTrue(said.first?.hasPrefix("Suggestion: Bid 2. ") == true, "\(said)")
        XCTAssertFalse(said.first?.contains("bot-assisted") ?? true, "no crossing note for VoiceOver")
        // the table's seats say so before any hint; a hint without the flag (the server's verdict:
        // the limit) wins over them, and keeps its 3rd-use warning, as on the web
        var s = myBidTurn()
        XCTAssertEqual(AssistRules.helpDescription(s.table.assistUses, free: AssistRules.isFreeHelpGame(s)), "Ask a bot for advice")
        let fx = TableReducer.reduce(&s, hint("bid", uses: 3, note: UIFixture.assistWarning))
        XCTAssertEqual(s.table.assist?.unlimited, false)
        XCTAssertEqual(s.table.assist?.note, UIFixture.assistWarning)
        XCTAssertEqual(s.table.assist.flatMap(AssistRules.footer), "What our strongest bot would play \u{00B7} Help 3 of 3 free")
        XCTAssertTrue(fx.contains(.announce("Suggestion: Bid 2. P (your partner) bid 1. \(UIFixture.assistWarning)")), "\(fx)")
        XCTAssertEqual(s.table.assistUses, AssistUses(uses: 3, freeUses: 3, assisted: false, told: true), "the uses as the wire said them")
        XCTAssertEqual(AssistRules.helpDescription(s.table.assistUses, free: AssistRules.isFreeHelpGame(s)),
                       "Ask a bot for advice (the next one makes this game bot-assisted)")
        // the same hint at a table of four humans keeps its count and its warning
        var four = try T.state(fixture: "bidding-mid")
        TableReducer.reduce(&four, T.ev("assistHint", UIFixture.assistPayload(four, uses: 3, free: false)))
        XCTAssertEqual(four.table.assist?.note, UIFixture.assistWarning)
        XCTAssertEqual(four.table.assist.flatMap(AssistRules.footer), "What our strongest bot would play \u{00B7} Help 3 of 3 free")
        XCTAssertEqual(AssistRules.helpDescription(four.table.assistUses, free: AssistRules.isFreeHelpGame(four)),
                       "Ask a bot for advice (the next one makes this game bot-assisted)")
    }

    // MARK: - The lightbulb

    func testTheLightbulbSendsHelpAndWaits() {
        let store = GameState()
        let emitter = FakeEmitter(), ask = ManualClock()
        let actions = ActionCoordinator(store: store, emitter: emitter, clock: ManualClock(), sounds: RecordingSounds(),
                                        soundClock: ManualClock(), tunePlayer: FakeTunePlayer(SoundClock()), askClock: ask)
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        XCTAssertFalse(actions.askHelp(connected: true), "no table: nothing to ask")
        store.apply(.snapshot(try! T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertTrue(store.showsAssistAsk, "bidding-mid: my bid turn")
        XCTAssertFalse(actions.askHelp(connected: false))
        XCTAssertEqual(store.notice?.text, AssistRules.reconnecting)
        XCTAssertEqual(emitter.sent, [])
        XCTAssertTrue(actions.askHelp(connected: true))
        XCTAssertEqual(emitter.sent, [.chat("/help")])
        XCTAssertFalse(store.showsAssistAsk, "one tap, one ask: hidden while the answer is on its way")
        XCTAssertFalse(actions.askHelp(connected: true))
        ask.advance(AssistRules.askWait)
        XCTAssertTrue(store.showsAssistAsk, "no answer in 10 s: it shows again")
        XCTAssertTrue(actions.askHelp(connected: true))
        store.apply(T.ev("assistHint", UIFixture.assistPayload(store.state, uses: 1)))
        XCTAssertFalse(store.state.table.assistAsking, "the answer came")
        XCTAssertEqual(store.suggestedBid, "2")
        store.apply(.local(.assistDismissed))
        XCTAssertNil(store.assistHint)
        XCTAssertTrue(store.showsAssistAsk, "dismissed: the lightbulb is back for another look")
    }

    // MARK: - Words

    func testTheFooterAndTheAnnouncement() throws {
        func h(_ conf: String, uses: Int, counted: Bool = true, note: String? = nil) throws -> AssistHint {
            try XCTUnwrap(AssistHint(WirePayload.AssistHint(kind: "card", headline: "Play 9♦", reasons: ["Contract line", "Main reason"],
                                                            uses: uses, freeUses: 3, counted: counted, confidence: conf, note: note)))
        }
        XCTAssertEqual(AssistRules.footer(try h("clear", uses: 2)), "What our strongest bot would play \u{00B7} Help 2 of 3 free")
        XCTAssertEqual(AssistRules.footer(try h("clear", uses: 4)), "What our strongest bot would play \u{00B7} Help 4: this game counts as bot-assisted for you")
        XCTAssertEqual(AssistRules.footer(try h("only", uses: 1)), "Not counted")
        XCTAssertEqual(AssistRules.footer(try h("clear", uses: 2, counted: false)), "What our strongest bot would play \u{00B7} Asked again this turn: not counted")
        XCTAssertEqual(AssistRules.footer(try h("quick", uses: 1)), "Quick suggestion: rules only, the server is busy. \u{00B7} Help 1 of 3 free")
        XCTAssertEqual(AssistRules.confidenceLabel(try h("close", uses: 1)), "Close call")
        XCTAssertEqual(AssistRules.announcement(try h("clear", uses: 3, note: UIFixture.assistWarning)),
                       "Suggestion: Play 9♦. Main reason. \(UIFixture.assistWarning)")
        let status = AssistHint(kind: .status, headline: "Nothing to suggest right now.")
        XCTAssertNil(AssistRules.footer(status))
        XCTAssertEqual(AssistRules.announcement(status), "Nothing to suggest right now.")
        XCTAssertEqual(AssistRules.logLine(status), "Help: Nothing to suggest right now. (only you see this)")
    }

    func testTheCommandList() {
        let seat = GameLogPanel.commands(pureSpectator: false, leave: .botFinishes, help: "Ask a bot for advice (1 of 3 free used)")
        XCTAssertEqual(seat.map(\.command), ["/lazy", "/active", "/leave", "/help"])
        XCTAssertEqual(seat.last?.description, "Ask a bot for advice (1 of 3 free used)")
        XCTAssertEqual(GameLogPanel.commands(pureSpectator: true, leave: .botFinishes, help: "x").map(\.command), ["/leave"])
        XCTAssertEqual(ChatCommand.resolve("/he", commands: seat.map(\.command)), .send("/help"))
        XCTAssertEqual(ChatCommand.resolve("/help", commands: ["/leave"]), .send("/help"), "a spectator's /help reaches the server")
    }
}
