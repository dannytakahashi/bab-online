import SpriteKit
import Combine

/// Main SpriteKit scene. The store calls `apply(model:animations:)`
/// synchronously after every commit (no Combine subjects, no `$phase` sinks).
/// Interim adapter: one rebuild path over the existing managers.
class GameSKScene: SKScene, TableRenderer {
    private var gameState: GameState!
    private var actions: ActionCoordinator!
    private var cancellables = Set<AnyCancellable>()
    private var isSetUp = false
    private var didMoveToView = false
    private(set) var lastModel: TableRenderModel?
    private var builtFor: (gameId: String?, view: Int, spectator: Bool, table: Bool)?

    // Managers
    private(set) var cardManager: SKCardManager!
    private(set) var opponentManager: SKOpponentManager!
    private(set) var trickManager: SKTrickManager!
    private(set) var bidManager: SKBidManager!
    private(set) var effectsManager: SKEffectsManager!

    private var backgroundNode: SKSpriteNode?

    /// Configure with the store and the action sender. Call once.
    func configure(gameState: GameState, actions: ActionCoordinator) {
        self.gameState = gameState
        self.actions = actions
        gameState.renderer = self
        if didMoveToView && !isSetUp { performSetup() }
    }

    override func didMove(to view: SKView) {
        didMoveToView = true
        backgroundColor = UIColor(red: 0.05, green: 0.15, blue: 0.05, alpha: 1)
        anchorPoint = CGPoint(x: 0.5, y: 0.5)
        scaleMode = .resizeFill
        if gameState != nil && !isSetUp { performSetup() }
    }

    private func performSetup() {
        guard gameState != nil, !isSetUp else { return }
        isSetUp = true
        setupBackground()
        cardManager = SKCardManager(scene: self)
        cardManager.onPlay = { [weak self] card in self?.actions.play(card) ?? false }
        opponentManager = SKOpponentManager(scene: self)
        trickManager = SKTrickManager(scene: self)
        bidManager = SKBidManager(scene: self)
        effectsManager = SKEffectsManager(scene: self)

        // Voice speaking indicators: socket id -> seat
        VoiceChatManager.shared.speakingChangedSubject
            .receive(on: DispatchQueue.main)
            .sink { [weak self] (socketId, isSpeaking) in
                guard let self, socketId != "self",
                      let pos = self.lastModel?.opponents.first(where: { $0.socketId == socketId })?.position else { return }
                self.opponentManager?.setSpeaking(position: pos, speaking: isSpeaking)
            }
            .store(in: &cancellables)

        apply(model: TableRenderModel(gameState.state), animations: [.sceneReset])
    }

    override func didChangeSize(_ oldSize: CGSize) {
        super.didChangeSize(oldSize)
        guard isSetUp else { return }
        setupBackground()
        if let m = lastModel { rebuild(m) }
    }

    private func setupBackground() {
        backgroundNode?.removeFromParent()
        let bg = SKSpriteNode(color: UIColor(red: 0.05, green: 0.22, blue: 0.08, alpha: 1), size: size)
        bg.position = .zero
        bg.zPosition = -100
        addChild(bg)
        backgroundNode = bg
    }

    // MARK: - TableRenderer

    func apply(model: TableRenderModel, animations: [TableAnimation]) {
        guard isSetUp else { lastModel = model; return }
        let key = (gameId: model.gameId, view: model.viewPosition, spectator: model.isSpectator, table: model.showsTable)
        let needsRebuild = animations.contains(.sceneReset) || builtFor.map { $0 != key } ?? true
        lastModel = model
        if needsRebuild { rebuild(model) }

        for a in animations {
            switch a {
            case .cardPlayed(let played, _, let byMe):
                guard model.showsTable else { break }
                if trickManager.trickCount >= 4 || (trickManager.trickCount > 0 && model.trick.count <= 1) { trickManager.clearTrickArea() }
                if byMe {
                    trickManager.placeCard(played.card, position: played.position)
                } else {
                    trickManager.placeCard(played.card, position: played.position, from: opponentManager.trickEntryPoint(forPosition: played.position))
                }
            case .trickCollected(let winner, _):
                trickManager.collectTrick(winner: winner) { [weak self] in
                    guard let self, let m = self.lastModel else { return }
                    self.cardManager.updateHand(m)
                }
            case .handCleared, .handsDestroyed:
                bidManager.clearAll()
                trickManager.clearHistory()
                trickManager.clearTrickArea()
            case .bidPlaced(let pos, let bid, _):
                bidManager.showBid(position: pos, bid: bid, myPosition: model.viewPosition)
            case .bore(_, let bid, _):
                effectsManager.showBoreBadge(bid)
            case .rainbow(let pos, _):
                effectsManager.showRainbow(position: pos, myPosition: model.viewPosition)
            case .overTrump:
                effectsManager.showOverTrump()
            case .chatBubble, .sceneReset:
                break
            }
        }

        if model.showsTable {
            cardManager.updateHand(model)
            opponentManager.update(model)
        }
    }

    /// The one setup path: idempotent from the model.
    private func rebuild(_ model: TableRenderModel) {
        builtFor = (gameId: model.gameId, view: model.viewPosition, spectator: model.isSpectator, table: model.showsTable)
        cardManager.cleanup()
        opponentManager.cleanup()
        trickManager.cleanup()
        bidManager.cleanup()
        guard model.showsTable else { return }
        if model.hand != nil { cardManager.setup() }
        opponentManager.setup(model)
        trickManager.setup(viewPosition: model.viewPosition)
        for c in model.trick where !c.provisional {
            trickManager.placeCard(c.card, position: c.position, animated: false)
        }
        for (pos, bid) in model.bidBubbles { bidManager.showBid(position: pos, bid: bid, myPosition: model.viewPosition) }
        cardManager.updateHand(model)
        opponentManager.update(model)
    }

    // MARK: - Cleanup

    func cleanupAll() {
        cancellables.removeAll()
        cardManager?.cleanup()
        opponentManager?.cleanup()
        trickManager?.cleanup()
        bidManager?.cleanup()
        effectsManager?.cleanup()
        builtFor = nil
        isSetUp = false
    }
}
