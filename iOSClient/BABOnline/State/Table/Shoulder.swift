import Foundation

// The over-the-shoulder view on iOS (owner 2026-11-21; the wire and the server's rules:
// docs/claude/spectators.md "Over-the-shoulder view"; the web's client/src/state/shoulder.js is
// the reference, ported rule for rule).
//
// A pure spectator watches one seat's hand, read-only, the table drawn from that seat as if
// looking over its player's shoulder. The wire keeps viewer.position null; the store keeps the
// role `.spectator` (nothing can act: TableState.myTurn, AssistRules.canAsk and every
// ActionCoordinator path require `.seat`) and sets `viewer.shoulder` {position, paused}: the
// table is drawn from that seat (`ViewerState.viewPosition`), its hand in `table.hand`, its HSI
// in `table.hsi`. `holdsSeat` never includes a watcher (it starts voice for a seat owner).
//
// What this file decides (the only sender of c2s watchHand, as `TableEffect.watchHand`):
//   - by default, after every full state (spectatorJoined, a requestSnapshot reply; never the
//     watchHand reply itself) and on the first deal: watch the first human seat in seat order
//     (seat 1 if none), or the person's pick for this game (an avatar tap; `Identity.watchChoices`,
//     in memory), or nothing after "Table view" for this game (it wins over every default);
//   - never at a tournament table (`tournamentId`, or the `tournament` refusal): no shoulder UI;
//   - the own-seat rule: a spectator whose username owns a seat here (a player's other device)
//     watches only that seat (the seat records, or the `own_seat` refusal's ownPosition);
//   - the paused rule: while the table is paused (an `unavailable` refusal, or between the
//     room's pause and resume lines) the selection stays, the hand area shows as paused, and
//     watchHand(selected) goes again after "Game resumed." and after the next full state; only
//     the person's own Table view, the game's end or leaving the table drop the selection.

/// The words and pure rules of the over-the-shoulder view (names only, never team numbers).
enum ShoulderRules {
    /// The clientHello cap that asks for it (ClientHello.caps).
    static let cap = "shoulderView"
    /// The read-only bid sheet's line when "<name> is bidding" does not fit (BidOverlayView).
    static let biddingShort = "Bidding"
    /// The room's system lines around a self-fence suspension (server/game/persist/liveStore.js).
    static let pauseLine = "Game paused: the server is reconnecting. It will resume on its own."
    static let resumeLine = "Game resumed."
    /// The pill's way back to the plain table view (the web's TABLE_VIEW_LABEL).
    static let tableViewLabel = "Table view"
    static let tableViewHint = "Stop watching: back to the table view"

    /// "Alice's" (the name as it is: no apostrophe rules beyond 's).
    static func possessive(_ name: String) -> String { "\(name)'s" }

    /// The spectating pill while watching: "Watching Alice's hand" (· paused).
    static func pillText(_ player: String, paused: Bool = false) -> String {
        "Watching \(possessive(player)) hand\(paused ? " \u{00B7} paused" : "")"
    }

    /// The watched hand area while the table is paused.
    static func pausedText(_ player: String) -> String {
        "Paused: \(possessive(player)) hand comes back when the game resumes."
    }

    /// The first human seat in seat order (an owner not gone, never a native bot), else seat 1.
    /// Every seat range here is the table's own (`TableSlice.seats`: Get Your Bid has no seat 4).
    static func firstHumanSeat(_ s: TableState) -> Int {
        (1...s.table.seats).first { pos in
            guard let seat = s.players.seats[pos], seat.controller != .bot, seat.presence != .gone, seat.presence != .none,
                  let owner = seat.ownerUsername, !owner.isEmpty else { return false }
            return true
        } ?? 1
    }

    /// The seat my username owns at this table (a player's other device; gone seats included).
    static func ownSeat(_ s: TableState) -> Int? {
        guard let me = s.table.me.username, !me.isEmpty else { return nil }
        return (1...s.table.seats).first { s.players.seats[$0]?.ownerUsername == me }
    }

    /// Is the shoulder view offered here: a pure spectator, not at a tournament table, not refused for the game.
    static func allowed(_ s: TableState) -> Bool {
        s.table.viewer.role == .spectator && s.table.tournamentId == nil && !s.table.watch.blocked
    }

    /// The person's pick for this game, if any.
    static func choice(_ s: TableState) -> WatchChoice? {
        s.table.gameId.flatMap { s.table.me.watchChoices[$0] }
    }

    /// The seat to watch now (nil: the plain table view).
    static func desired(_ s: TableState) -> Int? {
        guard allowed(s) else { return nil }
        let c = choice(s)
        // the person's Table view wins over every default: the own-seat rule only limits WHICH
        // seat may be watched, it never forces a watch
        if c == .table { return nil }
        if let own = s.table.watch.ownSeat ?? ownSeat(s) { return own }
        if case .seat(let p) = c { return p }
        // the seat watched now (the server's last word), else the first human seat
        return s.table.watch.selected ?? firstHumanSeat(s)
    }

    /// What a tap on seat `pos`'s avatar does: watch it, or open its player's profile (the
    /// watched seat itself, a seat the own-seat rule keeps out, a tournament table, a seat
    /// owner, before the first deal).
    enum Tap: Equatable { case watch, profile }

    static func tap(_ s: TableState, position pos: Int) -> Tap {
        guard (1...s.table.seats).contains(pos), allowed(s), s.table.deal != nil else { return .profile }
        if let own = s.table.watch.ownSeat ?? ownSeat(s), pos != own { return .profile }
        if s.table.viewer.watchedSeat == pos && s.table.viewer.watchesHand { return .profile }
        return .watch
    }

    /// The seats a tap (or a VoiceOver action) would watch now, in seat order.
    static func watchableSeats(_ s: TableState) -> [Int] {
        (1...s.table.seats).filter { tap(s, position: $0) == .watch }
    }
}

// MARK: - The reducer's side (the web's ShoulderWatch)

extension TableReducer {
    static func sendWatch(_ s: inout TableState, _ position: Int?, _ fx: inout [TableEffect]) {
        guard let gameId = s.table.gameId, s.table.viewer.role == .spectator else { return }
        fx.append(.watchHand(gameId: gameId, position: position))
    }

    /// The watched seat's view goes (a stop, a tournament table, not a spectator any more).
    static func stopWatchView(_ s: inout TableState) {
        guard s.table.viewer.shoulder != nil else { return }
        s.table.viewer.shoulder = nil
        if !s.table.viewer.holdsSeat {
            s.table.hand = []
            s.table.hsi = [:]
        }
        clearWatchedHints(&s)
    }

    /// Drop the selection and the view.
    static func clearWatchSelection(_ s: inout TableState) {
        s.table.watch.selected = nil
        s.table.watch.paused = false
        stopWatchView(&s)
    }

    /// The paused rule: hold seat `pos` (drawn from it, no cards) while the table is paused.
    static func holdWatch(_ s: inout TableState, _ pos: Int) {
        guard s.table.viewer.role == .spectator else { return }
        if s.table.viewer.shoulder?.position != pos { clearWatchedHints(&s) }
        s.table.viewer.shoulder = ShoulderSeat(position: pos, paused: true)
        s.table.hand = []
        s.table.hsi = [:]
        s.table.watchedAssist = nil
    }

    static func unpauseWatch(_ s: inout TableState) {
        s.table.watch.paused = false
    }

    static func clearWatchedHints(_ s: inout TableState) {
        s.table.watchedAssist = nil
        s.table.watchedTip = nil
    }

    /// Remember the person's pick for this game.
    static func rememberWatch(_ s: inout TableState, _ choice: WatchChoice) {
        guard let gameId = s.table.gameId else { return }
        s.table.me.watchChoices[gameId] = choice
    }

    /// A snapshot replaced the table: keep this game's selection, the held seat of a paused
    /// table (a snapshot without viewer.shoulder does not end the watch then) and the watched
    /// seat's hints while that seat is still the one served.
    static func carryWatch(from prev: TableState, into next: inout TableState, sameGame: Bool) {
        guard sameGame, next.table.viewer.role == .spectator else { return }
        next.table.watch = prev.table.watch
        if next.table.viewer.shoulder == nil, prev.table.watch.paused, let held = prev.table.watch.selected {
            next.table.viewer.shoulder = ShoulderSeat(position: held, paused: true)
            next.table.hand = []
            next.table.hsi = [:]
        }
        if let tip = prev.table.watchedTip, next.table.viewer.watchesHand, next.table.viewer.watchedSeat == tip.watched {
            next.table.watchedTip = tip
        }
        if let w = prev.table.watchedAssist, AssistRules.isLiveWatched(w, next) { next.table.watchedAssist = w }
    }

    /// After a full state (spectatorJoined, a requestSnapshot reply), already applied: send
    /// watchHand when what is wanted is not what is served (the re-send rule; idempotent).
    static func afterFullState(_ s: inout TableState, _ snap: TableSnapshot, _ fx: inout [TableEffect]) {
        guard s.table.viewer.role == .spectator else {
            s.table.watch = HandWatch()
            s.table.viewer.shoulder = nil
            clearWatchedHints(&s)
            return
        }
        if snap.tournament != nil { s.table.watch.blocked = true }
        guard ShoulderRules.allowed(s) else { clearWatchSelection(&s); return }
        let served = snap.viewer.shoulder.flatMap { Position.valid($0.position) }
        if let served {
            s.table.watch.selected = served
            unpauseWatch(&s)
        }
        guard snap.deal != nil else {
            s.table.watch.waitingDeal = true
            return
        }
        let want = s.table.watch.paused && s.table.watch.selected != nil ? s.table.watch.selected : ShoulderRules.desired(s)
        s.table.watch.selected = want
        s.table.watch.waitingDeal = false
        if want != served { sendWatch(&s, want, &fx) }
    }

    /// The watchHand reply (stateSnapshot reason watchHand), already applied.
    static func afterWatchReply(_ s: inout TableState, _ snap: TableSnapshot) {
        guard s.table.viewer.role == .spectator else { return }
        if let served = snap.viewer.shoulder.flatMap({ Position.valid($0.position) }) {
            s.table.watch.selected = served
            unpauseWatch(&s)
        } else if !s.table.watch.paused {
            s.table.watch.selected = nil
        }
    }

    /// gameStart for a spectator: the watched seat's new hand (gameStart.shoulder). One sent
    /// before my own Table view landed is not shown; a deal without it while watching keeps the
    /// view with no cards (afterDealWatch asks again).
    static func dealWatch(_ s: inout TableState, _ p: WirePayload.GameStart) {
        guard s.table.viewer.role == .spectator else { return }
        if let sh = p.shoulder?.value, let pos = Position.valid(sh.position), s.table.watch.selected != nil, !s.table.watch.paused {
            if s.table.viewer.shoulder?.position != pos { clearWatchedHints(&s) }
            s.table.viewer.shoulder = ShoulderSeat(position: pos)
            s.table.hand = sh.hand
            s.table.hsi = sh.hsi.map { [pos: $0] } ?? [:]
        } else if s.table.viewer.shoulder != nil {
            s.table.hand = []
            s.table.hsi = [:]
        }
    }

    /// After a spectator's deal: the first deal after the draw (or a not_dealt refusal) sends the
    /// watch; a deal without the wanted seat's hand asks again.
    static func afterDealWatch(_ s: inout TableState, _ p: WirePayload.GameStart, _ fx: inout [TableEffect]) {
        guard s.table.viewer.role == .spectator, ShoulderRules.allowed(s), !s.table.watch.paused else { return }
        let want = s.table.watch.selected ?? ShoulderRules.desired(s)
        let got = p.shoulder?.value.flatMap { Position.valid($0.position) }
        s.table.watch.waitingDeal = false
        if let want, got != want {
            s.table.watch.selected = want
            sendWatch(&s, want, &fx)
        }
    }

    /// watchHandRefused {gameId, position, reason, message, ownPosition?}.
    static func watchRefused(_ s: inout TableState, _ p: WirePayload.WatchHandRefused, _ fx: inout [TableEffect]) {
        guard s.table.viewer.role == .spectator else { return }
        if let gid = p.gameId, let mine = s.table.gameId, gid != mine { return }
        switch p.reason {
        case "own_seat":
            guard let own = Position.valid(p.ownPosition) else { return }
            s.table.watch.ownSeat = own
            // (after a Table view only a tap watches again)
            if ShoulderRules.choice(s) == .table || p.position == nil { return }
            s.table.watch.selected = own
            if p.position != own { sendWatch(&s, own, &fx) }
        case "unavailable":
            guard let sel = s.table.watch.selected else { return }
            s.table.watch.paused = true
            holdWatch(&s, sel)
        case "tournament":
            s.table.watch.blocked = true
            clearWatchSelection(&s)
        case "not_dealt":
            s.table.watch.waitingDeal = true
        default:
            // not_spectating (or a reason this build does not know): not a pure spectator of that table
            clearWatchSelection(&s)
        }
    }

    /// A room system line: the pause line keeps the selection and shows the hand area as paused;
    /// "Game resumed." sends the watch again.
    static func watchLogLine(_ s: inout TableState, _ message: String, _ fx: inout [TableEffect]) {
        guard ShoulderRules.allowed(s), let sel = s.table.watch.selected else { return }
        if message == ShoulderRules.pauseLine {
            s.table.watch.paused = true
            holdWatch(&s, sel)
        } else if message == ShoulderRules.resumeLine, s.table.watch.paused {
            sendWatch(&s, sel, &fx)
        }
    }

    /// An avatar tap (or its VoiceOver action): watch `pos`, remembered for this game.
    static func chooseWatch(_ s: inout TableState, _ pos: Int, _ fx: inout [TableEffect]) {
        guard ShoulderRules.tap(s, position: pos) == .watch else { return }
        rememberWatch(&s, .seat(pos))
        s.table.watch.selected = pos
        if s.table.watch.paused { holdWatch(&s, pos) }
        sendWatch(&s, pos, &fx)
    }

    /// "Table view": stop watching, remembered for this game; the view changes at once.
    static func stopWatch(_ s: inout TableState, _ fx: inout [TableEffect]) {
        guard s.table.viewer.role == .spectator else { return }
        rememberWatch(&s, .table)
        let had = s.table.watch.selected != nil || s.table.viewer.shoulder != nil
        clearWatchSelection(&s)
        if had { sendWatch(&s, nil, &fx) }
    }

    /// The game ended (gameEnd): the selection and the view go; nothing is sent.
    static func endWatch(_ s: inout TableState) {
        s.table.watch.selected = nil
        s.table.watch.paused = false
        stopWatchView(&s)
    }

    /// A watched seat's hint (assistHint `watched`): shown read-only while it is that seat's
    /// turn and this spectator watches it (never held, no log row, no count noted).
    static func watchedHint(_ s: inout TableState, _ h: AssistHint, _ fx: inout [TableEffect]) {
        guard s.table.viewer.role == .spectator, let w = h.watched, s.table.viewer.watchesHand,
              s.table.viewer.watchedSeat == w, h.kind != .status else { return }
        let name = s.players.name(w)
        if h.kind == .tip {
            guard !TutorialRules.isWelcome(h) else { return }
            switch s.table.phase.kind {
            case .bidding, .playing, .handResolving: break
            default: return
            }
            let fresh = s.table.watchedTip != h
            s.table.watchedTip = h
            if fresh { fx.append(.announce(TutorialRules.watchedAnnouncement(h, name: name))) }
            return
        }
        guard AssistRules.isLiveWatched(h, s) else { return }
        s.table.watchedAssist = h
        fx.append(.announce(AssistRules.watchedAnnouncement(h, name: name)))
    }
}
