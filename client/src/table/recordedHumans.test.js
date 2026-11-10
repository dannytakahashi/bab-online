/**
 * A recorded 4-human game (events-humans-s13: a spectator, an all-zero
 * redeal, a bore, rejected plays and bids, /lazy then /active, a resigned
 * seat) replayed for seat 1 through the real page and scene: the table
 * equals the server's snapshot at every live checkpoint, the recorded
 * actionRejected snapshots included, and the seq gate never sees a gap.
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
  rec = replay.loadRecording('events-humans-s13');
  page = await replay.realTablePage({ username: 'ios_bea' });
});

afterAll(() => vi.useRealTimers());

describe('recorded 4-human game, seat 1', () => {
  it('matches every live checkpoint to the game end', async () => {
    const { results, bad } = replay.replayViewer(page, rec, 'seat1');
    expect(results.length).toBeGreaterThan(150);
    expect(bad).toEqual([]);
    expect(page.session.screen).toBe('gameEnd');
    const { getSeqGate } = await import('../state/SeqGate.js');
    expect(getSeqGate().stats.gaps).toBe(0);
    expect(page.socket.emitted('requestSnapshot')).toEqual([]);
  });
});
