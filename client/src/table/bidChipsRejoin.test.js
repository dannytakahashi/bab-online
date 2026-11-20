/**
 * The game log's bid chips row after a rejoin (events-humans-s13
 * seat2-rejoin: rejoinSuccess mid-bidding): the snapshot draws the row,
 * then it follows the bids and every later deal (seat 2: coral first).
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
  page = await replay.realTablePage({ username: 'ios_cal', socketId: 'ios-p2-r1' });
});

afterAll(() => vi.useRealTimers());

describe('bid chips row after a rejoin', () => {
  it('matches the server at every live checkpoint', () => {
    expect(rec.logs['seat2-rejoin'][0].event).toBe('rejoinSuccess');
    const { results, bad } = replay.replayChips(page, rec, 'seat2-rejoin');
    expect(bad.slice(0, 3)).toEqual([]);
    expect(results.length).toBeGreaterThan(100);
  });
});
