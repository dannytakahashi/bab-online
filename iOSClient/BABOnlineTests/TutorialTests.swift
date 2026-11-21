import XCTest
@testable import BAB_Online

/// The tutorial on iOS (State/Table/Tutorial.swift; server: docs/claude/assist.md "The
/// tutorial"): the cap and the wire (assistHint kind tip / tipId / actions, s2c assistState,
/// the snapshot's viewer.assist.tutorial / auto), the reducer (tips, the welcome's own slot,
/// what clears them, the tutorial's advice never counted, on / off), the chip, the chat
/// commands, the coordinator's Keep / Turn off, and the column's layout (AssistLayout).
@MainActor
final class TutorialTests: XCTestCase {
    // dealtState: seat 1 ("me"), dealer 4, so I bid first; partner "P" at 3
    private let bidKey = "1|BIDDING|1|0|0"

    private func tip(_ id: String, _ title: String, _ text: String, actions: [String]? = nil, key: String? = nil) -> TableEvent {
        var p: [String: Any] = ["v": 1, "source": "tutorial", "kind": "tip", "turnKey": key ?? bidKey, "headline": title,
                                "reasons": [text], "uses": 0, "freeUses": 3, "assisted": false, "counted": false, "tipId": id]
        if let actions { p["actions"] = actions }
        return T.ev("assistHint", p)
    }

    private var welcome: TableEvent {
        tip("T.welcome", "Tutorial on", UIFixture.welcomeText, actions: ["keep", "off"])
    }

    private let bidText = "Bid how many tricks you expect to win. Your bid adds to the bid of P (your partner): together you must win at least that many."

    private func advice(_ kind: String = "bid", key: String? = nil) -> TableEvent {
        var p: [String: Any] = ["v": 1, "source": "tutorial", "kind": kind, "turnKey": key ?? bidKey, "headline": "Bid 2",
                                "reasons": ["Your hand should take about 2 tricks."], "uses": 0, "freeUses": 3,
                                "assisted": false, "counted": false, "confidence": "clear"]
        if kind == "bid" { p["suggest"] = ["bid": "2"] }
        return T.ev("assistHint", p)
    }

    private func state(on: Bool, auto: Bool = false, uses: Int = 0, unlimited: Bool? = nil) -> TableEvent {
        var p: [String: Any] = ["tutorial": on, "auto": auto, "uses": uses, "freeUses": 3, "assisted": on && !(unlimited ?? false)]
        if let unlimited { p["unlimited"] = unlimited }
        return T.ev("assistState", p)
    }

    private func myBidTurn() -> TableState {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        return s
    }

    private func privateRows(_ s: TableState) -> [String] { s.log.entries.filter(\.isPrivate).map(\.message) }

    // MARK: - Wire

    func testTheCapAndTheRoute() {
        XCTAssertTrue(ClientHello.caps.contains("tutorial"), "only a socket with the cap gets tips, assistState and the auto-start")
        XCTAssertTrue(GameSocketHandler.events.contains(SocketEvents.Server.assistState))
        XCTAssertFalse(ContractSeq.events.contains("assistState"), "private and unsequenced")
        XCTAssertEqual(SocketEvents.Server.assistState, "assistState")
    }

    func testDecodingTipsAndStateIsLenient() throws {
        let ev = try ServerEvent.decode(name: "assistHint", payload: [[
            "v": 1, "source": "tutorial", "kind": "tip", "headline": "Tutorial on", "reasons": ["Tips will appear above your cards."],
            "tipId": "T.welcome", "actions": ["keep", 3, "off", "later"], "turnKey": bidKey, "seq": 7, "future": true,
        ] as [String: Any]], strict: true).get()
        XCTAssertNil(ev.seq)
        guard case .assistHint(let w) = ev.event else { return XCTFail("\(ev.event)") }
        XCTAssertEqual(w.actions, ["keep", "off", "later"], "a non-string action is dropped, not a decode failure")
        let h = try XCTUnwrap(AssistHint(w))
        XCTAssertEqual(h.kind, .tip)
        XCTAssertEqual(h.tipId, "T.welcome")
        XCTAssertEqual(h.actions, ["keep", "off"], "an action this build does not know is not drawn")
        XCTAssertTrue(h.isTutorial)
        XCTAssertNil(AssistRules.footer(h))
        XCTAssertNil(AssistRules.confidenceLabel(h))
        // a tip needs the tutorial and its id
        XCTAssertNil(AssistHint(WirePayload.AssistHint(source: "tutorial", kind: "tip", headline: "Trump")))
        XCTAssertNil(AssistHint(WirePayload.AssistHint(source: "help", kind: "tip", headline: "Trump", tipId: "T.trump")))

        let st = try ServerEvent.decode(name: "assistState", payload: [[
            "tutorial": true, "auto": "yes", "uses": 2, "freeUses": 3, "assisted": true, "seq": 9,
        ] as [String: Any]], strict: true).get()
        XCTAssertNil(st.seq, "never gated")
        guard case .assistState(let a) = st.event else { return XCTFail("\(st.event)") }
        XCTAssertEqual(a.tutorial, true)
        XCTAssertNil(a.auto, "a field of the wrong type is absent")
        XCTAssertEqual(a.uses, 2)
        XCTAssertNil(a.unlimited)
    }

    // MARK: - Reducer

    func testAssistStateTurnsTheChipOnAndOff() {
        var s = myBidTurn()
        TableReducer.reduce(&s, state(on: true, auto: true, uses: 1))
        XCTAssertEqual(s.table.tutorial, TutorialStatus(on: true, auto: true))
        XCTAssertEqual(s.table.assistUses, AssistUses(uses: 1, freeUses: 3, assisted: true, told: true))
        TableReducer.reduce(&s, welcome)
        TableReducer.reduce(&s, tip("T.bid", "Bidding", bidText))
        TableReducer.reduce(&s, advice())
        XCTAssertNotNil(s.table.welcome)
        XCTAssertNotNil(s.table.tip)
        XCTAssertEqual(s.table.assist?.bid, "2")
        // off: its tips, its welcome and its advice go
        TableReducer.reduce(&s, state(on: false))
        XCTAssertEqual(s.table.tutorial, TutorialStatus())
        XCTAssertNil(s.table.welcome)
        XCTAssertNil(s.table.tip)
        XCTAssertNil(s.table.assist, "the tutorial's advice goes with it")
    }

    func testOffKeepsAHelpAnswer() {
        var s = myBidTurn()
        TableReducer.reduce(&s, state(on: true))
        TableReducer.reduce(&s, T.ev("assistHint", ["v": 1, "source": "help", "kind": "bid", "turnKey": bidKey, "headline": "Bid 3",
                                                    "reasons": ["r"], "uses": 1, "freeUses": 3, "assisted": false, "counted": true,
                                                    "suggest": ["bid": "3"]]))
        TableReducer.reduce(&s, state(on: false, uses: 1))
        XCTAssertEqual(s.table.assist?.bid, "3", "what /help answered stays")
    }

    func testOneTipCardAtATimeTheWelcomeFirstAndEveryRuleTipInTheLog() {
        let store = GameState()
        var said: [String] = []
        store.announce = { said.append($0) }
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.snapshot(try! T.snapshot("bidding-mid"), .rejoin, hints: nil))
        store.apply(state(on: true, auto: true))
        XCTAssertTrue(store.showsTutorialChip)
        store.apply(welcome)
        store.apply(tip("T.bid", "Bidding", bidText))
        XCTAssertEqual(store.tutorialWelcome?.tipId, "T.welcome")
        XCTAssertNil(store.tutorialTip, "one tip card at a time: the welcome has priority while it is up")
        XCTAssertEqual(store.state.table.tip?.tipId, "T.bid", "kept behind it")
        XCTAssertEqual(said, ["Tip: Tutorial on. \(UIFixture.welcomeText)"], "VoiceOver hears only the card shown")
        // every rule tip is in the log; the welcome is its card only (owner 2026-11-20: card + row
        // under "<name> turned on the tutorial." read as the start message twice), so the rule
        // tip's row is the log's first tutorial row and carries the note
        XCTAssertEqual(privateRows(store.state), ["Tutorial: \(bidText) (only you see this)"], "every rule tip is in the log, the welcome is not")
        // the same tip again (a rejoin's welcome): no row or second announcement
        store.apply(welcome)
        XCTAssertEqual(said.count, 1)
        XCTAssertEqual(privateRows(store.state).count, 1)
        // Keep: the welcome goes, the rule tip behind it shows and is heard now
        store.apply(.local(.tutorialWelcomeKept))
        XCTAssertNil(store.tutorialWelcome)
        XCTAssertEqual(store.tutorialTip?.headline, "Bidding")
        XCTAssertEqual(said, ["Tip: Tutorial on. \(UIFixture.welcomeText)", "Tip: Bidding. \(bidText)"])
        // a rule tip's close
        store.apply(.local(.tutorialTipDismissed))
        XCTAssertNil(store.tutorialTip)
        XCTAssertTrue(store.showsTutorialChip, "closing a tip leaves the tutorial on")
    }

    func testAWelcomeThatCannotShowAsACardStillLeavesItsRow() {
        // no table yet (as at the draw): the row is the welcome's only copy
        let store = GameState()
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(welcome)
        XCTAssertNil(store.tutorialWelcome)
        XCTAssertEqual(privateRows(store.state), ["Tutorial: \(UIFixture.welcomeText) (only you see this)"])
    }

    func testANewerRuleTipReplacesTheOneBehindTheWelcome() {
        let store = GameState()
        var said: [String] = []
        store.announce = { said.append($0) }
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.snapshot(try! T.snapshot("bidding-mid"), .rejoin, hints: nil))
        store.apply(state(on: true, auto: true))
        store.apply(welcome)
        store.apply(tip("T.trump", "Trump", "Trump this hand is diamonds."))
        store.apply(tip("T.bid", "Bidding", bidText))
        XCTAssertNil(store.tutorialTip)
        XCTAssertEqual(privateRows(store.state).count, 2, "both rule tips are in the log (the welcome is its card only)")
        store.apply(.local(.tutorialWelcomeKept))
        XCTAssertEqual(store.tutorialTip?.tipId, "T.bid", "the newer replaced the older")
        XCTAssertEqual(said.last, "Tip: Bidding. \(bidText)")
        XCTAssertEqual(said.count, 2, "the replaced tip was never shown, so never said")
        // after the welcome, a newer rule tip replaces the one up and is heard at once
        store.apply(tip("T.set", "Set", "Set means you lost."))
        XCTAssertEqual(store.tutorialTip?.tipId, "T.set")
        XCTAssertEqual(said.last, "Tip: Set. Set means you lost.")
        // a tip behind the welcome that my own bid ended is never said
        let t = GameState()
        var heard: [String] = []
        t.announce = { heard.append($0) }
        t.apply(.local(.identity(username: "me", playerId: "sid-me")))
        t.apply(.snapshot(try! T.snapshot("bidding-mid"), .rejoin, hints: nil))
        t.apply(state(on: true, auto: true))
        t.apply(welcome)
        t.apply(tip("T.bid", "Bidding", bidText))
        t.apply(.local(.submitBid("2", reqId: 1)))
        t.apply(.local(.tutorialWelcomeKept))
        XCTAssertNil(t.tutorialTip)
        XCTAssertEqual(heard.count, 1)
        // Turn off: no tip shows while the server's answer is on its way
        let u = GameState()
        u.apply(.local(.identity(username: "me", playerId: "sid-me")))
        u.apply(.snapshot(try! T.snapshot("bidding-mid"), .rejoin, hints: nil))
        u.apply(state(on: true, auto: true))
        u.apply(welcome)
        u.apply(tip("T.bid", "Bidding", bidText))
        u.apply(.local(.tutorialOffSent))
        XCTAssertNil(u.tutorialWelcome)
        XCTAssertNil(u.tutorialTip)
    }

    func testOnlyTheLogsFirstTutorialRowSaysOnlyYouSeeThis() throws {
        let store = GameState()
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.snapshot(try! T.snapshot("bidding-mid"), .rejoin, hints: nil))
        store.apply(state(on: true))
        // a /help status first: its row keeps the note and leaves the tutorial's first its own
        store.apply(T.ev("assistHint", ["v": 1, "source": "help", "kind": "status", "turnKey": bidKey,
                                        "headline": "One moment: try again in a few seconds.", "reasons": [String](),
                                        "uses": 0, "freeUses": 3, "assisted": false, "counted": false]))
        store.apply(tip("T.trump", "Trump", "Trump this hand is hearts ♥."))
        store.apply(tip("T.bid", "Bidding", bidText))
        store.apply(T.ev("assistHint", ["v": 1, "source": "tutorial", "kind": "status", "turnKey": bidKey,
                                        "headline": "Tips off. /help still works any time.", "reasons": [String](),
                                        "uses": 0, "freeUses": 3, "assisted": false, "counted": false]))
        XCTAssertEqual(privateRows(store.state), ["Help: One moment: try again in a few seconds. (only you see this)",
                                                  "Tutorial: Trump this hand is hearts ♥. (only you see this)",
                                                  "Tutorial: \(bidText)",
                                                  "Tutorial: Tips off. /help still works any time."])
        // a snapshot with its own log (a rejoin, a relaunch's): a new log, the note once again
        store.apply(.snapshot(try! T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertEqual(privateRows(store.state), [], "the server's log has no private rows")
        store.apply(state(on: true))
        store.apply(tip("T.lead", "Leading", "You lead: play any card."))
        store.apply(tip("T.follow", "Following", "Follow the suit led if you can."))
        XCTAssertEqual(privateRows(store.state), ["Tutorial: You lead: play any card. (only you see this)",
                                                  "Tutorial: Follow the suit led if you can."])
    }

    func testMyOwnBidEndsTheRuleTipButNotTheWelcome() {
        var s = myBidTurn()
        TableReducer.reduce(&s, state(on: true))
        TableReducer.reduce(&s, welcome)
        TableReducer.reduce(&s, tip("T.bid", "Bidding", bidText))
        // other seats' events leave it
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 4]))
        XCTAssertNotNil(s.table.tip)
        TableReducer.reduce(&s, .local(.submitBid("2", reqId: 1)))
        XCTAssertNil(s.table.tip, "my bid is on its way: the tip about it is done")
        XCTAssertNotNil(s.table.welcome, "the welcome waits for Keep / Turn off")
        var t = myBidTurn()
        TableReducer.reduce(&t, state(on: true))
        TableReducer.reduce(&t, tip("T.trump", "Trump", "Trump this hand is diamonds."))
        TableReducer.reduce(&t, T.ev("bidReceived", ["bid": 2, "position": 1, "seq": 4]))
        XCTAssertNil(t.table.tip, "my bid came back")
        // a tip at hand end (the hand score) survives the hand's end and the next deal
        TableReducer.reduce(&t, T.ev("handComplete", ["score": ["team1": 10, "team2": 0], "team1Tricks": 2, "team2Tricks": 1, "seq": 5]))
        TableReducer.reduce(&t, tip("T.handScore", "Hand score", "This hand, you and P (your partner) bid 2 and won 2: 2 × 10 = +20."))
        XCTAssertEqual(t.table.tip?.tipId, "T.handScore")
        TableReducer.reduce(&t, T.ev("gameEnd", ["score": ["team1": 300, "team2": 0], "seq": 6]))
        XCTAssertNil(t.table.tip, "game over")
        XCTAssertNil(t.table.welcome)
        // on the game-end screen a tip is its row only
        TableReducer.reduce(&t, tip("T.done", "Tutorial complete", "Thanks for playing with the tutorial. Type /help any time for a suggestion."))
        XCTAssertNil(t.table.tip)
        XCTAssertEqual(privateRows(t).last, "Tutorial: Thanks for playing with the tutorial. Type /help any time for a suggestion.")
    }

    func testTheTutorialsAdviceIsNeverCountedOrLogged() throws {
        var s = myBidTurn()
        s.table.assistAsking = true  // the lightbulb's /help is on its way
        TableReducer.reduce(&s, state(on: true))
        let fx = TableReducer.reduce(&s, advice())
        XCTAssertEqual(s.table.assist?.bid, "2")
        XCTAssertEqual(privateRows(s), [], "no row per decision")
        XCTAssertTrue(fx.contains(.announce("Suggestion: Bid 2. Your hand should take about 2 tricks.")))
        XCTAssertTrue(s.table.assistAsking, "the push is not the lightbulb's answer")
        let h = try XCTUnwrap(s.table.assist)
        XCTAssertEqual(AssistRules.footer(h), "What our strongest bot would play", "no count")
        // advice for a turn the table has not reached is held, then given up without a row
        var t = myBidTurn()
        TableReducer.reduce(&t, advice(key: "1|BIDDING|1|1|0"))
        XCTAssertNotNil(t.table.parkedAssist)
        TableReducer.reduce(&t, T.ev("bidReceived", ["bid": 1, "position": 1, "seq": 4]))
        XCTAssertNil(t.table.parkedAssist)
        XCTAssertEqual(privateRows(t), [], "never asked for: no 'that turn had passed' row")
    }

    func testATutorialStatusSettlesTheSwitch() {
        var s = myBidTurn()
        TableReducer.reduce(&s, state(on: true))
        TableReducer.reduce(&s, welcome)
        TableReducer.reduce(&s, .local(.tutorialOffSent))
        XCTAssertTrue(s.table.tutorialOffSent)
        XCTAssertNil(s.table.welcome, "Turn off: the welcome goes at once")
        XCTAssertTrue(s.table.tutorial.on, "the server says when it is off")
        // the rate limit's reply: still on, the switch is back
        TableReducer.reduce(&s, T.ev("assistHint", ["v": 1, "source": "tutorial", "kind": "status", "turnKey": bidKey,
                                                    "headline": "One moment: try again in a few seconds.", "reasons": [String](),
                                                    "uses": 0, "freeUses": 3, "assisted": false, "counted": false]))
        XCTAssertFalse(s.table.tutorialOffSent)
        XCTAssertTrue(s.table.tutorial.on)
        // the chip's switch (or Turn off): its reply is a "Tutorial:" row, never "Help:"
        TableReducer.reduce(&s, T.ev("assistHint", ["v": 1, "source": "tutorial", "kind": "status", "turnKey": bidKey,
                                                    "headline": "Tips off. /help still works any time.", "reasons": [String](),
                                                    "uses": 0, "freeUses": 3, "assisted": false, "counted": false]))
        XCTAssertEqual(privateRows(s).last, "Tutorial: Tips off. /help still works any time.", "the welcome's row had the note")
        XCTAssertFalse(privateRows(s).contains { $0.hasPrefix("Help:") })
    }

    func testOnlyMySeatSeesTipsAndTheChip() throws {
        var s = try T.state(fixture: "spectator-mid-hand")
        TableReducer.reduce(&s, state(on: true))
        TableReducer.reduce(&s, tip("T.trump", "Trump", "Trump this hand is hearts."))
        XCTAssertNil(s.table.tip, "a spectator: the row only")
        var t = myBidTurn()
        TableReducer.reduce(&t, state(on: true))
        TableReducer.reduce(&t, tip("T.trump", "Trump", "Trump this hand is hearts."))
        TableReducer.reduce(&t, T.ev("playerLazyMode", ["position": 1, "botUsername": "Bot", "originalUsername": "me", "seq": 4]))
        XCTAssertNil(t.table.tip, "a bot plays my seat")
        let store = GameState()
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.snapshot(try T.snapshot("spectator-mid-hand"), .spectate, hints: nil))
        store.apply(state(on: true))
        XCTAssertFalse(store.showsTutorialChip, "never a spectator's")
    }

    // MARK: - Snapshot

    func testTheSnapshotSaysWhetherItIsOn() throws {
        let on: (inout [String: Any]) -> Void = { raw in
            var v = raw["viewer"] as? [String: Any] ?? [:]
            v["assist"] = ["uses": 0, "freeUses": 3, "assisted": true, "tutorial": true, "auto": true]
            raw["viewer"] = v
        }
        let noAssist: (inout [String: Any]) -> Void = { raw in
            var v = raw["viewer"] as? [String: Any] ?? [:]
            v.removeValue(forKey: "assist")
            raw["viewer"] = v
        }
        var s = TableState()
        TableReducer.reduce(&s, .snapshot(try T.snapshot("bidding-mid", edit: on), .rejoin, hints: nil))
        XCTAssertEqual(s.table.tutorial, TutorialStatus(on: true, auto: true), "a reload shows the chip")
        TableReducer.reduce(&s, tip("T.trump", "Trump", "Trump this hand is hearts."))
        XCTAssertNotNil(s.table.tip)
        // the same game without viewer.assist (an older server): kept, with its tip
        TableReducer.reduce(&s, .snapshot(try T.snapshot("bidding-mid", edit: noAssist), .requested("x"), hints: nil))
        XCTAssertTrue(s.table.tutorial.on)
        XCTAssertNotNil(s.table.tip)
        // viewer.assist without tutorial: off (present only while on)
        TableReducer.reduce(&s, .snapshot(try T.snapshot("bidding-mid"), .requested("y"), hints: nil))
        XCTAssertFalse(s.table.tutorial.on)
        XCTAssertNil(s.table.tip)
        // another game's snapshot without it: off
        var t = TableState()
        TableReducer.reduce(&t, .snapshot(try T.snapshot("bidding-mid", edit: on), .rejoin, hints: nil))
        TableReducer.reduce(&t, .snapshot(try T.snapshot("bidding-mid") { noAssist(&$0); $0["gameId"] = "other" }, .rejoin, hints: nil))
        XCTAssertFalse(t.table.tutorial.on)
    }

    // MARK: - Words and commands

    func testWords() throws {
        let h = try XCTUnwrap(AssistHint(WirePayload.AssistHint(source: "tutorial", kind: "tip", headline: "Trump",
                                                                reasons: ["Trump this hand is hearts ♥."], tipId: "T.trump")))
        XCTAssertEqual(TutorialRules.logLine(h), "Tutorial: Trump this hand is hearts ♥. (only you see this)")
        // the tutorial's status replies are "Tutorial:" rows too; /help's own keep "Help:"
        let off = try XCTUnwrap(AssistHint(WirePayload.AssistHint(source: "tutorial", kind: "status",
                                                                  headline: "Tips off. /help still works any time.")))
        XCTAssertEqual(AssistRules.logLine(off), "Tutorial: Tips off. /help still works any time. (only you see this)")
        XCTAssertEqual(AssistRules.logLine(off, note: false), "Tutorial: Tips off. /help still works any time.")
        XCTAssertEqual(TutorialRules.logLine(h, note: false), "Tutorial: Trump this hand is hearts ♥.")
        let help = try XCTUnwrap(AssistHint(WirePayload.AssistHint(source: "help", kind: "status", headline: "/help is for players only.")))
        XCTAssertEqual(AssistRules.logLine(help), "Help: /help is for players only. (only you see this)")
        XCTAssertEqual(AssistRules.logLine(help, note: false), "Help: /help is for players only. (only you see this)", "/help's rows always")
        XCTAssertEqual(TutorialRules.announcement(h), "Tip: Trump. Trump this hand is hearts ♥.")
        XCTAssertEqual(TutorialRules.commandDescription(on: false), "Tutorial: tips and advice every turn")
        XCTAssertEqual(TutorialRules.commandDescription(on: true), "Turn off the tutorial")
        // names only: never team numbers, "your team" or "opponents" in this build's words
        let words = [TutorialRules.describeOff, TutorialRules.describeOn, TutorialRules.chipText, TutorialRules.chipLabel,
                     TutorialRules.chipHint, TutorialRules.keepLabel, TutorialRules.offLabel, TutorialRules.closeLabel]
        for w in words {
            for bad in ["Team 1", "Team 2", "T1", "T2", "your team", "Your Team", "opponent", "Opponent"] {
                XCTAssertFalse(w.contains(bad), "\(w)")
            }
        }
    }

    func testTheCommandListAndTypedLines() {
        let seat = GameLogPanel.commands(pureSpectator: false, leave: .botFinishes, help: "Ask a bot for advice (1 of 3 free used)",
                                         tutorial: TutorialRules.commandDescription(on: false))
        XCTAssertEqual(seat.map(\.command), ["/lazy", "/active", "/leave", "/help", "/tutorial"])
        XCTAssertEqual(seat.last?.description, "Tutorial: tips and advice every turn")
        XCTAssertEqual(GameLogPanel.commands(pureSpectator: true, leave: .botFinishes, help: "x", tutorial: "y").map(\.command), ["/leave"])
        let cmds = seat.map(\.command)
        XCTAssertEqual(ChatCommand.resolve("/tutorial", commands: cmds), .send("/tutorial"))
        XCTAssertEqual(ChatCommand.resolve("/t", commands: cmds), .send("/tutorial"))
        XCTAssertEqual(ChatCommand.resolve("/tutorial on", commands: cmds), .send("/tutorial on"))
        XCTAssertEqual(ChatCommand.resolve("/Tutorial  OFF ", commands: cmds), .send("/tutorial off"))
        XCTAssertEqual(ChatCommand.resolve("/tut off", commands: cmds), .send("/tutorial off"))
        XCTAssertEqual(ChatCommand.resolve("/tutorial maybe", commands: cmds), .send("/tutorial maybe"), "the server says how")
        XCTAssertEqual(ChatCommand.resolve("/tutorial on", commands: ["/leave"]), .send("/tutorial on"), "a spectator hears it from the server")
        XCTAssertEqual(ChatCommand.resolve("/tut on", commands: ["/leave"]), .unknown("/tut"))
        XCTAssertEqual(ChatCommand.resolve("/l on", commands: cmds), .unknown("/l"), "only /tutorial takes a word")
    }

    /// The iPhone Duo's vertical bar (owner 2026-11-21): its switch turns the tutorial on with
    /// /tutorial on, and a welcome there is no card: its row in the log once a game, the rule tip
    /// behind it up and heard, nothing sent.
    func testTheBarsSwitchTurnsItOnAndAHiddenWelcomeIsARow() {
        let store = GameState()
        let emitter = FakeEmitter()
        var said: [String] = []
        store.announce = { said.append($0) }
        let actions = ActionCoordinator(store: store, emitter: emitter, clock: ManualClock(), sounds: RecordingSounds(),
                                        soundClock: ManualClock(), tunePlayer: FakeTunePlayer(SoundClock()), askClock: ManualClock())
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.snapshot(try! T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertTrue(store.showsAssistBarItem, "my seat: the bar's switch is there with the tutorial off")
        XCTAssertFalse(actions.tutorialOn(connected: false), "offline: nothing sent")
        XCTAssertEqual(emitter.sent, [])
        XCTAssertTrue(actions.tutorialOn(connected: true))
        XCTAssertEqual(emitter.sent, [.chat("/tutorial on")])
        store.apply(state(on: true, auto: true))
        XCTAssertFalse(actions.tutorialOn(connected: true), "on already: nothing to send")
        store.apply(welcome)
        store.apply(tip("T.bid", "Bidding", bidText))
        XCTAssertNil(store.tutorialTip, "behind the welcome")
        store.apply(.local(.tutorialWelcomeHidden))
        XCTAssertNil(store.tutorialWelcome)
        XCTAssertEqual(store.tutorialTip?.headline, "Bidding", "the rule tip shows at once")
        XCTAssertEqual(said.last, "Tip: Bidding. \(bidText)", "and is heard")
        XCTAssertEqual(privateRows(store.state), ["Tutorial: \(bidText) (only you see this)", "Tutorial: \(TutorialRules.hiddenWelcomeText)"],
                       "the welcome's row, once (the first row keeps the note)")
        XCTAssertEqual(emitter.sent, [.chat("/tutorial on")], "nothing sent for the hidden welcome")
        // a rejoin's welcome again: hidden again, no second row
        store.apply(welcome)
        store.apply(.local(.tutorialWelcomeHidden))
        XCTAssertEqual(privateRows(store.state).count, 2)
    }

    /// The switch (the corner's button, the Duo's bar item) asks before turning the tutorial on
    /// where that makes the game bot-assisted for me (owner 2026-11-21): not once it already is
    /// (the server's `assisted`), and never in a game with a native bot seat (no such words there).
    func testTheSwitchAsksFirstOnlyWhereTheGameWouldBecomeBotAssisted() throws {
        let store = GameState()
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertFalse(AssistRules.isFreeHelpGame(store.state), "the fixture's seats are human")
        XCTAssertTrue(TutorialRules.needsConfirm(store.state), "a human game not yet assisted: ask")
        // an auto-start turned off before my first decision is not assisted: ask
        store.apply(state(on: false, auto: false))
        XCTAssertTrue(TutorialRules.needsConfirm(store.state))
        // on once (tutorialEver): the game stays assisted, a second on asks nothing
        store.apply(T.ev("assistState", ["tutorial": false, "auto": false, "uses": 0, "freeUses": 3, "assisted": true]))
        XCTAssertFalse(TutorialRules.needsConfirm(store.state))
        // a game with a native bot seat: its stats are bot-game stats anyway, and nothing is said
        let bots = GameState()
        bots.apply(.local(.identity(username: "me", playerId: "sid-me")))
        bots.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        bots.apply(state(on: false, unlimited: true))
        XCTAssertTrue(AssistRules.isFreeHelpGame(bots.state))
        XCTAssertFalse(TutorialRules.needsConfirm(bots.state))
        // the words: the server's own for the stats bucket, names none
        XCTAssertTrue(TutorialRules.confirmMessage.contains("it goes in your bot-game stats, not the human leaderboard"))
        XCTAssertTrue(TutorialRules.hiddenWelcomeText.hasPrefix("Tips will appear above your cards. Only you see them."))
        XCTAssertFalse(TutorialRules.hiddenWelcomeText.contains("Turn off"), "iOS draws no Turn off")
    }

    func testKeepAndTurnOffSendTheirLines() {
        let store = GameState()
        let emitter = FakeEmitter()
        let actions = ActionCoordinator(store: store, emitter: emitter, clock: ManualClock(), sounds: RecordingSounds(),
                                        soundClock: ManualClock(), tunePlayer: FakeTunePlayer(SoundClock()), askClock: ManualClock())
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.snapshot(try! T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertFalse(actions.tutorialOff(connected: true), "off already: nothing to send")
        store.apply(state(on: true, auto: true))
        store.apply(welcome)
        actions.tutorialKeep(connected: true)
        XCTAssertEqual(emitter.sent, [.chat("/tutorial keep")])
        XCTAssertNil(store.tutorialWelcome)
        // the welcome's ×: its own line (the server dismisses an auto-start for it, not for Keep)
        store.apply(welcome)
        XCTAssertNotNil(store.tutorialWelcome)
        actions.tutorialClose(connected: true)
        XCTAssertEqual(emitter.sent, [.chat("/tutorial keep"), .chat("/tutorial close")])
        XCTAssertNil(store.tutorialWelcome)
        XCTAssertTrue(store.showsTutorialChip, "closing the welcome leaves the tutorial on")
        XCTAssertFalse(actions.tutorialOff(connected: false))
        XCTAssertEqual(store.notice?.text, AssistRules.reconnecting)
        XCTAssertEqual(emitter.sent.count, 2)
        XCTAssertTrue(actions.tutorialOff(connected: true))
        XCTAssertEqual(emitter.sent.last, .chat("/tutorial off"))
        XCTAssertTrue(store.tutorialOffSent)
        XCTAssertFalse(actions.tutorialOff(connected: true), "one tap, one line")
        store.apply(state(on: false))
        XCTAssertFalse(store.showsTutorialChip)
        XCTAssertFalse(store.tutorialOffSent)
        XCTAssertEqual(store.tutorialDescription, "Tutorial: tips and advice every turn")
    }

    func testHelpWhileTheTutorialIsOnNamesNoCount() throws {
        // a first /help while on: the server answers source help, counted false (never counted then)
        let help = try XCTUnwrap(AssistHint(WirePayload.AssistHint(kind: "card", headline: "Play 9\u{2666}", reasons: ["Main reason"],
                                                                   uses: 0, freeUses: 3, assisted: false, counted: false,
                                                                   confidence: "clear")))
        XCTAssertFalse(help.isTutorial)
        XCTAssertEqual(AssistRules.footer(help, tutorial: true), "What our strongest bot would play")
        XCTAssertEqual(AssistRules.footer(help), "What our strongest bot would play \u{00B7} Asked again this turn: not counted",
                       "tutorial off: a re-ask, as before")
        let quick = try XCTUnwrap(AssistHint(WirePayload.AssistHint(kind: "card", headline: "Play 9\u{2666}", reasons: ["Main reason"],
                                                                    uses: 0, freeUses: 3, assisted: false, counted: false,
                                                                    confidence: "quick")))
        XCTAssertEqual(AssistRules.footer(quick, tutorial: true), AssistRules.footerQuick)
        // the chat list: no free-use count while on (before the first decision: not assisted yet)
        let store = GameState()
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        store.apply(T.ev("assistState", ["tutorial": true, "auto": true, "uses": 0, "freeUses": 3, "assisted": false]))
        XCTAssertEqual(store.helpDescription, "Ask a bot for advice")
        store.apply(state(on: true, auto: true))
        XCTAssertEqual(store.helpDescription, "Ask a bot for advice (this game is bot-assisted for you)")
        // off again, never assisted: the count is back
        store.apply(T.ev("assistState", ["tutorial": false, "auto": false, "uses": 1, "freeUses": 3, "assisted": false]))
        XCTAssertEqual(store.helpDescription, "Ask a bot for advice (1 of 3 free used)")
    }

    // MARK: - Layout

    func testTheColumnKeepsAboveTheLightbulbAndBelowTheCornerButtons() {
        let keeps = AssistLayout.Keeps(anchor: 700, clock: nil, seatRow: nil, fold: nil)
        let plain = AssistLayout.frame(paneWidth: 400, handMidX: 200, handWidth: 360, top: 100, keeps: keeps)
        XCTAssertEqual(plain.maxY, 700 - AssistLayout.gap)
        var withAsk = keeps
        withAsk.ask = CGRect(x: 330, y: 650, width: 44, height: 44)
        let f = AssistLayout.frame(paneWidth: 400, handMidX: 200, handWidth: 360, top: 100, keeps: withAsk)
        XCTAssertEqual(f.maxY, 650 - AssistLayout.gap, "above the lightbulb under its span")
        XCTAssertNotNil(withAsk.probe["ask"])
        var aside = keeps
        aside.ask = CGRect(x: 0, y: 650, width: 4, height: 44)
        XCTAssertEqual(AssistLayout.frame(paneWidth: 400, handMidX: 200, handWidth: 360, top: 100, keeps: aside).maxY, 700 - AssistLayout.gap,
                       "a lightbulb beside the column's span is no matter")
        var corners = keeps
        corners.corners = [CGRect(x: 12, y: 110, width: 80, height: 40), CGRect(x: 320, y: 110, width: 60, height: 60)]
        let c = AssistLayout.frame(paneWidth: 400, handMidX: 200, handWidth: 360, top: 100, keeps: corners)
        XCTAssertEqual(c.minY, 170 + AssistLayout.gap, "below Exit and the log's button")
        var narrow = keeps
        narrow.corners = [CGRect(x: 12, y: 110, width: 80, height: 40)]
        let n = AssistLayout.frame(paneWidth: 1000, handMidX: 500, handWidth: 300, top: 100, keeps: narrow)
        XCTAssertEqual(n.minY, 100, "a column clear of the corners keeps its top (an iPad)")
    }

    /// The other seats (avatar and name, bid bubble, dealer button): the column starts below
    /// the partner's while that leaves the cards minRoom (the web's assistRoomTop); it narrows
    /// between the side seats, else starts below them where that leaves sideRoom, else (a phone
    /// in portrait) may cover them.
    func testTheColumnKeepsOffTheOtherSeats() {
        var keeps = AssistLayout.Keeps(anchor: 700, clock: nil, seatRow: nil, fold: nil)
        keeps.seats = ["seat3": CGRect(x: 170, y: 120, width: 60, height: 80),     // the partner, above
                       "bubble3": CGRect(x: 240, y: 140, width: 60, height: 36)]
        let f = AssistLayout.frame(paneWidth: 400, handMidX: 200, handWidth: 360, top: 100, keeps: keeps)
        XCTAssertEqual(f.minY, 200 + AssistLayout.gap, "below the partner's avatar and name")
        XCTAssertEqual(f.maxY, 700 - AssistLayout.gap)
        XCTAssertFalse(keeps.seats.values.contains { $0.intersects(f.insetBy(dx: 0.5, dy: 0.5)) })
        // a partner's part that would leave the cards under minRoom is no cap
        var tight = keeps
        tight.seats["bubble3"] = CGRect(x: 240, y: 560, width: 60, height: 36)  // 694 - 50 - 602 = 42
        XCTAssertEqual(AssistLayout.frame(paneWidth: 400, handMidX: 200, handWidth: 360, top: 100, keeps: tight, foot: 50).minY,
                       200 + AssistLayout.gap)
        // side seats on a phone (no room between them): below them while that leaves sideRoom
        keeps.sides = ["seat2": CGRect(x: 20, y: 400, width: 60, height: 80), "seat4": CGRect(x: 330, y: 400, width: 60, height: 80)]
        let side = AssistLayout.frame(paneWidth: 400, handMidX: 200, handWidth: 360, top: 100, keeps: keeps)
        XCTAssertEqual(side.minY, 480 + AssistLayout.gap, "694 - 486 = 208 of room")
        XCTAssertEqual(side.width, 360, "no room between them (238 < minWidth): the hand's width stays")
        // less than sideRoom (the chip's foot): they may be covered, the partner's cap holds
        let covered = AssistLayout.frame(paneWidth: 400, handMidX: 200, handWidth: 360, top: 100, keeps: keeps, foot: 50)
        XCTAssertEqual(covered.minY, 200 + AssistLayout.gap, "694 - 50 - 486 = 158 < sideRoom")
        // a wide pane: the column narrows between them, its height kept
        var wide = AssistLayout.Keeps(anchor: 700, clock: nil, seatRow: nil, fold: nil)
        wide.sides = ["seat2": CGRect(x: 260, y: 400, width: 100, height: 80), "seat4": CGRect(x: 700, y: 400, width: 100, height: 80)]
        let n = AssistLayout.frame(paneWidth: 1000, handMidX: 500, handWidth: 380, top: 100, keeps: wide)
        XCTAssertEqual(n, CGRect(x: 366, y: 100, width: 328, height: 594))
        XCTAssertFalse(wide.sides.values.contains { $0.intersects(n) })
        // a seat beside the column's span is no matter
        var aside = AssistLayout.Keeps(anchor: 700, clock: nil, seatRow: nil, fold: nil)
        aside.sides = ["seat2": CGRect(x: 0, y: 300, width: 10, height: 80)]
        XCTAssertEqual(AssistLayout.frame(paneWidth: 1000, handMidX: 500, handWidth: 300, top: 100, keeps: aside).minY, 100)
        XCTAssertNil(keeps.probe["seat3"], "the seats are the probe's own part")
        XCTAssertNotNil(keeps.seatProbe["side.seat2"])
    }
}
