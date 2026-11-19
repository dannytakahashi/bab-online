/**
 * Deploy survival (LIVE_PERSIST=on, deploy-survival PR 5) on the real page: a recorded
 * 1-human + 3-bot game (events-bots-s12, real server handlers) replayed through the
 * handlers, SeqGate, GameState and the REAL GameScene (testing/fakePhaser.js), then a
 * deploy the game survives:
 *
 *   - serverShutdown at once (the restart banner; restartNotice records the seat), then
 *     the old instance's outcome line "The server is updating. This game will continue in
 *     a few seconds." (a room gameLogEntry), then the transport closes;
 *   - the new instance adopted the game: hydrate restarts its eventSeq at the saved seq +
 *     1000 (server/game/persist/gameCodec.js), so the rejoinSuccess snapshot's seq jumped
 *     by 1000 and its log carries "This game resumed after a server update.";
 *   - the page lands on the table it had, with no "game ended" toast and the record gone,
 *     and the rest of the game (every room event 1000 higher) applies with no seq gap.
 *
 * With an old server (no handoff) nothing here applies: the restore finds the game gone
 * and says so once (reload/serverRestart.test.js).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const CONTINUE = 'The server is updating. This game will continue in a few seconds.';
const RESUMED = 'This game resumed after a server update.';
// hydrate's offset (the plan's 2.2: eventSeq = saved + 1000)
const OFFSET = 1000;

let page;
let rec;
let replay;
let restart;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  const container = document.createElement('div');
  container.id = 'game-container';
  document.body.appendChild(container);
  const { loadPage } = await import('../testing/fakePage.js');
  replay = await import('../testing/replay.js');
  restart = await import('../state/restartNotice.js');
  rec = replay.loadRecording('events-bots-s12');
  page = await loadPage({ realScene: true, session: { username: 'ios_ann', sessionToken: 'tok-ann' }, connected: true, socketId: 'ios-h1' });
  page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', blockedUsers: [] });
});

afterAll(() => {
  vi.useRealTimers();
});

const restartToasts = () => [...document.querySelectorAll('.kit-toast__text')]
  .map((t) => t.textContent)
  .filter((t) => Object.values(restart.RESTART_LOSS_TEXT).includes(t));
const gapRequests = () => page.socket.emitted('requestSnapshot').filter((d) => String(d.requestId).startsWith('gap-'));
const logTexts = () => [...document.querySelectorAll('#gameFeed .log-row__text')].map((r) => r.textContent);

/** A recorded entry as the adopting instance sends it: every seq OFFSET higher. */
function shifted(entry) {
  const copy = JSON.parse(JSON.stringify(entry));
  if (copy.data && Number.isInteger(copy.data.seq)) copy.data.seq += OFFSET;
  if (copy.data?.snapshot && Number.isInteger(copy.data.snapshot.seq)) copy.data.snapshot.seq += OFFSET;
  return copy;
}

describe('a deploy the game survives (handoff): the recorded game on the real page', () => {
  let lastSeq;

  it('plays live up to the deploy', () => {
    replay.replayLog(page, rec.logs.seat1);
    expect(page.session.screen).toBe('table');
    lastSeq = Math.max(...rec.logs.seat1.filter((e) => Number.isInteger(e.data?.seq)).map((e) => e.data.seq));
    expect(gapRequests()).toEqual([]);
  });

  it('serverShutdown, the "continue" line, the close; the restore with seq +1000 lands with no "ended" toast', () => {
    page.socket.fire('serverShutdown', { message: 'Server is restarting, please reconnect shortly' });
    expect(restart.getRestartNotice().pending).toBe(restart.LOSS.SEAT);
    // the old instance's line, after its flush (sequenced like every room broadcast)
    page.socket.fire('gameLogEntry', { message: CONTINUE, type: 'system', seq: lastSeq + 1 });
    replay.advance(1000);
    expect(logTexts()).toContain(CONTINUE);

    page.socket.reconnect('ios-h1-deploy');
    expect(page.socket.emitted('restoreSession').at(-1)).toEqual({ username: 'ios_ann', sessionToken: 'tok-ann' });
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    expect(page.socket.emitted('rejoinGame').at(-1)).toMatchObject({ gameId: rec.gameId, username: 'ios_ann' });

    const data = shifted(rec.logs['seat1-rejoin'][0]);
    expect(data.event).toBe('rejoinSuccess');
    const snap = data.data.snapshot;
    snap.log.push({ message: RESUMED, type: 'system', position: null, at: snap.serverTime });
    expect(snap.seq).toBeGreaterThan(lastSeq + OFFSET);
    page.socket.fire('rejoinSuccess', data.data);
    replay.advance(50);

    expect(page.session.screen).toBe('table');
    expect(replay.liveCounts(page.scene)).toEqual(replay.expectedCounts(snap));
    // the snapshot's log is the table's log now: the "resumed" line, no error line
    expect(logTexts()).toContain(RESUMED);
    expect(restartToasts()).toEqual([]);
    expect(restart.getRestartNotice().pending).toBeNull();
    expect(gapRequests()).toEqual([]);
  });

  it('the rest of the game, every seq 1000 higher, applies with no gap to gameEnd, still matching', () => {
    const log = rec.logs['seat1-rejoin'].map(shifted);
    const byIndex = new Map(replay.tableCheckpoints(rec, 'seat1-rejoin').map((c) => [c.afterIndex, c]));
    const results = [];
    replay.replayLog(page, log, {
      from: 1,
      before: (entry) => {
        const cp = byIndex.get(entry.i);
        if (!cp || page.scene.director.waiting > 0) return;
        results.push({ i: entry.i, live: replay.liveCounts(page.scene), want: replay.expectedCounts(cp.snapshot) });
      },
    });
    expect(results.length).toBeGreaterThan(20);
    expect(results.filter((r) => JSON.stringify(r.live) !== JSON.stringify(r.want))).toEqual([]);
    expect(gapRequests()).toEqual([]);
    expect(page.session.screen).toBe('gameEnd');
    expect(restartToasts()).toEqual([]);
  });
});
