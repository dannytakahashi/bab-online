import SpriteKit

/// Manages visual effects: rainbow, bore badges, etc.
class SKEffectsManager {
    weak var scene: GameSKScene?

    init(scene: GameSKScene) {
        self.scene = scene
    }

    /// Show rainbow effect for a position
    func showRainbow(position: Int, myPosition: Int) {
        guard let scene = scene else { return }
        let relPos = Positions.getRelative(target: position, from: myPosition)
        let scaleX = scene.size.width / LayoutConstants.referenceWidth
        let scaleY = scene.size.height / LayoutConstants.referenceHeight

        let effectPos: CGPoint
        switch relPos {
        case .bottom: effectPos = CGPoint(x: 0, y: -scene.size.height / 2 + 200)
        case .top:    effectPos = CGPoint(x: 0, y: scene.size.height / 2 - 150 * scaleY)
        case .left:   effectPos = CGPoint(x: -scene.size.width / 2 + 120 * scaleX, y: 0)
        case .right:  effectPos = CGPoint(x: scene.size.width / 2 - 120 * scaleX, y: 0)
        }

        // Rainbow text
        let label = SKLabelNode(text: "RAINBOW!")
        label.fontName = "Helvetica-Bold"
        label.fontSize = 28
        label.fontColor = .white
        label.position = effectPos
        label.zPosition = 500
        scene.addChild(label)

        // Animate with color shimmer and fade
        let shimmer = CardAnimations.rainbowShimmer()
        let scaleUp = SKAction.scale(to: 1.5, duration: 0.5)
        let fadeOut = SKAction.fadeOut(withDuration: 0.5)
        let remove = SKAction.removeFromParent()

        label.run(SKAction.sequence([
            shimmer,
            SKAction.group([scaleUp, fadeOut]),
            remove
        ]))
    }

    /// Show bore badge effect
    func showBoreBadge(_ level: String, sceneSize: CGSize) {
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
        badge.position = .zero
        badge.zPosition = 500
        badge.alpha = 0
        badge.setScale(0.5)
        scene.addChild(badge)

        badge.run(SKAction.sequence([
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
        ]))
    }

    func cleanup() {
        // Effects clean themselves up via removeFromParent
    }
}
