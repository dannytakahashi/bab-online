import SpriteKit

/// Manages the draw phase card fan and interactions.
class DrawPhaseNode: SKNode {
    private var deckCards: [SKSpriteNode] = []
    private var drawnDisplays: [SKNode] = []
    private var titleLabel: SKLabelNode?
    private var hasDrawn = false

    var onCardDrawn: ((Int) -> Void)?

    /// Show the deck of 54 face-down cards for drawing.
    func showDeck(sceneSize: CGSize) {
        cleanup()
        hasDrawn = false

        let scaleX = sceneSize.width / LayoutConstants.referenceWidth
        let scaleY = sceneSize.height / LayoutConstants.referenceHeight

        let startX = 400 * scaleX - sceneSize.width / 2
        let overlap = 20 * scaleX

        // Title
        let title = SKLabelNode(text: "Draw for Deal!")
        title.fontName = "Helvetica-Bold"
        title.fontSize = 36 * scaleX
        title.fontColor = .white
        title.position = CGPoint(x: 0, y: sceneSize.height / 2 - 80 * scaleY)
        title.zPosition = 200
        addChild(title)
        titleLabel = title

        // Create 54 card backs
        let offScreenX = sceneSize.width / 2 + 500 * scaleX
        for i in 0..<54 {
            let texture = SKTexture(imageNamed: "card_back")
            let card = SKSpriteNode(texture: texture, size: CGSize(
                width: LayoutConstants.cardWidth * 1.2,
                height: LayoutConstants.cardHeight * 1.2
            ))
            card.position = CGPoint(x: offScreenX, y: 0)
            card.zPosition = CGFloat(100 + i)
            card.name = "draw_card_\(i)"
            addChild(card)
            deckCards.append(card)

            // Animate in
            let targetX = startX + CGFloat(i) * overlap
            let move = SKAction.move(to: CGPoint(x: targetX, y: 0), duration: 0.75)
            move.timingMode = .easeOut
            card.run(move)
        }

        // Enable tap
        isUserInteractionEnabled = true
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard !hasDrawn, let touch = touches.first else { return }
        hasDrawn = true

        let location = touch.location(in: self)

        // Find which card was tapped
        var closestIndex = 0
        var closestDist: CGFloat = .greatestFiniteMagnitude
        for (i, card) in deckCards.enumerated() {
            let dist = abs(card.position.x - location.x)
            if dist < closestDist {
                closestDist = dist
                closestIndex = i
            }
        }

        HapticManager.lightImpact()
        onCardDrawn?(closestIndex)
    }

    /// Show a player's drawn card result.
    func showDrawResult(username: String, card: Card, drawOrder: Int, sceneSize: CGSize, isLocalPlayer: Bool) {
        let scaleX = sceneSize.width / LayoutConstants.referenceWidth
        let scaleY = sceneSize.height / LayoutConstants.referenceHeight

        let displayY: CGFloat = 200 * scaleY
        let startX = -300 * scaleX
        let spacing = 200 * scaleX
        let slotX = startX + CGFloat(drawOrder - 1) * spacing

        // Pick a source card from the deck
        let sourceCard: SKSpriteNode
        if isLocalPlayer, let last = deckCards.last {
            sourceCard = last
            deckCards.removeLast()
        } else if let random = deckCards.randomElement() {
            deckCards.removeAll { $0 === random }
            sourceCard = random
        } else {
            return
        }

        let startPos = sourceCard.position

        // Name label
        let nameLabel = SKLabelNode(text: username)
        nameLabel.fontName = "Helvetica-Bold"
        nameLabel.fontSize = 18 * scaleX
        nameLabel.fontColor = .white
        nameLabel.position = CGPoint(x: slotX, y: displayY + 80 * scaleY)
        nameLabel.zPosition = 300
        addChild(nameLabel)
        drawnDisplays.append(nameLabel)

        // Flip animation
        let midPoint = CGPoint(x: (startPos.x + slotX) / 2, y: (startPos.y + displayY) / 2)
        sourceCard.zPosition = 300

        let moveToMid = SKAction.move(to: midPoint, duration: 0.25)
        moveToMid.timingMode = .easeIn
        let scaleXDown = SKAction.scaleX(to: 0, duration: 0.25)

        let changeTexture = SKAction.run {
            sourceCard.texture = SKTexture(imageNamed: card.imageName)
            sourceCard.size = CGSize(width: LayoutConstants.cardWidth * 1.5, height: LayoutConstants.cardHeight * 1.5)
        }

        let scaleXUp = SKAction.scaleX(to: 1.0, duration: 0.25)
        let moveToSlot = SKAction.move(to: CGPoint(x: slotX, y: displayY), duration: 0.25)
        moveToSlot.timingMode = .easeOut

        sourceCard.run(SKAction.sequence([
            SKAction.group([moveToMid, scaleXDown]),
            changeTexture,
            SKAction.group([moveToSlot, scaleXUp])
        ]))

        drawnDisplays.append(sourceCard)
    }

    /// Animate teams announcement and cleanup
    func showTeamsAndCleanup(data: [String: Any], sceneSize: CGSize, completion: @escaping () -> Void) {
        let scaleX = sceneSize.width / LayoutConstants.referenceWidth
        let scaleY = sceneSize.height / LayoutConstants.referenceHeight

        // Whisk remaining deck cards off-screen
        let offScreen = CGPoint(x: sceneSize.width / 2 + 150, y: sceneSize.height / 2 + 150)
        for (i, card) in deckCards.enumerated() {
            let delay = TimeInterval(i) * 0.005
            card.run(SKAction.sequence([
                SKAction.wait(forDuration: delay + 0.5),
                CardAnimations.whiskOffScreen(to: offScreen)
            ]))
        }

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

        // Team labels
        let team1 = data["team1"] as? [String] ?? []
        let team2 = data["team2"] as? [String] ?? []

        let t1Label = SKLabelNode(text: "Team 1")
        t1Label.fontName = "Helvetica-Bold"
        t1Label.fontSize = 28 * scaleX
        t1Label.fontColor = UIColor(red: 0.3, green: 0.85, blue: 0.5, alpha: 1)
        t1Label.position = CGPoint(x: 0, y: 80 * scaleY)
        t1Label.zPosition = 401
        addChild(t1Label)

        let t1Players = SKLabelNode(text: team1.joined(separator: " & "))
        t1Players.fontName = "Helvetica"
        t1Players.fontSize = 22 * scaleX
        t1Players.fontColor = .white
        t1Players.position = CGPoint(x: 0, y: 40 * scaleY)
        t1Players.zPosition = 401
        addChild(t1Players)

        let vsLabel = SKLabelNode(text: "vs")
        vsLabel.fontName = "Helvetica-Oblique"
        vsLabel.fontSize = 18 * scaleX
        vsLabel.fontColor = UIColor(white: 0.6, alpha: 1)
        vsLabel.position = .zero
        vsLabel.zPosition = 401
        addChild(vsLabel)

        let t2Label = SKLabelNode(text: "Team 2")
        t2Label.fontName = "Helvetica-Bold"
        t2Label.fontSize = 28 * scaleX
        t2Label.fontColor = UIColor(red: 0.97, green: 0.45, blue: 0.45, alpha: 1)
        t2Label.position = CGPoint(x: 0, y: -40 * scaleY)
        t2Label.zPosition = 401
        addChild(t2Label)

        let t2Players = SKLabelNode(text: team2.joined(separator: " & "))
        t2Players.fontName = "Helvetica"
        t2Players.fontSize = 22 * scaleX
        t2Players.fontColor = .white
        t2Players.position = CGPoint(x: 0, y: -80 * scaleY)
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
        let allNodes = drawnDisplays + deckCards + [titleLabel].compactMap { $0 }
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
        deckCards.forEach { $0.removeFromParent() }
        deckCards.removeAll()
        drawnDisplays.forEach { $0.removeFromParent() }
        drawnDisplays.removeAll()
        titleLabel?.removeFromParent()
        titleLabel = nil
        hasDrawn = false
        isUserInteractionEnabled = false
    }
}
