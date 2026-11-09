import SpriteKit

/// The cards on the table, reconciled from the model: one sprite per played
/// card, named `trick.<pos>.<cardId>`, tagged with its TrickKey, z by play
/// order (22.1c). Collected sprites leave for the scene's transient layer, so
/// a reconcile never touches them.
class TrickAreaNode: SKNode {
    /// Collects in flight. While above 0 the hand is not playable, so the next
    /// card cannot be played into a table that is still being cleared (#187).
    private(set) var collectingCount = 0

    override init() {
        super.init()
        name = "trick"
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    static func spriteName(_ position: Int, _ card: Card) -> String { "trick.\(position).\(card.id)" }
    static func keyString(_ key: TrickKey?) -> String { key.map { "\($0.dealSeq):\($0.trick)" } ?? "-" }

    var cardSprites: [SKSpriteNode] { children.compactMap { $0 as? SKSpriteNode }.filter { $0.name?.hasPrefix("trick.") == true } }
    var cardCount: Int { cardSprites.count }

    func sprite(named name: String) -> SKSpriteNode? { cardSprites.first { $0.name == name } }

    /// What one reconcile changed: `adopted` moved in from another container
    /// (my hand's sprite, flying itself), `created` are new sprites (the only
    /// ones a cardPlayed entrance may fly in).
    struct Changes: Equatable {
        var adopted: Set<String> = []
        var created: Set<String> = []
    }

    /// Make the layer show exactly `cards`. `adopt` supplies an existing
    /// sprite for a card (my hand's sprite).
    @discardableResult
    func apply(cards: [TableRenderModel.TrickCard], key: TrickKey?, viewPosition: Int, layout: TableLayout,
               adopt: (TableRenderModel.TrickCard) -> SKSpriteNode?, animator: Animator) -> Changes {
        let wanted = Set(cards.map { Self.spriteName($0.position, $0.card) })
        for s in cardSprites where !wanted.contains(s.name ?? "") { s.removeFromParent() }
        var adopted: Set<String> = []
        var created: Set<String> = []
        for c in cards {
            let name = Self.spriteName(c.position, c.card)
            let slot = layout.trickSlot(Positions.getRelative(target: c.position, from: viewPosition))
            let sprite: SKSpriteNode
            if let existing = self.sprite(named: name) {
                sprite = existing
                if !sprite.hasActions() { sprite.position = slot }
            } else if let moved = adopt(c) {
                // keep the sprite where it is on screen, then fly it to the slot (22.7)
                let world = moved.parent.map { $0.convert(moved.position, to: self) } ?? moved.position
                // its on-screen size too: the hand may be scaled
                let worldScale = moved.xScale * (moved.parent?.xScale ?? 1)
                moved.removeAllActions()
                moved.removeFromParent()
                moved.position = world
                moved.setScale(worldScale)
                addChild(moved)
                sprite = moved
                adopted.insert(name)
                animator.move(sprite, to: slot, duration: LayoutConstants.playCardDuration, completion: nil)
                if let card = sprite as? CardSpriteNode { card.isUserInteractionEnabled = false; card.isLegal = true }
                animator.scale(sprite, to: layout.trickSpriteScale, duration: LayoutConstants.playCardDuration)
            } else {
                // the hand card's base size at the trick scale, so a fresh sprite and an adopted one dump alike
                sprite = SKSpriteNode(texture: CardTextureGenerator.texture(for: c.card), size: TableLayout.cardSize)
                sprite.setScale(layout.trickSpriteScale)
                sprite.position = slot
                addChild(sprite)
                created.insert(name)
            }
            sprite.name = name
            sprite.zPosition = 100 + CGFloat(c.playIndex)
            if sprite.userData == nil { sprite.userData = [:] }
            sprite.userData?["key"] = Self.keyString(key)
        }
        return Changes(adopted: adopted, created: created)
    }

    /// Relayout: every card to its seat's new slot (a fly in flight is
    /// re-aimed) at the new trick scale.
    func apply(layout: TableLayout, viewPosition: Int, animator: Animator) {
        for s in cardSprites {
            let parts = (s.name ?? "").split(separator: ".")
            guard parts.count >= 2, let pos = Int(parts[1]) else { continue }
            let slot = layout.trickSlot(Positions.getRelative(target: pos, from: viewPosition))
            if s.action(forKey: "move") != nil { animator.retarget(s, to: slot) } else { s.position = slot }
            s.removeAction(forKey: "scale")
            s.setScale(layout.trickSpriteScale)
        }
    }

    /// Fly a newly placed card in from `start` (scene-local coordinates of this node).
    func animateEntry(_ name: String, from start: CGPoint, slot: CGPoint, animator: Animator) {
        guard let s = sprite(named: name), !s.hasActions() else { return }
        s.position = start
        animator.move(s, to: slot, duration: LayoutConstants.playCardDuration, completion: nil)
    }

    /// The sprites of trick `key` (all of them when nil), taken out for a collect.
    func takeForCollect(_ key: TrickKey?) -> [SKSpriteNode] {
        let k = Self.keyString(key)
        let taken = cardSprites.filter { key == nil || ($0.userData?["key"] as? String) == k }
        if !taken.isEmpty { collectingCount += 1 }
        return taken
    }

    func collectFinished() { collectingCount = max(0, collectingCount - 1) }

    /// Remove all trick cards immediately (a reset).
    func clearAllCards() {
        collectingCount = 0
        cardSprites.forEach { $0.removeFromParent() }
    }
}
