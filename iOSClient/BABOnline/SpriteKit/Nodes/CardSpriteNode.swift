import SpriteKit

/// A card sprite with texture, legality tinting, and tap handling.
class CardSpriteNode: SKSpriteNode {
    let card: Card
    var isLegal: Bool = true {
        didSet { updateLegality() }
    }
    var isLifted: Bool = false
    var onTap: ((Card) -> Void)?

    private static let cardSize = CGSize(
        width: LayoutConstants.cardWidth,
        height: LayoutConstants.cardHeight
    )

    init(card: Card) {
        self.card = card

        let texture = CardTextureGenerator.texture(for: card)
        super.init(texture: texture, color: .clear, size: CardSpriteNode.cardSize)

        self.name = "card_\(card.id)"
        self.isUserInteractionEnabled = true
        speak(card.displayName)
    }

    /// VoiceOver: a hand card is a button (dimmed while illegal, selected while lifted); once it
    /// is on the table (no taps) just the card.
    override var accessibilityTraits: UIAccessibilityTraits {
        get {
            guard isUserInteractionEnabled else { return .none }
            var t: UIAccessibilityTraits = .button
            if !isLegal { t.insert(.notEnabled) }
            if isLifted { t.insert(.selected) }
            return t
        }
        set { _ = newValue }
    }

    /// VoiceOver's double tap: what a touch does (lift, then play the lifted card).
    override func accessibilityActivate() -> Bool {
        guard isUserInteractionEnabled else { return false }
        handleTap()
        return true
    }

    /// Create a card-back sprite
    static func cardBack() -> SKSpriteNode {
        let texture = CardTextureGenerator.cardBackTexture()
        let sprite = SKSpriteNode(texture: texture, size: CGSize(
            width: LayoutConstants.opponentCardWidth,
            height: LayoutConstants.opponentCardHeight
        ))
        sprite.name = "card_back"
        sprite.speak("Card")
        return sprite
    }

    required init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func updateLegality() {
        if isLegal {
            colorBlendFactor = 0
            alpha = 1.0
        } else {
            // Opaque dimming (the web's card.dimTint tint, a multiply): a translucent card
            // let the overlapped cards' centre pips show through it.
            color = Theme.Palette.Card.dimTint.uiColor
            colorBlendFactor = 1
            alpha = 1.0
        }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        handleTap()
    }

    private func handleTap() {
        guard isLegal else {
            HapticManager.warning()
            return
        }
        onTap?(card)
    }
}
