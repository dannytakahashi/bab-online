import SpriteKit
import UIKit

/// The seat eye (TableLayout+Watchers.swift): a small pill with an eye ("eye.fill", as the
/// spectator badge's) and the count past one, on a seat whose hand somebody watches. Drawn only;
/// VoiceOver reads it from GameContainerView's element over it (`SeatWatchAccessibility`), as the
/// dealer marker. Made only once a seat is watched, so a table nobody watches over the shoulder
/// has no such node at all.
final class WatchChipNode: SKNode {
    static let roleName = "watch"
    private(set) var count = 0

    override init() {
        super.init()
        role = Self.roleName
        zPosition = 3
        hideFromAccessibility()
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Show `n` watchers (0: hidden); redrawn only when the count changes.
    func update(count n: Int) {
        isHidden = n <= 0
        guard n != count else { return }
        count = n
        removeAllChildren()
        guard n > 0 else { return }
        let size = TableLayout.watchChipSize(count: n)
        let pill = SKShapeNode(rect: CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height),
                               cornerRadius: size.height / 2)
        pill.role = "watch.pill"
        pill.fillColor = Theme.SK.avatarFill
        pill.strokeColor = Theme.SK.avatarStroke
        pill.lineWidth = 1
        pill.hideFromAccessibility()
        addChild(pill)
        let eye = SKSpriteNode(texture: Self.eyeTexture, size: Self.eyeSize)
        eye.role = "watch.eye"
        eye.zPosition = 1
        eye.hideFromAccessibility()
        addChild(eye)
        guard let text = WatchingList.eyeCount(n) else {
            eye.position = .zero
            return
        }
        eye.position = CGPoint(x: -size.width / 2 + 3 + Self.eyeSize.width / 2, y: 0)
        let label = SKLabelNode(text: text)
        label.role = "watch.count"
        label.fontName = Theme.SK.fontName(.bold)
        label.fontSize = 10
        label.drawForTableZoom()
        label.fontColor = Theme.SK.label
        label.verticalAlignmentMode = .center
        label.horizontalAlignmentMode = .right
        label.position = CGPoint(x: size.width / 2 - 4, y: 0)
        label.zPosition = 1
        label.hideFromAccessibility()
        addChild(label)
    }

    /// The eye's drawn size (points).
    static let eyeSize = CGSize(width: 12, height: 8)

    /// "eye.fill" in text.primary, drawn at the table's zoom once per process.
    private static let eyeTexture: SKTexture = {
        let k = CardTextureGenerator.textureZoom
        let config = UIImage.SymbolConfiguration(pointSize: 9 * k, weight: .bold)
        let side = CGSize(width: eyeSize.width * k, height: eyeSize.height * k)
        let image = UIGraphicsImageRenderer(size: side).image { _ in
            guard let symbol = UIImage(systemName: "eye.fill", withConfiguration: config)?
                .withTintColor(Theme.SK.label, renderingMode: .alwaysOriginal) else { return }
            let s = symbol.size
            let f = min(side.width / max(s.width, 1), side.height / max(s.height, 1))
            let w = s.width * f, h = s.height * f
            symbol.draw(in: CGRect(x: (side.width - w) / 2, y: (side.height - h) / 2, width: w, height: h))
        }
        let texture = SKTexture(image: image)
        texture.filteringMode = .linear
        return texture
    }()
}

extension SKNode {
    /// This node's seat eye, made on first use (`make`), else nil while it has none.
    func watchChip(make: Bool) -> WatchChipNode? {
        if let chip = children.first(where: { $0.role == WatchChipNode.roleName }) as? WatchChipNode { return chip }
        guard make else { return nil }
        let chip = WatchChipNode()
        addChild(chip)
        return chip
    }
}

extension OpponentHandNode {
    /// The seat eye at `chip` (scene coordinates) for `count` watchers of this seat's hand.
    func setWatchers(_ count: Int, chip: CGRect, anchor: CGPoint) {
        guard let node = watchChip(make: count > 0) else { return }
        node.position = CGPoint(x: chip.midX - anchor.x, y: chip.midY - anchor.y)
        node.update(count: count)
    }
}

extension SKOpponentManager {
    /// Every seat's eye from the model's watching list (none: nothing is made or changed).
    func applyWatchers(_ model: TableRenderModel, layout: TableLayout) {
        let bySeat = model.watching.watchersBySeat
        for o in model.opponents {
            guard let node = nodes[o.position] else { continue }
            let n = bySeat[o.position]?.count ?? 0
            guard n > 0 || node.watchChip(make: false) != nil else { continue }
            let chip = n > 0 ? layout.watchChip(o.rel, count: n, spectating: model.hand == nil) : .zero
            node.setWatchers(n, chip: chip, anchor: layout.seatAnchor(o.rel))
        }
    }
}

extension GameSKScene {
    /// My own seat's eye (seated: by my hand, under the hand's cards as my dealer marker, so a
    /// lifted card covers it), from the model alone.
    func placeMyWatchers(_ model: TableRenderModel) {
        let me = model.hand != nil && model.showsTable ? model.viewPosition : nil
        let n = me.map { model.watching.watchersBySeat[$0]?.count ?? 0 } ?? 0
        guard let node = watchChip(make: n > 0) else { return }
        node.zPosition = -1
        let chip = layout.myWatchChip(handCount: model.hand?.cards.count ?? 0, count: max(n, 1))
        node.position = CGPoint(x: chip.midX, y: chip.midY)
        node.update(count: n)
    }
}
