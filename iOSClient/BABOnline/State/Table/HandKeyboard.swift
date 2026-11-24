import Foundation

/// Keyboard card play, as a pure model of the web's hand toolbar (client/src/ui/handA11y.js):
/// one focus stop with a roving index in hand order. Left / Up and Right / Down move, Home and
/// End jump, Return and Space activate exactly what a click does. A dimmed card stays
/// focusable, and activating it gives its refusal (the blocked reason's toast, the web's
/// aria-disabled). Focus is kept by card id across a re-render; when the focused card leaves
/// the hand it passes to its neighbour, the last one to the announcer (and a render that clears
/// and redraws the same hand puts it back on the card). Focus is taken on my turn only from
/// nowhere (after a navigation key) or from the table's own controls, never from chat, a text
/// field, a sheet or the voice panel. The ring shows only after a navigation key (the web's
/// NAV_KEYS modality), and a pointer press hides it.
///
/// Platform-neutral and not wired on iOS (a hardware keyboard on the iPad would be a one-line
/// flag); the macOS table drives it from its key presses.
struct HandKeyboard: Equatable {
    /// A card of my hand, in hand order.
    struct Card: Equatable {
        let id: String
        /// What a click would do: play or lift it (true), or refuse it with its reason (false).
        let playable: Bool
    }

    /// A key press the hand handles; anything else is `.other` (the voice keys, letters).
    enum Key: Equatable {
        case left, right, up, down, home, end, enter, space, tab, other
    }

    /// Where the keyboard focus is when my turn comes.
    enum FocusOwner: Equatable {
        /// Nowhere (the window itself).
        case nowhere
        /// The table's own controls: this hand, the announcer, the bid panel, the draw, the
        /// /help card or its button (the web's HANDOFF).
        case table
        /// Anything else: chat, a text field, a sheet, the voice panel, another control.
        case elsewhere
    }

    /// Where the hand's focus is.
    enum Focus: Equatable {
        case none
        case card(String)
        /// The table's announcer (after the last card went).
        case announcer
    }

    /// What a key press did.
    enum Outcome: Equatable {
        /// Not the hand's key (or no card focused): left to the next handler.
        case ignored
        /// Focus moved (or stayed at an end) within the hand.
        case moved
        /// A playable card activated: what a click on it does.
        case activate(String)
        /// A dimmed card activated: its refusal (the blocked reason).
        case refuse(String)
    }

    private(set) var cards: [Card] = []
    private(set) var focus: Focus = .none
    /// The last input was a navigation key (not a pointer press): focus may move from nowhere
    /// and the ring shows.
    private(set) var lastInputWasKeyboard = false
    /// The card a render's clear left the announcer for, for the redraw that follows at once.
    private var restoreId: String?

    /// The keys that make the last input the keyboard (the web's NAV_KEYS).
    static let navigationKeys: Set<Key> = [.tab, .enter, .space, .left, .right, .up, .down, .home, .end]

    /// The card focused, or nil.
    var focusedId: String? {
        if case .card(let id) = focus { return id }
        return nil
    }

    /// The focus ring is drawn (on the focused card, after a navigation key).
    var showsRing: Bool { focusedId != nil && lastInputWasKeyboard }

    /// The one focus stop: the focused card, else the first playable, else the first.
    var stop: String? { focusedId ?? (cards.first(where: \.playable) ?? cards.first)?.id }

    /// The hand changed (a deal, a play, its legality). `redraw`: an empty hand that a render
    /// redraws right after (its next `sync` gives the focus back to the same card).
    mutating func sync(_ newCards: [Card], redraw: Bool = false) {
        let old = cards
        cards = newCards
        let keep = Set(newCards.map(\.id))
        let pending = restoreId
        restoreId = nil
        if let id = focusedId, !keep.contains(id) {
            let index = old.firstIndex(where: { $0.id == id }) ?? 0
            if newCards.isEmpty {
                focus = .announcer
                if redraw { restoreId = id }
            } else {
                focus = .card(newCards[min(index, newCards.count - 1)].id)
            }
        } else if let back = pending, !newCards.isEmpty, focus == .announcer, keep.contains(back) {
            focus = .card(back)
        }
    }

    /// A key press while the hand has focus. `modifiers`: Command, Control or Option held (left
    /// to the menus).
    mutating func press(_ key: Key, modifiers: Bool = false) -> Outcome {
        if Self.navigationKeys.contains(key) { lastInputWasKeyboard = true }
        guard !modifiers, let id = focusedId, let i = cards.firstIndex(where: { $0.id == id }) else { return .ignored }
        let to: Int
        switch key {
        case .left, .up: to = i - 1
        case .right, .down: to = i + 1
        case .home: to = 0
        case .end: to = cards.count - 1
        case .enter, .space: return cards[i].playable ? .activate(id) : .refuse(id)
        case .tab, .other: return .ignored
        }
        focus = .card(cards[max(0, min(cards.count - 1, to))].id)
        return .moved
    }

    /// A pointer press anywhere: the ring goes, and focus no longer moves from nowhere.
    mutating func pointerDown() {
        lastInputWasKeyboard = false
    }

    /// The hand took focus (a click into it, or the stop reached by Tab): on `id`.
    mutating func focusCard(_ id: String) {
        guard cards.contains(where: { $0.id == id }) else { return }
        focus = .card(id)
    }

    /// Focus left the hand and the announcer (chat, another control).
    mutating func focusLeft() {
        focus = .none
    }

    /// My turn to play: focus my first playable card if focus is nowhere (after a navigation
    /// key) or on the table's own controls; a playable card already focused stays. True when
    /// focus moved.
    mutating func offerTurnFocus(from owner: FocusOwner) -> Bool {
        switch owner {
        case .elsewhere: return false
        case .nowhere: guard lastInputWasKeyboard else { return false }
        case .table: break
        }
        if let id = focusedId, cards.first(where: { $0.id == id })?.playable == true { return false }
        guard let target = cards.first(where: \.playable) else { return false }
        focus = .card(target.id)
        return true
    }
}
