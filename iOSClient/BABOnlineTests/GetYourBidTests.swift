import XCTest
@testable import BAB_Online

/// Get Your Bid on iOS (State/Table/GetYourBid.swift): the rules the app mirrors, the three-seat
/// mapping, every `gyb` / `mode` payload of the real recording (events-gyb-s19, recorded from
/// the server's handlers by `npm run ios:fixtures`) through the reducer against the server's
/// checkpoints, and the screens' pure models (score bar, bid sheet, game end, lobby, lists).
final class GetYourBidTests: XCTestCase {

    // MARK: - Rules

    func testTheForbiddenBidIsWhatWouldMakeTheBidsAddUpToTheHand() {
        // docs/RULES.md: on the 12, the first bids 5, the second 4: the third may not bid 3
        var b = BidBook.fresh(bidder: 2, seats: 3)
        b.byPosition = BidBook.padded(["5", "4", nil])
        XCTAssertEqual(GybRules.forbidden(bids: b, dealer: 3, handSize: 12), GybForbidden(position: 3, bid: 3))
        // a hand of 4 cards or fewer has none
        XCTAssertNil(GybRules.forbidden(bids: b, dealer: 3, handSize: 4))
        XCTAssertEqual(GybRules.forbidden(bids: b, dealer: 3, handSize: 9), GybForbidden(position: 3, bid: 0))
        // the first two already past the hand: none
        XCTAssertNil(GybRules.forbidden(bids: b, dealer: 3, handSize: 8))
        // before both others bid: none
        b.byPosition = BidBook.padded(["5", nil, nil])
        XCTAssertNil(GybRules.forbidden(bids: b, dealer: 3, handSize: 12))
        // the dealer is whoever deals: seat 1 here
        b.byPosition = BidBook.padded([nil, "2", "1"])
        XCTAssertEqual(GybRules.forbidden(bids: b, dealer: 1, handSize: 5), GybForbidden(position: 1, bid: 2))
    }

    func testTheHandScoreIsTheServersRule() {
        XCTAssertEqual(GybRules.handScore(bid: 3, took: 3), 13)
        XCTAssertEqual(GybRules.handScore(bid: 1, took: 1), 11)
        XCTAssertEqual(GybRules.handScore(bid: 0, took: 0), 5)
        XCTAssertEqual(GybRules.handScore(bid: 3, took: 4), 0)
        XCTAssertEqual(GybRules.handScore(bid: 3, took: 2), 0)
        XCTAssertEqual(GybRules.handScore(bid: 3, took: 2, forbidden: 2), 1)
    }

    func testThreeSeatsMapLeftAndRightWithNoPartner() {
        XCTAssertEqual(Positions.rotate(3, seats: 3), 1)
        XCTAssertEqual(Positions.rotate(1, seats: 3), 2)
        for me in 1...3 {
            let a = Positions.around(me, seats: 3)
            XCTAssertNil(a.partner)
            XCTAssertEqual(Positions.getRelative(target: a.opp1, from: me, seats: 3), .left)
            XCTAssertEqual(Positions.getRelative(target: a.opp2, from: me, seats: 3), .right)
            XCTAssertEqual(Positions.getRelative(target: me, from: me, seats: 3), .bottom)
            XCTAssertEqual(Set([me, a.opp1, a.opp2]), [1, 2, 3])
        }
        // seats 1 and 3 share a parity but are opponents at three seats
        XCTAssertTrue(Positions.areOpponents(1, 3, seats: 3))
        XCTAssertFalse(Positions.areOpponents(1, 3, seats: 4))
        XCTAssertEqual(GybRules.order(viewer: 2), [2, 3, 1])
        XCTAssertEqual(GybRules.order(viewer: nil), [1, 2, 3])
        // the four-seat mapping is unchanged
        XCTAssertEqual(Positions.getRelative(target: 3, from: 1, seats: 4), .top)
        XCTAssertEqual(Positions.colour(3, seats: 4), 1)
        XCTAssertEqual(Positions.colour(3, seats: 3), 3)
    }

    func testAHiJokerLeadForcesEveryOtherSeatAtThreeSeats() {
        let trump = T.c("spades", "5")
        let hand = [T.c("spades", "K"), T.c("spades", "3"), T.c("hearts", "9")]
        let lead = T.c("joker", "HI")
        // seat 3 follows seat 1's HI joker: an opponent at three seats, the partner at four
        let solo = CardLegality.getLegalCards(hand: hand, lead: lead, isLeading: false, trump: trump, trumpBroken: true,
                                              myPosition: 3, leadPosition: 1, seats: 3)
        XCTAssertEqual(solo, [T.c("spades", "K")])
        let classic = CardLegality.getLegalCards(hand: hand, lead: lead, isLeading: false, trump: trump, trumpBroken: true,
                                                 myPosition: 3, leadPosition: 1)
        XCTAssertEqual(Set(classic.map(\.id)), Set([T.c("spades", "K"), T.c("spades", "3")].map(\.id)))
    }

    func testOverTrumpingAnyOtherSeatCountsAtThreeSeats() {
        let trump = T.c("spades", "5")
        let trick = [PlayedCard(card: T.c("hearts", "9"), position: 1), PlayedCard(card: T.c("spades", "3"), position: 2),
                     PlayedCard(card: T.c("spades", "K"), position: 3)]
        // 3 beats 2's trump: another seat (no partner) at three seats
        XCTAssertTrue(TrickRules.isOverTrump(trick: trick, trump: trump, seats: 3))
        let partnerTrick = [PlayedCard(card: T.c("hearts", "9"), position: 4), PlayedCard(card: T.c("spades", "3"), position: 1),
                            PlayedCard(card: T.c("spades", "K"), position: 3)]
        XCTAssertFalse(TrickRules.isOverTrump(trick: partnerTrick, trump: trump))
    }

    // MARK: - Wire

    func testEveryGybPayloadDecodes() throws {
        let game = try RecordedGame("events-gyb-s19")
        var seen: [String: Int] = [:]
        for (label, log) in game.logs {
            for e in log where e.dir == "s2c" {
                guard let d = e.data as? [String: Any] else { continue }
                if d["gyb"] != nil || d["mode"] != nil { seen[e.event, default: 0] += 1 }
                switch e.event {
                case "gameStart":
                    let p = try Wire.decode(WirePayload.GameStart.self, d, strict: true)
                    XCTAssertEqual(p.gyb?.scores.count, 3, label)
                case "doneBidding":
                    let p = try Wire.decode(WirePayload.DoneBidding.self, d, strict: true)
                    XCTAssertNotNil(p.gyb, label)
                case "handComplete":
                    let p = try Wire.decode(WirePayload.HandComplete.self, d, strict: true)
                    let h = try XCTUnwrap(p.gyb)
                    XCTAssertEqual(h.seats.map(\.position).sorted(), [1, 2, 3])
                    for s in h.seats {
                        XCTAssertEqual(s.points, s.forbiddenHit ? 1 : GybRules.handScore(bid: s.bid, took: s.took), "\(label) seat \(s.position)")
                        XCTAssertEqual(h.score(s.position), h.oldScores[s.position - 1] + s.points)
                    }
                case "gameEnd":
                    let end = try XCTUnwrap(GameEndData.from(d)?.gyb)
                    XCTAssertEqual(end.scores.count, 3)
                    XCTAssertEqual(end.hands, 13)
                    XCTAssertEqual(end.winners, [2])
                case "rejoinSuccess", "spectatorJoined":
                    // (a seat's spectatorJoined is the notice about someone else: no state)
                    guard d["snapshot"] != nil else { continue }
                    let env = try Wire.decode(WirePayload.RejoinEnvelope.self, d, strict: true)
                    XCTAssertNotNil(env.gyb, label)
                    XCTAssertEqual(env.hints.gyb, env.gyb)
                case "allPlayersReady":
                    XCTAssertEqual(try Wire.decode(WirePayload.AllPlayersReady.self, d, strict: true).mode, "gyb")
                default:
                    break
                }
            }
        }
        for event in ["gameStart", "doneBidding", "handComplete", "gameEnd", "rejoinSuccess", "spectatorJoined", "allPlayersReady"] {
            XCTAssertGreaterThan(seen[event] ?? 0, 0, "no \(event) with gyb / mode in the recording")
        }
    }

    func testAMalformedGybIsLenientAndStillMarksTheTable() throws {
        let p = try Wire.decode(WirePayload.HandComplete.self, ["gyb": ["scores": "x", "seats": [["position": 9], ["position": 2, "bid": 1, "took": 1, "points": 11]]]])
        XCTAssertEqual(p.gyb?.scores, [0, 0, 0])
        XCTAssertEqual(p.gyb?.seats.map(\.position), [2])
        let env = try Wire.decode(WirePayload.RejoinEnvelope.self, ["gameId": "g", "gyb": ["scores": [1, 2]]])
        XCTAssertEqual(env.gyb?.scores, [1, 2, 0])
        let plain = try Wire.decode(WirePayload.RejoinEnvelope.self, ["gameId": "g"])
        XCTAssertNil(plain.gyb)
        XCTAssertNil(GameEndData.from(["score": ["team1": 1, "team2": 2]])?.gyb)
    }

    // MARK: - The recording through the reducer

    /// Events this replay does not route through the table store (voice, play again).
    static let offTable: Set<String> = ["voiceSettings", "lobbyReturn"]

    func testEveryViewerMatchesTheServerAtEveryCheckpoint() throws {
        let game = try RecordedGame("events-gyb-s19")
        let raw = try FixtureLoader.eventLog("events-gyb-s19")
        let rawChecks = try XCTUnwrap(raw["checkpoints"] as? [[String: Any]])
        var compared = 0
        for viewer in game.viewers {
            let log = game.logs[viewer.label] ?? []
            var replay = ReducerReplay(viewer: viewer)
            var next = 0
            let checks = rawChecks.filter { $0["viewer"] as? String == viewer.label }
            for check in checks {
                let after = check["afterIndex"] as! Int
                while next < after {
                    if !Self.offTable.contains(log[next].event) { try replay.apply(log[next]) }
                    next += 1
                }
                let snap = try TableSnapshot.decode(check["snapshot"] as! [String: Any], strict: true)
                let gyb = try Wire.decode(GybSnapshot.self, check["gyb"])
                var server = TableProjection(snapshot: snap)
                // the padded four-seat snapshot: the fourth seat never bids; the team keys carry nothing
                server.order = server.order.filter { $0 <= 3 }
                server.teamBids = nil
                var client = TableProjection(state: replay.state)
                client.teamBids = nil
                let diff = client.diff(server, watchingInFlight: game.watchingInFlight(for: viewer.label, after: after))
                XCTAssertEqual(diff, [], "\(viewer.label) after #\(after)")
                if replay.state.table.phase.kind != .draw && replay.state.table.phase.kind != .waiting {
                    XCTAssertTrue(replay.state.table.isGyb, "\(viewer.label) after #\(after): not a Get Your Bid table")
                    XCTAssertEqual(replay.state.table.gyb.scores, gyb.scores, "\(viewer.label) after #\(after): scores")
                }
                compared += 1
            }
            while next < log.count {
                if !Self.offTable.contains(log[next].event) { try replay.apply(log[next]) }
                next += 1
            }
            let bad = replay.effects.filter { if case .dropped = $0 { return true }; if case .gap = $0 { return true }; return false }
            XCTAssertEqual(bad, [], "\(viewer.label): drops or gaps")
            if let final = game.final[viewer.label] {
                guard case .ended(let end) = replay.state.table.phase else { return XCTFail("\(viewer.label): not ended") }
                XCTAssertEqual(end, GameEndData.from(final.gameEnd))
                XCTAssertEqual(end.gyb?.scores, [62, 83, 26])
                XCTAssertEqual(replay.state.table.gyb.made, [5, 8, 2])
            }
        }
        XCTAssertGreaterThan(compared, 200)
    }

    /// Every handComplete's scores land, its lines are the server's words, and my made / set
    /// is exactly my bid (the seat), the neutral hand end for the spectator.
    func testHandCompleteScoresLinesAndSounds() throws {
        let game = try RecordedGame("events-gyb-s19")
        for label in ["seat1-rejoin", "spectator"] {
            let viewer = game.viewer(label)
            var replay = ReducerReplay(viewer: viewer)
            var hands = 0
            for e in game.logs[label]! where !Self.offTable.contains(e.event) {
                let before = replay.effects.count
                try replay.apply(e)
                guard e.event == "handComplete", let hand = try Wire.decode(WirePayload.HandComplete.self, e.data).gyb else { continue }
                hands += 1
                XCTAssertEqual(replay.state.table.gyb.scores, hand.scores)
                let sounds = replay.effects[before...].compactMap { if case .sound(let k) = $0 { return k } else { return nil } }
                if label == "spectator" {
                    XCTAssertEqual(sounds, [.handEnd])
                } else {
                    let mine = try XCTUnwrap(hand.seat(3))
                    XCTAssertEqual(sounds, [mine.took == mine.bid ? .made : .set])
                }
                let lines = replay.state.log.entries.suffix(4).map(\.message)
                XCTAssertEqual(lines.first, "--- HAND COMPLETE ---")
                XCTAssertTrue(lines[3].hasPrefix("ios_ann: Bid \(hand.seat(3)!.bid), Won \(hand.seat(3)!.took)"), lines[3])
            }
            XCTAssertGreaterThan(hands, 8, label)
        }
        // the Forbidden Bid hit: "(Forbidden Bid)", +1
        let hit = GybHand(scores: [34, 58, 14], oldScores: [34, 58, 13],
                          seats: [.init(position: 1, bid: 2, took: 1, points: 0), .init(position: 2, bid: 1, took: 2, points: 0),
                                  .init(position: 3, bid: 3, took: 2, points: 1, forbiddenHit: true)])
        XCTAssertEqual(GybRules.handLines(hit, name: { ["a", "b", "c"][$0 - 1] }).last, "c: Bid 3, Won 2 (Forbidden Bid), +1 → 14")
    }

    /// My bid turn as the dealer on the 5 and the 11 (the human deals both): the sheet's
    /// Forbidden Bid, derived from the two bids before mine, is the server's (doneBidding).
    func testMyForbiddenBidOnMyDealerTurnIsTheServers() throws {
        let game = try RecordedGame("events-gyb-s19")
        let viewer = game.viewer("seat1-rejoin")
        var replay = ReducerReplay(viewer: viewer)
        var found: [Int: GybForbidden] = [:]
        for e in game.logs[viewer.label]! where !Self.offTable.contains(e.event) {
            try replay.apply(e)
            let t = replay.state.table
            if replay.state.myTurn == .choosing(.bid), let deal = t.deal, deal.dealer == 3 {
                found[deal.handSize] = t.gybForbidden
            }
            if e.event == "doneBidding", let deal = t.deal, deal.dealer == 3, let said = found[deal.handSize] {
                XCTAssertEqual(said, try Wire.decode(WirePayload.DoneBidding.self, e.data).gyb?.forbidden, "hand \(deal.handSize)")
            }
        }
        XCTAssertEqual(found[5], GybForbidden(position: 3, bid: 2))
        XCTAssertEqual(found[11], GybForbidden(position: 3, bid: 3))
        // the 2 and 8: none (too small, or already past the hand)
        XCTAssertEqual(found[2] ?? nil, nil)
        XCTAssertEqual(found[8] ?? nil, nil)
    }

    /// The rejoin's carrier: three seats, the order of three, the scores and the Forbidden Bid.
    func testTheRejoinsCarrierRestoresAGybTable() throws {
        let game = try RecordedGame("events-gyb-s19")
        let viewer = game.viewer("seat1-rejoin")
        var replay = ReducerReplay(viewer: viewer)
        let first = try XCTUnwrap(game.logs[viewer.label]!.first { $0.event == "rejoinSuccess" })
        try replay.apply(first)
        let s = replay.state
        XCTAssertTrue(s.table.isGyb)
        XCTAssertEqual(s.table.seats, 3)
        XCTAssertEqual(s.players.seats.keys.sorted(), [1, 2, 3])
        XCTAssertEqual(s.table.phase.bids?.order.count, 3)
        XCTAssertEqual(s.table.gyb.scores, [0, 13, 13])
        XCTAssertEqual(s.table.gyb.forbidden, GybForbidden(position: 1, bid: 5))
        let model = TableRenderModel(s)
        XCTAssertEqual(model.seats, 3)
        XCTAssertEqual(model.opponents.map(\.rel), [.left, .right])
        XCTAssertEqual(model.opponents.map(\.position), [1, 2])
        // no HSI, no /help at such a table
        XCTAssertFalse(AssistRules.canAsk(s))
    }

    func testAPlainSpectatorSeesThreeSeatsRoundTheTable() throws {
        let game = try RecordedGame("events-gyb-s19")
        let viewer = game.viewer("spectator")
        var replay = ReducerReplay(viewer: viewer)
        try replay.apply(try XCTUnwrap(game.logs[viewer.label]!.first { $0.event == "spectatorJoined" }))
        let model = TableRenderModel(replay.state)
        XCTAssertTrue(model.isSpectator)
        XCTAssertEqual(model.opponents.map(\.rel), [.bottom, .left, .right])
    }

    func testATrickOfThreeCompletesAndMyOwnTrickSoundsOurs() {
        var s = Self.dealt(dealer: 3)
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        for (i, pos) in [1, 2, 3].enumerated() {
            TableReducer.reduce(&s, T.ev("bidReceived", ["bid": "1", "position": pos, "seq": 4 + 2 * i]))
            TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": pos % 3 + 1, "seq": 5 + 2 * i]))
        }
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "1", "1"], "lead": 1, "gyb": ["forbidden": NSNull()], "seq": 10]))
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("hearts", "K"), "position": 1, "seq": 11]))
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("hearts", "2"), "position": 2, "seq": 12]))
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("hearts", "3"), "position": 3, "seq": 13]))
        if case .playing(let p) = s.table.phase { XCTAssertNil(p.turn, "three cards: the trick resolves") } else { XCTFail() }
        let fx = TableReducer.reduce(&s, T.ev("trickComplete", ["winner": 1, "seq": 14]))
        XCTAssertTrue(fx.contains(.sound(.trickOurs)))
        XCTAssertEqual(s.log.entries.last?.message, "me won the trick (me 1, L 0, R 0)")
        XCTAssertEqual(SeatPips.all(s)[1]?.won, 1)
        XCTAssertEqual(SeatPips.all(s)[1]?.countsTeam, false)
    }

    func testTheDealerSeesTheForbiddenBidWhileBiddingAndNoHSI() {
        var s = Self.dealt(dealer: 1, size: 6)
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 3]))
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": "2", "position": 2, "bidArray": [NSNull(), "2"], "seq": 4]))
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 3, "seq": 5]))
        XCTAssertNil(s.table.gybForbidden)
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": "1", "position": 3, "bidArray": [NSNull(), "2", "1"], "seq": 6]))
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 7]))
        XCTAssertEqual(s.myTurn, .choosing(.bid))
        XCTAssertEqual(s.table.gybForbidden, GybForbidden(position: 1, bid: 3))
        XCTAssertEqual(s.table.phase.bids?.order, [2, 3, 1])
    }

    @MainActor
    func testTheStoreHidesHSIHelpAndTheTutorialSwitch() {
        let store = GameState()
        let s = Self.dealt(dealer: 1, size: 6)
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        store.apply(.local(.setMode(.gyb)))
        for e in Self.dealEvents(dealer: 1, size: 6) { store.apply(e) }
        XCTAssertTrue(store.isGyb)
        XCTAssertNil(store.myHSIReading)
        XCTAssertFalse(store.showsAssistBarItem)
        XCTAssertFalse(store.showsAssistAsk)
        XCTAssertEqual(store.seatCount, 3)
        XCTAssertEqual(s.table.seats, 3)
        let commands = GameLogPanel.commands(pureSpectator: false, leave: store.leaveOutcome).map(\.command)
        XCTAssertFalse(commands.contains("/help"))
        // three seats known: a leave with only bots left ends the game
        XCTAssertEqual(store.leaveOutcome, .endsGame)
    }

    // MARK: - Screens' models

    func testTheScoreBarHasOneColumnPerPlayerMineFirst() {
        var bids = BidBook.fresh(bidder: 2, seats: 3)
        bids.byPosition = BidBook.padded(["2", nil, "4"])
        let cols = ScoreBarView.soloColumns(viewer: 3, mine: 3, names: [1: "ann", 2: "bob", 3: "cat"], scores: [26, 13, 0],
                                            bids: bids, tricks: [1, 0, 2, 0])
        XCTAssertEqual(cols.map(\.name), ["cat", "ann", "bob"])
        XCTAssertEqual(cols.map(\.score), [0, 26, 13])
        XCTAssertEqual(cols[0].line, "Bid 4 \u{00B7} Won 2")
        XCTAssertEqual(cols[2].line, "Bid - \u{00B7} Won 0")
        XCTAssertEqual(cols[2].spoken, "bob, 13 points, not bid yet, won 0")
        XCTAssertEqual(cols.map(\.mine), [true, false, false])
        // a spectator: seats 1, 2, 3, none mine
        let spectator = ScoreBarView.soloColumns(viewer: nil, mine: nil, names: [:], scores: [0, 0, 0], bids: nil, tricks: [0, 0, 0, 0])
        XCTAssertEqual(spectator.map(\.position), [1, 2, 3])
        XCTAssertEqual(spectator.map(\.mine), [false, false, false])
    }

    func testTheBidChipsAreEachPlayersBidInItsSeatsColour() {
        var bids = BidBook.fresh(bidder: 1, seats: 3)
        bids.byPosition = BidBook.padded(["2", "1", nil])
        let chips = BidChips.solo(bids: bids, handSize: 5, viewer: 2, names: [1: "ann", 2: "bob", 3: "cat"])
        // mine first (bob 1, coral), then cat (0), then ann (2, blue)
        XCTAssertEqual(chips.chips, [.team(2), .team(1), .team(1), .empty, .empty])
        XCTAssertEqual(chips.debugValue, "1+0+2/5")
        XCTAssertEqual(chips.spoken, "Bids: bob 1, cat 0, ann 2, of 5 tricks")
        bids.byPosition = BidBook.padded(["4", "1", "2"])
        let over = BidChips.solo(bids: bids, handSize: 6, viewer: 1, names: [1: "ann", 2: "bob", 3: "cat"])
        XCTAssertEqual(over.overbid, 1)
        XCTAssertEqual(over.chips.last, .over(3))
    }

    func testTheGameEndRowsAreBestFirstWithTiesAndOutcomes() {
        let end = GybEnd(scores: [62, 83, 83], winners: [2, 3], made: [5, 8, 7], hands: 13)
        let rows = GybRules.resultRows(end, name: { ["ann", "bob", "cat"][$0 - 1] }, me: 1)
        XCTAssertEqual(rows.map(\.name), ["bob", "cat", "ann"])
        XCTAssertEqual(rows.map(\.winner), [true, true, false])
        XCTAssertEqual(rows[2].madeText, "Bids made 5 of 13")
        XCTAssertEqual(rows[0].spoken, "bob, 83 points, bids made 8 of 13, winner")
        XCTAssertEqual(GybRules.outcome(end, me: 1), .defeat)
        XCTAssertEqual(GybRules.outcome(end, me: 2), .tie)
        XCTAssertEqual(GybRules.outcome(end, me: nil), .neutral)
        XCTAssertEqual(GybRules.outcome(GybEnd(scores: [1, 0, 0], winners: [1], made: [1, 0, 0], hands: 13), me: 1), .victory)
        XCTAssertEqual(GybRules.winnerLine(end, name: { ["ann", "bob", "cat"][$0 - 1] }), "bob and cat tie!")
        // winners missing from a payload: the top score's seats
        XCTAssertEqual(GybEnd.from(["scores": [3, 9, 9], "made": [0, 1, 1], "hands": 13])?.winners, [2, 3])
    }

    func testGameEndSoundsFollowTheWinners() {
        var s = Self.dealt(dealer: 1)
        let won = GameEndData.from(["score": ["team1": 0, "team2": 0], "gyb": ["scores": [30, 1, 2], "winners": [1], "made": [2, 0, 0], "hands": 13]])
        XCTAssertEqual(TableReducer.gameEndSound(s, won), .gameWon)
        let lost = GameEndData.from(["score": ["team1": 0, "team2": 0], "gyb": ["scores": [1, 30, 2], "winners": [2], "made": [0, 2, 0], "hands": 13]])
        XCTAssertEqual(TableReducer.gameEndSound(s, lost), .gameLost)
        let shared = GameEndData.from(["score": ["team1": 0, "team2": 0], "gyb": ["scores": [30, 30, 2], "winners": [1, 2], "made": [2, 2, 0], "hands": 13]])
        XCTAssertEqual(TableReducer.gameEndSound(s, shared), .gameEnd)
        TableReducer.reduce(&s, T.ev("gameEnd", ["score": ["team1": 0, "team2": 0], "gyb": ["scores": [30, 1, 2], "winners": [1], "made": [2, 0, 0], "hands": 13], "tournamentId": NSNull(), "seq": 3]))
        XCTAssertEqual(s.table.gyb.scores, [30, 1, 2])
        XCTAssertEqual(s.table.gameEndDataGyb, GybEnd(scores: [30, 1, 2], winners: [1], made: [2, 0, 0], hands: 13))
    }

    @MainActor
    func testALobbyOfGetYourBidSeatsThree() {
        let lobby = LobbyState()
        lobby.applyLobby(["lobbyId": "l1", "lobbyName": "Three", "mode": "gyb",
                          "players": [["username": "me", "ready": true]],
                          "members": [["socketId": "s1", "username": "me", "ready": true, "playing": true],
                                      ["socketId": "bot:1", "username": "🤖 Bot", "ready": false, "playing": true, "isBot": true]],
                          "capacity": 8], isBlocked: { _ in false })
        XCTAssertEqual(lobby.mode, .gyb)
        XCTAssertEqual(lobby.seats, 3)
        XCTAssertEqual(LobbyCount(lobby).text, "Ready 1/3")
        XCTAssertEqual(LobbyCount(lobby).spoken, "1 of 3 ready")
        XCTAssertTrue(lobby.canAddBot)
        lobby.applyPlayers(from: ["members": [["socketId": "s1", "username": "me", "ready": true, "playing": true],
                                              ["socketId": "bot:1", "username": "🤖 Bot", "ready": false, "playing": true, "isBot": true],
                                              ["socketId": "bot:2", "username": "🤖 Bot 2", "ready": false, "playing": true, "isBot": true]]],
                           namesHeldSeats: true)
        XCTAssertFalse(lobby.canAddBot, "Add Bot only up to 3")
        // a fourth member watches: the family-lobby rules at 3
        lobby.applyPlayers(from: ["members": [["socketId": "s1", "username": "me", "ready": true, "playing": true],
                                              ["socketId": "bot:1", "username": "🤖 Bot", "ready": false, "playing": true, "isBot": true],
                                              ["socketId": "bot:2", "username": "🤖 Bot 2", "ready": false, "playing": true, "isBot": true],
                                              ["socketId": "s4", "username": "kim", "ready": false, "playing": false]]],
                           namesHeldSeats: true)
        XCTAssertTrue(lobby.tableFull)
        XCTAssertTrue(lobby.tableFullWithout("kim"))
        XCTAssertEqual(LobbySeatStatus.of(lobby.players[3], in: lobby.players, seats: lobby.seats), .willWatch)
        XCTAssertEqual(VoiceCopy.lobbyHint(seats: 3), "The first 3 to tap Ready play; everyone else watches and can talk")
        // a base-game lobby next: the mode goes
        lobby.applyLobby(["lobbyId": "l2", "lobbyName": "Four", "players": []], isBlocked: { _ in false })
        XCTAssertEqual(lobby.mode, .classic)
        XCTAssertEqual(LobbyCount(lobby).text, "Ready 0/4")
    }

    func testTheListsShowAGybLobbyAndATableWithItsScores() {
        let lobby = Lobby.from(["id": "l1", "name": "Three", "playerCount": 1, "maxPlayers": 4, "players": [["username": "ann", "ready": false]],
                                "mode": "gyb", "seats": 3])!
        XCTAssertEqual(lobby.mode, .gyb)
        XCTAssertEqual(lobby.countText, "1/3")
        XCTAssertEqual(lobby.action(for: "bob"), .join)
        let table = Lobby.from(["gameId": "g1", "players": [["position": 1, "username": "ann"], ["position": 2, "username": "bob"], ["position": 3, "username": "cat"]],
                                "currentHand": 5, "score": ["team1": 0, "team2": 0], "spectatorCount": 0, "mode": "gyb", "scores": [26, 13, 0]])!
        XCTAssertEqual(table.name, "ann, bob and cat")
        XCTAssertEqual(table.progress?.soloText, "ann 26 \u{00B7} bob 13 \u{00B7} cat 0")
        XCTAssertNil(table.progress?.teamText(1))
        XCTAssertEqual(table.progress?.spokenSummary, "Hand 5. ann 26, bob 13, cat 0")
        // the base game's card is unchanged
        let four = Lobby.from(["id": "l2", "name": "Four", "playerCount": 2, "maxPlayers": 4, "players": []])!
        XCTAssertEqual(four.mode, .classic)
        XCTAssertEqual(four.countText, "2/4")
    }

    func testTheCapIsSent() {
        XCTAssertTrue(ClientHello.caps.contains("getYourBid"))
        XCTAssertEqual(GameMode.from("gyb"), .gyb)
        XCTAssertEqual(GameMode.from("classic"), .classic)
        XCTAssertEqual(GameMode.from(nil), .classic)
    }

    // MARK: - Helpers

    /// Seat 1 ("me") at a Get Your Bid table with L at 2 and R at 3, dealt `size` cards.
    static func dealt(dealer: Int, size: Int = 3) -> TableState {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "me", playerId: "sid-me")))
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        TableReducer.reduce(&s, .local(.setMode(.gyb)))
        for e in dealEvents(dealer: dealer, size: size) { TableReducer.reduce(&s, e) }
        return s
    }

    static func dealEvents(dealer: Int, size: Int) -> [TableEvent] {
        let ranks = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"]
        return [
            T.ev("positionUpdate", ["positions": [1, 2, 3], "sockets": ["sid-me", "bot:l", "bot:r"],
                                    "usernames": [["username": "me"], ["username": "L"], ["username": "R"]], "pics": [1, 2, 3], "seq": 1]),
            T.ev("gameStart", ["gameId": "g1", "hand": ranks.prefix(size).map { T.card("spades", $0) }, "trump": T.card("diamonds", "5"),
                               "score1": 0, "score2": 0, "dealer": dealer, "position": 1, "currentHand": size, "hsiValues": [String: Double](),
                               "playerInfo": [["position": 1, "username": "me"], ["position": 2, "username": "L"], ["position": 3, "username": "R"]],
                               "gyb": ["scores": [0, 0, 0]], "seq": 2]),
        ]
    }
}

private extension TableSlice {
    var gameEndDataGyb: GybEnd? { if case .ended(let d) = phase { return d.gyb } else { return nil } }
}
