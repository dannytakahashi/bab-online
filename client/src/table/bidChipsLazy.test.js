/**
 * The game log's bid chips row for a seat that goes /lazy (a bot plays it:
 * the lazy watcher, ownerView) and back with /active (events-humans-s13
 * seat4, at seat 3): the row stays the seat's own (seats 1/3 first, blue)
 * through the lazy hands and after /active, at every live checkpoint.
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
  page = await replay.realTablePage({ username: 'ios_eli', socketId: 'ios-p4' });
});

afterAll(() => vi.useRealTimers());

describe('bid chips row, a seat through /lazy and /active', () => {
  it('matches the server at every live checkpoint', () => {
    const log = rec.logs.seat4;
    expect(log.some((e) => e.event === 'playerLazyMode')).toBe(true);
    expect(log.some((e) => e.event === 'playerActiveMode')).toBe(true);
    const lazyAt = new Set(rec.checkpoints.filter((c) => c.viewer === 'seat4' && c.snapshot?.viewer?.role === 'lazyWatcher').map((c) => c.afterIndex));
    const { results, bad } = replay.replayChips(page, rec, 'seat4');
    expect(bad.slice(0, 3)).toEqual([]);
    expect(results.length).toBeGreaterThan(150);
    // checked while lazy, too
    expect(results.filter((r) => lazyAt.has(r.i) && r.live !== 'hidden').length).toBeGreaterThan(5);
    expect(page.session.screen).toBe('gameEnd');
  });
});
