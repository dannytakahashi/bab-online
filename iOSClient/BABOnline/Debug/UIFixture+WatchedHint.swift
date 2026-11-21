#if DEBUG
import Foundation

/// The over-the-shoulder view's mirrored hint cards in fixture mode (WatchedHintUITests; no
/// server; docs/claude/spectators.md "Over-the-shoulder view"): `-uiWatchedHint <name>` on a
/// seated table fixture (`bidding-mid`, `trick-mid-lead3`) draws the column's cards as a
/// watched seat's copies, named for `<name>` (GameContainerView.watchedHintName ->
/// AssistCardView / TutorialTipView `watchedName`), and 1.5 s after launch pushes them as the
/// server mirrors them (assistHint with `watched`, tip first): this moment's rule tip
/// (UIFixture.ruleTip, without `actions`) and a /help answer whose counts are the watched
/// player's (`-uiWatchedHintUses <n>`, default 4: counted and bot-assisted, so my own card's
/// footer would say "Help 4: this game counts as bot-assisted for you"), with no `note` (the
/// server drops it from the copy). `-uiWatchedHintQuick YES`: the answer is a Quick suggestion.
/// The cards come through the table's own path (my seat, my turn) until the watch state exists;
/// their × only takes them down, so "fixture.sent" stays "-".
extension UIFixture {
    static let watchedHintName: String? = isActive ? UserDefaults.standard.string(forKey: "uiWatchedHint") : nil
    static let watchedHintUses: Int = max(1, UserDefaults.standard.object(forKey: "uiWatchedHintUses") == nil
        ? 4 : UserDefaults.standard.integer(forKey: "uiWatchedHintUses"))
    static let watchedHintQuick: Bool = UserDefaults.standard.bool(forKey: "uiWatchedHintQuick")

    @MainActor
    static func seedWatchedHint(_ store: GameState, auth: AuthState) {
        guard watchedHintName != nil else { return }
        auth.isAuthenticated = true  // the toast layer, as the other card fixtures
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { MainActor.assumeIsolated { pushWatchedHints(store) } }
    }

    /// The watched seat's tip and advice, as the server's mirror sends them.
    @MainActor
    static func pushWatchedHints(_ store: GameState) {
        let s = store.state
        let seat = max(s.table.viewer.position ?? 1, 1)
        var tip = ruleTip(s)
        tip["watched"] = seat
        tip.removeValue(forKey: "actions")
        _ = store.apply(serverEvent: "assistHint", payload: [tip])
        var advice = assistPayload(s, uses: watchedHintUses, free: false)
        advice["watched"] = seat
        advice.removeValue(forKey: "note")
        if watchedHintQuick, advice["kind"] as? String != "status" { advice["confidence"] = "quick" }
        _ = store.apply(serverEvent: "assistHint", payload: [advice])
    }
}
#endif
