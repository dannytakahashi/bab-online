import SpriteKit

/// Manages opponent hand displays, turn indicators, and card animations.
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

        for (absPos, relPos) in positions {
            let username = gameState.getPlayerName(position: absPos)
            let pic = gameState.players[absPos]?.pic
            let node = OpponentHandNode(position: relPos, username: username, pic: pic)

            // Position on screen — partner well below score bar, opponents centered vertically
            switch relPos {
            case .top:
                node.position = CGPoint(x: 0, y: scene.size.height / 2 - 220)
            case .left:
                node.position = CGPoint(x: -scene.size.width / 2 + 60, y: 0)
            case .right:
                node.position = CGPoint(x: scene.size.width / 2 - 60, y: 0)
            default:
                break
            }

            node.zPosition = 10
            scene.addChild(node)
            opponents[absPos] = node
        }
    }

    /// Setup for spectator mode — show all 4 positions (spectator has no "self")
    func setupForSpectator(gameState: GameState) {
        self.gameState = gameState
        cleanup()

        guard let scene = scene else { return }

        // Spectators view from position 1
        let myPos = 1
        let allPositions: [(absPos: Int, relPos: Positions.RelativePosition)] = [
            (1, .bottom),
            (2, .left),
            (3, .top),
            (4, .right),
        ]

        for (absPos, relPos) in allPositions {
            let username = gameState.getPlayerName(position: absPos)
            let pic = gameState.players[absPos]?.pic
            let node = OpponentHandNode(position: relPos, username: username, pic: pic)

            switch relPos {
            case .bottom:
                node.position = CGPoint(x: 0, y: -scene.size.height / 2 + 80)
            case .top:
                node.position = CGPoint(x: 0, y: scene.size.height / 2 - 220)
            case .left:
                node.position = CGPoint(x: -scene.size.width / 2 + 60, y: 0)
            case .right:
                node.position = CGPoint(x: scene.size.width / 2 - 60, y: 0)
            }

            node.zPosition = 10
            scene.addChild(node)
            opponents[absPos] = node
        }
    }

    /// Update player info when lazy/active/resign changes identity
    func updatePlayerInfo(position: Int, username: String, pic: String?) {
        guard let node = opponents[position] else { return }
        node.updateUsername(username)
        if let pic = pic {
            node.updatePic(pic)
        }
    }

    /// No-op — card-back fans are removed.
    func setCardCounts(_ count: Int) {}

    func updateTurn(currentTurn: Int?) {
        for (pos, node) in opponents {
            if pos == currentTurn {
                node.showTurnGlow()
            } else {
                node.hideTurnGlow()
            }
        }
    }

    func clearAllBids() {
        // Bids are managed by SKBidManager — no-op here
    }

    /// Animate a face-up card from the opponent's direction to the trick area.
    func animateOpponentCard(card: Card, fromPosition position: Int, toTrickPoint trickPoint: CGPoint, completion: (() -> Void)? = nil) {
        guard let scene = scene, let node = opponents[position] else {
            completion?()
            return
        }

        let scaleX = scene.size.width / LayoutConstants.referenceWidth
        let scaleY = scene.size.height / LayoutConstants.referenceHeight

        // Start point: off-screen in the opponent's direction
        let startPoint: CGPoint
        switch node.relativePosition {
        case .top:
            startPoint = CGPoint(x: 0, y: scene.size.height / 2 + 100 * scaleY)
        case .left:
            startPoint = CGPoint(x: -scene.size.width / 2 - 100 * scaleX, y: 0)
        case .right:
            startPoint = CGPoint(x: scene.size.width / 2 + 100 * scaleX, y: 0)
        default:
            startPoint = node.position
        }

        // Create face-up card sprite
        let texture = CardTextureGenerator.texture(for: card)
        let cardSprite = SKSpriteNode(texture: texture, size: CGSize(
            width: LayoutConstants.cardWidth * 0.8,
            height: LayoutConstants.cardHeight * 0.8
        ))
        cardSprite.position = startPoint
        cardSprite.zPosition = 90
        scene.addChild(cardSprite)

        // Animate to trick area then remove
        let move = SKAction.move(to: trickPoint, duration: LayoutConstants.playCardDuration)
        move.timingMode = .easeOut
        cardSprite.run(move) {
            cardSprite.removeFromParent()
            completion?()
        }
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
