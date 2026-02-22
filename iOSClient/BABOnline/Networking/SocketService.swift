import Foundation
import SocketIO
import Combine

/// Singleton managing the Socket.IO connection.
final class SocketService: ObservableObject {
    static let shared = SocketService()

    @Published var isConnected = false
    @Published var connectionError: String?

    private var isForceReconnecting = false

    private(set) var manager: SocketManager?
    private(set) var socket: SocketIOClient?
    var eventRouter: SocketEventRouter?

    /// Set by BABOnlineApp so SocketService can auto-restore session on reconnect
    weak var authState: AuthState?

    /// The server URL — simulator uses localhost, physical device uses production
    #if targetEnvironment(simulator)
    private let serverURL = "http://localhost:3000"
    #else
    private let serverURL = "https://babonline.io"
    #endif

    var socketId: String? { socket?.sid }

    private init() {}

    // MARK: - Connection

    func connect() {
        // If socket already exists, just reconnect it (preserves registered handlers)
        if let socket = socket {
            if socket.status != .connected {
                socket.connect()
            }
            return
        }

        let url = URL(string: serverURL)!
        manager = SocketManager(socketURL: url, config: [
            .log(true),
            .compress,
            .reconnects(true),
            .reconnectAttempts(-1),
            .reconnectWait(1),
            .reconnectWaitMax(5),
            .forceWebsockets(false),
        ])

        socket = manager?.defaultSocket

        socket?.on(clientEvent: .connect) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.isConnected = true
                self?.connectionError = nil
                print("[Socket] Connected: \(self?.socket?.sid ?? "?")")
            }
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
                print("[Socket] Disconnected")
            }
        }

        socket?.on(clientEvent: .error) { [weak self] data, _ in
            DispatchQueue.main.async {
                let msg = (data.first as? String) ?? "Unknown error"
                self?.connectionError = msg
                print("[Socket] Error: \(msg)")
            }
        }

        socket?.connect()
    }

    /// Force a full disconnect/reconnect cycle.
    /// iOS can silently kill the WebSocket when backgrounded without firing a disconnect event,
    /// leaving `isConnected` stale. This tears down and re-establishes the connection so
    /// Socket.IO fires `.connect` and the `restoreSession` flow runs.
    func forceReconnect() {
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
