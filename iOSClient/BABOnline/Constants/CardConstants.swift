import Foundation

enum CardConstants {
    /// Rank values for comparing cards (higher = better)
    static let rankValues: [Rank: Int] = [
        .hi: 16, .lo: 15, .ace: 14, .king: 13, .queen: 12, .jack: 11,
        .ten: 10, .nine: 9, .eight: 8, .seven: 7, .six: 6,
        .five: 5, .four: 4, .three: 3, .two: 2,
    ]

    /// Rank order for sorting (low to high)
    static let rankOrder: [Rank] = [
        .two, .three, .four, .five, .six, .seven, .eight,
        .nine, .ten, .jack, .queen, .king, .ace,
    ]

    /// All standard suits
    static let suits: [Suit] = [.spades, .hearts, .diamonds, .clubs]

    /// Hand progression for the game: 12→10→8→6→4→2→1→3→5→7→9→11→13
    static let handProgression = [12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13]

    /// Total number of hands in a game
    static let totalHands = 13
}
