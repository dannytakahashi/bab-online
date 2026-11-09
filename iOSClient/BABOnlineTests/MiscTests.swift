import XCTest
@testable import BAB_Online

/// Item 21 leftovers outside the table.
final class MiscTests: XCTestCase {
    func testLeaderboardPopulationRowIsUnranked() throws {
        let rows: [[String: Any]] = [
            ["username": "alice", "gamesPlayed": 10, "winRate": 60.0],
            ["username": "Population", "isPopulation": true, "gamesPlayed": 7, "winRate": 50.0],
            ["username": "bob", "gamesPlayed": 4, "winRate": 40.0],
            ["username": "Population", "gamesPlayed": 1, "winRate": 10.0],  // a real player with that name
        ]
        let entries = rows.compactMap { LeaderboardEntry.from($0) }
        XCTAssertEqual(entries.map(\.isPopulation), [false, true, false, false])
        XCTAssertEqual(Set(entries.map(\.id)).count, 4, "population row id never collides with a player")
        XCTAssertEqual((0..<entries.count).map { LeaderboardEntry.rank(at: $0, in: entries) }, [1, nil, 2, 3])
    }

    func testLeaderboardEntryWithoutFlagIsAPlayer() {
        XCTAssertEqual(LeaderboardEntry.from(["username": "x"])?.isPopulation, false)
    }
}
