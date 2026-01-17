/**
 * Card legality checking for client-side validation.
 *
 * These functions mirror server-side rules for immediate UI feedback.
 * Server always has final authority on move validity.
 */

import { RANK_VALUES, JOKER_SUIT } from '../constants/ranks.js';

/**
 * Check if two cards are the same suit.
 * Jokers count as the trump suit.
 *
 * @param {Object} card1 - First card
 * @param {Object} card2 - Second card
 * @param {Object} trump - Trump card (for joker matching)
 * @returns {boolean} True if same suit
 */
export function sameSuit(card1, card2, trump = null) {
  if (card1.suit === card2.suit) {
    return true;
  }

  // Jokers match trump suit
  if (trump) {
    const trumpSuit = trump.suit;
    if (
      (card1.suit === JOKER_SUIT && card2.suit === trumpSuit) ||
      (card2.suit === JOKER_SUIT && card1.suit === trumpSuit)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if player is void in a suit (has no cards of that suit).
 *
 * @param {Array} hand - Player's hand
 * @param {string} suit - Suit to check
 * @param {Object} trump - Trump card (for joker matching)
 * @returns {boolean} True if void in suit
 */
export function isVoid(hand, suit, trump = null) {
  const proto = { rank: '1', suit };

  for (const card of hand) {
    if (sameSuit(card, proto, trump)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if hand contains only trump cards (trump tight).
 *
 * @param {Array} hand - Player's hand
 * @param {Object} trump - Trump card
 * @returns {boolean} True if only trump cards
 */
export function isTrumpTight(hand, trump) {
  if (!trump) return false;

  for (const card of hand) {
    if (card.suit !== trump.suit && card.suit !== JOKER_SUIT) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a card is the highest trump in hand.
 * Used for HI joker rule enforcement.
 *
 * @param {string} rank - Rank to check
 * @param {Array} hand - Player's hand
 * @param {Object} trump - Trump card
 * @returns {boolean} True if no higher trump in hand
 */
export function isHighestTrump(rank, hand, trump) {
  for (const card of hand) {
    if (sameSuit(card, trump, trump) && RANK_VALUES[card.rank] > RANK_VALUES[rank]) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a card is a legal play given game state.
 *
 * @param {Object} card - Card to play
 * @param {Array} hand - Player's hand
 * @param {Object} lead - Lead card of trick (null if leading)
 * @param {boolean} isLeading - Whether this player is leading
 * @param {Object} trump - Trump card
 * @param {boolean} trumpBroken - Whether trump has been broken
 * @param {number} myPosition - Player's position
 * @param {number} leadPosition - Lead player's position (for HI joker rule)
 * @returns {Object} { legal: boolean, reason?: string }
 */
export function isLegalMove(
  card,
  hand,
  lead,
  isLeading,
  trump,
  trumpBroken,
  myPosition,
  leadPosition
) {
  // Leading a trick
  if (isLeading) {
    // Can't lead trump unless broken (or trump tight)
    if (
      sameSuit(card, trump, trump) &&
      !trumpBroken &&
      !isTrumpTight(hand, trump)
    ) {
      return {
        legal: false,
        reason: 'Cannot lead trump until trump is broken',
      };
    }

    return { legal: true };
  }

  // Following a trick
  if (!lead) {
    return { legal: false, reason: 'No lead card found' };
  }

  const isVoidInLead = isVoid(hand, lead.suit, trump);

  // Must follow suit if possible
  if (!sameSuit(card, lead, trump) && !isVoidInLead) {
    return {
      legal: false,
      reason: 'Must follow suit',
    };
  }

  // HI joker special rule: opponents must play their highest trump
  if (lead.rank === 'HI') {
    const isOpponent = myPosition % 2 !== leadPosition % 2;

    if (isOpponent && !isHighestTrump(card.rank, hand, trump)) {
      return {
        legal: false,
        reason: 'Must play highest trump when HI joker leads',
      };
    }
  }

  return { legal: true };
}

/**
 * Check if playing a card would break trump.
 *
 * @param {Object} card - Card being played
 * @param {Object} trump - Trump card
 * @param {boolean} currentlyBroken - Current trump broken state
 * @returns {boolean} True if this play breaks trump
 */
export function wouldBreakTrump(card, trump, currentlyBroken) {
  if (currentlyBroken) return false;
  return sameSuit(card, trump, trump);
}

/**
 * Get all legal cards from a hand given game state.
 *
 * @param {Array} hand - Player's hand
 * @param {Object} lead - Lead card (null if leading)
 * @param {boolean} isLeading - Whether player is leading
 * @param {Object} trump - Trump card
 * @param {boolean} trumpBroken - Whether trump is broken
 * @param {number} myPosition - Player's position
 * @param {number} leadPosition - Lead player's position
 * @returns {Array} Array of legal cards
 */
export function getLegalCards(
  hand,
  lead,
  isLeading,
  trump,
  trumpBroken,
  myPosition,
  leadPosition
) {
  return hand.filter((card) => {
    const result = isLegalMove(
      card,
      hand,
      lead,
      isLeading,
      trump,
      trumpBroken,
      myPosition,
      leadPosition
    );
    return result.legal;
  });
}
