import SwiftUI

/// Port of the web client's djb2 hash → HSL color system (client/src/utils/colors.js).
enum UsernameColor {
    /// Hash a username to a hue value (0-359) using the djb2 algorithm, exactly as the web's
    /// `hashToHue`: JavaScript's bit operators work on 32-bit integers and `charCodeAt` reads
    /// UTF-16 code units, so the hash wraps at 32 bits over the UTF-16 units (before 1.2.6 it
    /// ran in 64 bits over Unicode scalars, which gave a name of more than six letters
    /// another colour than on the web).
    static func hashToHue(_ username: String) -> Double {
        var hash: Int32 = 5381
        for unit in username.utf16 {
            hash = ((hash &<< 5) &+ hash) ^ Int32(unit)
        }
        return Double(abs(Int64(hash)) % 360)
    }

    /// Generate a color for a username (hsl with 70% saturation, 60% brightness mapped to SwiftUI).
    static func color(for username: String) -> Color {
        color(hue: hashToHue(username))
    }

    /// A chat name's colour from its hue (0-359).
    static func color(hue: Double) -> Color {
        Color(hue: hue / 360.0, saturation: 0.7, brightness: 0.85)
    }

    /// Hues closer than this are "the same colour" (the web's `generateDistinctColor`).
    static let minHueDistance: Double = 50
    /// The step a hue moves by until it is clear of the others (a prime, as on the web).
    static let hueStep: Double = 67

    /// One chat's names, each a hue at least `minHueDistance` from the names before it where
    /// that can be found (owner 2026-11-24: in a tournament lobby's chat two players' names
    /// were similar shades of green). The web's `generateDistinctColor`
    /// (client/src/utils/colors.js), which its main room, game lobby and tournament lobby chats
    /// use (since 7b7eaf0a): the first name keeps its own hash hue, each new name in order of
    /// first appearance moves by `hueStep` until it is clear of every earlier one (at most 360
    /// tries; with more names than fit it keeps the last try). Pure: the chat views compute it
    /// from their message list, so a name keeps its colour while the chat lasts.
    static func distinctHues(_ usernames: [String]) -> [String: Double] {
        var hues: [String: Double] = [:]
        var taken: [Double] = []
        for name in usernames where hues[name] == nil {
            var hue = hashToHue(name)
            var attempts = 0
            while attempts < 360, !taken.isEmpty, taken.contains(where: { hueDistance($0, hue) < minHueDistance }) {
                hue = (hue + hueStep).truncatingRemainder(dividingBy: 360)
                attempts += 1
            }
            hues[name] = hue
            taken.append(hue)
        }
        return hues
    }

    /// The names a chat colours, in order (system lines have none).
    static func distinctHues(for messages: [ChatMessage]) -> [String: Double] {
        distinctHues(messages.filter { $0.type != .system }.map(\.username))
    }

    static func hueDistance(_ a: Double, _ b: Double) -> Double {
        let d = abs(a - b)
        return min(d, 360 - d)
    }

    /// Team-based color for a game position (team A for seats 1 and 3, as on the web).
    static func teamColor(for position: Int) -> Color { Theme.team(forPosition: position) }
}
