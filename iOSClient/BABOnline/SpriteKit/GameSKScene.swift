import SpriteKit
import Combine

/// The table scene, rendered from state. The store calls
/// `apply(model:animations:)` synchronously after every commit:
///   1. exit animations (trick collect, cleared/destroyed hands) move their
///      sprites to `transient`,
///   2. `render(model)`: idempotent reconcile of the stable layers
///      (opponents, hand, trick, history, turn glow, bid bubbles),
///   3. entrance animations (card fly-in, bid pop, bore, rainbow, OT, chat).
/// Animations carry their deal / trick generation and only touch nodes of
/// that generation. No Combine subjects, no `$phase` sinks (22.2, 22.3).
class GameSKScene: SKScene, TableRenderer {
    private(set) var gameState: GameState?
    private var actions: ActionCoordinator?
    private var cancellables = Set<AnyCancellable>()
    private(set) var isSetUp = false

    var animator: Animator = LiveAnimator()
    private(set) var geometry = TableGeometry(size: .zero)
    private(set) var lastModel: TableRenderModel?

    // Static layers (built once)
    let backgroundNode = SKSpriteNode(color: UIColor(red: 0.05, green: 0.22, blue: 0.08, alpha: 1), size: .zero)
    let opponentsLayer = SKNode()
    let bidsLayer = SKNode()
    let transientLayer = SKNode()
    private(set) var cardManager: SKCardManager!
    private(set) var opponentManager: SKOpponentManager!
    private(set) var trickManager: SKTrickManager!
    private(set) var bidManager: SKBidManager!
    private(set) var chatManager: SKChatBubbleManager!
    private(set) var effectsManager: SKEffectsManager!

    var handNode: HandNode { cardManager.handNode }
    var trickArea: TrickAreaNode { trickManager.trickArea }

    /// Configure with the store and the action sender (sets itself as the store's renderer).
    func configure(gameState: GameState, actions: ActionCoordinator) {
        self.gameState = gameState
        self.actions = actions
        gameState.renderer = self
        if isSetUp && cancellables.isEmpty { subscribeSpeaking() }
        if view != nil || isSetUp { renderLatestFromStore(reset: true) }
    }

    override func didMove(to view: SKView) {
        backgroundColor = UIColor(red: 0.05, green: 0.15, blue: 0.05, alpha: 1)
        anchorPoint = CGPoint(x: 0.5, y: 0.5)
        scaleMode = .resizeFill
        buildLayersOnce()
        renderLatestFromStore(reset: true)
    }

    private func buildLayersOnce() {
        guard !isSetUp else { return }
        isSetUp = true
        geometry = TableGeometry(size: size)
        backgroundNode.name = "background"
        backgroundNode.zPosition = -100
        backgroundNode.size = size
        addChild(backgroundNode)
        opponentsLayer.name = "opponents"
        opponentsLayer.zPosition = 10
        addChild(opponentsLayer)
        bidsLayer.name = "bids"
        bidsLayer.zPosition = 60
        addChild(bidsLayer)
        transientLayer.name = "transient"
        transientLayer.zPosition = 500
        addChild(transientLayer)

        cardManager = SKCardManager(scene: self)
        cardManager.onPlay = { [weak self] card in self?.actions?.play(card) ?? false }
        addChild(cardManager.handNode)
        trickManager = SKTrickManager(scene: self)
        addChild(trickManager.trickArea)
        addChild(trickManager.trickHistory)
        opponentManager = SKOpponentManager(scene: self, layer: opponentsLayer)
        bidManager = SKBidManager(layer: bidsLayer)
        chatManager = SKChatBubbleManager(layer: transientLayer)
        effectsManager = SKEffectsManager(scene: self)
        subscribeSpeaking()
    }

    /// Voice speaking indicators (the one Combine sink left): socket id -> seat.
    private func subscribeSpeaking() {
        cancellables.removeAll()
        VoiceChatManager.shared.speakingChangedSubject
            .receive(on: DispatchQueue.main)
            .sink { [weak self] (socketId, isSpeaking) in
                guard let self, socketId != "self",
                      let pos = self.lastModel?.opponents.first(where: { $0.socketId == socketId })?.position else { return }
                self.opponentManager?.setSpeaking(position: pos, speaking: isSpeaking)
            }
            .store(in: &cancellables)
    }

    private func renderLatestFromStore(reset: Bool) {
        guard isSetUp, let gs = gameState else { return }
        let model = TableRenderModel(gs.state)
        lastModel = model
        render(model, reset: reset)
    }

    override func didChangeSize(_ oldSize: CGSize) {
        super.didChangeSize(oldSize)
        guard isSetUp else { return }
        geometry = TableGeometry(size: size)
        backgroundNode.size = size
        renderLatest()  // relays out every layer, opponents included
    }

    /// Re-render the latest model (collect completion, resize).
    func renderLatest() {
        if let m = lastModel { render(m) }
    }

    // MARK: - TableRenderer

    func apply(model: TableRenderModel, animations: [TableAnimation]) {
        guard isSetUp else { lastModel = model; return }
        lastModel = model
        let view = model.viewPosition

        // 1. exits
        for a in animations {
            switch a {
            case .trickCollected(let winner, let key):
                trickManager.collect(winner: winner, key: key, viewPosition: view, geometry: geometry, animator: animator)
            case .handsDestroyed:
                for s in handNode.sprites.values {
                    _ = handNode.detach(s.card.id)
                    s.removeFromParent()
                    transientLayer.addChild(s)
                    animator.fadeAndRemove(s, after: 0)
                }
            case .handCleared(let dealSeq):
                // anything left of the previous deal's tricks goes now
                for s in trickArea.cardSprites where (s.userData?["key"] as? String)?.hasPrefix("\(dealSeq):") == true { s.removeFromParent() }
            default:
                break
            }
        }

        // 2. reconcile
        let moved = render(model, reset: animations.contains(.sceneReset))

        // 3. entrances
        for a in animations {
            switch a {
            case .cardPlayed(let played, let key, _):
                guard key == model.trickKey || model.trick.contains(where: { $0.position == played.position && $0.card == played.card }) else { break }
                let name = TrickAreaNode.spriteName(played.position, played.card)
                guard !moved.contains(name) else { break }  // my hand's own sprite is already flying in
                let rel = Positions.getRelative(target: played.position, from: view)
                trickArea.animateEntry(name, from: geometry.trickEntry(rel), slot: geometry.trickSlot(rel), animator: animator)
            case .bidPlaced(let pos, _, _):
                bidManager.pop(position: pos, animator: animator)
            case .bore(_, let bid, _):
                effectsManager.showBoreBadge(bid)
            case .rainbow(let pos, _):
                effectsManager.showRainbow(position: pos, myPosition: view)
            case .overTrump:
                effectsManager.showOverTrump()
            case .chatBubble(let pos, let message):
                guard model.showsTable else { break }
                chatManager.show(position: pos, message: message, viewPosition: view, geometry: geometry, animator: animator)
            default:
                break
            }
        }
    }

    /// Idempotent: the stable layers show exactly `model`. Returns the trick
    /// sprites that came from my hand this render (they animate themselves).
    @discardableResult
    func render(_ model: TableRenderModel, reset: Bool = false) -> Set<String> {
        guard isSetUp else { return [] }
        lastModel = model
        if reset {
            // My own hand sprites stay (a rollback hands them back); everything else goes
            let mine = trickArea.cardSprites.compactMap { $0 as? CardSpriteNode }
            trickArea.clearAllCards()  // also zeroes collectingCount
            mine.forEach { trickArea.addChild($0) }
            transientLayer.removeAllChildren()
        }
        handNode.position = geometry.handBaseline
        trickManager.trickHistory.position = geometry.historyOrigin
        guard model.showsTable else {
            opponentManager.cleanup()
            handNode.cleanup()
            trickArea.clearAllCards()
            trickManager.trickHistory.setCounts(team: 0, opp: 0)
            bidManager.cleanup()
            return []
        }
        let me = model.viewPosition

        // Cross-container moves of my own card (22.4 / 22.7): hand -> trick on a
        // submit or a lazy-bot play, trick -> hand on a rollback
        var toHand: Set<String> = []
        if let hand = model.hand {
            for card in hand.cards where handNode.sprite(for: card.id) == nil {
                if let s = trickArea.sprite(named: TrickAreaNode.spriteName(me, card)) as? CardSpriteNode {
                    handNode.adopt(s)
                    toHand.insert(card.id)
                }
            }
        }

        var toTrick: [String: CardSpriteNode] = [:]
        if model.hand != nil {
            for c in model.trick where c.position == me && trickArea.sprite(named: TrickAreaNode.spriteName(me, c.card)) == nil {
                if let s = handNode.detach(c.card.id) { toTrick[c.card.id] = s }
            }
        }

        opponentManager.apply(model, geometry: geometry)
        cardManager.apply(model, geometry: geometry, arriving: toHand, animator: animator)
        let moved = trickArea.apply(cards: model.trick, key: model.trickKey, viewPosition: me, geometry: geometry, adopt: { c in
            c.position == me ? toTrick.removeValue(forKey: c.card.id) : nil
        }, animator: animator)
        toTrick.values.forEach { $0.removeFromParent() }
        trickManager.trickHistory.setCounts(team: model.history.team1, opp: model.history.team2)
        bidManager.apply(bubbles: model.bidBubbles, viewPosition: me, geometry: geometry)
        return moved
    }

    // MARK: - Cleanup

    func cleanupAll() {
        cancellables.removeAll()
        if gameState?.renderer === self { gameState?.renderer = nil }
    }
}
