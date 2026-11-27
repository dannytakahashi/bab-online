import Foundation

/// New Game's choices (owner 2026-11-26: "we could fold tournament into the spade menu, then the
/// trophy could be for the leaderboard/records"): every way to start something, each its name and
/// one line of what it is, in a native Menu on the spade control (a menu because the descriptions
/// are the point: choices of one kind that need words). The web's New Game dialog has the same three
/// (client/src/ui/screens/MainRoom.js `showCreateGameDialog`, `TOURNAMENT_NAME` / `TOURNAMENT_BLURB`).
enum NewGameChoice: String, CaseIterable, Identifiable {
    /// createLobby {}
    case classic
    /// createLobby {mode: 'gyb'}
    case gyb
    /// createTournament (what the main room's trophy sent before 2026-11-26)
    case tournament

    var id: String { rawValue }

    static let tournamentName = "Tournament"
    /// The web's TOURNAMENT_BLURB, word for word.
    static let tournamentBlurb = "Several rounds, a new partner each round. The top score wins."

    var title: String {
        switch self {
        case .classic: return GybRules.classicName
        case .gyb: return GybRules.name
        case .tournament: return Self.tournamentName
        }
    }

    var blurb: String {
        switch self {
        case .classic: return GybRules.classicBlurb
        case .gyb: return GybRules.blurb
        case .tournament: return Self.tournamentBlurb
        }
    }

    /// The menu item's accessibility identifier, `newGame.<choice>`.
    var identifier: String { "newGame.\(rawValue)" }

    /// The lobby's game mode, nil for a tournament (createTournament, not createLobby).
    var lobbyMode: GameMode? {
        switch self {
        case .classic: return .classic
        case .gyb: return .gyb
        case .tournament: return nil
        }
    }
}

/// The main room's actions, in the header row and, on the open Duo, the vertical bar (owner
/// 2026-11-26): New Game (the spade menu: Back Alley Bridge, Get Your Bid, Tournament) and the
/// trophy, which opens the leaderboard and records (the Stats sheet; the bar-chart Stats icon is
/// gone, and the trophy no longer creates a tournament). One action = one icon. MainRoomView builds
/// the header row and the bar from `items`, with `tint`, `identifier` and `waitsForSession`.
enum MainRoomControls {
    enum Item: CaseIterable, Hashable { case newGame, leaderboard }

    static let items: [Item] = Item.allCases

    /// Which of the vertical bar's two pills an item sits in (owner 2026-11-27): New Game alone
    /// on top (the one thing that starts play, as the game's Exit and the lobby's Leave sit
    /// alone), and the trophy first in the bottom pill with Players, Admin and the settings (the
    /// things you look at or manage; it opens the leaderboard and records, it no longer starts
    /// a tournament). The header row (phone, iPad, the closed Duo) is one row and keeps `items`.
    enum BarPill: Equatable { case play, browse }

    static func barPill(_ item: Item) -> BarPill {
        switch item {
        case .newGame: return .play
        case .leaderboard: return .browse
        }
    }

    static func barItems(_ pill: BarPill) -> [Item] { items.filter { barPill($0) == pill } }

    /// A control's colour: New Game the brand's green, the trophy the plain text colour (owner
    /// 2026-11-27, once it moved to the bar's bottom pill: "maybe you and fable were right and
    /// the trophy should go back to white"): it sits with Players, Admin and the settings, all
    /// white, and gold stays the tournaments' colour (their section and rows right below). It
    /// was gold for a few hours that day (#444).
    enum Tint: Equatable { case primary, plain }

    static func tint(_ item: Item) -> Tint {
        switch item {
        case .newGame: return .primary
        case .leaderboard: return .plain
        }
    }

    static func title(_ item: Item) -> String {
        switch item {
        case .newGame: return "New Game"
        case .leaderboard: return "Leaderboard"
        }
    }

    static func icon(_ item: Item) -> String {
        switch item {
        case .newGame: return "suit.spade.fill"
        case .leaderboard: return "trophy.fill"
        }
    }

    static func hint(_ item: Item) -> String {
        switch item {
        case .newGame: return "Choose which game to start"
        case .leaderboard: return "Shows the leaderboard and records"
        }
    }

    /// The trophy's identifier (New Game keeps none: the UI tests find it by its label).
    static func identifier(_ item: Item) -> String? {
        switch item {
        case .newGame: return nil
        case .leaderboard: return "mainRoom.leaderboard"
        }
    }

    /// New Game sends (a lobby or a tournament), so it waits for the session; the trophy opens a
    /// sheet, which needs none (as Stats did).
    static func waitsForSession(_ item: Item) -> Bool { item == .newGame }
}
