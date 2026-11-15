/**
 * The keyboard / screen reader hand (ui/handA11y.js) on its own: the
 * toolbar's buttons, roving focus and arrow keys, what a dimmed card says,
 * where focus goes when the focused card goes, and when my turn may take
 * focus (never from an input or a control outside the table). The real
 * table's use of it: client/src/table/keyboardHand.test.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncHand, offerTurnFocus, announce, announcer, handBar, resetHandA11y, ANNOUNCE_KEEP } from './handA11y.js';

const card = (key, legal = true, i = 0) => ({ key, label: key, legal, rect: { x: 10 + 30 * i, y: 100, w: 30, h: 90 } });
const hand = (spec) => spec.map(([k, legal], i) => card(k, legal, i));
const btns = () => Array.from(document.querySelectorAll('.hud-hand__card'));
const key = (k) => document.querySelector(`.hud-hand__card[data-key="${k}"]`);
const press = (el, k) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};
const lines = () => Array.from(announcer().children).map((p) => p.textContent);

beforeEach(() => {
  document.body.replaceChildren();
  resetHandA11y();
});

describe('the toolbar', () => {
  it('one button per card, in order, labelled; dimmed cards aria-disabled; one tab stop on the first playable', () => {
    syncHand({ cards: hand([['a', false], ['b', true], ['c', true]]), cardW: 60, cardH: 90, lift: 20 });
    const bar = handBar({ create: false });
    expect(bar.getAttribute('role')).toBe('toolbar');
    expect(bar.getAttribute('aria-label')).toBe('Your hand');
    expect(btns().map((b) => b.getAttribute('aria-label'))).toEqual(['a', 'b', 'c']);
    expect(btns().map((b) => b.getAttribute('aria-disabled'))).toEqual(['true', 'false', 'false']);
    expect(btns().map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    expect(key('b').style.getPropertyValue('--x')).toBe('40px');
    expect(bar.style.getPropertyValue('--card-w')).toBe('60px');
    // an empty hand: no tab stop at all
    syncHand({ cards: [] });
    expect(bar.hidden).toBe(true);
    expect(btns()).toHaveLength(0);
  });

  it('arrows / Home / End move focus (clamped) and the tab stop with it; other keys are left alone', () => {
    syncHand({ cards: hand([['a', true], ['b', false], ['c', true]]) });
    key('a').focus();
    expect(press(key('a'), 'ArrowRight').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(key('b')); // a dimmed card is still reachable
    press(key('b'), 'ArrowDown');
    expect(document.activeElement).toBe(key('c'));
    press(key('c'), 'ArrowRight');
    expect(document.activeElement).toBe(key('c'));
    press(key('c'), 'Home');
    expect(document.activeElement).toBe(key('a'));
    press(key('a'), 'ArrowLeft');
    expect(document.activeElement).toBe(key('a'));
    press(key('a'), 'End');
    expect(btns().map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
    // the voice keys (backquote, M) and Enter / Space are not ours to take
    for (const k of ['m', '`', 'Enter', ' ', 'Tab']) expect(press(key('c'), k).defaultPrevented, k).toBe(false);
    expect(document.activeElement).toBe(key('c'));
  });

  it('a click (Enter / Space) on a playable card activates it; on a dimmed one says why and plays nothing', () => {
    const onActivate = vi.fn();
    syncHand({ cards: hand([['a', true], ['b', false]]), onActivate, reasonFor: (k) => `no ${k}` });
    key('b').click();
    expect(onActivate).not.toHaveBeenCalled();
    expect(lines()).toEqual(['no b']);
    key('a').click();
    expect(onActivate).toHaveBeenCalledWith('a');
  });

  it('keeps the nodes by card: a resync keeps focus; the focused card going hands it to its neighbour, the last to the announcer', () => {
    syncHand({ cards: hand([['a', true], ['b', true], ['c', true]]) });
    const b = key('b');
    b.focus();
    syncHand({ cards: hand([['a', false], ['b', false], ['c', false]]) });
    expect(key('b')).toBe(b);
    expect(document.activeElement).toBe(b);
    // b played: the card now in its place
    syncHand({ cards: hand([['a', false], ['c', false]]) });
    expect(document.activeElement).toBe(key('c'));
    syncHand({ cards: hand([['a', false]]) });
    expect(document.activeElement).toBe(key('a'));
    syncHand({ cards: [] });
    expect(document.activeElement).toBe(announcer());
  });

  it('a render (clear, then the same hand in the same task) puts focus back on the same card', () => {
    syncHand({ cards: hand([['a', true], ['b', true]]) });
    key('b').focus();
    syncHand({ cards: [], redraw: true });
    expect(document.activeElement).toBe(announcer());
    syncHand({ cards: hand([['a', true], ['b', true]]) });
    expect(document.activeElement).toBe(key('b'));
  });

  it('a render that drew no hand: the card memory ends with the task', async () => {
    syncHand({ cards: hand([['a', true]]) });
    key('a').focus();
    syncHand({ cards: [], redraw: true });
    await Promise.resolve();
    syncHand({ cards: hand([['a', false]]) });
    expect(document.activeElement).toBe(announcer());
  });

  it('the last card played leaves focus on the announcer; the next deal never takes it, even holding that card', () => {
    syncHand({ cards: hand([['a', true]]) });
    key('a').focus();
    syncHand({ cards: [] });
    expect(document.activeElement).toBe(announcer());
    // a fresh deck often deals the same card again: still no jump mid-deal
    syncHand({ cards: hand([['x', false], ['a', false]]) });
    expect(document.activeElement).toBe(announcer());
    syncHand({ cards: hand([['x', false], ['a', true]]) });
    expect(document.activeElement).toBe(announcer());
    // my turn takes it from there (the announcer is the table's own)
    expect(offerTurnFocus()).toBe(true);
    expect(document.activeElement).toBe(key('a'));
  });
});

describe('my turn takes focus only where it is free', () => {
  const setup = () => syncHand({ cards: hand([['a', false], ['b', true]]) });

  it('from nowhere after a key press: the first playable card', () => {
    setup();
    press(document.body, 'Enter');
    expect(offerTurnFocus()).toBe(true);
    expect(document.activeElement).toBe(key('b'));
  });

  it('never for a pointer user (focus nowhere, last input a click)', () => {
    setup();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(offerTurnFocus()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('never for a pointer user who used the voice keys (M, backquote) or typed a stray letter', () => {
    setup();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    for (const k of ['m', '`', 'q']) press(document.body, k);
    expect(offerTurnFocus()).toBe(false);
    expect(document.activeElement).toBe(document.body);
    // a navigation key does make it the keyboard
    press(document.body, 'Tab');
    expect(offerTurnFocus()).toBe(true);
  });

  it('never from a text input (chat), even after typing in it', () => {
    setup();
    const chat = document.createElement('input');
    document.body.appendChild(chat);
    chat.focus();
    press(chat, 'h');
    expect(offerTurnFocus()).toBe(false);
    expect(document.activeElement).toBe(chat);
  });

  it('never from a control outside the table (a voice or log button)', () => {
    setup();
    const other = document.createElement('button');
    document.body.appendChild(other);
    other.focus();
    press(other, 'Tab');
    expect(offerTurnFocus()).toBe(false);
    expect(document.activeElement).toBe(other);
  });

  it('from the table\'s own controls (the bid sheet, the announcer, a dimmed card in the hand)', () => {
    setup();
    const bids = document.createElement('div');
    bids.id = 'bidContainer';
    const bid = document.createElement('button');
    bids.appendChild(bid);
    document.body.appendChild(bids);
    bid.focus();
    expect(offerTurnFocus()).toBe(true);
    expect(document.activeElement).toBe(key('b'));
    key('a').focus();
    expect(offerTurnFocus()).toBe(true);
    expect(document.activeElement).toBe(key('b'));
    // already on a playable card: it stays
    expect(offerTurnFocus()).toBe(false);
    announcer().focus();
    expect(offerTurnFocus()).toBe(true);
  });
});

describe('the announcer', () => {
  it('a polite log: each message its own line, the last few kept, a repeat within a second dropped', () => {
    vi.useFakeTimers();
    try {
      announce('one');
      announce('one');
      const log = announcer();
      expect(log.getAttribute('role')).toBe('log');
      expect(log.getAttribute('aria-live')).toBe('polite');
      expect(lines()).toEqual(['one']);
      vi.advanceTimersByTime(1100);
      announce('one');
      for (let i = 0; i < 10; i++) announce(`m${i}`);
      expect(lines()).toHaveLength(ANNOUNCE_KEEP);
      expect(lines().at(-1)).toBe('m9');
    } finally {
      vi.useRealTimers();
    }
  });
});
