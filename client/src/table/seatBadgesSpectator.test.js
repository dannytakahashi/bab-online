/**
 * The avatar badges as a spectator sees them (owner 2026-11-23;
 * state/seatBadges.js), on the real page: events-bots-s14's recorded
 * spectator (ios_fan; ios_ann at seat 1 with three bots):
 *  - the plain table view: the bottom seat (seat 1) is an avatar like the
 *    others and gets its lightbulb from the live notice, with the pop; its
 *    bid puts it out;
 *  - over the shoulder (the watchHand reply, seat 1): the watched seat's box
 *    is that player's, not mine, so it carries the seat's badge, from the
 *    reply's seats without a pop, and the live tag takes it off.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
const popped = [];
const copy = (v) => JSON.parse(JSON.stringify(v));

beforeAll(async () => {
  HTMLElement.prototype.animate = function animate(frames, opts) {
    popped.push({ el: this, frames, opts });
    return { cancel() {} };
  };
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_fan', socketId: 'ios-spec' });
});

afterAll(() => {
  delete HTMLElement.prototype.animate;
  vi.useRealTimers();
});

const log = () => rec.logs.spectator;
const shown = () => Object.fromEntries([...document.querySelectorAll('.hud-seat-badge[data-badge]')]
  .map((b) => [`${b.closest('#player-avatar-container, .opponent-avatar-container').id}:${b.closest('.hud-avatar-ring').dataset.position}`, b.dataset.badge]));

describe('the avatar badges for a spectator (ios_fan)', () => {
  it('the plain view: the bottom seat\'s lightbulb from the live notice, with the pop; its bid puts it out', () => {
    page.socket.fire('spectatorJoined', copy(log()[0].data));
    replay.advance(200);
    expect(page.session.role).toBe('spectator');
    const turn = log().findIndex((e) => e.event === 'updateTurn' && e.data.currentTurn === 1);
    replay.replayLog(page, log(), { from: 1, to: turn + 1 });
    replay.advance(100);
    expect(shown()).toEqual({});
    page.socket.fire('gameLogEntry', { message: 'ios_ann used /help.', type: 'system', help: { position: 1 } });
    replay.advance(50);
    expect(shown()).toEqual({ 'opponent-avatar-bottom:1': 'help' });
    const b = document.querySelector('#opponent-avatar-bottom .hud-seat-badge');
    expect(b.getAttribute('aria-label')).toBe('ios_ann, asked for help this turn');
    expect(popped.map((p) => p.el)).toEqual([b]);
    replay.replayLog(page, log(), { from: turn + 1, to: turn + 2 });
    replay.advance(50);
    expect(log()[turn + 1].event).toBe('bidReceived');
    expect(shown()).toEqual({});
  });

  it('over the shoulder: the watched seat\'s box carries its badge, from the reply\'s seats, still; the tag takes it off', () => {
    const join = log()[0];
    const deal = rec.logs.seat1.find((e) => e.event === 'gameStart' && e.t === join.t);
    const snap = copy(join.data.snapshot);
    snap.viewer = { ...snap.viewer, shoulder: { position: 1, hand: copy(deal.data.hand), hsi: null } };
    snap.partial = ['log'];
    snap.seats[0].tutorial = true;
    popped.length = 0;
    page.socket.fire('stateSnapshot', { snapshot: snap, reason: 'watchHand' });
    replay.advance(200);
    expect(page.gameState.shoulder).toEqual({ position: 1, paused: false });
    expect(document.getElementById('player-avatar-container')?.dataset.username).toBe('ios_ann');
    expect(shown()).toEqual({ 'player-avatar-container:1': 'tutorial' });
    expect(document.querySelector('#player-avatar-container .hud-seat-badge').title).toBe('ios_ann, tutorial on');
    expect(popped).toEqual([]);
    page.socket.fire('gameLogEntry', { message: 'ios_ann turned off the tutorial.', type: 'system', tutorial: { position: 1, on: false } });
    replay.advance(50);
    expect(shown()).toEqual({});
  });
});
