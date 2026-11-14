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

/// Which games the Stats sheet counts (owner 2026-11-13: games with bots are recorded from the
/// server update that adds them; the standings default to games among people). One choice for
/// both tabs, kept on disk (`UserDefaults` "statsScope").
enum StatsScope: String, CaseIterable, Identifiable {
    case human, bots, all

    var id: String { rawValue }

    /// The segment's label (short enough for three segments on the narrowest iPhone).
    var title: String {
        switch self {
        case .human: return "Humans"
        case .bots: return "Bots"
        case .all: return "All"
        }
    }

    /// What VoiceOver says for the segment.
    var spokenTitle: String {
        switch self {
        case .human: return "Human games"
        case .bots: return "Bot games"
        case .all: return "All games"
        }
    }

    /// The request's payload: none for human games (the request as it was before scopes, which
    /// every server answers with human games), else `{scope}`.
    var payload: [String: Any]? { self == .human ? nil : ["scope": rawValue] }

    static let defaultsKey = "statsScope"

    /// The saved choice; human games when there is none (or it is not one of the three).
    static func saved(_ defaults: UserDefaults = .standard) -> StatsScope {
        defaults.string(forKey: defaultsKey).flatMap(StatsScope.init(rawValue:)) ?? .human
    }

    func save(_ defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.defaultsKey)
    }

    /// A reply's `scope` echo: `.some(scope)`, `.some(nil)` for an echo this build does not know
    /// (the reply is dropped), nil for none (or a null one). The scoped server echoes a success
    /// only when its request named a scope (so never for Humans, which sends no payload) and
    /// never echoes a failure; today's server echoes nothing.
    static func echo(of dict: [String: Any]) -> StatsScope?? {
        guard let echo = dict["scope"], !(echo is NSNull) else { return nil }
        return .some((echo as? String).flatMap(StatsScope.init(rawValue:)))
    }
}

/// A stats request over the socket with one reply event: at most one in flight per scope, a
/// reply or a timeout ends it (and resumes a pull to refresh), a failed reply keeps the last
/// good value. Each scope keeps its own page, so a reply for another scope (`target`) fills
/// that scope's page and never shows under the selected one, and switching back shows
/// that scope's last numbers while they refresh. Main thread only (the socket handlers hop to it).
class StatsLoader<Value: Equatable>: ObservableObject {
    /// The games counted (the Stats sheet's Humans / Bots / All, shared by both tabs).
    @Published private(set) var scope: StatsScope
    @Published private var loads: [StatsScope: StatsLoad<Value>] = [:]

    /// The selected scope's page.
    var load: StatsLoad<Value> { loads[scope] ?? StatsLoad() }

    /// Sends the request for a scope (the emitter; tests and fixture mode replace it).
    var send: (StatsScope) -> Void
    /// How long a request may wait for its reply.
    var timeout: TimeInterval = 10
    var now: () -> Date = Date.init
    /// Where the scope is saved (tests pass their own suite).
    let defaults: UserDefaults
    private var requestIds: [StatsScope: Int] = [:]
    /// Humans requests sent and not yet answered, timed out ones included (a Humans success
    /// has no echo, so this is how a late one is told from today's server answering Bots / All).
    private var humanAwaited = 0
    /// A reply has carried a `scope` echo: the server is the scoped one, whose successes
    /// without an echo are only ever Humans'.
    private var serverEchoes = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(send: @escaping (StatsScope) -> Void, defaults: UserDefaults = .standard) {
        self.send = send
        self.defaults = defaults
        scope = StatsScope.saved(defaults)
    }

    /// Shows another scope and saves the choice. The tab on screen then asks for it (its view's
    /// `request()` on the change), keeping that scope's last data, if any, up meanwhile.
    func select(_ newScope: StatsScope) {
        newScope.save(defaults)
        guard newScope != scope else { return }
        scope = newScope
        // a pull to refresh on the old scope's page ends with that page
        resumeWaiters()
    }

    /// Asks for the selected scope's page unless its request is already waiting.
    func request() {
        let scope = scope
        var load = loads[scope] ?? StatsLoad()
        if load.isLoading { return }
        willRequest(&load)
        load.isLoading = true
        load.failure = nil
        loads[scope] = load
        let id = (requestIds[scope] ?? 0) + 1
        requestIds[scope] = id
        if scope == .human { humanAwaited += 1 }
        send(scope)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self, self.requestIds[scope] == id, self.loads[scope]?.isLoading == true else { return }
            self.finish(scope, failure: .noReply)
        }
    }

    /// Pull to refresh: a request, awaited until its reply or timeout.
    @MainActor
    func refresh() async {
        request()
        guard load.isLoading else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    /// A reply: the decoded value, else the failure it carries, on the page of the scope it
    /// answers (`target`).
    func apply(response dict: [String: Any]) {
        let value = decode(dict)
        guard let target = target(of: dict, success: value != nil) else { return }
        if let value {
            loads[target, default: StatsLoad()].value = value
            loads[target, default: StatsLoad()].loadedAt = now()
            finish(target, failure: nil)
        } else {
            finish(target, failure: StatsFailure(message: (dict["message"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallbackMessage))
        }
    }

    /// The page a reply lands on; nil drops it.
    /// - An echo: that scope's page (an echo this build does not know: dropped).
    /// - No echo, a success: human games in every case (the scoped server echoes every success
    ///   for Bots / All, and today's server answers every request with human games), so the
    ///   Humans page, unless no Humans reply is due (`humanAwaited`), a Bots / All request is
    ///   waiting and no reply has carried an echo: then today's server is answering it, and its
    ///   page (the selected one if it is waiting) shows that answer, as it did before scopes.
    /// - No echo, a failure (neither server echoes one): the selected page if its request is
    ///   waiting, else the waiting one (Humans first), else dropped (its request already timed
    ///   out). A failure carries no numbers and every page keeps its last good ones.
    private func target(of dict: [String: Any], success: Bool) -> StatsScope? {
        if let echo = StatsScope.echo(of: dict) {
            serverEchoes = true
            return echo
        }
        // the requests waiting for a reply (a Humans one is also counted in humanAwaited)
        let waiting = StatsScope.allCases.filter { loads[$0]?.isLoading == true }
        if success {
            if serverEchoes || humanAwaited > 0 || waiting.isEmpty {
                humanAwaited = max(0, humanAwaited - 1)
                return .human
            }
            return waiting.contains(scope) ? scope : waiting.first
        }
        let target = waiting.contains(scope) ? scope : waiting.first
        if target == .human { humanAwaited = max(0, humanAwaited - 1) }
        return target
    }

    func reset() {
        loads = [:]
        humanAwaited = 0
        for s in StatsScope.allCases { requestIds[s, default: 0] += 1 }
        resumeWaiters()
    }

    // MARK: Subclass hooks

    func decode(_ dict: [String: Any]) -> Value? { nil }
    var fallbackMessage: String { "Failed to load" }
    /// Before a request: drop what must not be shown again (RecordsState: last month's).
    func willRequest(_ load: inout StatsLoad<Value>) {}

    private func finish(_ scope: StatsScope, failure: StatsFailure?) {
        loads[scope, default: StatsLoad()].isLoading = false
        loads[scope, default: StatsLoad()].failure = failure
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
    /// The leaderboard's sort and its expanded list rows (kept for the session, like the tab:
    /// the sheet rebuilds the Leaderboard view on every tab switch).
    @Published var sort = LeaderboardSort()
    @Published var expanded: Set<String> = []

    init() {
        super.init(send: { LeaderboardEmitter.getLeaderboard(scope: $0) })
    }

    override init(send: @escaping (StatsScope) -> Void, defaults: UserDefaults = .standard) {
        super.init(send: send, defaults: defaults)
    }

    var entries: [LeaderboardEntry] { load.value ?? [] }

    override func decode(_ dict: [String: Any]) -> [LeaderboardEntry]? { LeaderboardEntry.rows(fromResponse: dict) }
    override var fallbackMessage: String { "Failed to load leaderboard" }
}

/// The Stats sheet's Records tab (`getRecords` -> `recordsResponse`).
final class RecordsState: StatsLoader<GameRecords> {
    var calendar = Calendar.current
    /// The period shown where one card fits across (phones; kept for the session, never on disk).
    @Published var period: GameRecords.Period = .allTime

    init() {
        super.init(send: { LeaderboardEmitter.getRecords(scope: $0) })
    }

    override init(send: @escaping (StatsScope) -> Void, defaults: UserDefaults = .standard) {
        super.init(send: send, defaults: defaults)
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
