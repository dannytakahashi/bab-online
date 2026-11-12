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
    private(set) var layout = TableLayout(size: .zero)
    /// Measured by GameContainerView (safe area, ScoreBar, corner buttons, pill, fold).
    var chrome = TableChrome() {
        didSet {
            guard chrome != oldValue else { return }
            var sameButFold = chrome
            sameButFold.fold = oldValue.fold
            // a fold toggling at the same size glides; everything else snaps
            relayout(animated: sameButFold == oldValue)
        }
    }
    #if DEBUG
    /// Relayouts that moved something (fixture probes).
    private(set) var relayoutCount = 0
    /// didMove(to:) calls (fixture probe: a SpriteView identity change shows as 2).
    private(set) var didMoveCount = 0
    #endif
    private(set) var lastModel: TableRenderModel?

    // Static layers (built once)
    /// The felt: the web table's radial gradient (felt.light -> base -> deep -> edge), stretched to the scene.
    let backgroundNode = SKSpriteNode(texture: GameSKScene.feltTexture, color: Theme.SK.felt, size: .zero)
    let opponentsLayer = SKNode()
    let bidsLayer = SKNode()
    let transientLayer = SKNode()
    /// My own seat's trick pips (I have no avatar): at `layout.myPips`, in the opponents layer.
    let myPipsNode = SeatPipsNode(style: .box)
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
        #if DEBUG
        didMoveCount += 1
        #endif
        backgroundColor = Theme.SK.sceneBackground
        anchorPoint = CGPoint(x: 0.5, y: 0.5)
        scaleMode = .resizeFill
        buildLayersOnce()
        renderLatestFromStore(reset: true)
        #if DEBUG
        if let effect = UIFixture.effect, didMoveCount == 1 {
            // after the chrome relayouts of the first second (a reset render clears transient)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self else { return }
                self.effectsManager.showFrozen(effect, myPosition: self.lastModel?.viewPosition ?? 1)
            }
        }
        #endif
    }

    private func buildLayersOnce() {
        guard !isSetUp else { return }
        isSetUp = true
        layout = TableLayout(size: size, chrome: chrome)
        #if DEBUG
        logLayout()
        #endif
        backgroundNode.name = "background"
        backgroundNode.zPosition = -100
        backgroundNode.size = size
        addChild(backgroundNode)
        opponentsLayer.name = "opponents"
        opponentsLayer.zPosition = 10
        addChild(opponentsLayer)
        myPipsNode.name = "pips.mine"
        opponentsLayer.addChild(myPipsNode)
        bidsLayer.name = "bids"
        bidsLayer.zPosition = 60
        addChild(bidsLayer)
        transientLayer.name = "transient"
        transientLayer.zPosition = 500
        addChild(transientLayer)

        cardManager = SKCardManager(scene: self)
        cardManager.onPlay = { [weak self] card in self?.actions?.play(card) ?? false }
        addChild(cardManager.handNode)
        #if DEBUG
        cardManager.handNode.onLiftChanged = { [weak self] in self?.probe() }  // "table.state" lifted= after a tap
        #endif
        trickManager = SKTrickManager(scene: self)
        addChild(trickManager.trickArea)
        addChild(trickManager.trickHistory)
        opponentManager = SKOpponentManager(scene: self, layer: opponentsLayer)
        bidManager = SKBidManager(layer: bidsLayer)
        chatManager = SKChatBubbleManager(layer: transientLayer)
        effectsManager = SKEffectsManager(scene: self)
        subscribeSpeaking()
        #if DEBUG
        // TableLayout positions are scene coordinates: every layer stays at the origin
        for layer in [opponentsLayer, bidsLayer, trickArea, transientLayer, backgroundNode] as [SKNode] {
            assert(layer.position == .zero, "\(layer.name ?? "?") must stay at (0,0)")
        }
        #endif
    }

    /// Voice speaking indicators (the one Combine sink left): voice peer -> seat, by the
    /// peer's username (TableRenderModel.seat(forVoicePeer:)), the seat socket id as a fallback.
    private func subscribeSpeaking() {
        cancellables.removeAll()
        VoiceChatManager.shared.speakingChangedSubject
            .receive(on: DispatchQueue.main)
            .sink { [weak self] (socketId, isSpeaking) in
                guard let self, socketId != "self" else { return }
                let username = VoiceChatManager.shared.peerInfos[socketId]?.username
                guard let pos = self.lastModel?.seat(forVoicePeer: socketId, username: username) else { return }
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
        relayout(animated: false)
    }

    /// Full relayout (item 25): a new TableLayout moves every existing node,
    /// in-flight ones included (a running move is re-aimed or snapped, a lift
    /// is cut short, a pop keeps going), then the latest model re-renders.
    /// Size changes are instant; a fold-only change uses the scene animator.
    /// Collects and handsDestroyed fades in flight finish at their old
    /// target (<= 0.4 s, fading). Idempotent: an unchanged layout is a no-op.
    func relayout(animated: Bool) {
        guard isSetUp else { return }
        let new = TableLayout(size: size, chrome: chrome)
        if new == layout && backgroundNode.size == size { return }
        layout = new
        backgroundNode.size = size
        let a: Animator = animated ? animator : InstantAnimator()
        let v = lastModel?.viewPosition ?? 1
        opponentManager.apply(layout: new, animator: a, animated: animated)
        cardManager.apply(layout: new, animator: a)
        trickManager.apply(layout: new, viewPosition: v, animator: a)
        bidManager.apply(layout: new, viewPosition: v, animator: a, animated: animated)
        chatManager.apply(layout: new)
        effectsManager.apply(layout: new)
        #if DEBUG
        relayoutCount += 1
        probe()
        logLayout()
        #endif
        renderLatest()
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
                trickManager.collect(winner: winner, key: key, viewPosition: view, layout: layout, animator: animator)
            case .handsDestroyed:
                // the sprites fade where they are: convert from the scaled hand node
                // into the transient layer (as TrickAreaNode's adopt does)
                for s in handNode.sprites.values {
                    let world = handNode.convert(s.position, to: transientLayer)
                    let ws = s.xScale * handNode.xScale, hs = s.yScale * handNode.yScale
                    let rot = s.zRotation + handNode.zRotation
                    _ = handNode.detach(s.card.id)
                    s.removeFromParent()
                    s.position = world
                    s.xScale = ws
                    s.yScale = hs
                    s.zRotation = rot
                    transientLayer.addChild(s)
                    animator.fadeAndRemove(s, after: 0)
                }
            default:
                // .handCleared needs nothing here: the reconcile below removes
                // every trick sprite the model no longer has, and a collect in
                // flight lives in the transient layer
                break
            }
        }

        // 2. reconcile
        let changes = render(model, reset: animations.contains(.sceneReset))

        // 3. entrances
        for a in animations {
            switch a {
            case .cardPlayed(let played, let key, _):
                guard key == model.trickKey || model.trick.contains(where: { $0.position == played.position && $0.card == played.card }) else { break }
                let name = TrickAreaNode.spriteName(played.position, played.card)
                // Only a sprite this render built flies in: my hand's sprite flies
                // itself (adopted), and my submitted card is already in its slot
                // when a late cardPlayed confirms it
                guard changes.created.contains(name) else { break }
                let rel = Positions.getRelative(target: played.position, from: view)
                trickArea.animateEntry(name, from: layout.trickEntry(rel), slot: layout.trickSlot(rel), animator: animator)
            case .bidPlaced(let pos, _, _):
                bidManager.pop(position: pos, animator: animator)
            case .bore(_, let bid, _):
                effectsManager.showBoreBadge(bid)
            case .rainbow(let pos, _):
                effectsManager.showRainbow(position: pos, myPosition: view)
            case .overTrump:
                effectsManager.showOverTrump()
            case .chatBubble(let pos, let message):
                // Not over my own hand (the bottom seat's spot): the log shows my line
                guard model.showsTable, !(model.hand != nil && pos == model.viewPosition) else { break }
                chatManager.show(position: pos, message: message, viewPosition: view, layout: layout, animator: animator)
            case .spectatorChatBubble(let username, let message):
                // by the spectator badge, shown even before the coalesced list makes the badge appear
                guard model.showsTable else { break }
                chatManager.showSpectator(username: username, message: message, spectating: model.hand == nil, layout: layout, animator: animator)
            default:
                break
            }
        }
    }

    /// Idempotent: the stable layers show exactly `model`. Returns what the
    /// trick reconcile changed (entrances fly only sprites it created).
    @discardableResult
    func render(_ model: TableRenderModel, reset: Bool = false) -> TrickAreaNode.Changes {
        guard isSetUp else { return .init() }
        lastModel = model
        #if DEBUG
        defer { probe() }
        #endif
        if reset {
            // My own hand sprites stay (a rollback hands them back); everything else goes
            let mine = trickArea.cardSprites.compactMap { $0 as? CardSpriteNode }
            trickArea.clearAllCards()  // also zeroes collectingCount
            mine.forEach { trickArea.addChild($0) }
            // Stop what flies in transient first: its completions (collect,
            // fades) hold the nodes, and a cut-off collect must not run later
            Self.stopActions(transientLayer)
            transientLayer.removeAllChildren()
        }
        handNode.position = layout.handBaseline
        handNode.setScale(layout.handScale)
        trickManager.trickHistory.position = layout.historyOrigin
        // Game over: the final table stays behind GameEndView (as before 23)
        if model.keepsLastTable { return .init() }
        guard model.showsTable else {
            opponentManager.cleanup()
            handNode.cleanup()
            trickArea.clearAllCards()
            trickManager.trickHistory.setCounts(team: 0, opp: 0, spacing: layout.historySpacing, totals: .some(nil))
            myPipsNode.update(nil, team: 1)
            bidManager.cleanup()
            return .init()
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

        opponentManager.apply(model, layout: layout)
        cardManager.apply(model, layout: layout, arriving: toHand, animator: animator)
        let changes = trickArea.apply(cards: model.trick, key: model.trickKey, viewPosition: me, layout: layout, adopt: { c in
            c.position == me ? toTrick.removeValue(forKey: c.card.id) : nil
        }, animator: animator)
        toTrick.values.forEach { $0.removeFromParent() }
        trickManager.trickHistory.setCounts(team: model.history.team1, opp: model.history.team2, spacing: layout.historySpacing,
                                            totals: .some(model.pileTotals.map { (team: $0.team1, opp: $0.team2) }))
        myPipsNode.position = CGPoint(x: layout.myPips.midX, y: layout.myPips.midY)
        myPipsNode.update(model.myPips, team: Positions.getTeamNumber(me))
        bidManager.apply(bubbles: model.bidBubbles, viewPosition: me, layout: layout)
        return changes
    }

    #if DEBUG
    private func logLayout() {
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        let i = chrome.safeArea, L = layout
        print("[Layout] \(Int(size.width))x\(Int(size.height)) insets \(i.top)/\(i.left)/\(i.bottom)/\(i.right) topBar \(chrome.topBar) "
              + "corner \(chrome.cornerButton) bottomBar \(chrome.bottomBar) fold \(chrome.fold.map { "\($0)" } ?? "-") "
              + "occlusions \(chrome.occlusions.count) -> s \(L.handScale) k \(L.trickScale) \(L.mode) degraded \(L.isDegraded) usedBottomBar \(L.usedBottomBar)")
    }

    /// Fixture mode: refresh the UI tests' "table.layoutCheck" / "table.state" probes.
    private func probe() {
        guard UIFixture.isActive else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            TableDebugProbe.shared.update(scene: self)
        }
    }
    #endif

    private static func stopActions(_ node: SKNode) {
        node.removeAllActions()
        node.children.forEach { stopActions($0) }
    }

    // MARK: - Cleanup

    func cleanupAll() {
        cancellables.removeAll()
        if gameState?.renderer === self { gameState?.renderer = nil }
    }
}

extension GameSKScene {
    /// table.css's felt, `radial-gradient(ellipse 75% 70% at 50% 48%, felt.light / 0.95 0%,
    /// felt.base / 0.98 46%, felt.deep 78%, felt.edge 100%)`, drawn once into a small
    /// texture; the background sprite stretches it to the scene, so the ellipse keeps
    /// its 75% x 70% proportions in every size.
    static let feltTexture: SKTexture = {
        let side: CGFloat = 256
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { ctx in
            let gc = ctx.cgContext
            let P = Theme.Palette.Felt.self
            Theme.Palette.Felt.edge.uiColor.setFill()
            gc.fill(CGRect(x: 0, y: 0, width: side, height: side))
            let stops: [(ThemeColor, CGFloat)] = [(P.light.opacity(0.95), 0), (P.base.opacity(0.98), 0.46), (P.deep, 0.78), (P.edge, 1)]
            // the stops over the edge color, opaque (the scene composites nothing under it)
            let colors = stops.map { c, _ -> CGColor in
                let a = c.alpha, e = P.edge
                return UIColor(red: c.red * a + e.red * (1 - a), green: c.green * a + e.green * (1 - a),
                               blue: c.blue * a + e.blue * (1 - a), alpha: 1).cgColor
            }
            var locations = stops.map(\.1)
            guard let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray,
                                            locations: &locations) else { return }
            // an ellipse with radii 75% x 70% of the box, centred at 50% / 48% (y down)
            gc.translateBy(x: side * 0.5, y: side * 0.48)
            gc.scaleBy(x: 0.75, y: 0.70)
            gc.drawRadialGradient(gradient, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: side,
                                  options: [.drawsAfterEndLocation])
        }
        let texture = SKTexture(image: image)
        texture.filteringMode = .linear
        return texture
    }()
}
