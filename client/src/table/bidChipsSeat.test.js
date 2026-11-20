/**
 * The game log's bid chips row for a seat player at seat 2 (team B, coral:
 * events-humans-s13 seat2, an all-zero redeal among its deals): my team's
 * chips first in coral, the other team's in blue, at every live checkpoint
 * (replay.replayChips against the server's bids).
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
  page = await replay.realTablePage({ username: 'ios_cal', socketId: 'ios-p2' });
});

afterAll(() => vi.useRealTimers());

describe('bid chips row, seat 2', () => {
  it('matches the server at every live checkpoint, the redeal included', () => {
    expect(rec.logs.seat2.some((e) => e.event === 'destroyHands')).toBe(true);
    const { results, bad } = replay.replayChips(page, rec, 'seat2');
    expect(bad.slice(0, 3)).toEqual([]);
    expect(results.length).toBeGreaterThan(20);
    // my team (seats 2/4) first, in team B's colour
    expect(results.some((r) => r.live.startsWith('b'))).toBe(true);
  });
});
