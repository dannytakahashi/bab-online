import XCTest
@testable import BAB_Online

/// The Stats sheet's data: leaderboardResponse / recordsResponse decoding (every field
/// optional), the web's columns, formats and sort, the Records rows, and the request state
/// (one in flight, timeout, failure keeps the data, rate limit, the month rule).
final class StatsTests: XCTestCase {
    // MARK: - Leaderboard decoding

    func testLeaderboardDecodesTheServerRowsAndAvatarUrls() throws {
        let reply: [String: Any] = [
            "success": true,
            "leaderboard": [
                ["username": "kim", "profilePic": 12, "customProfilePic": NSNull(), "gamesPlayed": 42, "winRate": 64.28571,
                 "pointsPerGame": 225, "bidsPerGame": 12.38, "tricksPerBid": 1.0538, "setRate": 11.17, "drag": 58.09,
                 "faultsPerGame": 0.21, "avgHSI": 7.65],
                ["username": "Population", "isPopulation": true, "gamesPlayed": 27, "winRate": 52.2],
                ["username": "hal", "profilePic": 31, "customProfilePic": NSNull(), "gamesPlayed": 38, "winRate": 50],
            ] as [Any],
            "avatarUrls": ["kim": "/avatar/kim?v=3"],
        ]
        let rows = try XCTUnwrap(LeaderboardEntry.rows(fromResponse: reply))
        XCTAssertEqual(rows.map(\.username), ["kim", "Population", "hal"])
        XCTAssertEqual(rows[0].pictureKey, "/avatar/kim?v=3", "a capable reply's avatar URL")
        XCTAssertEqual(rows[2].pictureKey, "31", "else the stock picture")
        XCTAssertNil(rows[1].pictureKey, "the population row has no avatar")
        XCTAssertEqual(rows[0].pointsPerGame, 225, "an integer JSON number reads as a Double")
        XCTAssertEqual(rows[2].winRate, 50)
        XCTAssertEqual(rows[0].gamesPlayed, 42)
    }

    func testLeaderboardRowsWithMissingOrGarbledFields() throws {
        let reply: [String: Any] = [
            "success": true,
            "leaderboard": [
                ["username": "pat"],                                         // only a name: zeros
                ["gamesPlayed": 3, "winRate": 10],                           // no name: dropped
                "not a row",                                                 // dropped
                ["username": "eve", "winRate": "48.5", "gamesPlayed": NSNull(), "drag": true, "profilePic": "x"],
            ] as [Any],
        ]
        let rows = try XCTUnwrap(LeaderboardEntry.rows(fromResponse: reply))
        XCTAssertEqual(rows.map(\.username), ["pat", "eve"])
        XCTAssertEqual(rows[0].gamesPlayed, 0)
        XCTAssertEqual(rows[0].winRate, 0)
        XCTAssertEqual(rows[0].pictureKey, "1", "the server's default picture")
        XCTAssertEqual(rows[1].winRate, 48.5, "a numeric string")
        XCTAssertEqual(rows[1].gamesPlayed, 0, "null")
        XCTAssertEqual(rows[1].drag, 0, "a JSON boolean is not a number")
        XCTAssertNil(LeaderboardEntry.rows(fromResponse: ["success": false, "message": "Database error"]))
        XCTAssertNil(LeaderboardEntry.rows(fromResponse: ["success": true]), "no rows array")
        XCTAssertEqual(LeaderboardEntry.rows(fromResponse: ["success": true, "leaderboard": [Any]()]), [])
    }

    /// A legacy (cap-less) reply carries custom pictures inline; only a same-origin `/avatar/`
    /// path is ever loaded, so a data URL or an absolute URL falls back to the stock picture.
    func testOnlyAvatarPathsAreLoaded() {
        let inline = LeaderboardEntry.from(["username": "a", "profilePic": 5, "customProfilePic": "data:image/webp;base64,AAAA"])
        XCTAssertEqual(inline?.pictureKey, "5")
        let absolute = LeaderboardEntry.from(["username": "b", "profilePic": 6], avatarUrls: ["b": "https://evil.invalid/x.png"])
        XCTAssertEqual(absolute?.pictureKey, "6")
    }

    // MARK: - Columns and sort (the web LeaderboardPage)

    private func entry(_ name: String, games: Int = 10, win: Double = 50, set: Double = 10, tpb: Double = 1,
                       drag: Double = 50, population: Bool = false) -> LeaderboardEntry {
        var d: [String: Any] = ["username": name, "gamesPlayed": games, "winRate": win, "setRate": set,
                                "tricksPerBid": tpb, "drag": drag, "pointsPerGame": 200, "bidsPerGame": 12, "avgHSI": 8]
        if population { d["isPopulation"] = true }
        return LeaderboardEntry.from(d)!
    }

    func testColumnsMatchTheWeb() {
        XCTAssertEqual(LeaderboardColumn.allCases.map(\.title),
                       ["Games", "Win %", "Pts/Game", "Bids/Game", "Tricks/Bid", "Set %", "Drag", "HSI"])
        XCTAssertEqual(LeaderboardColumn.allCases.filter(\.defaultAscending), [.tricksPerBid, .setRate, .drag])
        let e = LeaderboardEntry.from(["username": "k", "gamesPlayed": 42, "winRate": 64.2857, "pointsPerGame": 225,
                                       "bidsPerGame": 12.38, "tricksPerBid": 1.0538, "setRate": 11.17, "drag": 58.09,
                                       "avgHSI": 7.65])!
        XCTAssertEqual(LeaderboardColumn.allCases.map { $0.format(e) },
                       ["42", "64.3%", "225.0", "12.4", "1.05", "11.2%", "58.1", "7.7"])
    }

    func testSortFollowsTheWeb() {
        let rows = [entry("a", games: 5, win: 70, set: 20), entry("pop", games: 9, win: 55, set: 12, population: true),
                    entry("b", games: 30, win: 55, set: 5), entry("c", games: 12, win: 40, set: 12)]
        var sort = LeaderboardSort()
        XCTAssertEqual(sort, LeaderboardSort(column: .winRate, ascending: false), "Win % descending first")
        XCTAssertEqual(sort.sorted(rows).map(\.username), ["a", "pop", "b", "c"], "ties keep the server's order")

        sort.select(.setRate)
        XCTAssertTrue(sort.ascending, "Set % sorts ascending first")
        XCTAssertEqual(sort.sorted(rows).map(\.username), ["b", "pop", "c", "a"])
        sort.select(.setRate)
        XCTAssertFalse(sort.ascending, "the same column flips")
        XCTAssertEqual(sort.sorted(rows).map(\.username), ["a", "pop", "c", "b"])

        sort.select(.gamesPlayed)
        XCTAssertFalse(sort.ascending, "Games sorts descending first")
        let sorted = sort.sorted(rows)
        XCTAssertEqual(sorted.map(\.username), ["b", "c", "pop", "a"])
        XCTAssertEqual((0..<sorted.count).map { LeaderboardEntry.rank(at: $0, in: sorted) }, [1, 2, nil, 3],
                       "the population row sorts by its averages and is never ranked")
    }

    // MARK: - Records decoding and rows (the web RecordsPage)

    private let fullPeriod: [String: Any] = [
        "highestScore": ["score": 610, "players": ["kim", "ora"]],
        "lowestScore": ["score": -240, "players": ["jon", "pat"]],
        "biggestWin": ["margin": 705, "winnerScore": 610, "loserScore": -95, "winnerPlayers": ["kim", "ora"],
                       "loserPlayers": ["pat", "hal"]],
        "mostBags": ["bags": 15, "players": ["kim", "ora"]],
        "leastBags": ["bags": 0, "players": ["jon", "hal"]],
    ]

    func testRecordsDecodeEveryPeriod() throws {
        let reply: [String: Any] = ["success": true, "totalGames": 1234,
                                    "records": ["allTime": fullPeriod, "thisYear": fullPeriod, "thisMonth": NSNull()]]
        let r = try XCTUnwrap(GameRecords.from(response: reply))
        XCTAssertEqual(r.totalGames, 1234)
        XCTAssertNotNil(r.periods[.allTime])
        XCTAssertNotNil(r.periods[.thisYear])
        XCTAssertNil(r.periods[.thisMonth], "null: no games this month")
        let rows = RecordRow.rows(try XCTUnwrap(r.periods[.allTime]))
        XCTAssertEqual(rows.map(\.label), ["Highest Score", "Lowest Score", "Biggest Win", "Most Bags", "Least Bags"])
        XCTAssertEqual(rows.map(\.tone), [.success, .danger, .warning, .neutral, .neutral])
        XCTAssertEqual(rows.map(\.value), ["610 pts", "-240 pts", "705 pt margin", "15 bags", "0 bags"])
        XCTAssertEqual(rows[0].lines, [.plain("kim & ora")])
        XCTAssertEqual(rows[2].lines, [.plain("610 - -95"), .winner("W: kim & ora"), .loser("L: pat & hal")])
        XCTAssertEqual(rows[2].spoken, "Biggest Win, 705 pt margin, 610 - -95, winners kim & ora, losers pat & hal")
        XCTAssertEqual(GameRecords.Period.allCases.map(\.title), ["All Time", "This Year", "This Month"])
    }

    func testRecordsWithMissingFields() throws {
        // legacy games without bags (null), a record missing its core field, a period that is not
        // an object, no totalGames, extra keys (the rows are open on the wire)
        let reply: [String: Any] = ["success": true, "records": [
            "allTime": ["highestScore": ["score": 412.5, "players": ["kim"], "extra": 1], "lowestScore": ["players": ["x"]],
                        "biggestWin": ["margin": 10], "mostBags": NSNull()] as [String: Any],
            "thisYear": "garbled",
        ] as [String: Any]]
        let r = try XCTUnwrap(GameRecords.from(response: reply))
        XCTAssertNil(r.totalGames, "no count: the line is not shown")
        XCTAssertNil(r.periods[.thisYear])
        XCTAssertNil(r.periods[.thisMonth], "missing")
        let rows = RecordRow.rows(try XCTUnwrap(r.periods[.allTime]))
        XCTAssertEqual(rows.map(\.value), ["412.5 pts", nil, "10 pt margin", nil, nil])
        XCTAssertEqual(rows[1].spoken, "Lowest Score, no games yet")
        XCTAssertEqual(rows[2].lines, [.plain("0 - 0"), .winner("W: "), .loser("L: ")])
        XCTAssertNil(GameRecords.from(response: ["success": false, "message": "Database error"]))
        XCTAssertEqual(GameRecords.from(response: ["success": true])?.periods.count, 0, "no records object: three empty periods")
    }

    // MARK: - Request state

    func testOneRequestInFlightAndReplies() {
        var sent = 0
        let s = LeaderboardState(send: { sent += 1 })
        XCTAssertEqual(s.load.display, .loading)
        s.request()
        s.request()
        XCTAssertEqual(sent, 1, "a second request waits for the first")
        s.apply(response: ["success": true, "leaderboard": [["username": "kim"]]])
        XCTAssertEqual(s.load.display, .content)
        XCTAssertEqual(s.entries.map(\.username), ["kim"])
        XCTAssertFalse(s.load.isLoading)

        // a failed refresh keeps the rows and carries the message
        s.request()
        XCTAssertEqual(sent, 2)
        s.apply(response: ["success": false, "message": "Database error"])
        XCTAssertEqual(s.load.display, .content)
        XCTAssertEqual(s.entries.map(\.username), ["kim"])
        XCTAssertEqual(s.load.failure, StatsFailure(message: "Database error"))
        XCTAssertEqual(s.load.failure?.isRateLimited, false)
    }

    /// The sheet rebuilds a tab's view on every switch, so the choices a viewer makes in it
    /// live on the states (for the session) and survive new data.
    func testViewChoicesLiveOnTheStates() {
        let s = LeaderboardState(send: {})
        XCTAssertEqual(s.sort, LeaderboardSort(), "Win % descending until changed")
        XCTAssertTrue(s.expanded.isEmpty)
        s.sort.select(.setRate)
        s.expanded.insert("kim")
        s.request()
        s.apply(response: ["success": true, "leaderboard": [["username": "kim"]]])
        XCTAssertEqual(s.sort, LeaderboardSort(column: .setRate, ascending: true), "a reply keeps the sort")
        XCTAssertEqual(s.expanded, ["kim"])

        let r = RecordsState(send: {})
        XCTAssertEqual(r.period, .allTime, "the web's first box until changed")
        r.period = .thisMonth
        r.request()
        r.apply(response: ["success": true])
        XCTAssertEqual(r.period, .thisMonth)
    }

    func testFirstFailureAndRateLimit() {
        let s = LeaderboardState(send: {})
        s.request()
        s.apply(response: ["success": false, "message": "Too many requests. Please wait a moment."])
        guard case .failed(let f) = s.load.display else { return XCTFail("\(s.load.display)") }
        XCTAssertTrue(f.isRateLimited)
        s.request()
        XCTAssertEqual(s.load.display, .loading, "Try Again shows the spinner")
        s.apply(response: ["success": false])
        XCTAssertEqual(s.load.failure?.message, "Failed to load leaderboard", "no message: the web's fallback")
    }

    func testTimeoutEndsTheRequestAndRefresh() async {
        let s = await MainActor.run { () -> LeaderboardState in
            let s = LeaderboardState(send: {})
            s.timeout = 0.2
            return s
        }
        await s.refresh()  // returns at the timeout
        await MainActor.run {
            XCTAssertFalse(s.load.isLoading)
            XCTAssertEqual(s.load.failure, .noReply)
            // a late reply still lands
            s.apply(response: ["success": true, "leaderboard": [["username": "kim"]]])
            XCTAssertEqual(s.load.display, .content)
            XCTAssertNil(s.load.failure)
        }
    }

    func testRefreshReturnsOnTheReply() async {
        let s = await MainActor.run { () -> LeaderboardState in
            let s = LeaderboardState(send: {})
            s.send = { [weak s] in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { s?.apply(response: ["success": true, "leaderboard": [Any]()]) }
            }
            return s
        }
        await s.refresh()
        await MainActor.run {
            XCTAssertEqual(s.load.display, .content)
            XCTAssertEqual(s.entries, [], "an empty leaderboard is content (the empty state)")
        }
    }

    /// "This Month" is the server's month: records loaded last month are not shown again while
    /// this month's load; within a month a refresh keeps them on screen.
    func testRecordsFromAnEarlierMonthAreDropped() {
        let s = RecordsState(send: {})
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        s.calendar = cal
        var clock = cal.date(from: DateComponents(year: 2026, month: 10, day: 31, hour: 23))!
        s.now = { clock }
        s.request()
        s.apply(response: ["success": true, "totalGames": 3, "records": ["allTime": fullPeriod]])
        XCTAssertEqual(s.load.value?.totalGames, 3)

        clock = cal.date(from: DateComponents(year: 2026, month: 10, day: 31, hour: 23, minute: 30))!
        s.request()
        XCTAssertEqual(s.load.display, .content, "same month: the records stay while the refresh runs")
        s.apply(response: ["success": true, "totalGames": 4, "records": ["allTime": fullPeriod]])

        clock = cal.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 0, minute: 5))!
        s.request()
        XCTAssertNil(s.load.value, "a new month: last month's This Month is gone")
        XCTAssertEqual(s.load.display, .loading)
    }

    // MARK: - Theme

    /// Every text-on-surface pair the Stats sheet draws is a checked tokens.json pair.
    func testStatsColorPairsAreChecked() {
        let pairs = Set(Theme.contrastPairs.map { "\($0.fg) on \($0.bg.joined(separator: ","))" })
        for pair in ["gold on surface.s1", "medal.silver on surface.s1", "medal.bronze on surface.s1",  // ranks
                     "text.secondary on surface.s1", "text.dim on surface.s2",                       // rank, population dash
                     "primary.base on surface.s1", "primary.base on surface.s2",                     // sorted stat, me
                     "text.primary on surface.s2", "text.secondary on surface.s2", "text.dim on surface.s1",
                     "text.primary on surface.s3", "text.secondary on surface.s3",                   // population details
                     "success on surface.s1", "danger.text on surface.s1", "warning on surface.s1",  // record tones
                     "text.secondary on surface.s0", "text.dim on surface.s0",                       // messages
                     "text.onPrimary on primary.base"] {                                              // Try Again
            XCTAssertTrue(pairs.contains(pair), pair)
        }
    }
}
