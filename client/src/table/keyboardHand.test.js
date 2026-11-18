/**
 * Keyboard card play on a recorded live table (events-bots-s12, seat 1,
 * the real page, GameScene and managers on testing/fakePhaser.js): the HUD's
 * hand toolbar (ui/handA11y.js) mirrors the canvas hand, and
 *
 *   - each button is its card, in hand order, aria-disabled exactly when the
 *     canvas dims it (the client legality), over the card's visible strip
 *     (the canvas hit test at the strip's centre finds that card), at every
 *     layout a resize gives;
 *   - arrows move, a dimmed card says why and plays nothing, a playable one
 *     goes through CardManager's click handler with the pointer's arguments:
 *     the same playCard emit, the same fly-in, MyAction pending;
 *   - focus: my turn takes it only from nowhere after a key press (never
 *     from the chat input), the played card hands it to its neighbour, a
 *     render keeps it on the same card, a resize keeps the card raised;
 *   - the announcer says the trump, my turn with the trick so far, each
 *     card played and each trick's winner.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { scoreHeaderNames } from '../ui/components/ScoreModal.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let log;
let at = 0;
let myAction;
let layoutMod;
let cards;
const said = [];
const seen = new WeakSet();

const sameCard = (a, b) => a.suit === b.suit && a.rank === b.rank;
const keyOf = (c) => `${String(c.rank).toLowerCase()}_${c.suit}`;
const hud = () => document.getElementById('table-hud');
const bar = () => hud().querySelector(':scope > .hud-hand');
const btns = () => Array.from(bar().querySelectorAll('.hud-hand__card'));
const sprites = () => page.scene.cardManager.getHandSprites();
const px = (b, v) => parseFloat(b.style.getPropertyValue(v));

/** Collect the announcer's new lines (it keeps only the last few). */
function collect() {
  const log2 = hud()?.querySelector(':scope > .hud-announcer');
  for (const p of log2?.children || []) {
    if (!seen.has(p)) {
      seen.add(p);
      said.push(p.textContent);
    }
  }
}

/** Replay through entry `to` (exclusive), collecting what was said. */
function replayTo(to) {
  at = replay.replayLog(page, log, { from: at, to, before: collect });
  collect();
}

function press(el, key) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

/** Enter on a focused button (a browser then clicks it; jsdom does not). */
function enter(btn) {
  press(btn, 'Enter');
  btn.click();
}

/** The next play turn of mine from `from`: the updateTurn entry and my recorded card after it. */
function nextTurn(from, bidding = from === 0 || page.gameState.isBidding) {
  for (let i = from; i < log.length; i++) {
    const e = log[i];
    if (e.event === 'gameStart') bidding = true;
    if (e.event === 'doneBidding') bidding = false;
    if (!bidding && e.dir === 's2c' && e.event === 'updateTurn' && e.data.currentTurn === 1) {
      const play = log.slice(i + 1).find((x) => x.event === 'playCard' && x.dir === 'c2s');
      return { turn: i, card: play?.data.card };
    }
  }
  return null;
}

/** Each button's geometry against the layout's hand fan, and the canvas card at its strip's centre. */
function expectOverCards() {
  const L = page.scene.getLayout();
  const s = sprites();
  const fan = layoutMod.handPositions(L, s.length);
  expect(btns()).toHaveLength(s.length);
  btns().forEach((b, i) => {
    const x = px(b, '--x');
    const w = px(b, '--w');
    expect(Math.abs(x - (fan[i].x - L.hand.card.w / 2)), `button ${i} x`).toBeLessThan(0.02);
    expect(Math.abs(px(b, '--y') - (fan[i].y - L.hand.card.h / 2))).toBeLessThan(0.02);
    expect(Math.abs(px(b, '--h') - L.hand.card.h)).toBeLessThan(0.02);
    // what a touch screen reader taps (the strip's centre) is this card
    const top = page.scene.objectsAt(x + w / 2, px(b, '--y') + L.hand.card.h / 2)[0];
    expect(top, `card under button ${i}`).toBe(s[i]);
  });
}

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  log = replay.loadRecording('events-bots-s12').logs.seat1;
  layoutMod = await import('../phaser/layout/computeTableLayout.js');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
  ({ getMyAction: myAction } = await import('../state/MyAction.js'));
});

afterAll(() => vi.useRealTimers());

let turn;

describe('the hand toolbar mirrors the canvas hand', () => {
  it('the deal says the trump; my turn says the trick so far', () => {
    // the first play turn of mine with a choice (some cards dimmed, some not)
    let from = 0;
    for (;;) {
      turn = nextTurn(from);
      expect(turn, 'a mixed play turn in the recording').toBeTruthy();
      replayTo(turn.turn + 1);
      replay.advance(1500);
      collect();
      const legal = sprites().map((s) => s.getData('isLegal'));
      if (legal.includes(true) && legal.includes(false) && turn.card) break;
      from = turn.turn + 1;
    }
    expect(said.some((t) => /^New hand of \d+ cards?\. Trump is the .+\.$/.test(t)), said.join(' | ')).toBe(true);
    const mine = said.filter((t) => t.startsWith('Your turn'));
    expect(mine.at(-1)).toMatch(/^Your turn\. On the trick: .+, .+ of [A-Z][a-z]+(; .+)?\.$/);
    expect(said).toContain('Your turn to bid.');
    expect(said.some((t) => / played the .+\.$/.test(t))).toBe(true);
  });

  it('one button per card, labelled, in hand order; aria-disabled exactly where the canvas dims; one tab stop', () => {
    const s = sprites();
    expect(bar().getAttribute('role')).toBe('toolbar');
    expect(btns().map((b) => b.dataset.key)).toEqual(s.map((x) => keyOf(x.getData('card'))));
    expect(btns().every((b) => / of [A-Z]|Joker$/.test(b.getAttribute('aria-label')))).toBe(true);
    expect(btns().map((b) => b.getAttribute('aria-disabled') === 'false')).toEqual(s.map((x) => x.getData('isLegal')));
    expect(btns().filter((b) => b.tabIndex === 0)).toHaveLength(1);
    expect(btns().find((b) => b.tabIndex === 0).getAttribute('aria-disabled')).toBe('false');
    // never a pointer target (the canvas keeps the clicks and the hover)
    expect(document.activeElement).toBe(document.body); // no key pressed yet: focus stayed put
    expectOverCards();
  });

  it('arrows move through the hand; the voice keys pass through', () => {
    btns()[0].focus();
    press(btns()[0], 'ArrowRight');
    expect(document.activeElement).toBe(btns()[1]);
    press(document.activeElement, 'End');
    expect(document.activeElement).toBe(btns().at(-1));
    press(document.activeElement, 'Home');
    expect(document.activeElement).toBe(btns()[0]);
    expect(press(document.activeElement, 'm').defaultPrevented).toBe(false);
    expect(press(document.activeElement, '`').defaultPrevented).toBe(false);
  });

  it('a dimmed card: Enter says why and sends nothing', () => {
    page.socket.clearEmits();
    const dim = btns().find((b) => b.getAttribute('aria-disabled') === 'true');
    dim.focus();
    const before = page.scene.tableCounts();
    enter(dim);
    expect(page.socket.emitted('playCard')).toEqual([]);
    expect(page.scene.tableCounts()).toEqual(before);
    collect();
    expect(said.at(-1)).toMatch(/^(Must follow suit|Cannot lead trump until trump is broken|Must play highest trump when HI joker leads)\.$/);
  });

  it('a render keeps focus on the same card', () => {
    const k = btns()[1].dataset.key;
    btns()[1].focus();
    page.scene.render();
    expect(document.activeElement.dataset.key).toBe(k);
    expectOverCards();
  });

  it('a playable card: Enter is the pointer\'s click (same handler and arguments, same emit); focus goes to its neighbour', () => {
    page.socket.clearEmits();
    const cm = page.scene.cardManager;
    const click = vi.spyOn(cm, '_onCardClick');
    const i = btns().findIndex((b) => b.dataset.key === keyOf(turn.card));
    expect(i).toBeGreaterThan(-1);
    const btn = btns()[i];
    expect(btn.getAttribute('aria-disabled')).toBe('false');
    const sprite = sprites()[i];
    const before = page.scene.tableCounts();
    btn.focus();
    enter(btn);
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.calls[0][0]).toEqual(turn.card);
    expect(click.mock.calls[0][1]).toBe(sprite);
    expect(page.socket.emitted('playCard')).toEqual([{ card: turn.card, position: 1 }]);
    expect(myAction().state).toBe('pending');
    expect(page.scene.tableCounts()).toMatchObject({ hand: before.hand - 1, trick: before.trick + 1 });
    // focus stays in the hand, on the card now in its place; the rest dimmed
    expect(document.activeElement).toBe(btns()[Math.min(i, btns().length - 1)]);
    expect(btns().every((b) => b.getAttribute('aria-disabled') === 'true')).toBe(true);
    // a second Enter: nothing more goes out
    enter(document.activeElement);
    expect(page.socket.emitted('playCard')).toHaveLength(1);
    click.mockRestore();
  });

  it('my card\'s echo and the trick are announced', () => {
    const n = said.length;
    const done = log.findIndex((e, j) => j > turn.turn && e.event === 'trickComplete');
    replayTo(done + 1);
    const after = said.slice(n);
    expect(after).toContain(`You played the ${btnLabel(turn.card)}.`);
    const won = after.filter((t) => /^(You|.+) won the trick\. Tricks: .+ and .+ \d+, .+ and .+ \d+\.$/.test(t));
    expect(won, after.join(' | ')).toHaveLength(1);
    // the sides by their players' names, mine first (owner 2026-11-17: never
    // "your team" / "opponents"); the counts are the table's (GameState,
    // after the event applied)
    const { teamName, oppName } = scoreHeaderNames(page.gameState.position, page.gameState.playerData);
    const said2 = (names) => names.split('/').join(' and ');
    expect(won[0]).toContain(`Tricks: ${said2(teamName)} ${page.gameState.teamTricks}, ${said2(oppName)} ${page.gameState.oppTricks}.`);
    expect(won[0]).not.toMatch(/your team|opponents|Team [12]/i);
    expect(myAction().state).toBe('idle');
  });
});

function btnLabel(c) {
  const names = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' };
  if (c.suit === 'joker') return c.rank === 'HI' ? 'High Joker' : 'Low Joker';
  return `${names[c.rank] || c.rank} of ${c.suit[0].toUpperCase()}${c.suit.slice(1)}`;
}

describe('focus on my turn', () => {
  it('typing in the chat: my turn never takes focus from it', () => {
    const next = nextTurn(at);
    expect(next).toBeTruthy();
    const chat = document.getElementById('chatInput');
    expect(chat, 'the game log chat input').toBeTruthy();
    chat.focus();
    press(chat, 'h');
    replayTo(next.turn + 1);
    replay.advance(1500);
    expect(document.activeElement).toBe(chat);
    // ...and the play still works from the canvas (the recorded card)
    page.socket.clearEmits();
    sprites().find((s) => sameCard(s.getData('card'), next.card)).emit('pointerdown');
    expect(page.socket.emitted('playCard')).toEqual([{ card: next.card, position: 1 }]);
    cards = next;
  });

  it('focus nowhere after a key press: my turn puts it on my first playable card', () => {
    document.activeElement.blur();
    press(document.body, 'Tab');
    const next = nextTurn(at + 1);
    expect(next).toBeTruthy();
    replayTo(next.turn + 1);
    replay.advance(1500);
    const first = btns().find((b) => b.getAttribute('aria-disabled') === 'false');
    expect(first).toBeTruthy();
    expect(document.activeElement).toBe(first);
    // the focused playable card rises as a hovered one does
    const s = sprites()[btns().indexOf(first)];
    expect(s.y).toBeLessThan(s.getData('baseY'));
  });
});

describe('every layout', () => {
  it('the buttons follow a resize (wide, narrow, short) and still sit over their cards; the focused card stays raised', () => {
    // focus is on my first playable card (the test before)
    const focused = document.activeElement;
    expect(focused.getAttribute('aria-disabled')).toBe('false');
    for (const [w, h] of [[1920, 1080], [1100, 700], [800, 600], [1366, 640], [669, 900]]) {
      page.scene.scale.width = w;
      page.scene.scale.height = h;
      page.scene.scale.emit('resize', { width: w, height: h });
      replay.advance(600);
      expectOverCards();
      // the relayout snapped the hand to its new line: the focused card is
      // lifted again (its ring is drawn raised)
      expect(document.activeElement, `${w}x${h}`).toBe(focused);
      const s = sprites()[btns().indexOf(focused)];
      expect(s.y, `${w}x${h}`).toBeLessThan(s.getData('baseY'));
    }
  });
});
