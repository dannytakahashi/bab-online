import XCTest
@testable import BAB_Online

/// The shared case table, contract/rules/legality-cases.json, which Jest runs
/// on server/game/rules.js and Vitest on the web copy: `legality` against
/// CardLegality, `tricks` against TrickRules (OverTrumpTests reads the same
/// rows for the over-trump flag). Read from the checkout (simulator only,
/// like Release12FollowupTests' server-source check), never bundled.
final class LegalityCaseTableTests: XCTestCase {
    struct Lead: Decodable { let card: String; let position: Int }
    struct LegalityRow: Decodable {
        let name: String
        let trump: String
        let trumpBroken: Bool
        let position: Int
        let lead: Lead?
        let hand: [String]
        let legal: [String]
    }
    struct TrickRow: Decodable {
        let name: String
        let trump: String
        let trick: String
        let winner: Int
        let overTrump: Bool
        let oldDetectorWrong: Bool
    }
    struct Table: Decodable {
        let legality: [LegalityRow]
        let tricks: [TrickRow]
    }

    static func caseTable() throws -> Table {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("contract/rules/legality-cases.json"))
        return try JSONDecoder().decode(Table.self, from: data)
    }

    /// "As", "10h", "HIj"
    static func card(_ code: String) -> Card {
        let suits: [Character: Suit] = ["s": .spades, "h": .hearts, "d": .diamonds, "c": .clubs, "j": .joker]
        return Card(suit: suits[code.last!]!, rank: Rank(rawValue: String(code.dropLast()))!)
    }

    static func code(_ c: Card) -> String {
        c.rank.rawValue + (c.suit == .joker ? "j" : String(c.suit.rawValue.prefix(1)))
    }

    /// "1:Kh 2:5s 3:HIj" → play order
    static func trick(_ spec: String) -> [PlayedCard] {
        spec.split(separator: " ").map { tok in
            let parts = tok.split(separator: ":")
            return PlayedCard(card: card(String(parts[1])), position: Int(parts[0])!)
        }
    }

    func testLegality() throws {
        let table = try Self.caseTable()
        XCTAssertGreaterThanOrEqual(table.legality.count, 20)
        for row in table.legality {
            let hand = row.hand.map(Self.card)
            let lead = row.lead.map { Self.card($0.card) }
            let leadPosition = row.lead?.position ?? row.position
            let legal = CardLegality.getLegalCards(
                hand: hand, lead: lead, isLeading: row.lead == nil, trump: Self.card(row.trump),
                trumpBroken: row.trumpBroken, myPosition: row.position, leadPosition: leadPosition
            )
            XCTAssertEqual(legal.map(Self.code), row.legal, row.name)
            for c in hand where !row.legal.contains(Self.code(c)) {
                let r = CardLegality.isLegalMove(
                    card: c, hand: hand, lead: lead, isLeading: row.lead == nil, trump: Self.card(row.trump),
                    trumpBroken: row.trumpBroken, myPosition: row.position, leadPosition: leadPosition
                )
                XCTAssertFalse(r.legal, "\(row.name): \(Self.code(c))")
                XCTAssertNotNil(r.reason, "\(row.name): \(Self.code(c))")
            }
        }
    }

    func testTrickWinners() throws {
        let table = try Self.caseTable()
        XCTAssertGreaterThanOrEqual(table.tricks.count, 20)
        for row in table.tricks {
            let t = Self.trick(row.trick)
            let i = try XCTUnwrap(TrickRules.winnerIndex(trick: t, trump: Self.card(row.trump)), row.name)
            XCTAssertEqual(t[i].position, row.winner, row.name)
        }
    }
}
