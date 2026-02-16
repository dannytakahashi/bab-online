import SpriteKit

/// Player avatar circle with name label.
class AvatarNode: SKNode {
    private let circle: SKShapeNode
    private let label: SKLabelNode
    private let size: CGFloat

    init(username: String, size: CGFloat = LayoutConstants.avatarSize) {
        self.size = size

        circle = SKShapeNode(circleOfRadius: size / 2)
        circle.fillColor = UIColor(red: 0.2, green: 0.3, blue: 0.2, alpha: 1)
        circle.strokeColor = UIColor(white: 0.4, alpha: 1)
        circle.lineWidth = 2

        label = SKLabelNode(text: String(username.prefix(1)).uppercased())
        label.fontName = "Helvetica-Bold"
        label.fontSize = size * 0.5
        label.fontColor = .white
        label.verticalAlignmentMode = .center

        super.init()

        addChild(circle)
        addChild(label)
    }

    required init?(coder: NSCoder) {
        fatalError()
    }

    func setDisconnected(_ disconnected: Bool) {
        circle.fillColor = disconnected
            ? UIColor(red: 0.5, green: 0.2, blue: 0.2, alpha: 1)
            : UIColor(red: 0.2, green: 0.3, blue: 0.2, alpha: 1)
        alpha = disconnected ? 0.5 : 1.0
    }
}
