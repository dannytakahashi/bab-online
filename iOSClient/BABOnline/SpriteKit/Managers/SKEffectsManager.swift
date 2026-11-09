import SpriteKit

/// Visual effects (rainbow, bore badge, over-trump badge) in the transient
/// layer, placed from the table layout.
class SKEffectsManager {
    enum EffectAnchor { case rainbow(Positions.RelativePosition), bore, overTrump }

    weak var scene: GameSKScene?
    /// Effects still up, so a relayout can move them.
    private(set) var live: [(node: SKNode, anchor: EffectAnchor)] = []

    init(scene: GameSKScene) {
        self.scene = scene
    }

    /// Rainbow over a seat (rainbow1, 128x118).
    func showRainbow(position: Int, myPosition: Int) {
        guard let scene = scene else { return }
        let rel = Positions.getRelative(target: position, from: myPosition)
        let sprite = SKSpriteNode(texture: SKTexture(imageNamed: "rainbow1"), size: TableLayout.rainbowSize)
        sprite.name = "effect.rainbow"
        sprite.position = scene.layout.rainbowCenter(rel)
        sprite.zPosition = 1000
        sprite.setScale(0)
        scene.transientLayer.addChild(sprite)
        track(sprite, .rainbow(rel))

        let scaleIn = SKAction.scale(to: 1.0, duration: 0.5)
        scaleIn.timingMode = .easeOut
        let wait = SKAction.wait(forDuration: 2.0)
        let fadeOut = SKAction.fadeOut(withDuration: 1.0)

        scene.animator.run(sprite, SKAction.sequence([scaleIn, wait, fadeOut, SKAction.removeFromParent()])) { $0.removeFromParent() }
    }

    /// Bore badge at the trick cluster's center.
    func showBoreBadge(_ level: String) {
        guard let scene = scene else { return }

        let textureName: String
        switch level {
        case "B":  textureName = "b"
        case "2B": textureName = "2b"
        case "3B": textureName = "3b"
        case "4B": textureName = "4b"
        default: return
        }

        let texture = SKTexture(imageNamed: textureName)
        let badge = SKSpriteNode(texture: texture, size: CGSize(width: 80, height: 80))
        badge.name = "effect.bore"
        badge.position = scene.layout.boreBadgeCenter
        badge.zPosition = 500
        badge.alpha = 0
        badge.setScale(0.5)
        scene.transientLayer.addChild(badge)
        track(badge, .bore)

        scene.animator.run(badge, SKAction.sequence([
            SKAction.group([
                SKAction.fadeIn(withDuration: 0.3),
                SKAction.scale(to: 1.2, duration: 0.3),
            ]),
            SKAction.wait(forDuration: 1.5),
            SKAction.group([
                SKAction.fadeOut(withDuration: 0.5),
                SKAction.scale(to: 0.8, duration: 0.5),
            ]),
            SKAction.removeFromParent(),
        ])) { $0.removeFromParent() }
    }

    /// Over-trump (OT) badge, top-left of the trick cluster.
    func showOverTrump() {
        guard let scene = scene else { return }

        let texture = SKTexture(imageNamed: "ot")
        let badge = SKSpriteNode(texture: texture, size: CGSize(width: TableLayout.overTrumpSize, height: TableLayout.overTrumpSize))
        badge.name = "effect.overTrump"
        badge.position = scene.layout.overTrumpCenter
        badge.zPosition = 999
        badge.setScale(0)
        scene.transientLayer.addChild(badge)
        track(badge, .overTrump)

        let scaleIn = SKAction.scale(to: 1.0, duration: 0.5)
        scaleIn.timingMode = .easeOut
        let wait = SKAction.wait(forDuration: 1.5)
        let fadeOut = SKAction.fadeOut(withDuration: 1.0)

        scene.animator.run(badge, SKAction.sequence([scaleIn, wait, fadeOut, SKAction.removeFromParent()])) { $0.removeFromParent() }
    }

    private func track(_ node: SKNode, _ anchor: EffectAnchor) {
        live.removeAll { $0.node.parent == nil }
        live.append((node, anchor))
    }

    static func point(_ anchor: EffectAnchor, in layout: TableLayout) -> CGPoint {
        switch anchor {
        case .rainbow(let rel): return layout.rainbowCenter(rel)
        case .bore: return layout.boreBadgeCenter
        case .overTrump: return layout.overTrumpCenter
        }
    }

    /// Relayout: effects still up move to their new layout point.
    func apply(layout: TableLayout) {
        live.removeAll { $0.node.parent == nil }
        for e in live { e.node.position = Self.point(e.anchor, in: layout) }
    }

    func cleanup() {
        // Effects clean themselves up via removeFromParent
        live.removeAll()
    }
}
