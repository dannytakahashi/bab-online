import SwiftUI

extension Color {
    /// Dark card-table theme colors
    enum Theme {
        static let background = Color(red: 0.08, green: 0.12, blue: 0.08)
        static let surface = Color(red: 0.12, green: 0.16, blue: 0.12)
        static let surfaceLight = Color(red: 0.18, green: 0.22, blue: 0.18)
        static let cardTable = Color(red: 0.05, green: 0.15, blue: 0.05)

        static let primary = Color(red: 0.2, green: 0.8, blue: 0.4)
        static let primaryDim = Color(red: 0.15, green: 0.5, blue: 0.25)
        static let accent = Color(red: 0.3, green: 0.9, blue: 0.5)

        static let teamColor = Color(red: 0.2, green: 0.8, blue: 0.4)
        static let oppColor = Color(red: 0.9, green: 0.3, blue: 0.3)

        static let textPrimary = Color.white
        static let textSecondary = Color(white: 0.7)
        static let textDim = Color(white: 0.5)

        static let error = Color(red: 0.9, green: 0.3, blue: 0.3)
        static let warning = Color(red: 0.9, green: 0.7, blue: 0.2)
        static let success = Color(red: 0.2, green: 0.8, blue: 0.4)

        static let inputBackground = Color(red: 0.1, green: 0.14, blue: 0.1)
        static let inputBorder = Color(white: 0.3)
        static let buttonBackground = Color(red: 0.2, green: 0.5, blue: 0.3)
        static let buttonDisabled = Color(white: 0.3)

        static let disconnectBanner = Color(red: 0.6, green: 0.2, blue: 0.2)
    }
}
