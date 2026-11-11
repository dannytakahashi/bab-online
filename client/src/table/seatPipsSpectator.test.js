/**
 * Per-player seat pips for a pure spectator (events-bots-s12 spectator:
 * joins mid-game from the full state's snapshot, views from seat 1): all
 * four seats by their absolute positions, at every live checkpoint.
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
  page = await replay.realTablePage({ username: 'ios_fan' });
});

afterAll(() => vi.useRealTimers());

describe('per-player pips, spectator', () => {
  it('every seat matches the server at every live checkpoint', () => {
    const { results, bad } = replay.replayPips(page, rec, 'spectator');
    expect(page.session.role).toBe('spectator');
    expect(results.length).toBeGreaterThan(50);
    expect(bad.slice(0, 3)).toEqual([]);
    expect(results.some((r) => r.bores > 0)).toBe(true);
    // the four rings are there (the bottom seat included)
    expect(Object.keys(results.at(-1).live).sort()).toEqual(['1', '2', '3', '4']);
  });
});
