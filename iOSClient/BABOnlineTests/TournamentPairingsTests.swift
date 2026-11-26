import XCTest
@testable import BAB_Online

/// The tournament screen's pairings (owner 2026-11-25; iOS 1.2.7 (41)): the events' `pairings`
/// (lenient), the words (the web's client/src/ui/screens/tournamentPairings.test.js cases), and
/// TournamentState / TournamentSocketHandler keeping them.
final class TournamentPairingsTests: XCTestCase {
    /// The web test's P.
    private static let raw: [Any] = [
        ["roundNumber": 1, "tables": [
            ["gameId": "g1", "teams": [["ann", "bob"], ["ed", "fay"]]],
            ["gameId": "g2", "teams": [["cat", NSNull()], ["dan", NSNull()]]],
        ]],
        ["roundNumber": 2, "tables": [
            ["gameId": "g3", "teams": [["ann", "fay"], ["bob", "cat"]]],
            ["gameId": "g4", "teams": [["ed", NSNull()], ["Maximiliana_Quintessence", NSNull()]]],
        ]],
        ["roundNumber": 3, "tables": [
            ["gameId": NSNull(), "teams": [["ann", "dan"], ["bob", "fay"]]],
        ]],
    ]
    private static var P: [TournamentRoundPairings] { TournamentRoundPairings.list(raw) ?? [] }

    func testTheWordsAreTheWebs() {
        let P = Self.P
        XCTAssertEqual(P.map(\.roundNumber), [1, 2, 3])
        let t0 = P[0].tables[0].teams
        XCTAssertEqual(TournamentPairingRules.line(t0, me: "ed"), "You & fay vs ann & bob")
        XCTAssertEqual(TournamentPairingRules.line(t0, me: "fay"), "You & ed vs ann & bob")
        XCTAssertEqual(TournamentPairingRules.line(t0, me: nil), "ann & bob vs ed & fay")
        XCTAssertEqual(TournamentPairingRules.line(P[0].tables[1].teams, me: nil), "cat & a bot vs dan & a bot")
        XCTAssertEqual(TournamentPairingRules.line([["ed", nil], [nil, nil]], me: "ed"), "You & a bot vs two bots")
        XCTAssertEqual(TournamentPairingRules.spoken(t0, me: "ed"), "you and fay versus ann and bob")
        for me in [nil, "ed", "cat"] {
            for r in P { for t in r.tables {
                XCTAssertNil(TournamentPairingRules.line(t.teams, me: me).range(of: #"Team [12]|T[12]\b|Your Team|Opponents"#, options: .regularExpression))
            } }
        }
    }

    func testPartnersSoFarANameABotOrSatOut() {
        XCTAssertEqual(TournamentPairingRules.partnersSoFar(Self.P, me: "ed"), [
            .init(roundNumber: 1, partner: "fay"), .init(roundNumber: 2, partner: "a bot"), .init(roundNumber: 3, partner: "sat out"),
        ])
        XCTAssertEqual(TournamentPairingRules.partnersSoFar(Self.P, me: "fay").map(\.partner), ["ed", "ann", "bob"])
    }

    func testLatestRoundHasPairingsAndMalformedEntriesDropped() throws {
        let latest = try XCTUnwrap(TournamentPairingRules.latestRound(Self.P, me: "bob"))
        XCTAssertEqual(latest.round.tables[0].teams, [["ann", "dan"], ["bob", "fay"]])
        XCTAssertTrue(latest.mine)
        XCTAssertEqual(TournamentPairingRules.latestRound(Array(Self.P.prefix(2)), me: "ed")?.round.tables[0].gameId, "g4", "my table first")
        XCTAssertTrue(TournamentPairingRules.hasPairings(Self.P))
        XCTAssertFalse(TournamentPairingRules.hasPairings(TournamentRoundPairings.list([
            ["roundNumber": 1, "tables": [["gameId": "g", "teams": [["ed", NSNull()], [NSNull(), NSNull()]]]]],
        ] as [Any]) ?? []))
        XCTAssertNil(TournamentRoundPairings.list(nil))
        XCTAssertNil(TournamentRoundPairings.list("x"))
        let cleaned = TournamentRoundPairings.list([
            ["roundNumber": 1, "tables": [
                ["gameId": "g", "teams": [["a", "b"], ["c", "d"]]],
                ["gameId": "h", "teams": [["a", "b"]]],                    // one team
                ["gameId": "i", "teams": [["a", 3], ["c", "d"]]],          // not a name
                ["gameId": "j", "teams": [["a", ""], ["c", "d"]]],         // an empty name
            ]],
            ["roundNumber": 0, "tables": []],                               // no round
            ["tables": []], "junk",
        ] as [Any])
        XCTAssertEqual(cleaned, [TournamentRoundPairings(roundNumber: 1, tables: [.init(gameId: "g", teams: [["a", "b"], ["c", "d"]])])])
    }

    func testTheStateKeepsThePairingsAndTheWholeStateReplacesThem() {
        let state = TournamentState()
        state.loadFromServerState(["tournamentId": "t", "phase": "round_active", "pairings": Self.raw])
        XCTAssertEqual(state.pairings.count, 3)
        state.applyPairings(nil)
        XCTAssertEqual(state.pairings.count, 3, "an event without the key keeps them")
        state.applyPairings(Array(Self.raw.prefix(1)))
        XCTAssertEqual(state.pairings.count, 1)
        state.loadFromServerState(["tournamentId": "t", "phase": "lobby"])
        XCTAssertEqual(state.pairings, [], "a whole state without the key: nothing to show")
        state.applyPairings(Self.raw)
        state.reset()
        XCTAssertEqual(state.pairings, [])
    }

    func testTheClientHelloSendsTheCap() {
        XCTAssertEqual(TournamentPairingRules.cap, "tournamentPairings")
        let caps = ClientHello.payload(version: "1.2.7", build: "41")["caps"] as? [String]
        XCTAssertEqual(caps?.filter { $0 == "tournamentPairings" }.count, 1)
        XCTAssertLessThanOrEqual(caps?.count ?? 99, 16, "the contract's maxItems")
        XCTAssertLessThanOrEqual(TournamentPairingRules.cap.count, 32, "the contract's cap length")
    }
}
