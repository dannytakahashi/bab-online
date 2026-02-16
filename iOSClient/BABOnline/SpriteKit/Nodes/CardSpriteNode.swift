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

        let texture = SKTexture(imageNamed: card.imageName)
        super.init(texture: texture, color: .clear, size: CardSpriteNode.cardSize)

        self.name = "card_\(card.id)"
        self.isUserInteractionEnabled = true
    }

    /// Create a card-back sprite
    static func cardBack() -> SKSpriteNode {
        let texture = SKTexture(imageNamed: "card_back")
        let sprite = SKSpriteNode(texture: texture, size: CGSize(
            width: LayoutConstants.opponentCardWidth,
            height: LayoutConstants.opponentCardHeight
        ))
        sprite.name = "card_back"
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
            color = .black
            colorBlendFactor = 0.5
            alpha = 0.6
        }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard isLegal else {
            HapticManager.warning()
            return
        }
        onTap?(card)
    }
}
