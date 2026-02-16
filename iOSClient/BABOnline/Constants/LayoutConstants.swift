import Foundation

enum LayoutConstants {
    /// Reference scene size matching web client
    static let referenceWidth: CGFloat = 1920
    static let referenceHeight: CGFloat = 953

    /// Card dimensions (base)
    static let cardWidth: CGFloat = 100
    static let cardHeight: CGFloat = 145

    /// Card spacing in hand
    static let cardOverlap: CGFloat = 35
    static let cardOverlapCompact: CGFloat = 25

    /// Card lift when selected
    static let cardLiftY: CGFloat = 20

    /// Opponent card back size
    static let opponentCardWidth: CGFloat = 50
    static let opponentCardHeight: CGFloat = 72

    /// Trick area offsets from center
    static let trickOffsetX: CGFloat = 80
    static let trickOffsetY: CGFloat = 80

    /// Avatar size
    static let avatarSize: CGFloat = 48

    /// Bid bubble size
    static let bidBubbleWidth: CGFloat = 60
    static let bidBubbleHeight: CGFloat = 36

    /// Draw phase
    static let drawCardSpacing: CGFloat = 120
    static let drawCardScale: CGFloat = 1.0

    /// Animation durations
    static let dealDuration: TimeInterval = 0.3
    static let playCardDuration: TimeInterval = 0.25
    static let collectTrickDuration: TimeInterval = 0.4
    static let flipCardDuration: TimeInterval = 0.2

    /// iPhone vs iPad thresholds
    static let compactWidthThreshold: CGFloat = 700
}
