/**
 * Bids as trick counts: a bore counts as the whole hand and a team's total
 * is capped at the hand size, as the server counts them (rules.js
 * BID_RANKS, gameHandlers.js doneBidding).
 */
import { describe, it, expect } from 'vitest';
import { isBore, bidTricks, teamBidTotal, bidTotalsFor } from './bids.js';

describe('bid totals', () => {
  it('a bore is the whole hand; a number is itself; nothing placed is null', () => {
    expect(['B', '2B', '3b', '4B'].map(isBore)).toEqual([true, true, true, true]);
    expect([isBore('3'), isBore(0), isBore(null), isBore(undefined)]).toEqual([false, false, false, false]);
    expect(bidTricks('B', 2)).toBe(2);
    expect(bidTricks('4B', 13)).toBe(13);
    expect(bidTricks('3', 5)).toBe(3);
    expect(bidTricks(0, 5)).toBe(0);
    expect(bidTricks(undefined, 5)).toBe(null);
    expect(bidTricks('x', 5)).toBe(null);
    // an unknown hand size counts as 13
    expect(bidTricks('B')).toBe(13);
  });

  it('a team total is min(hand size, sum) with a bore as the hand', () => {
    expect(teamBidTotal('B', '2', 10)).toBe(10);
    expect(teamBidTotal('B', '2B', 1)).toBe(1);
    expect(teamBidTotal('3', '4', 5)).toBe(5);
    expect(teamBidTotal('3', '1', 5)).toBe(4);
    expect(teamBidTotal('2', undefined, 5)).toBe(2);
    expect(teamBidTotal('0', '0', 5)).toBe(0);
  });

  it('totals from a viewer\'s seat, by position or doneBidding\'s array', () => {
    expect(bidTotalsFor({ 1: '2', 2: 'B', 3: '1', 4: '0' }, 1, 4)).toEqual({ team: 3, opp: 4 });
    expect(bidTotalsFor(['2', 'B', '1', '0'], 4, 4)).toEqual({ team: 4, opp: 3 });
    // a spectator views from seat 1
    expect(bidTotalsFor(['2', 'B', '1', '0'], null, 4)).toEqual({ team: 3, opp: 4 });
  });
});
