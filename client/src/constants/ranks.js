/**
 * Card rank values and suit constants.
 */

// Rank values for comparing cards (higher = better)
export const RANK_VALUES = {
  'HI': 16,
  'LO': 15,
  'A': 14,
  'K': 13,
  'Q': 12,
  'J': 11,
  '10': 10,
  '9': 9,
  '8': 8,
  '7': 7,
  '6': 6,
  '5': 5,
  '4': 4,
  '3': 3,
  '2': 2,
};

// Rank order for sorting (low to high)
export const RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// All suit names
export const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];

// Joker suit value
export const JOKER_SUIT = 'joker';

// Joker ranks
export const HI_JOKER = 'HI';
export const LO_JOKER = 'LO';

// Hand progression for game
export const HAND_PROGRESSION = [12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13];
