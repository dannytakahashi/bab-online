import Foundation

enum CardUtils {
    /// Get suit order for sorting — alternating colors with trump rightmost.
    static func getSuitOrder(trumpSuit: Suit) -> [Suit] {
        switch trumpSuit {
        case .spades:   return [.hearts, .clubs, .diamonds, .spades]
        case .hearts:   return [.spades, .diamonds, .clubs, .hearts]
        case .diamonds: return [.clubs, .hearts, .spades, .diamonds]
        case .clubs:    return [.diamonds, .spades, .hearts, .clubs]
        case .joker:    return [.clubs, .diamonds, .hearts, .spades]
        }
    }

    /// Sort hand by suit (trump rightmost) and rank (low to high).
    /// Jokers go rightmost (they're always trump).
    static func sortHand(_ hand: [Card], trump: Card?) -> [Card] {
        guard !hand.isEmpty, let trump = trump else { return hand }

        let suitOrder = getSuitOrder(trumpSuit: trump.suit)

        return hand.sorted { a, b in
            // Jokers go last
            if a.suit == .joker && b.suit == .joker {
                return a.rank == .lo
            }
            if a.suit == .joker { return false }
            if b.suit == .joker { return true }

            // Sort by suit order (trump rightmost)
            let aSuitIdx = suitOrder.firstIndex(of: a.suit) ?? 0
            let bSuitIdx = suitOrder.firstIndex(of: b.suit) ?? 0
            if aSuitIdx != bSuitIdx { return aSuitIdx < bSuitIdx }

            // Within suit, sort by rank (low to high)
            let aRankIdx = CardConstants.rankOrder.firstIndex(of: a.rank) ?? 0
            let bRankIdx = CardConstants.rankOrder.firstIndex(of: b.rank) ?? 0
            return aRankIdx < bRankIdx
        }
    }

    /// Compare two cards for equality.
    static func cardsEqual(_ a: Card?, _ b: Card?) -> Bool {
        guard let a = a, let b = b else { return false }
        return a.suit == b.suit && a.rank == b.rank
    }
}
