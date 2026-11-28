#if DEBUG
import Foundation

/// The Players sheet's search in fixture mode (no socket): `searchPlayers` is answered here,
/// 0.3 s later, with the server's reply shape (profileHandlers searchPlayers: up to 20 rows of
/// {username, profilePic, customProfilePic, gamesPlayed, wins}, `avatarUrls` for a custom
/// picture, the query echoed), through the same decoding as the server's. The roster matches
/// case-insensitively anywhere in the name, as the server's regex does. `-uiPlayerSearch`:
/// `ok` (the default), `empty` (every search finds nobody), `silent` (never answers: the
/// timeout, shortened to 3 s), `offline` (the socket is down: the quiet line, nothing sent),
/// `slow` (answers after 2 s: the spinner). kim has a custom picture; kim, ora and hal are
/// online in the `main-room` fixture, kimberly and kip are not; ivy is me.
extension UIFixture {
    static let playerSearchMode: String = UserDefaults.standard.string(forKey: "uiPlayerSearch") ?? "ok"

    static let playerSearchRoster: [(name: String, pic: Int)] = [
        ("kim", 12), ("kimberly", 40), ("kip", 7), ("ora", 9), ("hal", 22), ("ivy", 31), ("jon", 5),
        ("Christopher Johnson1", 63),
    ]

    static func seedPlayerSearch(_ search: PlayerSearchState) {
        guard isActive else { return }
        search.isConnected = { playerSearchMode != "offline" }
        if playerSearchMode == "silent" { search.timeout = 3 }
        search.send = { [weak search] query in
            guard playerSearchMode != "silent" else { return }
            let delay: TimeInterval = playerSearchMode == "slow" ? 2 : 0.3
            let reply = playerSearchReply(query)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { search?.apply(response: reply) }
        }
    }

    static func playerSearchReply(_ query: String) -> [String: Any] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let found = playerSearchMode == "empty" ? [] : playerSearchRoster.filter { $0.name.lowercased().contains(q) }
        let rows: [[String: Any]] = found.prefix(20).map {
            ["username": $0.name, "profilePic": $0.pic, "customProfilePic": NSNull(), "gamesPlayed": 10, "wins": 6]
        }
        var reply: [String: Any] = ["success": true, "players": rows, "query": query]
        if found.contains(where: { $0.name == "kim" }) { reply["avatarUrls"] = ["kim": "/avatar/kim?v=3"] }
        return reply
    }
}
#endif
