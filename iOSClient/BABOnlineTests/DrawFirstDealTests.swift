import XCTest
@testable import BAB_Online

/// A tournament table's draw for first deal (owner 2026-11-25; iOS 1.2.7 (41)): startDraw.teams
/// and snapshot draw.teams (lenient: malformed is a casual draw, never a failure), the reducer's
/// `DrawState.plannedTeams`, DrawCopy against the web's client/src/ui/drawCopy.js, the teams
/// line's fitting, and the contract's recorded pairings events (contract/fixtures/pairings).
final class DrawFirstDealTests: XCTestCase {
    private typealias P = TableSnapshot.PlannedTeamPlayer
    private static let teams: [[P]] = [
        [P(username: "hannah", isBot: false), P(username: "danny", isBot: false)],
        [P(username: "clara", isBot: false), P(username: "🤖 Mary", isBot: true)],
    ]
    private static func wire(_ t: [[P]]) -> [[[String: Any]]] { t.map { $0.map { ["username": $0.username, "isBot": $0.isBot] } } }

    private static var root: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    // MARK: - Wire

    func testStartDrawDecodesTheTeamsLenientlyAndAPlainOneAsBefore() throws {
        func decode(_ data: [String: Any]) -> WirePayload.StartDraw? {
            guard case .success(let e) = ServerEvent.decode(name: "startDraw", payload: [data], strict: true),
                  case .startDraw(let p) = e.event else { return nil }
            return p
        }
        XCTAssertEqual(decode(["start": true])?.teams, nil, "a casual table's startDraw (every recording)")
        XCTAssertEqual(decode(["start": true, "teams": Self.wire(Self.teams), "seq": 1])?.teams, Self.teams)
        // malformed: dropped, the event still decodes
        let bad: [Any] = [
            [Self.wire(Self.teams)[0]],                                          // one team
            [[["username": "a", "isBot": false]], Self.wire(Self.teams)[1]],     // a team of one
            [[["username": "", "isBot": false], ["username": "b", "isBot": false]], Self.wire(Self.teams)[1]],
            [[["username": 3, "isBot": false], ["username": "b", "isBot": false]], Self.wire(Self.teams)[1]],
            [[["username": "a"], ["username": "b", "isBot": false]], Self.wire(Self.teams)[1]],  // isBot missing
            "teams", 7, NSNull(),
        ]
        for t in bad {
            let p = decode(["start": true, "teams": t])
            XCTAssertNotNil(p, "\(t) failed the whole event")
            XCTAssertNil(p?.teams, "\(t) was kept")
        }
        // a startDraw with no payload at all still opens the draw
        if case .success(let e) = ServerEvent.decode(name: "startDraw", payload: []), case .startDraw(let p) = e.event {
            XCTAssertNil(p.teams)
        } else {
            XCTFail("an empty startDraw")
        }
    }

    // MARK: - Reducer

    func testTheReducerKeepsThePlannedTeamsThroughTheDraw() {
        var s = TableState()
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g", tournamentId: "t")))
        TableReducer.reduce(&s, T.ev("startDraw", ["start": true, "teams": Self.wire(Self.teams)]))
        XCTAssertEqual(s.table.phase.draw?.plannedTeams, Self.teams)
        TableReducer.reduce(&s, T.ev("playerDrew", ["username": "hannah", "card": T.card("spades", "2"), "drawOrder": 1, "seq": 1]))
        TableReducer.reduce(&s, T.ev("teamsAnnounced", ["team1": ["hannah", "danny"], "team2": ["clara", "🤖 Mary"], "seq": 2]))
        XCTAssertEqual(s.table.phase.draw?.plannedTeams, Self.teams, "kept to the teams' panel")
        // the next casual startDraw (a new game) has none
        TableReducer.reduce(&s, T.ev("startDraw", ["start": true]))
        XCTAssertNil(s.table.phase.draw?.plannedTeams)
    }

    func testASnapshotMidDrawCarriesTheTeams() throws {
        let snap = try T.snapshot("draw-in-progress") { raw in
            var draw = raw["draw"] as? [String: Any] ?? [:]
            draw["teams"] = Self.wire(Self.teams)
            raw["draw"] = draw
        }
        XCTAssertEqual(snap.draw?.teams, Self.teams)
        let s = TableReducer.state(from: snap, hints: nil, previous: nil, source: .rejoin)
        XCTAssertEqual(s.table.phase.draw?.plannedTeams, Self.teams)
        // the contract's fixture without teams: a casual draw
        let plain = try T.state(fixture: "draw-in-progress")
        XCTAssertNil(plain.table.phase.draw?.plannedTeams)
    }

    @MainActor
    func testTheContractsRecordedPairingsEventsApply() throws {
        let url = Self.root.appendingPathComponent("contract/fixtures/pairings/events.json")
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("the checkout is not reachable from this test host") }
        let file = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        for mode in ["honest", "staged"] {
            let events = try XCTUnwrap(file[mode] as? [[String: Any]], mode)
            let store = GameState()
            var sawTeams = false, sawRoundStart = false
            for e in events {
                let name = try XCTUnwrap(e["event"] as? String)
                let data = e["data"] as? [String: Any] ?? [:]
                if name == "tournamentRoundStart" {
                    // the tournament screen's pairings (a dictionary event, TournamentSocketHandler)
                    let list = try XCTUnwrap(TournamentRoundPairings.list(data["pairings"]), mode)
                    XCTAssertTrue(TournamentPairingRules.hasPairings(list), mode)
                    sawRoundStart = true
                    continue
                }
                if name == "startDraw" { store.apply(.local(.enterGameContext(gameId: "g", tournamentId: "t"))) }
                let result = store.apply(serverEvent: name, payload: [data])
                if case .failure(let err) = result { XCTFail("\(mode) \(name): \(err)") }
                if name == "startDraw" || name == "stateSnapshot" {
                    XCTAssertNotNil(store.drawPlannedTeams, "\(mode) \(name) teams")
                    XCTAssertEqual(store.drawPlannedTeams?.flatMap { $0 }.count, 4)
                    sawTeams = true
                }
            }
            XCTAssertTrue(sawTeams && sawRoundStart, mode)
        }
    }

    // MARK: - Words

    /// The words are the web's (DrawCopy mirrors client/src/ui/drawCopy.js, read here).
    func testTheWordsAreTheWebs() throws {
        let url = Self.root.appendingPathComponent("client/src/ui/drawCopy.js")
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("the checkout is not reachable from this test host") }
        let js = try String(contentsOf: url, encoding: .utf8)
        func words(_ name: String) throws -> (String, String) {
            let block = try XCTUnwrap(js.range(of: #"export const \#(name) = Object\.freeze\(\{[^}]*\}\)"#, options: .regularExpression), name)
            let text = String(js[block])
            func value(_ key: String) throws -> String {
                let r = try XCTUnwrap(text.range(of: #"\#(key): '([^']*)'"#, options: .regularExpression), "\(name).\(key)")
                return String(text[r].dropFirst(key.count + 3).dropLast())
            }
            return (try value("title"), try value("rules"))
        }
        let casual = try words("CASUAL"), planned = try words("PLANNED")
        XCTAssertEqual(DrawCopy.casual.title, casual.0)
        XCTAssertEqual(DrawCopy.casual.rules, casual.1)
        XCTAssertEqual(DrawCopy.planned.title, planned.0)
        XCTAssertEqual(DrawCopy.planned.rules, planned.1)
        XCTAssertEqual(DrawCopy.title(planned: true), "Draw for First Deal")
        XCTAssertEqual(DrawCopy.rules(planned: false), "The two highest cards are partners; the highest deals.")
    }

    /// The web's drawCopy.test.js cases.
    func testTheTeamsLineMyTeamFirstNeverANumber() {
        let t = Self.teams
        XCTAssertEqual(DrawCopy.teamsLine(t, me: "danny"), "You & hannah vs clara & 🤖 Mary")
        XCTAssertEqual(DrawCopy.teamsLine(t, me: "clara"), "You & 🤖 Mary vs hannah & danny")
        XCTAssertEqual(DrawCopy.teamsLine(t, me: nil), "hannah & danny vs clara & 🤖 Mary")
        XCTAssertEqual(DrawCopy.teamsLine(t, me: "🤖 Mary"), "hannah & danny vs clara & 🤖 Mary", "a bot is never me")
        XCTAssertEqual(DrawCopy.teamsLine(nil, me: "x"), "")
        XCTAssertEqual(DrawCopy.teamsSpoken(t, me: "danny"), "Partners: you and hannah versus clara and 🤖 Mary")
        XCTAssertEqual(DrawCopy.teamsSpoken(t, me: nil), "Partners: hannah and danny versus clara and 🤖 Mary")
        XCTAssertEqual(DrawCopy.teamsNames(t, me: "danny"), [["You", "hannah"], ["clara", "🤖 Mary"]])
        for me in [nil, "hannah", "clara"] {
            XCTAssertNil(DrawCopy.teamsLine(t, me: me).range(of: #"Team [12]|T[12]\b|Your Team|Opponents"#, options: .regularExpression))
        }
        XCTAssertNil(PlannedTeams.valid([t[0]]))
        XCTAssertEqual(PlannedTeams.valid(t), t)
    }

    /// The line shrinks, then cuts each name on its own: "&" and "vs" always show.
    func testALongLineCutsEachNameAndKeepsTheSeparators() {
        let measure = { (s: String) in CGFloat(s.count) * 8 }  // 8 pt a character
        let names = [["You", "Christopher Johnson1"], ["Alexandra Montgomery", "🤖 Mary"]]
        let whole = "You & Christopher Johnson1 vs Alexandra Montgomery & 🤖 Mary"
        XCTAssertEqual(DrawCopy.fittedLine(names, width: 1000, minScale: 0.8, measure: measure), whole)
        for width in stride(from: CGFloat(80), through: 400, by: 20) {
            let line = DrawCopy.fittedLine(names, width: width, minScale: 0.8, measure: measure)
            XCTAssertEqual(line.components(separatedBy: " & ").count, 3, "\(width): \(line)")
            XCTAssertEqual(line.components(separatedBy: " vs ").count, 2, "\(width): \(line)")
            XCTAssertTrue(line.hasPrefix("Y"), "\(width): \(line)")
            if width >= 300 {
                XCTAssertLessThanOrEqual(measure(line), width / 0.8, "\(width): \(line)")
                XCTAssertTrue(line.hasPrefix("You & "), "a short name keeps all of it: \(line)")
            }
        }
        // one long name: only that one is cut
        let one = DrawCopy.fittedLine([["You", "ann"], ["Christopher Johnson1", "bob"]], width: 300, minScale: 1, measure: measure)
        XCTAssertTrue(one.hasPrefix("You & ann vs Chr"), one)
        XCTAssertTrue(one.hasSuffix("… & bob"), one)
    }
}
