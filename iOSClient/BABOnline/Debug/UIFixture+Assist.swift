#if DEBUG
import Foundation

/// /help in fixture mode (AssistCardUITests; no server): `-uiAssist YES` answers the
/// lightbulb's (or the chat's) /help 0.3 s later the way the server does with the cap `assist`
/// (a private assistHint for this turn: on my bid turn "Bid 2", on my play turn the first
/// playable card, off turn a status reply). `-uiAssistUses <n>`: the answer's count (3: the last
/// free use, with the warning in `note`; 4: the use that makes the game bot-assisted).
/// `-uiAssistShow YES`: the answer is up 1.5 s after launch, as if asked. Every /help shows in
/// "fixture.sent"; the card, the glow and the ring in the probe "table.assist".
extension UIFixture {
    static let assistMode: Bool = isActive && (UserDefaults.standard.bool(forKey: "uiAssist") || assistShow)
    static let assistShow: Bool = isActive && UserDefaults.standard.bool(forKey: "uiAssistShow")
    static let assistUses: Int = max(1, UserDefaults.standard.integer(forKey: "uiAssistUses"))

    /// The table store the answers go to (set by `seedAssist`).
    @MainActor private static weak var assistStore: GameState?

    /// The server's warning on the last free use (assistHandlers.js COPY.warning).
    static let assistWarning = "That's your 3rd free /help. The next one makes this game count as bot-assisted for you: it goes in your bot-game stats, not the human leaderboard."

    @MainActor
    static func seedAssist(_ store: GameState, auth: AuthState) {
        guard assistMode else { return }
        assistStore = store
        auth.isAuthenticated = true  // the toast layer (a status reply while a suggestion is up)
        if assistShow {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { MainActor.assumeIsolated { answerHelp() } }
        }
    }

    static func answerHelpLater() {
        guard assistMode else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { MainActor.assumeIsolated { answerHelp() } }
    }

    /// The private answer for the table as it is now.
    @MainActor
    static func answerHelp() {
        guard let store = assistStore else { return }
        _ = store.apply(serverEvent: "assistHint", payload: [assistPayload(store.state)])
    }

    /// assistHint as the server builds it (assistHandlers.hintPayload) for `s`.
    static func assistPayload(_ s: TableState, uses: Int = assistUses) -> [String: Any] {
        let dealSeq = s.table.deal?.dealSeq ?? 1
        let me = s.table.viewer.position ?? 0
        var p: [String: Any] = ["v": 1, "source": "help", "uses": uses, "freeUses": 3, "assisted": uses > 3, "counted": true]
        if uses == 3 { p["note"] = assistWarning }
        if uses == 4 { p["note"] = "This game now counts as bot-assisted for you." }
        let partner = s.players.name(Positions.team(max(me, 1)))
        let hand = TableRenderModel(s).hand
        let playable = hand?.cards.first { hand?.legalIds.contains($0.id) == true }
        switch (s.myTurn, playable) {
        case (.choosing(.bid), _):
            let bids = s.table.phase.bids?.byPosition.compactMap { $0 }.count ?? 0
            p["kind"] = "bid"
            p["turnKey"] = "\(dealSeq)|BIDDING|\(me)|\(bids)|0"
            p["headline"] = "Bid 2"
            p["reasons"] = ["Your hand should take about 2 tricks.", "\(partner) (your partner) has not bid yet, so 2 keeps the pair safe."]
            p["details"] = ["Your aces: about 1.6 tricks.", "Trump length: about 0.4 tricks."]
            p["confidence"] = "clear"
            p["suggest"] = ["bid": "2"]
        case (.choosing(.play), let card?):
            let index = AssistRules.cardIndex(s) ?? 0
            p["kind"] = "card"
            p["turnKey"] = "\(dealSeq)|PLAYING|\(me)|4|\(index)"
            p["headline"] = "Play \(card.displayName)"
            p["reasons"] = ["Follow suit low: \(partner) (your partner) is winning the trick."]
            p["details"] = ["Keep your high cards for later tricks."]
            p["confidence"] = "close"
            p["suggest"] = ["card": ["suit": card.suit.rawValue, "rank": card.rank.rawValue]]
        default:
            p["kind"] = "status"
            p["turnKey"] = "\(dealSeq)|\(s.table.phase.kind == .playing ? "PLAYING" : "BIDDING")|\(s.table.phase.turn ?? 0)|0|0"
            p["headline"] = "Not your turn yet."
            p["reasons"] = [String]()
            p["counted"] = false
            p.removeValue(forKey: "note")
        }
        return p
    }
}
#endif
