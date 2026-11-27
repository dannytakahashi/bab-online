import XCTest
@testable import BAB_Online

/// The main room's controls (owner 2026-11-26): New Game's three described choices (Tournament
/// folded in from the trophy), and the header / Duo bar's two actions, New Game and the trophy,
/// which opens the leaderboard and records (no Stats icon).
final class MainRoomControlsTests: XCTestCase {
    static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    func testNewGameOffersEveryWayToStart() {
        XCTAssertEqual(NewGameChoice.allCases, [.classic, .gyb, .tournament])
        XCTAssertEqual(NewGameChoice.allCases.map(\.title), ["Back Alley Bridge", "Get Your Bid", "Tournament"])
        XCTAssertEqual(NewGameChoice.allCases.map(\.identifier), ["newGame.classic", "newGame.gyb", "newGame.tournament"])
        XCTAssertEqual(NewGameChoice.tournament.blurb, "Several rounds, a new partner each round. The top score wins.")
        XCTAssertEqual(NewGameChoice.classic.blurb, GybRules.classicBlurb)
        XCTAssertEqual(NewGameChoice.gyb.blurb, GybRules.blurb)
        // what each sends: a lobby of its mode, or (Tournament) createTournament
        XCTAssertEqual(NewGameChoice.classic.lobbyMode, .classic)
        XCTAssertEqual(NewGameChoice.gyb.lobbyMode, .gyb)
        XCTAssertNil(NewGameChoice.tournament.lobbyMode)
        for choice in NewGameChoice.allCases { XCTAssertFalse(choice.blurb.isEmpty, "a menu that informs: \(choice)") }
    }

    /// The same words as the web's New Game dialog (client/src/ui/screens/MainRoom.js).
    func testTheTournamentChoiceSaysWhatTheWebSays() throws {
        let js = try String(contentsOf: Self.root.appendingPathComponent("client/src/ui/screens/MainRoom.js"), encoding: .utf8)
        func constant(_ name: String) throws -> String {
            let line = try XCTUnwrap(js.components(separatedBy: "\n").first { $0.contains("export const \(name) =") }, name)
            let parts = line.components(separatedBy: "'")
            XCTAssertGreaterThanOrEqual(parts.count, 3, line)
            return parts[1]
        }
        XCTAssertEqual(try constant("TOURNAMENT_NAME"), NewGameChoice.tournamentName)
        XCTAssertEqual(try constant("TOURNAMENT_BLURB"), NewGameChoice.tournamentBlurb)
    }

    func testTheHeaderHasNewGameAndTheTrophyOnly() {
        typealias C = MainRoomControls
        XCTAssertEqual(C.items, [.newGame, .leaderboard])
        XCTAssertEqual(C.items.map(C.title), ["New Game", "Leaderboard"])
        XCTAssertEqual(C.items.map(C.icon), ["suit.spade.fill", "trophy.fill"])
        XCTAssertFalse(C.items.map(C.icon).contains { $0.hasPrefix("chart.bar") }, "the Stats icon is gone")
        XCTAssertFalse(C.items.map(C.title).contains("Stats"))
        XCTAssertFalse(C.items.map(C.title).contains("Tournament"), "a tournament is New Game's choice now")
        XCTAssertEqual(C.identifier(.leaderboard), "mainRoom.leaderboard")
        XCTAssertNil(C.identifier(.newGame))
        XCTAssertEqual(C.hint(.newGame), "Choose which game to start")
        XCTAssertEqual(C.hint(.leaderboard), "Shows the leaderboard and records")
        // the trophy in the text colour with the bottom pill's icons (owner 2026-11-27), New Game
        // the brand's green; gold stays the tournaments'
        XCTAssertEqual(C.tint(.newGame), .primary)
        XCTAssertEqual(C.tint(.leaderboard), .plain)
        // New Game sends, so it waits for the session; the trophy opens a sheet (MainRoomView's
        // header and bar build both from `items` and gate each with this)
        XCTAssertTrue(C.waitsForSession(.newGame))
        XCTAssertFalse(C.waitsForSession(.leaderboard))
    }

    /// The vertical bar's pills (owner 2026-11-27): New Game alone on top, the trophy with the
    /// things you look at or manage below.
    func testNewGameHasTheTopPillAndTheTrophyTheBottom() {
        typealias C = MainRoomControls
        XCTAssertEqual(C.barItems(.play), [.newGame])
        XCTAssertEqual(C.barItems(.browse), [.leaderboard])
        XCTAssertEqual(Set(C.barItems(.play) + C.barItems(.browse)), Set(C.items), "every control is in one pill")
    }
}
