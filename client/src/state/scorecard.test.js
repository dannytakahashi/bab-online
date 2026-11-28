/**
 * The scorecard's model (state/scorecard.js): the wire rows read leniently,
 * the columns by pair (mine first) or by player (Get Your Bid), each cell's
 * colour roles, the ledger's delta above the total (none on the first
 * hand), the hand in play with bids only, and one sentence per row.
 */
import { describe, it, expect } from 'vitest';
import { validRow, parseRows, mergeRow, signed, handLabel, buildScorecard, cellOf, scorecardColumns } from './scorecard.js';
import { GameState } from './GameState.js';

const H = (suit, rank = '7') => ({ suit, rank });
const NAMES = { 1: 'ivy', 2: 'kim', 3: 'hal', 4: 'jon' };
const name = (p) => NAMES[p];

// The approved mockup's rows (ivy 1 & hal 3 vs kim 2 & jon 4)
const ROWS = [
  { handNo: 1, handSize: 12, trump: H('hearts'), dealer: 2, bids: ['3', '2', '2', '1'], took: [3, 3, 3, 3], points: [51, 33], scores: [51, 33], faults: [], set: [false, false] },
  { handNo: 2, handSize: 10, trump: H('spades'), dealer: 3, bids: ['2', '3', '2', '2'], took: [3, 1, 2, 2], points: [41, -50], scores: [92, -17], faults: [2], set: [false, true] },
  { handNo: 5, handSize: 4, trump: H('hearts'), dealer: 2, bids: ['B', '0', '0', '0'], took: [4, 0, 0, 0], points: [80, 0], scores: [162, 47], faults: [], set: [false, false] },
  { handNo: 9, handSize: 5, trump: H('diamonds'), dealer: 4, bids: ['1', '2B', '0', '0'], took: [1, 4, 0, 0], points: [10, -200], scores: [182, -143], faults: [], set: [false, true] },
];

describe('the wire rows', () => {
  it('a row is read only when the table can draw it', () => {
    expect(ROWS.every(validRow)).toBe(true);
    expect(validRow({ ...ROWS[0], bids: ['3', 'X', '2', '1'] })).toBe(false);
    expect(validRow({ ...ROWS[0], took: [3, 3, 3] })).toBe(false);
    expect(validRow({ ...ROWS[0], handNo: 14 })).toBe(false);
    expect(validRow(null)).toBe(false);
  });

  it('parseRows keeps the good rows by hand, mergeRow replaces a hand\'s row', () => {
    expect(parseRows([ROWS[1], { nope: 1 }, ROWS[0]])).toEqual([ROWS[0], ROWS[1]]);
    expect(parseRows('x')).toBeNull();
    const merged = mergeRow([ROWS[0], ROWS[1]], { ...ROWS[1], points: [1, 2] });
    expect(merged).toHaveLength(2);
    expect(merged[1].points).toEqual([1, 2]);
  });

  it('signed: "+41", "−50" (a true minus), "0"', () => {
    expect([signed(41), signed(-50), signed(0)]).toEqual(['+41', '−50', '0']);
  });

  it('the Hand column: the size and the suit, red for hearts and diamonds; a turned joker is HI / LO', () => {
    expect(handLabel(12, H('hearts'))).toMatchObject({ symbol: '♥', red: true, spoken: 'Hand 12, hearts' });
    expect(handLabel(10, H('spades'))).toMatchObject({ symbol: '♠', red: false });
    expect(handLabel(1, { suit: 'joker', rank: 'HI' })).toMatchObject({ symbol: 'HI', joker: true, spoken: 'Hand 1, no trump, high joker' });
    expect(handLabel(3, { suit: 'joker', rank: 'LO' })).toMatchObject({ symbol: 'LO', red: false });
  });
});

describe('the columns', () => {
  it('a seat: my pair first (me, partner), then the next seat and its partner, each pair in its team\'s colour', () => {
    const c = scorecardColumns({ me: 2, name });
    expect(c.players.map((p) => p.position)).toEqual([2, 4, 3, 1]);
    expect(c.groups.map((g) => [g.label, g.letter, g.teamIndex])).toEqual([['kim & jon', 'b', 1], ['hal & ivy', 'a', 0]]);
    expect(c.scores.map((s) => s.index)).toEqual([1, 0]);
  });

  it('a spectator: seats 1 and 3, then 2 and 4 (never Team 1 / Team 2)', () => {
    const c = scorecardColumns({ me: null, name });
    expect(c.players.map((p) => p.position)).toEqual([1, 3, 2, 4]);
    expect(c.groups.map((g) => g.label)).toEqual(['ivy & hal', 'kim & jon']);
    expect(JSON.stringify(c)).not.toMatch(/Team \d|T\d|Your Team|Opponents/);
  });

  it('Get Your Bid: three players, mine first, each its own colour; one score per player', () => {
    const c = scorecardColumns({ solo: true, me: 3, name });
    expect(c.players.map((p) => [p.position, p.letter])).toEqual([[3, 'c'], [1, 'a'], [2, 'b']]);
    expect(c.groups).toEqual([]);
    expect(c.scores.map((s) => s.index)).toEqual([2, 0, 1]);
  });
});

describe('the cells', () => {
  it('extra tricks are gold; the exact bid is plain', () => {
    expect(cellOf(ROWS[0], 2)).toMatchObject({ bid: '2', took: 3, extra: true, fault: false, bore: false });
    expect(cellOf(ROWS[0], 1)).toMatchObject({ extra: false });
  });

  it('the player at fault (the server\'s faults) is the red pill', () => {
    expect(cellOf(ROWS[1], 2)).toMatchObject({ bid: '3', took: 1, fault: true });
    expect(cellOf(ROWS[1], 4)).toMatchObject({ fault: false });
  });

  it('a made bore is the green outline; a set 2B is red and outlined; its partner as normal', () => {
    expect(cellOf(ROWS[2], 1)).toMatchObject({ bore: true, boreSet: false, extra: false });
    expect(cellOf(ROWS[3], 2)).toMatchObject({ bore: true, boreSet: true });
    expect(cellOf(ROWS[3], 4)).toMatchObject({ bore: false, boreSet: false, fault: false, extra: false });
  });

  it('the hand in play: the bids only', () => {
    expect(cellOf({ bids: ['2', null, '1', null] }, 1, { current: true })).toMatchObject({ bid: '2', took: null, extra: false });
    expect(cellOf({ bids: ['2', null, '1', null] }, 2, { current: true }).bid).toBeNull();
  });
});

describe('buildScorecard', () => {
  it('the ledger: the hand\'s points above the new total, none on the first hand', () => {
    const m = buildScorecard({ rows: ROWS, me: 1, name });
    expect(m.rows[0].scores.map((s) => s.showDelta)).toEqual([false, false]);
    expect(m.rows[1].scores).toEqual([
      { total: 92, delta: 41, showDelta: true, letter: 'a' },
      { total: -17, delta: -50, showDelta: true, letter: 'b' },
    ]);
  });

  it('one sentence per row, for VoiceOver and screen readers', () => {
    const m = buildScorecard({ rows: ROWS.slice(0, 2), me: 1, name });
    expect(m.rows[1].spoken).toBe('Hand 10, spades. Dealer hal. ivy bid 2, took 3, one extra. hal bid 2, took 2. kim bid 3, took 1, at fault. jon bid 2, took 2. ivy and hal 92, plus 41. kim and jon minus 17, minus 50.');
    expect(m.rows[0].spoken).toContain('ivy and hal 51. kim and jon 33.');
  });

  it('a bore set reads as set; a made bore as a bore', () => {
    const m = buildScorecard({ rows: ROWS, me: 1, name });
    expect(m.rows[2].spoken).toContain('ivy bid a bore, took 4.');
    expect(m.rows[3].spoken).toContain('kim bid bore 2B, took 4, set.');
  });

  it('the hand in play: its row last, bids only, no score; not when its row already came', () => {
    const current = { handNo: 3, handSize: 8, trump: H('diamonds'), dealer: 4, bids: ['1', null, '2', null] };
    const m = buildScorecard({ rows: ROWS.slice(0, 2), me: 1, name, current });
    const last = m.rows[2];
    expect(last.current).toBe(true);
    expect(last.scores).toEqual([null, null]);
    expect(last.cells.map((c) => c.bid)).toEqual(['1', '2', null, null]);
    expect(last.spoken).toContain('kim not bid yet');
    expect(buildScorecard({ rows: ROWS.slice(0, 2), me: 1, name, current: { ...current, handNo: 2 } }).rows).toHaveLength(2);
  });

  it('Get Your Bid: the players\' own points and totals, the Forbidden Bid named', () => {
    const row = { handNo: 9, handSize: 5, trump: H('clubs'), dealer: 3, bids: ['2', '1', '1'], took: [2, 0, 3], points: [12, 0, 0], scores: [40, 21, 7], faults: [], forbidden: { position: 3, bid: 2 } };
    const m = buildScorecard({ rows: [row], solo: true, me: 1, name });
    expect(m.rows[0].cells.map((c) => [c.bid, c.took, c.extra, c.fault, c.forbidden])).toEqual([
      ['2', 2, false, false, null], ['1', 0, false, false, null], ['1', 3, true, false, 2],
    ]);
    expect(m.rows[0].scores.map((s) => [s.total, s.delta])).toEqual([[40, 12], [21, 0], [7, 0]]);
    expect(m.rows[0].spoken).toContain('hal bid 1, took 3, 2 extra, forbidden bid 2.');
  });
});

describe('GameState keeps the server\'s rows', () => {
  it('null before the server says it keeps one; [] from the deal; rows from handComplete, a snapshot and gameEnd', () => {
    const gs = new GameState();
    gs.gameId = 'g1';
    expect(gs.scorecard).toBeNull();
    gs.applyDeal({ gameId: 'g1', currentHand: 12, dealer: 4, hand: [], trump: H('hearts') });
    expect(gs.scorecard).toBeNull(); // an older server: no key
    gs.applyDeal({ gameId: 'g1', currentHand: 12, dealer: 4, hand: [], trump: H('hearts'), scorecardRows: 0 });
    expect(gs.scorecard).toEqual([]);
    gs.applyHandComplete({ score: { team1: 51, team2: 33 }, scorecardRow: ROWS[0] });
    expect(gs.scorecard).toEqual([ROWS[0]]);
    gs.applyHandComplete({ score: { team1: 51, team2: 33 }, scorecardRow: { bad: true } });
    expect(gs.scorecard).toHaveLength(1);
    gs.applyDeal({ gameId: 'g1', currentHand: 10, dealer: 1, hand: [], trump: H('spades'), scorecardRows: 2 });
    expect(gs.scorecardBehind).toBe(true);
    gs.applyGameEnd({ score: { team1: 182, team2: -143 }, scorecard: ROWS });
    expect(gs.scorecard).toEqual(ROWS);
    // another game's deal starts a new card
    gs.applyDeal({ gameId: 'g2', currentHand: 12, dealer: 1, hand: [], trump: H('spades'), scorecardRows: 0 });
    expect(gs.scorecard).toEqual([]);
  });

  it('the hand in play: the deal\'s size, trump, dealer and the bids so far', () => {
    const gs = new GameState();
    gs.applyDeal({ gameId: 'g1', currentHand: 8, dealer: 4, hand: [], trump: H('diamonds'), scorecardRows: 2 });
    gs.bids = { 1: '1', 3: 'B' };
    expect(gs.scorecardCurrent()).toEqual({ handNo: 3, handSize: 8, trump: H('diamonds'), dealer: 4, bids: ['1', null, 'B', null] });
    gs.stage = 'ENDED';
    expect(gs.scorecardCurrent()).toBeNull();
  });
});
