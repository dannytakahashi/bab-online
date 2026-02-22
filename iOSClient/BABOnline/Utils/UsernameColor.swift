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

    /// Team 1 color (positions 1, 3) — matches web client's #63b3ed
    static let team1Color = Color(red: 0x63 / 255.0, green: 0xb3 / 255.0, blue: 0xed / 255.0)

    /// Team 2 color (positions 2, 4) — matches web client's #fc8181
    static let team2Color = Color(red: 0xfc / 255.0, green: 0x81 / 255.0, blue: 0x81 / 255.0)

    /// Get team-based color for a game position.
    static func teamColor(for position: Int) -> Color {
        (position == 1 || position == 3) ? team1Color : team2Color
    }
}
