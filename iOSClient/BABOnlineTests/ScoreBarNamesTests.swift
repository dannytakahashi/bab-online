import XCTest
import SwiftUI
@testable import BAB_Online

/// The score bar names the players (owner 2026-11-17): a seated player's sides read
/// "me/partner" and "opp1/opp2", as the web's score header, never "Your Team" / "Opponents";
/// a side whose names are not known yet is empty (the line keeps its height); a spectator's
/// sides are seats 1/3 and 2/4 by name (no longer the initials "a & c"). Each team's bore
/// level ("B", "2B") sits by its own score, not "T1: B | T2: 2B" in the centre. Long names
/// stay on one line inside the 84 pt cap.
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

    func testVoiceOverReadsTheNamesNeverTheSide() {
        typealias N = ScoreBarView.SideNames
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel(N(first: "ann", second: "cat")), "ann and cat")
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel(N(first: "bob", second: "dan")), "bob and dan")
        // nothing while not known (never "Your team" / "Opponents")
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel(nil), "")
    }

    /// A spectator's sides: seats 1/3 on the left, 2/4 on the right, full names as the web's
    /// spectator header ("ann/cat", "bob/dan"), whatever position the store holds; a side
    /// missing a name is empty.
    func testASpectatorSeesBothTeamsByName() {
        for pos in [nil, 1, 2, 3, 4] as [Int?] {
            let t = ScoreBarView.viewerTeams(position: pos, spectator: true, usernames: seated)
            XCTAssertEqual(t.team, ScoreBarView.SideNames(first: "ann", second: "cat"), "\(String(describing: pos))")
            XCTAssertEqual(t.opp, ScoreBarView.SideNames(first: "bob", second: "dan"), "\(String(describing: pos))")
            XCTAssertEqual(t.team?.joined, "ann/cat")
            XCTAssertEqual(t.opp?.joined, "bob/dan")
        }
        let partial = ScoreBarView.viewerTeams(position: nil, spectator: true, usernames: [1: "ann", 2: "bob", 4: "dan"])
        XCTAssertNil(partial.team)
        XCTAssertEqual(partial.opp?.joined, "bob/dan")
        // a seat is unchanged: "me/partner"
        XCTAssertEqual(ScoreBarView.viewerTeams(position: 2, spectator: false, usernames: seated).team?.joined, "bob/dan")
    }

    /// Each team's multiplier is its bore level by its own side: the viewer's team on the left
    /// (team 1, seats 1 and 3, for a spectator); VoiceOver says whose it is by name.
    func testEachTeamsBoreLevelSitsOnItsOwnSide() {
        XCTAssertNil(ScoreBarView.boreLevel(1))
        XCTAssertEqual([2, 4, 8, 16].compactMap(ScoreBarView.boreLevel), ["B", "2B", "3B", "4B"])
        XCTAssertNil(ScoreBarView.boreLevel(3))
        XCTAssertTrue(ScoreBarView.sideMults(team1: 1, team2: 2, myTeam: 1) == (1, 2))
        XCTAssertTrue(ScoreBarView.sideMults(team1: 1, team2: 2, myTeam: 2) == (2, 1))
        XCTAssertTrue(ScoreBarView.sideMults(team1: 4, team2: 1, myTeam: 2) == (1, 4))
        typealias N = ScoreBarView.SideNames
        XCTAssertEqual(ScoreBarView.multiplierAccessibilityLabel("B", names: N(first: "ann", second: "cat")),
                       "ann and cat, bore B")
        XCTAssertEqual(ScoreBarView.multiplierAccessibilityLabel("2B", names: N(first: "bob", second: "dan")),
                       "bob and dan, bore 2B")
        // names not known: just the level, for a seat and a spectator alike (no "Seats 1 and 3")
        XCTAssertEqual(ScoreBarView.multiplierAccessibilityLabel("B", names: nil), "bore B")
        for label in [ScoreBarView.multiplierAccessibilityLabel("4B", names: nil),
                      ScoreBarView.multiplierAccessibilityLabel("4B", names: N(first: "", second: ""))] {
            XCTAssertFalse(label.contains("T1") || label.contains("T2") || label.contains("Team") || label.contains("Opponents") || label.contains("Seats"), label)
        }
    }

    /// A "/" inside a username (an account older than the sign-up rules may have one) is read
    /// as part of that name, in either seat: the label comes from the two names, never from
    /// splitting the shown "a/b/c" (which read the first player's "a/b" as "a and b/c").
    func testVoiceOverKeepsASlashInsideEitherName() {
        let first = ScoreBarView.seatTeams(position: 1, usernames: [1: "a/b", 2: "x", 3: "c", 4: "y"])
        XCTAssertEqual(first.team?.joined, "a/b/c")
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel(first.team), "a/b and c")
        let second = ScoreBarView.seatTeams(position: 1, usernames: [1: "a", 2: "x", 3: "b/c", 4: "y"])
        XCTAssertEqual(second.team?.joined, "a/b/c")
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel(second.team), "a and b/c")
        let opp = ScoreBarView.seatTeams(position: 1, usernames: [1: "a", 2: "x/1", 3: "c", 4: "y"])
        XCTAssertEqual(ScoreBarView.namesAccessibilityLabel(opp.opp), "x/1 and y")
    }

    /// The fitting with a fake font (one point a character): the pair whole when it fits at up
    /// to 0.75, else each name cut at its end so both show with the "/" between them.
    func testFittedNamesKeepTheSeparatorAndBothNames() {
        typealias N = ScoreBarView.SideNames
        let chars: (String) -> CGFloat = { CGFloat($0.count) }
        // fits at full size, or shrunk to 0.75 (11 characters in 10 pt: 11 <= 10 / 0.75 - 2)
        XCTAssertEqual(ScoreBarView.fittedNames(N(first: "ann", second: "cat"), width: 20, measure: chars), "ann/cat")
        XCTAssertEqual(ScoreBarView.fittedNames(N(first: "annabel", second: "cat"), width: 10, measure: chars), "annabel/cat")
        // two long names: half each, both cut at the end, the "/" kept
        let two = ScoreBarView.fittedNames(N(first: "Bartholomew_Longname", second: "Christopherson_Ivory"), width: 18, measure: chars)
        XCTAssertEqual(two, "Bartholom…/Christoph…")
        // a short name keeps all of it; the long one gets the rest
        let one = ScoreBarView.fittedNames(N(first: "ann", second: "Christopherson_Ivory"), width: 18, measure: chars)
        XCTAssertEqual(one, "ann/Christopherson_Iv…")
        XCTAssertEqual(ScoreBarView.fittedNames(N(first: "Christopherson_Ivory", second: "ann"), width: 18, measure: chars), "Christopherson_Iv…/ann")
        // never cut to nothing, and no space before the "…" (a bot's "🤖 Maximilian")
        XCTAssertEqual(ScoreBarView.fittedNames(N(first: "Bartholomew", second: "Christopher"), width: 3, measure: chars), "B…/C…")
        XCTAssertEqual(ScoreBarView.cut("🤖 Maximilian", to: 3, measure: chars), "🤖…")
    }

    /// The real caption2 at the side's width on a 320 / 375 pt phone, the Duo and an iPad, at
    /// every type size the bar allows: two 20-character names (and bots') show the start of
    /// both names with the "/" between them, inside the line at 0.75. (Middle truncation of
    /// the joined text showed "Bartholomew_…pherson_Ivory": the "/" went first.)
    func testLongNamesShowBothStartsAndTheSlashOnAPhone() {
        typealias N = ScoreBarView.SideNames
        let pairs = [
            N(first: "Bartholomew_Longname", second: "Christopherson_Ivory"),
            N(first: "🤖 Maximilian", second: "🤖 Christopher"),
            N(first: "WWWWWWWWWWWWWWWWWWWW", second: "MWMWMWMWMWMWMWMWMWMW"),
            N(first: "ann", second: "Alexandria_Featherly"),
        ]
        for screen in [CGFloat(320), 375, 466, 744] {
            // a side's column: the bar less its padding (12 a side) and the 100 pt centre, halved
            let width = (screen - 24 - 100) / 2
            for type in [DynamicTypeSize.xSmall, .large, .xLarge] {
                let measure = ScoreBarView.captionWidth(type)
                for pair in pairs {
                    let shown = ScoreBarView.fittedNames(pair, width: width, measure: measure)
                    let parts = shown.components(separatedBy: "/")
                    XCTAssertEqual(parts.count, 2, "\(screen) \(type): \(shown)")
                    XCTAssertTrue(pair.first.hasPrefix(parts[0].replacingOccurrences(of: "…", with: "")), "\(screen) \(type): \(shown)")
                    XCTAssertTrue(pair.second.hasPrefix(parts[1].replacingOccurrences(of: "…", with: "")), "\(screen) \(type): \(shown)")
                    XCTAssertGreaterThanOrEqual(parts[0].count, 2, "\(screen) \(type): \(shown)")
                    XCTAssertGreaterThanOrEqual(parts[1].count, 2, "\(screen) \(type): \(shown)")
                    XCTAssertLessThanOrEqual(measure(shown) * ScoreBarView.namesMinScale, width, "\(screen) \(type): \(shown)")
                }
            }
        }
        // the reviewer's 375 pt case, at the default size: both names' starts
        let shown = ScoreBarView.fittedNames(pairs[0], width: (375 - 124) / 2, measure: ScoreBarView.captionWidth(.large))
        XCTAssertTrue(shown.hasPrefix("Bartholomew"), shown)
        XCTAssertTrue(shown.contains("/Christ"), shown)
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

    /// The bore levels by the scores never change the bar's size: bidding-mid (seat 4's own
    /// team on B) with no bore, with its B, and with both teams on 4B is the same height and
    /// inside the width, at every width and type size (the 84 pt cap holds with them).
    func testBoreLevelsKeepTheBarsSize() throws {
        func mults(_ t1: Int, _ t2: Int) throws -> ReplayHarness {
            let h = ReplayHarness()
            let snap = try T.snapshot("bidding-mid") { raw in
                guard var bids = raw["bids"] as? [String: Any] else { return }
                bids["mults"] = ["team1": t1, "team2": t2]
                raw["bids"] = bids
                if t1 == 1 && t2 == 1 { bids["byPosition"] = [NSNull(), "1", "1", NSNull()]; raw["bids"] = bids }
            }
            h.store.apply(.snapshot(snap, .rejoin, hints: nil))
            return h
        }
        let none = try mults(1, 1), one = try mults(1, 2), both = try mults(16, 16)
        XCTAssertEqual(one.store.team2Mult, 2)
        XCTAssertEqual(both.store.team1Mult, 16)
        for width in [CGFloat(320), 375, 466, 744, 1032] {
            for type in [DynamicTypeSize.large, .xLarge, .xxxLarge, .accessibility5] {
                let a = fit(ScoreBarView().environmentObject(none.store).environment(\.dynamicTypeSize, type), width: width)
                for h in [one, both] {
                    let b = fit(ScoreBarView().environmentObject(h.store).environment(\.dynamicTypeSize, type), width: width)
                    XCTAssertEqual(b.height, a.height, accuracy: 0.5, "\(width) \(type)")
                    XCTAssertLessThanOrEqual(b.height, 84, "\(width) \(type)")
                    XCTAssertLessThanOrEqual(b.width, width + 0.5, "\(width) \(type)")
                }
            }
        }
    }

    /// A bored team's level is never cut, even where its score is long and the column narrow:
    /// a 320 pt bar at xLarge (the bar's cap) gives each side (320 - 2 x 12 - 100) / 2 = 98 pt,
    /// and a 2B-4B team on 13 cards reaches four-digit negative scores. Without room for the
    /// centring copy, the line is the score and its level side by side at their full widths;
    /// with room, the copy is there and the score is centred.
    func testABoreLevelIsNeverCutInANarrowColumn() {
        let column = (320 - 2 * Theme.Space.s3 - 100) / 2
        let big = CGFloat(10_000)
        for type in [DynamicTypeSize.large, .xLarge] {
            for (score, level) in [(-2080, "4B"), (-1250, "2B"), (-2080, "3B"), (-1250, "B"), (-40, "B")] {
                let scoreW = fit(Text("\(score)").font(.title3.bold()).environment(\.dynamicTypeSize, type), width: big).width
                let levelW = fit(Text(level).font(.caption2.bold()).environment(\.dynamicTypeSize, type), width: big).width
                let line = ScoreBarView.BoreScoreLine(score: score, color: .primary, level: level)
                    .environment(\.dynamicTypeSize, type)
                let got = fit(line, width: column).width
                let centred = scoreW + 2 * levelW + 2 * Theme.Space.s1
                let whole = centred <= column + 0.5 ? centred : scoreW + levelW + Theme.Space.s1
                XCTAssertEqual(got, whole, accuracy: 0.5, "\(score) \(level) \(type): the level was cut")
                XCTAssertLessThanOrEqual(got, column + 0.5, "\(score) \(level) \(type)")
                XCTAssertEqual(fit(line, width: 300).width, centred, accuracy: 0.5, "\(score) \(level) \(type): not centred with room")
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
