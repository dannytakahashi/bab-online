import SpriteKit

/// Center area where trick cards are played.
class TrickAreaNode: SKNode {
    private var trickCards: [Int: SKSpriteNode] = [:]  // position → sprite

    /// Collects in flight (collectTrick until its group completes). While it is
    /// above 0 the hand is not playable, so the next card cannot be played into
    /// a table that is still being cleared (server pacing: the winner's
    /// updateTurn arrives in the same tick as trickComplete).
    private(set) var collectingCount = 0

    var cardCount: Int { trickCards.count }

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

    /// Place a card in the trick area for a position.
    /// `startPoint` (in this node's coordinates) is where the card flies in from;
    /// defaults to 3x the resting offset, i.e. from the player's side of the table.
    func placeCard(_ card: Card, position: Int, myPosition: Int, sceneSize: CGSize, animated: Bool = true, from startPoint: CGPoint? = nil) {
        let relPos = Positions.getRelative(target: position, from: myPosition)
        let offset = cardOffset(for: relPos, sceneSize: sceneSize)

        // One sprite per position: replacing (e.g. setup replaying the restored trick
        // after a rejoin) must not orphan the old sprite as a permanent ghost card.
        trickCards[position]?.removeFromParent()

        let texture = CardTextureGenerator.texture(for: card)
        let sprite = SKSpriteNode(texture: texture, size: CGSize(width: LayoutConstants.cardWidth * 0.8, height: LayoutConstants.cardHeight * 0.8))
        sprite.position = animated ? (startPoint ?? CGPoint(x: offset.x * 3, y: offset.y * 3)) : offset
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

        // Hand the collected sprites off now so the dict only ever holds the current
        // trick: a card placed (or a clear) during the collect animation then can't
        // remove a collecting sprite and strand the group before it leaves.
        let collecting = trickCards
        trickCards.removeAll()

        collectingCount += 1
        let group = DispatchGroup()
        for (_, sprite) in collecting {
            group.enter()
            sprite.run(CardAnimations.collectToWinner(x: collectPoint.x, y: collectPoint.y)) {
                sprite.removeFromParent()
                group.leave()
            }
        }

        group.notify(queue: .main) { [weak self] in
            if let self = self { self.collectingCount = max(0, self.collectingCount - 1) }
            completion()
        }
    }

    /// Remove all trick cards immediately
    func clearAllCards() {
        collectingCount = 0
        trickCards.values.forEach { $0.removeFromParent() }
        trickCards.removeAll()
        // Also drop sprites still mid-collect (no longer in trickCards), so a cleanup
        // that detaches this node can't carry them along as ghosts into the next setup.
        children.filter { $0.name?.hasPrefix("trick_") == true }.forEach { $0.removeFromParent() }
    }
}
