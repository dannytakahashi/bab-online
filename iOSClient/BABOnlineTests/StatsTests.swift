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

    /// periodGames (additive 2026-11-14): each period's count; owner: the one total never
    /// changed with the selected period.
    func testRecordsPeriodGames() throws {
        let reply: [String: Any] = ["success": true, "totalGames": 101,
                                    "periodGames": ["allTime": 101, "thisYear": 40, "thisMonth": 12],
                                    "records": ["allTime": fullPeriod, "thisYear": fullPeriod, "thisMonth": fullPeriod]]
        let r = try XCTUnwrap(GameRecords.from(response: reply))
        XCTAssertEqual(r.totalGames, 101, "totalGames is kept as sent")
        XCTAssertEqual(r.games(in: .allTime), 101)
        XCTAssertEqual(r.games(in: .thisYear), 40)
        XCTAssertEqual(r.games(in: .thisMonth), 12)
        XCTAssertFalse(r.isEmpty)
    }

    func testRecordsPeriodGamesMissingOrMalformed() throws {
        // a server from before periodGames: All Time falls back to totalGames, the others unknown
        let old = try XCTUnwrap(GameRecords.from(response: ["success": true, "totalGames": 7, "records": ["allTime": fullPeriod]]))
        XCTAssertEqual(old.games(in: .allTime), 7)
        XCTAssertNil(old.games(in: .thisYear), "never the all-time total under This Year")
        XCTAssertNil(old.games(in: .thisMonth))
        // StatsWire style: numeric strings count; negatives, booleans, garbage and missing keys do not
        let odd = try XCTUnwrap(GameRecords.from(response: ["success": true, "totalGames": 7,
                                                            "periodGames": ["allTime": "9", "thisYear": -1, "thisMonth": true, "extra": 3] as [String: Any]]))
        XCTAssertEqual(odd.games(in: .allTime), 9, "periodGames wins over totalGames")
        XCTAssertNil(odd.games(in: .thisYear))
        XCTAssertNil(odd.games(in: .thisMonth))
        let partial = try XCTUnwrap(GameRecords.from(response: ["success": true, "periodGames": ["thisMonth": 2]]))
        XCTAssertNil(partial.games(in: .allTime), "no allTime and no totalGames: no count")
        XCTAssertEqual(partial.games(in: .thisMonth), 2)
        let garbled = try XCTUnwrap(GameRecords.from(response: ["success": true, "totalGames": 4, "periodGames": "nope"]))
        XCTAssertEqual(garbled.games(in: .allTime), 4)
        XCTAssertNil(garbled.games(in: .thisYear))
    }

    func testRecordsIsEmptyReadsTheAllTimeCount() {
        XCTAssertTrue(GameRecords(totalGames: nil, periodGames: [.allTime: 0, .thisYear: 0, .thisMonth: 0]).isEmpty)
        XCTAssertFalse(GameRecords(totalGames: nil, periodGames: [.allTime: 2, .thisYear: 0, .thisMonth: 0]).isEmpty)
        // a period count alone says nothing about All Time: the periods decide
        XCTAssertTrue(GameRecords(periodGames: [.thisMonth: 0]).isEmpty)
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

    // MARK: - Superlatives (recordsPeriod.superlatives, additive 2026-11-20)

    private func period(superlatives: Any?) -> [String: Any] {
        var p = fullPeriod
        if let superlatives { p["superlatives"] = superlatives }
        return p
    }

    func testSuperlativesDecodeInOrder() throws {
        let list: [Any] = [
            ["id": "bagBoy", "title": "Bag Boy", "names": ["kim"], "detail": "2.4 bags a game"],
            ["id": "luckyDuck", "title": "Lucky Duck", "names": ["ora"], "detail": "141.2 avg HSI"],
            ["id": "cursed", "title": "Cursed", "names": ["jon"], "detail": "98.7 avg HSI"],
            ["id": "botFriends", "title": "Some of my best friends are bots", "names": ["ora"], "detail": "23 solo games"],
            ["id": "helpFromFriends", "title": "A little help from my friends", "names": ["ivy"], "detail": "37 /help uses"],
            ["id": "anchor", "title": "Anchor", "names": ["hal", "jon", "kim"], "detail": "31% of hands set (+2 more)"],
        ]
        let r = try XCTUnwrap(GameRecords.from(response: ["success": true, "records": ["allTime": period(superlatives: list)]]))
        let s = try XCTUnwrap(r.periods[.allTime]).superlatives
        XCTAssertEqual(s.map(\.id), ["bagBoy", "luckyDuck", "cursed", "botFriends", "helpFromFriends", "anchor"],
                       "the server's order")
        XCTAssertEqual(s[0], GameRecords.Superlative(id: "bagBoy", title: "Bag Boy", names: ["kim"], detail: "2.4 bags a game"))
        XCTAssertEqual(s[5].namesLine, "hal, jon, kim", "ties joined with commas")
        XCTAssertEqual(s[5].spoken, "Anchor, hal, jon, kim, 31% of hands set (+2 more)")
        XCTAssertEqual(s[3].spoken, "Some of my best friends are bots, ora, 23 solo games")
        XCTAssertEqual(RecordRow.rows(try XCTUnwrap(r.periods[.allTime])).count, 5, "the five records are unchanged")
    }

    func testSuperlativesAbsentOrNotAnArray() throws {
        let reply: [String: Any] = ["success": true, "records": [
            "allTime": period(superlatives: nil),
            "thisYear": period(superlatives: NSNull()),
            "thisMonth": period(superlatives: ["id": "bagBoy", "title": "Bag Boy", "names": ["kim"]]),
        ] as [String: Any]]
        let r = try XCTUnwrap(GameRecords.from(response: reply))
        for p in GameRecords.Period.allCases {
            XCTAssertEqual(r.periods[p]?.superlatives, [], "\(p): no superlatives section")
            XCTAssertNotNil(r.periods[p]?.highestScore, "\(p): the records still decode")
        }
        XCTAssertEqual(GameRecords.from(response: ["success": true, "records": ["allTime": period(superlatives: [Any]())]])?
            .periods[.allTime]?.superlatives, [])
    }

    func testSuperlativesSkipMalformedEntries() throws {
        let list: [Any] = [
            "garbled",
            NSNull(),
            ["id": "noTitle", "names": ["kim"], "detail": "x"],
            ["id": "emptyTitle", "title": "", "names": ["kim"]],
            ["id": "noNames", "title": "No Names", "detail": "x"],
            ["id": "emptyNames", "title": "Empty Names", "names": [Any]()],
            ["id": "badNames", "title": "Bad Names", "names": "kim"],
            ["id": "onlyJunkNames", "title": "Junk", "names": [3, "", NSNull()] as [Any]],
            ["id": "luckyDuck", "title": "Lucky Duck", "names": ["ora", 7, ""] as [Any], "detail": "141.2 avg HSI"],
            ["title": "No Id", "names": ["max"], "detail": 12] as [String: Any],
            ["id": "luckyDuck", "title": "Lucky Duck again", "names": ["kim"], "detail": "dup"],
            ["id": 5, "title": "Numeric Id", "names": ["ned"]] as [String: Any],
        ]
        let r = try XCTUnwrap(GameRecords.from(response: ["success": true, "records": ["allTime": period(superlatives: list)]]))
        let s = try XCTUnwrap(r.periods[.allTime]).superlatives
        XCTAssertEqual(s, [
            .init(id: "luckyDuck", title: "Lucky Duck", names: ["ora"], detail: "141.2 avg HSI"),
            .init(id: "No Id", title: "No Id", names: ["max"], detail: ""),
            .init(id: "Numeric Id", title: "Numeric Id", names: ["ned"], detail: ""),
        ], "a bad entry is skipped, never failing the reply; a repeated id keeps its first entry")
        XCTAssertEqual(s[1].spoken, "No Id, max", "no detail: nothing after the names")
    }

    func testSuperlativesUnknownIdRendersTheSameWay() throws {
        let list: [Any] = [["id": "nightOwl", "title": "Night Owl", "names": ["ivy", "ned"], "detail": "12 games after midnight",
                            "extra": ["ignored": true]] as [String: Any]]
        let r = try XCTUnwrap(GameRecords.from(response: ["success": true, "records": ["thisMonth": period(superlatives: list)]]))
        let s = try XCTUnwrap(r.periods[.thisMonth]?.superlatives.first)
        XCTAssertEqual(s, .init(id: "nightOwl", title: "Night Owl", names: ["ivy", "ned"], detail: "12 games after midnight"))
        XCTAssertEqual(s.namesLine, "ivy, ned")
        XCTAssertEqual(s.spoken, "Night Owl, ivy, ned, 12 games after midnight")
    }

    func testSuperlativesReachTheRecordsState() throws {
        let suite = "superlatives-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let state = RecordsState(send: { _ in }, defaults: defaults)
        XCTAssertEqual(state.scope, .human)
        state.request()
        state.apply(response: UIFixture.recordsFixture)
        let value = try XCTUnwrap(state.load.value)
        XCTAssertEqual(value.periods[.allTime]?.superlatives.map(\.id),
                       ["bagBoy", "luckyDuck", "cursed", "helpFromFriends", "anchor", "luckyBuck"])
        // Lucky Buck (the most Cut for a buck wins, 1.2.7 server) needs no client code: it is read
        // and shown like any other title, ties included
        let lucky = try XCTUnwrap(value.periods[.allTime]?.superlatives.last)
        XCTAssertEqual([lucky.title, lucky.namesLine, lucky.detail], ["Lucky Buck", "kim", "3 wins in 7 cuts"])
        XCTAssertEqual(value.periods[.thisYear]?.superlatives.last?.namesLine, "ivy, kim")
        XCTAssertEqual(value.periods[.thisYear]?.superlatives.first?.namesLine, "hal, kim, ned")
        XCTAssertNil(value.periods[.thisMonth], "no games this month: no card content, no superlatives")
        let bots = try XCTUnwrap(GameRecords.from(response: UIFixture.botsRecordsFixture))
        XCTAssertEqual(bots.periods[.thisMonth]?.superlatives.map(\.id), ["bagBoy", "luckyDuck", "cursed", "botFriends"])
    }

    /// The reply as the socket hands it over (JSON-parsed Foundation objects, not Swift literals),
    /// shaped as the server's fillRecords sends it: every non-null period carries `superlatives`
    /// (possibly []), a null period stays null, a longer tie says " (+N more)" in `detail`, and a
    /// garbled entry or a wrongly typed list beside good ones never costs the other periods.
    func testSuperlativesFromServerShapedJSON() throws {
        let json = """
        {"success": true, "totalGames": 40, "periodGames": {"allTime": 40, "thisYear": 40, "thisMonth": 0},
         "records": {
          "allTime": {"highestScore": {"score": 410, "players": ["kim", "ora"]}, "lowestScore": null,
            "biggestWin": null, "mostBags": null, "leastBags": null,
            "superlatives": [
              {"id": "bagBoy", "title": "Bag Boy", "names": ["hal", "kim", "ned"], "detail": "2.1 bags a game (+2 more)"},
              {"id": "luckyDuck", "title": "Lucky Duck", "names": ["ora"], "detail": "141.2 avg HSI"},
              {"id": "cursed", "title": "Cursed", "names": ["ora"], "detail": "141.2 avg HSI"},
              {"id": "anchor", "title": "Anchor", "names": ["jon"], "detail": "31% of hands set"},
              {"id": "nightOwl", "title": "Night Owl", "names": [true, 1.5, "ivy"], "detail": null},
              {"id": "broken", "title": 7, "names": ["kim"], "detail": "x"},
              [], 42, "text", null]},
          "thisYear": {"highestScore": {"score": 410, "players": ["kim", "ora"]}, "superlatives": []},
          "thisMonth": null}}
        """
        let dict = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let r = try XCTUnwrap(GameRecords.from(response: dict))
        let all = try XCTUnwrap(r.periods[.allTime])
        XCTAssertEqual(all.superlatives.map(\.id), ["bagBoy", "luckyDuck", "cursed", "anchor", "nightOwl"])
        XCTAssertEqual(all.superlatives[0].spoken, "Bag Boy, hal, kim, ned, 2.1 bags a game (+2 more)")
        XCTAssertEqual(all.superlatives[4], .init(id: "nightOwl", title: "Night Owl", names: ["ivy"], detail: ""),
                       "JSON booleans and numbers are not names; a null detail is none")
        XCTAssertEqual(all.highestScore?.value, 410, "the records beside them still decode")
        XCTAssertEqual(r.periods[.thisYear]?.superlatives, [], "an empty list: no section")
        XCTAssertNil(r.periods[.thisMonth])
        XCTAssertEqual(r.games(in: .thisMonth), 0)
    }

    // MARK: - Request state

    func testOneRequestInFlightAndReplies() {
        var sent = 0
        let s = LeaderboardState(send: { _ in sent += 1 })
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
        let s = LeaderboardState(send: { _ in })
        XCTAssertEqual(s.sort, LeaderboardSort(), "Win % descending until changed")
        XCTAssertTrue(s.expanded.isEmpty)
        s.sort.select(.setRate)
        s.expanded.insert("kim")
        s.request()
        s.apply(response: ["success": true, "leaderboard": [["username": "kim"]]])
        XCTAssertEqual(s.sort, LeaderboardSort(column: .setRate, ascending: true), "a reply keeps the sort")
        XCTAssertEqual(s.expanded, ["kim"])

        let r = RecordsState(send: { _ in })
        XCTAssertEqual(r.period, .allTime, "the web's first box until changed")
        r.period = .thisMonth
        r.request()
        r.apply(response: ["success": true])
        XCTAssertEqual(r.period, .thisMonth)
    }

    func testFirstFailureAndRateLimit() {
        let s = LeaderboardState(send: { _ in })
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
            let s = LeaderboardState(send: { _ in })
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
            let s = LeaderboardState(send: { _ in })
            s.send = { [weak s] _ in
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
        let s = RecordsState(send: { _ in })
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
