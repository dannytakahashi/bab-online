import Foundation

enum Suit: String, Codable, Equatable, Hashable, CaseIterable {
    case spades
    case hearts
    case diamonds
    case clubs
    case joker
}

enum Rank: String, Codable, Equatable, Hashable {
    case two = "2"
    case three = "3"
    case four = "4"
    case five = "5"
    case six = "6"
    case seven = "7"
    case eight = "8"
    case nine = "9"
    case ten = "10"
    case jack = "J"
    case queen = "Q"
    case king = "K"
    case ace = "A"
    case hi = "HI"
    case lo = "LO"
}

struct Card: Codable, Equatable, Hashable, Identifiable {
    let suit: Suit
    let rank: Rank

    var id: String { "\(rank.rawValue)_\(suit.rawValue)" }

    var isJoker: Bool { suit == .joker }

    var displayName: String {
        if suit == .joker {
            return rank == .hi ? "High Joker" : "Low Joker"
        }
        let rankName: String
        switch rank {
        case .ace: rankName = "Ace"
        case .king: rankName = "King"
        case .queen: rankName = "Queen"
        case .jack: rankName = "Jack"
        default: rankName = rank.rawValue
        }
        return "\(rankName) of \(suit.rawValue.capitalized)"
    }

    /// Image asset name matching web client convention: "a_spades", "hi_joker", etc.
    var imageName: String {
        let r: String
        switch rank {
        case .ace: r = "ace"
        case .king: r = "king"
        case .queen: r = "queen"
        case .jack: r = "jack"
        case .hi: r = "hi"
        case .lo: r = "lo"
        default: r = rank.rawValue
        }
        return "\(r)_\(suit.rawValue)"
    }

    // MARK: - Codable

    init(suit: Suit, rank: Rank) {
        self.suit = suit
        self.rank = rank
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let suitStr = try container.decode(String.self, forKey: .suit)
        let rankStr = try container.decode(String.self, forKey: .rank)

        guard let s = Suit(rawValue: suitStr) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [CodingKeys.suit], debugDescription: "Unknown suit: \(suitStr)"))
        }
        guard let r = Rank(rawValue: rankStr) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [CodingKeys.rank], debugDescription: "Unknown rank: \(rankStr)"))
        }
        self.suit = s
        self.rank = r
    }

    /// Parse a card from an untyped dictionary (Socket.IO data).
    static func from(_ dict: [String: Any]) -> Card? {
        guard let suitStr = dict["suit"] as? String,
              let rankStr = dict["rank"] as? String,
              let suit = Suit(rawValue: suitStr),
              let rank = Rank(rawValue: rankStr) else { return nil }
        return Card(suit: suit, rank: rank)
    }

    /// Parse an array of cards from Socket.IO data.
    static func arrayFrom(_ arr: [[String: Any]]) -> [Card] {
        arr.compactMap { Card.from($0) }
    }
}
