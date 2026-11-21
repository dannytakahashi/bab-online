/**
 * The over-the-shoulder view through a deal, a bid clock and a paused table,
 * on the real page (events-bots-s14's recorded spectator watching seat 1,
 * ios_ann; the server's shoulder payloads built from seat 1's own log, as a
 * spectator with the clientHello cap shoulderView receives them):
 *  - the next deal's gameStart.shoulder deals seat 1's new hand, read-only,
 *    with its HSI; a deal without it asks again (watchHand);
 *  - the watched seat's bid clock shows as a pill (no bid sheet);
 *  - the paused rule: "Game paused: ..." keeps the seat with no stale cards,
 *    a snapshot without viewer.shoulder does not end the watch, and
 *    "Game resumed." sends watchHand again; its reply brings the hand back.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let gs;
let setBidClockNow;
const copy = (v) => JSON.parse(JSON.stringify(v));

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_fan', socketId: 'ios-spec' });
  gs = (await import('../state/GameState.js')).getGameState();
  ({ setBidClockNow } = await import('../state/bidClock.js'));
  setBidClockNow(() => Date.now());
});

afterAll(() => {
  setBidClockNow?.(null);
  vi.useRealTimers();
});

const log = () => rec.logs.spectator;
const seatDealAt = (t) => rec.logs.seat1.find((e) => e.event === 'gameStart' && e.t === t);
const handCount = () => page.scene.cardManager.getHandCount();
const pill = () => document.getElementById('spectating-indicator');
const watchSent = () => page.socket.emitted('watchHand');
const nextDeal = () => log().findIndex((e, i) => i > 0 && e.event === 'gameStart');

function replyFor(snapshot, position, hand, hsi) {
  const snap = copy(snapshot);
  snap.viewer = { ...snap.viewer, shoulder: { position, hand: copy(hand), hsi } };
  snap.partial = ['log'];
  return { snapshot: snap, reason: 'watchHand' };
}

describe('watching seat 1 through a deal, a bid clock and a pause', () => {
  it('joins, watches seat 1 and is served its hand', () => {
    const joined = log()[0];
    page.socket.fire('spectatorJoined', copy(joined.data));
    replay.advance(100);
    expect(watchSent()).toEqual([{ gameId: rec.gameId, position: 1 }]);
    const deal = seatDealAt(joined.t);
    page.socket.fire('stateSnapshot', replyFor(joined.data.snapshot, 1, deal.data.hand, deal.data.hsiValues[1]));
    replay.advance(200);
    expect(handCount()).toBe(deal.data.hand.length);
  });

  it('the next deal\'s gameStart.shoulder deals seat 1\'s new hand, read-only, with its HSI', () => {
    const i = nextDeal();
    replay.replayLog(page, log(), { from: 1, to: i });
    replay.advance(100);
    page.socket.clearEmits();
    const e = log()[i];
    const own = seatDealAt(e.t);
    const data = { ...copy(e.data), shoulder: { position: 1, hand: copy(own.data.hand), hsi: own.data.hsiValues[1] } };
    page.socket.fire('gameStart', data);
    // the whisk, the deal, the HSI a beat after
    replay.advance(4000);
    expect(gs.myCards).toEqual(own.data.hand);
    expect(handCount()).toBe(own.data.hand.length);
    const sprites = page.scene.cardManager._handSprites.filter((s) => s.active !== false);
    expect(sprites.every((s) => s.interactive === false)).toBe(true);
    expect(document.getElementById('player-hsi-box').textContent).toBe(`HSI: ${own.data.hsiValues[1].toFixed(1)}`);
    // the watched seat's read-only sheet, up after the trump's flip (open on its turn)
    expect(page.scene.tableCounts().bidPanel).toBe(true);
    expect(document.getElementById('bidContainer').classList.contains('bid-sheet--readonly')).toBe(true);
    // it was served: nothing to ask
    expect(watchSent()).toEqual([]);
  });

  it('the watched seat\'s bid clock counts on its read-only sheet (never announced); its bid takes the sheet down', () => {
    // another seat's turn and clock: the sheet is closed, no countdown
    page.socket.fire('updateTurn', { currentTurn: 2 });
    page.socket.fire('bidClock', { gameId: rec.gameId, position: 2, running: true, inMs: 30000, durationMs: 30000 });
    const sheet = () => document.getElementById('bidContainer');
    const clock = () => sheet()?.querySelector('.bid-sheet__clock') || null;
    expect(sheet().classList.contains('is-open')).toBe(false);
    expect(clock()).toBeNull();
    page.socket.fire('bidClock', { gameId: rec.gameId, position: 2, running: false, reason: 'bid' });
    // seat 1's turn: open, its countdown
    const said = document.querySelector('#table-hud > .hud-announcer')?.textContent || '';
    page.socket.fire('updateTurn', { currentTurn: 1 });
    page.socket.fire('bidClock', { gameId: rec.gameId, position: 1, running: true, inMs: 30000, durationMs: 30000 });
    expect(sheet().classList.contains('is-open')).toBe(true);
    expect(clock().textContent).toBe('30');
    expect(clock().getAttribute('aria-label')).toBe('ios_ann: 30 seconds to bid');
    replay.advance(21000);
    expect(clock().textContent).toBe('9');
    expect(clock().classList.contains('bid-sheet__clock--low')).toBe(true);
    expect(document.querySelector('#table-hud > .hud-announcer')?.textContent || '').not.toMatch(/seconds to bid/);
    void said;
    // its bid: the sheet goes; nothing was ever sent
    page.socket.clearEmits();
    page.socket.fire('bidClock', { gameId: rec.gameId, position: 1, running: false, reason: 'bid' });
    page.socket.fire('bidReceived', { position: 1, bid: '2' });
    replay.advance(300);
    expect(sheet()).toBeNull();
    expect(page.socket.emitted('playerBid')).toEqual([]);
  });

  it('a pause keeps the seat, shows its hand area as paused, and never shows stale cards', () => {
    page.socket.clearEmits();
    page.socket.fire('gameLogEntry', { message: 'Game paused: the server is reconnecting. It will resume on its own.', type: 'system' });
    replay.advance(100);
    expect(gs.shoulder).toEqual({ position: 1, paused: true });
    expect(handCount()).toBe(0);
    expect(document.querySelector('#table-hud > .hud-shoulder-paused')?.textContent).toBe("Paused: ios_ann's hand comes back when the game resumes.");
    expect(pill().textContent).toContain("Watching ios_ann's hand · paused");
    // a snapshot without viewer.shoulder (the table serves nothing now) keeps it, and asks again
    const snap = copy(log()[0].data.snapshot);
    page.socket.fire('stateSnapshot', { snapshot: snap, requestId: 'ping-9' });
    replay.advance(100);
    expect(gs.shoulder).toEqual({ position: 1, paused: true });
    expect(handCount()).toBe(0);
    expect(watchSent()).toEqual([{ gameId: rec.gameId, position: 1 }]);
    // the server says so too: unavailable keeps it
    page.socket.fire('watchHandRefused', { gameId: rec.gameId, position: 1, reason: 'unavailable', message: 'This table is paused right now. Try again when it resumes.' });
    replay.advance(50);
    expect(gs.shoulder).toEqual({ position: 1, paused: true });
  });

  it('"Game resumed." sends watchHand again; the reply brings the hand back', () => {
    page.socket.clearEmits();
    page.socket.fire('gameLogEntry', { message: 'Game resumed.', type: 'system' });
    expect(watchSent()).toEqual([{ gameId: rec.gameId, position: 1 }]);
    const deal = seatDealAt(log()[nextDeal()].t);
    page.socket.fire('stateSnapshot', replyFor(log()[0].data.snapshot, 1, deal.data.hand, deal.data.hsiValues[1]));
    replay.advance(200);
    expect(gs.shoulder).toEqual({ position: 1, paused: false });
    expect(handCount()).toBe(deal.data.hand.length);
    expect(document.querySelector('#table-hud > .hud-shoulder-paused')).toBeNull();
    expect(pill().textContent).not.toContain('paused');
  });

  it('a deal without the watched hand (the server forgot the watch) asks for it again', () => {
    page.socket.clearEmits();
    const i = log().findIndex((e, k) => k > nextDeal() && e.event === 'gameStart');
    replay.replayLog(page, log(), { from: nextDeal() + 1, to: i + 1 });
    replay.advance(100);
    expect(watchSent()).toEqual([{ gameId: rec.gameId, position: 1 }]);
    expect(gs.myCards).toEqual([]);
  });

  it('the game\'s end drops the selection: the plain spectator view under the score modal', () => {
    page.socket.fire('gameEnd', { score: { team1: 100, team2: 50 }, playerStats: null, tournamentId: null });
    replay.advance(100);
    expect(gs.shoulder).toBeNull();
    expect(gs.position).toBe(1);
    expect(gs.isSpectator).toBe(true);
  });
});
