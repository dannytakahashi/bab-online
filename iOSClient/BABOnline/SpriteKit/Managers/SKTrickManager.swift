import SpriteKit

/// Manages the trick area, play animations, collection, and history.
class SKTrickManager {
    weak var scene: GameSKScene?
    private let trickArea = TrickAreaNode()
    private let trickHistory = TrickHistoryNode()
    private var gameState: GameState?

    init(scene: GameSKScene) {
        self.scene = scene
    }

    func setup(gameState: GameState) {
        self.gameState = gameState
        guard let scene = scene else { return }

        trickArea.removeFromParent()
        trickArea.position = .zero
        trickArea.zPosition = 50
        scene.addChild(trickArea)

        trickHistory.removeFromParent()
        let scaleX = scene.size.width / LayoutConstants.referenceWidth
        trickHistory.position = CGPoint(x: scene.size.width / 2 - 150 * scaleX, y: -scene.size.height / 2 + 50)
        trickHistory.zPosition = 10
        scene.addChild(trickHistory)
    }

    func placeCard(_ card: Card, position: Int) {
        guard let scene = scene, let myPos = gameState?.position else { return }
        trickArea.placeCard(card, position: position, myPosition: myPos, sceneSize: scene.size)
    }

    func collectTrick(winner: Int, completion: @escaping () -> Void) {
        guard let scene = scene, let myPos = gameState?.position else {
            completion()
            return
        }

        // Add to history
        if Positions.getTeamNumber(winner) == Positions.getTeamNumber(myPos) {
            trickHistory.addTeamTrick()
        } else {
            trickHistory.addOppTrick()
        }

        trickArea.collectTrick(winner: winner, myPosition: myPos, sceneSize: scene.size, completion: completion)
        HapticManager.success()
    }

    func clearTrickArea() {
        trickArea.clearAllCards()
    }

    func clearHistory() {
        trickHistory.clearAll()
    }

    /// Get the trick area position for a given player position
    func trickPosition(for position: Int) -> CGPoint {
        guard let scene = scene, let myPos = gameState?.position else { return .zero }
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
