/**
 * The game log's bid chips row for a tournament spectator
 * (events-tournament-s15: spectatorJoined mid-play): the row matches the
 * server's bids at every live checkpoint through every later deal.
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
  page = await replay.realTablePage({ username: 'ios_tom', socketId: 'ios-tspec' });
});

afterAll(() => vi.useRealTimers());

describe('bid chips row, tournament spectator', () => {
  it('matches the server at every live checkpoint', () => {
    expect(rec.logs.spectator[0].event).toBe('spectatorJoined');
    const { results, bad } = replay.replayChips(page, rec, 'spectator');
    expect(page.session.role).toBe('spectator');
    expect(bad.slice(0, 3)).toEqual([]);
    expect(results.length).toBeGreaterThan(100);
    expect(new Set(results.filter((r) => r.live !== 'hidden').map((r) => r.handNo)).size).toBeGreaterThanOrEqual(8);
  });
});
