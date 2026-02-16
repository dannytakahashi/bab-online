import SpriteKit

/// Displays the player's hand as a fan of cards at the bottom of the screen.
class HandNode: SKNode {
    private var cardSprites: [CardSpriteNode] = []
    private var liftedCard: CardSpriteNode?

    var onCardTapped: ((Card) -> Void)?

    func updateHand(cards: [Card], legalCards: [Card], sceneSize: CGSize) {
        // Remove old sprites
        cardSprites.forEach { $0.removeFromParent() }
        cardSprites = []
        liftedCard = nil

        guard !cards.isEmpty else { return }

        let isCompact = sceneSize.width < LayoutConstants.compactWidthThreshold
        let overlap = isCompact ? LayoutConstants.cardOverlapCompact : LayoutConstants.cardOverlap
        let cardWidth = LayoutConstants.cardWidth
        let totalWidth = cardWidth + overlap * CGFloat(cards.count - 1)
        let startX = -totalWidth / 2 + cardWidth / 2

        for (index, card) in cards.enumerated() {
            let sprite = CardSpriteNode(card: card)
            sprite.position = CGPoint(x: startX + CGFloat(index) * overlap, y: 0)
            sprite.zPosition = CGFloat(index)
            sprite.isLegal = legalCards.contains(card)

            sprite.onTap = { [weak self] tappedCard in
                self?.handleCardTap(tappedCard)
            }

            addChild(sprite)
            cardSprites.append(sprite)
        }
    }

    private func handleCardTap(_ card: Card) {
        guard let sprite = cardSprites.first(where: { $0.card == card }) else { return }

        if liftedCard == sprite {
            // Second tap on lifted card — confirm play
            onCardTapped?(card)
            liftedCard = nil
        } else {
            // Lower previously lifted card
            if let prev = liftedCard, prev.isLifted {
                prev.run(CardAnimations.lower())
                prev.isLifted = false
            }
            // Lift this card
            sprite.run(CardAnimations.lift())
            sprite.isLifted = true
            liftedCard = sprite
            HapticManager.selection()
        }
    }

    /// Remove a specific card from the hand with animation
    func removeCard(_ card: Card, animateTo point: CGPoint, in scene: SKScene, completion: (() -> Void)? = nil) {
        guard let sprite = cardSprites.first(where: { $0.card == card }) else {
            completion?()
            return
        }

        let worldPos = convert(sprite.position, to: scene)
        sprite.removeFromParent()
        sprite.position = worldPos
        scene.addChild(sprite)
        sprite.isUserInteractionEnabled = false

        sprite.run(CardAnimations.playToTrickArea(x: point.x, y: point.y)) {
            sprite.removeFromParent()
            completion?()
        }

        cardSprites.removeAll { $0 === sprite }
        liftedCard = nil
    }

    func cleanup() {
        cardSprites.forEach { $0.removeFromParent() }
        cardSprites = []
        liftedCard = nil
    }
}
