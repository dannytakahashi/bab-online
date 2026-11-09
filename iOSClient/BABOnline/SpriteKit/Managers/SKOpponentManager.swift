import SpriteKit

/// Manages opponent hand displays, turn indicators, and card animations.
class SKOpponentManager {
    weak var scene: GameSKScene?
    private var opponents: [Int: OpponentHandNode] = [:]  // position → node
    private var names: [Int: (name: String, pic: Pic)] = [:]

    init(scene: GameSKScene) {
        self.scene = scene
    }

    /// Create the opponent nodes for the model's seats (3 around me, or all 4 for a spectator).
    func setup(_ model: TableRenderModel) {
        cleanup()
        guard let scene = scene else { return }
        for o in model.opponents {
            let node = OpponentHandNode(position: o.rel, username: o.name, pic: o.pic.string)
            switch o.rel {
            case .bottom: node.position = CGPoint(x: 0, y: -scene.size.height / 2 + 140)
            case .top: node.position = CGPoint(x: 0, y: scene.size.height / 2 - 220)
            case .left: node.position = CGPoint(x: -scene.size.width / 2 + 60, y: 0)
            case .right: node.position = CGPoint(x: scene.size.width / 2 - 60, y: 0)
            }
            node.zPosition = 10
            scene.addChild(node)
            opponents[o.position] = node
            names[o.position] = (o.name, o.pic)
        }
    }

    /// Names, pictures and the turn glow from the model (re-applied every render).
    func update(_ model: TableRenderModel) {
        for o in model.opponents {
            if let prev = names[o.position], prev.name != o.name || prev.pic != o.pic {
                updatePlayerInfo(position: o.position, username: o.name, pic: o.pic.string)
                names[o.position] = (o.name, o.pic)
            }
        }
        updateTurn(currentTurn: model.turn)
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

    func setSpeaking(position: Int, speaking: Bool) {
        guard let node = opponents[position] else { return }
        if speaking {
            node.showSpeakingGlow()
        } else {
            node.hideSpeakingGlow()
        }
    }

    func clearAllBids() {
        // Bids are managed by SKBidManager — no-op here
    }

    /// Scene point a played card flies in from: off-screen in the opponent's direction.
    func trickEntryPoint(forPosition position: Int) -> CGPoint? {
        guard let scene = scene, let node = opponents[position] else { return nil }

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
        return startPoint
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
        names.removeAll()
    }
}
