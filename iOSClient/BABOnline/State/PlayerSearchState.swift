import Foundation
import Combine

/// One row of `searchPlayersResponse.players` (profileHandlers searchPlayers): a name and the
/// picture AvatarImageView loads (the row's `/avatar/` URL from `avatarUrls`, else the stock
/// number, as LeaderboardEntry reads it).
struct PlayerSearchResult: Identifiable, Equatable {
    let username: String
    let pictureKey: String
    var id: String { username }

    /// A row, or nil without a username. `avatarUrls` is the reply's username -> `/avatar/` map.
    static func from(_ dict: [String: Any], avatarUrls: [String: String] = [:]) -> PlayerSearchResult? {
        guard let username = StatsWire.string(dict["username"]) else { return nil }
        let pic = StatsWire.int(dict["profilePic"]).flatMap { (1...ProfilePicture.stockCount).contains($0) ? $0 : nil } ?? 1
        // a legacy (cap-less) reply carries a custom picture inline as a data URL, which the
        // SwiftUI avatar cache does not load: the stock picture then
        let custom = avatarUrls[username] ?? StatsWire.string(dict["customProfilePic"])
        let path = custom.flatMap { HTTPAvatarLoader.isAvatarPath($0) ? $0 : nil }
        return PlayerSearchResult(username: username, pictureKey: path ?? String(pic))
    }
}

/// The main room's Players sheet (owner 2026-11-27: the web's Players page on iOS): search as
/// you type over c2s `searchPlayers {query}` -> s2c `searchPlayersResponse`, as the web's
/// PlayerSearchPage does it: the trimmed text, 300 ms after the last keystroke (Search on the
/// keyboard sends at once), and only the reply whose echoed `query` is the latest one sent is
/// shown (replies can finish out of order). An empty field shows the online players instead.
/// Main thread only (the socket handler hops to it).
final class PlayerSearchState: ObservableObject {
    static let shared = PlayerSearchState()

    enum Phase: Equatable {
        /// Nothing typed: the sheet lists who is online.
        case idle
        /// A search is due or waiting for its reply, with nothing on screen yet.
        case searching
        /// The latest answered query's players (empty: "No players found"); they stay up while
        /// the next search runs, so a keystroke never blanks the list.
        case results([PlayerSearchResult])
        /// No search can be made or none answered: a quiet line, never an error. It stays up
        /// while the next search runs, as results do.
        case unavailable(String)

        /// Something is on screen that the next reply replaces (so no spinner over it).
        var keepsWhileSearching: Bool {
            switch self {
            case .results, .unavailable: return true
            case .idle, .searching: return false
            }
        }
    }

    /// What the field holds (the sheet's `.searchable` text).
    @Published private(set) var text = ""
    @Published private(set) var phase: Phase = .idle
    /// A search has waited long enough with nothing on screen to show it is working (a quick
    /// reply never flashes a spinner).
    @Published private(set) var showsProgress = false

    // MARK: Requests (tests and fixture mode replace them)

    var send: (String) -> Void = { query in
        SocketService.shared.emit(SocketEvents.Client.searchPlayers, ["query": query])
    }
    var isConnected: () -> Bool = { SocketService.shared.isConnected }
    /// Runs `work` after `delay` seconds; the returned closure cancels it.
    var schedule: (TimeInterval, @escaping () -> Void) -> () -> Void = { delay, work in
        let item = DispatchWorkItem(block: work)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        return { item.cancel() }
    }

    /// The web's debounce (PlayerSearchPage: 300 ms).
    var debounce: TimeInterval = 0.3
    /// How long a search runs before the spinner shows (only with no results on screen).
    var progressDelay: TimeInterval = 0.5
    var timeout: TimeInterval = 10

    /// No username is longer than this (server MAX_USERNAME_LENGTH): a longer query matches
    /// nobody, so it is answered here, never sent (the server would answer an empty list).
    static let maxQueryLength = 50
    static let offlineLine = "Search is available once you're connected."
    static let noAnswerLine = "Search isn't answering right now. Try again in a moment."
    static let rateLimitedLine = "Too many searches. Try again in a moment."

    /// The query of the latest searchPlayers sent (nil: none, or the field was cleared since).
    private(set) var latestQuery: String?
    private var cancelDebounce: (() -> Void)?
    private var cancelProgress: (() -> Void)?
    private var cancelTimeout: (() -> Void)?

    /// The trimmed field, the way the web sends it.
    var query: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    // MARK: - Typing

    /// The field changed: an empty one shows the online list; otherwise a search is due
    /// `debounce` after the last change.
    func setText(_ newText: String) {
        guard newText != text else { return }
        text = newText
        cancelDebounce?()
        cancelDebounce = nil
        let q = query
        if q.isEmpty {
            clear()
            return
        }
        // offline: the quiet line at once (no search can be sent, so no spinner either)
        guard isConnected() else {
            goOffline()
            return
        }
        // the last results (or "No players found", or a quiet line) stay up until the new reply
        if !phase.keepsWhileSearching { phase = .searching }
        startProgress()
        cancelDebounce = schedule(debounce) { [weak self] in self?.search() }
    }

    /// The keyboard's Search (the web's Enter): now, not after the pause.
    func submit() {
        cancelDebounce?()
        cancelDebounce = nil
        guard !query.isEmpty else { return }
        search()
    }

    /// The sheet closed: nothing typed, nothing waiting.
    func reset() {
        cancelDebounce?()
        cancelDebounce = nil
        text = ""
        clear()
    }

    private func clear() {
        latestQuery = nil
        phase = .idle
        stopTimers()
    }

    private func search() {
        cancelDebounce = nil
        let q = query
        guard !q.isEmpty else { return }
        guard q.count <= Self.maxQueryLength else {
            latestQuery = nil
            show([])
            return
        }
        guard isConnected() else {
            goOffline()
            return
        }
        latestQuery = q
        if !phase.keepsWhileSearching { phase = .searching }
        startProgress()
        cancelTimeout?()
        cancelTimeout = schedule(timeout) { [weak self] in
            guard let self, self.latestQuery == q else { return }
            self.latestQuery = nil
            self.stopTimers()
            self.phase = .unavailable(Self.noAnswerLine)
        }
        send(q)
    }

    private func goOffline() {
        latestQuery = nil
        stopTimers()
        let line = Phase.unavailable(Self.offlineLine)
        if phase != line { phase = line }
    }

    private func startProgress() {
        guard cancelProgress == nil, !showsProgress else { return }
        cancelProgress = schedule(progressDelay) { [weak self] in
            guard let self else { return }
            self.cancelProgress = nil
            if self.phase == .searching { self.showsProgress = true }
        }
    }

    private func stopTimers() {
        cancelProgress?()
        cancelProgress = nil
        cancelTimeout?()
        cancelTimeout = nil
        showsProgress = false
    }

    private func show(_ results: [PlayerSearchResult]) {
        stopTimers()
        phase = .results(results)
    }

    // MARK: - Replies

    /// searchPlayersResponse: shown unless it answers an older query than the latest one sent
    /// (the echoed `query`; a reply without one, from an older server, is shown as on the web).
    /// Returns whether it was taken.
    @discardableResult
    func apply(response dict: [String: Any]) -> Bool {
        guard let latest = latestQuery else { return false }
        if let echoed = dict["query"] as? String, echoed != latest { return false }
        latestQuery = nil
        if dict["success"] as? Bool == true, let rows = dict["players"] as? [Any] {
            var urls: [String: String] = [:]
            for (name, url) in dict["avatarUrls"] as? [String: Any] ?? [:] {
                if let url = url as? String { urls[name] = url }
            }
            var seen = Set<String>()
            let results = rows.compactMap { ($0 as? [String: Any]).flatMap { PlayerSearchResult.from($0, avatarUrls: urls) } }
                .filter { seen.insert($0.username).inserted }
            show(results)
        } else {
            stopTimers()
            phase = .unavailable(Self.noAnswerLine)
        }
        return true
    }

    /// serverError for a waiting search (the rate limit: 30 per 10 s): true when it was ours.
    func applyServerError(_ dict: [String: Any]) -> Bool {
        guard dict["handler"] as? String == SocketEvents.Client.searchPlayers, latestQuery != nil else { return false }
        latestQuery = nil
        stopTimers()
        let rateLimited = (dict["code"] as? String ?? dict["type"] as? String) == "rateLimit"
        phase = .unavailable(rateLimited ? Self.rateLimitedLine : Self.noAnswerLine)
        return true
    }

    // MARK: - Rows

    struct Row: Identifiable, Equatable {
        let username: String
        /// Nil for the online list (names only, as the server sends it).
        let pictureKey: String?
        let isOnline: Bool
        /// My own name is just my name (my profile lives in the Account sheet).
        let isMe: Bool
        var id: String { username }

        /// VoiceOver: "kim, online".
        var spokenLabel: String {
            var parts = [username]
            if isMe { parts.append("you") }
            if isOnline { parts.append("online") }
            return parts.joined(separator: ", ")
        }
    }

    /// The online list's rows (an empty field), in the server's order.
    static func onlineRows(_ online: [String], me: String) -> [Row] {
        var seen = Set<String>()
        return online.filter { !$0.isEmpty && seen.insert($0).inserted }
            .map { Row(username: $0, pictureKey: nil, isOnline: true, isMe: !me.isEmpty && $0 == me) }
    }

    /// Search results as rows: the online dot from the main room's list.
    static func resultRows(_ results: [PlayerSearchResult], online: [String], me: String) -> [Row] {
        let on = Set(online)
        return results.map { Row(username: $0.username, pictureKey: $0.pictureKey, isOnline: on.contains($0.username),
                                 isMe: !me.isEmpty && $0.username == me) }
    }
}
