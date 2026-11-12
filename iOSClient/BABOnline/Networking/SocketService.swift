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

    private var isForceReconnecting = false
    private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid
    private(set) var isBackgroundTaskActive = false

    private(set) var manager: SocketManager?
    private(set) var socket: SocketIOClient?
    var eventRouter: SocketEventRouter?

    /// Set by BABOnlineApp so SocketService can auto-restore session on reconnect
    weak var authState: AuthState?

    /// The server URL — simulator uses localhost, physical device uses production (ServerConfig)
    private var serverURL: String { ServerConfig.baseURL }
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

        let url = URL(string: serverURL)!
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
        manager = SocketManager(socketURL: url, config: config)

        socket = manager?.defaultSocket

        socket?.on(clientEvent: .connect) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.isConnected = true
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
                RestartNotices.shared.disconnected()
                print("[Socket] Disconnected")
            }
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
        // without a .disconnect event (isConnected stays true): the restart toast learns it here
        socket?.on(clientEvent: .reconnectAttempt) { _, _ in
            DispatchQueue.main.async { RestartNotices.shared.disconnected() }
        }

        // ~1 s before every deploy closes the sockets (roadmap #17): the toast, and what will be lost
        socket?.on(SocketEvents.Server.serverShutdown) { [weak self] data, _ in
            let dict = data.first as? [String: Any]
            DispatchQueue.main.async { self?.handleServerShutdown(dict) }
        }

        socket?.connect()
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

    /// Force a full disconnect/reconnect cycle.
    /// iOS can silently kill the WebSocket when backgrounded without firing a disconnect event,
    /// leaving `isConnected` stale. This tears down and re-establishes the connection so
    /// Socket.IO fires `.connect` and the `restoreSession` flow runs.
    func forceReconnect() {
        if Self.connectionsDisabled { return }
        guard !isForceReconnecting else {
            print("[Socket] forceReconnect already in progress, skipping")
            return
        }
        guard socket != nil else {
            print("[Socket] No socket to force-reconnect, calling connect()")
            connect()
            return
        }

        isForceReconnecting = true
        print("[Socket] Force reconnecting — tearing down and reconnecting")
        socket?.disconnect()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self else { return }
            self.socket?.connect()
            self.isForceReconnecting = false
        }
    }

    func disconnect() {
        socket?.disconnect()
        socket = nil
        manager = nil
        DispatchQueue.main.async {
            self.isConnected = false
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
