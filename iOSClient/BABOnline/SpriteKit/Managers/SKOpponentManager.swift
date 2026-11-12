import SpriteKit

/// Opponent seats: created once per layout (game, view seat, spectator) and
/// updated in place after that (22.8); the turn glow is re-applied on every
/// render (22.5) and the speaking glow survives renders.
class SKOpponentManager {
    weak var scene: GameSKScene?
    let layer: SKNode
    private(set) var nodes: [Int: OpponentHandNode] = [:]  // position -> node
    private var layoutKey: String?

    init(scene: GameSKScene, layer: SKNode) {
        self.scene = scene
        self.layer = layer
    }

    func apply(_ model: TableRenderModel, layout: TableLayout) {
        let key = "\(model.gameId ?? "-")|\(model.viewPosition)|\(model.isSpectator)"
        if key != layoutKey {
            cleanup()
            layoutKey = key
            for o in model.opponents {
                let node = OpponentHandNode(position: o.rel, username: o.name, pic: o.pictureKey, fallback: o.fallbackPicture)
                node.zPosition = 10
                layer.addChild(node)
                nodes[o.position] = node
            }
        }
        for o in model.opponents {
            guard let node = nodes[o.position] else { continue }
            if !node.hasActions() { node.position = layout.seatAnchor(o.rel) }
            node.update(name: o.name, pic: o.pictureKey, fallback: o.fallbackPicture, isTurn: o.isTurn)
            node.setPips(model.pips[o.position], team: Positions.getTeamNumber(o.position))
        }
    }

    /// Relayout: every seat to its new anchor (a fold change glides).
    func apply(layout: TableLayout, animator: Animator, animated: Bool) {
        for node in nodes.values {
            let target = layout.seatAnchor(node.relativePosition)
            if animated {
                animator.move(node, to: target, duration: LayoutConstants.playCardDuration, completion: nil)
            } else {
                node.removeAction(forKey: "move")
                node.position = target
            }
        }
    }

    func setSpeaking(position: Int, speaking: Bool) {
        guard let node = nodes[position] else { return }
        if speaking { node.showSpeakingGlow() } else { node.hideSpeakingGlow() }
    }

    func cleanup() {
        nodes.values.forEach { $0.cleanup(); $0.removeFromParent() }
        nodes.removeAll()
        layoutKey = nil
    }
}
