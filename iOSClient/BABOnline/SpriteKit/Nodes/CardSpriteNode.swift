import SpriteKit

/// A card sprite with texture, legality tinting, and tap handling.
class CardSpriteNode: SKSpriteNode {
    let card: Card
    var isLegal: Bool = true {
        didSet { updateLegality() }
    }
    var isLifted: Bool = false
    /// My /help answer's card (TableRenderModel.Hand.suggestedId): a gold ring round it
    /// ("glow.suggested"), and VoiceOver reads "<card>, suggested".
    var isSuggested: Bool = false {
        didSet { if isSuggested != oldValue { updateSuggested() } }
    }
    private var suggestedRing: SKShapeNode?
    var onTap: ((Card) -> Void)?
    /// Why this card cannot be played now (dimmed; TableRenderModel.Hand.blocked): VoiceOver's
    /// hint, and what a tap on it says (`onBlockedTap`).
    var blockedReason: String?
    var onBlockedTap: ((Card, String) -> Void)?

    override var accessibilityHint: String? {
        get { isUserInteractionEnabled && !isLegal ? blockedReason : nil }
        set { _ = newValue }
    }

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

    private func updateSuggested() {
        accessibilityLabel = isSuggested ? "\(card.displayName), suggested" : card.displayName
        if isSuggested {
            guard suggestedRing == nil else { return }
            // drawn inside the card's edge: the next card of the hand covers its right part, so the
            // ring outlines just the strip of this card that shows (outside it, it ran along the
            // neighbours' edges and read as a bracket round three cards)
            let pad: CGFloat = -2
            let ring = SKShapeNode(rect: CGRect(x: -size.width / 2 - pad, y: -size.height / 2 - pad,
                                                width: size.width + 2 * pad, height: size.height + 2 * pad), cornerRadius: 6)
            ring.role = "glow.suggested"
            ring.hideFromAccessibility()
            ring.fillColor = .clear
            ring.strokeColor = Theme.SK.suggestedRing
            ring.lineWidth = 3
            ring.isUserInteractionEnabled = false
            ring.zPosition = 0.5  // over the card, under the next card of the hand
            CardAnimations.startPulseGlow(on: ring)
            addChild(ring)
            suggestedRing = ring
        } else {
            suggestedRing?.removeFromParent()
            suggestedRing = nil
        }
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
            if let why = blockedReason { onBlockedTap?(card, why) }
            return
        }
        onTap?(card)
    }
}
