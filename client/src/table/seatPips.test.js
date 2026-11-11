/**
 * Per-player seat pips (owner, 2026-11-11) on the real page and scene,
 * replaying a recorded 4-human game for seat 1 (events-humans-s13: an
 * opponent bores, a zero redeal, /lazy, a resign): at every live checkpoint
 * each seat's ring shows its own bid and its own tricks as the server counts
 * them (snapshot tricksByPosition), a bore seat its team's tricks out of the
 * hand. The rejoin and spectator views: seatPipsRejoin.test.js.
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

describe('per-player pips, recorded 4-human game, seat 1', () => {
  it('every seat shows its own count at every live checkpoint; the bore seat its team\'s tricks out of the hand', () => {
    const { results, bad } = replay.replayPips(page, rec, 'seat1');
    expect(results.length).toBeGreaterThan(100);
    expect(bad.slice(0, 3)).toEqual([]);
    // the bore hand was checked, and partners showed different pips somewhere
    expect(results.some((r) => r.bores > 0 && r.live[2][0] > 0)).toBe(true);
    expect(results.some((r) => JSON.stringify(r.live[1]) !== JSON.stringify(r.live[3]))).toBe(true);
  });
});
