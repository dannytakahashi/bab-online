import Foundation
import XCTest
@testable import BAB_Online

/// Small builders for reducer tests.
enum T {
    static func ev(_ name: String, _ data: [String: Any] = [:], blocked: Bool = false, mine: Bool = false) -> TableEvent {
        switch ServerEvent.decode(name: name, payload: [data], strict: true, chatBlocked: blocked, chatMine: mine) {
        case .success(let e): return .server(e)
        case .failure(let err): fatalError("test event \(name): \(err)")
        }
    }

    static func card(_ s: String, _ r: String) -> [String: Any] { ["suit": s, "rank": r] }

    static func snapshot(_ name: String, edit: (inout [String: Any]) -> Void = { _ in }) throws -> TableSnapshot {
        var raw = try FixtureLoader.v2Snapshot(name)
        edit(&raw)
        return try TableSnapshot.decode(raw, strict: true)
    }

    static func state(fixture name: String, previous: TableState? = nil, source: SnapshotSource = .requested("t")) throws -> TableState {
        TableReducer.state(from: try snapshot(name), hints: nil, previous: previous, source: source)
    }

    /// Seat 1 ("me"), dealt `hand`, bidding open (no updateTurn yet).
    static func dealtState(hand: [[String: Any]] = [card("spades", "A"), card("hearts", "2"), card("clubs", "K")],
                           size: Int = 3, dealer: Int = 4, trump: [String: Any] = card("diamonds", "5")) -> TableState {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "me", playerId: "sid-me")))
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        TableReducer.reduce(&s, ev("positionUpdate", [
            "positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
            "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1,
        ]))
        TableReducer.reduce(&s, ev("gameStart", [
            "gameId": "g1", "hand": hand, "trump": trump, "score1": 0, "score2": 0, "dealer": dealer, "position": 1,
            "currentHand": size, "seq": 2,
        ]))
        return s
    }
}
