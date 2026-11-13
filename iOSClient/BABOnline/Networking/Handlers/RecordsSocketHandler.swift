import Foundation

/// `recordsResponse` -> RecordsState (decoding and failures: RecordsState.apply; GameRecords).
final class RecordsSocketHandler {
    private let socket: SocketService
    private let recordsState: RecordsState

    init(socket: SocketService, recordsState: RecordsState) {
        self.socket = socket
        self.recordsState = recordsState
    }

    func register() {
        socket.on(SocketEvents.Server.recordsResponse) { [weak self] data, _ in
            guard let self, let dict = data.first as? [String: Any] else { return }
            DispatchQueue.main.async { self.recordsState.apply(response: dict) }
        }
    }
}
