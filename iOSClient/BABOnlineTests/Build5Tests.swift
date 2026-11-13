import XCTest
@testable import BAB_Online

/// 1.2.0 (5): positionUpdate.isBot (contract/V1_REMOVALS #14, additive) is read first and the
/// `bot:` socket prefix is the fallback, so a server that later drops `sockets` keeps this
/// build's bots and its own seat (matched by username).
final class PositionUpdateIsBotTests: XCTestCase {
    private func seats(_ data: [String: Any], me: String = "me") -> [Int: SeatState] {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: me, playerId: "sid-me")))
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        var d = data
        d["positions"] = [1, 2, 3, 4]
        d["usernames"] = [["username": "me"], ["username": "🤖 Mary"], ["username": "P"], ["username": "🤖 Mike"]]
        d["pics"] = [1, 2, 3, 4]
        d["seq"] = 1
        TableReducer.reduce(&s, T.ev("positionUpdate", d))
        XCTAssertEqual(s.table.viewer.position, 1, "my seat")
        XCTAssertEqual(s.table.viewer.role, .seat)
        return s.players.seats
    }

    private func bots(_ seats: [Int: SeatState]) -> [Int] { seats.values.filter(\.isBot).map(\.position).sorted() }

    func testIsBotWithoutSockets() {
        let s = seats(["isBot": [false, true, false, true]])
        XCTAssertEqual(bots(s), [2, 4])
        XCTAssertEqual(s[2]?.controller, .bot)
        XCTAssertNil(s[2]?.ownerUsername)
        XCTAssertEqual(s[3]?.controller, .human)
        XCTAssertEqual(s[3]?.ownerUsername, "P")
    }

    func testIsBotWinsOverTheSocketPrefix() {
        let s = seats(["sockets": ["sid-me", "opaque-2", "sid-p", "bot:x"], "isBot": [false, true, false, false]])
        XCTAssertEqual(bots(s), [2])
    }

    func testSocketPrefixFallbackWhenIsBotIsAbsent() {
        // today's server (no isBot): exactly what 1.2.0 (4) did
        let s = seats(["sockets": ["sid-me", "bot:🤖 Mary:u1", "sid-p", "bot:🤖 Mike:u2"]])
        XCTAssertEqual(bots(s), [2, 4])
    }

    func testShortIsBotFallsBackPerSeat() {
        let s = seats(["sockets": ["sid-me", "bot:a", "sid-p", "bot:b"], "isBot": [false, true]])
        XCTAssertEqual(bots(s), [2, 4], "seats past the array use the prefix")
    }

    func testDecodesTheField() throws {
        let json = #"{"positions":[1,2],"sockets":["a","b"],"isBot":[false,true],"usernames":[{"username":"a"},{"username":"b"}]}"#
        let p = try JSONDecoder().decode(WirePayload.PositionUpdate.self, from: Data(json.utf8))
        XCTAssertEqual(p.isBot, [false, true])
    }
}
