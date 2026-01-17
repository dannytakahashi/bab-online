import { describe, it, expect } from 'vitest';
import {
  getCardImageKey,
  getSuitOrder,
  sortHand,
  cardsEqual,
  isJoker,
  getCardDisplayName,
} from './cards.js';

describe('getCardImageKey', () => {
  it('returns lowercase key for regular cards', () => {
    expect(getCardImageKey({ rank: 'A', suit: 'Spades' })).toBe('a_spades');
    expect(getCardImageKey({ rank: 'K', suit: 'Hearts' })).toBe('k_hearts');
    expect(getCardImageKey({ rank: '10', suit: 'diamonds' })).toBe('10_diamonds');
  });

  it('returns key for jokers', () => {
    expect(getCardImageKey({ rank: 'HI', suit: 'joker' })).toBe('hi_joker');
    expect(getCardImageKey({ rank: 'LO', suit: 'joker' })).toBe('lo_joker');
  });
});

describe('getSuitOrder', () => {
  it('places spades last when spades is trump', () => {
    const order = getSuitOrder('spades');
    expect(order[3]).toBe('spades');
  });

  it('places hearts last when hearts is trump', () => {
    const order = getSuitOrder('hearts');
    expect(order[3]).toBe('hearts');
  });

  it('alternates colors in order', () => {
    const order = getSuitOrder('spades');
    // Should alternate: hearts (red), clubs (black), diamonds (red), spades (black)
    expect(order).toEqual(['hearts', 'clubs', 'diamonds', 'spades']);
  });

  it('returns default order for joker trump', () => {
    const order = getSuitOrder('joker');
    expect(order).toEqual(['clubs', 'diamonds', 'hearts', 'spades']);
  });

  it('returns default order for unknown trump', () => {
    const order = getSuitOrder('unknown');
    expect(order).toEqual(['clubs', 'diamonds', 'hearts', 'spades']);
  });
});

describe('sortHand', () => {
  const trumpCard = { suit: 'spades' };

  it('returns empty array for empty hand', () => {
    expect(sortHand([], trumpCard)).toEqual([]);
  });

  it('returns original hand if no trump card', () => {
    const hand = [{ rank: 'A', suit: 'hearts' }];
    expect(sortHand(hand, null)).toEqual(hand);
  });

  it('sorts cards by suit order', () => {
    const hand = [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
      { rank: 'A', suit: 'clubs' },
    ];
    const sorted = sortHand(hand, trumpCard);
    expect(sorted[0].suit).toBe('hearts');
    expect(sorted[1].suit).toBe('clubs');
    expect(sorted[2].suit).toBe('spades'); // Trump last
  });

  it('sorts cards by rank within same suit', () => {
    const hand = [
      { rank: 'K', suit: 'hearts' },
      { rank: '2', suit: 'hearts' },
      { rank: 'A', suit: 'hearts' },
    ];
    const sorted = sortHand(hand, trumpCard);
    expect(sorted[0].rank).toBe('2');
    expect(sorted[1].rank).toBe('K');
    expect(sorted[2].rank).toBe('A');
  });

  it('places jokers at the end', () => {
    const hand = [
      { rank: 'A', suit: 'spades' },
      { rank: 'HI', suit: 'joker' },
      { rank: 'LO', suit: 'joker' },
    ];
    const sorted = sortHand(hand, trumpCard);
    expect(sorted[0].suit).toBe('spades');
    expect(sorted[1].rank).toBe('LO');
    expect(sorted[2].rank).toBe('HI');
  });

  it('does not mutate original hand', () => {
    const hand = [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ];
    const original = [...hand];
    sortHand(hand, trumpCard);
    expect(hand).toEqual(original);
  });
});

describe('cardsEqual', () => {
  it('returns true for equal cards', () => {
    expect(
      cardsEqual({ rank: 'A', suit: 'spades' }, { rank: 'A', suit: 'spades' })
    ).toBe(true);
  });

  it('returns false for different ranks', () => {
    expect(
      cardsEqual({ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'spades' })
    ).toBe(false);
  });

  it('returns false for different suits', () => {
    expect(
      cardsEqual({ rank: 'A', suit: 'spades' }, { rank: 'A', suit: 'hearts' })
    ).toBe(false);
  });

  it('returns false for null cards', () => {
    expect(cardsEqual(null, { rank: 'A', suit: 'spades' })).toBe(false);
    expect(cardsEqual({ rank: 'A', suit: 'spades' }, null)).toBe(false);
    expect(cardsEqual(null, null)).toBe(false);
  });
});

describe('isJoker', () => {
  it('returns true for jokers', () => {
    expect(isJoker({ rank: 'HI', suit: 'joker' })).toBe(true);
    expect(isJoker({ rank: 'LO', suit: 'joker' })).toBe(true);
  });

  it('returns false for regular cards', () => {
    expect(isJoker({ rank: 'A', suit: 'spades' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isJoker(null)).toBe(false);
  });
});

describe('getCardDisplayName', () => {
  it('returns name for face cards', () => {
    expect(getCardDisplayName({ rank: 'A', suit: 'spades' })).toBe('Ace of Spades');
    expect(getCardDisplayName({ rank: 'K', suit: 'hearts' })).toBe('King of Hearts');
    expect(getCardDisplayName({ rank: 'Q', suit: 'diamonds' })).toBe('Queen of Diamonds');
    expect(getCardDisplayName({ rank: 'J', suit: 'clubs' })).toBe('Jack of Clubs');
  });

  it('returns name for number cards', () => {
    expect(getCardDisplayName({ rank: '10', suit: 'spades' })).toBe('10 of Spades');
    expect(getCardDisplayName({ rank: '2', suit: 'hearts' })).toBe('2 of Hearts');
  });

  it('returns name for jokers', () => {
    expect(getCardDisplayName({ rank: 'HI', suit: 'joker' })).toBe('High Joker');
    expect(getCardDisplayName({ rank: 'LO', suit: 'joker' })).toBe('Low Joker');
  });

  it('returns Unknown for null', () => {
    expect(getCardDisplayName(null)).toBe('Unknown');
  });
});
