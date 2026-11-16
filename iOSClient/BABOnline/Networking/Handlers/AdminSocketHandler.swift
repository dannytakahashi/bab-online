import Foundation

/// Handles the admin panel's one reply event: adminResponse (matched to its request by
/// requestId in AdminApi). Never logged: a createResetLink answer carries the link's secret.
final class AdminSocketHandler {
    private let socket: SocketService
    private let api: AdminApi

    init(socket: SocketService, api: AdminApi) {
        self.socket = socket
        self.api = api
    }

    func register() {
        socket.on(SocketEvents.Server.adminResponse) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            let api = self.api
            DispatchQueue.main.async { MainActor.assumeIsolated { api.handleResponse(dict) } }
        }
    }
}
