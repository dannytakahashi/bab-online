/**
 * A recorded presence game (events-presence-s21): seat 1's owner rejoins as
 * the lazy watcher of their seat and later goes /active (restorePlayerState
 * rebuilds it in place). The page starts from the recorded rejoinSuccess and
 * matches every live checkpoint to the game end.
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
  rec = replay.loadRecording('events-presence-s21');
  page = await replay.realTablePage({ username: 'ios_cy', session: { gameId: rec.gameId } });
});

afterAll(() => vi.useRealTimers());

describe('recorded lazy watcher, /active, to the game end', () => {
  it('matches every live checkpoint', () => {
    const { results, bad } = replay.replayViewer(page, rec, 'seat1-rejoin');
    expect(results.length).toBeGreaterThan(100);
    expect(bad).toEqual([]);
    expect(page.session.screen).toBe('gameEnd');
  });
});
