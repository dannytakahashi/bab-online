/**
 * The bid sheet's bore buttons on the real page and scene (owner report
 * 2026-11-11: "both members of the other team did a bore and double bore
 * and it was my turn to bid ... not sure if triple bore was grayed out (it
 * should be available)").
 *
 * events-bots-s12, seat 1, the first deal (bidder 2: opp 2, partner 3,
 * opp 4, then me) up to its first updateTurn; from there the bids are
 * server-shaped events (seq in order, the bot's raw bid, bidArray) for each
 * variant, and each variant ends in a redeal (destroyHands + the deal's
 * gameStart again), so the next one also covers "a redeal earlier in the
 * game". The rule (docs/RULES.md, rules.isValidBid): 2B needs a B on the
 * table, 3B a 2B, 4B a 3B; the sheet also greys B once a B is down and a
 * level once it is down.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let log;
let gate;
let dealStart;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  log = replay.loadRecording('events-bots-s12').logs.seat1;
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
  gate = (await import('../state/SeqGate.js')).getSeqGate();
  dealStart = log.findIndex((e) => e.event === 'gameStart');
  const firstTurn = log.findIndex((e, i) => i > dealStart && e.event === 'updateTurn');
  expect(log[dealStart].data.dealer).toBe(1);
  expect(log[firstTurn].data.currentTurn).toBe(2);
  replay.replayLog(page, log, { to: firstTurn + 1 });
  replay.advance(4000); // the first hand's fade, the deal, the trump flip: the sheet is built
});

afterAll(() => vi.useRealTimers());

const clone = (x) => JSON.parse(JSON.stringify(x));
const nextSeq = () => gate.lastSeq + 1;
const sheet = () => page.scene.bidManager.bidContainer;

/** What the sheet shows: open, and each bore button's state. */
function bores() {
  const bm = page.scene.bidManager;
  const out = { open: !!sheet()?.classList.contains('is-open') };
  for (const b of ['B', '2B', '3B', '4B']) {
    const btn = bm.boreButtons[b];
    expect(btn, `${b} button`).toBeTruthy();
    expect(btn.isConnected).toBe(true);
    out[b] = btn.disabled ? 'off' : 'on';
  }
  // the visible sheet is this manager's (no stale second sheet)
  expect(document.querySelectorAll('#bidContainer')).toHaveLength(1);
  return out;
}

const bidArray = [];
/** A bot's (or another player's) bid as the server broadcasts it. */
function bid(position, value) {
  bidArray[position - 1] = String(value).toUpperCase();
  page.socket.fire('bidReceived', { bid: value, position, bidArray: [...bidArray].map((b) => b ?? null), seq: nextSeq() });
  replay.advance(50);
}
function turn(position) {
  page.socket.fire('updateTurn', { currentTurn: position, seq: nextSeq() });
  replay.advance(50);
}
/** Every bid 0: destroyHands, the redeal's gameStart, its first turn (bidder 2). */
function redeal() {
  bidArray.length = 0;
  page.socket.fire('destroyHands', { seq: nextSeq() });
  page.socket.fire('gameStart', { ...clone(log[dealStart].data), seq: nextSeq() });
  replay.advance(4000);
  turn(2);
}

describe('the owner\'s sequence: the opponents bore and double-bore, then my turn', () => {
  it('before any bore: B on, the escalations off', () => {
    expect(page.gameState.position).toBe(1);
    expect(sheet()).toBeTruthy();
    expect(bores()).toEqual({ open: false, B: 'on', '2B': 'off', '3B': 'off', '4B': 'off' });
  });

  it.each([
    ['partner bids 0 between them', '0'],
    ['partner bids a number between them (bots send numbers as numbers)', 3],
  ])('opp B, %s, opp 2B: 3B is on at my turn (and clickable)', (_name, partnerBid) => {
    bid(2, 'B');
    turn(3);
    expect(bores()).toMatchObject({ open: false, B: 'off', '2B': 'on', '3B': 'off' });
    bid(3, partnerBid);
    turn(4);
    // the sheet is already built (hidden) when the 2B arrives
    bid(4, '2B');
    expect(bores()).toMatchObject({ open: false, '3B': 'on' });
    turn(1);
    expect(bores()).toEqual({ open: true, B: 'off', '2B': 'off', '3B': 'on', '4B': 'off' });

    // a relayout, a render and a tab-return fast-forward keep it
    page.scene.relayout();
    replay.advance(50);
    expect(bores()).toEqual({ open: true, B: 'off', '2B': 'off', '3B': 'on', '4B': 'off' });
    page.scene.render();
    replay.advance(100);
    expect(bores()).toEqual({ open: true, B: 'off', '2B': 'off', '3B': 'on', '4B': 'off' });
    page.scene.director.fastForward('visible');
    replay.advance(100);
    expect(bores()).toEqual({ open: true, B: 'off', '2B': 'off', '3B': 'on', '4B': 'off' });

    // a click sends 3B
    page.socket.clearEmits();
    page.scene.bidManager.boreButtons['3B'].click();
    expect(page.socket.emitted('playerBid').map((d) => d.bid)).toEqual(['3B']);
    redeal();
  });

  it('after the redeals nothing of the earlier deals is left: B on again', () => {
    expect(page.gameState.tempBids).toEqual([]);
    expect(bores()).toEqual({ open: false, B: 'on', '2B': 'off', '3B': 'off', '4B': 'off' });
  });

  it('partner bores, the opponent double-bores: 3B is on for me too', () => {
    bid(2, '1');
    turn(3);
    bid(3, 'B');
    turn(4);
    bid(4, '2B');
    turn(1);
    expect(bores()).toEqual({ open: true, B: 'off', '2B': 'off', '3B': 'on', '4B': 'off' });
    redeal();
  });

  it('4B follows the same rule: on once a 3B is down', () => {
    bid(2, 'B');
    turn(3);
    bid(3, '2B');
    turn(4);
    bid(4, '3B');
    turn(1);
    expect(bores()).toEqual({ open: true, B: 'off', '2B': 'off', '3B': 'off', '4B': 'on' });
    redeal();
  });

  it('a single B: 2B on, B off; lowercase bids from the wire count the same', () => {
    bid(2, 'b');
    turn(3);
    bid(3, '0');
    turn(4);
    bid(4, '0');
    turn(1);
    expect(bores()).toEqual({ open: true, B: 'off', '2B': 'on', '3B': 'off', '4B': 'off' });
    redeal();
    bid(2, 'b');
    turn(3);
    bid(3, '0');
    turn(4);
    bid(4, '2b');
    turn(1);
    expect(bores()).toEqual({ open: true, B: 'off', '2B': 'off', '3B': 'on', '4B': 'off' });
  });

  it('the bores arrive while the redeal is still being dealt (before the sheet exists): 3B on once it shows', () => {
    bidArray.length = 0;
    page.socket.fire('destroyHands', { seq: nextSeq() });
    page.socket.fire('gameStart', { ...clone(log[dealStart].data), seq: nextSeq() });
    replay.advance(50);
    expect(sheet()).toBeFalsy();
    turn(2);
    bid(2, 'B');
    turn(3);
    bid(3, '0');
    turn(4);
    bid(4, '2B');
    turn(1);
    expect(sheet()).toBeFalsy(); // the trump has not flipped yet
    replay.advance(4000);
    expect(bores()).toEqual({ open: true, B: 'off', '2B': 'off', '3B': 'on', '4B': 'off' });
  });
});
