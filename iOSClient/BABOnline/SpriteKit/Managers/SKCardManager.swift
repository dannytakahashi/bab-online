import SpriteKit

/// The player's hand: reconciles HandNode from TableRenderModel.hand and
/// gates taps (my turn, not read-only, not submitted, not while a trick is
/// still being collected — #187) before ActionCoordinator.play.
class SKCardManager {
    weak var scene: GameSKScene?
    let handNode = HandNode()
    /// actions.play: false when refused
    var onPlay: ((Card) -> Bool)?
    private var interactive = false

    init(scene: GameSKScene) {
        self.scene = scene
        handNode.onCardTapped = { [weak self] card in self?.handleCardPlay(card) }
    }

    func apply(_ model: TableRenderModel, layout: TableLayout, arriving: Set<String>, animator: Animator) {
        handNode.position = layout.handBaseline
        handNode.setScale(layout.handScale)
        guard let hand = model.hand, model.showsTable else {
            interactive = false
            handNode.cleanup()
            return
        }
        let collecting = scene?.trickManager.isCollecting ?? false
        interactive = hand.interactive && !collecting
        // The legal set is empty while the previous trick flies; the collect completion re-renders
        let legal: Set<String> = collecting && hand.interactive ? [] : hand.legalIds
        handNode.apply(cards: hand.cards, legalIds: legal, layout: layout, interactive: interactive, arriving: arriving, animator: animator)
    }

    func handleCardPlay(_ card: Card) {
        guard interactive, !(scene?.trickManager.isCollecting ?? false) else { return }
        if onPlay?(card) == true {
            HapticManager.lightImpact()
        } else {
            HapticManager.warning()
        }
    }
}
