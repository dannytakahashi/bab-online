/**
 * Per-player seat pips (owner, 2026-11-11) on the real page and scene,
 * replaying a recorded 4-human game for seat 1 (events-humans-s13: an
 * opponent bores, a zero redeal, /lazy, a resign): at every live checkpoint
 * each seat's ring shows its own bid and its own tricks as the server counts
 * them (snapshot tricksByPosition), a bore seat its team's tricks out of the
 * hand; and both trick piles carry the server's team totals (a bore is the
 * whole hand) and their safe / danger border. The rejoin and spectator
 * views: seatPipsRejoin.test.js, seatPipsSpectator.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let run;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-humans-s13');
  page = await replay.realTablePage({ username: 'ios_bea' });
  run = replay.replayPips(page, rec, 'seat1');
});

afterAll(() => vi.useRealTimers());

describe('recorded 4-human game, seat 1', () => {
  it('every seat shows its own count at every live checkpoint; the bore seat its team\'s tricks out of the hand', () => {
    const { results, bad } = run;
    expect(results.length).toBeGreaterThan(100);
    expect(bad.slice(0, 3)).toEqual([]);
    // the bore hand was checked, and partners showed different pips somewhere
    expect(results.some((r) => r.bores > 0 && r.live[2][0] > 0)).toBe(true);
    expect(results.some((r) => JSON.stringify(r.live[1]) !== JSON.stringify(r.live[3]))).toBe(true);
  });

  it('the opponents\' bore (B + 4 on 12 cards) totals the whole hand: their pile stays "danger" past the partner\'s 4', () => {
    const bore = run.results.filter((r) => r.bores > 0);
    expect(bore.length).toBeGreaterThan(0);
    expect(bore.every((r) => r.piles.opp === 12)).toBe(true);
    // with 4+ tricks the old total (the bore as 0, so 4) already read "safe"
    const pastFour = bore.filter((r) => r.piles.won[1] >= 4 && r.piles.won[1] < 12);
    expect(pastFour.length).toBeGreaterThan(0);
    expect(pastFour.every((r) => r.piles.borders.opp === 'danger')).toBe(true);
  });
});
