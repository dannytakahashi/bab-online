/**
 * The game log's bid chips row for a spectator who joins mid-hand
 * (events-bots-s12: spectatorJoined at BIDDING, the full state's
 * snapshot): the row is drawn from the snapshot at once, then follows
 * every bid, trick and deal live to the game end (replay.replayChips
 * against the server's bids; seats 1/3 blue first).
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
  page = await replay.realTablePage({ username: 'ios_fan', socketId: 'ios-spec' });
});

afterAll(() => vi.useRealTimers());

describe('bid chips row, spectator joining mid-hand', () => {
  it('the join draws the row; every later checkpoint matches the server', () => {
    const join = rec.logs.spectator[0];
    expect(join.event).toBe('spectatorJoined');
    expect(join.data.snapshot.stage).toBe('BIDDING');
    page.socket.fire('spectatorJoined', JSON.parse(JSON.stringify(join.data)));
    replay.advance(50);
    expect(page.session.role).toBe('spectator');
    expect(replay.liveChips()).toBe(replay.expectedChips(join.data.snapshot));
    expect(replay.liveChips()).not.toBe('hidden');
    const { results, bad } = replay.replayChips(page, rec, 'spectator', { from: 1 });
    expect(bad.slice(0, 3)).toEqual([]);
    expect(results.length).toBeGreaterThan(100);
    expect(new Set(results.filter((r) => r.live !== 'hidden').map((r) => r.handNo)).size).toBeGreaterThanOrEqual(8);
    expect(page.session.screen).toBe('gameEnd');
  });
});
