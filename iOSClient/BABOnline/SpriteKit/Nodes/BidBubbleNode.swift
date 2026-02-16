import SpriteKit

/// Floating bid display bubble.
class BidBubbleNode: SKNode {
    private let background: SKShapeNode
    private let label: SKLabelNode

    init(bid: String) {
        background = SKShapeNode(rectOf: CGSize(width: LayoutConstants.bidBubbleWidth, height: LayoutConstants.bidBubbleHeight), cornerRadius: 8)
        background.fillColor = UIColor(red: 0.15, green: 0.25, blue: 0.15, alpha: 0.9)
        background.strokeColor = UIColor(red: 0.3, green: 0.6, blue: 0.3, alpha: 1)
        background.lineWidth = 1.5

        label = SKLabelNode(text: bid)
        label.fontName = "Helvetica-Bold"
        label.fontSize = 18
        label.fontColor = .white
        label.verticalAlignmentMode = .center

        super.init()
        self.name = "bid_bubble"
        addChild(background)
        addChild(label)
    }

    required init?(coder: NSCoder) {
        fatalError()
    }

    func updateBid(_ bid: String) {
        label.text = bid
    }
}
