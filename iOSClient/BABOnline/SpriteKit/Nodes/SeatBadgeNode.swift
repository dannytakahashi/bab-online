import SpriteKit

/// A seat's avatar badge (State/Table/SeatBadges.swift, TableLayout+Badges.swift): a small dark
/// disc with a glyph, "lightbulb.fill" in gold (a counted /help on the seat's open turn) or
/// "graduationcap.fill" in primary (its tutorial on). A glyph on a dark disc, so it reads neither
/// as the gold dealer "D" (a gold disc with a letter, beside the avatar's middle) nor as the green
/// speaking ring (a ring round the avatar). Drawn only: VoiceOver hears it on the seat's name
/// element (OpponentHandNode.setBadge). The watching pill draws the watched seat's in SwiftUI
/// (SeatBadgeChip, Theme.Badge: the same disc, glyphs and colours). Made only once a seat shows one, so a table nobody badges
/// has no such node at all; hidden after that while the seat has none.
final class SeatBadgeNode: SKNode {
    static let roleName = "badge"
    private(set) var badge: SeatBadge?

    override init() {
        super.init()
        role = Self.roleName
        zPosition = 3
        hideFromAccessibility()
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Show `b` (nil: hidden); redrawn only when it changes.
    func update(_ b: SeatBadge?) {
        isHidden = b == nil
        guard b != badge else { return }
        badge = b
        removeAllChildren()
        removeAllActions()  // a pop in flight (the badge runs nothing else)
        setScale(1)
        alpha = 1
        guard let b else { return }
        let disc = SKShapeNode(circleOfRadius: TableLayout.seatBadge / 2 - 0.5)
        disc.role = "badge.disc"
        disc.fillColor = Theme.SK.badgeFill
        disc.strokeColor = Theme.SK.badgeEdge
        disc.lineWidth = 1
        disc.hideFromAccessibility()
        addChild(disc)
        let glyph = SKSpriteNode(texture: Self.texture(b), size: Self.glyphSize)
        glyph.role = "badge.\(b.rawValue)"
        glyph.zPosition = 1
        glyph.hideFromAccessibility()
        addChild(glyph)
    }

    /// The lightbulb's one pop (the live /help notice): up a little and back, `popDuration` in
    /// all; under Reduce Motion a fade in place. A pure function of nothing but the node: a
    /// relayout or a render meanwhile leaves it running.
    func pop(animator: Animator, reduceMotion: Bool = Theme.Motion.reduceMotion) {
        removeAllActions()  // Animator.run is unkeyed: a pop in flight is the only action
        let action: SKAction
        if reduceMotion {
            alpha = 0
            action = SKAction.fadeIn(withDuration: Self.popDuration)
        } else {
            setScale(1)
            let up = SKAction.scale(to: Self.popScale, duration: Self.popDuration * 0.4)
            up.timingMode = .easeOut
            let settle = SKAction.scale(to: 1, duration: Self.popDuration * 0.6)
            settle.timingMode = .easeInEaseOut
            action = SKAction.sequence([up, settle])
        }
        animator.run(self, SKAction.sequence([action, SKAction.run { [weak self] in self?.setScale(1); self?.alpha = 1 }])) {
            $0.setScale(1)
            $0.alpha = 1
        }
    }

    static let popDuration: TimeInterval = 0.25
    static let popScale: CGFloat = 1.3

    /// The glyph's drawn size (points).
    static let glyphSize = CGSize(width: 11, height: 11)

    static func texture(_ b: SeatBadge) -> SKTexture { b == .bulb ? bulbTexture : capTexture }
    private static let bulbTexture = makeTexture(SeatBadge.bulb.symbol, Theme.SK.badgeBulb)
    private static let capTexture = makeTexture(SeatBadge.cap.symbol, Theme.SK.badgeCap)

    /// `symbol` in `colour`, drawn at the table's zoom once per process (WatchChipNode's eye).
    private static func makeTexture(_ symbol: String, _ colour: PlatformColor) -> SKTexture {
        let k = CardTextureGenerator.textureZoom
        let side = CGSize(width: glyphSize.width * k, height: glyphSize.height * k)
        let image = BitmapRenderer.screenImage(size: side) { _ in
            guard let s = PlatformImage.tintedSymbol(symbol, pointSize: 10 * k, weight: .semibold, colour: colour) else { return }
            let f = min(side.width / max(s.size.width, 1), side.height / max(s.size.height, 1))
            let w = s.size.width * f, h = s.size.height * f
            s.draw(in: CGRect(x: (side.width - w) / 2, y: (side.height - h) / 2, width: w, height: h))
        }
        let texture = SKTexture.make(image)
        texture.filteringMode = .linear
        return texture
    }
}

extension OpponentHandNode {
    /// This seat's badge node, made on first use (`make`), else nil while it has none.
    func badgeNode(make: Bool) -> SeatBadgeNode? {
        if let node = children.first(where: { $0.role == SeatBadgeNode.roleName }) as? SeatBadgeNode { return node }
        guard make else { return nil }
        let node = SeatBadgeNode()
        addChild(node)
        return node
    }

    /// The badge `b` at `chip` (scene coordinates; nil: none), and the seat's name element's words.
    func setBadge(_ b: SeatBadge?, chip: CGRect?, anchor: CGPoint) {
        spokenBadge = b
        guard let node = badgeNode(make: b != nil) else { return }
        if let chip { node.position = CGPoint(x: chip.midX - anchor.x, y: chip.midY - anchor.y) }
        node.update(b)
    }
}

extension SKOpponentManager {
    /// Every seat's badge from the model (none: nothing is made or changed).
    func applyBadges(_ model: TableRenderModel, layout: TableLayout) {
        for o in model.opponents {
            guard let node = nodes[o.position] else { continue }
            guard o.badge != nil || node.badgeNode(make: false) != nil else { continue }
            let chip = o.badge != nil ? layout.seatBadge(o, model: model) : nil
            node.setBadge(o.badge, chip: chip, anchor: layout.seatAnchor(o.rel))
        }
    }

    /// The live /help notice's pop on `position`'s lightbulb (rendered by now); false: no
    /// lightbulb there (my own seat, a cap wins).
    @discardableResult
    func popBadge(position: Int, animator: Animator) -> Bool {
        guard let badge = nodes[position]?.badgeNode(make: false), badge.badge == .bulb, !badge.isHidden else { return false }
        badge.pop(animator: animator)
        return true
    }
}
