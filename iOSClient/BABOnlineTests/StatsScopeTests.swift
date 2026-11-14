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
    //
    // As the servers send them: the scoped server (server/bot-game-stats) echoes `scope` on a
    // success only when the request named one (Bots / All; Humans sends no payload) and never
    // on a failure; today's server echoes nothing and answers every request with human games.

    private func failure(_ message: String = "Database error") -> [String: Any] {
        ["success": false, "message": message]
    }

    /// Humans -> Bots -> Humans quickly on the scoped server: each scope's reply fills its own
    /// page, never the one selected when it lands.
    func testAReplyForAnotherScopeNeverShows() {
        let s = leaderboard()
        s.request()                              // human
        s.select(.bots)
        s.request()                              // bots
        s.apply(response: rows("kim", "ivy"))    // Humans' reply: no echo
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

    /// The Humans reply (no echo) lands after the Bots one: Bots keeps its rows.
    func testALateHumansReplyAfterTheBotsReply() {
        let s = leaderboard()
        s.request()
        s.select(.bots)
        s.request()
        s.apply(response: rows("ora", scope: "bots"))
        s.apply(response: rows("ivy", "kim"))
        XCTAssertEqual(s.entries.map(\.username), ["ora"], "Bots is not overwritten with human rows")
        s.select(.human)
        XCTAssertEqual(s.entries.map(\.username), ["ivy", "kim"])
        XCTAssertEqual(s.load.display, .content)
    }

    /// Switching back to Humans after its late reply landed: its rows, no timeout error.
    func testALateHumansReplyFinishesHumans() async {
        let s = await MainActor.run { () -> LeaderboardState in
            let s = leaderboard()
            s.timeout = 0.2
            s.request()
            s.select(.all)
            s.request()
            s.apply(response: rows("ivy", "kim"))
            XCTAssertEqual(s.load.display, .loading, "All is still loading")
            return s
        }
        try? await Task.sleep(nanoseconds: 400_000_000)
        await MainActor.run {
            XCTAssertEqual(s.load.failure, .noReply, "All got no reply")
            XCTAssertTrue(s.entries.isEmpty)
            s.select(.human)
            XCTAssertEqual(s.entries.map(\.username), ["ivy", "kim"])
            XCTAssertNil(s.load.failure, "Humans answered: no \"didn't answer\" error")
        }
    }

    /// A Humans reply after its own timeout, on a Bots page waiting for its reply, before any
    /// echo has been seen: still Humans'.
    func testAHumansReplyAfterItsTimeoutStaysOnHumans() async {
        let s = await MainActor.run { () -> LeaderboardState in
            let s = leaderboard()
            s.timeout = 0.2
            s.request()
            return s
        }
        try? await Task.sleep(nanoseconds: 400_000_000)
        await MainActor.run {
            XCTAssertEqual(s.load.failure, .noReply)
            s.timeout = 10
            s.select(.bots)
            s.request()
            s.apply(response: rows("ivy", "kim"))
            XCTAssertEqual(s.load.display, .loading, "the human rows are not shown under Bots")
            s.apply(response: rows("ora", scope: "bots"))
            XCTAssertEqual(s.entries.map(\.username), ["ora"])
            s.select(.human)
            XCTAssertEqual(s.entries.map(\.username), ["ivy", "kim"])
        }
    }

    /// Once a reply has carried an echo, a reply without one is Humans' even when no Humans
    /// request is counted as waiting.
    func testAfterAnEchoAReplyWithoutOneIsHumans() {
        let s = leaderboard()
        s.select(.bots)
        s.request()
        s.apply(response: rows("ora", scope: "bots"))
        s.request()
        s.apply(response: rows("ivy"))
        XCTAssertEqual(s.entries.map(\.username), ["ora"])
        XCTAssertTrue(s.load.isLoading, "Bots still waits for its own reply")
        s.select(.human)
        XCTAssertEqual(s.entries.map(\.username), ["ivy"])
    }

    /// A failure (never echoed): the selected page if it is waiting, else the waiting one.
    func testFailuresWithoutEcho() {
        let s = leaderboard()
        s.request()
        s.apply(response: rows("kim"))
        s.select(.bots)
        s.request()
        s.apply(response: failure())
        guard case .failed(let f) = s.load.display else { return XCTFail("\(s.load.display)") }
        XCTAssertEqual(f.message, "Database error")
        s.select(.human)
        XCTAssertEqual(s.load.display, .content)
        XCTAssertNil(s.load.failure, "Humans is untouched by the Bots failure")

        // Humans waiting, Bots selected and answered: the failure is Humans'
        s.request()
        s.select(.bots)
        s.request()
        s.apply(response: rows("ora", scope: "bots"))
        s.apply(response: failure("Too many requests. Please wait a moment."))
        XCTAssertEqual(s.load.display, .content)
        XCTAssertNil(s.load.failure, "Bots shows its rows, not Humans' failure")
        s.select(.human)
        XCTAssertFalse(s.load.isLoading)
        XCTAssertEqual(s.load.failure?.isRateLimited, true)
        XCTAssertEqual(s.entries.map(\.username), ["kim"], "the last good rows stay")

        // nothing waiting: dropped
        s.apply(response: failure())
        XCTAssertEqual(s.load.failure?.isRateLimited, true)
        s.select(.all)
        XCTAssertEqual(s.load.display, .loading)
        XCTAssertNil(s.load.failure)
    }

    /// Today's server ignores the payload and echoes nothing: Humans as before scopes, and a
    /// Bots / All request (answered with human games) gets its reply rather than a timeout.
    func testTodaysServerWithoutEcho() {
        let s = leaderboard()
        s.request()
        s.apply(response: rows("kim"))
        XCTAssertEqual(s.entries.map(\.username), ["kim"], "Humans: today's server, unchanged")
        s.select(.bots)
        s.request()
        s.apply(response: rows("kim"))
        XCTAssertEqual(s.load.display, .content)
        XCTAssertFalse(s.load.isLoading)
        s.request()
        let null: [String: Any] = ["success": true, "leaderboard": [["username": "ned"]], "scope": NSNull()]
        s.apply(response: null)
        XCTAssertEqual(s.entries.map(\.username), ["ned"], "a null echo is no echo")

        // both waiting (Bots, then back to Humans): one reply each, in either order
        s.request()
        s.select(.human)
        s.request()
        s.apply(response: rows("pat"))
        s.apply(response: rows("hal"))
        XCTAssertFalse(s.load.isLoading)
        s.select(.bots)
        XCTAssertFalse(s.load.isLoading, "Bots got a reply too")
        XCTAssertEqual(s.load.display, .content)
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
