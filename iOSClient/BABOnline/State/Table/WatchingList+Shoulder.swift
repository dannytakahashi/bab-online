import Foundation

/// Who watches which hand (the over-the-shoulder view's transparency, docs/claude/spectators.md
/// "Who watches which hand"; the web's state/shoulder.js watchersBySeat / watchTitle / watcherRow):
/// read-only, from the spectator entries' `shoulder`. People by name, never seat or team numbers.
/// With no entry carrying `shoulder` (every server and socket without the cap) all of it is empty,
/// so the table and the badge's list are exactly as before.
extension WatchingList {
    /// Who watches each seat's hand: position -> usernames, in the list's order.
    var watchersBySeat: [Int: [String]] {
        var out: [Int: [String]] = [:]
        for w in spectators {
            guard let seat = Position.valid(w.shoulder), !w.username.isEmpty else { continue }
            out[seat, default: []].append(w.username)
        }
        return out
    }

    /// The seat eye's words: "Zach is watching Alice's hand", "Zach and Yan are watching Alice's
    /// hand"; my own name reads "You" ("You are watching Alice's hand"); `mine` (the seat is my
    /// own): "Zach is watching your hand".
    static func watchLabel(_ names: [String], player: String, me: String?, mine: Bool) -> String {
        let shown = names.map { $0 == me ? "You" : $0 }
        let verb = shown.count == 1 && shown[0] != "You" ? "is" : "are"
        return "\(nameList(shown)) \(verb) watching \(mine ? "your" : "\(player)'s") hand"
    }

    /// A list row: "Zach · watching Alice", "Zach (you) · watching Alice", or just the name.
    static func rowText(_ w: Watcher, me: String?, seatName: (Int) -> String?) -> String {
        let name = w.username == me ? "\(w.username) (you)" : w.username
        guard let seat = Position.valid(w.shoulder), let player = seatName(seat), !player.isEmpty else { return name }
        return "\(name) · watching \(player)"
    }

    /// The seat eye's count: none for one watcher, "2" ... "99", "99+".
    static func eyeCount(_ n: Int) -> String? {
        n > 99 ? "99+" : n > 1 ? "\(n)" : nil
    }

    /// "Ann", "Ann and Bo", "Ann, Bo and Cy".
    private static func nameList(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + (names.last ?? "")
    }
}

extension PlayersSlice {
    /// The names of the seats somebody watches over the shoulder (the badge list's
    /// "watching <player>"; empty while nobody does).
    var watchedSeatNames: [Int: String] {
        var out: [Int: String] = [:]
        for seat in watching.watchersBySeat.keys { out[seat] = name(seat) }
        return out
    }
}
