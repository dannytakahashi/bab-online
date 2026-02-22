import SpriteKit

/// Manages bid bubble display in SpriteKit.
class SKBidManager {
    weak var scene: GameSKScene?
    private var bidBubbles: [Int: BidBubbleNode] = [:]  // position → node

    init(scene: GameSKScene) {
        self.scene = scene
    }

    func showBid(position: Int, bid: String, myPosition: Int) {
        guard let scene = scene else { return }
        let relPos = Positions.getRelative(target: position, from: myPosition)
        let halfW = scene.size.width / 2
        let halfH = scene.size.height / 2

        // Remove existing bubble for this position
        bidBubbles[position]?.removeFromParent()

        let bubble = BidBubbleNode(bid: bid)

        // Position near each player — offset below names to avoid overlap
        switch relPos {
        case .bottom:
            bubble.position = CGPoint(x: 80, y: -halfH + 280)
        case .top:
            bubble.position = CGPoint(x: 0, y: halfH - 250)
        case .left:
            bubble.position = CGPoint(x: -halfW + 60, y: -30)
        case .right:
            bubble.position = CGPoint(x: halfW - 60, y: -30)
        }

        bubble.zPosition = 60
        bubble.alpha = 0
        scene.addChild(bubble)

        // Fade in, hold for 5s, then fade out and remove
        let fadeIn = CardAnimations.fadeIn(duration: 0.2)
        let wait = SKAction.wait(forDuration: 5.0)
        let fadeOut = SKAction.fadeOut(withDuration: 0.3)
        let remove = SKAction.run { [weak self] in
            bubble.removeFromParent()
            self?.bidBubbles.removeValue(forKey: position)
        }
        bubble.run(SKAction.sequence([fadeIn, wait, fadeOut, remove]))

        bidBubbles[position] = bubble
    }

    func clearAll() {
        bidBubbles.values.forEach { $0.removeFromParent() }
        bidBubbles.removeAll()
    }

    func cleanup() {
        clearAll()
    }
}
