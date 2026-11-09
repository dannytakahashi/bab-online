import SpriteKit

/// The trick area and the won-trick history.
class SKTrickManager {
    weak var scene: GameSKScene?
    let trickArea = TrickAreaNode()
    let trickHistory = TrickHistoryNode()

    init(scene: GameSKScene) {
        self.scene = scene
        trickArea.zPosition = 50
        trickHistory.zPosition = 10
    }

    /// True while a trick is being collected (the hand is not playable).
    var isCollecting: Bool { trickArea.collectingCount > 0 }

    /// Relayout: the trick cards and the history (place and icon spacing).
    func apply(layout: TableLayout, viewPosition: Int, animator: Animator) {
        trickArea.apply(layout: layout, viewPosition: viewPosition, animator: animator)
        trickHistory.position = layout.historyOrigin
        trickHistory.setCounts(team: trickHistory.counts.team, opp: trickHistory.counts.opp, spacing: layout.historySpacing)
    }

    /// Exit animation: trick `key`'s sprites leave for the transient layer and
    /// fly to the winner; the completion re-renders the latest model.
    func collect(winner: Int, key: TrickKey, viewPosition: Int, layout: TableLayout, animator: Animator) {
        guard let scene else { return }
        let sprites = trickArea.takeForCollect(key)
        guard !sprites.isEmpty else { return }
        for s in sprites {
            let world = trickArea.convert(s.position, to: scene.transientLayer)
            s.removeFromParent()
            s.position = world
            scene.transientLayer.addChild(s)
        }
        HapticManager.success()
        // in flight, a collect ends at this target even if the table relays out (0.4 s, fading)
        let point = layout.collectPoint(Positions.getRelative(target: winner, from: viewPosition))
        animator.collect(sprites, to: point) { [weak self, weak scene] in
            self?.trickArea.collectFinished()
            scene?.renderLatest()
        }
    }
}
