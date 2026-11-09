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
    private var reqId: UInt32 = 0
    private var timers: [UInt32: AckCancellable] = [:]
    private var cancellables = Set<AnyCancellable>()
    /// requestSnapshot debounce: at most one in flight (the server allows 10 per 10 s).
    private var inFlight: (id: String, resets: Int)?
    private var inFlightTimer: AckCancellable?

    init(store: GameState, emitter: GameActionEmitting = LiveGameEmitter(), clock: AckClock = DispatchAckClock()) {
        self.store = store
        self.emitter = emitter
        self.clock = clock
        store.ioRequests
            .sink { [weak self] fx in self?.handle(fx) }
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
            // An ack resync always goes out; a gap resync waits for the one in flight
            if let f = inFlight, f.resets == store.sceneResets, !id.hasPrefix("ack-") { return }
            inFlight = (id, store.sceneResets)
            inFlightTimer?.cancel()
            inFlightTimer = clock.after(AckPolicy.timeout) { [weak self] in self?.inFlight = nil }
            emitter.requestSnapshot(requestId: id, log: log)
        case .haptic:
            HapticManager.error()
        default:
            break
        }
    }
}
