import Foundation

/// The tournament lobby's one action slot at the bottom (owner 2026-11-26: "one primary action"):
/// Ready, then Unready; for the host, once Begin is allowed (`TournamentBegin.canBegin`, the
/// server's rule: every connected member ready, or between rounds past the ready deadline), the
/// same slot is Begin Tournament / Begin Next Round / Start with ready players with the host's
/// own Ready / Unready as a small text button under it. Pure: phase x role x ready x canBegin.
struct TournamentLobbySlot: Equatable {
    enum Primary: Equatable {
        /// Primary style; sends tournamentReady.
        case ready
        /// Secondary style; sends tournamentUnready.
        case unready
        /// The host's Begin (warning fill), with `TournamentBegin.label`'s words; sends
        /// beginTournament in the lobby, beginNextRound between rounds.
        case begin(String)
    }

    /// The small text button under Begin: the host's own ready flag.
    enum Toggle: Equatable { case ready, unready }

    var primary: Primary
    var toggle: Toggle?
    /// One line under the slot saying what it waits for (nil: nothing to wait for).
    var caption: String?

    /// nil: no slot (a round in play, the cut, the results, a spectator, an unknown phase).
    /// `isReady` is the ready flag to show (TournamentLobbyView's `showsReady`: not ready while a
    /// re-entry waits); `me` my username.
    static func of(phase: String, isCreator: Bool, isSpectator: Bool, isReady: Bool,
                   deadlinePassed: Bool, players: [TournamentPlayer], me: String?, host: String?) -> TournamentLobbySlot? {
        guard phase == "lobby" || phase == "between_rounds", !isSpectator else { return nil }
        if isCreator && TournamentBegin.canBegin(phase: phase, deadlinePassed: deadlinePassed, players: players) {
            let label = TournamentBegin.label(phase: phase, deadlinePassed: deadlinePassed, players: players)
            let sitOut = TournamentBegin.startsWithReadyOnly(phase: phase, deadlinePassed: deadlinePassed, players: players)
            return TournamentLobbySlot(primary: .begin(label), toggle: isReady ? .unready : .ready,
                                       caption: sitOut ? Copy.sitOutNote : nil)
        }
        guard isReady else { return TournamentLobbySlot(primary: .ready) }
        let waiting = players.filter { $0.connected && !$0.isReady && $0.username != me }.count
        let caption: String
        if waiting > 0 {
            caption = isCreator ? Copy.hostWaiting(waiting) : Copy.waitingFor(waiting)
        } else if isCreator {
            caption = Copy.waitingFor(0)  // my own row not yet updated by the server
        } else {
            caption = Copy.waitingForHost(host)
        }
        return TournamentLobbySlot(primary: .unready, caption: caption)
    }

    init(primary: Primary, toggle: Toggle? = nil, caption: String? = nil) {
        self.primary = primary
        self.toggle = toggle
        self.caption = caption
    }

    enum Copy {
        static let ready = "Ready"
        static let unready = "Unready"
        static let sitOutNote = "Players who aren't ready sit this round out."

        static func players(_ n: Int) -> String { n == 1 ? "1 player" : "\(n) players" }

        static func waitingFor(_ n: Int) -> String {
            n == 0 ? "Waiting for everyone to be ready" : "Waiting for \(players(n)) to ready up"
        }

        static func hostWaiting(_ n: Int) -> String {
            "Waiting for \(players(n)) to ready up, then you can begin"
        }

        static func waitingForHost(_ host: String?) -> String {
            guard let host, !host.isEmpty else { return "Waiting for the host to begin" }
            return "Waiting for \(host) to begin"
        }
    }
}

/// The lobby header's "…" menu (owner 2026-11-26): Cancel Tournament for the host, Leave for
/// everyone (the host too: the role passes on, as the old Leave did), Stop Watching for a
/// spectator; each confirmed first. Cancel is not offered during Cut for a buck (as before), and
/// the complete phase has no menu (its back control reads "Main Room").
enum TournamentLobbyMenu {
    enum Item: Equatable { case cancel, leave, stopWatching }

    static func items(phase: String, isCreator: Bool, isSpectator: Bool) -> [Item] {
        if phase == "complete" { return [] }
        if isSpectator { return [.stopWatching] }
        var items: [Item] = [.leave]
        if isCreator && phase != CutForABuck.phase { items.append(.cancel) }
        return items
    }

    static func title(_ item: Item) -> String {
        switch item {
        case .cancel: return "Cancel Tournament"
        case .leave: return "Leave Tournament"
        case .stopWatching: return "Stop Watching"
        }
    }

    static func icon(_ item: Item) -> String {
        switch item {
        case .cancel: return "xmark.circle"
        case .leave: return "rectangle.portrait.and.arrow.right"
        case .stopWatching: return "eye.slash"
        }
    }

    /// The confirmation's question.
    static func confirmTitle(_ item: Item) -> String {
        switch item {
        case .cancel: return "Cancel the tournament?"
        case .leave: return "Leave the tournament?"
        case .stopWatching: return "Stop watching?"
        }
    }

    /// What happens, in plain words.
    static func confirmMessage(_ item: Item, phase: String, isCreator: Bool) -> String {
        switch item {
        case .cancel:
            return phase == "lobby"
                ? "The tournament ends for everyone before it starts."
                : "The tournament ends for everyone, and any games still in play stop now."
        case .leave:
            var lines: [String] = []
            if phase == "lobby" {
                lines.append("You can join again while it's waiting to start.")
            } else {
                lines.append("You'll miss the rounds still to come; a missed round scores that round's lowest.")
            }
            if isCreator { lines.append("Another player becomes the host.") }
            return lines.joined(separator: " ")
        case .stopWatching:
            return "You go back to the main room."
        }
    }

    /// The confirming button (destructive role); the other one keeps things as they are.
    static func confirmButton(_ item: Item) -> String { title(item) }

    static func keepButton(_ item: Item) -> String {
        switch item {
        case .cancel: return "Keep Tournament"
        case .leave: return "Stay"
        case .stopWatching: return "Keep Watching"
        }
    }
}
