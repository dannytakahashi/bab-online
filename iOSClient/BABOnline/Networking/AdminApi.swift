import Foundation

/// The admin panel's transport (the web's client/src/admin/adminApi.js): c2s
/// `adminRequest {requestId, action, args}` out, s2c `adminResponse` back to this socket
/// with the same requestId.
///
/// - A request is sent only when `send` takes it: the socket is connected and its sign-in
///   or restore was answered (`SocketService.canSendMainRoomActions`). Otherwise it fails
///   at once as `.offline`, so a `forbidden` answer always belongs to a signed-in socket
///   and means the admin access is gone (a request from a socket not yet restored would be
///   refused the same way and close the panel for nothing).
/// - No answer within `timeout` (15 s): `.timeout`.
/// - Over the server's limit (60 / min) the wrapper answers `serverError {code: 'rateLimit',
///   handler: 'adminRequest'}` with no requestId and never an adminResponse: a request
///   still unanswered `rateLimitGrace` (3 s) after it is the dropped one and fails as
///   `.rateLimited` (an accepted request answers well within that).
/// - A lost connection fails what waits as `.offline`: a new socket never gets the old
///   socket's answers.
///
/// Nothing is ever logged here: a createResetLink answer carries the link's secret.
@MainActor
final class AdminApi {
    enum NoAnswer: String, Error, Equatable {
        case timeout, rateLimited = "rate_limited", offline, closed
    }
    typealias Outcome = Result<AdminResponse, NoAnswer>

    static let requestTimeout: TimeInterval = 15
    static let rateLimitGrace: TimeInterval = 3

    /// Sends the payload; false when it cannot go out now (not connected, session not ready).
    var send: ([String: Any]) -> Bool = { _ in false }

    private let timeout: TimeInterval
    private let rateLimitGrace: TimeInterval
    private var pending: [String: Pending] = [:]
    private var seq = 0

    private struct Pending {
        let continuation: CheckedContinuation<Outcome, Never>
        var timer: DispatchWorkItem
    }

    init(timeout: TimeInterval = AdminApi.requestTimeout, rateLimitGrace: TimeInterval = AdminApi.rateLimitGrace) {
        self.timeout = timeout
        self.rateLimitGrace = rateLimitGrace
    }

    var pendingCount: Int { pending.count }

    /// One request; resumes with the server's answer (ok or not), or with why none came.
    func request(_ action: AdminAction, _ args: [String: Any] = [:]) async -> Outcome {
        seq += 1
        let requestId = "adm-\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))-\(seq)"
        return await withCheckedContinuation { continuation in
            let timer = schedule(requestId, after: timeout, as: .timeout)
            pending[requestId] = Pending(continuation: continuation, timer: timer)
            if !send(["requestId": requestId, "action": action.rawValue, "args": args]) {
                finish(requestId, .failure(.offline))
            }
        }
    }

    /// An `adminResponse` from the socket (AdminSocketHandler). One for a request that is
    /// not waiting (answered, timed out, another panel's) is dropped.
    func handleResponse(_ dict: [String: Any]) {
        guard let requestId = dict["requestId"] as? String, pending[requestId] != nil else { return }
        finish(requestId, .success(AdminResponse(dict)))
    }

    /// A `serverError` (SocketService.claimAdminServerError): true when it is the admin
    /// request limit and a request is waiting, so the panel says it and no raw toast shows.
    func handleServerError(_ dict: [String: Any]) -> Bool {
        guard dict["code"] as? String == "rateLimit", dict["handler"] as? String == SocketEvents.Client.adminRequest,
              !pending.isEmpty else { return false }
        for requestId in Array(pending.keys) {
            pending[requestId]?.timer.cancel()
            pending[requestId]?.timer = schedule(requestId, after: rateLimitGrace, as: .rateLimited)
        }
        return true
    }

    /// The socket is gone (disconnected, replaced): nothing waiting can be answered.
    func connectionLost() { failAll(.offline) }

    /// The panel closed.
    func closeAll() { failAll(.closed) }

    private func failAll(_ why: NoAnswer) {
        for requestId in Array(pending.keys) { finish(requestId, .failure(why)) }
    }

    private func schedule(_ requestId: String, after delay: TimeInterval, as why: NoAnswer) -> DispatchWorkItem {
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.finish(requestId, .failure(why)) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        return item
    }

    private func finish(_ requestId: String, _ outcome: Outcome) {
        guard let p = pending.removeValue(forKey: requestId) else { return }
        p.timer.cancel()
        p.continuation.resume(returning: outcome)
    }
}
