import SpriteKit

/// The player's hand, from TableRenderModel.hand. Taps go to ActionCoordinator.
class SKCardManager {
    weak var scene: GameSKScene?
    private let handNode = HandNode()
    /// actions.play: false when refused (not my turn, illegal, already submitted)
    var onPlay: ((Card) -> Bool)?
    private var interactive = false

    init(scene: GameSKScene) {
        self.scene = scene
    }

    func setup() {
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
        // Raise hand above bottom edge to leave room for bid overlay
        let bottomY = -scene.size.height / 2 + LayoutConstants.cardHeight / 2 + 60
        handNode.position = CGPoint(x: 0, y: bottomY)
    }

    func updateHand(_ model: TableRenderModel) {
        guard let scene = scene, let hand = model.hand, handNode.parent != nil else { return }
        // Not while the previous trick is still flying to its winner (#187);
        // the collect completion calls updateHand again
        let collecting = scene.trickManager?.isCollecting ?? false
        interactive = hand.interactive && !collecting
        let legal = collecting && hand.interactive ? [] : hand.cards.filter { hand.legalIds.contains($0.id) }
        handNode.updateHand(cards: hand.cards, legalCards: legal, sceneSize: scene.size)
    }

    private func handleCardPlay(_ card: Card) {
        guard interactive, !(scene?.trickManager?.isCollecting ?? false) else { return }
        if onPlay?(card) == true {
            HapticManager.lightImpact()
        } else {
            HapticManager.warning()
        }
    }

    func cleanup() {
        handNode.cleanup()
        handNode.removeFromParent()
    }
}
