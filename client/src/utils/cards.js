/**
 * Card utility functions for image keys, sorting, and display.
 */

import { RANK_ORDER, JOKER_SUIT } from '../constants/ranks.js';

/**
 * Get the texture atlas key for a card.
 *
 * @param {Object} card - Card object with suit and rank
 * @returns {string} Texture key like "a_spades" or "hi_joker"
 */
export function getCardImageKey(card) {
  const rank = card.rank.toLowerCase();
  const suit = card.suit.toLowerCase();
  return `${rank}_${suit}`;
}

/**
 * Get suit order for sorting - alternating colors with trump rightmost.
 *
 * @param {string} trumpSuit - The trump suit for this hand
 * @returns {Array<string>} Ordered array of suits
 */
export function getSuitOrder(trumpSuit) {
  const orders = {
    'spades': ['hearts', 'clubs', 'diamonds', 'spades'],
    'hearts': ['spades', 'diamonds', 'clubs', 'hearts'],
    'diamonds': ['clubs', 'hearts', 'spades', 'diamonds'],
    'clubs': ['diamonds', 'spades', 'hearts', 'clubs'],
    'joker': ['clubs', 'diamonds', 'hearts', 'spades'], // No trump - just alternate colors
  };
  return orders[trumpSuit] || ['clubs', 'diamonds', 'hearts', 'spades'];
}

/**
 * Sort hand by suit (trump rightmost) and rank (low to high).
 * Jokers go rightmost (they're always trump).
 *
 * @param {Array} hand - Array of card objects
 * @param {Object} trumpCard - Card object indicating trump suit
 * @returns {Array} Sorted copy of hand
 */
export function sortHand(hand, trumpCard) {
  if (!hand || hand.length === 0) return hand;
  if (!trumpCard || !trumpCard.suit) return hand;

  const trumpSuit = trumpCard.suit;
  const suitOrder = getSuitOrder(trumpSuit);

  return [...hand].sort((a, b) => {
    // Jokers go last (they're trump) - HI joker rightmost
    if (a.suit === JOKER_SUIT && b.suit === JOKER_SUIT) {
      return a.rank === 'LO' ? -1 : 1;
    }
    if (a.suit === JOKER_SUIT) return 1;
    if (b.suit === JOKER_SUIT) return -1;

    // Sort by suit order (trump rightmost)
    const suitDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
    if (suitDiff !== 0) return suitDiff;

    // Within suit, sort by rank (low to high)
    return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
  });
}

/**
 * Compare two cards for equality.
 *
 * @param {Object} card1 - First card
 * @param {Object} card2 - Second card
 * @returns {boolean} True if cards are equal
 */
export function cardsEqual(card1, card2) {
  if (!card1 || !card2) return false;
  return card1.suit === card2.suit && card1.rank === card2.rank;
}

/**
 * Check if a card is a joker.
 *
 * @param {Object} card - Card to check
 * @returns {boolean} True if joker
 */
export function isJoker(card) {
  return card != null && card.suit === JOKER_SUIT;
}

/**
 * Get display name for a card (e.g., "Ace of Spades", "High Joker").
 *
 * @param {Object} card - Card object
 * @returns {string} Human-readable card name
 */
export function getCardDisplayName(card) {
  if (!card) return 'Unknown';

  if (card.suit === JOKER_SUIT) {
    return card.rank === 'HI' ? 'High Joker' : 'Low Joker';
  }

  const rankNames = {
    'A': 'Ace',
    'K': 'King',
    'Q': 'Queen',
    'J': 'Jack',
  };

  const rank = rankNames[card.rank] || card.rank;
  const suit = card.suit.charAt(0).toUpperCase() + card.suit.slice(1);

  return `${rank} of ${suit}`;
}
