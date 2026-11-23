import Foundation

/// The avatar badges (owner 2026-11-23, "a little light bulb indicator on the player avatar when
/// they use help ... Would be nice for people that don't look at the running log" and "Same for
/// grad cap"; server and wire: docs/claude/assist.md "Avatar badges"): one small badge on a seat's
/// avatar, never on my own seat (the render model draws only the other seats' avatars; a pure
/// spectator's four), drawn by SeatBadgeNode where TableLayout+Badges.swift puts it; a watcher's
/// watched seat (the bottom hand, no avatar on the felt) has its on the watching pill's avatar
/// (WatchingPill, SeatBadgeChip).
///
/// - The lightbulb (`SeatState.askedHelp`): set by the live /help room notice (gameLogEntry
///   `help {position}`, the one the log draws gold), with one short pop
///   (`TableAnimation.helpBadge`); gone at that seat's bid or card, an updateTurn to another
///   seat, doneBidding, handComplete, a new deal (gameStart, destroyHands), gameEnd, and that
///   seat going lazy, being replaced or coming back (playerLazyMode / playerResigned /
///   playerActiveMode); abortGame, leaving and a new game start the table afresh.
/// - The graduation cap (`SeatState.tutorial`): the live tutorial tag (gameLogEntry `tutorial
///   {position, on}`). The server stores the tag on the line too (the log draws it in the cap's
///   colour, `ChatMessage.isTutorial`), but a replayed one (the snapshot's log) never toggles
///   the cap: the snapshot's seats[] says. It stays while the seat is lazy (the owner's tutorial stays on, as the
///   server's snapshot says).
/// - A snapshot sets both from `seats[].askedHelp` / `seats[].tutorial` (present only when true:
///   a full snapshot without the key is off), with no pop; one with no seats yet keeps ours.
/// - A seat whose owner changes (positionUpdate seats another user) loses both.
/// - Both known (a tutorial's /help is never counted, so in practice never): the cap.
enum SeatBadge: String, Equatable {
    case bulb, cap

    /// What a seat's avatar shows (the cap wins).
    static func of(_ seat: SeatState?) -> SeatBadge? {
        guard let seat else { return nil }
        if seat.tutorial { return .cap }
        return seat.askedHelp ? .bulb : nil
    }

    /// Its SF Symbol (SeatBadgeNode, SeatBadgeChip).
    var symbol: String { self == .bulb ? "lightbulb.fill" : "graduationcap.fill" }

    /// The watching pill's accessibilityValue part, as its "Talking" / "Their turn".
    var spokenValue: String { self == .bulb ? "Asked for help this turn" : "Tutorial on" }

    /// What VoiceOver adds to the seat's name element ("kim, asked for help this turn").
    var spokenSuffix: String {
        switch self {
        case .bulb: return ", asked for help this turn"
        case .cap: return ", tutorial on"
        }
    }
}

extension TableReducer {
    /// The live /help room notice for `pos`: its lightbulb, popping when it was not up.
    static func helpNotice(_ s: inout TableState, position pos: Int, _ fx: inout [TableEffect]) {
        guard let seat = s.players.seats[pos], !seat.askedHelp else { return }
        s.players.seats[pos]?.askedHelp = true
        fx.append(.animate(.helpBadge(position: pos)))
    }

    /// The live tutorial tag: `pos`'s cap on or off; turning it on pops it once, as the web does
    /// (the same `TableAnimation.helpBadge`, which pops whatever badge the seat shows).
    static func tutorialTag(_ s: inout TableState, position pos: Int, on: Bool, _ fx: inout [TableEffect]) {
        guard let seat = s.players.seats[pos] else { return }
        s.players.seats[pos]?.tutorial = on
        if on && !seat.tutorial { fx.append(.animate(.helpBadge(position: pos))) }
    }

    /// Every lightbulb but `keep`'s goes (nil: all of them).
    static func clearHelpBadges(_ s: inout TableState, keeping keep: Int? = nil) {
        for pos in s.players.seats.keys where pos != keep && s.players.seats[pos]?.askedHelp == true {
            s.players.seats[pos]?.askedHelp = false
        }
    }

    /// `pos`'s lightbulb goes (its bid, its card, a bot taking or leaving the seat).
    static func clearHelpBadge(_ s: inout TableState, at pos: Int) {
        if s.players.seats[pos]?.askedHelp == true { s.players.seats[pos]?.askedHelp = false }
    }
}
