import XCTest
@testable import BAB_Online

/// The scorecard (owner 2026-11-27; State/Table/Scorecard.swift, the web's state/scorecard.js):
/// the server's rows read leniently from every carrier, the columns by pair (mine first) or by
/// player, each cell's colour role, the ledger (the hand's points above the total, none on the
/// first hand), the hand in play with bids only, one VoiceOver sentence per row, and every
/// recorded game's rows adding up to its final score.
final class ScorecardTests: XCTestCase {
    private let names: [Int: String] = [1: "ivy", 2: "kim", 3: "hal", 4: "jon"]
    private func name(_ p: Int) -> String { names[p] ?? "" }
    private func c(_ s: String, _ r: String = "7") -> Card { T.c(s, r) }

    /// The approved mockup's rows (ivy 1 & hal 3 vs kim 2 & jon 4).
    private lazy var rows: [ScorecardRow] = [
        ScorecardRow(handNo: 1, handSize: 12, trump: c("hearts"), dealer: 2, bids: ["3", "2", "2", "1"], took: [3, 3, 3, 3],
                     points: [51, 33], scores: [51, 33], faults: [], set: [false, false]),
        ScorecardRow(handNo: 2, handSize: 10, trump: c("spades"), dealer: 3, bids: ["2", "3", "2", "2"], took: [3, 1, 2, 2],
                     points: [41, -50], scores: [92, -17], faults: [2], set: [false, true]),
        ScorecardRow(handNo: 5, handSize: 4, trump: c("hearts"), dealer: 2, bids: ["B", "0", "0", "0"], took: [4, 0, 0, 0],
                     points: [80, 0], scores: [162, 47], faults: [], set: [false, false]),
        ScorecardRow(handNo: 9, handSize: 5, trump: c("diamonds"), dealer: 4, bids: ["1", "2B", "0", "0"], took: [1, 4, 0, 0],
                     points: [10, -200], scores: [182, -143], faults: [], set: [false, true]),
    ]

    private func rowDict(_ handNo: Int = 1) -> [String: Any] {
        ["handNo": handNo, "handSize": 12, "trump": T.card("hearts", "9"), "dealer": 2, "bids": ["3", "2", "2", "1"],
         "took": [3, 3, 3, 3], "points": [51, 33], "scores": [51, 33], "faults": [Int](), "set": [false, false]]
    }

    // MARK: - Wire and store

    func testHandCompletesRowIsReadAndABadOneIsDropped() throws {
        var s = T.dealtState()
        XCTAssertNil(s.table.scorecard, "no scorecardRows on the deal: an older server, no scorecard")
        TableReducer.reduce(&s, T.ev("handComplete", ["score": ["team1": 51, "team2": 33], "team1Tricks": 6, "team2Tricks": 6,
                                                      "team1OldScore": 0, "team2OldScore": 0, "seq": 3, "scorecardRow": rowDict()]))
        XCTAssertEqual(s.table.scorecard?.count, 1)
        XCTAssertEqual(s.table.scorecard?.first?.points, [51, 33])
        TableReducer.reduce(&s, T.ev("handComplete", ["score": ["team1": 51, "team2": 33], "team1Tricks": 6, "team2Tricks": 6,
                                                      "team1OldScore": 0, "team2OldScore": 0, "seq": 4,
                                                      "scorecardRow": ["handNo": "x", "bids": 3]]))
        XCTAssertEqual(s.table.scorecard?.count, 1, "a malformed row is dropped, never a failed event")
    }

    func testTheDealSaysTheServerKeepsOneAndAnotherGameStartsANewCard() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("clubs", "2"),
                                                   "score1": 0, "score2": 0, "dealer": 1, "position": 1, "currentHand": 10,
                                                   "seq": 3, "scorecardRows": 0]))
        XCTAssertEqual(s.table.scorecard, [])
        s.table.scorecard = rows
        TableReducer.reduce(&s, T.ev("gameStart", ["gameId": "g2", "hand": [T.card("spades", "A")], "trump": T.card("clubs", "2"),
                                                   "score1": 0, "score2": 0, "dealer": 1, "position": 1, "currentHand": 12,
                                                   "seq": 4, "scorecardRows": 0]))
        XCTAssertEqual(s.table.scorecard, [], "another game's deal: a new card")
    }

    func testTheSnapshotCarriesTheRowsAndOneWithoutKeepsThisGames() throws {
        let snap = try T.snapshot("trick-mid-lead3") { raw in raw["scorecard"] = [self.rowDict(1)] }
        var s = TableState()
        TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))
        XCTAssertEqual(s.table.scorecard?.map(\.handNo), [1])
        let without = try T.snapshot("trick-mid-lead3") { raw in raw.removeValue(forKey: "scorecard") }
        TableReducer.reduce(&s, .snapshot(without, .requested("x"), hints: nil))
        XCTAssertEqual(s.table.scorecard?.map(\.handNo), [1], "the same game keeps its card")
    }

    func testGameEndBringsEveryRowAndAnOlderServerNone() {
        let data = GameEndData.from(["score": ["team1": 182, "team2": -143], "scorecard": [rowDict(1), rowDict(2), ["bad": true]]])
        XCTAssertEqual(data?.scorecard?.map(\.handNo), [1, 2])
        XCTAssertNil(GameEndData.from(["score": ["team1": 1, "team2": 0]])?.scorecard)
        XCTAssertNil(GameEndData.from(["score": ["team1": 1, "team2": 0], "handHistory": [["x": 1]]])?.scorecard,
                     "the reserved handHistory is not the scorecard")
    }

    // MARK: - The model

    func testColumnsMinePairFirstInTeamColoursNeverATeamNumber() {
        let seat = Scorecard.columns(solo: false, me: 2, name: name)
        XCTAssertEqual(seat.players.map(\.position), [2, 4, 3, 1])
        XCTAssertEqual(seat.pairs.map(\.label), ["kim & jon", "hal & ivy"])
        XCTAssertEqual(seat.pairs.map(\.colour), [2, 1], "the score bar's colours: seats 1 and 3 team 1")
        XCTAssertEqual(seat.scores.map(\.index), [1, 0])
        let spectator = Scorecard.columns(solo: false, me: nil, name: name)
        XCTAssertEqual(spectator.players.map(\.position), [1, 3, 2, 4])
        XCTAssertEqual(spectator.pairs.map(\.label), ["ivy & hal", "kim & jon"])
        let all = Scorecard.model(rows: rows, solo: false, me: nil, name: name)
        let words = (all.pairs.map(\.label) + all.scoreColumns.map(\.label) + all.rows.map(\.spoken)).joined(separator: " ")
        XCTAssertNil(words.range(of: #"Team \d|T\d|Your Team|Opponents"#, options: .regularExpression))
    }

    func testCellRoles() {
        XCTAssertEqual(Scorecard.cell(rows[0], 2).extra, true, "took > bid: gold")
        XCTAssertEqual(Scorecard.cell(rows[0], 1).extra, false)
        XCTAssertEqual(Scorecard.cell(rows[1], 2).role, .fault, "the server's fault list: the red pill")
        XCTAssertEqual(Scorecard.cell(rows[1], 4).role, .plain)
        XCTAssertEqual(Scorecard.cell(rows[2], 1).role, .bore, "a made bore: the green outline")
        XCTAssertFalse(Scorecard.cell(rows[2], 1).extra, "a bore is never gold")
        XCTAssertEqual(Scorecard.cell(rows[3], 2).role, .boreSet, "a set 2B: red and outlined")
        XCTAssertEqual(Scorecard.cell(rows[3], 4).role, .plain, "the bore's partner as normal")
        XCTAssertEqual(Scorecard.cell(rows[0], 2).text, "2 \u{2192} 3")
    }

    func testTheLedgerDeltaAboveTheTotalNoneOnTheFirstHand() {
        let m = Scorecard.model(rows: rows, solo: false, me: 1, name: name)
        XCTAssertEqual(m.rows[0].scores?.map(\.showDelta), [false, false])
        XCTAssertEqual(m.rows[1].scores, [.init(total: 92, delta: 41, showDelta: true, colour: 1),
                                         .init(total: -17, delta: -50, showDelta: true, colour: 2)])
        XCTAssertEqual([Scorecard.signed(41), Scorecard.signed(-50), Scorecard.signed(0)], ["+41", "\u{2212}50", "0"])
    }

    func testOneSentencePerRow() {
        let m = Scorecard.model(rows: Array(rows.prefix(2)), solo: false, me: 1, name: name)
        XCTAssertEqual(m.rows[1].spoken, "Hand 10, spades. Dealer hal. ivy bid 2, took 3, one extra. hal bid 2, took 2. "
            + "kim bid 3, took 1, at fault. jon bid 2, took 2. ivy and hal 92, plus 41. kim and jon minus 17, minus 50.")
        XCTAssertTrue(m.rows[0].spoken.hasSuffix("ivy and hal 51. kim and jon 33."), "no delta on the first hand")
        let all = Scorecard.model(rows: rows, solo: false, me: 1, name: name)
        XCTAssertTrue(all.rows[2].spoken.contains("ivy bid a bore, took 4."))
        XCTAssertTrue(all.rows[3].spoken.contains("kim bid bore 2B, took 4, set."))
    }

    func testTheJokerHandAndTheSuitColours() {
        XCTAssertEqual(Scorecard.handLabel(1, T.c("joker", "HI")), .init(size: 1, symbol: "HI", red: true, joker: true,
                                                                      spoken: "Hand 1, no trump, high joker"))
        XCTAssertEqual(Scorecard.handLabel(3, T.c("joker", "LO")).symbol, "LO")
        XCTAssertTrue(Scorecard.handLabel(12, c("diamonds")).red)
        XCTAssertFalse(Scorecard.handLabel(12, c("clubs")).red)
    }

    func testTheHandInPlayBidsOnlyAndNotTwice() {
        let current = Scorecard.Current(handNo: 3, handSize: 8, trump: c("diamonds"), dealer: 4, bids: ["1", nil, "2", nil])
        let m = Scorecard.model(rows: Array(rows.prefix(2)), solo: false, me: 1, name: name, current: current)
        let last = m.rows.last!
        XCTAssertTrue(last.current)
        XCTAssertNil(last.scores)
        XCTAssertEqual(last.cells.map(\.text), ["1 \u{2192} \u{2013}", "2 \u{2192} \u{2013}", "\u{2013}", "\u{2013}"])
        XCTAssertTrue(last.spoken.contains("kim not bid yet"))
        var done = current
        done.handNo = 2
        XCTAssertEqual(Scorecard.model(rows: Array(rows.prefix(2)), solo: false, me: 1, name: name, current: done).rows.count, 2)
    }

    @MainActor
    func testTheStoresCurrentRowFollowsTheBids() {
        let store = GameState()
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        for ev in [T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
                                           "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]],
                                           "pics": [1, 2, 3, 4], "seq": 1]),
                   T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("hearts", "2"), "score1": 0,
                                      "score2": 0, "dealer": 4, "position": 1, "currentHand": 12, "seq": 2, "scorecardRows": 0]),
                   T.ev("updateTurn", ["currentTurn": 1, "seq": 3]),
                   T.ev("bidReceived", ["bid": "2", "position": 1, "bidArray": ["2", NSNull(), NSNull(), NSNull()], "seq": 4])] {
            _ = store.apply(ev)
        }
        XCTAssertTrue(store.hasScorecard)
        let m = store.scorecardModel()
        XCTAssertEqual(m.rows.count, 1)
        XCTAssertEqual(m.rows[0].cells.first?.text, "2 \u{2192} \u{2013}")
        XCTAssertEqual(m.players.map(\.name), ["me", "P", "L", "R"])
    }

    func testGetYourBidColumnsAndTheForbiddenBid() {
        let row = ScorecardRow(handNo: 9, handSize: 5, trump: c("clubs"), dealer: 3, bids: ["2", "1", "1"], took: [2, 0, 3],
                               points: [12, 0, 0], scores: [40, 21, 7], faults: [], forbidden: .init(position: 3, bid: 2))
        let m = Scorecard.model(rows: [row], solo: true, me: 1, name: name)
        XCTAssertTrue(m.pairs.isEmpty)
        XCTAssertEqual(m.players.map(\.colour), [1, 2, 3], "each player its own colour")
        XCTAssertEqual(m.rows[0].cells.map(\.forbidden), [nil, nil, 2])
        XCTAssertEqual(m.rows[0].cells.map(\.role), [.plain, .plain, .plain], "no fault in Get Your Bid")
        XCTAssertEqual(m.rows[0].scores?.map(\.total), [40, 21, 7])
        XCTAssertTrue(m.rows[0].spoken.contains("hal bid 1, took 3, 2 extra, forbidden bid 2."))
    }

    // MARK: - Every recorded game

    /// Each recording replayed through the reducer: one row per completed hand, each handComplete
    /// row's points what the score changed by, the totals the game's final score, and the gameEnd
    /// rows the ones the table kept.
    func testEveryRecordedGamesRowsAddUpToItsFinalScore() throws {
        var games = 0
        for game in try RecordedGame.all() {
            for viewer in game.viewers {
                let log = game.logs[viewer.label] ?? []
                guard log.contains(where: { $0.event == "gameEnd" }), log.first?.event == "gameStart" || log.contains(where: { $0.event == "createUI" }) else { continue }
                var replay = ReducerReplay(viewer: viewer)
                for e in log { try replay.apply(e) }
                guard case .ended(let end) = replay.state.table.phase, let rows = end.scorecard else { continue }
                XCTAssertEqual(rows, replay.state.table.scorecard, "\(game.name)/\(viewer.label)")
                XCTAssertEqual(rows.map(\.handNo), Array(1...13), "\(game.name)/\(viewer.label)")
                let cols = rows.first?.points.count ?? 2
                var total = Array(repeating: 0, count: cols)
                for r in rows {
                    for k in 0..<cols { total[k] += r.points[k] }
                    XCTAssertEqual(r.scores, total, "\(game.name) hand \(r.handNo)")
                    XCTAssertEqual(r.took.reduce(0, +), r.handSize)
                }
                if cols == 2 { XCTAssertEqual(total, [end.team1Score, end.team2Score], game.name) }
                else { XCTAssertEqual(total, end.gyb?.scores, game.name) }
                games += 1
            }
        }
        XCTAssertGreaterThan(games, 3, "the recordings that end carry the scorecard")
    }
}
