import SpriteKit

/// The player's hand: reconciles HandNode from TableRenderModel.hand and
/// gates taps (my turn, not read-only, not submitted, not while a trick is
/// still being collected — #187) before ActionCoordinator.play.
class SKCardManager {
    weak var scene: GameSKScene?
    let handNode = HandNode()
    /// actions.play: false when refused
    var onPlay: ((Card) -> Bool)?
    /// A tap on a dimmed card: why it cannot be played now (the web's illegalReason), for the toast.
    var onBlocked: ((String) -> Void)?
    private var interactive = false

    init(scene: GameSKScene) {
        self.scene = scene
        handNode.onCardTapped = { [weak self] card in self?.handleCardPlay(card) }
        handNode.onBlockedTap = { [weak self] why in self?.onBlocked?(why) }
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
        // ... and every card says so
        let blocked = collecting && hand.interactive
            ? hand.cards.reduce(into: [String: String]()) { $0[$1.id] = TableRenderModel.Blocked.trickClearing } : hand.blocked
        handNode.apply(cards: hand.cards, legalIds: legal, blocked: blocked, layout: layout, interactive: interactive, arriving: arriving,
                       suggestedId: hand.suggestedId, animator: animator)
    }

    /// Relayout: the hand node's place and scale, then every card to its slot.
    func apply(layout: TableLayout, animator: Animator) {
        handNode.position = layout.handBaseline
        handNode.setScale(layout.handScale)
        handNode.apply(layout: layout, animator: animator)
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
