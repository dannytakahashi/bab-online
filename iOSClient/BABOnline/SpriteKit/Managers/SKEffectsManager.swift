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

    /// The art's own aspect inside `box` (centered fit): the PNGs are not the
    /// boxes' shape (b.png 218x193, 3b.png 262x296, ot.png 302x293).
    static func fit(_ texture: SKTexture, in box: CGSize) -> CGSize {
        let t = texture.size()
        guard t.width > 0, t.height > 0 else { return box }
        let k = min(box.width / t.width, box.height / t.height)
        return CGSize(width: t.width * k, height: t.height * k)
    }

    /// The bore badge's box (it peaks at 1.2x in its animation).
    static let boreBox = CGSize(width: 80, height: 80)

    /// What VoiceOver reads for the bore badge ("B" bore, "2B" double bore, ...).
    static func boreLabel(_ level: String) -> String {
        switch level {
        case "2B": return "Double bore"
        case "3B": return "Triple bore"
        case "4B": return "Quadruple bore"
        default: return "Bore"
        }
    }

    static func boreTextureName(_ level: String) -> String? {
        switch level {
        case "B": return "b"
        case "2B": return "2b"
        case "3B": return "3b"
        case "4B": return "4b"
        default: return nil
        }
    }

    /// Rainbow over a seat (rainbow1, 128x118).
    func showRainbow(position: Int, myPosition: Int) {
        guard let scene = scene else { return }
        let rel = Positions.getRelative(target: position, from: myPosition)
        let texture = SKTexture(imageNamed: "rainbow1")
        let sprite = SKSpriteNode(texture: texture, size: Self.fit(texture, in: TableLayout.rainbowSize))
        sprite.name = "effect.rainbow"
        sprite.speak("Rainbow")
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

        guard let textureName = Self.boreTextureName(level) else { return }
        let texture = SKTexture(imageNamed: textureName)
        let badge = SKSpriteNode(texture: texture, size: Self.fit(texture, in: Self.boreBox))
        badge.name = "effect.bore"
        badge.speak(Self.boreLabel(level))
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
        let badge = SKSpriteNode(texture: texture, size: Self.fit(texture, in: CGSize(width: TableLayout.overTrumpSize, height: TableLayout.overTrumpSize)))
        badge.name = "effect.overTrump"
        badge.speak("Over trump")
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

    #if DEBUG
    /// Fixture screenshots (`-uiEffect rainbow|b|2b|3b|4b|ot|all`): the effects held
    /// at their peak (no animation, never removed), the rainbow over my seat.
    func showFrozen(_ which: String, myPosition: Int) {
        let all = which == "all"
        if all || which == "rainbow" { showRainbow(position: myPosition, myPosition: myPosition) }
        if all || which == "ot" { showOverTrump() }
        let bore = all ? "3B" : which.uppercased()
        if Self.boreTextureName(bore) != nil { showBoreBadge(bore) }
        for e in live {
            e.node.removeAllActions()
            e.node.alpha = 1
            if case .bore = e.anchor { e.node.setScale(1.2) } else { e.node.setScale(1) }
        }
    }
    #endif
}
