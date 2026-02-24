import SpriteKit

/// Manages the draw phase — auto-draw with sequential card flip reveals.
class DrawPhaseNode: SKNode {
    private var drawnDisplays: [SKNode] = []
    private var titleLabel: SKLabelNode?

    /// Show "Drawing for deal..." title centered on screen.
    func showAutoDrawTitle(sceneSize: CGSize) {
        cleanup()

        let title = SKLabelNode(text: "Drawing for deal...")
        title.fontName = "Helvetica-Bold"
        title.fontSize = 28
        title.fontColor = .white
        title.position = CGPoint(x: 0, y: sceneSize.height / 2 - 100)
        title.zPosition = 200
        addChild(title)
        titleLabel = title
    }

    /// Show a player's drawn card result with flip animation into one of 4 slots.
    func showDrawResult(username: String, card: Card, drawOrder: Int, sceneSize: CGSize, isLocalPlayer: Bool) {
        let cardW = LayoutConstants.cardWidth * 0.8
        let cardH = LayoutConstants.cardHeight * 0.8
        let displayY: CGFloat = 0
        let spacing = cardW + 20
        let totalWidth = spacing * 3
        let startX = -totalWidth / 2
        let slotX = startX + CGFloat(drawOrder - 1) * spacing

        // Username label above the slot
        let nameLabel = SKLabelNode(text: username)
        nameLabel.fontName = "Helvetica-Bold"
        nameLabel.fontSize = 16
        nameLabel.fontColor = isLocalPlayer ? UIColor(red: 0.3, green: 0.9, blue: 0.4, alpha: 1) : .white
        nameLabel.position = CGPoint(x: slotX, y: displayY + (cardH / 2) + 22)
        nameLabel.zPosition = 300
        addChild(nameLabel)
        drawnDisplays.append(nameLabel)

        // Create card back at center
        let backTexture = CardTextureGenerator.cardBackTexture()
        let cardSprite = SKSpriteNode(texture: backTexture, size: CGSize(width: cardW, height: cardH))
        cardSprite.position = CGPoint(x: 0, y: displayY)
        cardSprite.zPosition = 300 + CGFloat(drawOrder)
        addChild(cardSprite)

        // Flip animation: scaleX to 0, change to face texture, scaleX back, slide to slot
        let faceTexture = CardTextureGenerator.texture(for: card)

        let scaleDown = SKAction.scaleX(to: 0, duration: 0.2)
        scaleDown.timingMode = .easeIn

        let changeTexture = SKAction.run {
            cardSprite.texture = faceTexture
        }

        let scaleUp = SKAction.scaleX(to: 1.0, duration: 0.2)
        scaleUp.timingMode = .easeOut

        let slideToSlot = SKAction.move(to: CGPoint(x: slotX, y: displayY), duration: 0.3)
        slideToSlot.timingMode = .easeOut

        cardSprite.run(SKAction.sequence([
            SKAction.wait(forDuration: 0.1),
            scaleDown,
            changeTexture,
            scaleUp,
            slideToSlot,
        ]))

        drawnDisplays.append(cardSprite)
    }

    /// Animate teams announcement and cleanup.
    func showTeamsAndCleanup(data: [String: Any], sceneSize: CGSize, completion: @escaping () -> Void) {
        // Fade title
        titleLabel?.run(CardAnimations.fadeOut())

        // Show overlay
        let overlay = SKShapeNode(rectOf: sceneSize)
        overlay.fillColor = UIColor(white: 0, alpha: 0.7)
        overlay.strokeColor = .clear
        overlay.position = .zero
        overlay.zPosition = 400
        overlay.alpha = 0
        addChild(overlay)
        overlay.run(SKAction.fadeAlpha(to: 0.7, duration: 0.5))

        // Team labels — absolute font sizes for readability
        let team1 = data["team1"] as? [String] ?? []
        let team2 = data["team2"] as? [String] ?? []

        let t1Label = SKLabelNode(text: "Team 1")
        t1Label.fontName = "Helvetica-Bold"
        t1Label.fontSize = 26
        t1Label.fontColor = UIColor(red: 0.3, green: 0.85, blue: 0.5, alpha: 1)
        t1Label.position = CGPoint(x: 0, y: 70)
        t1Label.zPosition = 401
        addChild(t1Label)

        let t1Players = SKLabelNode(text: team1.joined(separator: " & "))
        t1Players.fontName = "Helvetica"
        t1Players.fontSize = 20
        t1Players.fontColor = .white
        t1Players.position = CGPoint(x: 0, y: 35)
        t1Players.zPosition = 401
        addChild(t1Players)

        let vsLabel = SKLabelNode(text: "vs")
        vsLabel.fontName = "Helvetica-Oblique"
        vsLabel.fontSize = 16
        vsLabel.fontColor = UIColor(white: 0.6, alpha: 1)
        vsLabel.position = .zero
        vsLabel.zPosition = 401
        addChild(vsLabel)

        let t2Label = SKLabelNode(text: "Team 2")
        t2Label.fontName = "Helvetica-Bold"
        t2Label.fontSize = 26
        t2Label.fontColor = UIColor(red: 0.97, green: 0.45, blue: 0.45, alpha: 1)
        t2Label.position = CGPoint(x: 0, y: -35)
        t2Label.zPosition = 401
        addChild(t2Label)

        let t2Players = SKLabelNode(text: team2.joined(separator: " & "))
        t2Players.fontName = "Helvetica"
        t2Players.fontSize = 20
        t2Players.fontColor = .white
        t2Players.position = CGPoint(x: 0, y: -70)
        t2Players.zPosition = 401
        addChild(t2Players)

        drawnDisplays.append(contentsOf: [overlay, t1Label, t1Players, vsLabel, t2Label, t2Players])

        // After 3 seconds, fade everything and call completion
        run(SKAction.sequence([
            SKAction.wait(forDuration: 3.0),
            SKAction.run { [weak self] in
                self?.fadeAllAndCleanup(completion: completion)
            }
        ]))
    }

    private func fadeAllAndCleanup(completion: @escaping () -> Void) {
        let allNodes = drawnDisplays + [titleLabel].compactMap { $0 }
        let group = DispatchGroup()

        for node in allNodes {
            group.enter()
            node.run(CardAnimations.fadeOut(duration: 0.6)) {
                group.leave()
            }
        }

        group.notify(queue: .main) { [weak self] in
            self?.cleanup()
            completion()
        }
    }

    func cleanup() {
        drawnDisplays.forEach { $0.removeFromParent() }
        drawnDisplays.removeAll()
        titleLabel?.removeFromParent()
        titleLabel = nil
    }
}
