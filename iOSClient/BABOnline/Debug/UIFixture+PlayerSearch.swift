#if DEBUG
import SwiftUI

/// The Players sheet's search in fixture mode (no socket): `searchPlayers` is answered here,
/// 0.3 s later, with the server's reply shape (profileHandlers searchPlayers: up to 20 rows of
/// {username, profilePic, customProfilePic, gamesPlayed, wins}, `avatarUrls` for a custom
/// picture, the query echoed), through the same decoding as the server's. The roster matches
/// case-insensitively anywhere in the name, as the server's regex does. `-uiPlayerSearch`:
/// `ok` (the default), `empty` (every search finds nobody), `silent` (never answers: the
/// timeout, shortened to 3 s), `offline` (the socket is down: the quiet line, nothing sent),
/// `slow` (answers after 2 s: the spinner). kim has a custom picture; kim, ora and hal are
/// online in the `main-room` fixture, kimberly and kip are not; ivy is me.
///
/// The online list's pictures (2026-11-27): `playerCards` is answered here too, with the
/// server's playerCardsResponse shape (the same rows; `avatarUrls` for kim; a name with no
/// account, "pat", absent) and decoding. `-uiPlayerCards`: `ok` (the default, 0.3 s), `slow`
/// (after 6 s: the initials first, then the pictures in place), `silent` (never answers: a
/// server from before playerCards). Every request is noted in the "players.cardsSent" probe
/// ("ivy,kim,...|max" per request, "-" for none).
extension UIFixture {
    static let playerSearchMode: String = UserDefaults.standard.string(forKey: "uiPlayerSearch") ?? "ok"
    static let playerCardsMode: String = UserDefaults.standard.string(forKey: "uiPlayerCards") ?? "ok"

    static let playerSearchRoster: [(name: String, pic: Int)] = [
        ("kim", 12), ("kimberly", 40), ("kip", 7), ("ora", 9), ("hal", 22), ("ivy", 31), ("jon", 5),
        ("max", 50), ("Christopher Johnson1", 63),
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
        search.sendCards = { [weak search] names in
            PlayerCardsProbe.shared.note(names)
            guard playerCardsMode != "silent" else { return }
            let delay: TimeInterval = playerCardsMode == "slow" ? 6 : 0.3
            let reply = playerCardsReply(names)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { search?.applyCards(response: reply) }
        }
    }

    /// The server's playerCardsResponse for `names`: the roster's rows in the order asked.
    static func playerCardsReply(_ names: [String]) -> [String: Any] {
        let rows: [[String: Any]] = names.compactMap { name in
            playerSearchRoster.first { $0.name == name }.map {
                ["username": $0.name, "profilePic": $0.pic, "customProfilePic": NSNull(), "gamesPlayed": 10, "wins": 6]
            }
        }
        var reply: [String: Any] = ["success": true, "players": rows]
        if names.contains("kim") { reply["avatarUrls"] = ["kim": "/avatar/kim?v=3"] }
        return reply
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

/// "players.cardsSent" (fixture mode): the playerCards requests sent this launch, "|"-separated,
/// each its names comma-separated ("-": none yet). Main thread only.
final class PlayerCardsProbe: ObservableObject {
    static let shared = PlayerCardsProbe()
    @Published private(set) var value = "-"
    private var sent: [String] = []

    func note(_ names: [String]) {
        sent.append(names.joined(separator: ","))
        value = sent.joined(separator: "|")
    }

    /// The Players sheet's probes, 1x1 and nearly transparent (only in fixture mode):
    /// "players.cardsSent" and "players.onlinePictures" (each online row's picture as drawn,
    /// "name:key" or "name:-" for its initial, comma-separated in list order).
    struct Dots: View {
        let pictures: String
        @ObservedObject private var probe = PlayerCardsProbe.shared
        var body: some View {
            if UIFixture.isActive {
                VStack(spacing: 0) {
                    dot("players.cardsSent", probe.value)
                    dot("players.onlinePictures", pictures)
                }
                .allowsHitTesting(false)
            }
        }

        private func dot(_ id: String, _ value: String) -> some View {
            Rectangle().fill(Color.black).frame(width: 1, height: 1).opacity(0.01)
                .accessibilityElement()
                .accessibilityLabel(id)
                .accessibilityIdentifier(id)
                .accessibilityValue(value)
        }
    }
}
#endif
