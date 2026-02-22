import SpriteKit
import Combine

/// Manages draw phase interactions within the SpriteKit scene.
class SKDrawManager {
    weak var scene: GameSKScene?
    private let drawPhaseNode = DrawPhaseNode()

    init(scene: GameSKScene) {
        self.scene = scene
    }

    func showDrawUI() {
        // No-op — draw phase is now handled by SwiftUI DrawPhaseView
    }

    func handleYouDrew(card: Card, position: Int) {
        // The playerDrew event handles the visual
    }

    func handlePlayerDrew(username: String, card: Card, drawOrder: Int, isLocalPlayer: Bool) {
        guard let scene = scene else { return }
        drawPhaseNode.showDrawResult(
            username: username,
            card: card,
            drawOrder: drawOrder,
            sceneSize: scene.size,
            isLocalPlayer: isLocalPlayer
        )
    }

    func handleTeamsAnnounced(data: [String: Any], completion: @escaping () -> Void) {
        guard let scene = scene else {
            completion()
            return
        }
        drawPhaseNode.showTeamsAndCleanup(data: data, sceneSize: scene.size, completion: completion)
    }

    func cleanup() {
        drawPhaseNode.cleanup()
        drawPhaseNode.removeFromParent()
    }
}
