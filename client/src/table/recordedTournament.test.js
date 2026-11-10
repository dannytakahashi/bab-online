/**
 * A recorded tournament (events-tournament-s15, seat 1: rounds 1 and 2,
 * each a new table with its own seq from 1): the seq gate takes each new
 * table's baseline (no gap, no stale drop of round 2), and both games match
 * the server at every live checkpoint.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-tournament-s15');
  page = await replay.realTablePage({ username: 'ios_tia' });
});

afterAll(() => vi.useRealTimers());

describe('recorded tournament, two rounds', () => {
  it('both tables match every live checkpoint; the gate never drops round 2', async () => {
    const { results, bad } = replay.replayViewer(page, rec, 'seat1');
    expect(results.length).toBeGreaterThan(250);
    expect(bad).toEqual([]);
    const { getSeqGate } = await import('../state/SeqGate.js');
    expect(getSeqGate().stats.dropped).toBe(0);
    expect(getSeqGate().stats.gaps).toBe(0);
  });
});
