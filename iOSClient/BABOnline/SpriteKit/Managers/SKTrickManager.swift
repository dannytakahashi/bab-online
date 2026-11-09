import SpriteKit

/// Manages the trick area, play animations, collection, and history.
class SKTrickManager {
    weak var scene: GameSKScene?
    private let trickArea = TrickAreaNode()
    private let trickHistory = TrickHistoryNode()
    private var viewPosition = 1

    init(scene: GameSKScene) {
        self.scene = scene
    }

    func setup(viewPosition: Int) {
        self.viewPosition = viewPosition
        guard let scene = scene else { return }

        trickArea.removeFromParent()
        trickArea.position = .zero
        trickArea.zPosition = 50
        scene.addChild(trickArea)

        trickHistory.removeFromParent()
        trickHistory.position = CGPoint(x: -scene.size.width / 2 + 20, y: -scene.size.height / 2 + 100)
        trickHistory.zPosition = 10
        scene.addChild(trickHistory)
    }

    /// `startPoint` is in scene coordinates (the trick area sits at the scene origin).
    func placeCard(_ card: Card, position: Int, from startPoint: CGPoint? = nil, animated: Bool = true) {
        guard let scene = scene else { return }
        trickArea.placeCard(card, position: position, myPosition: viewPosition, sceneSize: scene.size, animated: animated,
                            from: startPoint.map { trickArea.convert($0, from: scene) })
    }

    var trickCount: Int { trickArea.cardCount }

    func collectTrick(winner: Int, completion: @escaping () -> Void) {
        guard let scene = scene else {
            completion()
            return
        }
        let myPos = viewPosition

        // Add to history
        if Positions.getTeamNumber(winner) == Positions.getTeamNumber(myPos) {
            trickHistory.addTeamTrick()
        } else {
            trickHistory.addOppTrick()
        }

        trickArea.collectTrick(winner: winner, myPosition: myPos, sceneSize: scene.size, completion: completion)
        HapticManager.success()
    }

    /// True while a trick is being collected (the hand is not playable).
    var isCollecting: Bool { trickArea.collectingCount > 0 }

    func clearTrickArea() {
        trickArea.clearAllCards()
    }

    func clearHistory() {
        trickHistory.clearAll()
    }

    /// Get the trick area position for a given player position
    func trickPosition(for position: Int) -> CGPoint {
        guard let scene = scene else { return .zero }
        let myPos = viewPosition
        let relPos = Positions.getRelative(target: position, from: myPos)
        let scaleX = scene.size.width / LayoutConstants.referenceWidth
        let scaleY = scene.size.height / LayoutConstants.referenceHeight
        let ox = LayoutConstants.trickOffsetX * scaleX
        let oy = LayoutConstants.trickOffsetY * scaleY

        switch relPos {
        case .bottom: return CGPoint(x: 0, y: -oy)
        case .top:    return CGPoint(x: 0, y: oy)
        case .left:   return CGPoint(x: -ox, y: 0)
        case .right:  return CGPoint(x: ox, y: 0)
        }
    }

    func cleanup() {
        trickArea.clearAllCards()
        trickArea.removeFromParent()
        trickHistory.clearAll()
        trickHistory.removeFromParent()
    }
}
