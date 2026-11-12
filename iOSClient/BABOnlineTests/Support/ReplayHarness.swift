import Foundation
import XCTest
@testable import BAB_Online

final class FakeEmitter: GameActionEmitting {
    enum Sent: Equatable { case play(Card, Int), bid(String, Int), snapshot(String, Bool) }
    var sent: [Sent] = []
    func playCard(_ c: Card, position: Int) { sent.append(.play(c, position)) }
    func playerBid(_ b: String, position: Int) { sent.append(.bid(b, position)) }
    func requestSnapshot(requestId: String, log: Bool) { sent.append(.snapshot(requestId, log)) }
    var snapshotRequests: [String] { sent.compactMap { if case .snapshot(let id, _) = $0 { return id } else { return nil } } }
}

final class ManualClock: AckClock {
    private final class Timer: AckCancellable {
        var cancelled = false
        let at: TimeInterval
        let fire: @MainActor () -> Void
        init(at: TimeInterval, fire: @escaping @MainActor () -> Void) { self.at = at; self.fire = fire }
        func cancel() { cancelled = true }
    }
    private var timers: [Timer] = []
    private(set) var now: TimeInterval = 0
    /// Timers that fired (the replay checks that no ack timeout ever does).
    private(set) var fired = 0

    func after(_ s: TimeInterval, _ f: @escaping @MainActor () -> Void) -> AckCancellable {
        let t = Timer(at: now + s, fire: f)
        timers.append(t)
        return t
    }

    var pending: Int { timers.filter { !$0.cancelled }.count }

    @MainActor
    func advance(_ s: TimeInterval) {
        now += s
        while let t = timers.filter({ !$0.cancelled && $0.at <= now }).min(by: { $0.at < $1.at }) {
            t.cancelled = true
            fired += 1
            t.fire()
        }
    }

    /// Advance to an absolute time (a recorded entry's `t`, in seconds).
    @MainActor
    func advance(to t: TimeInterval) { if t > now { advance(t - now) } }
}

final class RecordingRenderer: TableRenderer {
    var calls: [(TableRenderModel, [TableAnimation])] = []
    func apply(model: TableRenderModel, animations: [TableAnimation]) { calls.append((model, animations)) }
}

/// The whole client path: GameSocketHandler.handle, the chat / voice / error /
/// lobby / tournament handlers' table routes, the store and ActionCoordinator
/// (my recorded plays and bids go through ActionCoordinator.play / bid when it
/// would send them, with the clock following the recording's timestamps).
@MainActor
final class ReplayHarness {
    let store = GameState()
    let emitter = FakeEmitter()
    let clock = ManualClock()
    let renderer = RecordingRenderer()
    let appState = AppState()
    lazy var actions = ActionCoordinator(store: store, emitter: emitter, clock: clock)
    lazy var handler = GameSocketHandler(socket: SocketService.shared, gameState: store, appState: appState)
    var effects: [TableEffect] = []
    private var reqId: UInt32 = 1000

    init(viewer: RecordedGame.Viewer? = nil) {
        store.renderer = renderer
        store.effectObserver = { [unowned self] in self.effects += $0 }
        _ = actions
        if let v = viewer { store.apply(.local(.identity(username: v.username, playerId: v.sid))) }
    }

    /// Plays / bids that went through ActionCoordinator (the rest were ones the app would not send).
    private(set) var coordinated = 0

    /// One recorded entry, routed the way the app's handlers route it.
    func apply(_ e: RecordedGame.Entry) throws {
        clock.advance(to: TimeInterval(e.t) / 1000)
        if e.dir == "c2s" {
            guard let d = e.data as? [String: Any] else { return }
            switch e.event {
            case "playCard":
                guard let cd = d["card"] as? [String: Any], let card = Card.from(cd) else { return }  // Joi-invalid: never built by the app
                let built = LiveGameEmitter.playCardPayload(card, position: d["position"] as! Int)
                XCTAssertTrue(NSDictionary(dictionary: built).isEqual(to: d), "playCard payload \(built) != recorded \(d)")
                if actions.play(card) { coordinated += 1; return }
                reqId += 1
                store.apply(.local(.submitPlay(card, reqId: reqId)))
            case "playerBid":
                let bid = (d["bid"] as? String) ?? (d["bid"] as? Int).map(String.init) ?? "0"
                let built = LiveGameEmitter.playerBidPayload(bid, position: d["position"] as! Int)
                XCTAssertTrue(NSDictionary(dictionary: built).isEqual(to: d), "playerBid payload \(built) != recorded \(d)")
                if actions.bid(bid) { coordinated += 1; return }
                reqId += 1
                store.apply(.local(.submitBid(bid, reqId: reqId)))
            default:
                break
            }
            return
        }
        let payload: [Any] = e.data.map { [$0] } ?? []
        let dict = e.data as? [String: Any]
        switch e.event {
        case "allPlayersReady":
            LobbySocketHandler.routeAllPlayersReady(dict, to: store)
        case "tournamentGameAssignment":
            TournamentSocketHandler.routeGameAssignment(dict ?? [:], to: store)
        case "chatMessage":
            ChatSocketHandler.route(payload, to: store, isBlocked: { _ in false })
        case "voicePeerLeft":
            VoiceSocketHandler.routeTable(payload, to: store)
        case "voicePeerJoined", "voicePeerList":
            break
        case "serverError":
            // SocketService.handleServerError's table part (V1_REMOVALS #1: the only error event since phase B)
            SocketService.routeTableError(dict ?? [:], to: store)
        default:
            XCTAssertTrue(GameSocketHandler.events.contains(e.event), "unrouted event \(e.event)")
            handler.handle(event: e.event, payload: payload)
        }
    }

    var badEffects: [TableEffect] {
        effects.filter { if case .dropped = $0 { return true }; if case .gap = $0 { return true }; return false }
    }
}
