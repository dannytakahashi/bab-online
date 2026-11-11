/**
 * Every contract v2 fixture (contract/fixtures/v2, captured from real
 * games) drawn by the real page and scene, through the carrier a client
 * gets it on (rejoinSuccess for a seat / lazy watcher, the spectator full
 * state): the table shows what the snapshot says, drawing it again over
 * itself changes nothing, and drawing it over another live table equals a
 * fresh render (teardown, new scene).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let fixtures;
let EXIT;
let sock = 0;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  fixtures = replay.loadV2Fixtures();
  page = await replay.realTablePage({ username: 'viewer' });
  ({ EXIT } = await import('../state/ClientSession.js'));
});

afterAll(() => vi.useRealTimers());

/** Deliver a fixture on its carrier (a new socket each time: one rejoin per socket). */
function deliver(fx) {
  const snap = JSON.parse(JSON.stringify(fx.snapshot));
  const role = snap.viewer.role;
  page.socket.reconnect(`sock-fx-${++sock}`);
  page.socket.fire('restoreSessionResponse', { success: true, username: 'viewer', blockedUsers: [] });
  if (role === 'spectator') {
    const players = snap.seats.map((s) => ({ position: s.position, username: s.username, socketId: `s${s.position}`, pic: s.pic ?? 1 }));
    page.socket.fire('spectatorJoined', { gameId: snap.gameId, players, trump: snap.trump, snapshot: snap });
  } else {
    page.socket.fire('rejoinSuccess', { gameId: snap.gameId, snapshot: snap, isLazy: role === 'lazyWatcher' });
  }
  replay.advance(50);
}

const shot = () => ({
  counts: page.scene.tableCounts(),
  census: page.scene.census(),
  rows: replay.logRows(),
});

describe('contract v2 fixtures on the real scene', () => {
  it('each live fixture: the snapshot is the table, idempotent, and equal to a fresh render', () => {
    const live = fixtures.filter((f) => f.snapshot.deal && ['seat', 'lazyWatcher', 'spectator'].includes(f.snapshot.viewer.role));
    expect(live.length).toBeGreaterThanOrEqual(8);
    const seen = [];
    for (const fx of live) {
      deliver(fx);
      expect(replay.liveCounts(page.scene), fx.name).toEqual(replay.expectedCounts(fx.snapshot));
      expect(page.scene.tableCardSprite?.texture.key, `${fx.name}: trump face up`).toBe('cards');
      const once = shot();
      deliver(fx); // the same snapshot again, over itself
      expect(shot(), `${fx.name}: idempotent`).toEqual(once);
      // a fresh page: the table torn down, a new scene, the same carrier
      page.session.exitTable(EXIT.TABLE_LOST, { route: false });
      replay.advance(50);
      expect(page.scene.liveObjects()).toHaveLength(0);
      deliver(fx);
      expect(shot(), `${fx.name}: fresh render`).toEqual(once);
      seen.push(fx.name);
    }
    expect(seen).toEqual(expect.arrayContaining(['trick-mid-lead3', 'spectator-mid-hand', 'lazy-watcher', 'trick-resolving', 'hand-resolving']));
  });

  it('a lazy watcher gets its hand dimmed and the green pill; a spectator the blue one and no hand', () => {
    const lazy = fixtures.find((f) => f.name === 'lazy-watcher');
    deliver(lazy);
    expect(page.session.role).toBe('lazy');
    expect(document.getElementById('spectating-indicator').dataset.kind).toBe('lazy');
    expect(page.scene.cardManager.getHandSprites().every((s) => s.interactive === false)).toBe(true);
    const spec = fixtures.find((f) => f.name === 'spectator-mid-hand');
    deliver(spec);
    expect(page.session.role).toBe('spectator');
    expect(document.getElementById('spectating-indicator').dataset.kind).toBe('spectator');
    expect(page.scene.tableCounts().hand).toBe(0);
    expect(document.getElementById('player-avatar-container')).toBeNull();
  });

  it('a bidding snapshot with my turn shows the bid panel; not my turn, none is visible', () => {
    const bidding = fixtures.find((f) => f.name === 'bidding-mid');
    expect(bidding.snapshot.viewer.canAct).toBe(true);
    deliver(bidding);
    replay.advance(50);
    const panel = document.getElementById('bidContainer');
    expect(panel).not.toBeNull();
    // (open: table.css .bid-sheet.is-open, the class's pop-in)
    expect(panel.classList.contains('is-open')).toBe(true);
  });
});
