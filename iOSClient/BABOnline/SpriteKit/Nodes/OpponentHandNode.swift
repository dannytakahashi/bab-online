import SpriteKit

/// Displays an opponent's hand as face-down cards with username and bid bubble.
class OpponentHandNode: SKNode {
    let relativePosition: Positions.RelativePosition

    private var cardBacks: [SKSpriteNode] = []
    private let nameLabel: SKLabelNode
    private var turnGlow: SKShapeNode?
    private var bidLabel: SKLabelNode?

    var cardCount: Int = 0 {
        didSet { updateCardBacks() }
    }

    init(position: Positions.RelativePosition, username: String) {
        self.relativePosition = position

        nameLabel = SKLabelNode(text: username)
        nameLabel.fontName = "Helvetica-Bold"
        nameLabel.fontSize = 14
        nameLabel.fontColor = .white

        super.init()

        self.name = "opponent_\(position.rawValue)"

        // Position name label relative to cards
        switch position {
        case .top:
            nameLabel.position = CGPoint(x: 0, y: 60)
        case .left:
            nameLabel.position = CGPoint(x: 0, y: 60)
        case .right:
            nameLabel.position = CGPoint(x: 0, y: 60)
        default:
            nameLabel.position = CGPoint(x: 0, y: -60)
        }
        addChild(nameLabel)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    func updateUsername(_ name: String) {
        nameLabel.text = name
    }

    private func updateCardBacks() {
        cardBacks.forEach { $0.removeFromParent() }
        cardBacks = []

        guard cardCount > 0 else { return }

        let isVertical = relativePosition == .left || relativePosition == .right
        let spacing: CGFloat = isVertical ? 12 : 18
        let totalSpan = spacing * CGFloat(cardCount - 1)
        let startOffset = -totalSpan / 2

        for i in 0..<cardCount {
            let back = CardSpriteNode.cardBack()
            if isVertical {
                back.position = CGPoint(x: 0, y: startOffset + CGFloat(i) * spacing)
                back.zRotation = .pi / 2
            } else {
                back.position = CGPoint(x: startOffset + CGFloat(i) * spacing, y: 0)
            }
            back.zPosition = CGFloat(i)
            addChild(back)
            cardBacks.append(back)
        }
    }

    /// Remove one card back (when opponent plays)
    func removeOneCard(animateTo point: CGPoint, completion: (() -> Void)? = nil) {
        guard let last = cardBacks.popLast() else {
            completion?()
            return
        }
        cardCount = max(0, cardCount - 1)

        let worldPos = convert(last.position, to: scene!)
        last.removeFromParent()
        last.position = worldPos
        scene!.addChild(last)

        last.run(CardAnimations.playToTrickArea(x: point.x, y: point.y)) {
            last.removeFromParent()
            completion?()
        }
    }

    // MARK: - Turn Glow

    func showTurnGlow() {
        guard turnGlow == nil else { return }
        let glow = SKShapeNode(circleOfRadius: 30)
        glow.fillColor = UIColor(red: 0.2, green: 0.8, blue: 0.4, alpha: 0.5)
        glow.strokeColor = .clear
        glow.zPosition = -1
        glow.run(CardAnimations.pulseGlow())
        addChild(glow)
        turnGlow = glow
    }

    func hideTurnGlow() {
        turnGlow?.removeFromParent()
        turnGlow = nil
    }

    // MARK: - Bid Bubble

    func showBid(_ bid: Int) {
        bidLabel?.removeFromParent()

        let label = SKLabelNode(text: "\(bid)")
        label.fontName = "Helvetica-Bold"
        label.fontSize = 16
        label.fontColor = .white

        let bg = SKShapeNode(rectOf: CGSize(width: LayoutConstants.bidBubbleWidth, height: LayoutConstants.bidBubbleHeight), cornerRadius: 8)
        bg.fillColor = UIColor(red: 0.2, green: 0.3, blue: 0.2, alpha: 0.9)
        bg.strokeColor = UIColor(red: 0.3, green: 0.6, blue: 0.3, alpha: 1)

        label.position = CGPoint(x: 0, y: -6)
        bg.addChild(label)

        switch relativePosition {
        case .top:    bg.position = CGPoint(x: 0, y: -60)
        case .left:   bg.position = CGPoint(x: 60, y: 0)
        case .right:  bg.position = CGPoint(x: -60, y: 0)
        default:      bg.position = CGPoint(x: 0, y: 60)
        }
        bg.zPosition = 50
        addChild(bg)
        bidLabel = label
    }

    func clearBid() {
        bidLabel?.parent?.removeFromParent()
        bidLabel = nil
    }

    func cleanup() {
        cardBacks.forEach { $0.removeFromParent() }
        cardBacks = []
        turnGlow?.removeFromParent()
        turnGlow = nil
        bidLabel?.parent?.removeFromParent()
        bidLabel = nil
    }
}
