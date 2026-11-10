import { describe, it, expect } from 'vitest';
import { snapshotFromLegacy, playOrder } from './legacySnapshot.js';
import { tableSnapshotOf } from './tableSync.js';

const players = ['me', 'b', 'c', 'd'].map((username, i) => ({ position: i + 1, username, socketId: `s${i}`, pic: i + 1 }));

describe('snapshotFromLegacy (a v1 table payload without a snapshot)', () => {
  it('opponents hold the deal size minus the tricks played minus a card in the trick (webclient-8)', () => {
    const snap = snapshotFromLegacy({
      gameId: 'g', position: 1, currentHand: 8, trump: { suit: 'clubs', rank: '2' },
      hand: new Array(5).fill(0).map((_, i) => ({ suit: 'hearts', rank: String(i + 2) })),
      tricks: { team1: 2, team2: 1 }, playerBids: ['2', '1', '3', '1'], bidding: false,
      playedCards: [null, null, { suit: 'spades', rank: 'A' }, { suit: 'spades', rank: 'K' }],
      leadPosition: 3, currentTurn: 1, players,
    });
    expect(snap.seats.map((s) => s.cardsInHand)).toEqual([5, 5, 4, 4]);
    expect(snap.trick.cards.map((c) => c.position)).toEqual([3, 4]);
    expect(snap.trick.number).toBe(4);
    expect(snap.stage).toBe('PLAYING');
    expect(snap.turn).toEqual({ position: 1, action: 'play' });
    expect(snap.viewer).toMatchObject({ role: 'seat', position: 1, canAct: true });
    expect(snap.seq).toBeNull();
  });

  it('play order follows the lead around the table', () => {
    const cards = [{ suit: 'a', rank: '1' }, null, { suit: 'c', rank: '3' }, { suit: 'd', rank: '4' }];
    expect(playOrder(cards, 3).map((c) => c.position)).toEqual([3, 4, 1]);
    expect(playOrder(cards).map((c) => c.position)).toEqual([1, 3, 4]);
  });

  it('a spectator payload has no hand; a lazy one is a lazy watcher', () => {
    expect(snapshotFromLegacy({ players, trump: { suit: 'clubs', rank: '2' }, currentHand: 3 }, { role: 'spectator' }).hand).toBeNull();
    expect(snapshotFromLegacy({ position: 2, isLazy: true, hand: [], players, trump: { suit: 'clubs', rank: '2' } }).viewer.role).toBe('lazyWatcher');
  });

  it('tableSnapshotOf prefers a valid v2 snapshot, else falls back to the v1 fields', () => {
    const v1 = { position: 1, hand: [], trump: { suit: 'clubs', rank: '2' }, players };
    expect(tableSnapshotOf(v1).seq).toBeNull();
    expect(tableSnapshotOf({ ...v1, snapshot: { v: 2, broken: true } }).seq).toBeNull();
    expect(tableSnapshotOf({ reason: 'x' })).toBeNull();
  });
});
