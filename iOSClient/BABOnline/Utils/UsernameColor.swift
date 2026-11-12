import SwiftUI

/// Port of the web client's djb2 hash → HSL color system (client/src/utils/colors.js).
enum UsernameColor {
    /// Hash a username to a hue value (0-359) using the djb2 algorithm.
    static func hashToHue(_ username: String) -> Double {
        var hash: Int64 = 5381
        for char in username.unicodeScalars {
            hash = ((hash << 5) &+ hash) ^ Int64(char.value)
        }
        return Double(abs(hash) % 360)
    }

    /// Generate a color for a username (hsl with 70% saturation, 60% brightness mapped to SwiftUI).
    static func color(for username: String) -> Color {
        let hue = hashToHue(username) / 360.0
        return Color(hue: hue, saturation: 0.7, brightness: 0.85)
    }

    /// Team-based color for a game position (team A for seats 1 and 3, as on the web).
    static func teamColor(for position: Int) -> Color { Theme.team(forPosition: position) }
}
