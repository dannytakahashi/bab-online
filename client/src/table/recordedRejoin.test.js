/**
 * A recorded 1-human + 3-bot game (events-bots-s12, real server handlers)
 * replayed through the real page: handlers, SeqGate, GameState, the
 * TableDirector and the REAL GameScene and managers (testing/fakePhaser.js).
 *
 *   - At every live-table checkpoint the scene shows what the server's
 *     snapshot says (hand, opponent backs, trick, stacked cards).
 *   - Mid-hand the socket dies and the recorded rejoinSuccess lands on the
 *     LIVE scene (cli-4): sprite counts, the whole display list and the log
 *     rows equal a fresh render of the same snapshot (teardown + render).
 *   - The rest of the game replays on, to gameEnd, still matching.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let rec;
let replay;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  const container = document.createElement('div');
  container.id = 'game-container';
  document.body.appendChild(container);
  const { loadPage } = await import('../testing/fakePage.js');
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s12');
  page = await loadPage({ realScene: true, session: { username: 'ios_ann', sessionToken: 'tok-ann' }, connected: true, socketId: 'ios-h1' });
  page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', blockedUsers: [] });
});

afterAll(() => {
  vi.useRealTimers();
});

/** Compare the scene with each checkpoint's snapshot just before the entry it precedes. */
function checkAt(viewer) {
  const byIndex = new Map(replay.tableCheckpoints(rec, viewer).map((c) => [c.afterIndex, c]));
  const results = [];
  const check = (i) => {
    const cp = byIndex.get(i);
    if (!cp) return;
    if (page.scene.director.waiting > 0) return; // the deal still waits for a fade / whisk
    results.push({ i, stage: cp.snapshot.stage, live: replay.liveCounts(page.scene), want: replay.expectedCounts(cp.snapshot) });
  };
  return { before: (entry) => check(entry.i), check, results };
}

describe('recorded game: live play, a rejoin onto the live scene, play on', () => {
  let rejoinLive;

  it('the live table matches the server snapshot at every checkpoint (no seq gaps)', () => {
    const log = rec.logs.seat1;
    const check = checkAt('seat1');
    replay.replayLog(page, log, { before: check.before });
    expect(check.results.length).toBeGreaterThan(20);
    const bad = check.results.filter((r) => JSON.stringify(r.live) !== JSON.stringify(r.want));
    expect(bad).toEqual([]);
    expect(page.socket.emitted('requestSnapshot').filter((d) => String(d.requestId).startsWith('gap-'))).toEqual([]);
  });

  it('the recorded rejoinSuccess on the live scene draws exactly its snapshot (cli-4)', () => {
    const r = rec.logs['seat1-rejoin'];
    const rejoin = r[0];
    expect(rejoin.event).toBe('rejoinSuccess');
    const snap = rejoin.data.snapshot;
    // The table is mid-trick and animated; the socket dies and comes back
    replay.advance(150);
    page.socket.reconnect('ios-h1-r1');
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    expect(page.socket.emitted('rejoinGame').at(-1)).toMatchObject({ gameId: rec.gameId });
    page.socket.fire('rejoinSuccess', JSON.parse(JSON.stringify(rejoin.data)));
    replay.advance(50);

    const scene = page.scene;
    expect(replay.liveCounts(scene)).toEqual(replay.expectedCounts(snap));
    // the log is the server's (73 lines) plus one 'Reconnected to game!'
    expect(replay.logRows()).toBe(snap.log.length + 1);
    // the trump is face up, no flip pending
    expect(scene.tableCardSprite.texture.key).toBe('cards');
    rejoinLive = {
      counts: scene.tableCounts(),
      census: scene.census(),
      rows: replay.logRows(),
      bubbles: document.querySelectorAll('.opponent-avatar-container').length,
    };
    expect(scene.director.pending()).toBe(0);
  });

  it('…and equals a fresh render of the same snapshot (teardown, new scene, same rejoinSuccess)', async () => {
    const { EXIT } = await import('../state/ClientSession.js');
    const rejoin = rec.logs['seat1-rejoin'][0];
    page.session.exitTable(EXIT.TABLE_LOST, { route: false });
    replay.advance(50); // the scene restarts
    expect(page.scene.liveObjects()).toHaveLength(0);
    expect(document.getElementById('gameFeed')).toBeNull();
    page.socket.reconnect('ios-h1-r2');
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', JSON.parse(JSON.stringify(rejoin.data)));
    replay.advance(50);
    const scene = page.scene;
    expect({
      counts: scene.tableCounts(),
      census: scene.census(),
      rows: replay.logRows(),
      bubbles: document.querySelectorAll('.opponent-avatar-container').length,
    }).toEqual(rejoinLive);
  });

  it('the rest of the game replays to gameEnd and still matches every checkpoint', () => {
    const log = rec.logs['seat1-rejoin'];
    const check = checkAt('seat1-rejoin');
    replay.replayLog(page, log, { from: 1, before: check.before });
    expect(check.results.length).toBeGreaterThan(20);
    const bad = check.results.filter((r) => JSON.stringify(r.live) !== JSON.stringify(r.want));
    expect(bad).toEqual([]);
    expect(page.session.screen).toBe('gameEnd');
    expect(document.getElementById('finalScoreOverlay')).not.toBeNull();
  });
});
