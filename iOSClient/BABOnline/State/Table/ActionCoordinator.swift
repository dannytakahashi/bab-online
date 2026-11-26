import Foundation
import Combine

/// Sends my plays and bids and keeps each one acknowledged: confirmed by
/// cardPlayed / bidReceived, rolled back by actionRejected (its snapshot is
/// the truth), and resynced after `AckPolicy.timeout` without an answer.
/// Correlation is by action type (one outstanding action per seat), so the
/// wire is unchanged.
protocol GameActionEmitting {
    func playCard(_ c: Card, position: Int)
    func playerBid(_ b: String, position: Int)
    func requestSnapshot(requestId: String, log: Bool)
    /// A chat line (the lightbulb's /help).
    func chat(_ message: String)
    /// c2s watchHand (the over-the-shoulder view; a pure spectator only).
    func watchHand(gameId: String, position: Int?)
}

extension GameActionEmitting {
    func chat(_ message: String) { ChatEmitter.sendMessage(message) }
    func watchHand(gameId: String, position: Int?) { GameEmitter.watchHand(gameId: gameId, position: position) }
}

struct LiveGameEmitter: GameActionEmitting {
    /// The exact payloads (pinned by the replay tests against the recorded iOS c2s entries).
    static func playCardPayload(_ c: Card, position: Int) -> [String: Any] {
        ["card": ["suit": c.suit.rawValue, "rank": c.rank.rawValue], "position": position]
    }

    /// Numeric bids go as an Int, bores as their string (as GameEmitter always did).
    static func playerBidPayload(_ b: String, position: Int) -> [String: Any] {
        if let n = Int(b) { return ["bid": n, "position": position] }
        return ["bid": b.uppercased(), "position": position]
    }

    /// `{gameId, position}`, position null to stop (contract c2s watchHand).
    static func watchHandPayload(gameId: String, position: Int?) -> [String: Any] {
        ["gameId": gameId, "position": position.map { $0 as Any } ?? NSNull()]
    }

    func playCard(_ c: Card, position: Int) { GameEmitter.playCard(card: c, position: position) }
    func playerBid(_ b: String, position: Int) {
        if let n = Int(b) { GameEmitter.playerBid(bid: n, position: position) } else { GameEmitter.playerBidBore(bid: b.uppercased(), position: position) }
    }
    func requestSnapshot(requestId: String, log: Bool) { GameEmitter.requestSnapshot(requestId: requestId, log: log, customPics: false) }
}

protocol AckCancellable { func cancel() }

protocol AckClock {
    func after(_ s: TimeInterval, _ f: @escaping @MainActor () -> Void) -> AckCancellable
}

struct DispatchAckClock: AckClock {
    private final class Item: AckCancellable {
        let work: DispatchWorkItem
        init(_ w: DispatchWorkItem) { work = w }
        func cancel() { work.cancel() }
    }

    func after(_ s: TimeInterval, _ f: @escaping @MainActor () -> Void) -> AckCancellable {
        let work = DispatchWorkItem { MainActor.assumeIsolated { f() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: work)
        return Item(work)
    }
}

@MainActor
final class ActionCoordinator: ObservableObject {
    private let store: GameState
    private let emitter: GameActionEmitting
    private let clock: AckClock
    /// Table sounds, spaced (TableSoundCues) and played by SoundPlayer.shared (tests inject a recorder).
    private let cues: TableSoundCues
    /// The bid clock's tune (BidClockTune over SoundPlayer.shared; tests inject a fake player).
    let tune: BidClockTune
    private var reqId: UInt32 = 0
    private var timers: [UInt32: AckCancellable] = [:]
    private var cancellables = Set<AnyCancellable>()
    /// requestSnapshot debounce: at most one in flight (the server allows 10 per 10 s).
    private var inFlight: (id: String, resets: Int)?
    private var inFlightTimer: AckCancellable?
    private var deferred: (id: String, log: Bool)?
    /// The pending retry after a snapshot this build could not show (SnapshotRetryPolicy).
    private var retryTimer: AckCancellable?
    /// The lightbulb's wait for its /help answer (AssistRules.askWait), on its own clock.
    private let askClock: AckClock
    private var askTimer: AckCancellable?
    /// A live deal's HSI reveal (`.revealHSI`, HSIScale.revealDelay), on its own clock (the ack
    /// tests count `clock`'s timers); a redeal replaces it.
    private let hsiClock: AckClock
    private var hsiTimer: AckCancellable?
    /// The haptic on my turn (TurnHaptic: once per turn, the setting, the app active).
    let turnHaptic: TurnHaptic
    /// Plays a haptic (HapticManager on iOS; tests inject a recorder).
    private let hapticOutput: @MainActor (HapticKind) -> Void

    /// `soundClock` is not `clock`: the ack tests count that clock's timers.
    init(store: GameState, emitter: GameActionEmitting = LiveGameEmitter(), clock: AckClock = DispatchAckClock(),
         sounds: SoundPlaying? = nil, soundClock: AckClock = DispatchAckClock(), tunePlayer: TunePlaying? = nil,
         notifications: NotificationCenter = .default, askClock: AckClock = DispatchAckClock(),
         hsiClock: AckClock = DispatchAckClock(), hapticClock: AckClock = DispatchAckClock(),
         haptics: (@MainActor (HapticKind) -> Void)? = nil,
         vibratesOnTurn: (@MainActor () -> Bool)? = nil, isAppActive: (@MainActor () -> Bool)? = nil) {
        self.store = store
        let output = haptics ?? ActionCoordinator.playHaptic
        hapticOutput = output
        turnHaptic = TurnHaptic(clock: hapticClock,
                                isEnabled: vibratesOnTurn ?? { HapticSettings.shared.vibratesOnTurn },
                                isAppActive: isAppActive ?? { AppPresence.shared.mayPlaySound },
                                isStillOpen: { [weak store] cue in
                                    guard let store, case .choosing(let action) = store.state.myTurn else { return false }
                                    return TableReducer.turnCue(store.state, action) == cue
                                },
                                play: { output(.myTurn($0)) })
        self.askClock = askClock
        self.hsiClock = hsiClock
        self.emitter = emitter
        self.clock = clock
        cues = TableSoundCues(clock: soundClock, sounds: sounds ?? SoundPlayer.shared,
                              isMyChoice: { [weak store] in store?.state.myTurn.isChoosing == true },
                              epoch: { [weak store] in store.map { "\($0.sceneResets) \($0.state.table.gameId ?? "")" } ?? "" })
        tune = BidClockTune(player: tunePlayer ?? SoundPlayer.shared,
                            remaining: { [weak store] in
                                guard let store, let c = store.bidCountdown else { return nil }
                                return c.deadline - store.clockNow()
                            })
        store.ioRequests
            .sink { [weak self] fx in self?.handle(fx) }
            .store(in: &cancellables)
        // the tune follows the app and the sound setting: nothing unless the app is active
        // (Notification Center, Control Center or the app switcher make it inactive, not
        // background: SoundPlayer.isAppActive would not have started it there either), back at
        // its place when the app is active again or the sound comes back on
        for name in AppPresence.resignActiveNotifications {
            notifications.publisher(for: name)
                .sink { [weak self] _ in MainActor.assumeIsolated { self?.tune.backgrounded() } }
                .store(in: &cancellables)
        }
        notifications.publisher(for: AppPresence.becomeActiveNotification)
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.tune.sync() } }
            .store(in: &cancellables)
        if tunePlayer == nil {
            SoundPlayer.shared.tuneResync
                .sink { [weak self] in self?.tune.sync() }
                .store(in: &cancellables)
        }
    }

    /// My socket's connection (SocketService.isConnected): a drop ends the bid clock and its
    /// tune here (critic C4: no `stopped` can reach me), the rejoin's snapshot brings it back.
    func watchConnection<P: Publisher>(_ connected: P) where P.Output == Bool, P.Failure == Never {
        connected
            .removeDuplicates()
            .filter { !$0 }
            .sink { [weak self] _ in
                guard let self, self.store.state.table.bidClock != nil || self.store.state.table.bidTuneLive else { return }
                self.store.apply(.local(.connectionLost))
            }
            .store(in: &cancellables)
    }

    @discardableResult
    func play(_ c: Card) -> Bool {
        let s = store.state
        guard s.myTurn == .choosing(.play), let me = s.table.viewer.position, s.table.hand.contains(c),
              TableRenderModel(s).hand?.legalIds.contains(c.id) == true else { return false }
        reqId &+= 1
        let id = reqId
        store.apply(.local(.submitPlay(c, reqId: id)))
        guard store.state.pending?.reqId == id else { return false }
        emitter.playCard(c, position: me)
        arm(id, attempt: 0)
        return true
    }

    @discardableResult
    func bid(_ b: String) -> Bool {
        let s = store.state
        guard s.myTurn == .choosing(.bid), let me = s.table.viewer.position else { return false }
        reqId &+= 1
        let id = reqId
        store.apply(.local(.submitBid(b, reqId: id)))
        guard store.state.pending?.reqId == id else { return false }
        emitter.playerBid(b, position: me)
        arm(id, attempt: 0)
        return true
    }

    /// The lightbulb by my hand: send /help as the chat would (the server answers with my private
    /// assistHint). It hides until the answer, or for AssistRules.askWait at most. Offline: the
    /// reconnecting notice instead. false when nothing was sent.
    @discardableResult
    func askHelp(connected: Bool) -> Bool {
        guard AssistRules.showsAsk(store.state) else { return false }
        guard connected else {
            store.postNotice(AssistRules.reconnecting)
            return false
        }
        emitter.chat(AssistRules.command)
        store.apply(.local(.assistAsked))
        askTimer?.cancel()
        askTimer = askClock.after(AssistRules.askWait) { [weak self] in
            guard let self else { return }
            self.askTimer = nil
            if self.store.state.table.assistAsking { self.store.apply(.local(.assistAskLapsed)) }
        }
        return true
    }

    /// The switch, on -> off: /tutorial off (the server answers with
    /// assistState and "Tips off. /help still works any time."). Offline: the reconnecting
    /// notice, and the tutorial stays on. false when nothing was sent.
    @discardableResult
    func tutorialOff(connected: Bool) -> Bool {
        // my own seat only (never a spectator or a watcher: the switch is the seat's)
        guard store.state.table.viewer.role == .seat, store.state.table.tutorial.on, !store.state.table.tutorialOffSent else { return false }
        guard connected else {
            store.postNotice(AssistRules.reconnecting)
            return false
        }
        emitter.chat(TutorialRules.offCommand)
        store.apply(.local(.tutorialOffSent))
        return true
    }

    /// The switch, off -> on (after its question, if any): /tutorial on (the server answers with
    /// assistState and its status line; the switch shows on and waits, `tutorialOnSent`, until
    /// then). Offline: the reconnecting notice. false when nothing was sent.
    @discardableResult
    func tutorialOn(connected: Bool) -> Bool {
        guard store.state.table.viewer.role == .seat, !store.state.table.tutorial.on, !store.state.table.tutorialOnSent else { return false }
        guard connected else {
            store.postNotice(AssistRules.reconnecting)
            return false
        }
        emitter.chat(TutorialRules.onCommand)
        store.apply(.local(.tutorialOnSent))
        return true
    }

    private func arm(_ id: UInt32, attempt: Int) {
        timers[id]?.cancel()
        timers[id] = clock.after(AckPolicy.timeout) { [weak self] in
            guard let self else { return }
            self.timers[id] = nil
            let fx = self.store.apply(.local(.ackTimeout(reqId: id, attempt: attempt)))
            if fx.contains(where: { if case .requestSnapshot = $0 { return true } else { return false } }) {
                self.arm(id, attempt: attempt + 1)
            }
        }
    }

    private func handle(_ fx: TableEffect) {
        switch fx {
        case .cancelAck(let id):
            timers[id]?.cancel()
            timers[id] = nil
        case .requestSnapshot(let id, let log):
            // An ack resync always goes out; a gap resync waits for the one in
            // flight, and goes out when that one lapses if the table still
            // waits for it (else a gap could stall behind an unanswered request)
            if let f = inFlight, f.resets == store.sceneResets, !id.hasPrefix("ack-") {
                deferred = (id, log)
                return
            }
            send(id, log: log)
        case .retrySnapshot(let id, let attempt):
            // the failed answer ended the one in flight, so this goes out past the debounce;
            // skipped if anything else resynced the table meanwhile
            retryTimer?.cancel()
            retryTimer = clock.after(SnapshotRetryPolicy.delay(attempt: attempt)) { [weak self] in
                guard let self else { return }
                self.retryTimer = nil
                if self.store.state.sync.resyncId == id { self.send(id, log: false) }
            }
        case .revealHSI(let dealSeq):
            hsiTimer?.cancel()
            hsiTimer = hsiClock.after(HSIScale.revealDelay) { [weak self] in
                guard let self else { return }
                self.hsiTimer = nil
                self.store.apply(.local(.hsiRevealed(dealSeq: dealSeq)))
            }
        case .haptic(.myTurn(let cue)):
            turnHaptic.turnOpened(cue)
        case .haptic(let kind):
            hapticOutput(kind)
        case .sound(let kind):
            cues.cue(kind)
        case .bidClock(let cue):
            tune.handle(cue)
        case .watchHand(let gameId, let position):
            // the over-the-shoulder view: only ever a pure spectator's (a seat never sends it)
            guard store.state.table.viewer.role == .spectator, store.state.table.gameId == gameId else { return }
            emitter.watchHand(gameId: gameId, position: position)
        default:
            break
        }
    }

    /// The device's haptic for a kind: an error's notification, my turn's medium impact
    /// (TurnHaptic says why).
    static func playHaptic(_ kind: HapticKind) {
        #if os(iOS)
        switch kind {
        case .error: HapticManager.error()
        case .myTurn: HapticManager.mediumImpact()
        }
        #endif
    }

    private func send(_ id: String, log: Bool) {
        inFlight = (id, store.sceneResets)
        if deferred?.id == id { deferred = nil }
        inFlightTimer?.cancel()
        inFlightTimer = clock.after(AckPolicy.timeout) { [weak self] in
            guard let self else { return }
            self.inFlight = nil
            if let d = self.deferred {
                self.deferred = nil
                if self.store.state.sync.resyncId == d.id { self.send(d.id, log: d.log) }
            }
        }
        emitter.requestSnapshot(requestId: id, log: log)
    }
}
