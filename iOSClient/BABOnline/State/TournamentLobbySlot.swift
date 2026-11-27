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
    ///
    /// My own row is read with `isReady` (review of PR #430): a tap flips the local flag at once
    /// while the server's row only changes with tournamentReadyUpdate, so the host's Unready under
    /// Begin left Begin up (and the toggle reading Ready) until the server answered.
    ///
    /// Past the ready deadline between rounds the host's own flag gates nothing (pressing Begin
    /// puts the host in the round, `TournamentBegin.sitsOut`), so Begin has no toggle under it.
    static func of(phase: String, isCreator: Bool, isSpectator: Bool, isReady: Bool,
                   deadlinePassed: Bool, players: [TournamentPlayer], me: String?, host: String?) -> TournamentLobbySlot? {
        guard phase == "lobby" || phase == "between_rounds", !isSpectator else { return nil }
        let players = players.map { row -> TournamentPlayer in
            guard let me, row.username == me, row.isReady != isReady else { return row }
            var mine = row
            mine.isReady = isReady
            return mine
        }
        if isCreator && TournamentBegin.canBegin(phase: phase, deadlinePassed: deadlinePassed, players: players) {
            let label = TournamentBegin.label(phase: phase, deadlinePassed: deadlinePassed, players: players)
            let sitOut = TournamentBegin.startsWithReadyOnly(phase: phase, deadlinePassed: deadlinePassed, players: players)
            let flagMatters = !(phase == "between_rounds" && deadlinePassed)
            return TournamentLobbySlot(primary: .begin(label), toggle: flagMatters ? (isReady ? .unready : .ready) : nil,
                                       caption: sitOut ? Copy.sitOutNote : nil)
        }
        guard isReady else { return TournamentLobbySlot(primary: .ready) }
        let waiting = players.filter { $0.connected && !$0.isReady && $0.username != me }.count
        let caption: String
        if waiting > 0 {
            caption = isCreator ? Copy.hostWaiting(waiting) : Copy.waitingFor(waiting)
        } else if isCreator {
            caption = Copy.waitingFor(0)  // my own row not in the list yet
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
        /// The small text button under Begin (a button, not a status: "Ready" under Begin read
        /// as "you are ready").
        static let markReady = "Mark me ready"
        static let markNotReady = "Mark me not ready"
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
/// spectator; each confirmed in its own submenu (the consequence, then one destructive button).
/// Cancel is not offered during Cut for a buck (as before), and the complete phase has no menu (its
/// back control reads "Main Room").
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

    /// What happens, in plain words, as the server does it (review of PR #430): the header of the
    /// item's confirm submenu.
    /// - the lobby phase: a member may join again while it waits to start; the host's role passes
    ///   to another member; with nobody else in it the tournament is deleted
    ///   (`GameManager.leaveTournament`: deleteTournamentIfAbandoned before transferCreator). In the
    ///   lobby a disconnect is a leave, so the other rows are connected members, except in a lobby
    ///   restored after a deploy: its members come back disconnected and hold it open
    ///   (restoreTournament's restoreHolds), and one of them takes the role (transferCreator falls
    ///   back to a disconnected member). So the lobby counts every other row (`othersPresent`);
    /// - once it has begun a member who leaves is gone: no score for later rounds (scoreMissedRound
    ///   covers members only), no way back (joinTournament refuses non-members after the lobby
    ///   phase), never a winner (getWinners takes members only);
    /// - between rounds with nobody else connected the tournament is deleted (no round game runs
    ///   then: deleteTournamentIfAbandoned). Not right away in a tournament restored after a deploy
    ///   while its abandon window holds it; the app cannot tell, and that window is short and rare;
    /// - the cut: leaving takes me out of it (cutForABuck.memberLeft).
    /// `othersConnected`: connected members besides me; `othersPresent`: every member besides me.
    static func confirmMessage(_ item: Item, phase: String, isCreator: Bool, othersConnected: Int,
                               othersPresent: Int) -> String {
        switch item {
        case .cancel:
            return phase == "lobby"
                ? "The tournament ends for everyone before it starts."
                : "The tournament ends for everyone, and any games still in play stop now."
        case .leave:
            switch phase {
            case "lobby":
                // alone in the lobby (the host, in practice: a lone member is handed the role)
                if othersPresent == 0 { return Copy.closesAlone }
                return isCreator ? "\(Copy.rejoinWhileWaiting) \(Copy.newHost)" : Copy.rejoinWhileWaiting
            case CutForABuck.phase:
                return isCreator && othersConnected > 0 ? "\(Copy.outOfTheCut) \(Copy.newHost)" : Copy.outOfTheCut
            default:
                if phase == "between_rounds" && othersConnected == 0 { return Copy.closesNobodyConnected }
                return isCreator && othersConnected > 0 ? "\(Copy.noWayBack) \(Copy.newHost)" : Copy.noWayBack
            }
        case .stopWatching:
            return "You go back to the main room."
        }
    }

    enum Copy {
        static let rejoinWhileWaiting = "You can join again while it's waiting to start."
        static let closesAlone = "The tournament closes, since nobody else has joined."
        static let closesNobodyConnected = "The tournament closes, since nobody else is connected."
        static let noWayBack = "You can't come back to this tournament, and you won't be among the winners."
        /// Lowercase mid-sentence (the owner's rule, CutCopy).
        static let outOfTheCut = "You'll be out of cut for a buck."
        static let newHost = "Another player becomes the host."
    }

    /// The confirming button (destructive role), the item's submenu's one button; closing the menu
    /// is the keep choice, so there is no second button.
    static func confirmButton(_ item: Item) -> String { title(item) }

    /// A confirm for a choice the menu no longer offers (the role or the phase changed under the
    /// open menu: a host hand-off, the cut, the results) is dropped.
    static func stillOffers(_ item: Item, phase: String, isCreator: Bool, isSpectator: Bool) -> Bool {
        items(phase: phase, isCreator: isCreator, isSpectator: isSpectator).contains(item)
    }
}
