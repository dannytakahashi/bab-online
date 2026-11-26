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
    /// The chrome of SwiftUI's latest pass, waiting for `takeChrome`'s main-queue turn.
    private var pendingChrome: TableChrome?

    /// SwiftUI's chrome from a view pass (GameContainerView): applied on the next main-queue
    /// turn, never during the pass, and only the latest of a burst (an unchanged one is a no-op).
    func takeChrome(_ c: TableChrome) {
        let scheduled = pendingChrome != nil
        pendingChrome = c
        guard !scheduled else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, let c = self.pendingChrome else { return }
            self.pendingChrome = nil
            self.chrome = c
            #if DEBUG
            if UIFixture.isActive { TableDebugProbe.shared.chrome = c }
            #endif
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
    /// The zoomed table's camera (TableLayout.zoom > 1: an iPad): at the origin, scaled
    /// 1 / zoom, so the scene's units (the layout's) fill the pane. A zoom-1 layout (every
    /// phone) uses no camera, so the scene renders exactly as before.
    let zoomCamera = SKCameraNode()
    /// My own seat's trick pips (I have no avatar): in my seat's row at `layout.myPips`
    /// (`layout.myPipsCenter`), in the opponents layer.
    let myPipsNode = SeatPipsNode(style: .box)
    /// My own dealer marker (I have no avatar): at the left end of my hand
    /// (`layout.myDealerChip`), under the hand's cards, so a lifted card covers it.
    let myDealerNode = DealerChipNode()
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
        if !UIFixture.chat.isEmpty, didMoveCount == 1 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, let gs = self.gameState else { return }
                for line in UIFixture.chat { _ = gs.apply(serverEvent: "chatMessage", payload: [line]) }
                self.chatManager.freeze()
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
        backgroundNode.role = "background"  // roles, not names: SpriteKit reads a named node by its name
        backgroundNode.zPosition = -100
        backgroundNode.size = layout.size
        applyZoom()
        backgroundNode.hideFromAccessibility()
        addChild(backgroundNode)
        opponentsLayer.role = "opponents"
        opponentsLayer.zPosition = 10
        addChild(opponentsLayer)
        opponentsLayer.addChild(myPipsNode)
        myDealerNode.zPosition = -1
        addChild(myDealerNode)
        bidsLayer.role = "bids"
        bidsLayer.zPosition = 60
        addChild(bidsLayer)
        transientLayer.role = "transient"
        transientLayer.zPosition = 500
        addChild(transientLayer)

        cardManager = SKCardManager(scene: self)
        cardManager.onPlay = { [weak self] card in self?.actions?.play(card) ?? false }
        cardManager.onBlocked = { [weak self] why in self?.gameState?.postNotice(why) }
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
        // the felt's size is stored as Float: a zoomed layout's scene size (pane / zoom) is not exact there
        let felt = backgroundNode.size
        if new == layout && abs(felt.width - new.size.width) < 0.01 && abs(felt.height - new.size.height) < 0.01 { return }
        layout = new
        backgroundNode.size = new.size
        applyZoom()
        syncWatchedChat()
        let a: Animator = animated ? animator : InstantAnimator()
        let v = lastModel?.viewPosition ?? 1
        opponentManager.apply(layout: new, animator: a, animated: animated)
        cardManager.apply(layout: new, animator: a)
        trickManager.apply(layout: new, viewPosition: v, animator: a)
        bidManager.apply(layout: new, viewPosition: v, animator: a, animated: animated)
        chatManager.apply(layout: new)
        effectsManager.apply(layout: new)
        placeDealDeck()
        #if DEBUG
        relayoutCount += 1
        probe()
        logLayout()
        #endif
        renderLatest()
    }

    /// The camera for the layout's zoom: none at zoom 1 (added once, the first time a
    /// layout zooms; it stays a child while unused, and SpriteKit ignores it then).
    private func applyZoom() {
        guard layout.zoom != 1 else {
            camera = nil
            return
        }
        if zoomCamera.parent == nil {
            zoomCamera.role = "camera"
            zoomCamera.hideFromAccessibility()
            addChild(zoomCamera)
        }
        zoomCamera.position = .zero
        zoomCamera.setScale(1 / layout.zoom)
        camera = zoomCamera
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
                let rel = Positions.getRelative(target: played.position, from: view, seats: model.seats)
                trickArea.animateEntry(name, from: cardEntry(rel, model: model), slot: layout.trickSlot(rel), animator: animator)
            case .bidPlaced(let pos, _, _):
                bidManager.pop(position: pos, animator: animator)
            case .bore(_, let bid, _):
                effectsManager.showBoreBadge(bid)
            case .rainbow(let pos, _):
                effectsManager.showRainbow(position: pos, myPosition: view)
            case .overTrump:
                effectsManager.showOverTrump()
            case .helpBadge(let pos):
                guard model.showsTable else { break }
                let popped = opponentManager.popBadge(position: pos, animator: animator)
                #if DEBUG
                if popped {
                    badgePops += 1
                    lastBadgePop = Theme.Motion.reduceMotion ? "fade" : "scale"
                }
                #endif
                _ = popped
            case .dealt(let seq):
                // this render's deal only (a later deal in the same commit owns the table)
                guard seq == model.dealSeq, model.showsTable, !model.keepsLastTable else { break }
                dealIn(back: model.back)
            case .chatBubble(let pos, let message):
                // Not over my own hand (the bottom seat's spot): the log shows my line. A watcher's
                // bottom seat is the watched player's, whose lines show above that hand, beside its
                // row and clear of the /help column (TableLayout+WatchedChat), never on the hand
                guard model.showsTable, !(model.hand != nil && pos == model.viewPosition && model.watchedSeat == nil) else { break }
                if model.watchedSeat != nil, pos == model.viewPosition {
                    chatManager.showWatched(position: pos, message: message, context: watchedChatContext(model), layout: layout, animator: animator)
                } else {
                    chatManager.show(position: pos, message: message, viewPosition: view, layout: layout, animator: animator)
                }
            case .spectatorChatBubble(let username, let message):
                // by the spectator badge, shown even before the coalesced list makes the badge appear
                guard model.showsTable else { break }
                chatManager.showSpectator(username: username, message: message, spectating: model.hand == nil,
                                          watcherBidding: model.watchedSeat != nil ? model.bidding : nil, layout: layout, animator: animator)
            default:
                break
            }
        }
    }

    /// The /help column's visible frame in the pane's points (GameContainerView), nil while it is
    /// not up: the watched player's chat bubble keeps clear of it (the SwiftUI cards are drawn
    /// over the scene, so a bubble under them would be hidden).
    var assistColumnFrame: CGRect? {
        didSet { if oldValue != assistColumnFrame { syncWatchedChat() } }
    }

    /// What places the watched player's bubble now.
    func watchedChatContext(_ model: TableRenderModel?) -> SKChatBubbleManager.WatchedChat {
        SKChatBubbleManager.WatchedChat(bidding: model?.bidding ?? false,
                                        column: assistColumnFrame.map { layout.scene(fromWindow: $0) })
    }

    /// A live watched bubble follows the bidding phase and the /help column.
    private func syncWatchedChat() {
        guard isSetUp, chatManager != nil else { return }
        chatManager.setWatchedContext(watchedChatContext(lastModel), layout: layout)
    }

    /// Idempotent: the stable layers show exactly `model`. Returns what the
    /// trick reconcile changed (entrances fly only sprites it created).
    @discardableResult
    func render(_ model: TableRenderModel, reset: Bool = false) -> TrickAreaNode.Changes {
        guard isSetUp else { return .init() }
        lastModel = model
        syncWatchedChat()
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
            // a snapshot shows the table as it is: a deal in flight lands now
            removeDealDeck()
            handNode.sprites.values.forEach { $0.finishDeal() }
            opponentManager.nodes.values.forEach { $0.fanNode.children.forEach { $0.finishDeal() } }
        }
        handNode.position = layout.handBaseline
        handNode.setScale(layout.handScale)
        trickManager.trickHistory.position = layout.historyOrigin
        placeMyPips()
        // Game over: the final table stays behind GameEndView (as before 23)
        if model.keepsLastTable { return .init() }
        guard model.showsTable else {
            opponentManager.cleanup()
            handNode.cleanup()
            trickArea.clearAllCards()
            trickManager.trickHistory.setCounts(team: 0, opp: 0, opp2: 0, spacing: layout.historySpacing, totals: .some(nil))
            myPipsNode.update(nil, team: 1)
            placeMyPips()
            myDealerNode.update(shown: false)
            placeMyWatchers(model)
            bidManager.cleanup()
            return .init()
        }
        let me = model.viewPosition
        // Get Your Bid: three seats (no partner across); every manager places seats by it
        trickArea.seats = model.seats
        trickManager.seats = model.seats
        effectsManager.seats = model.seats
        bidManager.seats = model.seats
        chatManager.seats = model.seats

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
        // three seats: a pile per seat, each in its seat's colour with its own bid's border
        let solo = model.soloPiles
        trickManager.trickHistory.setCounts(team: model.history.team1, opp: model.history.team2, opp2: solo?.opp2Won ?? 0,
                                            spacing: layout.historySpacing,
                                            totals: .some(model.pileTotals.map { (team: $0.team1, opp: $0.team2) }),
                                            opp2Total: solo?.opp2Total,
                                            myTeam: Positions.colour(me, seats: model.seats),
                                            solo: .some(solo.map { .init(opp: Positions.colour($0.opp, seats: 3),
                                                                         opp2: Positions.colour($0.opp2, seats: 3)) }))
        myPipsNode.update(model.myPips, team: Positions.colour(me, seats: model.seats))
        placeMyPips()
        placeMyDealer(model)
        placeMyWatchers(model)
        bidManager.apply(bubbles: model.bidBubbles, viewPosition: me, layout: layout)
        return changes
    }

    /// My pips' pill in my seat's row, against its neighbour (TableLayout.myPipsCenter); an
    /// empty node waits at its box's centre (a pure function of what it shows: idempotent).
    private func placeMyPips() {
        let slots = myPipsNode.pips?.slots ?? 0
        myPipsNode.position = slots > 0 ? layout.myPipsCenter(slots: slots) : CGPoint(x: layout.myPips.midX, y: layout.myPips.midY)
    }

    /// My dealer marker by my hand (a pure function of the model and the layout).
    private func placeMyDealer(_ model: TableRenderModel) {
        let chip = layout.myDealerChip(handCount: model.hand?.cards.count ?? 0)
        myDealerNode.position = model.iDeal ? CGPoint(x: chip.midX, y: chip.midY) : .zero
        myDealerNode.update(shown: model.iDeal)
    }

    // MARK: - The deal

    /// The deck a live deal flies from (a few backs of the hand's colour at the hand's card
    /// size at `layout.dealOrigin`), up while the cards leave it; nil otherwise.
    private(set) var dealDeck: SKNode?
    #if DEBUG
    /// Lightbulb pops shown, and the latest one's kind (scale, or Reduce Motion's fade; fixture probe "table.badges").
    private(set) var badgePops = 0
    private(set) var lastBadgePop = "-"
    /// Live deals shown, and the latest one's cards and kind (fixture probe "table.deal").
    private(set) var dealsShown = 0
    private(set) var lastDeal = (cards: 0, mode: "-")
    #endif

    /// A live deal (`.dealt`): my hand's cards, then every seat's card backs, leave the deck
    /// one `Deal.stagger` after another after `Deal.wait`, each flying `Deal.flight` into the
    /// place the render just gave it (the web's CardManager / OpponentManager deal; the same
    /// motion tokens). Cosmetic: nothing waits for it (taps, the bid panel and the server's
    /// pacing go on as before; a tap lands its card at once). Under Reduce Motion the cards
    /// fade in where they are and no deck shows. A snapshot, a later deal or a relayout
    /// never replays it: a relayout re-aims the flights, a snapshot lands them. The deck's
    /// backs are `back`, the hand's colour (`model.back`), as the fans' backs it deals.
    func dealIn(back colour: CardBackColour) {
        removeDealDeck()
        let reduce = Theme.Motion.reduceMotion
        let mine = handNode.sprites.values.sorted { $0.zPosition < $1.zPosition }
        for (i, s) in mine.enumerated() {
            animator.deal(s, delay: Deal.wait + Double(i) * Deal.stagger, duration: Deal.flight) { [weak self] n in
                self?.dealStart(n, width: LayoutConstants.cardWidth)
            }
        }
        var most = mine.count
        for seat in opponentManager.nodes.values {
            let backs = seat.fanNode.children.sorted { $0.zPosition < $1.zPosition }
            most = max(most, backs.count)
            for (i, b) in backs.enumerated() {
                animator.deal(b, delay: Deal.wait + Double(i) * Deal.stagger, duration: Deal.flight) { [weak self] n in
                    self?.dealStart(n, width: TableLayout.fanCard.width)
                }
            }
        }
        guard most > 0 else { return }
        #if DEBUG
        dealsShown += 1
        lastDeal = (mine.count + opponentManager.nodes.values.reduce(0) { $0 + $1.fanNode.children.count }, reduce ? "fade" : "fly")
        dealProbe(after: Deal.wait + Double(most - 1) * Deal.stagger + Deal.flight)
        #endif
        guard !reduce else { return }
        let deck = SKNode()
        deck.role = "deal.deck"
        deck.zPosition = -0.5  // over the felt, under the hand and the seats: the cards leave from its top
        deck.hideFromAccessibility()
        for i in 0..<3 {
            let back = SKSpriteNode(texture: CardTextureGenerator.cardBackTexture(colour: colour), size: TableLayout.cardSize)
            back.position = CGPoint(x: CGFloat(i) * 1.5, y: CGFloat(i) * 1.5)
            back.zPosition = CGFloat(i)
            back.hideFromAccessibility()
            deck.addChild(back)
        }
        addChild(deck)
        dealDeck = deck
        placeDealDeck()
        deck.alpha = 0
        // up until the last card has left, then gone
        let last = Deal.wait + Double(most - 1) * Deal.stagger
        animator.run(deck, SKAction.sequence([
            SKAction.fadeIn(withDuration: Theme.Motion.fast),
            SKAction.wait(forDuration: max(0, last - Theme.Motion.fast)),
            SKAction.fadeOut(withDuration: Theme.Motion.base),
            SKAction.run { [weak self, weak deck] in
                guard let self, let deck else { return }
                deck.removeFromParent()
                if self.dealDeck === deck { self.dealDeck = nil }
            },
        ]), final: { [weak self] n in
            n.removeFromParent()
            if self?.dealDeck === n { self?.dealDeck = nil }
        })
    }

    /// Where `node`'s deal flight starts, in its parent's coordinates: the deck, at the hand's
    /// card size (`width` is the node's unscaled width), square to the table.
    func dealStart(_ node: SKNode, width: CGFloat) -> Deal.Start? {
        guard let parent = node.parent, node.scene === self else { return nil }
        var scale: CGFloat = 1
        var n: SKNode? = parent
        while let p = n, p !== self {
            scale *= p.xScale
            n = p.parent
        }
        guard scale > 0, width > 0 else { return nil }
        return Deal.Start(point: parent.convert(layout.dealOrigin, from: self),
                          scale: TableLayout.cardSize.width * layout.handScale / (width * scale), rotation: 0)
    }

    private func placeDealDeck() {
        guard let deck = dealDeck else { return }
        deck.position = layout.dealOrigin
        deck.setScale(layout.handScale)
    }

    private func removeDealDeck() {
        dealDeck?.removeAllActions()
        dealDeck?.removeFromParent()
        dealDeck = nil
    }

    #if DEBUG
    /// Fixture mode: refresh the probes as the deal starts and once it has landed.
    private func dealProbe(after: TimeInterval) {
        guard UIFixture.isActive else { return }
        probe()
        run(SKAction.sequence([SKAction.wait(forDuration: after + 0.05), SKAction.run { [weak self] in self?.probe() }]))
    }
    #endif

    /// Where a seat's played card flies in from: its fan of card backs where the table
    /// shows them, else off-screen on the seat's side (as before 1.2.2).
    func cardEntry(_ rel: Positions.RelativePosition, model: TableRenderModel) -> CGPoint {
        if rel != .bottom || model.hand == nil, let box = layout.fans(spectating: model.hand == nil)?[rel] {
            return CGPoint(x: box.midX, y: box.midY)
        }
        return layout.trickEntry(rel)
    }

    #if DEBUG
    private func logLayout() {
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        let i = chrome.safeArea, L = layout
        print("[Layout] \(Int(size.width))x\(Int(size.height)) insets \(i.top)/\(i.left)/\(i.bottom)/\(i.right) topBar \(chrome.topBar) "
              + "corner \(chrome.cornerButton) +\(L.chrome.cornerTrailingExtra)\(L.tutorialBeside ? " beside" : "") bottomBar \(chrome.bottomBar) fold \(chrome.fold.map { "\($0)" } ?? "-") "
              + "occlusions \(chrome.occlusions.count) banner \(chrome.banner) -> zoom \(L.zoom) s \(L.handScale) k \(L.trickScale) \(L.mode) "
              + "degraded \(L.isDegraded) usedBottomBar \(L.usedBottomBar)")
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
        let image = BitmapRenderer.image(pixelSize: CGSize(width: side, height: side), standardRange: false) { gc in
            let P = Theme.Palette.Felt.self
            Theme.Palette.Felt.edge.uiColor.setFill()
            gc.fill(CGRect(x: 0, y: 0, width: side, height: side))
            let stops: [(ThemeColor, CGFloat)] = [(P.light.opacity(0.95), 0), (P.base.opacity(0.98), 0.46), (P.deep, 0.78), (P.edge, 1)]
            // the stops over the edge color, opaque (the scene composites nothing under it)
            let colors = stops.map { c, _ -> CGColor in
                let a = c.alpha, e = P.edge
                return PlatformColor(red: c.red * a + e.red * (1 - a), green: c.green * a + e.green * (1 - a),
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
        let texture = SKTexture.make(image)
        texture.filteringMode = .linear
        return texture
    }()
}
