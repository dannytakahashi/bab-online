import XCTest
@testable import BAB_Online

/// The Stats sheet's Humans / Bots / All choice (StatsScope, StatsLoader): the default and
/// its persistence, the request payloads, and which page a reply lands on (its `scope` echo,
/// or the selected scope for an older server that sends none).
final class StatsScopeTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() {
        suite = "StatsScopeTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    private func leaderboard(_ sent: @escaping (StatsScope) -> Void = { _ in }) -> LeaderboardState {
        LeaderboardState(send: sent, defaults: defaults)
    }

    private func rows(_ names: String..., scope: String? = nil) -> [String: Any] {
        var reply: [String: Any] = ["success": true, "leaderboard": names.map { ["username": $0] }]
        if let scope { reply["scope"] = scope }
        return reply
    }

    // MARK: - The choice

    func testLabelsAndPayloads() {
        XCTAssertEqual(StatsScope.allCases, [.human, .bots, .all], "segment order")
        XCTAssertEqual(StatsScope.allCases.map(\.title), ["Humans", "Bots", "All"])
        XCTAssertEqual(StatsScope.allCases.map(\.spokenTitle), ["Human games", "Bot games", "All games"])
        XCTAssertNil(StatsScope.human.payload, "Humans sends today's request: no payload")
        XCTAssertEqual(StatsScope.bots.payload as? [String: String], ["scope": "bots"])
        XCTAssertEqual(StatsScope.all.payload as? [String: String], ["scope": "all"])
    }

    func testDefaultIsHumansAndTheChoiceIsSaved() {
        let s = leaderboard()
        XCTAssertEqual(s.scope, .human, "nothing saved: human games")
        s.select(.bots)
        XCTAssertEqual(defaults.string(forKey: StatsScope.defaultsKey), "bots")
        XCTAssertEqual(leaderboard().scope, .bots, "a new launch reads the saved choice")
        XCTAssertEqual(RecordsState(send: { _ in }, defaults: defaults).scope, .bots, "both tabs read the one choice")
        defaults.set("everything", forKey: StatsScope.defaultsKey)
        XCTAssertEqual(leaderboard().scope, .human, "an unknown saved value: human games")
    }

    func testEachScopeIsRequestedWithItsScope() {
        var sent: [StatsScope] = []
        let s = leaderboard { sent.append($0) }
        s.request()
        s.select(.bots)
        s.request()
        s.request()
        s.select(.all)
        s.request()
        XCTAssertEqual(sent, [.human, .bots, .all], "one request in flight per scope")
        XCTAssertEqual(s.load.display, .loading, "a new scope shows the loading state")
        s.select(.human)
        s.request()
        XCTAssertEqual(sent, [.human, .bots, .all], "Humans' request is still waiting")
    }

    // MARK: - Replies

    /// Humans -> Bots -> Humans quickly: each scope's reply fills its own page, never the
    /// one selected when it lands.
    func testAReplyForAnotherScopeNeverShows() {
        let s = leaderboard()
        s.request()                              // human
        s.select(.bots)
        s.request()                              // bots
        s.apply(response: rows("kim", "ivy", scope: "human"))
        XCTAssertEqual(s.load.display, .loading, "Bots is still loading: the human rows are not shown")
        XCTAssertTrue(s.entries.isEmpty)
        s.apply(response: rows("ora", scope: "bots"))
        XCTAssertEqual(s.entries.map(\.username), ["ora"])

        s.select(.human)
        XCTAssertEqual(s.entries.map(\.username), ["kim", "ivy"], "back on Humans: its rows, kept per scope")
        XCTAssertFalse(s.load.isLoading)
        s.request()
        s.apply(response: rows("ora", "zed", scope: "all"))
        XCTAssertEqual(s.entries.map(\.username), ["kim", "ivy"], "an All reply does not show under Humans")
        XCTAssertTrue(s.load.isLoading)
        s.select(.all)
        XCTAssertEqual(s.entries.map(\.username), ["ora", "zed"])
    }

    func testFailuresLandOnTheirScope() {
        let s = leaderboard()
        s.request()
        s.apply(response: rows("kim"))
        s.select(.bots)
        s.request()
        s.apply(response: ["success": false, "message": "Database error", "scope": "bots"])
        guard case .failed(let f) = s.load.display else { return XCTFail("\(s.load.display)") }
        XCTAssertEqual(f.message, "Database error")
        s.select(.human)
        XCTAssertEqual(s.load.display, .content)
        XCTAssertNil(s.load.failure, "Humans is untouched by the Bots failure")
    }

    /// An older server ignores the payload and sends no echo: its reply is taken as the
    /// selected scope's (such a server only ever counts human games).
    func testAReplyWithoutEchoIsTheSelectedScopes() {
        let s = leaderboard()
        s.request()
        s.apply(response: rows("kim"))
        XCTAssertEqual(s.entries.map(\.username), ["kim"], "Humans: today's server, unchanged")
        s.select(.bots)
        s.request()
        s.apply(response: rows("kim"))
        XCTAssertEqual(s.load.display, .content)
        XCTAssertFalse(s.load.isLoading)
        let null: [String: Any] = ["success": true, "leaderboard": [["username": "ned"]], "scope": NSNull()]
        s.apply(response: null)
        XCTAssertEqual(s.entries.map(\.username), ["ned"], "a null echo is no echo")
    }

    func testAnUnknownEchoIsDropped() {
        let s = leaderboard()
        s.request()
        s.apply(response: rows("kim", scope: "robots"))
        s.apply(response: rows("kim", scope: "BOTS"))
        let number: [String: Any] = ["success": true, "leaderboard": [["username": "kim"]], "scope": 1]
        s.apply(response: number)
        XCTAssertEqual(s.load.display, .loading, "no page takes a reply for a scope this build does not know")
        for scope in StatsScope.allCases {
            s.select(scope)
            XCTAssertTrue(s.entries.isEmpty, "\(scope)")
        }
    }

    /// A timeout ends only its own scope's request.
    func testTimeoutPerScope() async {
        let s = await MainActor.run { () -> LeaderboardState in
            let s = leaderboard()
            s.timeout = 0.2
            s.request()
            s.select(.bots)
            s.request()
            s.apply(response: rows("ora", scope: "bots"))
            return s
        }
        try? await Task.sleep(nanoseconds: 400_000_000)
        await MainActor.run {
            XCTAssertEqual(s.load.display, .content, "Bots answered")
            XCTAssertNil(s.load.failure)
            s.select(.human)
            XCTAssertEqual(s.load.failure, .noReply, "Humans timed out")
        }
    }

    /// Switching scope ends a pull to refresh on the old page.
    func testSwitchingEndsARefresh() async {
        let s = await MainActor.run { leaderboard() }
        async let done: Void = s.refresh()
        try? await Task.sleep(nanoseconds: 50_000_000)
        await MainActor.run { s.select(.all) }
        await done
        await MainActor.run { XCTAssertEqual(s.scope, .all) }
    }

    func testRecordsPerScopeAndAdditiveFields() {
        let r = RecordsState(send: { _ in }, defaults: defaults)
        r.select(.bots)
        r.request()
        let record: [String: Any] = ["score": 480, "players": ["ora", "🤖 Mary"], "withBots": true, "botSeats": [false, true]]
        r.apply(response: ["success": true, "scope": "bots", "totalGames": 6, "withBots": true,
                           "records": ["thisMonth": ["highestScore": record, "mostBags": ["bags": 9, "players": ["kim"], "withBots": true]]]])
        let month = r.load.value?.periods[.thisMonth]
        XCTAssertEqual(month?.highestScore, GameRecords.TeamRecord(value: 480, players: ["ora", "🤖 Mary"]))
        XCTAssertEqual(month?.mostBags?.value, 9)
        XCTAssertEqual(r.load.value?.isEmpty, false)

        r.select(.all)
        r.request()
        r.apply(response: ["success": true, "scope": "all", "totalGames": 0, "records": ["allTime": NSNull()]])
        XCTAssertEqual(r.load.value?.isEmpty, true, "no games yet: the bots note shows")
        r.select(.bots)
        XCTAssertEqual(r.load.value?.totalGames, 6, "Bots keeps its own records")
    }

    func testRecordsIsEmpty() {
        XCTAssertTrue(GameRecords().isEmpty)
        XCTAssertTrue(GameRecords(totalGames: 0).isEmpty)
        XCTAssertFalse(GameRecords(totalGames: 3).isEmpty)
        XCTAssertFalse(GameRecords(totalGames: nil, periods: [.allTime: GameRecords.PeriodRecords()]).isEmpty)
    }

    #if DEBUG
    /// Fixture mode's replies (UIFixture+Stats) decode through the real path: Bots and All
    /// carry their echo, Humans none (as today's server).
    func testFixtureRepliesDecode() {
        XCTAssertNil(UIFixture.leaderboardFixture["scope"])
        XCTAssertEqual(LeaderboardEntry.rows(fromResponse: UIFixture.botsLeaderboardFixture)?.map(\.username), ["ora", "kim", "Population"])
        XCTAssertEqual(LeaderboardEntry.rows(fromResponse: UIFixture.allLeaderboardFixture)?.first { $0.username == "kim" }?.gamesPlayed, 44)
        XCTAssertEqual(GameRecords.from(response: UIFixture.botsRecordsFixture)?.periods.count, 3)
        XCTAssertEqual(GameRecords.from(response: UIFixture.allRecordsFixture)?.totalGames, 1240)
    }
    #endif
}
