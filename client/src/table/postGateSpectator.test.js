/**
 * The recorded spectator (events-bots-s12) on the POST-GATE wire: its full
 * state is {snapshot} only (V1_REMOVALS #9, and the self-only half of #8),
 * the room notice stays {username, spectatorCount}. The page routes on the
 * snapshot, enters the table as a spectator and matches every checkpoint.
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
  const { postGateRecording } = await import('../testing/postGateWire.js');
  rec = postGateRecording(replay.loadRecording('events-bots-s12'));
  page = await replay.realTablePage({ username: 'ios_fan' });
});

afterAll(() => vi.useRealTimers());

describe('post-gate wire: a spectator joining mid-hand', () => {
  it('a snapshot-only full state enters the table as a spectator', () => {
    const [join, notice] = rec.logs.spectator;
    expect(Object.keys(join.data)).toEqual(['snapshot']);
    expect(notice.data.snapshot).toBeUndefined();
    page.socket.fire('spectatorJoined', JSON.parse(JSON.stringify(join.data)));
    replay.advance(50);
    expect(page.session.role).toBe('spectator');
    expect(page.session.gameId).toBe(join.data.snapshot.gameId);
    expect(replay.liveCounts(page.scene)).toEqual(replay.expectedCounts(join.data.snapshot));
    const header = document.getElementById('gameLogScore').textContent;
    expect(header).toContain(`${join.data.snapshot.seats[0].username}/${join.data.snapshot.seats[2].username}`);
  });

  it('…the notice is only a log line, and the table matches to the game end', () => {
    const { results, bad } = replay.replayViewer(page, rec, 'spectator', { from: 1 });
    expect(results.length).toBeGreaterThan(100);
    expect(bad).toEqual([]);
    expect(page.session.screen).toBe('gameEnd');
  });
});
