import SpriteKit

/// Manages bid bubble display in SpriteKit.
class SKBidManager {
    weak var scene: GameSKScene?
    private var bidBubbles: [Int: BidBubbleNode] = [:]  // position → node

    init(scene: GameSKScene) {
        self.scene = scene
    }

    func showBid(position: Int, bid: Int, myPosition: Int) {
        guard let scene = scene else { return }
        let relPos = Positions.getRelative(target: position, from: myPosition)
        let scaleX = scene.size.width / LayoutConstants.referenceWidth
        let scaleY = scene.size.height / LayoutConstants.referenceHeight

        // Remove existing bubble for this position
        bidBubbles[position]?.removeFromParent()

        let bubble = BidBubbleNode(bid: "\(bid)")

        // Position near the player area
        switch relPos {
        case .bottom:
            bubble.position = CGPoint(x: 100 * scaleX, y: -scene.size.height / 2 + 180)
        case .top:
            bubble.position = CGPoint(x: 0, y: scene.size.height / 2 - 160 * scaleY)
        case .left:
            bubble.position = CGPoint(x: -scene.size.width / 2 + 180 * scaleX, y: 60 * scaleY)
        case .right:
            bubble.position = CGPoint(x: scene.size.width / 2 - 180 * scaleX, y: 60 * scaleY)
        }

        bubble.zPosition = 60
        bubble.alpha = 0
        scene.addChild(bubble)
        bubble.run(CardAnimations.fadeIn(duration: 0.2))

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
