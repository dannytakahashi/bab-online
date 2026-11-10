import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SeqGate, GAP_TIMEOUT_MS } from './SeqGate.js';

describe('SeqGate (contract R1-R5)', () => {
  let gate;
  let requests;
  let applied;
  const ev = (event, seq, extra = {}) => gate.admit(event, { seq, ...extra }, () => applied.push(`${event}#${seq}`));

  afterEach(() => {
    // an earlier test's timers must not fire into the next one
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    requests = [];
    applied = [];
    gate = new SeqGate({ requestSnapshot: (id) => requests.push(id) });
  });

  it('the first sequenced event is the baseline; next applies, stale drops', () => {
    expect(ev('cardPlayed', 10)).toBe('applied');
    expect(ev('updateTurn', 11)).toBe('applied');
    expect(ev('updateTurn', 11)).toBe('stale');
    expect(ev('cardPlayed', 9)).toBe('stale');
    expect(applied).toEqual(['cardPlayed#10', 'updateTurn#11']);
    expect(gate.stats.dropped).toBe(2);
  });

  it('unsequenced events always apply, in arrival order, even during a gap', () => {
    ev('cardPlayed', 1);
    ev('updateTurn', 3); // gap
    gate.admit('actionRejected', { action: 'play' }, () => applied.push('actionRejected'));
    expect(applied).toEqual(['cardPlayed#1', 'actionRejected']);
  });

  it('a gap buffers, asks once, and the snapshot replays only what is above it', () => {
    ev('cardPlayed', 1);
    expect(ev('trickComplete', 4)).toBe('gap');
    expect(ev('updateTurn', 5)).toBe('gap');
    expect(ev('updateTurn', 3)).toBe('gap');
    expect(requests).toEqual(['gap-1']);
    expect(gate.buffered).toBe(3);
    expect(applied).toEqual(['cardPlayed#1']);
    gate.onSnapshot({ gameId: 'g', seq: 3 });
    expect(applied).toEqual(['cardPlayed#1', 'trickComplete#4', 'updateTurn#5']);
    expect(gate.lastSeq).toBe(5);
    expect(gate.buffered).toBe(0);
    // the next gap asks again
    ev('cardPlayed', 9);
    expect(requests).toEqual(['gap-1', 'gap-2']);
  });

  it('no snapshot within the timeout: the buffer applies in order anyway', () => {
    ev('cardPlayed', 1);
    ev('updateTurn', 4);
    ev('cardPlayed', 3);
    vi.advanceTimersByTime(GAP_TIMEOUT_MS);
    expect(applied).toEqual(['cardPlayed#1', 'cardPlayed#3', 'updateTurn#4']);
    expect(gate.resyncId).toBeNull();
  });

  it('a snapshot is always applied (R3): any snapshot sets the baseline, even an older one', () => {
    ev('cardPlayed', 20);
    gate.onSnapshot({ gameId: 'g', seq: 18 });
    expect(gate.lastSeq).toBe(18);
    expect(ev('updateTurn', 19)).toBe('applied');
  });

  it('a new game restarts the count: startDraw, a gameStart for another game, after gameEnd / abortGame', () => {
    ev('handComplete', 700);
    expect(ev('startDraw', 1)).toBe('applied');
    expect(ev('positionUpdate', 2)).toBe('applied');
    ev('gameStart', 3, { gameId: 'g1' });
    expect(ev('gameStart', 1, { gameId: 'g2' })).toBe('applied');
    ev('gameEnd', 2);
    expect(gate.lastSeq).toBeNull();
    expect(ev('startDraw', 1)).toBe('applied');
    ev('abortGame', 2);
    expect(ev('positionUpdate', 1)).toBe('applied');
  });
});
