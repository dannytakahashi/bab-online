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
/// shown (replies can finish out of order). An empty field shows the online players instead,
/// each with its picture: the online list is names only, so while it shows the sheet asks for
/// the listed players' cards (c2s `playerCards {usernames}` -> s2c `playerCardsResponse`, the
/// search rows of those players, 2026-11-27) and a row shows the name's initial until its card
/// is known. Main thread only (the socket handler hops to it).
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

        /// Something is on screen that the next reply replaces (so no spinner over it). Not the
        /// offline line: once a search can be sent it is no longer true, so it gives way to
        /// `.searching` (and the spinner rule) at once.
        var keepsWhileSearching: Bool {
            switch self {
            case .results: return true
            case .unavailable(let line): return line != PlayerSearchState.offlineLine
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
    var sendCards: ([String]) -> Void = { usernames in
        SocketService.shared.emit(SocketEvents.Client.playerCards, ["usernames": usernames])
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

    // MARK: Player cards (the online list's pictures)

    /// username -> the picture AvatarImageView loads (PlayerSearchResult.pictureKey), from
    /// playerCardsResponse and search results; kept for the app's session, so a reopened sheet
    /// draws the known pictures at once while it asks again.
    @Published private(set) var cards: [String: String] = [:]
    /// The names asked for since the sheet opened: each at most once per opening, so a server
    /// that never answers (one from before playerCards) costs one request per change of the list
    /// and nothing else. Cleared when the sheet opens, which refreshes every listed card. Two
    /// cases ask a name again within an opening (review of PR #454): a refused request (the
    /// rate limit, during a burst of joins) and a new session (a reconnect), each below.
    private(set) var cardsAsked = Set<String>()
    /// The names a reply has brought back since the sheet opened (a name with no account never
    /// comes back: it counts as unanswered, and is asked again at most as often as below).
    private(set) var cardsAnswered = Set<String>()
    /// The names asked again after a refusal since the sheet opened: each at most once, so a
    /// request the server always refuses is one retry, never a loop.
    private(set) var cardsRetried = Set<String>()
    /// After a refusal nothing is asked for `cardsRetryDelay` (the server's rate-limit window,
    /// playerCards 20 per 10 s); then what is unasked goes in one request.
    private(set) var cardsHeld = false
    var cardsRetryDelay: TimeInterval = 10
    private var cancelRetry: (() -> Void)?
    /// The online list as the sheet last showed it (the main room's, in its order).
    private var online: [String] = []
    private var sheetOpen = false
    private var cancelCards: (() -> Void)?
    /// The server's limit per playerCards request (profileHandlers PLAYER_CARDS_MAX).
    static let cardsBatch = 100
    /// The pause after a change of the online list before asking (the search's 300 ms).
    var cardsDebounce: TimeInterval = 0.3
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

    /// The sheet closed: nothing typed, nothing waiting (the cards stay for the next opening).
    func reset() {
        cancelDebounce?()
        cancelDebounce = nil
        text = ""
        clear()
        sheetOpen = false
        cancelCards?()
        cancelCards = nil
        endHold()
    }

    private func clear() {
        latestQuery = nil
        phase = .idle
        stopTimers()
        // the online list is back: the names it gained meanwhile, after the pause
        if sheetOpen { scheduleCards() }
    }

    // MARK: - Player cards

    /// The sheet opened on `online`: every listed name's card is asked for at once (known
    /// pictures show meanwhile).
    func sheetOpened(online: [String]) {
        sheetOpen = true
        cardsAsked = []
        cardsAnswered = []
        cardsRetried = []
        endHold()
        self.online = online
        askForCards()
    }

    /// The main room's online list changed while the sheet is up: the new names' cards after
    /// the pause (a leave asks for nothing).
    func onlineChanged(_ online: [String]) {
        self.online = online
        guard sheetOpen else { return }
        scheduleCards()
    }

    /// A new session while the sheet is up (SocketService.isSessionReady again: a reconnect's
    /// restore): the names sent and never answered are asked again, as are the names the sheet
    /// could not ask while offline, after the pause. A reply lost with the old socket would
    /// otherwise leave their initials until the sheet reopened, and the reconnect's online list
    /// is often the same one (no onChange). The new socket has a fresh rate limit, so a hold ends.
    func sessionRestored() {
        guard sheetOpen else { return }
        cardsAsked.formIntersection(cardsAnswered)
        endHold()
        scheduleCards()
    }

    private func scheduleCards() {
        guard !cardsHeld else { return }
        cancelCards?()
        cancelCards = schedule(cardsDebounce) { [weak self] in self?.askForCards() }
    }

    /// The listed names not asked for since the sheet opened, 100 a request; only while the
    /// online list shows (an empty field) and a request can be sent.
    private func askForCards() {
        cancelCards?()
        cancelCards = nil
        guard sheetOpen, !cardsHeld, phase == .idle, isConnected() else { return }
        var seen = Set<String>()
        let names = online.filter { !$0.isEmpty && !cardsAsked.contains($0) && !cardsAnswered.contains($0) && seen.insert($0).inserted }
        var start = 0
        while start < names.count {
            let batch = Array(names[start..<min(start + Self.cardsBatch, names.count)])
            cardsAsked.formUnion(batch)
            sendCards(batch)
            start += Self.cardsBatch
        }
    }

    /// playerCardsResponse: each row's picture remembered (the rows on screen redraw). A failure
    /// reply keeps the initials, and nothing is asked again until the list changes, a new
    /// session or the sheet reopens.
    func applyCards(response dict: [String: Any]) {
        guard dict["success"] as? Bool == true, let rows = dict["players"] as? [Any] else { return }
        let results = rows.compactMap { ($0 as? [String: Any]).flatMap { PlayerSearchResult.from($0, avatarUrls: Self.urls(dict)) } }
        cardsAnswered.formUnion(results.map(\.username))
        remember(results)
    }

    /// serverError for playerCards (the rate limit, a refused payload): claimed, so a background
    /// request never shows a toast; the initials stay for now. The names asked and not answered
    /// (the refused request's among them; the server does not say which it was) are asked once
    /// more, `cardsRetryDelay` later, with whatever joined meanwhile, in one request; a name
    /// already asked again after a refusal is not, so this is one retry, never a loop.
    func applyCardsServerError(_ dict: [String: Any]) -> Bool {
        guard dict["handler"] as? String == SocketEvents.Client.playerCards else { return false }
        guard sheetOpen else { return true }
        let again = cardsAsked.subtracting(cardsAnswered).subtracting(cardsRetried)
        cardsAsked.subtract(again)
        cardsRetried.formUnion(again)
        if !cardsHeld {
            cardsHeld = true
            cancelCards?()
            cancelCards = nil
            cancelRetry = schedule(cardsRetryDelay) { [weak self] in
                guard let self else { return }
                self.cancelRetry = nil
                self.cardsHeld = false
                self.askForCards()
            }
        }
        return true
    }

    private func endHold() {
        cancelRetry?()
        cancelRetry = nil
        cardsHeld = false
    }

    private func remember(_ results: [PlayerSearchResult]) {
        var next = cards
        for r in results { next[r.username] = r.pictureKey }
        if next != cards { cards = next }
    }

    private static func urls(_ dict: [String: Any]) -> [String: String] {
        var urls: [String: String] = [:]
        for (name, url) in dict["avatarUrls"] as? [String: Any] ?? [:] {
            if let url = url as? String { urls[name] = url }
        }
        return urls
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
            var seen = Set<String>()
            let results = rows.compactMap { ($0 as? [String: Any]).flatMap { PlayerSearchResult.from($0, avatarUrls: Self.urls(dict)) } }
                .filter { seen.insert($0.username).inserted }
            // a result row is a card too (the same row shape): the online list can use it
            remember(results)
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
        /// The picture to load; nil on an online row whose card is not known yet (the initial).
        let pictureKey: String?
        /// A row of the online list (an empty field), not a search result: no online dot (every
        /// row is online) and the `online.<name>` identifier.
        var inOnlineList = false
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

    /// The online list's rows (an empty field), in the server's order, each with its card's
    /// picture when known.
    static func onlineRows(_ online: [String], me: String, cards: [String: String] = [:]) -> [Row] {
        var seen = Set<String>()
        return online.filter { !$0.isEmpty && seen.insert($0).inserted }
            .map { Row(username: $0, pictureKey: cards[$0], inOnlineList: true, isOnline: true, isMe: !me.isEmpty && $0 == me) }
    }

    /// Search results as rows: the online dot from the main room's list.
    static func resultRows(_ results: [PlayerSearchResult], online: [String], me: String) -> [Row] {
        let on = Set(online)
        return results.map { Row(username: $0.username, pictureKey: $0.pictureKey, isOnline: on.contains($0.username),
                                 isMe: !me.isEmpty && $0.username == me) }
    }
}
