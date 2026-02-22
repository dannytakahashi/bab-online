import SpriteKit

/// Displays an opponent's name label, turn glow, and bid bubble.
/// Card-back fans are removed; opponents are lightweight anchors.
class OpponentHandNode: SKNode {
    let relativePosition: Positions.RelativePosition

    private let nameLabel: SKLabelNode
    private var turnGlow: SKShapeNode?

    init(position: Positions.RelativePosition, username: String) {
        self.relativePosition = position

        nameLabel = SKLabelNode(text: username)
        nameLabel.fontName = "Helvetica-Bold"
        nameLabel.fontSize = 14
        nameLabel.fontColor = .white

        super.init()

        self.name = "opponent_\(position.rawValue)"

        // Position name label
        switch position {
        case .top:
            nameLabel.position = CGPoint(x: 0, y: 30)
        case .left:
            nameLabel.position = CGPoint(x: 0, y: 30)
        case .right:
            nameLabel.position = CGPoint(x: 0, y: 30)
        default:
            nameLabel.position = CGPoint(x: 0, y: -30)
        }
        addChild(nameLabel)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    func updateUsername(_ name: String) {
        nameLabel.text = name
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

    func cleanup() {
        turnGlow?.removeFromParent()
        turnGlow = nil
    }
}
