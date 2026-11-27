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

    /// A control's colour: New Game the brand's, the trophy gold (Theme.warning), as it always was
    /// (owner 2026-11-27: "It was gold before which was nice"; #438's review had made it the plain
    /// text colour, since the tournaments' section and rows below are the same gold).
    enum Tint: Equatable { case primary, gold }

    static func tint(_ item: Item) -> Tint {
        switch item {
        case .newGame: return .primary
        case .leaderboard: return .gold
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
