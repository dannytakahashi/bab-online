/**
 * The avatar badges on a seat's real page (owner 2026-11-23: the /help
 * lightbulb, the tutorial's graduation cap; state/seatBadges.js): the
 * recorded four-human game events-humans-s13 as seat 2 (ios_cal), with the
 * server's help notices and tutorial tags fired at its turns:
 *  - a help notice lights that seat's lightbulb with one pop, the seat's
 *    name and "asked for help this turn" as its title and label; its own bid
 *    (or card) puts it out; never on my own seat;
 *  - the tutorial's tag puts the cap on (one pop) and off; the cap wins
 *    over a lightbulb; a redeal clears the lightbulb, never the cap;
 *  - a reload (rejoinSuccess) draws both from the snapshot's seats, still
 *    (no pop), and the next bid of that seat puts the lightbulb out.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let log;
let at = 0;
const popped = [];
const copy = (v) => JSON.parse(JSON.stringify(v));

beforeAll(async () => {
  // jsdom has no Web Animations: record each pop (the element and its keyframes)
  HTMLElement.prototype.animate = function animate(frames, opts) {
    popped.push({ el: this, frames, opts });
    return { cancel() {} };
  };
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-humans-s13');
  log = rec.logs.seat2;
  page = await replay.realTablePage({ username: 'ios_cal', socketId: 'ios-p2' });
});

afterAll(() => {
  delete HTMLElement.prototype.animate;
  vi.useRealTimers();
});

const name = (p) => page.gameState.getPlayerNameByPosition(p);
const ring = (p) => document.querySelector(`.opponent-avatar-container .hud-avatar-ring[data-position="${p}"]`);
const badgeOf = (p) => ring(p)?.querySelector('.hud-seat-badge');
const shown = () => Object.fromEntries([...document.querySelectorAll('.hud-seat-badge[data-badge]')]
  .map((b) => [b.closest('.hud-avatar-ring').dataset.position, b.dataset.badge]));
const helpNotice = (p) => ({ message: `${name(p)} used /help.`, type: 'system', help: { position: p } });
const tutorialLine = (p, on) => ({ message: on ? `${name(p)} turned on the tutorial.` : `${name(p)} turned off the tutorial.`, type: 'system', tutorial: { position: p, on } });

/** Replay seat 2's log up to (not including) the first entry from `at` that matches. */
function upTo(match) {
  const i = log.findIndex((e, k) => k >= at && e.dir === 's2c' && match(e));
  expect(i, 'entry not found').toBeGreaterThanOrEqual(0);
  replay.replayLog(page, log, { from: at, to: i });
  replay.advance(50);
  at = i;
  return log[i];
}
/** Fire the next entry (the one upTo stopped at). */
function step() {
  replay.replayLog(page, log, { from: at, to: at + 1, settle: false });
  replay.advance(50);
  at++;
}
const turnOf = (p) => (e) => e.event === 'updateTurn' && e.data.currentTurn === p;
const bidOf = (p) => (e) => e.event === 'bidReceived' && e.data.position === p;

describe('the avatar badges at a seat (ios_cal, seat 2)', () => {
  it('a help notice lights that seat\'s lightbulb, with one pop; its bid puts it out', () => {
    upTo(turnOf(3));
    step();
    expect(page.session.role).toBe('player');
    expect(shown()).toEqual({});
    popped.length = 0;
    page.socket.fire('gameLogEntry', helpNotice(3));
    replay.advance(50);
    expect(shown()).toEqual({ 3: 'help' });
    const b = badgeOf(3);
    expect(b.title).toBe(`${name(3)}, asked for help this turn`);
    expect(b.getAttribute('aria-label')).toBe(`${name(3)}, asked for help this turn`);
    expect(b.getAttribute('role')).toBe('img');
    // the gold log row is the notice's, as before
    expect(document.querySelector('#gameFeedMessages .log-row.is-help')?.textContent).toContain(`${name(3)} used /help.`);
    // one pop: up a little and settle, ~250 ms
    expect(popped.map((p) => p.el)).toEqual([b]);
    expect(popped[0].frames.some((f) => /scale\(1\.\d+\)/.test(f.transform || ''))).toBe(true);
    expect(popped[0].opts.duration).toBeGreaterThanOrEqual(200);
    expect(popped[0].opts.duration).toBeLessThanOrEqual(300);
    // the same notice again (a duplicate) neither changes nor pops it
    page.socket.fire('gameLogEntry', helpNotice(3));
    replay.advance(50);
    expect(popped).toHaveLength(1);
    upTo(bidOf(3));
    expect(shown()).toEqual({ 3: 'help' });
    step();
    expect(shown()).toEqual({});
    expect(b.hasAttribute('title')).toBe(false);
    expect(b.hasAttribute('aria-label')).toBe(false);
  });

  it('never on my own seat: my own notice leaves my box as it is', () => {
    // (the next deal's turn of mine: the redeal)
    upTo(turnOf(2));
    step();
    page.socket.fire('gameLogEntry', helpNotice(2));
    replay.advance(50);
    expect(page.gameState.helpAsked).toEqual({ 2: true });
    const mine = document.querySelector('#player-avatar-container .hud-seat-badge');
    expect(mine).not.toBeNull();
    expect(mine.dataset.badge).toBeUndefined();
    expect(shown()).toEqual({});
  });

  it('the tutorial\'s tag puts the cap on (one pop) and it stays through turns and bids; the cap wins over a lightbulb', () => {
    popped.length = 0;
    page.socket.fire('gameLogEntry', tutorialLine(4, true));
    replay.advance(50);
    expect(shown()).toEqual({ 4: 'tutorial' });
    expect(badgeOf(4).title).toBe(`${name(4)}, tutorial on`);
    expect(badgeOf(4).getAttribute('aria-label')).toBe(`${name(4)}, tutorial on`);
    expect(popped.map((p) => p.el)).toEqual([badgeOf(4)]);
    upTo(turnOf(4));
    step();
    // (a tutorial's /help is never counted: were both known, the cap shows)
    page.socket.fire('gameLogEntry', helpNotice(4));
    replay.advance(50);
    expect(shown()).toEqual({ 4: 'tutorial' });
    upTo(bidOf(4));
    step();
    expect(shown()).toEqual({ 4: 'tutorial' });
  });

  it('a lightbulb goes with the bidding\'s end; the cap does not', () => {
    upTo(turnOf(1));
    step();
    page.socket.fire('gameLogEntry', helpNotice(1));
    replay.advance(50);
    expect(shown()).toEqual({ 1: 'help', 4: 'tutorial' });
    upTo((e) => e.event === 'doneBidding');
    // seat 1's bid comes first: its own bid puts its lightbulb out
    expect(shown()).toEqual({ 4: 'tutorial' });
    step();
    expect(shown()).toEqual({ 4: 'tutorial' });
  });

  it('a card played puts the lightbulb out; the off tag takes the cap off (no pop)', () => {
    upTo(turnOf(3));
    step();
    page.socket.fire('gameLogEntry', helpNotice(3));
    replay.advance(50);
    expect(shown()).toEqual({ 3: 'help', 4: 'tutorial' });
    upTo((e) => e.event === 'cardPlayed' && e.data.position === 3);
    step();
    expect(shown()).toEqual({ 4: 'tutorial' });
    popped.length = 0;
    page.socket.fire('gameLogEntry', tutorialLine(4, false));
    replay.advance(50);
    expect(shown()).toEqual({});
    expect(popped).toEqual([]);
    // a plain line (the stored form, a replay) changes nothing
    page.socket.fire('gameLogEntry', { message: `${name(4)} turned on the tutorial.`, type: 'system' });
    replay.advance(50);
    expect(shown()).toEqual({});
  });

  it('a reload draws both from the snapshot\'s seats, still; the seat\'s bid puts the lightbulb out, the cap stays', () => {
    replay.replayLog(page, log, { from: at });
    replay.advance(500);
    const rejoin = copy(rec.logs['seat2-rejoin'][0].data);
    expect(rejoin.snapshot.stage).toBe('BIDDING');
    const turn = rejoin.snapshot.turn.position;
    expect(turn).not.toBe(2);
    rejoin.snapshot.seats[turn - 1].askedHelp = true;
    rejoin.snapshot.seats[2].tutorial = true;
    // my own seat's keys draw nothing on my box
    rejoin.snapshot.seats[1].tutorial = true;
    popped.length = 0;
    page.socket.reconnect('ios-p2-r1');
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_cal', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', rejoin);
    replay.advance(200);
    expect(shown()).toEqual({ [turn]: 'help', 3: 'tutorial' });
    expect(popped).toEqual([]);
    const rl = rec.logs['seat2-rejoin'];
    const bid = rl.findIndex((e) => e.event === 'bidReceived' && e.data.position === turn);
    replay.replayLog(page, rl, { from: 1, to: bid + 1 });
    replay.advance(50);
    expect(shown()).toEqual({ 3: 'tutorial' });
    expect(popped).toEqual([]);
  });

  it('a later snapshot without the keys (a resync\'s, the same game) takes both off', () => {
    const rl = rec.logs['seat2-rejoin'];
    const bid = rl.findIndex((e) => e.event === 'bidReceived' && e.data.position === rl[0].data.snapshot.turn.position);
    const cp = rec.checkpoints.filter((c) => c.viewer === 'seat2-rejoin' && c.afterIndex <= bid + 1).at(-1);
    expect(cp.snapshot.seats.some((st) => 'tutorial' in st || 'askedHelp' in st)).toBe(false);
    page.socket.fire('stateSnapshot', { snapshot: copy(cp.snapshot), requestId: 'gap-9' });
    replay.advance(200);
    expect(shown()).toEqual({});
    expect(page.gameState.tutorialSeats).toEqual({});
  });
});
