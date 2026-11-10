import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MyAction, ACK_TIMEOUT_MS, OUTCOME } from './MyAction.js';

const A = { suit: 'spades', rank: 'A' };
const K = { suit: 'hearts', rank: 'K' };

/** A snapshot of my seat (position 2) with `hand` and the bid at my seat. */
const snap = ({ hand = [A, K], myBid = null, canAct = true } = {}) => ({
  hand,
  viewer: { role: 'seat', position: 2, canAct },
  bids: { byPosition: [null, myBid, null, null] },
});

describe('MyAction (idle -> pending -> confirmed | rolled back)', () => {
  let action;
  let emits;
  let requests;
  let reconnects;

  afterEach(() => {
    // an earlier test's timers must not fire into the next one
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    emits = [];
    requests = [];
    reconnects = 0;
    action = new MyAction({
      emit: (e, d) => emits.push([e, d]),
      requestSnapshot: (id) => requests.push(id),
      forceReconnect: () => { reconnects++; },
    });
  });

  it('one outstanding action: a second submit is refused until the first settles', () => {
    expect(action.submitPlay(A, 2)).toBe(true);
    expect(action.submitPlay(K, 2)).toBe(false);
    expect(action.submitBid('3', 2)).toBe(false);
    expect(emits).toEqual([['playCard', { card: A, position: 2 }]]);
    expect(action.pendingCard).toEqual(A);
    expect(action.state).toBe('pending');
  });

  it('my own echo confirms it (a play by cardPlayed, a bid by bidReceived)', () => {
    action.submitPlay(A, 2);
    expect(action.confirm('bid')).toBeNull();
    expect(action.confirm('play')).toBe(OUTCOME.CONFIRMED);
    expect(action.state).toBe('idle');
    action.submitBid('b', 2);
    expect(emits.at(-1)).toEqual(['playerBid', { position: 2, bid: 'b' }]);
    expect(action.pending.bid).toBe('B');
    expect(action.confirm('bid')).toBe(OUTCOME.CONFIRMED);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS * 3);
    expect(requests).toEqual([]);
  });

  it('actionRejected for its kind rolls it back; another kind does not', () => {
    action.submitPlay(A, 2);
    expect(action.reject({ action: 'bid' })).toBeNull();
    expect(action.reject({ action: 'play', reason: 'not_your_turn' })).toBe(OUTCOME.ROLLED_BACK);
    expect(action.history.at(-1)).toMatchObject({ outcome: 'rolledBack', reason: 'not_your_turn' });
  });

  it('a snapshot reconciles: the card gone from my hand = taken; still there = rolled back', () => {
    action.submitPlay(A, 2);
    expect(action.reconcile(snap({ hand: [K] }), 'ack')).toBe(OUTCOME.CONFIRMED);
    action.submitPlay(A, 2);
    expect(action.reconcile(snap(), 'ack')).toBe(OUTCOME.ROLLED_BACK);
    action.submitBid('3', 2);
    expect(action.reconcile(snap({ myBid: '3' }), 'rejoin')).toBe(OUTCOME.CONFIRMED);
  });

  it('a gap resync that still shows my turn keeps it pending (it may be in flight)', () => {
    action.submitPlay(A, 2);
    expect(action.reconcile(snap(), 'gap')).toBe(OUTCOME.KEPT);
    expect(action.state).toBe('pending');
    expect(action.reconcile(snap({ canAct: false }), 'gap')).toBe(OUTCOME.ROLLED_BACK);
  });

  it('5 s without an answer asks for a snapshot; a second silence reconnects, never a blind rollback', () => {
    action.submitPlay(A, 2);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1);
    expect(requests).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(requests).toEqual([`ack-${action.pending.reqId}`]);
    expect(action.state).toBe('pending');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    expect(reconnects).toBe(1);
    expect(action.state).toBe('pending');
    // the rejoin's snapshot decides
    expect(action.reconcile(snap({ hand: [K] }), 'rejoin')).toBe(OUTCOME.CONFIRMED);
  });

  it('reset drops it and its timer (an exit, a new deal)', () => {
    action.submitPlay(A, 2);
    action.reset();
    vi.advanceTimersByTime(ACK_TIMEOUT_MS * 2);
    expect(requests).toEqual([]);
    expect(action.state).toBe('idle');
  });
});
