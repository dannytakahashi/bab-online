import Foundation

// /help (AssistHint.swift; the web's GameScene.handleAssistHint): my private answer, kept in the
// table slice so the card, the suggested card's glow (TableRenderModel.Hand.suggestedId) and the
// suggested bid's ring all follow one state. Cleared on the same events as the web: the next
// updateTurn (unless still live by its turnKey), my own bidReceived / cardPlayed (and my own
// submit), the end of the bidding, hand end, a redeal, a new deal, game end, a bot taking my
// seat, a snapshot that leaves it stale.

extension TableReducer {
    /// assistHint (private, unsequenced): one for this turn shows (the card, the glow or the
    /// ring, a dim private log row, the VoiceOver announcement); a status reply while a live
    /// suggestion is up is a toast and leaves the suggestion; a bid or card answer that is not
    /// live is held (shown if the next turn change makes it live, else its row says the turn had
    /// passed). Off the table: the draw's status is a toast, the game-end screen's a log row.
    static func assistHint(_ s: inout TableState, _ w: WirePayload.AssistHint, _ fx: inout [TableEffect]) {
        guard let wire = AssistHint(w) else { return }
        // the tutorial's push is not the answer the lightbulb waits for
        if !wire.isTutorial { s.table.assistAsking = false }
        // a pure spectator's reply ("players only") says nothing about my uses
        if s.table.viewer.role != .spectator {
            s.table.assistUses = AssistUses(uses: wire.uses, freeUses: wire.freeUses, assisted: wire.assisted, unlimited: wire.unlimited,
                                      told: true)
        }
        // a game with a native bot seat: no count, no note, never bot-assisted (the card's
        // footer and VoiceOver); the hint's own flag decides (the server's verdict)
        let h = AssistRules.inFreeHelpGame(wire)
        if h.kind == .tip { tutorialTip(&s, h, &fx); return }
        // a reply to /tutorial (e.g. the rate limit after the chip's switch): the switch settles
        if h.kind == .status && h.isTutorial { s.table.tutorialOffSent = false }
        switch s.table.phase.kind {
        case .ended:
            if h.kind == .status { addPrivateLog(&s, AssistRules.logLine(h, note: !h.isTutorial || tutorialNote(&s))) }
            return
        case .none, .waiting, .draw:
            if h.kind == .status { fx.append(.infoNotice(h.headline)) }
            return
        default:
            break
        }
        if h.kind == .status, let up = s.table.assist, up.kind != .status, AssistRules.isLive(up, s) {
            fx.append(.notice(h.headline))
            return
        }
        guard AssistRules.isLive(h, s) else {
            abandonParked(&s)
            s.table.parkedAssist = h
            return
        }
        abandonParked(&s)
        showAssist(&s, h, &fx)
    }

    /// Put a live answer up (the card, the glow or ring, the row, the announcement).
    /// The tutorial's advice adds no row: it comes on every decision while the tutorial is on.
    static func showAssist(_ s: inout TableState, _ h: AssistHint, _ fx: inout [TableEffect]) {
        if !(h.isTutorial && h.kind != .status) { addPrivateLog(&s, AssistRules.logLine(h, note: !h.isTutorial || tutorialNote(&s))) }
        s.table.assist = h
        fx.append(.announce(AssistRules.announcement(h)))
    }

    /// A held (not yet live) answer is given up: its row says the turn had passed.
    /// The tutorial's advice goes quietly (never asked for, never counted).
    static func abandonParked(_ s: inout TableState) {
        guard let parked = s.table.parkedAssist else { return }
        s.table.parkedAssist = nil
        if !parked.isTutorial { addPrivateLog(&s, AssistRules.lateLine) }
    }

    /// My /help answer is done (and a held one with it, said in its row).
    static func clearAssist(_ s: inout TableState) {
        abandonParked(&s)
        s.table.assist = nil
    }

    /// The table moved: a held answer that is live now shows. A turn change (`abandon`) gives up
    /// a held one that is not and ends the answer up unless it is still this turn's by its
    /// turnKey (a status reply ends there); a snapshot (a resync, a rejected action) ends it only
    /// once it is no longer live.
    static func settleAssist(_ s: inout TableState, abandon: Bool, _ fx: inout [TableEffect]) {
        if let held = s.table.parkedAssist {
            if AssistRules.stillLive(held, s) {
                s.table.parkedAssist = nil
                showAssist(&s, held, &fx)
            } else if abandon {
                abandonParked(&s)
            }
        }
        if let up = s.table.assist, !(abandon ? AssistRules.stillLive(up, s) : AssistRules.isLive(up, s)) { s.table.assist = nil }
    }

    /// Game over: nothing to show and no row for a held answer.
    static func dropAssist(_ s: inout TableState) {
        s.table.assist = nil
        s.table.parkedAssist = nil
        s.table.assistAsking = false
        s.table.tip = nil
        s.table.tipUnheard = false
        s.table.welcome = nil
    }

    // MARK: - The tutorial (State/Table/Tutorial.swift)

    /// A rule tip: a dim private row (each tip once a game), and up over the table while at it
    /// (the welcome in its own slot, with no row: its card only); on the game-end screen, at the
    /// draw or without a table, the row only. One tip card at a time: a rule tip that comes while the welcome is up waits
    /// behind it (GameState.tutorialTip), and VoiceOver hears it only when it shows.
    static func tutorialTip(_ s: inout TableState, _ h: AssistHint, _ fx: inout [TableEffect]) {
        let key = TutorialRules.seenKey(h)
        let fresh = !s.table.tipsSeen.contains(key)
        let atTable: Bool
        switch s.table.phase.kind {
        case .none, .waiting, .draw, .ended: atTable = false
        default: atTable = true
        }
        // only a seat holder sees it over the table (a bot playing my seat: the row only)
        let overTable = atTable && s.table.viewer.role == .seat
        let welcomeCard = overTable && TutorialRules.isWelcome(h) && !h.actions.isEmpty
        if fresh {
            s.table.tipsSeen.insert(key)
            // The welcome shown as its card leaves no row (owner 2026-11-20: its card and a
            // matching row under "<name> turned on the tutorial." read as the start message twice)
            if !welcomeCard { addPrivateLog(&s, TutorialRules.logLine(h, note: tutorialNote(&s))) }
        }
        guard overTable else { return }
        if welcomeCard {
            s.table.welcome = h
            if fresh { fx.append(.announce(TutorialRules.announcement(h))) }
            return
        }
        s.table.tip = h
        // behind the welcome: heard when it shows (tipShows)
        s.table.tipUnheard = fresh && s.table.welcome != nil
        if fresh && s.table.welcome == nil { fx.append(.announce(TutorialRules.announcement(h))) }
    }

    /// The welcome went (Keep, ×): the rule tip behind it shows now, and VoiceOver hears it if
    /// it has not.
    static func welcomeGone(_ s: inout TableState, _ fx: inout [TableEffect]) {
        s.table.welcome = nil
        if s.table.tipUnheard, let tip = s.table.tip { fx.append(.announce(TutorialRules.announcement(tip))) }
        s.table.tipUnheard = false
    }

    /// The welcome not shown as a card (the vertical bar's switch says the tutorial is on and
    /// turns it off): its row in the log, once a game (a rejoin's welcome comes again), then as
    /// Keep's local side.
    static func welcomeHidden(_ s: inout TableState, _ fx: inout [TableEffect]) {
        guard let w = s.table.welcome else { return }
        let key = TutorialRules.seenKey(w) + "#row"
        if !s.table.tipsSeen.contains(key) {
            s.table.tipsSeen.insert(key)
            var row = w
            row.reasons = [TutorialRules.hiddenWelcomeText]
            addPrivateLog(&s, TutorialRules.logLine(row, note: tutorialNote(&s)))
        }
        welcomeGone(&s, &fx)
    }

    /// My own bid or card (or a bot taking my seat): the rule tip about it is done (the welcome stays).
    static func clearTip(_ s: inout TableState) {
        s.table.tip = nil
        s.table.tipUnheard = false
    }

    /// assistState: my seat's tutorial and /help uses. Off: its tips, its welcome and its advice go.
    static func assistState(_ s: inout TableState, _ p: WirePayload.AssistState, _ fx: inout [TableEffect]) {
        if let uses = p.uses {
            s.table.assistUses = AssistUses(uses: max(0, uses), freeUses: max(0, p.freeUses ?? AssistRules.defaultFreeUses),
                                            assisted: p.assisted == true, unlimited: p.unlimited == true, told: true)
        }
        let on = p.tutorial == true
        s.table.tutorial = TutorialStatus(on: on, auto: on && p.auto == true)
        s.table.tutorialOffSent = false
        if !on { endTutorial(&s) }
    }

    /// The tutorial is off: what it put up goes (a /help answer stays).
    static func endTutorial(_ s: inout TableState) {
        s.table.tip = nil
        s.table.tipUnheard = false
        s.table.welcome = nil
        if s.table.assist?.isTutorial == true && s.table.assist?.kind != .status { s.table.assist = nil }
        if s.table.parkedAssist?.isTutorial == true { s.table.parkedAssist = nil }
    }

    /// A row only this device shows (never sent or stored), dim in the suggestion's gold.
    /// For a tutorial row about to be written: is it the log's first (it alone ends "(only you
    /// see this)"; /help's rows always do)? Marks the log.
    static func tutorialNote(_ s: inout TableState) -> Bool {
        defer { s.log.tutorialNoted = true }
        return !s.log.tutorialNoted
    }

    static func addPrivateLog(_ s: inout TableState, _ message: String) {
        var m = ChatMessage(username: "System", message: message, type: .system)
        m.isPrivate = true
        s.log.entries.append(m)
    }
}
