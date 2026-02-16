import SpriteKit

/// Center area where trick cards are played.
class TrickAreaNode: SKNode {
    private var trickCards: [Int: SKSpriteNode] = [:]  // position → sprite

    /// Positions for each player's card in the trick area (relative to center)
    private func cardOffset(for relPos: Positions.RelativePosition, sceneSize: CGSize) -> CGPoint {
        let scaleX = sceneSize.width / LayoutConstants.referenceWidth
        let scaleY = sceneSize.height / LayoutConstants.referenceHeight
        let ox = LayoutConstants.trickOffsetX * scaleX
        let oy = LayoutConstants.trickOffsetY * scaleY

        switch relPos {
        case .bottom: return CGPoint(x: 0, y: -oy)
        case .top:    return CGPoint(x: 0, y: oy)
        case .left:   return CGPoint(x: -ox, y: 0)
        case .right:  return CGPoint(x: ox, y: 0)
        }
    }

    /// Place a card in the trick area for a position
    func placeCard(_ card: Card, position: Int, myPosition: Int, sceneSize: CGSize, animated: Bool = true) {
        let relPos = Positions.getRelative(target: position, from: myPosition)
        let offset = cardOffset(for: relPos, sceneSize: sceneSize)

        let texture = SKTexture(imageNamed: card.imageName)
        let sprite = SKSpriteNode(texture: texture, size: CGSize(width: LayoutConstants.cardWidth * 0.8, height: LayoutConstants.cardHeight * 0.8))
        sprite.position = animated ? CGPoint(x: offset.x * 3, y: offset.y * 3) : offset
        sprite.zPosition = 100 + CGFloat(trickCards.count)
        sprite.name = "trick_\(position)"

        addChild(sprite)
        trickCards[position] = sprite

        if animated {
            let move = SKAction.move(to: offset, duration: LayoutConstants.playCardDuration)
            move.timingMode = .easeOut
            sprite.run(move)
        }
    }

    /// Collect all trick cards to winner
    func collectTrick(winner: Int, myPosition: Int, sceneSize: CGSize, completion: @escaping () -> Void) {
        let winnerRelPos = Positions.getRelative(target: winner, from: myPosition)

        // Determine where to collect to (off toward winner)
        let scaleX = sceneSize.width / LayoutConstants.referenceWidth
        let scaleY = sceneSize.height / LayoutConstants.referenceHeight
        let collectPoint: CGPoint
        switch winnerRelPos {
        case .bottom: collectPoint = CGPoint(x: 0, y: -200 * scaleY)
        case .top:    collectPoint = CGPoint(x: 0, y: 200 * scaleY)
        case .left:   collectPoint = CGPoint(x: -200 * scaleX, y: 0)
        case .right:  collectPoint = CGPoint(x: 200 * scaleX, y: 0)
        }

        let group = DispatchGroup()
        for (_, sprite) in trickCards {
            group.enter()
            sprite.run(CardAnimations.collectToWinner(x: collectPoint.x, y: collectPoint.y)) {
                sprite.removeFromParent()
                group.leave()
            }
        }

        group.notify(queue: .main) { [weak self] in
            self?.trickCards.removeAll()
            completion()
        }
    }

    /// Remove all trick cards immediately
    func clearAllCards() {
        trickCards.values.forEach { $0.removeFromParent() }
        trickCards.removeAll()
    }
}
