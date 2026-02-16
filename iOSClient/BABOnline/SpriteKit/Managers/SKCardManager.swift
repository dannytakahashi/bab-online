import SpriteKit
import Combine

/// Manages the player's hand display, deal animations, and legality tinting.
class SKCardManager {
    weak var scene: GameSKScene?
    private let handNode = HandNode()
    private var gameState: GameState?

    init(scene: GameSKScene) {
        self.scene = scene
    }

    func setup(gameState: GameState) {
        self.gameState = gameState
        guard let scene = scene else { return }

        handNode.removeFromParent()
        scene.addChild(handNode)
        positionHand()

        handNode.onCardTapped = { [weak self] card in
            self?.handleCardPlay(card)
        }
    }

    func positionHand() {
        guard let scene = scene else { return }
        let bottomY = -scene.size.height / 2 + LayoutConstants.cardHeight / 2 + 20
        handNode.position = CGPoint(x: 0, y: bottomY)
    }

    func updateHand() {
        guard let scene = scene, let gs = gameState else { return }

        let sortedCards = gs.sortedHand
        let legalCards: [Card]

        if gs.isMyTurn && gs.phase == .playing && !gs.hasPlayedCard {
            legalCards = CardLegality.getLegalCards(
                hand: sortedCards,
                lead: gs.leadCard,
                isLeading: gs.isLeading,
                trump: gs.trump,
                trumpBroken: gs.trumpBroken,
                myPosition: gs.position ?? 0,
                leadPosition: gs.leadPosition ?? 0
            )
        } else {
            // Not our turn — all cards shown as non-interactive
            legalCards = gs.isMyTurn && gs.isBidding ? sortedCards : []
        }

        handNode.updateHand(cards: sortedCards, legalCards: legalCards, sceneSize: scene.size)
    }

    private func handleCardPlay(_ card: Card) {
        guard let gs = gameState, gs.isMyTurn, !gs.hasPlayedCard, gs.phase == .playing else { return }

        // Legality check
        let result = CardLegality.isLegalMove(
            card: card,
            hand: gs.sortedHand,
            lead: gs.leadCard,
            isLeading: gs.isLeading,
            trump: gs.trump,
            trumpBroken: gs.trumpBroken,
            myPosition: gs.position ?? 0,
            leadPosition: gs.leadPosition ?? 0
        )

        guard result.legal else {
            HapticManager.warning()
            return
        }

        // Optimistic update
        gs.hasPlayedCard = true
        _ = gs.optimisticPlayCard(card)

        HapticManager.lightImpact()

        // Emit to server
        GameEmitter.playCard(card: card, position: gs.position ?? 0)

        // Update hand display
        updateHand()
    }

    /// Animate card from hand to trick area
    func animateCardToTrick(card: Card, trickPosition: CGPoint) {
        handNode.removeCard(card, animateTo: trickPosition, in: scene!)
    }

    func cleanup() {
        handNode.cleanup()
        handNode.removeFromParent()
    }
}
