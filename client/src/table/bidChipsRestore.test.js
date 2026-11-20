/**
 * The game log's bid chips row for seat 4 (events-humans-s13 seat3: a
 * restorePlayerState rebuild among its deals, a redeal): the row is the
 * deal's after the rebuild too, at every live checkpoint.
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
  page = await replay.realTablePage({ username: 'ios_dee', socketId: 'ios-p3' });
});

afterAll(() => vi.useRealTimers());

describe('bid chips row, seat 4 with a restorePlayerState rebuild', () => {
  it('matches the server at every live checkpoint', () => {
    expect(rec.logs.seat3.some((e) => e.event === 'restorePlayerState')).toBe(true);
    const { results, bad } = replay.replayChips(page, rec, 'seat3');
    expect(bad.slice(0, 3)).toEqual([]);
    expect(results.length).toBeGreaterThan(30);
  });
});
