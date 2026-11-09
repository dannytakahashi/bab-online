import SpriteKit

/// The player's hand as a reconciled fan: one CardSpriteNode per card id
/// (`hand.card.<id>`), created or removed only when the hand changes,
/// legality toggled in place, the lifted card kept while it is held (22.9)
/// within one play window: a lift from before the window (my bid turn, the
/// other seats' turns, a collect) is dropped when the hand becomes playable,
/// so a card is always played by lift-then-confirm inside the window.
class HandNode: SKNode {
    private(set) var sprites: [String: CardSpriteNode] = [:]
    private(set) var liftedCardId: String?
    private var wasInteractive = false
    var onCardTapped: ((Card) -> Void)?

    override init() {
        super.init()
        name = "hand"
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func sprite(for id: String) -> CardSpriteNode? { sprites[id] }

    /// `arriving`: ids just adopted from elsewhere, animated into their slot.
    /// `interactive`: taps may play now (my play turn, no collect in flight).
    func apply(cards: [Card], legalIds: Set<String>, geometry: TableGeometry, interactive: Bool = false,
               arriving: Set<String> = [], animator: Animator = InstantAnimator()) {
        let ids = Set(cards.map(\.id))
        for (id, s) in sprites where !ids.contains(id) {
            s.removeFromParent()
            sprites[id] = nil
        }
        if let lifted = liftedCardId, !ids.contains(lifted) { liftedCardId = nil }
        // A new play window starts unlifted; an illegal card never stays lifted in it
        if let lifted = liftedCardId, interactive && (!wasInteractive || !legalIds.contains(lifted)) {
            liftedCardId = nil
            sprites[lifted]?.removeAction(forKey: CardAnimations.liftKey)
        }
        wasInteractive = interactive
        let slots = geometry.handSlots(count: cards.count)
        for (i, card) in cards.enumerated() {
            let s: CardSpriteNode
            if let existing = sprites[card.id] {
                s = existing
            } else {
                s = CardSpriteNode(card: card)
                s.onTap = { [weak self] c in self?.handleCardTap(c) }
                addChild(s)
                sprites[card.id] = s
            }
            s.name = "hand.card.\(card.id)"
            s.zPosition = CGFloat(i)
            s.isLegal = legalIds.contains(card.id)
            s.isUserInteractionEnabled = true
            s.isLifted = card.id == liftedCardId
            let target = CGPoint(x: slots[i].x, y: slots[i].y + (s.isLifted ? LayoutConstants.cardLiftY : 0))
            if arriving.contains(card.id) {
                animator.move(s, to: target, duration: LayoutConstants.playCardDuration, completion: nil)
            } else if !s.hasActions() {
                s.position = target
            }
        }
    }

    private func handleCardTap(_ card: Card) {
        guard let sprite = sprites[card.id] else { return }
        if liftedCardId == card.id {
            // Second tap on the lifted card: play it
            onCardTapped?(card)
        } else {
            if let prev = liftedCardId.flatMap({ sprites[$0] }) {
                prev.isLifted = false
                prev.run(CardAnimations.lower(), withKey: CardAnimations.liftKey)
            }
            liftedCardId = card.id
            sprite.isLifted = true
            sprite.run(CardAnimations.lift(), withKey: CardAnimations.liftKey)
            HapticManager.selection()
        }
    }

    /// Hand a card's sprite over to another container (my card going to the trick).
    func detach(_ id: String) -> CardSpriteNode? {
        guard let s = sprites.removeValue(forKey: id) else { return nil }
        if liftedCardId == id { liftedCardId = nil }
        s.isLifted = false
        return s
    }

    /// Take a sprite back (a rolled-back play), keeping its world position.
    func adopt(_ s: CardSpriteNode) {
        let world = s.parent.map { $0.convert(s.position, to: self) } ?? s.position
        s.removeAllActions()
        s.removeFromParent()
        s.position = world
        s.setScale(1)
        s.onTap = { [weak self] c in self?.handleCardTap(c) }
        addChild(s)
        sprites[s.card.id] = s
    }

    func cleanup() {
        sprites.values.forEach { $0.removeFromParent() }
        sprites = [:]
        liftedCardId = nil
        wasInteractive = false
    }
}
