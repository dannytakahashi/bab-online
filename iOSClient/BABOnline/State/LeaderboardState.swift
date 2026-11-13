import Foundation

/// Why a stats request failed: the reply's `message`, or no reply in time.
struct StatsFailure: Equatable {
    let message: String
    /// The server's soft limit (getLeaderboard / getRecords, 10 per 10 s) with nothing
    /// cached to answer from (profileHandlers replyThrottled).
    let isRateLimited: Bool

    init(message: String) {
        self.message = message
        isRateLimited = message.localizedCaseInsensitiveContains("too many requests")
    }

    static let noReply = StatsFailure(message: "The server didn't answer. Check your connection and try again.")
}

/// One stats page's data and request (the leaderboard, the records): the last good value
/// stays on screen while a refresh runs or after one fails.
struct StatsLoad<Value: Equatable>: Equatable {
    var value: Value?
    var isLoading = false
    var failure: StatsFailure?
    var loadedAt: Date?

    /// What the page shows.
    enum Display: Equatable { case loading, content, failed(StatsFailure) }

    var display: Display {
        if value != nil { return .content }
        if let failure, !isLoading { return .failed(failure) }
        return .loading
    }
}

/// A stats request over the socket with one reply event: at most one in flight, a reply or a
/// timeout ends it (and resumes a pull to refresh), a failed reply keeps the last good value.
/// Main thread only (the socket handlers hop to it).
class StatsLoader<Value: Equatable>: ObservableObject {
    @Published private(set) var load = StatsLoad<Value>()

    /// Sends the request (the emitter; tests and fixture mode replace it).
    var send: () -> Void
    /// How long a request may wait for its reply.
    var timeout: TimeInterval = 10
    var now: () -> Date = Date.init
    private var requestId = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(send: @escaping () -> Void) {
        self.send = send
    }

    /// Asks for the page unless a request is already waiting.
    func request() {
        if load.isLoading { return }
        willRequest(&load)
        load.isLoading = true
        load.failure = nil
        requestId += 1
        let id = requestId
        send()
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self, self.requestId == id, self.load.isLoading else { return }
            self.finish(failure: .noReply)
        }
    }

    /// Pull to refresh: a request, awaited until its reply or timeout.
    @MainActor
    func refresh() async {
        request()
        guard load.isLoading else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    /// A reply: the decoded value, else the failure it carries.
    func apply(response dict: [String: Any]) {
        if let value = decode(dict) {
            load.value = value
            load.loadedAt = now()
            finish(failure: nil)
        } else {
            finish(failure: StatsFailure(message: (dict["message"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallbackMessage))
        }
    }

    func reset() {
        load = StatsLoad()
        requestId += 1
        resumeWaiters()
    }

    // MARK: Subclass hooks

    func decode(_ dict: [String: Any]) -> Value? { nil }
    var fallbackMessage: String { "Failed to load" }
    /// Before a request: drop what must not be shown again (RecordsState: last month's).
    func willRequest(_ load: inout StatsLoad<Value>) {}

    private func finish(failure: StatsFailure?) {
        load.isLoading = false
        load.failure = failure
        resumeWaiters()
    }

    private func resumeWaiters() {
        let w = waiters
        waiters = []
        w.forEach { $0.resume() }
    }
}

/// The Stats sheet's Leaderboard tab (`getLeaderboard` -> `leaderboardResponse`).
final class LeaderboardState: StatsLoader<[LeaderboardEntry]> {
    /// The Stats tab last shown (kept for the session; never written to disk).
    @Published var tab: StatsTab = .leaderboard

    init() {
        super.init(send: { LeaderboardEmitter.getLeaderboard() })
    }

    override init(send: @escaping () -> Void) {
        super.init(send: send)
    }

    var entries: [LeaderboardEntry] { load.value ?? [] }

    override func decode(_ dict: [String: Any]) -> [LeaderboardEntry]? { LeaderboardEntry.rows(fromResponse: dict) }
    override var fallbackMessage: String { "Failed to load leaderboard" }
}

/// The Stats sheet's Records tab (`getRecords` -> `recordsResponse`).
final class RecordsState: StatsLoader<GameRecords> {
    var calendar = Calendar.current

    init() {
        super.init(send: { LeaderboardEmitter.getRecords() })
    }

    override init(send: @escaping () -> Void) {
        super.init(send: send)
    }

    override func decode(_ dict: [String: Any]) -> GameRecords? { GameRecords.from(response: dict) }
    override var fallbackMessage: String { "Failed to load records" }

    /// "This Month" and "This Year" are the server's current month and year: records loaded
    /// in an earlier month are not shown again while the new ones load (the server's cache
    /// is keyed by month the same way).
    override func willRequest(_ load: inout StatsLoad<GameRecords>) {
        guard let at = load.loadedAt else { return }
        let a = calendar.dateComponents([.year, .month], from: at), b = calendar.dateComponents([.year, .month], from: now())
        if a != b {
            load.value = nil
            load.loadedAt = nil
        }
    }
}

/// The Stats sheet's two tabs.
enum StatsTab: String, CaseIterable, Identifiable {
    case leaderboard, records
    var id: String { rawValue }
    var title: String { self == .leaderboard ? "Leaderboard" : "Records" }
}
