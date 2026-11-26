import XCTest
import CoreGraphics
@testable import BAB_Online

/// Cut for a buck on iOS 1.2.7 (41): the reducer over the contract's recorded cut
/// (contract/fixtures/cut/events.json, read through #filePath), tournamentJoined.cut, the words
/// (with the owner's tweaks: lowercase "cut for a buck" mid-sentence, no "just for bragging
/// rights"), the seat looks, the ring geometry on every device's stage, the fan, the intro's
/// timeline, the screen model (verdict wait, sounds, the tap after the server drew for me) and the
/// handler.
@MainActor
final class CutForABuckTests: XCTestCase {
    static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static func fixtureEvents() throws -> [[String: Any]] {
        let url = root.appendingPathComponent("contract/fixtures/cut/events.json")
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try XCTUnwrap(json["events"] as? [[String: Any]])
    }

    // MARK: - Reducer over the recorded cut

    func testTheRecordedCutReplaysToItsWinner() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        var s: CutState?
        var redraws = 0, reshuffles = 0, reveals = 0
        for e in try Self.fixtureEvents() where e["to"] as? String == "tournament" {
            let name = try XCTUnwrap(e["event"] as? String)
            guard let type = CutState.Event.of(wireName: name), let data = e["data"] as? [String: Any] else { continue }
            let before = s
            s = CutState.reduce(s, type, data, now: now)
            let st = try XCTUnwrap(s, name)
            XCTAssertGreaterThan(st.seq, before?.seq ?? -1, "every event is a change (\(name))")
            XCTAssertGreaterThanOrEqual(st.deckCount, 0)
            switch type {
            case .start:
                XCTAssertEqual(st.stage, .gather)
                XCTAssertEqual(st.candidates.count, 4)
                XCTAssertEqual(st.endsAt, now.addingTimeInterval(15))
            case .round:
                XCTAssertEqual(st.stage, .drawing)
                XCTAssertTrue(st.drawn.isEmpty)
                if st.reshuffled {
                    reshuffles += 1
                    XCTAssertTrue(st.table.isEmpty, "a reshuffle clears the table")
                    XCTAssertEqual(st.deckCount, 54)
                }
                XCTAssertEqual(st.alive, data["alive"] as? [String])
            case .drew:
                XCTAssertNotNil(st.drawn[data["username"] as! String])
                XCTAssertEqual(st.freeSlots.count, st.deckCount - st.drawn.count)
            case .reveal:
                reveals += 1
                let reveal = try XCTUnwrap(st.lastReveal)
                if reveal.redraw {
                    redraws += 1
                    XCTAssertTrue(reveal.eliminated.isEmpty)
                }
                for u in reveal.eliminated { XCTAssertEqual(st.out[u]?.round, reveal.round) }
                XCTAssertEqual(st.alive, data["alive"] as? [String])
                // suits never count: everyone out holds the lowest rank, nobody left lower
                let low = CutSeatLook.lowestRank(reveal.draws.map(\.card))
                for d in reveal.draws where reveal.eliminated.contains(d.username) {
                    XCTAssertEqual(CardConstants.rankValues[d.card.rank], low)
                }
            case .winner:
                XCTAssertEqual(st.stage, .winner)
            case .left:
                break
            }
        }
        let end = try XCTUnwrap(s)
        XCTAssertEqual(end.winner, "T13_u2")
        XCTAssertEqual(end.rounds, 15)
        XCTAssertEqual(end.alive, ["T13_u2"])
        XCTAssertEqual(redraws, 13)
        XCTAssertEqual(reshuffles, 1)
        XCTAssertEqual(reveals, 15)
        XCTAssertEqual(Set(end.out.keys), ["T13_u1", "T13_u3", "T13_u4"])
        XCTAssertEqual(end.out["T13_u1"]?.round, 14, "the two-way tie on 4s: both out")
        XCTAssertEqual(end.out["T13_u4"]?.round, 14)
        XCTAssertEqual(CutCopy.verdictLines(end.lastReveal, me: "T13_u3"), ["You're out with a 2"])
    }

    func testTheRecordedJoinsRestoreTheCutAndTheResult() throws {
        let joins = try Self.fixtureEvents().filter { $0["event"] as? String == "tournamentJoined" }
        let cutJoin = try XCTUnwrap(joins.first { ($0["data"] as? [String: Any])?["phase"] as? String == "cut" }?["data"] as? [String: Any])
        let t = TournamentState()
        t.loadFromServerState(cutJoin)
        XCTAssertTrue(t.isCutPhase)
        let cut = try XCTUnwrap(t.cut)
        XCTAssertEqual(cut.last, .restore)
        XCTAssertFalse(cut.participants.isEmpty)
        for d in cut.drawn.values { XCTAssertFalse(d.auto) }

        // a socket without the cap: round_active, no cut
        let legacy = try XCTUnwrap(joins.first { ($0["data"] as? [String: Any])?["phase"] as? String == "round_active" }?["data"] as? [String: Any])
        t.loadFromServerState(legacy)
        XCTAssertNil(t.cut)

        let done = try XCTUnwrap(joins.first { ($0["data"] as? [String: Any])?["phase"] as? String == "complete" }?["data"] as? [String: Any])
        t.loadFromServerState(done)
        XCTAssertNil(t.cut)
        XCTAssertEqual(t.cutResult?.winner, "T13_u2")
        XCTAssertEqual(t.cutResult?.rounds, 15)

        let summary = try XCTUnwrap(try Self.fixtureEvents().first { $0["event"] as? String == "lobbiesUpdated" }?["data"] as? [String: Any])
        let row = try XCTUnwrap((summary["tournaments"] as? [[String: Any]])?.first.flatMap(TournamentSummary.from))
        XCTAssertTrue(row.cut)
        XCTAssertEqual(row.phase, "round_active")
    }

    func testFromWireAtEveryStage() {
        let now = Date()
        let base: [String: Any] = ["inMs": 4000, "round": 2, "participants": ["a", "b", "c"], "alive": ["a", "b"],
                                   "out": [["username": "c", "round": 1], ["username": "d", "round": 1, "left": true]],
                                   "table": [["username": "a", "cards": [["suit": "hearts", "rank": "9"]]],
                                             ["username": "c", "cards": [["suit": "joker", "rank": "LO"]]]],
                                   "drawn": [["username": "a", "slot": 3]], "deckCount": 50]
        for stage in ["gather", "drawing", "reveal", "winner"] {
            var w = base
            w["stage"] = stage
            if stage == "winner" { w["winner"] = "a" }
            let s = CutState.fromWire(w, now: now)!
            XCTAssertEqual(s.stage.rawValue, stage)
            XCTAssertEqual(s.out["d"], CutState.Out(round: 1, left: true))
            XCTAssertEqual(s.table["c"], [Card(suit: .joker, rank: .lo)])
            XCTAssertEqual(s.drawn.isEmpty, stage != "drawing", "drawn slots only while drawing")
            XCTAssertEqual(s.endsAt, now.addingTimeInterval(4))
        }
        XCTAssertNil(CutState.fromWire(nil))
        XCTAssertNil(CutState.fromWire("x"))
        // an event before its start (a late joiner): a round builds what it can, a drew does not
        XCTAssertNil(CutState.reduce(nil, .drew, ["round": 1, "username": "a", "slot": 1, "auto": false]))
        XCTAssertEqual(CutState.reduce(nil, .round, ["round": 3, "participants": ["a", "b"], "alive": ["a", "b"], "deckCount": 40,
                                                     "reshuffled": false, "closesInMs": 15000])?.round, 3)
        // a stale drew is ignored
        let s = CutState.reduce(nil, .round, ["round": 3, "alive": ["a"], "deckCount": 40, "closesInMs": 1])
        XCTAssertEqual(CutState.reduce(s, .drew, ["round": 2, "username": "a", "slot": 1, "auto": false]), s)
    }

    /// Back from the score screen mid-round after the server drew for me: the wire says only that I
    /// drew; the app keeps that it was the server's ("We drew a card for you", the tap that says I am back).
    func testARejoinMidRoundKeepsTheServersDrawForMe() {
        let t = TournamentState()
        t.tournamentId = "t1"
        t.phase = "cut"
        t.applyCut(.round, ["round": 2, "participants": ["ivy", "kim"], "alive": ["ivy", "kim"], "deckCount": 50, "closesInMs": 9000])
        t.applyCut(.drew, ["round": 2, "username": "ivy", "slot": 7, "auto": true])
        t.loadFromServerState(["tournamentId": "t1", "phase": "cut",
                               "cut": ["stage": "drawing", "inMs": 5000, "round": 2, "participants": ["ivy", "kim"], "alive": ["ivy", "kim"],
                                       "out": [], "table": [], "drawn": [["username": "ivy", "slot": 7]], "deckCount": 50]])
        XCTAssertEqual(t.cut?.drawn["ivy"]?.auto, true)
        XCTAssertTrue(t.cut!.canSayBack(me: "ivy", spectator: false))
        // another tournament's state never inherits it
        t.loadFromServerState(["tournamentId": "t2", "phase": "cut",
                               "cut": ["stage": "drawing", "inMs": 5000, "round": 2, "participants": ["ivy", "kim"], "alive": ["ivy", "kim"],
                                       "out": [], "table": [], "drawn": [["username": "ivy", "slot": 7]], "deckCount": 50]])
        XCTAssertEqual(t.cut?.drawn["ivy"]?.auto, false)
    }

    func testALeaveFreesTheSlotAndMarksLeft() {
        var s = CutState.reduce(nil, .round, ["round": 2, "participants": ["a", "b", "c"], "alive": ["a", "b", "c"], "deckCount": 40,
                                              "closesInMs": 1000])
        s = CutState.reduce(s, .drew, ["round": 2, "username": "b", "slot": 7, "auto": false])
        s = CutState.reduce(s, .left, ["round": 2, "username": "b", "alive": ["a", "c"], "freedSlot": 7])
        XCTAssertEqual(s?.out["b"], CutState.Out(round: 2, left: true))
        XCTAssertNil(s?.drawn["b"])
        XCTAssertTrue(s!.freeSlots.contains(7))
        XCTAssertEqual(s?.last, .left("b", freedSlot: 7))
        XCTAssertEqual(CutSeatLook.of(s, "b", me: "a").look, .left)
    }

    // MARK: - Words

    func testTheWordsWithTheOwnersTweaks() {
        XCTAssertEqual(CutCopy.winnerLine("bea", me: "ivy"), "bea wins cut for a buck!")
        XCTAssertEqual(CutCopy.winnerLine("ivy", me: "ivy"), "You win cut for a buck!")
        XCTAssertEqual(CutCopy.cutWonLine(CutResult(winner: "bea", participants: [], rounds: 2), me: "ivy"), "bea won cut for a buck")
        XCTAssertEqual(CutCopy.watching, "Watching cut for a buck")
        XCTAssertEqual(CutCopy.tournamentWinnerLine(["kim", "ivy"], me: "ivy"), "You and kim share the win!")
        XCTAssertEqual(CutCopy.tournamentWinnerLine(["kim"], me: "ivy"), "kim wins the tournament!")
        XCTAssertEqual(CutCopy.joinNames(["al", "bo", "cy"]), "al, bo and cy")
        XCTAssertEqual(CutCopy.rankWithArticle(.ace), "an ace")
        XCTAssertEqual(CutCopy.rankWithArticle(.eight), "an 8")
        XCTAssertEqual(CutCopy.rankWithArticle(.hi), "a HI joker")
        XCTAssertEqual(CutCopy.cardSpoken(Card(suit: .clubs, rank: .three)), "3 of clubs")
        XCTAssertEqual(CutCopy.cardShort(Card(suit: .hearts, rank: .nine)), "9\u{2665}")
        let reveal = CutReveal(round: 2, draws: [CutDraw(username: "ivy", slot: 0, card: Card(suit: .hearts, rank: .nine)),
                                                 CutDraw(username: "bo", slot: 1, card: Card(suit: .spades, rank: .three)),
                                                 CutDraw(username: "al", slot: 2, card: Card(suit: .clubs, rank: .three))],
                               eliminated: ["bo", "al"], redraw: false)
        XCTAssertEqual(CutCopy.verdictLines(reveal, me: "ivy"), ["You're safe with a 9", "bo and al are out with 3s"])
        XCTAssertEqual(CutCopy.revealAnnouncement(reveal, me: "ivy"),
                       "Round 2: you 9 of hearts, bo 3 of spades, al 3 of clubs. You're safe with a 9. bo and al are out with 3s.")
        let tie = CutReveal(round: 4, draws: [CutDraw(username: "a", slot: 0, card: Card(suit: .hearts, rank: .seven))], eliminated: [], redraw: true)
        XCTAssertEqual(CutCopy.verdictLines(tie, me: "x"), ["Everyone tied on 7s. Redraw!"])
        // no "Team" words, no bragging line anywhere
        let all = [CutCopy.rules, CutCopy.reshuffle, CutCopy.drewForYou, CutCopy.watching, CutCopy.outWatching, CutCopy.tapToDraw]
        for w in all { XCTAssertFalse(w.lowercased().contains("bragging")); XCTAssertFalse(w.contains("Team")) }
    }

    func testStatusAtEveryStage() throws {
        let now = Date()
        let names = ["ivy", "kim", "bo"]
        var s = CutState.reduce(nil, .start, ["candidates": names, "startsInMs": 12000, "deckCount": 54], now: now)
        XCTAssertEqual(CutCopy.status(s, me: "ivy", spectator: false, now: now).main, "Cut for a buck starts in 12")
        s = CutState.reduce(s, .round, ["round": 1, "participants": names, "alive": names, "deckCount": 54, "closesInMs": 7000], now: now)
        XCTAssertEqual(CutCopy.status(s, me: "ivy", spectator: false, now: now), .init(main: "Tap the deck to draw", sub: "Auto-draw in 7"))
        XCTAssertEqual(CutCopy.status(s, me: "lou", spectator: true, now: now).main, "Watching cut for a buck")
        s = CutState.reduce(s, .drew, ["round": 1, "username": "ivy", "slot": 3, "auto": true])
        XCTAssertEqual(CutCopy.status(s, me: "ivy", spectator: false, now: now), .init(main: "Waiting for kim and bo", sub: CutCopy.drewForYou))
        s = CutState.reduce(s, .reveal, ["round": 1, "draws": [["username": "ivy", "slot": 3, "card": ["suit": "clubs", "rank": "2"]],
                                                                ["username": "kim", "slot": 4, "card": ["suit": "clubs", "rank": "9"]],
                                                                ["username": "bo", "slot": 5, "card": ["suit": "clubs", "rank": "8"]]],
                                         "eliminated": ["ivy"], "redraw": false, "alive": ["kim", "bo"], "nextInMs": 4000], now: now)
        XCTAssertEqual(CutCopy.status(s, me: "ivy", spectator: false, now: now).main, "You're out with a 2")
        // out, I keep watching the next round live
        s = CutState.reduce(s, .round, ["round": 2, "participants": names, "alive": ["kim", "bo"], "deckCount": 51, "closesInMs": 7000], now: now)
        s = CutState.reduce(s, .drew, ["round": 2, "username": "kim", "slot": 1, "auto": false])
        XCTAssertEqual(CutCopy.status(s, me: "ivy", spectator: false, now: now), .init(main: CutCopy.outWatching, sub: "Waiting for bo"))
        XCTAssertEqual(CutSeatLook.of(s, "kim", me: "ivy").look, .drawn)
        XCTAssertEqual(CutSeatLook.of(s, "ivy", me: "ivy").caption, "Out \u{00B7} round 1")
        s = CutState.reduce(s, .winner, ["winner": "kim", "participants": names, "rounds": 2])
        XCTAssertEqual(CutCopy.status(s, me: "ivy", spectator: false, now: now), .init(main: "kim wins cut for a buck!", sub: ""))
        XCTAssertEqual(s?.out["bo"]?.round, 2, "the round cap's pick: the others are out")
        // the score screen's strip
        let gather = CutState.reduce(nil, .start, ["candidates": names, "startsInMs": 9000], now: now)
        XCTAssertEqual(CutCopy.scoreStrip(gather, me: "ivy", spectator: false, now: now)?.text, "Cut for a buck starts in 9")
        XCTAssertEqual(CutCopy.scoreStrip(gather, me: "ivy", spectator: false, now: now)?.button, "Join cut for a buck")
        XCTAssertEqual(CutCopy.scoreStrip(gather, me: "lou", spectator: true, now: now)?.button, "Watch cut for a buck")
        XCTAssertEqual(CutCopy.scoreStrip(s, me: "ivy", spectator: false, now: now)?.text, "kim wins cut for a buck!")
        XCTAssertNil(CutCopy.scoreStrip(s, me: "ivy", spectator: false, now: now)?.button)
        XCTAssertNil(CutCopy.scoreStrip(nil, me: "ivy", spectator: false))
    }

    func testAnOutPlayerLooksInUntilTheVerdict() {
        var s = CutState.reduce(nil, .round, ["round": 1, "participants": ["a", "b"], "alive": ["a", "b"], "deckCount": 54, "closesInMs": 1])
        s = CutState.reduce(s, .reveal, ["round": 1, "draws": [["username": "a", "slot": 0, "card": ["suit": "clubs", "rank": "2"]],
                                                                ["username": "b", "slot": 1, "card": ["suit": "clubs", "rank": "K"]]],
                                         "eliminated": ["a"], "redraw": false, "alive": ["b"], "nextInMs": 6000])
        s = CutState.reduce(s, .winner, ["winner": "b", "participants": ["a", "b"], "rounds": 1])
        XCTAssertEqual(CutSeatLook.of(s, "a", me: nil, verdictPending: true).look, .idle)
        XCTAssertEqual(CutSeatLook.of(s, "b", me: nil, verdictPending: true).look, .idle)
        XCTAssertEqual(CutSeatLook.of(s, "a", me: nil).look, .out)
        XCTAssertEqual(CutSeatLook.of(s, "b", me: nil).look, .winner)
        let v = CutSeatLook.of(s, "a", me: "a", connected: false, talking: true)
        XCTAssertEqual(v.label, "you, out in round 1, 2 of clubs, reconnecting, talking")
    }

    // MARK: - Ring and fan

    /// The stages the screen gives the ring (phones, the Duo closed / open / book page, the iPad),
    /// measured in fixture mode, and a few smaller and wider ones.
    static let stages: [CGSize] = [CGSize(width: 393, height: 560), CGSize(width: 375, height: 470), CGSize(width: 466, height: 470),
                                   CGSize(width: 520, height: 700), CGSize(width: 320, height: 380), CGSize(width: 600, height: 300),
                                   CGSize(width: 669, height: 760), CGSize(width: 820, height: 1000), CGSize(width: 1180, height: 680)]

    func testTheRingFitsTwoToTwentyOnEveryStage() {
        for size in Self.stages {
            for n in 2...20 {
                let L = CutRing.layout(w: size.width, h: size.height, n: n)
                XCTAssertTrue(L.ok, "\(n) on \(size): \(L.why ?? "")")
                XCTAssertEqual(L.seats.count, n)
                // me at 6 o'clock: straight below the centre, the lowest seat
                XCTAssertEqual(L.seats[0].x, L.cx, accuracy: 1)
                XCTAssertEqual(L.seats[0].y, L.seats.map(\.y).max()!, accuracy: 0.5)
                // clockwise on screen: the next seat is to my left
                if n >= 3 { XCTAssertLessThan(L.seats[1].x, L.seats[0].x - 1) }
                XCTAssertGreaterThanOrEqual(L.deck.height, CutRing.deckMin - 0.01)
                XCTAssertLessThanOrEqual(L.avatarD, CutRing.avatarMax)
            }
        }
    }

    /// The ring falls back to the list when it cannot fit (owner 2026-11-25, the web's PR #422):
    /// the layout's own check fails, or the avatars come out under 24 pt.
    func testTheRingFallsBackToTheListWhenItCannotFit() {
        XCTAssertEqual(CutRing.minRingAvatar, 24)
        // the iPhone 18 Pro's stage (393 x 560 measured): 12 fits, 40 never does
        XCTAssertTrue(CutRing.fits(w: 393, h: 560, n: 12))
        let forty = CutRing.layout(w: 393, h: 560, n: 40)
        XCTAssertLessThan(forty.avatarD, CutRing.minRingAvatar)
        XCTAssertFalse(CutRing.fits(forty))
        XCTAssertFalse(CutRing.fits(w: 393, h: 560, n: 40))
        // the threshold itself, on a layout that is otherwise fine
        var L = CutRing.layout(w: 820, h: 1000, n: 8)
        XCTAssertTrue(L.ok)
        L.avatarD = 24
        XCTAssertTrue(CutRing.fits(L), "24 pt is enough")
        L.avatarD = 23.9
        XCTAssertFalse(CutRing.fits(L), "under 24 pt is not")
        L.avatarD = 40
        L.ok = false
        XCTAssertFalse(CutRing.fits(L), "an overlap never fits, whatever the size")
        // every stage: fits is exactly "ok and at least 24", and once it stops fitting, more players never fit again
        // (2 players of slack: the thin stack edge from 13 can give one more player room)
        for size in Self.stages {
            var stopped: Int?
            for n in 2...40 {
                let lay = CutRing.layout(w: size.width, h: size.height, n: n)
                let fits = CutRing.fits(w: size.width, h: size.height, n: n)
                XCTAssertEqual(fits, lay.ok && lay.avatarD >= 24 - 0.001, "\(n) on \(size)")
                if !fits, stopped == nil { stopped = n }
                if let s = stopped, n > s + 2 { XCTAssertFalse(fits, "\(n) on \(size) fits after \(s) did not") }
            }
            if size.width < 700 { XCTAssertNotNil(stopped, "40 players never fit a phone's or the Duo's \(size)") }
        }
        // a size change brings the ring back: 16 players do not fit a phone's stage, they fit the iPad's
        XCTAssertFalse(CutRing.fits(w: 393, h: 560, n: 16))
        XCTAssertTrue(CutRing.fits(w: 820, h: 1000, n: 16))
    }

    func testTheFixtureSeatsFortyPlayers() {
        let names = UIFixture.cutPlayers(40)
        XCTAssertEqual(names.count, 40)
        XCTAssertEqual(Set(names).count, 40)
        XCTAssertEqual(names.first, "ivy")
        XCTAssertNotNil(UIFixture.cutState(n: 40, stage: "drawing"))
    }

    func testEqualArcsAndThePerimeter() {
        XCTAssertEqual(CutRing.ellipsePerimeter(10, 10), 2 * .pi * 10, accuracy: 0.001)
        let a = CutRing.equalArcAngles(200, 120, 7)
        XCTAssertEqual(a.first!, .pi / 2, accuracy: 0.0001)
        func pt(_ t: CGFloat) -> CGPoint { CGPoint(x: 200 * cos(t), y: 120 * sin(t)) }
        // the arcs between neighbours are equal (not the angles)
        func arc(_ t0: CGFloat, _ t1: CGFloat) -> CGFloat {
            var len: CGFloat = 0
            let end = t1 > t0 ? t1 : t1 + 2 * .pi
            var t = t0
            while t < end {
                let n = min(end, t + 0.001)
                len += hypot(pt(n).x - pt(t).x, pt(n).y - pt(t).y)
                t = n
            }
            return len
        }
        let arcs = (0..<7).map { i in arc(a[i], a[(i + 1) % 7]) }
        XCTAssertLessThan(arcs.max()! - arcs.min()!, arcs.max()! * 0.01, "\(arcs)")
        XCTAssertEqual(CutOrder.ring(["a", "b", "me", "c"], me: "me"), ["me", "c", "a", "b"])
        XCTAssertEqual(CutOrder.ring(["a", "b"], me: nil), ["a", "b"])
    }

    func testTheFanNarrowsAndMapsTheFingerToASlot() {
        let full = CutFan(width: 200, height: 100, count: 54, deckSize: 54)
        let half = CutFan(width: 200, height: 100, count: 27, deckSize: 54)
        XCTAssertEqual(full.half, 50 * .pi / 180, accuracy: 0.0001)
        XCTAssertLessThan(half.half, full.half)
        XCTAssertEqual(CutFan(width: 200, height: 100, count: 1, deckSize: 54).half, 0)
        XCTAssertEqual(full.angle(0, of: 54), -full.half, accuracy: 0.0001)
        XCTAssertEqual(full.angle(53, of: 54), full.half, accuracy: 0.0001)
        // the left edge picks the first card, the right edge the last, the middle the middle
        XCTAssertEqual(full.index(at: CGPoint(x: 0, y: full.pivot.y - 30), of: 54), 0)
        XCTAssertEqual(full.index(at: CGPoint(x: 200, y: full.pivot.y - 30), of: 54), 53)
        XCTAssertEqual(full.index(at: CGPoint(x: 100, y: 0), of: 54), 27, accuracy: 1)
        // the fan stays in its box
        for i in [0, 53] {
            let c = full.centre(i, of: 54)
            XCTAssertTrue((0...200).contains(c.x) && (0...100).contains(c.y), "\(c)")
        }
    }

    // MARK: - Intro

    func testTheIntroIsUnderThreeSecondsAndReduceMotionOnlyFades() {
        let full = CutIntro(reduceMotion: false)
        XCTAssertLessThan(full.finish, 3)
        for n in [2, 12, 20] {
            for k in 0..<n { XCTAssertEqual(full.seat(k, of: n, at: full.finish - 0.2), 1, accuracy: 0.0001, "seat \(k)/\(n) home") }
            XCTAssertEqual(full.seat(n - 1, of: n, at: 0.5), 0)
        }
        XCTAssertEqual(full.titleOpacity(full.finish), 0)
        XCTAssertEqual(full.titleOpacity(1.2), 1)
        XCTAssertGreaterThan(full.riffle(0.45), 0)
        XCTAssertEqual(full.fanSpread(0.5), 0)
        XCTAssertEqual(full.fanSpread(2), 1, accuracy: 0.0001)
        let reduced = CutIntro(reduceMotion: true)
        XCTAssertLessThan(reduced.finish, full.finish)
        for t in stride(from: 0.0, through: reduced.finish, by: 0.1) {
            XCTAssertEqual(reduced.titleScale(t), 1)
            XCTAssertEqual(reduced.riffle(t), 0)
            XCTAssertEqual(reduced.fanSpread(t), 1)
            XCTAssertEqual(reduced.seat(3, of: 8, at: t), 1)
        }
        XCTAssertEqual(reduced.stageOpacity(0), 0)
        XCTAssertEqual(reduced.stageOpacity(1), 1)
    }

    /// Over the list (iOS 1.2.7 (42)): the cover hides the rows while the title and the deck's
    /// shuffle play, and is gone, with the title, by the intro's end; Reduce Motion the same, sooner.
    func testTheListsCoverGoesWithTheTitle() {
        for intro in [CutIntro(reduceMotion: false), CutIntro(reduceMotion: true)] {
            XCTAssertEqual(intro.coverOpacity(0), 1, "the rows hidden as the intro starts")
            XCTAssertEqual(intro.coverOpacity(intro.finish), 0, "the rows shown by its end")
            for t in stride(from: 0.0, through: intro.finish, by: 0.05) {
                // never a bare title over the rows: the cover is at least as up as the title
                XCTAssertGreaterThanOrEqual(intro.coverOpacity(t) + 0.0001, intro.titleOpacity(t), "t=\(t)")
            }
        }
        let full = CutIntro(reduceMotion: false)
        XCTAssertEqual(full.coverOpacity(1.6), 1, "covered through the riffle and the fan")
    }

    // MARK: - The screen model

    private final class Recorder {
        var sounds: [SoundKind] = []
        var sent: [String] = []
        var said: [(String, Bool)] = []
        var haptics: [CutScreenModel.Haptic] = []
        var timers: [(TimeInterval, () -> Void)] = []
        func fire() { let t = timers; timers = []; for (_, f) in t { f() } }
    }

    private func model(me: String = "ivy", now: Date) -> (CutScreenModel, Recorder) {
        let m = CutScreenModel()
        let r = Recorder()
        m.me = me
        m.now = { now }
        m.play = { r.sounds.append($0) }
        m.send = { round, slot in r.sent.append("\(round):\(slot.map(String.init) ?? "null")") }
        m.announce = { r.said.append(($0, $1)) }
        m.haptic = { r.haptics.append($0) }
        m.schedule = { delay, fn in r.timers.append((delay, fn)) }
        return (m, r)
    }

    func testTheVerdictWaitsForTheCardsThenSoundsAndAnnounces() {
        let now = Date()
        let (m, r) = model(now: now)
        let names = ["ivy", "kim", "bo"]
        var s = CutState.reduce(nil, .start, ["candidates": names, "startsInMs": 1000], now: now)
        m.attach(s)
        XCTAssertNil(m.introStart, "1 s of gather left: no intro")
        let s1 = CutState.reduce(s, .round, ["round": 1, "participants": names, "alive": names, "deckCount": 54, "closesInMs": 15000], now: now)
        m.update(old: s, new: s1)
        s = s1
        XCTAssertTrue(m.canDraw(s))
        XCTAssertTrue(m.draw(s, slot: 12))
        XCTAssertEqual(r.sent, ["1:12"])
        XCTAssertFalse(m.draw(s, slot: 13), "one draw a round")
        XCTAssertEqual(r.sent, ["1:12"])
        XCTAssertEqual(r.haptics, [.light])
        let s2 = CutState.reduce(s, .drew, ["round": 1, "username": "kim", "slot": 3, "auto": false])
        m.update(old: s, new: s2)
        s = s2!
        XCTAssertEqual(r.sounds, [.draw, .draw])
        let s3 = CutState.reduce(s, .reveal, ["round": 1, "draws": [["username": "ivy", "slot": 12, "card": ["suit": "clubs", "rank": "2"]],
                                                                    ["username": "kim", "slot": 3, "card": ["suit": "clubs", "rank": "9"]],
                                                                    ["username": "bo", "slot": 5, "card": ["suit": "clubs", "rank": "8"]]],
                                             "eliminated": ["ivy"], "redraw": false, "alive": ["kim", "bo"], "nextInMs": 4000])
        m.update(old: s, new: s3)
        XCTAssertTrue(m.verdictPending(s3))
        XCTAssertEqual(m.status(s3).main, CutCopy.turning)
        XCTAssertEqual(r.timers.last?.0, CutScreenModel.Timing.verdict)
        r.fire()
        XCTAssertFalse(m.verdictPending(s3))
        XCTAssertEqual(r.sounds.suffix(2), [.card, .gameLost])
        XCTAssertEqual(r.haptics.last, .warning)
        XCTAssertTrue(r.said.last!.0.hasPrefix("Round 1: you 2 of clubs"))
        XCTAssertFalse(r.said.last!.1)
    }

    func testTheWinnerComesAfterTheLastVerdict() {
        let now = Date()
        let (m, r) = model(now: now)
        var s = CutState.reduce(nil, .round, ["round": 1, "participants": ["ivy", "kim"], "alive": ["ivy", "kim"], "deckCount": 54, "closesInMs": 1])
        m.attach(s)
        let rev = CutState.reduce(s, .reveal, ["round": 1, "draws": [["username": "ivy", "slot": 0, "card": ["suit": "clubs", "rank": "A"]],
                                                                     ["username": "kim", "slot": 1, "card": ["suit": "clubs", "rank": "3"]]],
                                               "eliminated": ["kim"], "redraw": false, "alive": ["ivy"], "nextInMs": 6000])
        m.update(old: s, new: rev)
        s = rev
        let win = CutState.reduce(s, .winner, ["winner": "ivy", "participants": ["ivy", "kim"], "rounds": 1])
        m.update(old: s, new: win)
        XCTAssertNil(m.winnerShown, "not before the cards have turned")
        r.fire()
        XCTAssertEqual(m.winnerShown, "ivy")
        XCTAssertEqual(r.sounds.suffix(2), [.set, .gameWon])
        XCTAssertEqual(r.haptics.last, .success)
        XCTAssertEqual(r.said.last?.0, "You win cut for a buck!")
        XCTAssertEqual(r.said.last?.1, true, "the winner is the urgent announcement")
    }

    func testATapAfterTheServerDrewForMeSaysIAmBackOnceARound() {
        let now = Date()
        let (m, r) = model(now: now)
        var s = CutState.reduce(nil, .round, ["round": 3, "participants": ["ivy", "kim"], "alive": ["ivy", "kim"], "deckCount": 40, "closesInMs": 15000])
        s = CutState.reduce(s, .drew, ["round": 3, "username": "ivy", "slot": 9, "auto": true])
        m.attach(s)
        XCTAssertFalse(m.canDraw(s))
        XCTAssertTrue(m.canSayBack(s))
        XCTAssertEqual(CutCopy.status(s, me: "ivy", spectator: false, now: now).sub, CutCopy.drewForYou)
        XCTAssertFalse(m.draw(s, slot: 4), "not a draw of mine")
        XCTAssertEqual(r.sent, ["3:null"], "cutForABuckDraw {round, slot: null}")
        _ = m.draw(s, slot: nil)
        XCTAssertEqual(r.sent, ["3:null"], "once a round")
        // next round, drawn for again: one more
        let s4 = CutState.reduce(CutState.reduce(s, .round, ["round": 4, "participants": ["ivy", "kim"], "alive": ["ivy", "kim"],
                                                             "deckCount": 38, "closesInMs": 15000]),
                                 .drew, ["round": 4, "username": "ivy", "slot": 1, "auto": true])
        m.update(old: s, new: s4)
        _ = m.draw(s4, slot: nil)
        XCTAssertEqual(r.sent, ["3:null", "4:null"])
        // a spectator never draws
        let (spec, sr) = model(me: "lou", now: now)
        spec.spectator = true
        XCTAssertFalse(spec.draw(s4, slot: 1))
        XCTAssertTrue(sr.sent.isEmpty)
    }

    func testTheIntroPlaysOnlyWithTheGatherWellAhead() {
        let now = Date()
        let (m, _) = model(now: now)
        let s = CutState.reduce(nil, .start, ["candidates": ["ivy", "kim"], "startsInMs": 12000], now: now)
        m.attach(s)
        XCTAssertNotNil(m.introStart)
        XCTAssertTrue(m.introPlaying(at: now.addingTimeInterval(1)))
        XCTAssertFalse(m.introPlaying(at: now.addingTimeInterval(3)))
        // a start while the screen is up plays it again
        let (m2, _) = model(now: now)
        m2.attach(nil)
        m2.update(old: nil, new: s)
        XCTAssertNotNil(m2.introStart)
    }

    /// The stage view's task is cancelled whenever SwiftUI rebuilds the view (it is, as the lobby
    /// comes up): a cancelled wait must leave the intro playing for the view that replaces it.
    /// With `try?` around the sleep it ended the intro in its first frames (verifier 2026-11-25,
    /// a screen recording: no title, no riffle, the avatars home from the first frame).
    func testACancelledIntroWaitLeavesTheIntroPlaying() async {
        let now = Date()
        var clock = now
        let (m, _) = model(now: now)
        m.now = { clock }
        let s = CutState.reduce(nil, .start, ["candidates": ["ivy", "kim"], "startsInMs": 12000], now: now)
        m.attach(s)
        let start = m.introStart
        XCTAssertNotNil(start)
        // the injected wait cancelled
        m.sleep = { _ in throw CancellationError() }
        await m.playIntro()
        XCTAssertEqual(m.introStart, start, "a cancelled wait ends nothing")
        XCTAssertNil(m.lastIntroLength)
        // the real wait, its task cancelled (the stage view rebuilt)
        m.sleep = { try await Task.sleep(for: .seconds($0)) }
        let task = Task { await m.playIntro() }
        task.cancel()
        await task.value
        XCTAssertEqual(m.introStart, start, "a cancelled task ends nothing")
        // the replacing view's wait runs out: the intro ends at its full length
        var waited: [TimeInterval] = []
        m.sleep = { waited.append($0); clock = now.addingTimeInterval(CutIntro.duration) }
        clock = now.addingTimeInterval(0.4)
        await m.playIntro()
        XCTAssertEqual(waited.count, 1)
        XCTAssertEqual(waited.first ?? 0, CutIntro.duration - 0.4, accuracy: 0.001, "the wait is what is left")
        XCTAssertNil(m.introStart)
        XCTAssertEqual(m.lastIntroLength ?? 0, CutIntro.duration, accuracy: 0.001)
    }

    func testAnOlderIntroWaitNeverEndsANewerIntro() async {
        let now = Date()
        var clock = now
        let (m, _) = model(now: now)
        m.now = { clock }
        let s = CutState.reduce(nil, .start, ["candidates": ["ivy", "kim"], "startsInMs": 12000], now: now)
        m.attach(s)
        // while the first intro's wait runs, the cut starts again (a new intro)
        m.sleep = { _ in
            clock = now.addingTimeInterval(1)
            guard var again = s else { return }
            again.seq += 1
            m.update(old: s, new: again)
        }
        await m.playIntro()
        XCTAssertEqual(m.introStart, now.addingTimeInterval(1), "the newer intro plays on")
        // arriving with too little gather left: no intro, and none left over from before
        let late = CutState.reduce(nil, .start, ["candidates": ["ivy", "kim"], "startsInMs": 2000], now: clock)
        m.attach(late)
        XCTAssertNil(m.introStart)
    }

    func testAReshuffleSendsTheTableBack() {
        let now = Date()
        let (m, r) = model(now: now)
        var s = CutState.reduce(nil, .round, ["round": 1, "participants": ["ivy", "kim"], "alive": ["ivy", "kim"], "deckCount": 2, "closesInMs": 1])
        s = CutState.reduce(s, .reveal, ["round": 1, "draws": [["username": "ivy", "slot": 0, "card": ["suit": "clubs", "rank": "7"]],
                                                                ["username": "kim", "slot": 1, "card": ["suit": "hearts", "rank": "7"]]],
                                         "eliminated": [], "redraw": true, "alive": ["ivy", "kim"], "nextInMs": 4000])
        m.attach(s)
        let next = CutState.reduce(s, .round, ["round": 2, "participants": ["ivy", "kim"], "alive": ["ivy", "kim"], "deckCount": 54,
                                               "reshuffled": true, "closesInMs": 15000])
        m.update(old: s, new: next)
        XCTAssertEqual(m.ghosts, ["ivy": 1, "kim": 1])
        XCTAssertEqual(r.said.first?.0, CutCopy.reshuffle)
        XCTAssertEqual(CutCopy.status(next, me: "kim", spectator: false).main, CutCopy.tapToDraw)
        r.fire()
        XCTAssertTrue(m.ghosts.isEmpty)
    }

    // MARK: - Handler

    func testTheHandlerFeedsTheCutAndTheResult() {
        let t = TournamentState()
        let handler = TournamentSocketHandler(socket: SocketService.shared, tournamentState: t, gameState: GameState(),
                                              appState: AppState(), safetyState: SafetyState(), voice: { VoiceChatManager.silent() })
        handler.handleCut(SocketEvents.Server.cutForABuckStart, ["candidates": ["a", "b"], "startsInMs": 15000, "deckCount": 54])
        XCTAssertNil(t.cut, "no tournament: a late copy is dropped")
        t.tournamentId = "t1"
        t.phase = "round_active"
        handler.handleCut(SocketEvents.Server.cutForABuckStart, ["candidates": ["a", "b"], "startsInMs": 15000, "deckCount": 54])
        XCTAssertEqual(t.phase, "cut")
        XCTAssertEqual(t.cut?.stage, .gather)
        handler.handleCut("somethingElse", [:])
        XCTAssertEqual(t.cut?.seq, 1)
        handler.handleComplete(["scoreboard": [["username": "a", "totalScore": 10, "roundScores": [10]]], "winners": ["a"],
                                "cutForABuck": ["winner": "b", "participants": ["a", "b"], "rounds": 3]])
        XCTAssertEqual(t.phase, "complete")
        XCTAssertNil(t.cut)
        XCTAssertEqual(t.cutResult, CutResult(winner: "b", participants: ["a", "b"], rounds: 3))
        handler.handleComplete(["scoreboard": [], "winners": ["a"]])
        XCTAssertNil(t.cutResult, "no cut ran: the same payload as before")
        t.reset()
        XCTAssertNil(t.cut)
    }

    func testTheCapIsSentAndTheEmitterShape() {
        XCTAssertTrue(ClientHello.caps.contains("cutForABuck"))
        XCTAssertEqual(CutForABuck.cap, "cutForABuck")
        XCTAssertEqual(SocketEvents.Client.cutForABuckDraw, "cutForABuckDraw")
        for e in CutState.Event.allCases { XCTAssertEqual(CutState.Event.of(wireName: e.wireName), e) }
    }

    func testTheFixtureStagesBuildThroughTheReducer() {
        for n in [2, 4, 8, 12, 20] {
            for stage in ["gather", "drawing", "away", "reveal", "out", "redraw", "reshuffle", "winner"] {
                let s = UIFixture.cutState(n: n, stage: stage)
                XCTAssertNotNil(s, "\(n) \(stage)")
                XCTAssertGreaterThanOrEqual(s!.deckCount, 0)
            }
            XCTAssertNotNil(UIFixture.cutState(n: n, stage: "winner")?.winner)
            XCTAssertEqual(UIFixture.cutState(n: n, stage: "away")?.drawn["ivy"]?.auto, true)
        }
    }
}
