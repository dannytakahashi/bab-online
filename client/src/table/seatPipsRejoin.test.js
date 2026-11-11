/**
 * Per-player seat pips after a reload (events-bots-s12 seat1-rejoin: the
 * page comes back mid-game from rejoinSuccess's snapshot v2, whose
 * tricksByPosition gives each seat's count; the opponents bid B and 2B on
 * one hand, so both their rings show the team's target).
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
  rec = replay.loadRecording('events-bots-s12');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1-r1' });
});

afterAll(() => vi.useRealTimers());

describe('per-player pips after a rejoin', () => {
  it('match the server at every live checkpoint, both bores of a hand included', () => {
    const log = rec.logs['seat1-rejoin'];
    expect(log[0].event).toBe('rejoinSuccess');
    expect(log[0].data.snapshot.tricksByPosition).toHaveLength(4);
    const { results, bad } = replay.replayPips(page, rec, 'seat1-rejoin');
    expect(results.length).toBeGreaterThan(50);
    expect(bad.slice(0, 3)).toEqual([]);
    // the B + 2B hand: both opponents' rings show the hand size
    const both = results.filter((r) => r.bores === 2 && r.live[2][0] > 0);
    expect(both.length).toBeGreaterThan(0);
    expect(both.every((r) => r.live[2][0] === r.live[4][0] && r.live[2][1] === r.live[4][1])).toBe(true);
  });
});
