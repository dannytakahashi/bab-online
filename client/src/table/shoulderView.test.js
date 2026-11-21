/**
 * The over-the-shoulder view on the real page (docs/claude/spectators.md
 * "Over-the-shoulder view"): events-bots-s14's recorded spectator (ios_fan
 * watches ios_ann, seat 1, with three bots), with the server's shoulder
 * payloads built from the same recording (seat 1's own deal), as a
 * spectator with the clientHello cap shoulderView receives them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let gs;
let computeTableLayout;
const copy = (v) => JSON.parse(JSON.stringify(v));
let replayed = 1;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_fan', socketId: 'ios-spec' });
  gs = (await import('../state/GameState.js')).getGameState();
  ({ computeTableLayout } = await import('../phaser/layout/computeTableLayout.js'));
});

afterAll(() => vi.useRealTimers());

const log = () => rec.logs.spectator;
const joined = () => log()[0];
// seat 1's own deal of the hand the spectator joins in (the same instant)
const seatDeal = () => rec.logs.seat1.find((e) => e.event === 'gameStart' && e.t === joined().t);
const watchSent = () => page.socket.emitted('watchHand');
const handCount = () => page.scene.cardManager.getHandCount();
const pill = () => document.getElementById('spectating-indicator');
const box = () => document.getElementById('player-avatar-container');

function reply(position, hand, hsi = null) {
  const snap = copy(joined().data.snapshot);
  snap.viewer = { ...snap.viewer, shoulder: { position, hand, hsi } };
  snap.partial = ['log'];
  return { snapshot: snap, reason: 'watchHand' };
}

describe('a spectator looks over a player\'s shoulder', () => {
  it('sends the clientHello cap shoulderView', () => {
    const hello = page.socket.emitted('clientHello').at(-1);
    expect(hello.caps).toContain('shoulderView');
  });

  it('after its full state, watches the first human seat (seat 1, ios_ann)', () => {
    page.socket.fire('spectatorJoined', copy(joined().data));
    replay.advance(100);
    expect(page.session.role).toBe('spectator');
    expect(watchSent()).toEqual([{ gameId: rec.gameId, position: 1 }]);
    // nothing is served yet: the plain spectator view
    expect(page.scene.getLayout().isSpectator).toBe(true);
    expect(handCount()).toBe(0);
  });

  it('the reply draws seat 1\'s own table: its hand face up and read-only, its box and HSI, the seated layout', () => {
    const deal = seatDeal();
    const hand = deal.data.hand;
    page.socket.fire('stateSnapshot', reply(1, copy(hand), deal.data.hsiValues[1]));
    replay.advance(200);
    expect(gs.shoulder).toEqual({ position: 1, paused: false });
    expect(gs.position).toBe(1);
    expect(handCount()).toBe(hand.length);
    // read-only: no card can be clicked or played
    const sprites = page.scene.cardManager._handSprites.filter((s) => s.active !== false);
    expect(sprites.every((s) => s.interactive === false && s.getData('isLegal') === false)).toBe(true);
    // seat 1's box at the bottom, with its HSI
    expect(box()?.dataset.username).toBe('ios_ann');
    expect(document.getElementById('player-hsi-box').textContent).toBe(`HSI: ${deal.data.hsiValues[1].toFixed(1)}`);
    // the seated layout (no Tutorial slot), as a player of that seat has it
    const L = page.scene.getLayout();
    expect(L.isSpectator).toBe(false);
    expect(JSON.stringify(L)).toBe(JSON.stringify(computeTableLayout({ w: L.w, h: L.h, dpr: L.dpr, isSpectator: false, logW: L.logW, tutorial: false })));
    // the pill says whose hand, with the way back
    expect(pill().dataset.kind).toBe('watching');
    expect(pill().textContent).toContain("Watching ios_ann's hand");
    expect(pill().querySelector('button').textContent).toBe('Table view');
    // no sending re-ask: the reply is the answer
    expect(watchSent()).toHaveLength(1);
  });

  it('a mirrored /help bid answer shows on seat 1\'s bid turn, with no count', () => {
    // the recording's first events: bids up to seat 1's turn
    const firstTurnOf1 = log().findIndex((e) => e.event === 'updateTurn' && e.data.currentTurn === 1);
    replay.replayLog(page, log(), { from: 1, to: firstTurnOf1 + 1 });
    replay.advance(50);
    expect(gs.currentTurn).toBe(1);
    expect(gs.isBidding).toBe(true);
    const bids = Object.keys(gs.bids).length;
    page.socket.fire('assistHint', {
      v: 1, source: 'help', kind: 'bid', turnKey: `${gs.dealSeq}|BIDDING|1|${bids}|0`, headline: 'Bid 2',
      reasons: ['Your hand should win about 2 tricks.'], uses: 2, freeUses: 3, assisted: false, counted: true,
      details: [], confidence: 'clear', suggest: { bid: '2' }, watched: 1,
    });
    replay.advance(50);
    const card = document.querySelector('#table-hud > .hud-assist');
    expect(card && !card.hidden).toBe(true);
    expect(card.querySelector('.assist-card__head').textContent).toBe('Bid 2');
    expect(card.querySelector('.assist-card__foot').textContent).toBe('What our strongest bot would play');
    expect(card.textContent).not.toMatch(/free|bot-assisted|unlimited|counted/i);
    // whose advice it is, one line on top; the same words label the card
    expect(card.firstElementChild.className).toBe('assist-card__owner');
    expect(card.firstElementChild.textContent).toBe("ios_ann's advice");
    expect(card.getAttribute('aria-label')).toBe("ios_ann's advice");
    // narrow and wide tables: the same card, its heading first, placed by the layout
    for (const [w, h] of [[760, 560], [1920, 953], [1040, 680]]) {
      page.scene.scale.width = w;
      page.scene.scale.height = h;
      page.scene.scale.emit('resize', { width: w, height: h });
      replay.advance(50);
      const now = document.querySelector('#table-hud > .hud-assist');
      expect(now.hidden).toBe(false);
      expect(now.firstElementChild.textContent).toBe("ios_ann's advice");
      expect(document.querySelectorAll('.assist-card__owner')).toHaveLength(1);
      const hud = document.getElementById('table-hud');
      expect(parseFloat(hud.style.getPropertyValue('--assist-w'))).toBeGreaterThanOrEqual(240);
    }
    // no lightbulb, no bid sheet for a watcher
    expect(document.querySelector('.hud-assist-ask:not([hidden])')).toBeNull();
    expect(page.scene.tableCounts().bidPanel).toBe(false);
    // its bid clears it (the owner's client does the same)
    const bidOf1 = log().findIndex((e, i) => i > firstTurnOf1 && e.event === 'bidReceived' && e.data.position === 1);
    replay.replayLog(page, log(), { from: firstTurnOf1 + 1, to: bidOf1 + 1 });
    replayed = bidOf1 + 1;
    replay.advance(50);
    expect(document.querySelector('#table-hud > .hud-assist:not([hidden])')).toBeNull();
  });

  it('a mirrored tutorial tip shows read-only (no buttons, no row)', () => {
    const rows = document.querySelectorAll('#gameFeed .is-private, #gameFeed .private').length;
    page.socket.fire('assistHint', {
      v: 1, source: 'tutorial', kind: 'tip', tipId: 'T.trump', headline: 'Trump', reasons: ['Jokers are always trump.'],
      uses: 0, freeUses: 3, assisted: false, counted: false, watched: 1,
    });
    replay.advance(50);
    const tip = document.querySelector('#table-hud > .hud-assist .assist-tip');
    expect(tip).not.toBeNull();
    expect(document.querySelector('#table-hud > .hud-assist > .assist-card__owner').textContent).toBe("ios_ann's tip");
    expect(document.querySelector('#table-hud > .hud-assist').getAttribute('aria-label')).toBe("ios_ann's tip");
    expect(tip.querySelector('.assist-tip__text').textContent).toBe('Jokers are always trump.');
    expect(tip.querySelector('.assist-tip__actions')).toBeNull();
    expect(document.querySelectorAll('#gameFeed .is-private, #gameFeed .private').length).toBe(rows);
    // the watcher's own tutorial is off: the tip stays (it is seat 1's)
    page.scene.syncTutorial();
    expect(document.querySelector('#table-hud > .hud-assist .assist-tip')).not.toBeNull();
  });

  it('cards leave the watched hand as seat 1 plays them; others only leave their backs', () => {
    const at = handCount();
    const firstPlay1 = log().findIndex((e) => e.event === 'cardPlayed' && e.data.position === 1);
    const before = log().slice(0, firstPlay1).filter((e) => e.event === 'cardPlayed').length;
    expect(before).toBeGreaterThan(0);
    // (every event in order: a skipped one is a seq gap, which holds the rest)
    replay.replayLog(page, log(), { from: replayed, to: firstPlay1 });
    replay.advance(50);
    expect(handCount()).toBe(at);
    const card = log()[firstPlay1].data.card;
    replay.replayLog(page, log(), { from: firstPlay1, to: firstPlay1 + 1 });
    replay.advance(1200);
    expect(handCount()).toBe(at - 1);
    expect(gs.myCards.some((c) => c.suit === card.suit && c.rank === card.rank)).toBe(false);
    // the card flew to seat 1's own trick slot
    expect(page.scene.trickManager._currentTrick.some((s) => s.getData('playPosition') === 'self')).toBe(true);
  });

  it('voice: the watched player speaking lights its box; my own voice lights the badge, not its box', async () => {
    page.socket.fire('voiceSettings', { gameId: rec.gameId, host: 'ios_ann', spectatorsCanTalk: true, role: 'spectator', canTalk: true, canChange: false });
    await vi.waitFor(() => expect(page.voice.onSpeakingChange).toHaveBeenCalled());
    const cb = page.voice.onSpeakingChange.mock.calls.at(-1)[0];
    page.voice.peers.set('s-ann', { username: 'ios_ann' });
    cb('s-ann', true);
    expect(box().classList.contains('voice-speaking')).toBe(true);
    cb('s-ann', false);
    expect(box().classList.contains('voice-speaking')).toBe(false);
    cb('self', true);
    expect(box().classList.contains('voice-speaking')).toBe(false);
    expect(document.querySelector('#table-hud > .hud-spectators .spectator-badge').classList.contains('voice-speaking')).toBe(true);
    cb('self', false);
    expect(document.querySelector('#table-hud > .hud-spectators .spectator-badge').classList.contains('voice-speaking')).toBe(false);
  });

  it('an avatar click switches the watch; the watched seat\'s own box opens its profile', () => {
    page.socket.clearEmits();
    const partner = document.querySelector('#opponent-avatar-partner');
    expect(partner.dataset.position).toBe('3');
    partner.click();
    expect(page.socket.emitted('watchHand')).toEqual([{ gameId: rec.gameId, position: 3 }]);
    expect(page.socket.emitted('getPlayerProfile')).toEqual([]);
    box().click();
    expect(page.socket.emitted('getPlayerProfile').map((p) => p.username)).toEqual(['ios_ann']);
  });

  it('the switch\'s reply turns the table to seat 3 (its side first in the score header)', () => {
    page.socket.fire('stateSnapshot', reply(3, [{ suit: 'hearts', rank: 'A' }, { suit: 'clubs', rank: '2' }], 120.5));
    replay.advance(200);
    expect(gs.position).toBe(3);
    expect(box()?.dataset.username).toBe('🤖 Mike');
    expect(handCount()).toBe(2);
    expect(pill().textContent).toContain("Watching 🤖 Mike's hand");
    // a hint mirrored from seat 1 is not this seat's: not shown
    expect(document.querySelector('#table-hud > .hud-assist .assist-tip')).toBeNull();
  });

  it('who watches which hand: an eye on the watched seat and the list row', () => {
    page.socket.fire('spectatorsUpdated', { gameId: rec.gameId, spectators: [{ username: 'ios_fan', pic: 12, shoulder: 3 }, { username: 'zed', pic: 3 }], count: 2 });
    const eye = box().querySelector('.hud-watch-chip');
    expect(eye.classList.contains('is-on')).toBe(true);
    expect(eye.title).toBe("You are watching 🤖 Mike's hand");
    for (const ring of document.querySelectorAll('.opponent-avatar-container .hud-watch-chip')) expect(ring.classList.contains('is-on')).toBe(false);
    document.querySelector('#table-hud > .hud-spectators button').click();
    expect([...document.querySelectorAll('.spectator-popover__name')].map((n) => n.textContent)).toEqual(['ios_fan (you) · watching 🤖 Mike', 'zed']);
  });

  it('Table view: the plain spectator view at once, watchHand(null), remembered for this game', () => {
    page.socket.clearEmits();
    pill().querySelector('button').click();
    replay.advance(100);
    expect(page.socket.emitted('watchHand')).toEqual([{ gameId: rec.gameId, position: null }]);
    expect(gs.shoulder).toBeNull();
    expect(gs.position).toBe(1);
    expect(handCount()).toBe(0);
    expect(page.scene.getLayout().isSpectator).toBe(true);
    expect(pill().dataset.kind).toBe('spectator');
    expect(pill().textContent).toBe('Spectating — type /leave to exit');
    expect(JSON.parse(sessionStorage.getItem('bab.shoulder'))).toEqual({ gameId: rec.gameId, choice: 'table' });
    // a later full state does not watch again
    page.socket.clearEmits();
    page.socket.fire('stateSnapshot', { snapshot: copy(joined().data.snapshot), requestId: 'ping-1' });
    replay.advance(50);
    expect(page.socket.emitted('watchHand')).toEqual([]);
  });

  it('a click from the table view watches that seat again', () => {
    const bottom = document.querySelector('#opponent-avatar-bottom');
    expect(bottom.dataset.position).toBe('1');
    bottom.click();
    expect(page.socket.emitted('watchHand')).toEqual([{ gameId: rec.gameId, position: 1 }]);
  });
});
