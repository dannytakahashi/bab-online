import XCTest
@testable import BAB_Online

/// gameEnd `playerStats` (contract/src/s2c.js gameEnd) on the iOS game-end screen, as the
/// web's score modal shows them (ScoreModal.js: Player, Bids, Tricks, Faults, Avg HSI).
/// Decoding is optional throughout: an older server, a missing seat or field never breaks
/// the screen.
@MainActor
final class GameEndStatsTests: XCTestCase {
    private func seat(_ name: String, _ bids: Any, _ tricks: Any, _ sets: Any, _ avg: Any) -> [String: Any] {
        ["username": name, "totalBids": bids, "totalTricks": tricks, "setsCaused": sets, "totalHSI": 1500.25, "avgHSI": avg]
    }

    private var fullPayload: [String: Any] {
        ["score": ["team1": 101, "team2": 319], "tournamentId": NSNull(), "seq": 9,
         "playerStats": ["1": seat("ann", 23, 17, 5, 120), "2": seat("🤖 Mike", 17, 22, 1, 128),
                         "3": seat("🤖 Sharon", 14, 23, 0, 112), "4": seat("🤖 Mary", 17, 29, 0, 137)]]
    }

    func testDecodesEverySeatInSeatOrder() throws {
        let data = try XCTUnwrap(GameEndData.from(fullPayload))
        XCTAssertEqual(data.playerStats.map(\.position), [1, 2, 3, 4])
        XCTAssertEqual(data.playerStats[0], PlayerEndStats(position: 1, username: "ann", totalBids: 23, totalTricks: 17,
                                                           setsCaused: 5, avgHSI: 120))
        XCTAssertEqual(data.playerStats[3].username, "🤖 Mary")
        XCTAssertEqual(data.playerStats.map(\.team), [1, 2, 1, 2])
        // what the screen showed before is unchanged
        XCTAssertEqual(data.team1Score, 101)
        XCTAssertEqual(data.team2Score, 319)
        XCTAssertEqual(data.winningTeam, 2)
        XCTAssertEqual(data.team1Players, ["ann", "🤖 Sharon"])
        XCTAssertEqual(data.team2Players, ["🤖 Mike", "🤖 Mary"])
    }

    func testMissingPlayerStatsKeepsTheScreen() throws {
        var payload = fullPayload
        payload["playerStats"] = nil
        let data = try XCTUnwrap(GameEndData.from(payload))
        XCTAssertEqual(data.playerStats, [])
        XCTAssertEqual(data.team1Score, 101)
        XCTAssertEqual(data.winningTeam, 2)
        // and through the real event path into the store
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("hand-resolving"), .rejoin, hints: nil))
        h.store.apply(T.ev("gameEnd", ["score": ["team1": 10, "team2": 20], "tournamentId": NSNull(),
                                       "seq": h.store.state.sync.lastSeq! + 1]))
        XCTAssertEqual(h.store.phase, .ended)
        XCTAssertEqual(h.store.gameEndData?.playerStats, [])
        XCTAssertEqual(h.store.gameEndData?.team2Score, 20)
    }

    func testMalformedPlayerStatsShapes() throws {
        for bad in [NSNull(), "x", [1, 2, 3], [String: Any]()] as [Any] {
            var payload = fullPayload
            payload["playerStats"] = bad
            XCTAssertEqual(try XCTUnwrap(GameEndData.from(payload)).playerStats, [], "\(bad)")
        }
    }

    func testMissingSeatAndFieldsDegradeToDashes() throws {
        var payload = fullPayload
        payload["playerStats"] = [
            "1": ["username": "ann"],                                              // an older stats shape: name only
            "2": seat("bo", "7", true, NSNull(), 12.5),                            // mistyped values
            "4": seat("cy", 3, 4.0, 2, 99),                                        // seat 3 missing
            "9": seat("zz", 1, 1, 1, 1),                                           // not a seat
        ] as [String: Any]
        let rows = try XCTUnwrap(GameEndData.from(payload)).playerStats
        XCTAssertEqual(rows.map(\.position), [1, 2, 4])
        XCTAssertEqual(rows[0], PlayerEndStats(position: 1, username: "ann", totalBids: nil, totalTricks: nil, setsCaused: nil, avgHSI: nil))
        XCTAssertNil(rows[1].totalBids, "a string is not a count")
        XCTAssertNil(rows[1].totalTricks, "a Bool is not a count")
        XCTAssertNil(rows[1].setsCaused)
        XCTAssertEqual(rows[1].avgHSI, 12.5)
        XCTAssertEqual(rows[2].totalTricks, 4, "a whole JSON double is a count")
        XCTAssertEqual(PlayerEndStats.format(rows[0].totalBids), "–")
        XCTAssertEqual(PlayerEndStats.format(rows[0].avgHSI), "–")
        XCTAssertEqual(rows[0].accessibilityLabel, "ann, team 1: – bids, – tricks, – faults, average HSI –")
    }

    func testFormatsAsTheWeb() {
        XCTAssertEqual(PlayerEndStats.format(120.0), "120")  // the server rounds avgHSI
        XCTAssertEqual(PlayerEndStats.format(0.0), "0")
        XCTAssertEqual(PlayerEndStats.format(12.54), "12.5")
        XCTAssertEqual(PlayerEndStats.format(7), "7")
        let r = PlayerEndStats(position: 2, username: "kim", totalBids: 19, totalTricks: 17, setsCaused: 3, avgHSI: 104)
        XCTAssertEqual(r.accessibilityLabel, "kim, team 2: 19 bids, 17 tricks, 3 faults, average HSI 104")
        let unnamed = PlayerEndStats(position: 3, username: "", totalBids: 1, totalTricks: 2, setsCaused: 0, avgHSI: 5)
        XCTAssertTrue(unnamed.accessibilityLabel.hasPrefix("Seat 3, team 1:"))
        // a count of 1 reads with the singular noun
        let ones = PlayerEndStats(position: 1, username: "ivy", totalBids: 1, totalTricks: 1, setsCaused: 1, avgHSI: 98)
        XCTAssertEqual(ones.accessibilityLabel, "ivy, team 1: 1 bid, 1 trick, 1 fault, average HSI 98")
    }

    /// Equality (the replay tests compare the store's end with the wire's) includes the stats.
    func testEqualityIncludesStats() throws {
        let a = try XCTUnwrap(GameEndData.from(fullPayload))
        var payload = fullPayload
        var stats = payload["playerStats"] as! [String: Any]
        stats["2"] = seat("🤖 Mike", 17, 22, 2, 128)
        payload["playerStats"] = stats
        XCTAssertNotEqual(a, try XCTUnwrap(GameEndData.from(payload)))
    }

    /// Every real gameEnd the server recorded maps to four rows with the wire's values.
    func testRecordedGameEndsMapEverySeat() throws {
        var checked = 0
        for name in FixtureLoader.eventLogNames {
            let rec = try FixtureLoader.eventLog(name)
            let logs = try XCTUnwrap(rec["logs"] as? [String: [[String: Any]]])
            for (label, log) in logs {
                for entry in log where entry["dir"] as? String == "s2c" && entry["event"] as? String == "gameEnd" {
                    let raw = try XCTUnwrap(entry["data"] as? [String: Any])
                    let wire = try XCTUnwrap(raw["playerStats"] as? [String: [String: Any]], "\(name)/\(label)")
                    let rows = try XCTUnwrap(GameEndData.from(raw)).playerStats
                    XCTAssertEqual(rows.map(\.position), [1, 2, 3, 4], "\(name)/\(label)")
                    for r in rows {
                        let w = try XCTUnwrap(wire[String(r.position)])
                        XCTAssertEqual(r.username, w["username"] as? String)
                        XCTAssertEqual(r.totalBids, w["totalBids"] as? Int)
                        XCTAssertEqual(r.totalTricks, w["totalTricks"] as? Int)
                        XCTAssertEqual(r.setsCaused, w["setsCaused"] as? Int)
                        XCTAssertEqual(r.avgHSI, (w["avgHSI"] as? NSNumber)?.doubleValue)
                    }
                    // and through the event decoder the store uses
                    guard case .success(let seqd) = ServerEvent.decode(name: "gameEnd", payload: [raw], strict: true),
                          case .gameEnd(_, let data) = seqd.event else {
                        return XCTFail("\(name)/\(label): gameEnd did not decode")
                    }
                    XCTAssertEqual(data?.playerStats, rows)
                    checked += 1
                }
            }
        }
        XCTAssertGreaterThan(checked, 4)
    }

    /// The store's ended phase carries the stats (GameEndView reads gameEndData).
    func testStoreKeepsStatsAtGameEnd() throws {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("hand-resolving"), .rejoin, hints: nil))
        var payload = fullPayload
        payload["seq"] = h.store.state.sync.lastSeq! + 1
        h.store.apply(T.ev("gameEnd", payload))
        XCTAssertEqual(h.store.phase, .ended)
        XCTAssertEqual(h.store.gameEndData?.playerStats.count, 4)
        XCTAssertEqual(h.store.gameEndData?.playerStats.first?.setsCaused, 5)
    }
}
