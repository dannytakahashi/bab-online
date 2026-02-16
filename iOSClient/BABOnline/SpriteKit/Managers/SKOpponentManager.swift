import SpriteKit

/// Manages opponent hand displays, turn indicators, and card removal.
class SKOpponentManager {
    weak var scene: GameSKScene?
    private var opponents: [Int: OpponentHandNode] = [:]  // position → node
    private var gameState: GameState?

    init(scene: GameSKScene) {
        self.scene = scene
    }

    func setup(gameState: GameState) {
        self.gameState = gameState
        cleanup()

        guard let scene = scene, let myPos = gameState.position else { return }
        let rel = Positions.getRelativePositions(myPos: myPos)

        // Create opponent nodes
        let positions: [(pos: Int, relPos: Positions.RelativePosition)] = [
            (rel.partner, .top),
            (rel.opp1, .left),
            (rel.opp2, .right),
        ]

        let scaleX = scene.size.width / LayoutConstants.referenceWidth
        let scaleY = scene.size.height / LayoutConstants.referenceHeight

        for (absPos, relPos) in positions {
            let username = gameState.getPlayerName(position: absPos)
            let node = OpponentHandNode(position: relPos, username: username)

            // Position on screen
            switch relPos {
            case .top:
                node.position = CGPoint(x: 0, y: scene.size.height / 2 - 100 * scaleY)
            case .left:
                node.position = CGPoint(x: -scene.size.width / 2 + 120 * scaleX, y: 0)
            case .right:
                node.position = CGPoint(x: scene.size.width / 2 - 120 * scaleX, y: 0)
            default:
                break
            }

            node.zPosition = 10
            scene.addChild(node)
            opponents[absPos] = node
        }
    }

    func setCardCounts(_ count: Int) {
        for (_, node) in opponents {
            node.cardCount = count
        }
    }

    func updateTurn(currentTurn: Int?) {
        for (pos, node) in opponents {
            if pos == currentTurn {
                node.showTurnGlow()
            } else {
                node.hideTurnGlow()
            }
        }
    }

    func showBid(position: Int, bid: Int) {
        opponents[position]?.showBid(bid)
    }

    func clearAllBids() {
        opponents.values.forEach { $0.clearBid() }
    }

    func removeCard(fromPosition position: Int, trickPoint: CGPoint, completion: (() -> Void)? = nil) {
        opponents[position]?.removeOneCard(animateTo: trickPoint, completion: completion)
    }

    func setDisconnected(position: Int, disconnected: Bool) {
        // visual feedback on opponent nodes
    }

    func cleanup() {
        opponents.values.forEach {
            $0.cleanup()
            $0.removeFromParent()
        }
        opponents.removeAll()
    }
}
