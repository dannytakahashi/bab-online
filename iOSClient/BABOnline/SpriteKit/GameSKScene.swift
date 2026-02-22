import SpriteKit
import Combine

/// Main SpriteKit scene — coordinates all game visual managers.
/// Subscribes to GameState via Combine for reactive updates.
class GameSKScene: SKScene {
    private var gameState: GameState!
    private var cancellables = Set<AnyCancellable>()
    private var isSetUp = false
    private var didMoveToView = false

    // Managers
    private(set) var drawManager: SKDrawManager!
    private(set) var cardManager: SKCardManager!
    private(set) var opponentManager: SKOpponentManager!
    private(set) var trickManager: SKTrickManager!
    private(set) var bidManager: SKBidManager!
    private(set) var effectsManager: SKEffectsManager!

    // Background
    private var backgroundNode: SKSpriteNode?

    /// Configure with game state. Call once.
    func configure(gameState: GameState) {
        self.gameState = gameState
        // If didMove already fired, run setup now
        if didMoveToView && !isSetUp {
            performSetup()
        }
    }

    override func didMove(to view: SKView) {
        didMoveToView = true
        backgroundColor = UIColor(red: 0.05, green: 0.15, blue: 0.05, alpha: 1)
        anchorPoint = CGPoint(x: 0.5, y: 0.5) // Center-origin coordinate system
        scaleMode = .resizeFill

        // If gameState is already configured, set up now
        if gameState != nil && !isSetUp {
            performSetup()
        }
    }

    private func performSetup() {
        guard gameState != nil, !isSetUp else { return }
        isSetUp = true
        print("[GameSKScene] Setting up scene, phase: \(gameState.phase)")

        setupBackground()
        initializeManagers()
        subscribeToState()
        handleCurrentPhase()
    }

    override func didChangeSize(_ oldSize: CGSize) {
        super.didChangeSize(oldSize)
        guard gameState != nil else { return }

        setupBackground()
        repositionAll()
    }

    // MARK: - Setup

    private func setupBackground() {
        backgroundNode?.removeFromParent()
        // Programmatic green felt background — no asset needed
        let bg = SKSpriteNode(color: UIColor(red: 0.05, green: 0.22, blue: 0.08, alpha: 1), size: size)
        bg.position = .zero
        bg.zPosition = -100
        addChild(bg)
        backgroundNode = bg
    }

    private func initializeManagers() {
        drawManager = SKDrawManager(scene: self)
        cardManager = SKCardManager(scene: self)
        opponentManager = SKOpponentManager(scene: self)
        trickManager = SKTrickManager(scene: self)
        bidManager = SKBidManager(scene: self)
        effectsManager = SKEffectsManager(scene: self)
    }

    private func repositionAll() {
        cardManager?.positionHand()
        // Opponent and trick positions recalculate from scene.size automatically
        if gameState.phase == .playing || gameState.phase == .bidding {
            cardManager?.updateHand()
        }
    }

    // MARK: - State Subscriptions

    private func subscribeToState() {
        // Phase changes
        gameState.$phase
            .receive(on: DispatchQueue.main)
            .sink { [weak self] phase in
                self?.handlePhaseChange(phase)
            }
            .store(in: &cancellables)

        // Hand changes
        gameState.$myCards
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self, self.gameState.phase == .bidding || self.gameState.phase == .playing else { return }
                self.cardManager?.updateHand()
            }
            .store(in: &cancellables)

        // Turn changes
        gameState.$currentTurn
            .receive(on: DispatchQueue.main)
            .sink { [weak self] turn in
                self?.opponentManager?.updateTurn(currentTurn: turn)
                if self?.gameState.phase == .playing {
                    self?.cardManager?.updateHand()
                }
            }
            .store(in: &cancellables)

        // Card played events
        gameState.cardPlayedSubject
            .receive(on: DispatchQueue.main)
            .sink { [weak self] played in
                self?.handleCardPlayed(played)
            }
            .store(in: &cancellables)

        // Trick complete events
        gameState.trickCompleteSubject
            .receive(on: DispatchQueue.main)
            .sink { [weak self] winner in
                self?.handleTrickComplete(winner: winner)
            }
            .store(in: &cancellables)

        // Hand complete events
        gameState.handCompleteSubject
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.handleHandComplete()
            }
            .store(in: &cancellables)

        // Destroy hands
        gameState.destroyHandsSubject
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in
                self?.handleDestroyHands()
            }
            .store(in: &cancellables)

        // Rainbow
        gameState.rainbowSubject
            .receive(on: DispatchQueue.main)
            .sink { [weak self] position in
                guard let self, let myPos = self.gameState.position else { return }
                self.effectsManager?.showRainbow(position: position, myPosition: myPos)
            }
            .store(in: &cancellables)

        // Bid received
        gameState.bidReceivedSubject
            .receive(on: DispatchQueue.main)
            .sink { [weak self] (position, bid) in
                guard let self, let myPos = self.gameState.position else { return }
                self.bidManager?.showBid(position: position, bid: bid, myPosition: myPos)
            }
            .store(in: &cancellables)

        // Draw phase results and teams announced — handled by SwiftUI DrawPhaseView
    }

    // MARK: - Phase Handling

    private func handleCurrentPhase() {
        handlePhaseChange(gameState.phase)
    }

    private func handlePhaseChange(_ phase: GamePhase) {
        switch phase {
        case .draw:
            // Handled by SwiftUI DrawPhaseView
            break
        case .bidding:
            setupGameUI()
        case .playing:
            setupGameUI()
        case .ended:
            // Handled by SwiftUI overlay
            break
        default:
            break
        }
    }

    private func setupGameUI() {
        drawManager?.cleanup()
        cardManager?.setup(gameState: gameState)
        opponentManager?.setup(gameState: gameState)
        trickManager?.setup(gameState: gameState)

        cardManager?.updateHand()
    }

    // MARK: - Event Handlers

    private func handleCardPlayed(_ played: PlayedCard) {
        guard let myPos = gameState.position else { return }

        let trickPos = trickManager?.trickPosition(for: played.position) ?? .zero

        if played.position == myPos {
            // Our card — animate from hand to trick area
            cardManager?.animateCardToTrick(card: played.card, trickPosition: trickPos)
        } else {
            // Opponent card — animate face-up card from off-screen to trick area
            opponentManager?.animateOpponentCard(
                card: played.card,
                fromPosition: played.position,
                toTrickPoint: trickPos
            )
        }

        // Place card face-up in trick area
        trickManager?.placeCard(played.card, position: played.position)
    }

    private func handleTrickComplete(winner: Int) {
        trickManager?.collectTrick(winner: winner) { [weak self] in
            // Trick collected — ready for next trick
            self?.cardManager?.updateHand()
        }
    }

    private func handleHandComplete() {
        // Clear bids and trick history for next hand
        bidManager?.clearAll()
        opponentManager?.clearAllBids()
        trickManager?.clearHistory()
    }

    private func handleDestroyHands() {
        cardManager?.cleanup()
        opponentManager?.cleanup()
        trickManager?.cleanup()
        bidManager?.cleanup()
    }

    // MARK: - Cleanup

    func cleanupAll() {
        cancellables.removeAll()
        drawManager?.cleanup()
        cardManager?.cleanup()
        opponentManager?.cleanup()
        trickManager?.cleanup()
        bidManager?.cleanup()
        effectsManager?.cleanup()
    }
}
