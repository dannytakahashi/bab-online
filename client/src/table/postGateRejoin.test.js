/**
 * A recorded lazy rejoin (events-presence-s21, seat3-rejoin = ios_di: the
 * rejoinSuccess of a lazy watcher, /active, restorePlayerState) on the
 * POST-GATE wire, where both carriers are {snapshot} (+ tournamentId) only
 * (V1_REMOVALS #9): the role and the game come from the snapshot and the
 * table matches every live checkpoint to the game end.
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
  rec = postGateRecording(replay.loadRecording('events-presence-s21'));
  const first = rec.logs['seat3-rejoin'][0];
  expect(first.event).toBe('rejoinSuccess');
  expect(Object.keys(first.data).sort()).toEqual(['snapshot', 'tournamentId']);
  page = await replay.realTablePage({ username: 'ios_di', session: { gameId: rec.gameId } });
});

afterAll(() => vi.useRealTimers());

describe('post-gate wire: a lazy rejoin, /active, to the game end', () => {
  it('the snapshot-only rejoinSuccess seats a lazy watcher of the right game', () => {
    page.socket.fire('rejoinSuccess', JSON.parse(JSON.stringify(rec.logs['seat3-rejoin'][0].data)));
    replay.advance(50);
    expect(page.session.role).toBe('lazy');
    expect(page.session.gameId).toBe(rec.gameId);
    expect(sessionStorage.getItem('gameId')).toBe(rec.gameId);
    expect(page.gameState.position).toBe(3);
  });

  it('…then the snapshot-only restorePlayerState after /active, and every checkpoint', () => {
    const { results, bad } = replay.replayViewer(page, rec, 'seat3-rejoin', { from: 1 });
    expect(results.length).toBeGreaterThan(100);
    expect(bad).toEqual([]);
    expect(page.session.screen).toBe('gameEnd');
  });
});
