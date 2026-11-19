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
        s.table.assistAsking = false
        // a pure spectator's reply ("players only") says nothing about my uses
        if s.table.viewer.role != .spectator {
            s.table.assistUses = AssistUses(uses: wire.uses, freeUses: wire.freeUses, assisted: wire.assisted, unlimited: wire.unlimited)
        }
        // a game with a native bot seat: no count, no note, never bot-assisted (the card's
        // footer and VoiceOver), whether the hint or the table's seats say so
        let h = AssistRules.inFreeHelpGame(wire, s)
        switch s.table.phase.kind {
        case .ended:
            if h.kind == .status { addPrivateLog(&s, AssistRules.logLine(h)) }
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
    static func showAssist(_ s: inout TableState, _ h: AssistHint, _ fx: inout [TableEffect]) {
        addPrivateLog(&s, AssistRules.logLine(h))
        s.table.assist = h
        fx.append(.announce(AssistRules.announcement(h)))
    }

    /// A held (not yet live) answer is given up: its row says the turn had passed.
    static func abandonParked(_ s: inout TableState) {
        guard s.table.parkedAssist != nil else { return }
        s.table.parkedAssist = nil
        addPrivateLog(&s, AssistRules.lateLine)
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
    }

    /// A row only this device shows (never sent or stored), dim in the suggestion's gold.
    static func addPrivateLog(_ s: inout TableState, _ message: String) {
        var m = ChatMessage(username: "System", message: message, type: .system)
        m.isPrivate = true
        s.log.entries.append(m)
    }
}
