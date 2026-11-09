import SpriteKit

/// Bid bubbles from state (`bid.<pos>`): up from the bid until the hand's
/// first card; a new bid pops.
class SKBidManager {
    let layer: SKNode
    private(set) var bubbles: [Int: BidBubbleNode] = [:]

    init(layer: SKNode) { self.layer = layer }

    func apply(bubbles wanted: [Int: String], viewPosition: Int, geometry: TableGeometry) {
        for (pos, node) in bubbles where wanted[pos] == nil {
            node.removeFromParent()
            bubbles[pos] = nil
        }
        for (pos, bid) in wanted {
            let node: BidBubbleNode
            if let existing = bubbles[pos], existing.bid == bid {
                node = existing
            } else {
                bubbles[pos]?.removeFromParent()
                node = BidBubbleNode(bid: bid)
                node.zPosition = 60
                layer.addChild(node)
                bubbles[pos] = node
            }
            node.name = "bid.\(pos)"
            if !node.hasActions() { node.position = geometry.bubbleAnchor(Positions.getRelative(target: pos, from: viewPosition)) }
        }
    }

    func pop(position: Int, animator: Animator) {
        guard let node = bubbles[position] else { return }
        animator.pop(node)
    }

    func cleanup() {
        bubbles.values.forEach { $0.removeFromParent() }
        bubbles.removeAll()
    }
}

/// Chat bubbles above the speaker's seat (22.6): transient, one per seat,
/// replaced by a newer message, gone after LayoutConstants.bubbleLifetime.
class SKChatBubbleManager {
    let layer: SKNode
    private var bubbles: [Int: SKNode] = [:]

    init(layer: SKNode) { self.layer = layer }

    func show(position: Int, message: String, viewPosition: Int, geometry: TableGeometry, animator: Animator) {
        bubbles[position]?.removeFromParent()
        let label = SKLabelNode(text: message.count > 40 ? String(message.prefix(39)) + "\u{2026}" : message)
        label.fontName = "Helvetica"
        label.fontSize = 13
        label.fontColor = .black
        label.verticalAlignmentMode = .center
        let bg = SKShapeNode(rectOf: CGSize(width: max(40, label.frame.width + 16), height: 26), cornerRadius: 10)
        bg.fillColor = UIColor(white: 1, alpha: 0.92)
        bg.strokeColor = .clear
        let bubble = SKNode()
        bubble.name = "chat.\(position)"
        bubble.addChild(bg)
        bubble.addChild(label)
        bubble.zPosition = 80
        bubble.position = geometry.chatAnchor(Positions.getRelative(target: position, from: viewPosition))
        layer.addChild(bubble)
        bubbles[position] = bubble
        animator.fadeAndRemove(bubble, after: LayoutConstants.bubbleLifetime)
    }
}
