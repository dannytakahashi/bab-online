import SpriteKit

/// A seat's remaining cards as a fan of card backs (the web's
/// OpponentManager fans; TableLayout+Fans.swift): the red lattice back at the
/// fan's size, one sprite per card, drawn idempotently from the count. Nothing
/// here has a `name` (SeatPipsNode's rule); GameContainerView's fan elements
/// speak the counts ("kim: 5 cards").
final class CardFanNode: SKNode {
    /// The backs shown now (0: none).
    private(set) var count = 0

    override init() {
        super.init()
        role = "fan"
        zPosition = 1
        hideFromAccessibility()
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The back at the largest fan card's on-screen size (the roomy scale at the device's
    /// largest zoom), once per process:
    /// `cardBackImage(width:)` hints the lattice for the pixels it gets.
    static let backTexture: SKTexture = {
        let texture = SKTexture(image: CardTextureGenerator.cardBackImage(width: CardFanNode.textureWidth))
        texture.filteringMode = .linear
        return texture
    }()

    /// The texture's width in points: a back at the largest fan scale and table zoom.
    static var textureWidth: CGFloat { TableLayout.fanCard.width * (TableLayout.fanScales.max() ?? 1) * CardTextureGenerator.textureZoom }

    /// Show `n` backs (TableLayout.fanSlots): the same children for the same count.
    func update(count n: Int) {
        let n = min(max(n, 0), TableLayout.fanMaxCards)
        guard n != count else { return }
        count = n
        removeAllChildren()
        for (i, slot) in TableLayout.fanSlots(count: n).enumerated() {
            let back = SKSpriteNode(texture: Self.backTexture, size: TableLayout.fanCard)
            back.role = "fan.card"
            back.position = slot.center
            back.zRotation = slot.rotation
            back.zPosition = CGFloat(i) * 0.01
            back.hideFromAccessibility()
            addChild(back)
        }
    }
}

/// The dealer marker: a gold "D" button (the web shows its frog on the
/// dealer's seat). Hidden unless its seat dealt this hand.
final class DealerChipNode: SKNode {
    private(set) var isShown = false

    override init() {
        super.init()
        role = "dealer"
        zPosition = 3
        hideFromAccessibility()
        isHidden = true
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(shown: Bool) {
        guard shown != isShown else { return }
        isShown = shown
        isHidden = !shown
        removeAllChildren()
        guard shown else { return }
        let disc = SKShapeNode(circleOfRadius: TableLayout.dealerChip / 2 - 0.75)
        disc.role = "dealer.disc"
        disc.fillColor = Theme.SK.dealerFill
        disc.strokeColor = Theme.SK.dealerEdge
        disc.lineWidth = 1.5
        disc.hideFromAccessibility()
        addChild(disc)
        let label = SKLabelNode(text: "D")
        label.fontName = Theme.SK.fontName(.heavy)
        label.fontSize = 11
        label.drawForTableZoom()
        label.fontColor = Theme.SK.dealerInk
        label.verticalAlignmentMode = .center
        label.horizontalAlignmentMode = .center
        label.zPosition = 1
        label.hideFromAccessibility()
        addChild(label)
    }
}

extension OpponentHandNode {
    /// The seat's card backs: `count` cards in the layout's fan box (scene coordinates), or
    /// none where the table has no room for fans (`box` nil).
    func setFan(count: Int, box: CGRect?, anchor: CGPoint) {
        guard let box else {
            fanNode.update(count: 0)
            fanNode.position = .zero
            fanNode.setScale(1)
            return
        }
        // the slots are scale 1's: the node carries the table's fan scale (the box's)
        fanNode.setScale(TableLayout.fanScale(of: box))
        fanNode.position = CGPoint(x: box.midX - anchor.x, y: box.midY - anchor.y)
        fanNode.update(count: count)
    }

    /// The dealer marker at `chip` (scene coordinates) when this seat dealt.
    func setDealer(_ dealer: Bool, chip: CGRect, anchor: CGPoint) {
        dealerNode.position = dealer ? CGPoint(x: chip.midX - anchor.x, y: chip.midY - anchor.y) : .zero
        dealerNode.update(shown: dealer)
    }
}
