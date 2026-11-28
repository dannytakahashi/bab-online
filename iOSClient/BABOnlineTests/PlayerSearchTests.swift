import XCTest
import Combine
@testable import BAB_Online

/// The main room's Players sheet (owner 2026-11-27): search as you type over searchPlayers ->
/// searchPlayersResponse as the web's PlayerSearchPage does it (the trimmed text after a 300 ms
/// pause, a stale reply dropped by its echoed query), the online list for an empty field, the
/// online dot, my own name, no result, offline, the rate limit, the rows' decoding; and which
/// leaderboard rows open a profile from their avatar.
@MainActor
final class PlayerSearchTests: XCTestCase {
    /// A scheduler run by hand: `fire(after:)` runs what is due.
    private final class Clock {
        var now: TimeInterval = 0
        var items: [(at: TimeInterval, id: Int, work: () -> Void)] = []
        var cancelled: Set<Int> = []
        private var serial = 0

        func schedule(_ delay: TimeInterval, _ work: @escaping () -> Void) -> () -> Void {
            serial += 1
            let id = serial
            items.append((now + delay, id, work))
            return { [weak self] in self?.cancelled.insert(id) }
        }

        func advance(_ seconds: TimeInterval) {
            now += seconds
            while let i = items.indices.filter({ items[$0].at <= now }).min(by: { items[$0].at < items[$1].at }) {
                let item = items.remove(at: i)
                if !cancelled.contains(item.id) { item.work() }
            }
        }
    }

    private var clock: Clock!
    private var sent: [String] = []
    private var connected = true

    private func makeState() -> PlayerSearchState {
        clock = Clock()
        sent = []
        connected = true
        let s = PlayerSearchState()
        s.schedule = { [unowned self] d, w in self.clock.schedule(d, w) }
        s.send = { [unowned self] in self.sent.append($0) }
        s.isConnected = { [unowned self] in self.connected }
        return s
    }

    private func reply(_ query: String?, _ names: [String], urls: [String: String]? = nil) -> [String: Any] {
        var d: [String: Any] = ["success": true,
                                "players": names.map { ["username": $0, "profilePic": 3, "customProfilePic": NSNull(), "gamesPlayed": 2, "wins": 1] }]
        if let query { d["query"] = query }
        if let urls { d["avatarUrls"] = urls }
        return d
    }

    private func names(_ s: PlayerSearchState) -> [String]? {
        if case .results(let r) = s.phase { return r.map(\.username) }
        return nil
    }

    // MARK: - Typing

    func testTypingSendsOnlyAfterThePauseAndTheTrimmedText() {
        let s = makeState()
        s.setText("k")
        clock.advance(0.1)
        s.setText("ki")
        clock.advance(0.1)
        s.setText(" kim ")
        clock.advance(0.29)
        XCTAssertEqual(sent, [], "nothing before 300 ms of quiet")
        clock.advance(0.02)
        XCTAssertEqual(sent, ["kim"], "one request, trimmed, as the web sends it")
        XCTAssertEqual(s.latestQuery, "kim")
        XCTAssertEqual(s.debounce, 0.3, "the web's debounce")
    }

    func testSearchOnTheKeyboardSendsAtOnce() {
        let s = makeState()
        s.setText("ora")
        s.submit()
        XCTAssertEqual(sent, ["ora"])
        clock.advance(1)
        XCTAssertEqual(sent, ["ora"], "the pending pause was cancelled")
        s.setText("   ")
        s.submit()
        XCTAssertEqual(sent, ["ora"], "a blank field never sends (the server answers success: false)")
    }

    func testAStaleReplyIsDroppedByItsEchoedQuery() {
        let s = makeState()
        s.setText("k"); clock.advance(0.3)
        s.setText("kim"); clock.advance(0.3)
        XCTAssertEqual(sent, ["k", "kim"])
        XCTAssertFalse(s.apply(response: reply("k", ["kim", "kip", "kimberly"])), "the reply to an older query")
        XCTAssertNotEqual(names(s), ["kim", "kip", "kimberly"])
        XCTAssertTrue(s.apply(response: reply("kim", ["kim", "kimberly"])))
        XCTAssertEqual(names(s), ["kim", "kimberly"])
        XCTAssertFalse(s.apply(response: reply("k", ["kip"])), "a late one after the answer changes nothing")
        XCTAssertEqual(names(s), ["kim", "kimberly"])
    }

    func testAFailureForAnOlderQueryKeepsTheResults() {
        let s = makeState()
        s.setText("k"); clock.advance(0.3)
        s.setText("kim"); clock.advance(0.3)
        s.apply(response: reply("kim", ["kim"]))
        XCTAssertFalse(s.apply(response: ["success": false, "message": "Database error", "query": "k"]))
        XCTAssertEqual(names(s), ["kim"])
    }

    func testAReplyWithoutTheEchoIsShownAsOnTheWeb() {
        let s = makeState()
        s.setText("kim"); clock.advance(0.3)
        XCTAssertTrue(s.apply(response: reply(nil, ["kim"])), "an older server during a deploy")
        XCTAssertEqual(names(s), ["kim"])
    }

    func testAnEmptyFieldShowsTheOnlineListAndALateReplyStaysOut() {
        let s = makeState()
        XCTAssertEqual(s.phase, .idle)
        s.setText("kim"); clock.advance(0.3)
        s.setText("")
        XCTAssertEqual(s.phase, .idle)
        XCTAssertNil(s.latestQuery)
        XCTAssertFalse(s.apply(response: reply("kim", ["kim"])))
        XCTAssertEqual(s.phase, .idle)
        s.setText("  ")
        clock.advance(1)
        XCTAssertEqual(s.phase, .idle, "spaces are an empty field")
        XCTAssertEqual(sent, ["kim"])
    }

    func testNoResultIsItsOwnState() {
        let s = makeState()
        s.setText("zzz"); clock.advance(0.3)
        s.apply(response: reply("zzz", []))
        XCTAssertEqual(s.phase, .results([]))
    }

    func testTheLastResultsStayWhileTheNextSearchRuns() {
        let s = makeState()
        s.setText("ki"); clock.advance(0.3)
        s.apply(response: reply("ki", ["kim", "kip"]))
        s.setText("kim")
        XCTAssertEqual(names(s), ["kim", "kip"], "a keystroke never blanks the list")
        clock.advance(2)
        XCTAssertFalse(s.showsProgress, "no spinner over results")
        s.apply(response: reply("kim", ["kim"]))
        XCTAssertEqual(names(s), ["kim"])
    }

    func testTheSpinnerOnlyAfterAWaitWithNothingShown() {
        let s = makeState()
        s.setText("kim")
        clock.advance(0.3)
        XCTAssertEqual(s.phase, .searching)
        XCTAssertFalse(s.showsProgress, "a quick reply never flashes a spinner")
        clock.advance(0.3)
        XCTAssertTrue(s.showsProgress)
        s.apply(response: reply("kim", ["kim"]))
        XCTAssertFalse(s.showsProgress)
    }

    func testOfflineIsAQuietLineAndNothingIsSent() {
        let s = makeState()
        connected = false
        s.setText("kim"); clock.advance(0.3)
        XCTAssertEqual(sent, [])
        XCTAssertEqual(s.phase, .unavailable(PlayerSearchState.offlineLine))
        connected = true
        s.setText("kimb"); clock.advance(0.3)
        XCTAssertEqual(sent, ["kimb"], "back online, the next keystroke searches")
    }

    func testTypingWhileOfflineNeverBlanksTheLineOrShowsASpinner() {
        let s = makeState()
        connected = false
        var phases: [PlayerSearchState.Phase] = []
        var progress: [Bool] = []
        let watch = [s.$phase.sink { phases.append($0) }, s.$showsProgress.sink { progress.append($0) }]
        s.setText("k")
        XCTAssertEqual(s.phase, .unavailable(PlayerSearchState.offlineLine), "the quiet line at once, not after the pause")
        for text in ["ki", "kim", "kimb", "kimbe", "kimber"] {
            s.setText(text)
            clock.advance(0.2)
            XCTAssertEqual(s.phase, .unavailable(PlayerSearchState.offlineLine), "still the line at \(text)")
        }
        clock.advance(2)
        XCTAssertEqual(sent, [])
        XCTAssertFalse(phases.contains(.searching), "never \"Searching\" with no search to send: \(phases)")
        XCTAssertFalse(progress.contains(true), "never a spinner")
        watch.forEach { $0.cancel() }
    }

    func testAQuietLineStaysWhileTheNextSearchRuns() {
        let s = makeState()
        s.setText("kim"); clock.advance(0.3)
        clock.advance(s.timeout)
        XCTAssertEqual(s.phase, .unavailable(PlayerSearchState.noAnswerLine))
        s.setText("kimb")
        XCTAssertEqual(s.phase, .unavailable(PlayerSearchState.noAnswerLine), "a keystroke never blanks the line")
        clock.advance(0.3)
        XCTAssertEqual(sent, ["kim", "kimb"])
        clock.advance(2)
        XCTAssertFalse(s.showsProgress, "no spinner over the line")
        s.apply(response: reply("kimb", ["kimberly"]))
        XCTAssertEqual(names(s), ["kimberly"])
    }

    func testNoAnswerAndAFailureAreQuietLines() {
        let s = makeState()
        s.setText("kim"); clock.advance(0.3)
        clock.advance(s.timeout)
        XCTAssertEqual(s.phase, .unavailable(PlayerSearchState.noAnswerLine))
        XCTAssertFalse(s.apply(response: reply("kim", ["kim"])), "nothing waits any more")
        s.setText("kip"); clock.advance(0.3)
        s.apply(response: ["success": false, "message": "Database error", "query": "kip"])
        XCTAssertEqual(s.phase, .unavailable(PlayerSearchState.noAnswerLine))
    }

    func testTheRateLimitIsClaimedOnlyWhileASearchWaits() {
        let s = makeState()
        let limit: [String: Any] = ["code": "rateLimit", "message": "Too many requests, please slow down", "handler": "searchPlayers"]
        XCTAssertFalse(s.applyServerError(limit), "nothing waits: the toast as before")
        s.setText("kim"); clock.advance(0.3)
        XCTAssertFalse(s.applyServerError(["code": "rateLimit", "handler": "getPlayerProfile"]), "another handler's")
        XCTAssertTrue(s.applyServerError(limit))
        XCTAssertEqual(s.phase, .unavailable(PlayerSearchState.rateLimitedLine))
    }

    func testALongerQueryThanAnyUsernameIsAnsweredHere() {
        let s = makeState()
        s.setText(String(repeating: "x", count: 51)); clock.advance(0.3)
        XCTAssertEqual(sent, [], "the server would answer an empty list (and Joi refuses over 500)")
        XCTAssertEqual(s.phase, .results([]))
        s.setText(String(repeating: "x", count: 50)); clock.advance(0.3)
        XCTAssertEqual(sent, [String(repeating: "x", count: 50)])
    }

    func testResetForgetsEverything() {
        let s = makeState()
        s.setText("kim"); clock.advance(0.3)
        s.reset()
        XCTAssertEqual(s.text, "")
        XCTAssertEqual(s.phase, .idle)
        XCTAssertFalse(s.apply(response: reply("kim", ["kim"])))
    }

    // MARK: - Rows

    func testRowsDecodeAsTheLeaderboardDoes() {
        let s = makeState()
        s.setText("k"); clock.advance(0.3)
        let urls = ["kim": "/avatar/kim?v=3", "kip": "data:image/png;base64,AAAA"]
        s.apply(response: ["success": true, "query": "k", "avatarUrls": urls, "players": [
            ["username": "kim", "profilePic": 12], ["username": "kip", "profilePic": 7],
            ["username": "kimberly", "profilePic": 500], ["profilePic": 3], ["username": "kim", "profilePic": 1], "junk",
        ] as [Any]])
        guard case .results(let r) = s.phase else { return XCTFail("\(s.phase)") }
        XCTAssertEqual(r.map(\.username), ["kim", "kip", "kimberly"], "no name dropped, a repeat kept once")
        XCTAssertEqual(r.map(\.pictureKey), ["/avatar/kim?v=3", "7", "1"], "a data URL falls back to the stock picture, an unknown one to 1")
    }

    func testTheOnlineListAndMyOwnName() {
        let rows = PlayerSearchState.onlineRows(["ivy", "kim", "", "kim", "ora"], me: "ivy")
        XCTAssertEqual(rows.map(\.username), ["ivy", "kim", "ora"])
        XCTAssertEqual(rows.map(\.isMe), [true, false, false], "my own name is not a button")
        XCTAssertTrue(rows.allSatisfy(\.isOnline))
        XCTAssertTrue(rows.allSatisfy { $0.pictureKey == nil }, "names only, as the server sends the list")
        XCTAssertEqual(rows[1].spokenLabel, "kim, online")
        XCTAssertEqual(rows[0].spokenLabel, "ivy, you, online")
    }

    func testResultsCarryTheOnlineDot() {
        let results = [PlayerSearchResult(username: "kim", pictureKey: "12"), PlayerSearchResult(username: "kimberly", pictureKey: "1"),
                       PlayerSearchResult(username: "ivy", pictureKey: "31")]
        let rows = PlayerSearchState.resultRows(results, online: ["ivy", "kim", "ora"], me: "ivy")
        XCTAssertEqual(rows.map(\.isOnline), [true, false, true])
        XCTAssertEqual(rows.map(\.isMe), [false, false, true])
        XCTAssertEqual(rows.map(\.spokenLabel), ["kim, online", "kimberly", "ivy, you, online"])
    }

    func testTheSheetSendsWhatTheWebSends() throws {
        // the web sends {query} with no stats scope (PlayerSearchPage.js); so does the default emitter
        let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let web = try String(contentsOf: ios.appendingPathComponent("../client/src/ui/screens/PlayerSearchPage.js"), encoding: .utf8)
        XCTAssertTrue(web.contains("socket.emit('searchPlayers', { query });"))
        XCTAssertTrue(web.contains("setTimeout(doSearch, 300)"))
        XCTAssertTrue(web.contains("placeholder: '\(PlayersSheet.prompt)'"), "the same prompt as the web's")
        let src = try String(contentsOf: ios.appendingPathComponent("BABOnline/State/PlayerSearchState.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("SocketService.shared.emit(SocketEvents.Client.searchPlayers, [\"query\": query])"))
        XCTAssertEqual(SocketEvents.Client.searchPlayers, "searchPlayers")
        XCTAssertEqual(SocketEvents.Server.searchPlayersResponse, "searchPlayersResponse")
    }

    // MARK: - Leaderboard avatars

    func testTheLeaderboardAvatarTargetIsTheRowOrTheNameLine() {
        let avatar = CGRect(x: 40, y: 12, width: 28, height: 28)
        // one line: the row's full height, 44 pt wide over the avatar
        let row = LeaderboardAvatarTarget.frame(avatar: avatar, line: nil, row: CGSize(width: 360, height: 60))
        XCTAssertEqual(row, CGRect(x: 32, y: 0, width: 44, height: 60))
        // a short row still gets 44 x 44
        XCTAssertEqual(LeaderboardAvatarTarget.frame(avatar: avatar, line: nil, row: CGSize(width: 360, height: 40)).size,
                       CGSize(width: 44, height: 44))
        // stacked (accessibility sizes): the name's line only, never the stats under it
        let big = CGRect(x: 60, y: 20, width: 70, height: 70)
        let line = CGRect(x: 12, y: 10, width: 330, height: 90)
        let stacked = LeaderboardAvatarTarget.frame(avatar: big, line: line, row: CGSize(width: 360, height: 260))
        XCTAssertEqual(stacked, CGRect(x: 54, y: 10, width: 82, height: 90))
        XCTAssertLessThanOrEqual(stacked.maxY, line.maxY, "the stats below the line expand the row")
        // a one-line name at a small avatar: 44 pt, centred on the line, kept inside the row
        let thin = LeaderboardAvatarTarget.frame(avatar: CGRect(x: 40, y: 4, width: 20, height: 20),
                                                 line: CGRect(x: 0, y: 4, width: 300, height: 20), row: CGSize(width: 360, height: 120))
        XCTAssertEqual(thin.height, 44)
        XCTAssertEqual(thin.minY, 0, "never above the row")
    }

    func testTheLeaderboardRowKeepsItsHintAndGainsTheViewProfileAction() throws {
        // XCUITest cannot read custom actions or hints: the source is the check
        let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let src = try String(contentsOf: ios.appendingPathComponent("BABOnline/Views/MainRoom/LeaderboardView.swift"), encoding: .utf8)
        let squashed = src.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(squashed.contains(".accessibilityActions { Button(\"View profile\", action: open) }"), "the custom action")
        XCTAssertTrue(squashed.contains(".accessibilityHint(open ? \"Hides the other stats\" : \"Shows all stats\")"), "the expand hint")
        // on both row kinds, after the row's own label (one element)
        XCTAssertEqual(src.components(separatedBy: ".modifier(AvatarProfileTarget(username: e.username, open: profileOpener(e)))").count - 1, 2)
        XCTAssertTrue(squashed.contains(".accessibilityHidden(true) } } } else { content }"), "the clear target is hidden from VoiceOver")
    }

    func testWhichLeaderboardRowsOpenAProfile() {
        let rows = LeaderboardEntry.rows(fromResponse: ["success": true, "leaderboard": [
            ["username": "kim", "gamesPlayed": 3], ["username": "ivy", "gamesPlayed": 5],
            ["username": "Population", "isPopulation": true],
        ] as [Any]]) ?? []
        XCTAssertEqual(rows.map { $0.offersProfile(me: "ivy") }, [true, false, false], "not my own row, never the population row")
        XCTAssertEqual(rows.map { $0.offersProfile(me: "") }, [true, true, false], "signed out (no name): every player")
    }
}
