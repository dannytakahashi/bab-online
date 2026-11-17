import XCTest
import SwiftUI
@testable import BAB_Online

/// The score bar names the players (owner 2026-11-17): a seated player's sides read
/// "me/partner" and "opp1/opp2", as the web's score header, never "Your Team" / "Opponents";
/// a side whose names are not known yet is empty (the line keeps its height); a spectator's
/// initials ("a & c") are unchanged. Long names stay on one line inside the 84 pt cap.
@MainActor
final class ScoreBarNamesTests: XCTestCase {
    private let seated: [Int: String] = [1: "ann", 2: "bob", 3: "cat", 4: "dan"]

    func testASeatsSidesByName() {
        XCTAssertTrue(ScoreBarView.seatTeamNames(position: 1, usernames: seated) == ("ann/cat", "bob/dan"))
        XCTAssertTrue(ScoreBarView.seatTeamNames(position: 2, usernames: seated) == ("bob/dan", "cat/ann"))
        XCTAssertTrue(ScoreBarView.seatTeamNames(position: 3, usernames: seated) == ("cat/ann", "dan/bob"))
        XCTAssertTrue(ScoreBarView.seatTeamNames(position: 4, usernames: seated) == ("dan/bob", "ann/cat"))
    }

    func testNamesNotKnownYetAreEmptyNeverAPlaceholder() {
        XCTAssertTrue(ScoreBarView.seatTeamNames(position: nil, usernames: seated) == ("", ""))
        XCTAssertTrue(ScoreBarView.seatTeamNames(position: 0, usernames: seated) == ("", ""))
        XCTAssertTrue(ScoreBarView.seatTeamNames(position: 2, usernames: [:]) == ("", ""))
        // a side missing one name is empty; the other keeps its names
        XCTAssertTrue(ScoreBarView.seatTeamNames(position: 1, usernames: [1: "ann", 2: "bob", 4: "dan"]) == ("", "bob/dan"))
        XCTAssertTrue(ScoreBarView.seatTeamNames(position: 1, usernames: [1: "ann", 2: "", 3: "cat", 4: "dan"]) == ("ann/cat", ""))
        for pos in [nil, 1, 2, 3, 4] as [Int?] {
            for names in [[:], seated, [1: "ann"]] {
                let (team, opp) = ScoreBarView.seatTeamNames(position: pos, usernames: names)
                for text in [team, opp] {
                    XCTAssertFalse(text.contains("Your Team") || text.contains("Opponents"), text)
                }
            }
        }
    }

    func testVoiceOverSaysTheSideThenTheNames() {
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel("ann/cat", side: .mine, spectator: false), "Your team, ann and cat")
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel("bob/dan", side: .theirs, spectator: false), "Opponents, bob and dan")
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel("", side: .mine, spectator: false), "Your team")
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel("", side: .theirs, spectator: false), "Opponents")
        // a name with a slash in it keeps it (only the first "/" splits the pair)
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel("a/b/c", side: .mine, spectator: false), "Your team, a and b/c")
        // a spectator's initials as shown
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel("a & c", side: .mine, spectator: true), "a & c")
    }

    /// The store's seats give the bar's names (trick-mid-lead3: ivy at seat 1, hal her partner).
    func testTheStoresSeatsGiveTheNames() throws {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        XCTAssertEqual(h.store.position, 1)
        let names = ScoreBarView.seatTeamNames(position: h.store.position, usernames: h.store.players.seats.compactMapValues(\.username))
        XCTAssertEqual(names.team, "ivy/hal")
        XCTAssertEqual(names.opp, "kim/jon")
    }

    private func fit<V: View>(_ v: V, width: CGFloat) -> CGSize {
        UIHostingController(rootView: v).sizeThatFits(in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
    }

    private func bar(_ fixture: String, names: [String]?) throws -> ReplayHarness {
        let h = ReplayHarness()
        let snap = try T.snapshot(fixture) { raw in
            guard let names, var seats = raw["seats"] as? [[String: Any]] else { return }
            for i in seats.indices { seats[i]["username"] = names[i] }
            raw["seats"] = seats
        }
        h.store.apply(.snapshot(snap, .rejoin, hints: nil))
        return h
    }

    /// Long names (the server allows 20 characters) never wrap or change the bar: it is exactly
    /// as tall as with one-letter names (so every existing cap holds: SceneLayoutTests'
    /// 84 pt, TableZoomTests' zoomTopBar), on a 320 / 375 pt phone, the Duo (466) and iPads;
    /// trick-mid-lead3 (the 84 pt cap's fixture) is checked against 84 directly.
    func testLongNamesStayOnOneLineInsideTheCap() throws {
        let long = ["Bartholomew_Longname", "Maximiliana_Wolfgang", "Christopherson_Ivory", "Alexandria_Featherly"]
        for fixture in ["trick-mid-lead3", "bidding-mid", "spectator-mid-hand"] {
            let short = try bar(fixture, names: ["a", "b", "c", "d"])
            let wide = try bar(fixture, names: long)
            for width in [CGFloat(320), 375, 466, 744, 1032] {
                for type in [DynamicTypeSize.large, .xLarge, .xxxLarge, .accessibility5] {
                    let s = fit(ScoreBarView().environmentObject(short.store).environment(\.dynamicTypeSize, type), width: width)
                    let l = fit(ScoreBarView().environmentObject(wide.store).environment(\.dynamicTypeSize, type), width: width)
                    if fixture == "trick-mid-lead3" { XCTAssertLessThanOrEqual(l.height, 84, "\(fixture) \(width) \(type)") }
                    XCTAssertEqual(l.height, s.height, accuracy: 0.5, "\(fixture) \(width) \(type): a long name changed the bar's height")
                    XCTAssertLessThanOrEqual(l.width, width + 0.5, "\(fixture) \(width) \(type)")
                }
            }
        }
    }

    /// Names not known yet: the empty side keeps the line's height (no jump when they come).
    func testAnEmptySideKeepsItsHeight() throws {
        let named = try bar("trick-mid-lead3", names: nil)
        let blank = try bar("trick-mid-lead3", names: ["ivy", "", "hal", ""])
        let mine = ScoreBarView.seatTeamNames(position: blank.store.position, usernames: blank.store.players.seats.compactMapValues(\.username))
        XCTAssertEqual(mine.team, "ivy/hal")
        XCTAssertEqual(mine.opp, "")
        for width in [CGFloat(375), 834] {
            let a = fit(ScoreBarView().environmentObject(named.store), width: width)
            let b = fit(ScoreBarView().environmentObject(blank.store), width: width)
            XCTAssertEqual(a.height, b.height, accuracy: 0.5, "\(width)")
        }
    }
}
