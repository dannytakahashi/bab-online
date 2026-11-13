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
    /// Leave's confirmation opened: when the outcome hinges on owners who may have left
    /// unannounced (LeaveOutcome `.unsure`), ask for a snapshot to settle it.
    case leaveAsked
    /// Leave's confirmation closed (Leave or Cancel): the check ends.
    case leaveClosed
}

enum TableEffect: Equatable {
    case animate(TableAnimation)
    case requestSnapshot(requestId: String, log: Bool)
    case haptic(HapticKind)
    case dropped(event: String, seq: Int)
    case gap(expected: Int, got: Int)
    case cancelAck(reqId: UInt32)
}

enum TableAnimation: Equatable {
    case cardPlayed(PlayedCard, TrickKey, byMe: Bool)
    case trickCollected(winner: Int, TrickKey)
    case handCleared(dealSeq: Int)
    case handsDestroyed(dealSeq: Int)
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
        switch e {
        case .server(let ev): gate(&s, ev, &fx)
        case .snapshot(let snap, let source, let hints): applySnapshot(&s, snap, source, hints, &fx)
        case .local(let a): local(&s, a, &fx)
        }
        s.table.myTurn = s.myTurn
        return fx
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
            s.sync.buffered.append(ev)
            fx.append(.gap(expected: (s.sync.lastSeq ?? 0) + 1, got: seq))
            if s.sync.resyncId == nil {
                let id = "gap-\(s.sync.nextRequestNo)"
                s.sync.nextRequestNo += 1
                s.sync.resyncId = id
                fx.append(.requestSnapshot(requestId: id, log: false))
            }
        }
    }

    /// Fallback when no snapshot can come: apply what was buffered, in order.
    static func flushBuffer(_ s: inout TableState, _ fx: inout [TableEffect]) {
        let buffered = s.sync.buffered.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
        s.sync.buffered = []
        s.sync.resyncId = nil
        for ev in buffered {
            if let seq = ev.seq, let last = s.sync.lastSeq, seq <= last { fx.append(.dropped(event: ev.name, seq: seq)); continue }
            s.sync.lastSeq = ev.seq ?? s.sync.lastSeq
            apply(&s, ev, &fx)
        }
    }

    // MARK: - Local actions

    static func local(_ s: inout TableState, _ a: LocalAction, _ fx: inout [TableEffect]) {
        switch a {
        case .identity(let username, let playerId):
            if let username { s.table.me.username = username }
            s.table.me.playerId = playerId ?? s.table.me.playerId
        case .reset:
            s = .fresh(keeping: s.table.me)
            fx.append(.animate(.sceneReset))
        case .enterLobby(let lobbyId):
            s = .fresh(keeping: s.table.me)
            s.table.gameId = lobbyId  // as today: the lobby id stands in until the game's id arrives
        case .enterGameContext(let gameId, let tournamentId):
            // 21.4: a new game (or a finished / empty context) starts from scratch;
            // the same game again (tournamentGameAssignment then allPlayersReady)
            // keeps what it has, tournamentId included
            if gameId != s.table.gameId || s.table.phase.kind == .none || s.table.phase.kind == .ended {
                let keepTournament = gameId == s.table.gameId ? s.table.tournamentId : nil
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
        case .submitBid(let bid, let reqId):
            guard s.pending == nil, s.table.phase.isBidding else { return }
            s.pending = PendingAction(submission: .bid(bid.uppercased()), reqId: reqId, key: currentKey(s))
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
                flushBuffer(&s, &fx)
            default:
                break
            }
        case .chatRead:
            s.log.unread = 0
        case .resyncNeeded:
            requestResync(&s, &fx)
        case .leaveAsked:
            checkLeave(&s, &fx)
        case .leaveClosed:
            s.players.leaveCheck = .idle
        case .snapshotUnavailable(let requestId):
            // No snapshot is coming for this request. Flush a pending gap buffer
            // whichever request it was: a gap request suppressed behind this one
            // (ActionCoordinator debounce) would otherwise never be answered
            if (requestId != nil && requestId == s.sync.resyncId) || !s.sync.buffered.isEmpty { flushBuffer(&s, &fx) }
            if let id = requestId, id.hasPrefix("ack-"), let p = s.pending, id == "ack-\(p.reqId)" {
                s.pending = nil
            }
        }
    }

    /// Leave's check: `.unsure` asks for a fresh snapshot ("leave-N"); any snapshot that lands
    /// while it is pending verifies the seats (applySnapshot). A definite outcome needs none.
    static func checkLeave(_ s: inout TableState, _ fx: inout [TableEffect]) {
        s.players.leaveCheck = .idle
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
