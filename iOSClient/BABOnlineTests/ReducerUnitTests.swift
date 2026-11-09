import XCTest
@testable import BAB_Online

final class ReducerUnitTests: XCTestCase {
    private func bid(_ s: inout TableState, _ pos: Int, _ bid: Any, array: [Any], seq: Int) {
        TableReducer.reduce(&s, T.ev("bidReceived", ["bid": bid, "position": pos, "bidArray": array, "seq": seq]))
    }

    func testDealDerivesHandNoBidderAndOrder() {
        let s = T.dealtState(size: 3, dealer: 4)
        XCTAssertEqual(s.table.deal?.handNo, 8, "HAND_SEQUENCE: 3 cards is the 8th hand")
        XCTAssertEqual(s.table.deal?.bidder, 1)
        XCTAssertEqual(s.table.deal?.dealSeq, 1)
        XCTAssertEqual(s.table.phase.bids?.order, [1, 2, 3, 4])
        XCTAssertEqual(HandSequence.handNo(forSize: 12), 1)
        XCTAssertEqual(HandSequence.handNo(forSize: 13), 13)
        XCTAssertEqual(s.players.seats.values.map(\.cardsInHand), [3, 3, 3, 3])
        XCTAssertEqual(s.players.seats[2]?.controller, .bot)
        XCTAssertEqual(s.table.viewer.role, .seat)
    }

    func testRedealClearsBidsAndTempBids() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        bid(&s, 1, 0, array: ["0"], seq: 4)
        bid(&s, 2, "0", array: ["0", "0"], seq: 5)
        XCTAssertEqual(s.table.phase.bids?.tempBids, ["0", "0"])
        TableReducer.reduce(&s, T.ev("destroyHands", ["seq": 6]))
        XCTAssertEqual(s.table.hand, [])
        TableReducer.reduce(&s, T.ev("gameStart", ["hand": [T.card("spades", "2")], "trump": T.card("clubs", "3"), "dealer": 1, "position": 1,
                                                   "currentHand": 3, "score1": 0, "score2": 0, "seq": 7]))
        XCTAssertEqual(s.table.phase.bids?.tempBids, [])
        XCTAssertEqual(s.table.phase.bids?.byPosition, [nil, nil, nil, nil])
        XCTAssertEqual(s.table.deal?.dealSeq, 2, "a redeal is a new deal")
        XCTAssertEqual(s.table.deal?.bidder, 2)
    }

    func testMultsFromBidsAndFromDoneBidding() {
        var s = T.dealtState()
        bid(&s, 1, "B", array: ["B"], seq: 3)
        XCTAssertEqual(s.table.phase.bids?.mults, TeamPair(team1: 2, team2: 1))
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["B", "2B", "0", "1"], "lead": 1, "teamBids": ["team1": 0, "team2": 1],
                                                      "mults": ["team1": 2, "team2": 4], "seq": 4]))
        XCTAssertEqual(s.table.phase.bids?.mults, TeamPair(team1: 2, team2: 4))
        XCTAssertEqual(s.table.phase.bids?.teamBids, TeamPair(team1: 0, team2: 1))
        XCTAssertEqual(s.table.phase.turn, 1)
        XCTAssertEqual(s.myTurn, .choosing(.play))
    }

    func testHandCompleteLeavesNoBidOverlayWindow() {
        var s = T.dealtState(hand: [T.card("spades", "A")], size: 1)
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 3]))
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", "A"), "position": 1, "trump": false, "seq": 4]))
        for (i, p) in [2, 3, 4].enumerated() {
            TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", String(i + 2)), "position": p, "trump": false, "seq": 5 + i]))
        }
        XCTAssertNil(s.table.phase.turn, "no turn while the full trick is shown")
        TableReducer.reduce(&s, T.ev("trickComplete", ["winner": 1, "seq": 8]))
        XCTAssertEqual(s.table.phase.kind, .handResolving)
        TableReducer.reduce(&s, T.ev("handComplete", ["score": ["team1": 11, "team2": -10], "team1Tricks": 1, "team2Tricks": 0,
                                                       "team1OldScore": 0, "team2OldScore": 0, "seq": 9]))
        XCTAssertEqual(s.table.phase.kind, .handResolving)
        XCTAssertFalse(s.table.phase.isBidding)
        XCTAssertEqual(s.myTurn, .waiting)
        XCTAssertEqual(s.scores.score, TeamPair(team1: 11, team2: -10))
        XCTAssertEqual(s.scores.tricks, TeamPair(team1: 1, team2: 0), "trick counts stay until the next deal")
    }

    func testContextRules() {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "me", playerId: nil)))
        TableReducer.reduce(&s, .local(.enterLobby(lobbyId: "lobby-1")))
        XCTAssertEqual(s.table.gameId, "lobby-1")
        s.log.entries.append(ChatMessage(username: "x", message: "stale"))
        TableReducer.reduce(&s, T.ev("allPlayersReady", ["gameId": "game-1"]))
        XCTAssertEqual(s.table.gameId, "game-1")
        XCTAssertEqual(s.table.phase, .waiting)
        XCTAssertEqual(s.log.entries, [], "lobbyId then allPlayersReady resets")
        XCTAssertEqual(s.table.me.username, "me")
        // tournament: the assignment first, then allPlayersReady with the same id keeps tournamentId
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "game-2", tournamentId: "t-1")))
        TableReducer.reduce(&s, T.ev("allPlayersReady", ["gameId": "game-2"]))
        XCTAssertEqual(s.table.tournamentId, "t-1")
        XCTAssertEqual(s.table.gameId, "game-2")
    }

    func testStartDrawClearsResults() {
        var s = TableState()
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g", tournamentId: nil)))
        TableReducer.reduce(&s, T.ev("startDraw", ["start": true, "seq": 1]))
        TableReducer.reduce(&s, T.ev("playerDrew", ["username": "a", "card": T.card("spades", "2"), "drawOrder": 1, "seq": 2]))
        TableReducer.reduce(&s, T.ev("playerDrew", ["username": "a", "card": T.card("spades", "3"), "drawOrder": 1, "seq": 3]))
        XCTAssertEqual(s.table.phase.draw?.results.count, 1, "upsert by drawOrder")
        TableReducer.reduce(&s, T.ev("startDraw", ["start": true, "seq": 4]))
        XCTAssertEqual(s.table.phase.draw?.results, [])
    }

    func testNullPositionDisconnectIsIgnored() {
        var s = T.dealtState()
        let before = s.players
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": NSNull(), "username": "x", "seq": 3]))
        XCTAssertEqual(s.players, before)
        XCTAssertEqual(s.sync.lastSeq, 3, "the seq still advances")
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": 3, "username": "P", "seq": 4]))
        XCTAssertEqual(s.players.disconnected, [3: "P"])
        TableReducer.reduce(&s, T.ev("playerReconnected", ["position": 3, "username": "P", "seq": 5]))
        XCTAssertEqual(s.players.disconnected, [:])
    }

    func testLazyOwnersOwnCardPlayedRemovesTheCard() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("playerLazyMode", ["position": 1, "botUsername": "Bot", "botPic": 5, "originalUsername": "me", "seq": 3]))
        XCTAssertEqual(s.table.viewer.role, .lazyWatcher)
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 4]))
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("hearts", "2"), "position": 1, "trump": false, "seq": 5]))
        XCTAssertFalse(s.table.hand.contains(Card(suit: .hearts, rank: .two)))
        TableReducer.reduce(&s, T.ev("playerActiveMode", ["position": 1, "username": "me", "pic": 1, "seq": 6]))
        XCTAssertEqual(s.table.viewer.role, .seat)
        XCTAssertEqual(s.players.seats[1]?.controller, .human)
    }

    func testChatSpectatorFlagAndUnread() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("chatMessage", ["username": "fan", "message": "hi", "position": NSNull(), "isSpectator": true, "type": "player", "seq": 3]))
        XCTAssertEqual(s.log.entries.last?.type, .spectator, "isSpectator wins over type")
        XCTAssertEqual(s.log.unread, 1)
        let fx = TableReducer.reduce(&s, T.ev("chatMessage", ["username": "me", "message": "yo", "position": 1, "type": "player", "seq": 4], mine: true))
        XCTAssertEqual(s.log.unread, 1, "my own line is never unread")
        XCTAssertEqual(fx.animations, [.chatBubble(position: 1, message: "yo")])
        TableReducer.reduce(&s, .local(.chatRead))
        XCTAssertEqual(s.log.unread, 0)
    }

    func testGoldenLogStrings() {
        var s = T.dealtState(hand: [T.card("spades", "A")], size: 1, dealer: 4, trump: T.card("hearts", "Q"))
        XCTAssertEqual(s.log.entries.last?.message, "Hand 1 — Trump: Q\u{2665}")
        bid(&s, 1, 1, array: ["1"], seq: 3)
        XCTAssertEqual(s.log.entries.last?.message, "me bid 1")
        bid(&s, 2, "B", array: ["1", "B"], seq: 4)
        bid(&s, 3, "0", array: ["1", "B", "0"], seq: 5)
        bid(&s, 4, "0", array: ["1", "B", "0", "0"], seq: 6)
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "B", "0", "0"], "lead": 1, "seq": 7]))
        XCTAssertEqual(s.log.entries.last?.message, "Bidding complete — Your team: 1/0, Opponents: B/0")
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", "A"), "position": 1, "trump": false, "seq": 8]))
        for (i, p) in [2, 3, 4].enumerated() {
            TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", String(i + 2)), "position": p, "trump": false, "seq": 9 + i]))
        }
        TableReducer.reduce(&s, T.ev("trickComplete", ["winner": 1, "seq": 12]))
        XCTAssertEqual(s.log.entries.last?.message, "me won the trick (1-0)")
        TableReducer.reduce(&s, T.ev("rainbow", ["position": 3, "seq": 13]))
        TableReducer.reduce(&s, T.ev("handComplete", ["score": ["team1": 21, "team2": 0], "team1Tricks": 1, "team2Tricks": 0,
                                                       "team1OldScore": 0, "team2OldScore": 20, "seq": 14]))
        let last3 = s.log.entries.suffix(3).map(\.message)
        XCTAssertEqual(last3, [
            "--- HAND COMPLETE ---",
            "me/P: Bid 1/0, Won 1, +21 → 21 (rainbow +10)",
            "L/R: Bid B/0, Won 0, -20 → 0 (2x)",
        ])
    }

    func testOverTrumpDetection() {
        let trump = Card(suit: .hearts, rank: .queen)
        let t = [PlayedCard(card: Card(suit: .clubs, rank: .two), position: 1),
                 PlayedCard(card: Card(suit: .hearts, rank: .three), position: 2),
                 PlayedCard(card: Card(suit: .hearts, rank: .king), position: 3)]
        XCTAssertTrue(TrickRules.isOverTrump(trick: t, trump: trump))
        XCTAssertFalse(TrickRules.isOverTrump(trick: Array(t.prefix(2)), trump: trump))
    }
}
