import Foundation
import UIKit
import SocketIO
import Combine

/// A user-facing failure the server sent as an 'error' event ({ type?, message }).
/// Each one gets its own id so repeating the same message re-shows the toast.
struct ServerErrorNotice: Equatable {
    let id = UUID()
    let message: String
}

/// The server sends one failure twice while V1_REMOVALS #1 is in phase A: the
/// app-level `error` ({type?, message, handler?}; Socket.IO-Client-Swift
/// delivers it as `clientEvent: .error`) and `serverError` ({code, message,
/// handler}). Phase B drops `error`. Whichever arrives first is shown (toast,
/// table resync); the other copy, the same message and handler from the
/// other channel within `window`, is dropped. The same message again on the
/// same channel is a new failure (a repeated tap) and is shown again.
struct ServerErrorDeduper {
    enum Channel: Equatable { case error, serverError }
    static let window: TimeInterval = 1.5

    private var last: (channel: Channel, message: String, handler: String?, at: Date)?

    /// true: handle this one; false: the other channel's copy of the failure just handled
    /// (same handler; with no handler, the same message: the two may word it differently).
    mutating func accept(_ channel: Channel, message: String, handler: String?, at now: Date = Date()) -> Bool {
        if let l = last, l.channel != channel, now.timeIntervalSince(l.at) < Self.window,
           l.handler == handler, handler != nil || l.message == message {
            last = nil  // one twin per failure: a third copy is a new one
            return false
        }
        last = (channel, message, handler, now)
        return true
    }
}

/// Singleton managing the Socket.IO connection.
final class SocketService: ObservableObject {
    static let shared = SocketService()

    @Published var isConnected = false
    /// Signed in on the current server-side socket (sign-in, sign-up or the restore answered):
    /// false from every new `.connect` until then. Main-room actions wait for it
    /// (`noteSessionEstablished`).
    @Published var isSessionReady = false

    /// The table part of the server's 'error' (also driven by the replay tests):
    /// a refused play/bid/resync makes the table resync instead of waiting (21.10).
    @MainActor
    static func routeTableError(_ dict: [String: Any], to store: GameState) {
        if let handler = dict["handler"] as? String, ["playCard", "playerBid", "requestSnapshot"].contains(handler) {
            store.apply(.local(.transportError(handler: handler)))
        }
    }
    /// The table store (set by BABOnlineApp) for transport errors of game actions.
    weak var gameState: GameState?
    @Published var connectionError: String?
    @Published var serverError: ServerErrorNotice?

    private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid
    private(set) var isBackgroundTaskActive = false

    private(set) var manager: SocketManager?
    private(set) var socket: SocketIOClient?
    var eventRouter: SocketEventRouter?

    /// Set by BABOnlineApp so SocketService can auto-restore session on reconnect
    weak var authState: AuthState?

    /// The server URL — simulator uses localhost, physical device uses production (ServerConfig)
    private var serverURL: String { serverURLOverride ?? ServerConfig.baseURL }
    /// Tests only: where `connect` goes instead (ForegroundReconnectTests: a refused local port).
    var serverURLOverride: String?
    /// `serverError` (V1_REMOVALS #1 phase A/B; its constant joins SocketEvents.swift with the contract entry).
    static let serverErrorEvent = "serverError"
    private var errorDeduper = ServerErrorDeduper()

    var socketId: String? { socket?.sid }

    private init() {}

    // MARK: - Connection

    /// Debug fixture mode (`-uiFixture`, item 26) never opens a socket, on any
    /// path (launch, foreground, settings): every connect funnels through here.
    static var connectionsDisabled: Bool {
        #if DEBUG
        return UIFixture.isActive
        #else
        return false
        #endif
    }

    func connect() {
        if Self.connectionsDisabled { return }
        // If socket already exists, just reconnect it (preserves registered handlers)
        if let socket = socket {
            if socket.status != .connected {
                socket.connect()
            }
            return
        }
        openConnection()
    }

    /// A new manager and default socket for `url` (not connected yet).
    static func makeConnection(url: URL) -> (SocketManager, SocketIOClient) {
        var config: SocketIOClientConfiguration = [
            .compress,
            .reconnects(true),
            .reconnectAttempts(-1),
            .reconnectWait(1),
            .reconnectWaitMax(5),
            .forceWebsockets(false),
        ]
        #if DEBUG
        // Transport logging is opt-in (`-socketLog YES`), and even then payloads that carry
        // credentials are redacted (RedactingSocketLogger). Release builds never log payloads.
        if RedactingSocketLogger.isEnabled {
            config.insert(.logger(RedactingSocketLogger()))
        }
        #endif
        let manager = SocketManager(socketURL: url, config: config)
        return (manager, manager.defaultSocket)
    }

    /// Builds the manager and socket, registers every handler on the socket (this service's,
    /// then the router's, which reach it through `on`), and connects it.
    private func openConnection() {
        let (manager, socket) = Self.makeConnection(url: URL(string: serverURL)!)
        self.manager = manager
        self.socket = socket
        registerHandlers()
        eventRouter?.registerAll()
        socket.connect()
    }

    private func registerHandlers() {
        socket?.on(clientEvent: .connect) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.isConnected = true
                // a new server-side socket: nobody is signed in on it until the restore answers
                self?.isSessionReady = false
                self?.connectionError = nil
                RestartNotices.shared.reconnected()
                print("[Socket] Connected: \(self?.socket?.sid ?? "?")")
            }
            // Capabilities first (every connect, a new socket each time): the restore's replies
            // and every later payload already use the avatarUrl shapes
            self?.socket?.emit(SocketEvents.Client.clientHello, ClientHello.payload())
            // Auto-restore session on any connection (handles force-reconnect,
            // auto-reconnect, and app relaunch with stored credentials)
            if let authState = self?.authState, authState.hasStoredSession {
                print("[Socket] Auto-restoring session for: \(authState.username)")
                AuthEmitter.restoreSession(username: authState.username, sessionToken: authState.sessionToken)
            }
        }

        socket?.on(clientEvent: .disconnect) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.isConnected = false
                self?.isSessionReady = false
                RestartNotices.shared.disconnected()
                print("[Socket] Disconnected")
            }
        }

        // The library reconnecting a socket it had connected (a dead engine found after a
        // long background, a deploy, forceReconnect) sends no .disconnect, only this status:
        // until the next .connect the socket cannot emit, so it is not connected.
        socket?.on(clientEvent: .statusChange) { [weak self] data, _ in
            guard let status = data.first as? SocketIOStatus else { return }
            DispatchQueue.main.async { self?.noteStatus(status) }
        }

        // Fires for the server's app-level 'error' event (an object with `message`:
        // lobby full, not ready, rate limit, ...) and for client transport errors (a String).
        socket?.on(clientEvent: .error) { [weak self] data, _ in
            DispatchQueue.main.async {
                if let dict = data.first as? [String: Any] {
                    self?.handleServerError(dict, channel: .error)
                } else {
                    let msg = (data.first as? String) ?? "Unknown error"
                    self?.connectionError = msg
                    print("[Socket] Error: \(msg)")
                }
            }
        }

        // The same failures as {code, message, handler} (V1_REMOVALS #1): the only one after phase B
        socket?.on(Self.serverErrorEvent) { [weak self] data, _ in
            guard let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self?.handleServerError(dict, channel: .serverError) }
        }

        // A server that closes the connection (a deploy) leaves Socket.IO-Client-Swift reconnecting
        // without a .disconnect event (statusChange clears isConnected): the restart toast learns it here
        socket?.on(clientEvent: .reconnectAttempt) { _, _ in
            DispatchQueue.main.async { RestartNotices.shared.disconnected() }
        }

        // ~1 s before every deploy closes the sockets (roadmap #17): the toast, and what will be lost
        socket?.on(SocketEvents.Server.serverShutdown) { [weak self] data, _ in
            let dict = data.first as? [String: Any]
            DispatchQueue.main.async { self?.handleServerShutdown(dict) }
        }
    }

    /// A server-side failure from either channel: one toast and one table resync per failure.
    @MainActor
    func handleServerError(_ dict: [String: Any], channel: ServerErrorDeduper.Channel, at now: Date = Date()) {
        let msg = dict["message"] as? String ?? "Something went wrong"
        guard errorDeduper.accept(channel, message: msg, handler: dict["handler"] as? String, at: now) else { return }
        serverError = ServerErrorNotice(message: msg)
        print("[Socket] Server error: \(msg)")
        if let store = gameState { Self.routeTableError(dict, to: store) }
    }

    /// What a restart would cost the player now (set by BABOnlineApp: screen, table role, tournament).
    var restartPlace: (@MainActor () -> RestartNotice.Place?)?

    /// `serverShutdown {message}` (contract s2c serverShutdown; server/utils/shutdown.js): the
    /// ConnectionStatusToast shows "Restarting for an update…" until the socket is back, and
    /// the notice remembers what the player was in, for the one message after the restore.
    @MainActor
    func handleServerShutdown(_ dict: [String: Any]?, now: Date = Date()) {
        let place = restartPlace?()
        print("[Socket] Server restarting (\(place?.rawValue ?? "nothing to lose"))")
        RestartNotices.shared.serverShutdown(place: place, now: now)
    }

    /// Force a reconnect cycle (foreground after the keep-alive expired, or within it while
    /// not connected; sign-out). iOS can silently kill the WebSocket when backgrounded without
    /// firing a disconnect event, leaving the socket looking connected. The new connection
    /// makes Socket.IO fire `.connect`, and the `restoreSession` flow runs.
    ///
    /// Always a NEW manager and socket, never the old one reconnected
    /// (Socket.IO-Client-Swift 16.1.1):
    /// - Once the library is reconnecting, `_tryReconnect` schedules its next attempt after
    ///   every connect (1.5^n s with jitter, at most `reconnectWaitMax`, 5 s) whether or not
    ///   that handshake has answered, and nothing can fire or cancel the tick. Between two
    ///   attempts (manager `.notConnected`, socket `.connecting`) nothing is in flight, and
    ///   waiting for the tick left the buttons dead for up to 5 s after a deploy or a network
    ///   drop.
    /// - Each tick's `connect()` starts a new handshake on the same engine beside one still in
    ///   flight (a slow link: a polling handshake over ~1.5 s), without cancelling it, and the
    ///   late answer to the old one can be taken for the new one, losing the namespace connect
    ///   (no `.connect`, no restore) until the server drops the engine (connectTimeout, 10 s).
    ///   Read from the library source; a 2.5 s server-side handshake delay did not stall.
    ///   `SocketManager.reconnect()` runs through the same ticks, and so did the namespace
    ///   leave + join before 2026-11-12.
    /// A new manager starts exactly one handshake at once (attempt 0: no tick is scheduled
    /// until that handshake fails). The old manager is retired so that nothing of it can act
    /// later (`retire`).
    func forceReconnect() {
        if Self.connectionsDisabled { return }
        guard let manager, let socket else {
            print("[Socket] No socket to force-reconnect, calling connect()")
            connect()
            return
        }
        print("[Socket] Force reconnect: new connection (was manager \(manager.status), socket \(socket.status))")
        Self.retire(manager: manager, socket: socket)
        self.manager = nil
        self.socket = nil
        isConnected = false
        isSessionReady = false
        DispatchQueue.main.async { RestartNotices.shared.disconnected() }  // as the old .disconnect would have
        openConnection()
    }

    /// Makes a replaced manager and socket inert: no handler of ours runs on the old socket
    /// again, the manager never reconnects (its pending backoff tick returns at once:
    /// `_tryReconnect` needs `reconnects` and a status other than `.disconnected`), and a late
    /// answer to its handshake joins no namespace (the socket is no longer its). The engine
    /// closes; the server drops a namespace-less engine after connectTimeout.
    static func retire(manager: SocketManager, socket: SocketIOClient) {
        socket.removeAllHandlers()
        manager.reconnects = false
        manager.disconnect()
        manager.removeSocket(socket)
    }

    /// The socket's status changed (statusChange): any status but connected means it cannot
    /// emit, so `isConnected` is false until the next `.connect` sets it (the connected
    /// status itself is left to `.connect`, which also starts the restore).
    func noteStatus(_ status: SocketIOStatus) {
        if status != .connected {
            isConnected = false
            isSessionReady = false
        }
    }

    /// The server answered sign-in, sign-up or the restore with success and the follow-up
    /// (joinMainRoom, rejoinGame or joinTournament) has been emitted: a main-room action
    /// sent now reaches the server after it, so the restore's joinMainRoom can no longer
    /// undo it (a New Game tap between `.connect` and the restore's answer made a lobby
    /// that the joinMainRoom then left at once).
    func noteSessionEstablished() {
        isSessionReady = true
    }

    func disconnect() {
        if let manager, let socket { Self.retire(manager: manager, socket: socket) }
        socket = nil
        manager = nil
        DispatchQueue.main.async {
            self.isConnected = false
            self.isSessionReady = false
        }
    }

    // MARK: - Background Keep-Alive

    /// Begin a background task to keep the socket alive during brief app switches (~30s).
    func beginBackgroundKeepAlive() {
        guard backgroundTaskId == .invalid else { return }
        isBackgroundTaskActive = true
        backgroundTaskId = UIApplication.shared.beginBackgroundTask(withName: "SocketKeepAlive") { [weak self] in
            // Expiration handler — OS is about to kill the task
            self?.endBackgroundKeepAlive()
        }
        print("[Socket] Background keep-alive started")
    }

    /// End the background task (called on return to foreground or expiration).
    func endBackgroundKeepAlive() {
        guard backgroundTaskId != .invalid else { return }
        isBackgroundTaskActive = false
        UIApplication.shared.endBackgroundTask(backgroundTaskId)
        backgroundTaskId = .invalid
        print("[Socket] Background keep-alive ended")
    }

    // MARK: - Emit

    /// Emit event with no data
    func emit(_ event: String) {
        socket?.emit(event)
    }

    /// Emit event with a single dictionary payload
    func emit(_ event: String, _ data: [String: Any]) {
        #if DEBUG
        UIFixture.recordSent(event, data)
        #endif
        socket?.emit(event, data)
    }

    // MARK: - Listeners

    func on(_ event: String, callback: @escaping ([Any], SocketAckEmitter) -> Void) {
        socket?.on(event, callback: callback)
    }

    func off(_ event: String) {
        socket?.off(event)
    }
}
