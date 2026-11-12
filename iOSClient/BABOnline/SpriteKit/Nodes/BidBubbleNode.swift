import SpriteKit

/// Floating bid display bubble.
class BidBubbleNode: SKNode {
    private let background: SKShapeNode
    private let label: SKLabelNode
    let bid: String

    init(bid: String) {
        self.bid = bid
        background = SKShapeNode(rectOf: CGSize(width: LayoutConstants.bidBubbleWidth, height: LayoutConstants.bidBubbleHeight), cornerRadius: Theme.Radius.sm)
        background.fillColor = Theme.SK.bidBubbleFill
        background.strokeColor = Theme.SK.bidBubbleStroke
        background.lineWidth = 1.5

        label = SKLabelNode(text: bid)
        label.fontName = Theme.SK.fontName(.bold)
        label.fontSize = 18
        label.fontColor = Theme.SK.label
        label.verticalAlignmentMode = .center

        super.init()
        self.name = "bid_bubble"
        speak("Bid \(bid)")  // not "bid_bubble" / "bid.2" (SpriteKit reads a named node by its name)
        label.hideFromAccessibility()
        addChild(background)
        addChild(label)
    }

    required init?(coder: NSCoder) {
        fatalError()
    }
}
