import { describe, it, expect } from 'vitest';
import {
  sameSuit,
  isVoid,
  isTrumpTight,
  isHighestTrump,
  isLegalMove,
  wouldBreakTrump,
  getLegalCards,
} from './legality.js';

describe('sameSuit', () => {
  const trump = { suit: 'spades' };

  it('returns true for matching suits', () => {
    expect(sameSuit({ suit: 'hearts' }, { suit: 'hearts' }, trump)).toBe(true);
  });

  it('returns false for different suits', () => {
    expect(sameSuit({ suit: 'hearts' }, { suit: 'diamonds' }, trump)).toBe(false);
  });

  it('treats joker as trump suit', () => {
    expect(sameSuit({ suit: 'joker' }, { suit: 'spades' }, trump)).toBe(true);
    expect(sameSuit({ suit: 'spades' }, { suit: 'joker' }, trump)).toBe(true);
  });

  it('joker does not match non-trump suits', () => {
    expect(sameSuit({ suit: 'joker' }, { suit: 'hearts' }, trump)).toBe(false);
  });
});

describe('isVoid', () => {
  const trump = { suit: 'spades' };

  it('returns true when hand has no cards of suit', () => {
    const hand = [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'diamonds' },
    ];
    expect(isVoid(hand, 'spades', trump)).toBe(true);
  });

  it('returns false when hand has cards of suit', () => {
    const hand = [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'spades' },
    ];
    expect(isVoid(hand, 'spades', trump)).toBe(false);
  });

  it('joker counts as trump suit', () => {
    const hand = [
      { rank: 'A', suit: 'hearts' },
      { rank: 'HI', suit: 'joker' },
    ];
    expect(isVoid(hand, 'spades', trump)).toBe(false);
  });
});

describe('isTrumpTight', () => {
  const trump = { suit: 'spades' };

  it('returns true when all cards are trump', () => {
    const hand = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'spades' },
      { rank: 'HI', suit: 'joker' },
    ];
    expect(isTrumpTight(hand, trump)).toBe(true);
  });

  it('returns false when hand has non-trump cards', () => {
    const hand = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
    ];
    expect(isTrumpTight(hand, trump)).toBe(false);
  });

  it('returns false when no trump', () => {
    const hand = [{ rank: 'A', suit: 'spades' }];
    expect(isTrumpTight(hand, null)).toBe(false);
  });
});

describe('isHighestTrump', () => {
  const trump = { suit: 'spades' };

  it('returns true when card is highest trump in hand', () => {
    const hand = [
      { rank: 'K', suit: 'spades' },
      { rank: '10', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ];
    expect(isHighestTrump('K', hand, trump)).toBe(true);
  });

  it('returns false when higher trump exists', () => {
    const hand = [
      { rank: 'K', suit: 'spades' },
      { rank: 'A', suit: 'spades' },
    ];
    expect(isHighestTrump('K', hand, trump)).toBe(false);
  });

  it('considers joker as highest', () => {
    const hand = [
      { rank: 'A', suit: 'spades' },
      { rank: 'HI', suit: 'joker' },
    ];
    expect(isHighestTrump('A', hand, trump)).toBe(false);
  });
});

describe('isLegalMove', () => {
  const trump = { suit: 'spades' };

  describe('when leading', () => {
    it('allows leading non-trump', () => {
      const hand = [
        { rank: 'A', suit: 'hearts' },
        { rank: 'K', suit: 'spades' },
      ];
      const result = isLegalMove(
        { rank: 'A', suit: 'hearts' },
        hand,
        null,
        true, // leading
        trump,
        false, // trump not broken
        1,
        1
      );
      expect(result.legal).toBe(true);
    });

    it('disallows leading trump when not broken', () => {
      const hand = [
        { rank: 'A', suit: 'hearts' },
        { rank: 'K', suit: 'spades' },
      ];
      const result = isLegalMove(
        { rank: 'K', suit: 'spades' },
        hand,
        null,
        true,
        trump,
        false, // trump not broken
        1,
        1
      );
      expect(result.legal).toBe(false);
      expect(result.reason).toContain('trump');
    });

    it('allows leading trump when broken', () => {
      const hand = [
        { rank: 'A', suit: 'hearts' },
        { rank: 'K', suit: 'spades' },
      ];
      const result = isLegalMove(
        { rank: 'K', suit: 'spades' },
        hand,
        null,
        true,
        trump,
        true, // trump broken
        1,
        1
      );
      expect(result.legal).toBe(true);
    });

    it('allows leading trump when trump tight', () => {
      const hand = [
        { rank: 'K', suit: 'spades' },
        { rank: 'HI', suit: 'joker' },
      ];
      const result = isLegalMove(
        { rank: 'K', suit: 'spades' },
        hand,
        null,
        true,
        trump,
        false, // trump not broken
        1,
        1
      );
      expect(result.legal).toBe(true);
    });
  });

  describe('when following', () => {
    const lead = { rank: 'A', suit: 'hearts' };

    it('allows following suit', () => {
      const hand = [
        { rank: 'K', suit: 'hearts' },
        { rank: 'A', suit: 'spades' },
      ];
      const result = isLegalMove(
        { rank: 'K', suit: 'hearts' },
        hand,
        lead,
        false,
        trump,
        false,
        2,
        1
      );
      expect(result.legal).toBe(true);
    });

    it('disallows playing off-suit when not void', () => {
      const hand = [
        { rank: 'K', suit: 'hearts' },
        { rank: 'A', suit: 'spades' },
      ];
      const result = isLegalMove(
        { rank: 'A', suit: 'spades' },
        hand,
        lead,
        false,
        trump,
        false,
        2,
        1
      );
      expect(result.legal).toBe(false);
      expect(result.reason).toContain('follow suit');
    });

    it('allows playing off-suit when void', () => {
      const hand = [
        { rank: 'K', suit: 'diamonds' },
        { rank: 'A', suit: 'spades' },
      ];
      const result = isLegalMove(
        { rank: 'A', suit: 'spades' },
        hand,
        lead,
        false,
        trump,
        false,
        2,
        1
      );
      expect(result.legal).toBe(true);
    });
  });

  describe('HI joker rule', () => {
    const hiLead = { rank: 'HI', suit: 'joker' };

    it('requires opponents to play highest trump', () => {
      const hand = [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ];
      const result = isLegalMove(
        { rank: 'K', suit: 'spades' },
        hand,
        hiLead,
        false,
        trump,
        true,
        2, // opponent (position 2 vs lead position 1)
        1
      );
      expect(result.legal).toBe(false);
      expect(result.reason).toContain('highest trump');
    });

    it('allows partner to play any trump', () => {
      const hand = [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ];
      const result = isLegalMove(
        { rank: 'K', suit: 'spades' },
        hand,
        hiLead,
        false,
        trump,
        true,
        3, // partner (position 3 vs lead position 1)
        1
      );
      expect(result.legal).toBe(true);
    });
  });
});

describe('wouldBreakTrump', () => {
  const trump = { suit: 'spades' };

  it('returns true when playing trump for first time', () => {
    expect(wouldBreakTrump({ rank: 'A', suit: 'spades' }, trump, false)).toBe(true);
  });

  it('returns false when trump already broken', () => {
    expect(wouldBreakTrump({ rank: 'A', suit: 'spades' }, trump, true)).toBe(false);
  });

  it('returns false for non-trump cards', () => {
    expect(wouldBreakTrump({ rank: 'A', suit: 'hearts' }, trump, false)).toBe(false);
  });

  it('returns true for joker when not broken', () => {
    expect(wouldBreakTrump({ rank: 'HI', suit: 'joker' }, trump, false)).toBe(true);
  });
});

describe('getLegalCards', () => {
  const trump = { suit: 'spades' };

  it('returns all cards when leading with trump broken', () => {
    const hand = [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'spades' },
    ];
    const legal = getLegalCards(hand, null, true, trump, true, 1, 1);
    expect(legal).toHaveLength(2);
  });

  it('excludes trump when leading with trump not broken', () => {
    const hand = [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'spades' },
    ];
    const legal = getLegalCards(hand, null, true, trump, false, 1, 1);
    expect(legal).toHaveLength(1);
    expect(legal[0].suit).toBe('hearts');
  });

  it('returns only cards of lead suit when not void', () => {
    const hand = [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'hearts' },
      { rank: 'Q', suit: 'spades' },
    ];
    const lead = { rank: '2', suit: 'hearts' };
    const legal = getLegalCards(hand, lead, false, trump, false, 2, 1);
    expect(legal).toHaveLength(2);
    expect(legal.every((c) => c.suit === 'hearts')).toBe(true);
  });
});
