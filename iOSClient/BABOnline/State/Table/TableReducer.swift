import Foundation

enum TableEvent {
    case server(SequencedEvent)
    case snapshot(TableSnapshot, SnapshotSource, hints: LegacySeatHints?)
    case local(LocalAction)
}

enum SnapshotSource: Equatable {
    case rejoin, restore, spectate, rejected
    case requested(String)
}

enum LocalAction: Equatable {
    case identity(username: String?, playerId: String?)
    case enterGameContext(gameId: String, tournamentId: String?)
    case enterLobby(lobbyId: String)
    case reset
    case submitPlay(Card, reqId: UInt32)
    case submitBid(String, reqId: UInt32)
    case ackTimeout(reqId: UInt32, attempt: Int)
    case transportError(handler: String)   // the server 'error' dictionary
    case chatRead
    case snapshotUnavailable(requestId: String?)
    case resyncNeeded                        // an undecodable event: ask for a snapshot (debounced)
    /// A snapshot this build cannot show (WireError.snapshot): retry with backoff, then say so.
    case snapshotFailed(requestId: String?, SnapshotProblem)
    /// Leave's confirmation opened: when the outcome hinges on owners who may have left
    /// unannounced (LeaveOutcome `.unsure`), ask for a snapshot to settle it.
    case leaveAsked
    /// Leave's confirmation closed (Leave or Cancel): the check ends.
    case leaveClosed
    /// My socket left `.connected` (critic C4): no `stopped` can reach me, so the bid clock
    /// and its tune end here; the rejoin's snapshot brings the clock back if it still runs.
    case connectionLost
    /// The lightbulb sent /help: it hides until the answer (or `assistAskLapsed`).
    case assistAsked
    /// No answer to the lightbulb's /help within AssistRules.askWait: it may show again.
    case assistAskLapsed
    /// The card's close button: my /help answer goes (the suggestion's glow and ring too).
    case assistDismissed
    /// A rule tip's close button (local: the server is not told).
    case tutorialTipDismissed
    /// The welcome's Keep or close button (ActionCoordinator sent /tutorial keep or /tutorial close).
    case tutorialWelcomeKept
    /// The welcome is not shown as a card (the iPhone Duo's vertical bar has the tutorial's
    /// switch): its text goes to the log once, and the rule tip behind it shows now. Nothing is
    /// sent (an auto-start stays as it is, as before Keep or ×).
    case tutorialWelcomeHidden
    /// The chip's switch or the welcome's Turn off (ActionCoordinator sent /tutorial off).
    case tutorialOffSent
    /// HSIScale.revealDelay after a live deal (ActionCoordinator, `.revealHSI`): its HSI shows.
    /// A later deal's reveal is its own (a stale one, after a redeal, changes nothing).
    case hsiRevealed(dealSeq: Int)
}

enum TableEffect: Equatable {
    case animate(TableAnimation)
    case requestSnapshot(requestId: String, log: Bool)
    /// requestSnapshot after SnapshotRetryPolicy.delay(attempt), if the table still waits for it.
    case retrySnapshot(requestId: String, attempt: Int)
    case haptic(HapticKind)
    /// A short line over the table (GameState.notice, shown in the server-error toast): why a bid or play was refused.
    case notice(String)
    /// The same toast with the neutral (info) look: news for me, not a refusal (the bid clock's
    /// "Time ran out: you bid 0").
    case infoNotice(String)
    case sound(SoundKind)
    /// The bid clock's tune (BidClockTune): unlike `.sound`, a snapshot may start it (state, not
    /// news) and catch-up keeps it (a replayed clear must still stop it).
    case bidClock(BidClockCue)
    case dropped(event: String, seq: Int)
    case gap(expected: Int, got: Int)
    case cancelAck(reqId: UInt32)
    /// Said to VoiceOver (my /help answer: AssistRules.announcement).
    case announce(String)
    /// A live deal holds its HSI ("HSI --", TableSlice.hsiHeld): ActionCoordinator applies
    /// `.local(.hsiRevealed(dealSeq:))` HSIScale.revealDelay later (the web's director.delay
    /// after the cards go down). Catch-up never sends it: it shows the value at once.
    case revealHSI(dealSeq: Int)
}

enum TableAnimation: Equatable {
    case cardPlayed(PlayedCard, TrickKey, byMe: Bool)
    case trickCollected(winner: Int, TrickKey)
    case handCleared(dealSeq: Int)
    case handsDestroyed(dealSeq: Int)
    /// A live gameStart: the new hand (and the card backs) fly in from the deck
    /// (GameSKScene.dealIn). Never from a snapshot or a buffered catch-up.
    case dealt(dealSeq: Int)
    case bidPlaced(position: Int, bid: String, dealSeq: Int)
    case bore(position: Int, bid: String, dealSeq: Int)
    case rainbow(position: Int, dealSeq: Int)
    case overTrump(TrickKey)
    case chatBubble(position: Int, message: String)
    /// A spectator's chat ("Name: text") by the spectator badge, one at a time (isSpectator, not `type`).
    case spectatorChatBubble(username: String, message: String)
    case sceneReset
}

extension Array where Element == TableEffect {
    var animations: [TableAnimation] { compactMap { if case .animate(let a) = $0 { return a } else { return nil } } }
}

/// The one writer of table state: pure, deterministic, no clock.
enum TableReducer {
    @discardableResult
    static func reduce(_ s: inout TableState, _ e: TableEvent) -> [TableEffect] {
        var fx: [TableEffect] = []
        let before = s.myTurn
        switch e {
        case .server(let ev): gate(&s, ev, &fx)
        case .snapshot(let snap, let source, let hints): applySnapshot(&s, snap, source, hints, &fx)
        case .local(let a): local(&s, a, &fx)
        }
        s.table.myTurn = s.myTurn
        // the your-turn cue: the edge into my choice, from a live delta only (a snapshot that
        // lands on my turn, a rolled-back submission or an ack timeout is not news)
        if case .server(let ev) = e, !ev.event.isSnapshotCarrier, !before.isChoosing, s.myTurn.isChoosing {
            fx.append(.sound(.turn))
        }
        return fx
    }

    /// Catch-up (buffered events replayed after a snapshot or a lapsed resync): its effects
    /// without the sounds and the deal's fly-in, so a rejoin or resync never plays a burst
    /// and shows the hand where it is; a replayed deal's HSI shows at once (no reveal wait).
    static func catchUp(_ s: inout TableState, _ fx: inout [TableEffect], _ body: (inout TableState, inout [TableEffect]) -> Void) {
        var inner: [TableEffect] = []
        body(&s, &inner)
        var revealed = false
        fx += inner.filter {
            switch $0 {
            case .sound, .animate(.dealt): return false
            case .revealHSI: revealed = true; return false
            default: return true
            }
        }
        if revealed { s.table.hsiHeld = false }
    }

    // MARK: - Seq gate (contract/README.md R1-R5)

    static func gate(_ s: inout TableState, _ ev: SequencedEvent, _ fx: inout [TableEffect]) {
        guard let seq = ev.seq else { return apply(&s, ev, &fx) }
        switch SeqGate.classify(lastSeq: s.sync.lastSeq, seq: seq) {
        case .apply:
            s.sync.lastSeq = seq
            apply(&s, ev, &fx)
        case .drop:
            fx.append(.dropped(event: ev.name, seq: seq))
        case .gap:
            fx.append(.gap(expected: (s.sync.lastSeq ?? 0) + 1, got: seq))
            // unreadable: no snapshot is asked for, so a buffer would only grow
            guard s.table.snapshotTrouble != .unreadable else { return }
            s.sync.buffered.append(ev)
            requestResync(&s, &fx)
        }
    }

    /// Fallback when no snapshot can come: apply what was buffered, in order.
    static func flushBuffer(_ s: inout TableState, _ fx: inout [TableEffect]) {
        let buffered = s.sync.buffered.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
        s.sync.buffered = []
        s.sync.resyncId = nil
        catchUp(&s, &fx) { s, fx in
            for ev in buffered {
                if let seq = ev.seq, let last = s.sync.lastSeq, seq <= last { fx.append(.dropped(event: ev.name, seq: seq)); continue }
                s.sync.lastSeq = ev.seq ?? s.sync.lastSeq
                apply(&s, ev, &fx)
            }
        }
    }

    // MARK: - Local actions

    static func local(_ s: inout TableState, _ a: LocalAction, _ fx: inout [TableEffect]) {
        switch a {
        case .identity(let username, let playerId):
            if let username { s.table.me.username = username }
            s.table.me.playerId = playerId ?? s.table.me.playerId
        case .reset:
            let live = s.table.bidTuneLive
            s = .fresh(keeping: s.table.me)
            fx.append(.animate(.sceneReset))
            if live { fx.append(.bidClock(.stop(.hard))) }
        case .connectionLost:
            stopBidClock(&s, .hard, &fx)
        case .enterLobby(let lobbyId):
            if s.table.bidTuneLive { fx.append(.bidClock(.stop(.hard))) }
            s = .fresh(keeping: s.table.me)
            s.table.gameId = lobbyId  // as today: the lobby id stands in until the game's id arrives
        case .enterGameContext(let gameId, let tournamentId):
            // 21.4: a new game (or a finished / empty context) starts from scratch;
            // the same game again (tournamentGameAssignment then allPlayersReady)
            // keeps what it has, tournamentId included
            if gameId != s.table.gameId || s.table.phase.kind == .none || s.table.phase.kind == .ended {
                let keepTournament = gameId == s.table.gameId ? s.table.tournamentId : nil
                if s.table.bidTuneLive { fx.append(.bidClock(.stop(.hard))) }
                s = .fresh(keeping: s.table.me)
                s.table.gameId = gameId
                s.table.tournamentId = tournamentId ?? keepTournament
                s.table.phase = .waiting
                s.table.viewer.role = .entrant  // as the server's snapshot says until seating (positionUpdate / gameStart)
            } else if tournamentId != nil {
                s.table.tournamentId = tournamentId
            }
        case .submitPlay(let card, let reqId):
            guard s.pending == nil, s.table.hand.contains(card) else { return }
            s.pending = PendingAction(submission: .play(card), reqId: reqId, key: currentKey(s))
            // my card is on its way: the /help card (and its glow) is done
            clearAssist(&s)
            clearTip(&s)
            // the card shows in its slot now (TableRenderModel), so it sounds now, not a round
            // trip later with the echo (which then stays quiet; a rollback is rare)
            if s.table.phase.kind == .playing { fx.append(.sound(.card)) }
        case .submitBid(let bid, let reqId):
            guard s.pending == nil, s.table.phase.isBidding else { return }
            s.pending = PendingAction(submission: .bid(bid.uppercased()), reqId: reqId, key: currentKey(s))
            clearAssist(&s)
            clearTip(&s)
        case .ackTimeout(let reqId, let attempt):
            guard let p = s.pending, p.reqId == reqId else { return }
            if attempt < AckPolicy.maxResyncs {
                fx.append(.requestSnapshot(requestId: "ack-\(reqId)", log: false))
            } else {
                s.pending = nil
                fx.append(.haptic(.error))
            }
        case .transportError(let handler):
            switch handler {
            case "playCard", "playerBid":
                if let p = s.pending { fx.append(.requestSnapshot(requestId: "ack-\(p.reqId)", log: false)) }
            case "requestSnapshot":
                // while retrying, a refused retry counts as one more failure (still bounded,
                // never "reloading" with nothing asked); else no snapshot is coming
                if case .retrying = s.table.snapshotTrouble { snapshotFailed(&s, &fx) } else { flushBuffer(&s, &fx) }
            default:
                break
            }
        case .chatRead:
            s.log.unread = 0
        case .resyncNeeded:
            requestResync(&s, &fx)
        case .snapshotFailed:
            snapshotFailed(&s, &fx)
        case .leaveAsked:
            checkLeave(&s, &fx)
        case .leaveClosed:
            s.players.leaveCheck = .idle
        case .assistAsked:
            s.table.assistAsking = true
        case .assistAskLapsed:
            s.table.assistAsking = false
        case .assistDismissed:
            clearAssist(&s)
        case .tutorialTipDismissed:
            clearTip(&s)
        case .tutorialWelcomeKept:
            welcomeGone(&s, &fx)
        case .tutorialWelcomeHidden:
            welcomeHidden(&s, &fx)
        case .tutorialOffSent:
            // every tip goes (a rule tip behind the welcome does not come up for the moment
            // until the server's assistState: its row is in the log)
            s.table.welcome = nil
            clearTip(&s)
            s.table.tutorialOffSent = true
        case .hsiRevealed(let dealSeq):
            if s.table.deal?.dealSeq == dealSeq { s.table.hsiHeld = false }
        case .snapshotUnavailable(let requestId):
            // No snapshot is coming for this request. Flush a pending gap buffer
            // whichever request it was: a gap request suppressed behind this one
            // (ActionCoordinator debounce) would otherwise never be answered
            if (requestId != nil && requestId == s.sync.resyncId) || !s.sync.buffered.isEmpty { flushBuffer(&s, &fx) }
            // not_in_game, to any request: no retry can bring the table (GameSocketHandler
            // leaves it unless a gameEnd landed meanwhile); the count stays until a reset
            if case .retrying = s.table.snapshotTrouble {
                if s.sync.resyncId != nil { flushBuffer(&s, &fx) }
                s.table.snapshotTrouble = .none
            }
            if let id = requestId, id.hasPrefix("ack-"), let p = s.pending, id == "ack-\(p.reqId)" {
                s.pending = nil
            }
        }
    }

    /// Leave's check: `.unsure` asks for a fresh snapshot ("leave-N"); any snapshot that lands
    /// while Leave is up verifies the seats (applySnapshot). A definite outcome needs none, but
    /// is `.settled` (not `.idle`), so a later lazy mode or resignation while the alert is up
    /// still checks again (review M1).
    static func checkLeave(_ s: inout TableState, _ fx: inout [TableEffect]) {
        s.players.leaveCheck = .settled
        guard case .unsure = LeaveOutcome.of(seats: s.players.seats, myPosition: s.table.viewer.position,
                                              inTournament: s.table.tournamentId != nil) else { return }
        let id = "leave-\(s.sync.nextRequestNo)"
        s.sync.nextRequestNo += 1
        s.players.leaveCheck = .pending(requestId: id)
        fx.append(.requestSnapshot(requestId: id, log: false))
    }

    static func currentKey(_ s: TableState) -> TrickKey {
        TrickKey(dealSeq: s.table.deal?.dealSeq ?? 0, trick: s.table.trickNo)
    }
}

/// Snapshots this build cannot show: asked again twice, 1 s then 3 s later, before
/// the table says so (a deploy mid-answer, a stage that passes); never a loop.
enum SnapshotRetryPolicy {
    static let maxRetries = 2
    static func delay(attempt: Int) -> TimeInterval { attempt <= 1 ? 1 : 3 }
}

/// Network liveness for acknowledged actions (not presentation pacing).
enum AckPolicy {
    static let timeout: TimeInterval = 5
    static let maxResyncs = 1
}

enum SeqGate {
    enum Verdict: Equatable { case apply, drop, gap }
    /// Kill switch: false turns drops and gaps into plain applies (DEBUG-logged by the store).
    static var enabled = true

    static func classify(lastSeq: Int?, seq: Int) -> Verdict {
        guard enabled, let last = lastSeq else { return .apply }
        if seq <= last { return .drop }
        if seq == last + 1 { return .apply }
        return .gap
    }
}
