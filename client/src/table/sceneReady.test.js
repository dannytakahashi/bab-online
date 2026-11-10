/**
 * webclient-2: events that arrive before GameScene.create() (a cold cache
 * on a slow link: the scene is still loading its assets) are buffered by
 * the TableDirector, never dropped. A recorded game (events-bots-s12, seat
 * 1) runs from the draw into the first hand's play with no scene; when the
 * scene is created the draw replays, and the table is exactly the server's
 * (one render of the model settles the late events): no black overlay left.
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  const container = document.createElement('div');
  container.id = 'game-container';
  document.body.appendChild(container);
  const { loadPage } = await import('../testing/fakePage.js');
  page = await loadPage({ realScene: true, createScene: false, session: { username: 'ios_ann', sessionToken: 'tok' }, connected: true, socketId: 'ios-h1' });
  page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', blockedUsers: [] });
});

afterAll(() => vi.useRealTimers());

describe('table events before the scene exists', () => {
  it('are buffered in order and shown once the scene is created', async () => {
    const log = rec.logs.seat1;
    const cps = rec.checkpoints.filter((c) => c.viewer === 'seat1' && c.snapshot.stage === 'PLAYING' && c.snapshot.trick.cards.length > 0);
    const target = cps[0];
    replay.replayLog(page, log, { to: target.afterIndex });
    const { getTableDirector } = await import('../phaser/TableDirector.js');
    const director = getTableDirector();
    expect(director.ready).toBe(false);
    const queued = director.queued;
    expect(queued).toBeGreaterThan(10); // startDraw ... cardPlayed, none dropped
    expect(page.session.screen).toBe('table');

    page.createScene();
    replay.advance(100);
    expect(director.queued).toBe(0);
    expect(director.stats.flushed).toBe(queued);
    expect(replay.liveCounts(page.scene)).toEqual(replay.expectedCounts(target.snapshot));
    expect(page.scene.tableCardSprite.texture.key).toBe('cards');
    expect(document.getElementById('transition-overlay')).toBeNull();
    expect(document.getElementById('gameFeed')).not.toBeNull();
    // and the game goes on live from here, matching the server
    const rest = replay.replayViewer(page, rec, 'seat1', { from: target.afterIndex });
    expect(rest.bad).toEqual([]);
  });
});
