import XCTest
import SpriteKit
@testable import BAB_Online

/// iOS 1.2.2 table parity with the web (state and wording): the idle-seat offer,
/// a refused action's reason, a tied game, the bid-total chips, unknown chat commands.
final class IdleOfferTests: XCTestCase {
    /// Seat 3 ("P") is the human partner of T.dealtState (2 and 4 are bots).
    private func idle(_ s: inout TableState, _ pos: Int = 3, name: String = "P") {
        // private, unsequenced, as seatLifecycle.sendIdleOffer emits it
        TableReducer.reduce(&s, T.ev("resignationAvailable", ["position": pos, "username": name, "idle": true]))
    }

    func testThePayloadReadsIdle() throws {
        func decode(_ d: [String: Any]) throws -> WirePayload.ResignationAvailable {
            try JSONDecoder().decode(WirePayload.ResignationAvailable.self, from: JSONSerialization.data(withJSONObject: d))
        }
        XCTAssertEqual(try decode(["position": 2, "username": "L", "idle": true]).idle, true)
        XCTAssertNil(try decode(["position": 2, "username": "L", "seq": 9]).idle, "the room / replay offer has no idle")
        XCTAssertEqual(try decode(["position": 2, "username": "L", "seq": 9]).seq, 9)
        // through the event decoder, as the handler does
        guard case .success(let ev) = ServerEvent.decode(name: "resignationAvailable", payload: [["position": 3, "username": "P", "idle": true]],
                                                          chatBlocked: false, chatMine: false),
              case .resignationAvailable(let p) = ev.event else { return XCTFail("not decoded") }
        XCTAssertEqual(p, WirePayload.ResignationAvailable(position: 3, username: "P", idle: true, seq: nil))
    }

    func testAnIdleSeatStaysConnected() {
        var s = T.dealtState()
        idle(&s)
        XCTAssertEqual(s.players.seats[3]?.presence, .connected, "the player is here, just slow")
        XCTAssertTrue(s.players.disconnected.isEmpty, "no \"disconnected\" row for an idle seat")
        XCTAssertEqual(s.players.resignationOffer, ResignationOffer(position: 3, username: "P", idle: true))
        let offer = s.players.resignationOffer!
        XCTAssertEqual(offer.title, "P seems idle")
        XCTAssertEqual(offer.question, "Replace with a bot?")
        XCTAssertEqual(offer.spoken, "P seems idle. Replace with a bot?")
    }

    func testTheUsualOfferKeepsItsWordingAndPresence() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": 3, "username": "P", "seq": 3]))
        TableReducer.reduce(&s, T.ev("resignationAvailable", ["position": 3, "username": "P", "seq": 4]))
        XCTAssertEqual(s.players.seats[3]?.presence, .resignable)
        XCTAssertEqual(s.players.disconnected, [3: "P"])
        XCTAssertEqual(s.players.resignationOffer, ResignationOffer(position: 3, username: "P"))
        XCTAssertEqual(s.players.resignationOffer?.title, "P timed out")
    }

    func testIdleForASeatThatIsAwayIsTheUsualOffer() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": 3, "username": "P", "seq": 3]))
        idle(&s)
        XCTAssertEqual(s.players.seats[3]?.presence, .resignable)
        XCTAssertEqual(s.players.resignationOffer?.idle, false)
    }

    func testTheServerWithdrawsItWithPlayerReconnected() {
        var s = T.dealtState()
        idle(&s)
        TableReducer.reduce(&s, T.ev("playerReconnected", ["position": 3, "username": "P", "seq": 3]))
        XCTAssertNil(s.players.resignationOffer)
        XCTAssertEqual(s.players.seats[3]?.presence, .connected)
    }

    func testARealDisconnectDropsTheIdleOffer() {
        var s = T.dealtState()
        idle(&s)
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": 3, "username": "P", "seq": 3]))
        XCTAssertNil(s.players.resignationOffer, "grace, then its own offer, follow")
        XCTAssertEqual(s.players.seats[3]?.presence, .grace)
        // another seat's drop leaves it
        var t = T.dealtState()
        idle(&t)
        TableReducer.reduce(&t, T.ev("playerDisconnected", ["position": 2, "username": "L", "seq": 3]))
        XCTAssertEqual(t.players.resignationOffer?.position, 3)
    }

    /// A snapshot of the same game with the idle seat (`pos`) a connected human on turn.
    private func snapshot(of s: TableState, idleSeat pos: Int, strict: Bool = true, edit: (inout [String: Any]) -> Void = { _ in }) throws -> TableSnapshot {
        var raw = try FixtureLoader.v2Snapshot("trick-mid-lead3")
        ({ (snap: inout [String: Any]) in
            snap["gameId"] = s.table.gameId
            var seats = snap["seats"] as! [[String: Any]]
            for i in seats.indices where seats[i]["position"] as? Int == pos {
                seats[i]["controller"] = "human"; seats[i]["presence"] = "connected"; seats[i]["isBot"] = false; seats[i]["lazy"] = false
                seats[i]["offered"] = false
            }
            snap["seats"] = seats
            var turn = (snap["turn"] as? [String: Any]) ?? [:]
            turn["position"] = pos
            snap["turn"] = turn
            edit(&snap)
        })(&raw)
        return try TableSnapshot.decode(raw, strict: strict)
    }

    /// The server replays an idle offer only to a re-attached socket or at its next 90 s asking,
    /// so a resync (the foreground probe, a seq gap, my own actionRejected) must not lose it.
    func testASnapshotOfTheSameGameKeepsAStandingIdleOffer() throws {
        for source in [SnapshotSource.requested("gap-1"), .rejected] {
            var s = T.dealtState()
            idle(&s); idle(&s)
            let before = try XCTUnwrap(s.players.resignationOffer)
            XCTAssertEqual(before.round, 1)
            TableReducer.reduce(&s, .snapshot(try snapshot(of: s, idleSeat: 3), source, hints: nil))
            XCTAssertEqual(s.players.resignationOffer, before, "\(source): kept, with its round (an answered Wait stays answered)")
            XCTAssertEqual(s.players.seats[3]?.presence, .connected)
        }
    }

    func testASnapshotDropsAnIdleOfferThatNoLongerStands() throws {
        // the turn moved on: the idle player acted
        var s = T.dealtState()
        idle(&s)
        TableReducer.reduce(&s, .snapshot(try snapshot(of: s, idleSeat: 3) { snap in
            var turn = snap["turn"] as! [String: Any]; turn["position"] = 2; snap["turn"] = turn
        }, .requested("gap-1"), hints: nil))
        XCTAssertNil(s.players.resignationOffer, "the seat is no longer on turn")

        // a bot plays the seat now
        s = T.dealtState()
        idle(&s)
        TableReducer.reduce(&s, .snapshot(try snapshot(of: s, idleSeat: 3) { snap in
            var seats = snap["seats"] as! [[String: Any]]
            for i in seats.indices where seats[i]["position"] as? Int == 3 { seats[i]["controller"] = "lazyBot" }
            snap["seats"] = seats
        }, .requested("gap-1"), hints: nil))
        XCTAssertNil(s.players.resignationOffer, "a bot plays the seat")

        // the seat dropped
        s = T.dealtState()
        idle(&s)
        TableReducer.reduce(&s, .snapshot(try snapshot(of: s, idleSeat: 3) { snap in
            var seats = snap["seats"] as! [[String: Any]]
            for i in seats.indices where seats[i]["position"] as? Int == 3 { seats[i]["presence"] = "grace" }
            snap["seats"] = seats
        }, .requested("gap-1"), hints: nil))
        XCTAssertNil(s.players.resignationOffer, "the seat is away: its own offer follows")

        // another game's snapshot
        s = T.dealtState()
        idle(&s)
        TableReducer.reduce(&s, .snapshot(try snapshot(of: s, idleSeat: 3) { $0["gameId"] = "another-game" }, .requested("gap-1"), hints: nil))
        XCTAssertNil(s.players.resignationOffer, "another game")
    }

    /// A presence value this build does not know (a newer server) reads as `.none`: the seat
    /// is still a human's, so its idle offer shows (1.2.1 showed its offer too).
    @MainActor
    func testAnIdleOfferShowsForASeatWithAnUnknownPresence() throws {
        let store = GameState()
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        let snap = try snapshot(of: T.dealtState(), idleSeat: 3, strict: false) { snap in
            var seats = snap["seats"] as! [[String: Any]]
            for i in seats.indices where seats[i]["position"] as? Int == 3 { seats[i]["presence"] = "somethingNewer" }
            snap["seats"] = seats
        }
        store.apply(.snapshot(snap, .rejoin, hints: nil))
        XCTAssertEqual(store.players.seats[3]?.presence, SeatPresence.none)
        store.apply(T.ev("resignationAvailable", ["position": 3, "username": "P", "idle": true]))
        XCTAssertEqual(store.resignationOffer?.idle, true)
        XCTAssertTrue(store.showsPresenceBanner)
    }

    func testEachAskingIsANewRound() {
        var s = T.dealtState()
        idle(&s)
        XCTAssertEqual(s.players.resignationOffer?.round, 0)
        idle(&s)
        XCTAssertEqual(s.players.resignationOffer?.round, 1, "the server asks again while the seat stays idle")
        idle(&s, 4, name: "R")
        XCTAssertEqual(s.players.resignationOffer, ResignationOffer(position: 4, username: "R", idle: true), "another seat starts over")
    }

    @MainActor
    func testTheStoreShowsItAndWaitHidesItUntilTheNextAsking() {
        let store = GameState()
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        for e in [T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "s2", "s3", "s4"],
                                          "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]],
                                          "pics": [1, 2, 3, 4], "seq": 1]),
                  T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("diamonds", "5"), "score1": 0,
                                     "score2": 0, "dealer": 4, "position": 1, "currentHand": 1, "seq": 2])] {
            store.apply(e)
        }
        XCTAssertFalse(store.showsPresenceBanner)
        store.apply(T.ev("resignationAvailable", ["position": 2, "username": "L", "idle": true]))
        XCTAssertEqual(store.resignationOffer?.idle, true)
        XCTAssertTrue(store.showsPresenceBanner, "the banner shows the offer with nobody disconnected")
        XCTAssertTrue(store.disconnectedPlayers.isEmpty)
        XCTAssertEqual(store.resignationAvailable?.position, 2)

        store.waitOnOffer()
        XCTAssertNil(store.resignationOffer, "Wait: gone until the server asks again")
        XCTAssertFalse(store.showsPresenceBanner)
        store.apply(T.ev("resignationAvailable", ["position": 2, "username": "L", "idle": true]))
        XCTAssertEqual(store.resignationOffer?.round, 1)
        XCTAssertTrue(store.showsPresenceBanner)

        // the idle player acted: playerReconnected withdraws it
        store.apply(T.ev("playerReconnected", ["position": 2, "username": "L", "seq": 3]))
        XCTAssertNil(store.resignationOffer)
        XCTAssertFalse(store.showsPresenceBanner)
        // a withdrawn offer forgets the Wait: the next first asking shows
        store.apply(T.ev("resignationAvailable", ["position": 2, "username": "L", "idle": true]))
        store.waitOnOffer()
        store.apply(T.ev("playerReconnected", ["position": 2, "username": "L", "seq": 4]))
        XCTAssertNil(store.waitedOffer)
        store.apply(T.ev("resignationAvailable", ["position": 2, "username": "L", "idle": true]))
        XCTAssertEqual(store.resignationOffer?.round, 0)
        XCTAssertTrue(store.showsPresenceBanner)
    }

    @MainActor
    func testAnIdleOfferForALazySeatIsNotShown() {
        let store = GameState()
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "s2", "s3", "s4"],
                                            "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]],
                                            "pics": [1, 2, 3, 4], "seq": 1]))
        store.apply(T.ev("resignationAvailable", ["position": 2, "username": "L", "idle": true]))
        XCTAssertNotNil(store.resignationOffer)
        store.apply(T.ev("playerLazyMode", ["position": 2, "botUsername": "🤖 Bo", "botPic": 4, "originalUsername": "L", "seq": 2]))
        XCTAssertNil(store.resignationOffer, "a bot plays the seat: nothing to replace")
    }
}

final class RejectedActionTests: XCTestCase {
    func testTheWebsWording() {
        XCTAssertEqual(RejectReason.message("not_your_turn"), "Not your turn")
        XCTAssertEqual(RejectReason.message("illegal_card"), "That card can't be played now")
        XCTAssertEqual(RejectReason.message("invalid_play"), "That card can't be played")
        XCTAssertEqual(RejectReason.message("already_played"), "You already played this trick")
        XCTAssertEqual(RejectReason.message("already_bid"), "You already bid")
        XCTAssertEqual(RejectReason.message("invalid_bid"), "That bid isn't allowed")
        XCTAssertEqual(RejectReason.message("something_new"), "Action not accepted")
        XCTAssertEqual(RejectReason.message(nil), "Action not accepted")
    }

    func testEveryContractReasonHasWords() throws {
        // contract/src/s2c.js actionRejected.reason
        for reason in ["not_your_turn", "already_bid", "invalid_bid", "invalid_play", "already_played", "illegal_card"] {
            XCTAssertNotEqual(RejectReason.message(reason), RejectReason.fallback, reason)
        }
    }

    func testARejectionSaysWhy() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 3]))
        TableReducer.reduce(&s, .local(.submitPlay(T.c("spades", "A"), reqId: 7)))
        XCTAssertNotNil(s.pending)
        let fx = TableReducer.reduce(&s, T.ev("actionRejected", ["action": "play", "reason": "not_your_turn"]))
        XCTAssertNil(s.pending, "the card goes back")
        XCTAssertTrue(fx.contains(.notice("Not your turn")), "\(fx)")
        XCTAssertTrue(fx.contains(.haptic(.error)))
    }

    func testARejectionWithNothingPendingStillSaysWhy() {
        var s = T.dealtState()
        let fx = TableReducer.reduce(&s, T.ev("actionRejected", ["action": "bid", "reason": "already_bid"]))
        XCTAssertTrue(fx.contains(.notice("You already bid")))
        XCTAssertFalse(fx.contains(.haptic(.error)))
    }

    @MainActor
    func testTheStorePublishesEachNotice() {
        let store = GameState()
        XCTAssertNil(store.notice)
        store.apply(T.ev("actionRejected", ["action": "play", "reason": "illegal_card"]))
        XCTAssertEqual(store.notice?.text, "That card can't be played now")
        let first = store.notice!.id
        store.apply(T.ev("actionRejected", ["action": "play", "reason": "illegal_card"]))
        XCTAssertNotEqual(store.notice?.id, first, "the same reason twice shows twice")
        // the table's own notices (a tap on a dimmed card) go the same way
        store.postNotice("Not your turn.")
        XCTAssertEqual(store.notice?.text, "Not your turn.")
        store.reset()
        XCTAssertNil(store.notice)
    }
}

/// Why a dimmed card cannot be played (the web's GameScene.illegalReason): the toast a tap
/// on it shows, and its VoiceOver hint.
final class BlockedCardTests: XCTestCase {
    typealias B = TableRenderModel.Blocked

    func testWhileBiddingEveryCardSaysBidFirstUnlessItIsMyBid() {
        var s = T.dealtState()
        var hand = TableRenderModel(s).hand!
        XCTAssertTrue(hand.legalIds.isEmpty)
        XCTAssertEqual(Set(hand.blocked.values), [B.bidFirst])
        XCTAssertEqual(Set(hand.blocked.keys), Set(hand.cards.map(\.id)))
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 3]))
        XCTAssertEqual(Set(TableRenderModel(s).hand!.blocked.values), [B.bidFirst], "another seat's bid")
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 4]))
        hand = TableRenderModel(s).hand!
        XCTAssertEqual(hand.blocked, [:], "my bid turn: the cards are lit")
        XCTAssertEqual(hand.legalIds.count, 3)
    }

    func testAnotherSeatsTurnSaysNotYourTurn() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 2, "seq": 3]))
        let hand = TableRenderModel(s).hand!
        XCTAssertEqual(Set(hand.blocked.values), [B.notYourTurn])
    }

    func testMyTurnGivesEachDimmedCardItsRule() {
        // spades led, I hold a spade: the others must follow suit
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 4, "seq": 3]))
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", "3"), "position": 4, "trump": false, "seq": 4]))
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 5]))
        let hand = TableRenderModel(s).hand!
        XCTAssertTrue(hand.interactive)
        XCTAssertEqual(hand.legalIds.count, 1)
        XCTAssertEqual(hand.blocked.count, 2)
        XCTAssertEqual(Set(hand.blocked.values), ["Must follow suit."])
        XCTAssertTrue(Set(hand.blocked.keys).isDisjoint(with: hand.legalIds))

        // leading with trump unbroken: a trump says so
        var t = T.dealtState(hand: [T.card("diamonds", "9"), T.card("hearts", "2")], size: 2)
        TableReducer.reduce(&t, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 3]))
        let lead = TableRenderModel(t).hand!
        XCTAssertEqual(Array(lead.blocked.values), ["Cannot lead trump until trump is broken."])
    }

    func testMySubmittedCardSaysItIsOnItsWay() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 3]))
        let card = TableRenderModel(s).hand!.cards[0]
        TableReducer.reduce(&s, .local(.submitPlay(card, reqId: 7)))
        let hand = TableRenderModel(s).hand!
        XCTAssertEqual(hand.cards.count, 2)
        XCTAssertEqual(Set(hand.blocked.values), [B.onItsWay])
    }

    /// The scene: a dimmed card carries its reason as VoiceOver's hint, and a tap on it posts
    /// the reason as a table notice (the toast) instead of only buzzing.
    @MainActor
    func testATapOnADimmedCardSaysWhy() throws {
        OpponentHandNode.avatarLoader = StubAvatarLoader()
        let h = ReplayHarness()
        h.store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        for e in [T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "s2", "s3", "s4"],
                                          "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]],
                                          "pics": [1, 2, 3, 4], "seq": 1]),
                  T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A"), T.card("hearts", "2")], "trump": T.card("diamonds", "5"),
                                     "score1": 0, "score2": 0, "dealer": 4, "position": 1, "currentHand": 2, "seq": 2]),
                  T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 2, "seq": 3])] {
            h.store.apply(e)
        }
        let size = CGSize(width: 390, height: 844)
        let scene = GameSKScene(size: size)
        scene.animator = InstantAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: size)))
        let sprite = try XCTUnwrap(scene.cardManager.handNode.sprite(for: h.store.state.table.hand[0].id))
        XCTAssertFalse(sprite.isLegal)
        XCTAssertEqual(sprite.blockedReason, B.notYourTurn)
        XCTAssertEqual(sprite.accessibilityHint, B.notYourTurn)
        XCTAssertNil(h.store.notice)
        XCTAssertTrue(sprite.accessibilityActivate())
        XCTAssertEqual(h.store.notice?.text, B.notYourTurn, "the toast says why")
        XCTAssertNil(h.store.state.pending, "nothing was played")

        // my turn: a legal card has no hint and its tap lifts it, without a notice
        h.store.apply(T.ev("cardPlayed", ["card": T.card("clubs", "3"), "position": 2, "trump": false, "seq": 4]))
        h.store.apply(T.ev("cardPlayed", ["card": T.card("clubs", "4"), "position": 3, "trump": false, "seq": 5]))
        h.store.apply(T.ev("cardPlayed", ["card": T.card("clubs", "5"), "position": 4, "trump": false, "seq": 6]))
        h.store.apply(T.ev("updateTurn", ["currentTurn": 1, "seq": 7]))
        let lit = try XCTUnwrap(scene.cardManager.handNode.sprite(for: h.store.state.table.hand[0].id))
        XCTAssertTrue(lit.isLegal)
        XCTAssertNil(lit.accessibilityHint)
        let before = h.store.notice?.id
        XCTAssertTrue(lit.accessibilityActivate())
        XCTAssertEqual(h.store.notice?.id, before)
    }
}

final class TieGameTests: XCTestCase {
    func testEqualScoresHaveNoWinner() {
        let tie = GameEndData.from(["score": ["team1": 250, "team2": 250]])!
        XCTAssertEqual(tie.winningTeam, 0)
        XCTAssertTrue(tie.isTie)
        let zero = GameEndData.from(["score": ["team1": 0, "team2": 0]])!
        XCTAssertTrue(zero.isTie)
    }

    func testAWinnerIsStillDerivedFromTheScores() {
        let one = GameEndData.from(["score": ["team1": 251, "team2": 250]])!
        XCTAssertEqual(one.winningTeam, 1)
        XCTAssertFalse(one.isTie)
        let two = GameEndData.from(["score": ["team1": -40, "team2": 12]])!
        XCTAssertEqual(two.winningTeam, 2)
        XCTAssertFalse(two.isTie)
    }
}

final class BidChipsTests: XCTestCase {
    private func book(_ bids: [String?]) -> BidBook {
        var b = BidBook()
        b.byPosition = bids
        return b
    }

    func testOneChipPerTrickMyTeamFirst() {
        // seat 1 views: team 1 = seats 1 and 3
        let c = BidChips(bids: book(["2", "1", nil, nil]), handSize: 5, viewPosition: 1, names: names(1))
        XCTAssertEqual(c.mine, 2)
        XCTAssertEqual(c.theirs, 1)
        XCTAssertEqual(c.chips, [.team(1), .team(1), .team(2), .empty, .empty])
        XCTAssertEqual(c.overbid, 0)
        XCTAssertEqual(c.spoken, "Bids: ann and cat 2, bob and dan 1, of 5 tricks")
    }

    func testFromTheOtherTeamsSeat() {
        let c = BidChips(bids: book(["2", "1", nil, nil]), handSize: 5, viewPosition: 2, names: names(2))
        XCTAssertEqual(c.chips, [.team(2), .team(1), .team(1), .empty, .empty], "my team's chips lead, in its own colour")
        XCTAssertEqual(c.spoken, "Bids: bob and dan 1, cat and ann 2, of 5 tricks", "my side's names first")
    }

    /// The score bar's sides for seat `pos` (ann, bob, cat, dan in seats 1-4).
    private func names(_ pos: Int) -> (team: ScoreBarView.SideNames?, opp: ScoreBarView.SideNames?) {
        ScoreBarView.viewerTeams(position: pos, spectator: false, usernames: [1: "ann", 2: "bob", 3: "cat", 4: "dan"])
    }

    func testNoBidsYet() {
        let c = BidChips(bids: book([nil, nil, nil, nil]), handSize: 3, viewPosition: 1, names: names(1))
        XCTAssertEqual(c.chips, [.empty, .empty, .empty])
        XCTAssertEqual(c.spoken, "Bids: ann and cat 0, bob and dan 0, of 3 tricks")
    }

    func testAnOverbidAddsOutlinedChips() {
        let c = BidChips(bids: book(["3", "2", "1", nil]), handSize: 4, viewPosition: 1, names: names(1))
        XCTAssertEqual(c.total, 6)
        XCTAssertEqual(c.overbid, 2)
        XCTAssertEqual(c.chips, [.team(1), .team(1), .team(1), .team(1), .over(2), .over(2)])
        XCTAssertEqual(c.spoken, "Bids: ann and cat 4, bob and dan 2, of 4 tricks. Over by 2")
    }

    func testABoreIsTheWholeHandAndTheRowStopsAtSixteen() {
        // each team capped at the hand: 13 + 13 = 26 bid, 16 chips at most (the web's cap)
        let c = BidChips(bids: book(["B", "2B", "5", "6"]), handSize: 13, viewPosition: 1)
        XCTAssertEqual(c.mine, 13)
        XCTAssertEqual(c.theirs, 13)
        XCTAssertEqual(c.chips.count, BidChips.maxChips)
        XCTAssertEqual(Array(c.chips.prefix(13)), Array(repeating: .team(1), count: 13))
        XCTAssertEqual(Array(c.chips.suffix(3)), Array(repeating: .over(2), count: 3))
    }

    func testOneTrickHand() {
        let c = BidChips(bids: book(["1", nil, nil, nil]), handSize: 1, viewPosition: 1)
        XCTAssertEqual(c.chips, [.team(1)])
        XCTAssertEqual(c.spoken, "Bids: 1 of 1 trick", "names not known: only the total, never a side")
    }
}

final class ChatCommandTests: XCTestCase {
    private let seat = ["/lazy", "/active", "/leave"]

    func testACommandOrItsUniquePrefixIsSent() {
        XCTAssertEqual(ChatCommand.resolve("/lazy", commands: seat), .send("/lazy"))
        XCTAssertEqual(ChatCommand.resolve("/a", commands: seat), .send("/active"))
        XCTAssertEqual(ChatCommand.resolve("/LEAVE ", commands: seat), .send("/leave"))
        XCTAssertEqual(ChatCommand.resolve("/le", commands: seat), .send("/leave"))
    }

    func testAnythingElseIsUnknownAndNamesItsFirstWord() {
        XCTAssertEqual(ChatCommand.resolve("/l", commands: seat), .unknown("/l"), "ambiguous: /lazy or /leave")
        XCTAssertEqual(ChatCommand.resolve("/shrug", commands: seat), .unknown("/shrug"))
        XCTAssertEqual(ChatCommand.resolve("/lazy now", commands: seat), .unknown("/lazy"))
        XCTAssertEqual(ChatCommand.resolve("/", commands: seat), .unknown("/"))
        XCTAssertEqual(ChatCommand.resolve("/", commands: ["/leave"]), .unknown("/"), "a bare slash is never a command")
    }

    func testASpectatorHasOnlyLeave() {
        XCTAssertEqual(ChatCommand.resolve("/l", commands: ["/leave"]), .send("/leave"))
        XCTAssertEqual(ChatCommand.resolve("/lazy", commands: ["/leave"]), .unknown("/lazy"), "the server ignores a spectator's /lazy")
    }

    /// The server takes `/active` from a spectator recorded as a seat's owner (chatHandlers
    /// spectatorCommand), though a spectator's list shows only /leave: typed in full, it is sent.
    func testASpectatorsActiveIsSent() {
        XCTAssertEqual(ChatCommand.resolve("/active", commands: ["/leave"]), .send("/active"))
        XCTAssertEqual(ChatCommand.resolve(" /Active ", commands: ["/leave"]), .send("/active"))
        XCTAssertEqual(ChatCommand.resolve("/a", commands: ["/leave"]), .unknown("/a"), "only in full: the list has no /active to complete")
    }

    func testADraftWithALeadingSpaceIsStillACommand() {
        XCTAssertEqual(ChatCommand.resolve(" /foo", commands: seat), .unknown("/foo"))
        XCTAssertEqual(ChatCommand.resolve("  /lazy", commands: seat), .send("/lazy"))
    }
}
