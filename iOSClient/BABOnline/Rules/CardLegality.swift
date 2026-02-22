import Foundation

/// Card legality checking — mirrors server-side rules for immediate UI feedback.
/// Server always has final authority on move validity.
enum CardLegality {

    struct LegalityResult {
        let legal: Bool
        let reason: String?

        static let ok = LegalityResult(legal: true, reason: nil)

        static func illegal(_ reason: String) -> LegalityResult {
            LegalityResult(legal: false, reason: reason)
        }
    }

    /// Check if two cards are the same suit. Jokers count as the trump suit.
    static func sameSuit(_ card1: Card, _ card2: Card, trump: Card?) -> Bool {
        if card1.suit == card2.suit { return true }

        if let trump = trump {
            let trumpSuit = trump.suit
            if (card1.suit == .joker && card2.suit == trumpSuit) ||
               (card2.suit == .joker && card1.suit == trumpSuit) {
                return true
            }
        }
        return false
    }

    /// Check if player is void in a suit (has no cards of that suit).
    static func isVoid(hand: [Card], suit: Suit, trump: Card?) -> Bool {
        let proto = Card(suit: suit, rank: .two)
        for card in hand {
            if sameSuit(card, proto, trump: trump) { return false }
        }
        return true
    }

    /// Check if hand contains only trump cards (trump tight).
    static func isTrumpTight(hand: [Card], trump: Card) -> Bool {
        for card in hand {
            if card.suit != trump.suit && card.suit != .joker {
                return false
            }
        }
        return true
    }

    /// Check if a card is the highest trump in hand (for HI joker rule).
    static func isHighestTrump(rank: Rank, hand: [Card], trump: Card) -> Bool {
        let myValue = CardConstants.rankValues[rank] ?? 0
        for card in hand {
            if sameSuit(card, trump, trump: trump),
               let cardValue = CardConstants.rankValues[card.rank],
               cardValue > myValue {
                return false
            }
        }
        return true
    }

    /// Check if a card is a legal play given game state.
    static func isLegalMove(
        card: Card,
        hand: [Card],
        lead: Card?,
        isLeading: Bool,
        trump: Card?,
        trumpBroken: Bool,
        myPosition: Int,
        leadPosition: Int
    ) -> LegalityResult {
        guard let trump = trump else { return .ok }

        // Leading a trick
        if isLeading {
            if sameSuit(card, trump, trump: trump) && !trumpBroken && !isTrumpTight(hand: hand, trump: trump) {
                return .illegal("Cannot lead trump until trump is broken")
            }
            return .ok
        }

        // Following a trick
        guard let lead = lead else {
            return .illegal("No lead card found")
        }

        let voidInLead = isVoid(hand: hand, suit: lead.suit, trump: trump)

        // Must follow suit if possible
        if !sameSuit(card, lead, trump: trump) && !voidInLead {
            return .illegal("Must follow suit")
        }

        // HI joker special rule: opponents must play their highest trump
        if lead.rank == .hi {
            let isOpponent = myPosition % 2 != leadPosition % 2
            if isOpponent && !isHighestTrump(rank: card.rank, hand: hand, trump: trump) {
                return .illegal("Must play highest trump when HI joker leads")
            }
        }

        return .ok
    }

    /// Check if playing a card would break trump.
    static func wouldBreakTrump(card: Card, trump: Card?, currentlyBroken: Bool) -> Bool {
        if currentlyBroken { return false }
        guard let trump = trump else { return false }
        return sameSuit(card, trump, trump: trump)
    }

    /// Get all legal cards from a hand given game state.
    static func getLegalCards(
        hand: [Card],
        lead: Card?,
        isLeading: Bool,
        trump: Card?,
        trumpBroken: Bool,
        myPosition: Int,
        leadPosition: Int
    ) -> [Card] {
        hand.filter { card in
            isLegalMove(
                card: card, hand: hand, lead: lead, isLeading: isLeading,
                trump: trump, trumpBroken: trumpBroken,
                myPosition: myPosition, leadPosition: leadPosition
            ).legal
        }
    }
}
