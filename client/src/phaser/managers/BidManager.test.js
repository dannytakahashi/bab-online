/**
 * The bid sheet's box is the layout's (BID_SHEET): the bid slot's fit and
 * the overlap check model it, so nothing the sheet draws may stick out of
 * it. Its widest row is the trick chips (one per trick, up to 16 when the
 * bids overbid the hand): 13 chips at their natural width fit the sheet,
 * and an overbid's extra chips shrink to fit instead of overflowing.
 * (jsdom has no layout engine: these check the box model the browser uses:
 * the layout's numbers as CSS variables on the sheet, and the table.css
 * rules that read them.) Item 18a: the look is classes (kit / table.css),
 * hover and disabled are CSS, and no style is set inline but the box model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BidManager } from './BidManager.js';
import { resetGameState, getGameState } from '../../state/GameState.js';
import { BID_SHEET, BID_CHIP, BID_SHEET_CHROME, BID_SHEET_PAD, BID_SHEET_BORDER } from '../layout/computeTableLayout.js';
import { readClientFile } from '../../testing/files.js';
import { clearToasts } from '../../ui/kit/toast.js';
import { resetMyAction, getMyAction } from '../../state/MyAction.js';
import { setBidClockNow, BID_CLOCK_UI_MARGIN_MS, BID_CLOCK_EXPIRED_GRACE_MS } from '../../state/bidClock.js';

const css = readClientFile('styles/table.css');
const chipsWidth = (n) => n * BID_CHIP.w + (n - 1) * BID_CHIP.gap;
/** The declarations of one rule of table.css. */
const rule = (sel) => {
  const i = css.indexOf(`\n${sel} {`);
  expect(i, sel).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
};

describe('the bid sheet\'s width (the layout\'s BID_SHEET)', () => {
  let bm;
  beforeEach(() => {
    resetGameState();
    bm = new BidManager({});
  });
  afterEach(() => {
    bm.hideBidUI(false);
    document.getElementById('bidContainer')?.remove();
  });

  it('the sheet is the layout\'s width, border included; 13 chips at their natural width fit inside it', () => {
    bm.showBidUI(13, () => {});
    const sheet = document.getElementById('bidContainer');
    expect(sheet.classList.contains('bid-sheet')).toBe(true);
    const v = (k) => sheet.style.getPropertyValue(k);
    expect(v('--bid-sheet-w')).toBe(`${BID_SHEET.w}px`);
    const sheetRule = rule('.bid-sheet');
    expect(sheetRule).toContain('width: var(--bid-sheet-w');
    expect(sheetRule).toContain('box-sizing: border-box');
    expect(sheetRule).toContain('padding: var(--bid-sheet-pad');
    expect(sheetRule).toContain('border: var(--bid-sheet-border');
    // the chrome the layout subtracts is the sheet's own (padding + border, both sides)
    expect(2 * parseFloat(v('--bid-sheet-pad')) + 2 * parseFloat(v('--bid-sheet-border'))).toBe(BID_SHEET_CHROME);
    expect([parseFloat(v('--bid-sheet-pad')), parseFloat(v('--bid-sheet-border'))]).toEqual([BID_SHEET_PAD, BID_SHEET_BORDER]);
    expect(bm.trickIndicators).toHaveLength(13);
    expect(v('--bid-chip-w')).toBe(`${BID_CHIP.w}px`);
    expect(v('--bid-chip-gap')).toBe(`${BID_CHIP.gap}px`);
    expect(rule('.bid-chip')).toContain('width: var(--bid-chip-w');
    expect(rule('.bid-chips')).toContain('gap: var(--bid-chip-gap');
    expect(chipsWidth(13)).toBeLessThanOrEqual(BID_SHEET.w - BID_SHEET_CHROME);
    // nothing else inline: the look is the classes
    for (const el of [sheet, ...sheet.querySelectorAll('*')]) {
      const inline = Array.from({ length: el.style.length }, (_, i) => el.style[i]).filter((k) => !k.startsWith('--'));
      expect(inline, el.className).toEqual([]);
    }
  });

  it('an overbid\'s 16 chips shrink to the sheet\'s width instead of sticking out past it', () => {
    const state = getGameState();
    state.position = 1;
    state.bids = { 1: '5', 2: '4', 3: '4', 4: '3' }; // 16 > 13
    bm.showBidUI(13, () => {});
    expect(bm.trickIndicators).toHaveLength(16);
    expect(chipsWidth(16)).toBeGreaterThan(BID_SHEET.w - BID_SHEET_CHROME); // would overflow at 18 px
    // the row is the sheet's content width (not its chips' min-content width,
    // which a centred column item would take)...
    const row = rule('.bid-chips');
    expect(row).toContain('align-self: stretch');
    expect(row).toContain('min-width: 0');
    // ...and every chip may shrink below 18 px
    const chip = rule('.bid-chip');
    expect(chip).toContain('flex: 0 1 var(--bid-chip-w');
    expect(chip).toContain('min-width: 0');
    // the chips past the hand size are marked (a static outline, no animation)
    expect(bm.trickIndicators.filter((c) => c.classList.contains('is-overbid'))).toHaveLength(3);
    expect(bm.trickIndicators.filter((c) => c.classList.contains('is-team'))).toHaveLength(9);
    expect(bm.trickIndicators.filter((c) => c.classList.contains('is-opp'))).toHaveLength(7);
  });

  it('the chips are in the absolute team colors (the seat rings\'), never green / red by mine-or-theirs', () => {
    const state = getGameState();
    const count = (cls) => bm.trickIndicators.filter((c) => c.classList.contains(cls)).length;
    // seat 2 (team B): my team's 5 chips coral, the opponents' 3 blue
    state.position = 2;
    state.bids = { 1: '2', 2: '3', 3: '1', 4: '2' };
    bm.showBidUI(13, () => {});
    expect([count('is-team'), count('is-opp')]).toEqual([5, 3]);
    expect([count('is-team-b'), count('is-team-a')]).toEqual([5, 3]);
    expect(bm.trickIndicators.slice(0, 5).every((c) => c.classList.contains('is-team-b'))).toBe(true);
    // seat 1 (team A): the same bids, mine blue
    state.position = 1;
    bm.updateTrickIndicator();
    expect([count('is-team-a'), count('is-team-b')]).toEqual([3, 5]);
    expect(bm.trickIndicators.slice(0, 3).every((c) => c.classList.contains('is-team-a'))).toBe(true);
    // the colors are the team tokens; nothing keys a chip's color on mine / theirs
    expect(rule('.bid-chip.is-team-a')).toContain('var(--team-a)');
    expect(rule('.bid-chip.is-team-b')).toContain('var(--team-b)');
    expect(css).not.toMatch(/\.bid-chip\.is-(team|opp) \{/);
  });

  it('a bore fills the whole hand for its team (rules/bids.js), not 0; the opponents\' bids are then over it', () => {
    const state = getGameState();
    const count = (cls) => bm.trickIndicators.filter((c) => c.classList.contains(cls)).length;
    state.position = 2;
    state.bids = { 1: 'B', 2: '1' };
    bm.showBidUI(4, () => {});
    expect(bm.trickIndicators).toHaveLength(5);
    expect([count('is-opp'), count('is-team'), count('is-overbid')]).toEqual([4, 1, 1]);
  });

  it('bores are a segmented control; a disabled bore and the selected bid are states, not inline colors', () => {
    const state = getGameState();
    state.position = 1;
    state.currentTurn = 1;
    state.isBidding = true;
    state.tempBids = ['B'];
    const picked = [];
    bm.showBidUI(5, (b) => picked.push(b));
    const bores = document.querySelector('.bid-bores');
    expect(bores.getAttribute('role')).toBe('group');
    expect(bm.boreButtons.B.disabled).toBe(true);
    expect(bm.boreButtons['2B'].disabled).toBe(false);
    bm.allBidButtons[2].click();
    expect(picked).toEqual(['2']);
    expect(bm.allBidButtons[2].classList.contains('is-selected')).toBe(true);
    expect(bm.allBidButtons[2].getAttribute('aria-pressed')).toBe('true');
    // hover is CSS (no JS handlers that stick on touch)
    expect(css).toContain('.bid-button:hover:not(:disabled)');
    expect(css).toContain('.bid-button:focus-visible');
  });

  it('a bid the sender refuses on the spot (MyAction returns false) is not left marked', () => {
    const state = getGameState();
    state.position = 1;
    state.currentTurn = 1;
    state.isBidding = true;
    state.tempBids = [];
    let accept = false;
    bm.showBidUI(5, () => accept);
    bm.allBidButtons[3].click();
    expect(bm.allBidButtons.some((b) => b.classList.contains('is-selected') || b.hasAttribute('aria-pressed'))).toBe(false);
    expect(bm.selectedBid).toBe(null);
    accept = undefined; // a sender that returns nothing keeps the mark, as before
    bm.boreButtons.B.click();
    expect(bm.boreButtons.B.getAttribute('aria-pressed')).toBe('true');
    expect(bm.selectedBid).toBe('B');
  });
});

describe('the bid clock\'s countdown (owner 2026-11-18)', () => {
  let bm;
  let state;
  let sent;
  const sheet = () => document.getElementById('bidContainer');
  const clockEl = () => sheet()?.querySelector('.bid-sheet__clock') || null;
  const said = () => Array.from(document.querySelectorAll('.hud-announcer p')).map((p) => p.textContent);
  /** The server's clock for seat `pos`, `inMs` from now (as GameState.applyBidClock does). */
  const run = (pos, inMs, durationMs = 30000) => {
    state.applyBidClock({ gameId: 'g1', position: pos, running: true, inMs, durationMs });
    bm.syncClock();
  };
  const tick = (ms) => vi.advanceTimersByTime(ms);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame'] });
    vi.setSystemTime(1_000_000);
    setBidClockNow(() => Date.now());
    document.querySelectorAll('.hud-announcer').forEach((el) => el.remove());
    state = resetGameState();
    state.applyDeal({ gameId: 'g1', position: 1, currentHand: 5, hand: [], trump: { suit: 'spades', rank: '5' } });
    state.applyTurn({ currentTurn: 1 });
    sent = [];
    resetMyAction({ emit: (event, data) => sent.push({ event, data }), setTimer: () => 0, clearTimer: () => {} });
    bm = new BidManager({});
    bm.showBidUI(5, (bid) => getMyAction().submitBid(bid, state.position));
  });
  afterEach(() => {
    bm.hideBidUI(false);
    document.getElementById('bidContainer')?.remove();
    setBidClockNow(null);
    vi.useRealTimers();
  });

  it('nothing before the clock runs; then the whole seconds left on the title row, to deadline - margin', () => {
    expect(clockEl()).toBe(null);
    run(1, 30000);
    const el = clockEl();
    expect(el).toBeTruthy();
    expect(el.parentElement.classList.contains('bid-sheet__title')).toBe(true);
    expect(el.getAttribute('role')).toBe('timer');
    // 30000 - 750 = 29250 ms: ceil = 30
    expect(el.textContent).toBe('30');
    expect(el.getAttribute('aria-label')).toBe('30 seconds to bid');
    tick(250);
    expect(el.textContent).toBe('29');
    tick(1000);
    expect(el.textContent).toBe('28');
    expect(el.classList.contains('bid-sheet__clock--low')).toBe(false);
    // the sheet's box model is unchanged: no inline style on the countdown
    expect(el.style.length).toBe(0);
  });

  it('the warning colour for the last 10 s; at 0 it goes and no bid is offered; the grace offers it again', () => {
    run(1, 12000);
    expect(clockEl().textContent).toBe('12');
    tick(2250);
    expect(clockEl().textContent).toBe('9');
    expect(clockEl().classList.contains('bid-sheet__clock--low')).toBe(true);
    tick(12000 - BID_CLOCK_UI_MARGIN_MS - 2250);
    expect(clockEl()).toBe(null);
    expect(sheet().classList.contains('bid-sheet--expired')).toBe(true);
    expect(bm.expired).toBe(true);
    const btn = sheet().querySelector('.bid-numbers .bid-button');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    // a click (or a key) at 0 sends nothing
    btn.click();
    expect(sent).toEqual([]);
    expect(rule('.bid-sheet--expired .bid-button')).toContain('pointer-events: none');
    // no word from the server: offered again after the grace
    tick(BID_CLOCK_EXPIRED_GRACE_MS + 10);
    expect(bm.expired).toBe(false);
    expect(btn.hasAttribute('aria-disabled')).toBe(false);
    btn.click();
    expect(sent.map((x) => x.event)).toEqual(['playerBid']);
  });

  it('a new clock (a resume) after 0 offers the bid again and counts afresh', () => {
    run(1, 2000);
    tick(1500);
    expect(bm.expired).toBe(true);
    run(1, 10000);
    expect(bm.expired).toBe(false);
    expect(clockEl().textContent).toBe('10');
  });

  it('only for the bidder: another seat\'s clock, a spectator, a lazy seat show nothing', () => {
    run(2, 30000);
    expect(clockEl()).toBe(null);
    state.applyBidClock({ gameId: 'g1', position: 2, running: false, reason: 'bid' });
    state.isSpectator = true;
    run(1, 30000);
    expect(clockEl()).toBe(null);
    state.isSpectator = false;
    state.applyMyLazy(true);
    bm.syncClock();
    expect(clockEl()).toBe(null);
    state.applyMyLazy(false);
    bm.syncClock();
    expect(clockEl()).toBeTruthy();
  });

  it('hidden while my bid is on its way; back if it is rolled back', () => {
    run(1, 30000);
    sheet().querySelector('.bid-numbers .bid-button').click();
    expect(sent).toHaveLength(1);
    expect(clockEl()).toBe(null);
    // the rollback (actionRejected): the render rebuilds the sheet
    getMyAction().reject({ action: 'bid' });
    bm.showBidUI(5, () => true);
    expect(clockEl()).toBeTruthy();
  });

  it('removed with the sheet, by my bid, by the turn moving on and by the clock stopping; its timer goes too', () => {
    run(1, 30000);
    state.applyBidClock({ gameId: 'g1', position: 1, running: false, reason: 'controller' });
    bm.syncClock();
    expect(clockEl()).toBe(null);
    run(1, 30000);
    state.applyBid({ position: 1, bid: '2' });
    bm.updateBoreButtonStates();
    expect(clockEl()).toBe(null);
    state.bids = {};
    run(1, 30000);
    state.applyTurn({ currentTurn: 2 });
    bm.updateVisibility();
    expect(clockEl()).toBe(null);
    state.applyTurn({ currentTurn: 1 });
    run(1, 30000);
    expect(clockEl()).toBeTruthy();
    tick(100); // the sheet's pop-in timers
    const before = vi.getTimerCount();
    bm.hideBidUI(false);
    expect(bm._clockTimer).toBe(null);
    expect(vi.getTimerCount()).toBe(before - 1);
  });

  it('screen readers hear it once when it appears and once at 10 s; a rebuilt sheet for the same clock says nothing new', () => {
    run(1, 15000);
    expect(said()).toEqual(['15 seconds to bid']);
    tick(4000);
    expect(said()).toEqual(['15 seconds to bid']);
    tick(1000);
    expect(said()).toEqual(['15 seconds to bid', '10 seconds to bid']);
    tick(3000);
    bm.showBidUI(5, () => true);
    expect(clockEl()).toBeTruthy();
    expect(said()).toHaveLength(2);
  });

  it('one that appears under 10 s (a rejoin) is announced once', () => {
    run(1, 6000);
    tick(3000);
    expect(said()).toEqual(['6 seconds to bid']);
  });

  it('a snapshot restating the running clock (its deadline rebuilt from receipt) says nothing new; a top-up or a clock after a stop does', () => {
    run(1, 15000);
    tick(6000);
    expect(said()).toEqual(['15 seconds to bid', '10 seconds to bid']);
    // a background probe's stateSnapshot / gap resync: the same clock, 200 ms off
    state.applyBidClock({ gameId: 'g1', position: 1, running: true, inMs: 9000 - 200, durationMs: 30000 });
    bm.showBidUI(5, () => true);
    bm.syncClock();
    expect(clockEl()).toBeTruthy();
    expect(said()).toHaveLength(2);
    // its deadline is followed: the countdown ends 200 ms sooner
    tick(9000 - 200 - BID_CLOCK_UI_MARGIN_MS);
    expect(bm.expired).toBe(true);
    // a resume's top-up (to 10 s) is a new clock
    run(1, 10000);
    expect(said()).toEqual(['15 seconds to bid', '10 seconds to bid', '10 seconds to bid']);
    // stopped (/lazy), then resumed at the same deadline (/active): announced
    // again (a second later: announce() drops the same words within 1 s)
    tick(1000);
    state.applyBidClock({ gameId: 'g1', position: 1, running: false, reason: 'controller' });
    bm.syncClock();
    run(1, 9000);
    expect(said()).toEqual(['15 seconds to bid', '10 seconds to bid', '10 seconds to bid', '9 seconds to bid']);
  });

  it('"1 second to bid", singular, as iOS says it', () => {
    run(1, 1500);
    expect(clockEl().textContent).toBe('1');
    expect(clockEl().getAttribute('aria-label')).toBe('1 second to bid');
    expect(said()).toEqual(['1 second to bid']);
  });

  it('table.css: a quiet number out of the flow (the sheet\'s box does not change), the warning token for the low state', () => {
    const c = rule('.bid-sheet__clock');
    expect(c).toContain('position: absolute');
    expect(c).toContain('tabular-nums');
    expect(c).toContain('var(--type-sm)');
    expect(rule('.bid-sheet__clock--low')).toContain('var(--warning)');
    expect(rule('.bid-sheet__title')).toContain('position: relative');
  });
});

describe('a bid tap off my turn says so (iOS\'s words), on my turn it bids', () => {
  let bm;
  beforeEach(() => {
    resetGameState();
    resetMyAction();
    clearToasts();
    bm = new BidManager({});
  });
  afterEach(() => {
    bm.hideBidUI(false);
    document.getElementById('bidContainer')?.remove();
    clearToasts();
  });

  const button = (label) => [...document.querySelectorAll('#bidContainer .bid-button')].find((b) => b.textContent === label);

  it('a number or a bore off my turn: the "Not your turn." notice (amber), nothing sent', () => {
    const state = getGameState();
    state.position = 1;
    state.currentTurn = 2;
    state.isBidding = true;
    const onBid = vi.fn();
    bm.showBidUI(13, onBid);
    button('3').click();
    expect(onBid).not.toHaveBeenCalled();
    expect(document.querySelector('.kit-toast.toast-warning').textContent).toBe('Not your turn.');
    clearToasts();
    const bore = button('B');
    if (!bore.disabled) {
      bore.click();
      expect(document.querySelector('.kit-toast.toast-warning').textContent).toBe('Not your turn.');
    }
    expect(onBid).not.toHaveBeenCalled();
  });

  it('on my turn: the bid goes out, no toast', () => {
    const state = getGameState();
    state.position = 1;
    state.currentTurn = 1;
    state.isBidding = true;
    const onBid = vi.fn(() => true);
    bm.showBidUI(13, onBid);
    button('3').click();
    expect(onBid).toHaveBeenCalledWith('3');
    expect(document.querySelector('.kit-toast')).toBeNull();
  });
});

describe('the /help suggested bid', () => {
  let bm;
  beforeEach(() => {
    resetGameState();
    bm = new BidManager({});
  });
  afterEach(() => {
    bm.hideBidUI(false);
    document.getElementById('bidContainer')?.remove();
  });

  const suggested = () => [...document.querySelectorAll('#bidContainer .bid-button.is-suggested')];

  it('rings the suggested button (numbers and bores) and names it; null clears it', () => {
    bm.showBidUI(5, () => true);
    bm.setSuggestedBid('3');
    expect(suggested().map((b) => b.textContent)).toEqual(['3']);
    expect(suggested()[0].getAttribute('aria-label')).toBe('3 (suggested)');
    bm.setSuggestedBid('b');
    expect(suggested().map((b) => b.textContent)).toEqual(['B']);
    bm.setSuggestedBid(null);
    expect(suggested()).toEqual([]);
    expect(document.querySelector('#bidContainer .bid-button[aria-label]')).toBeNull();
  });

  it('survives a rebuild of the sheet (a render)', () => {
    bm.showBidUI(5, () => true);
    bm.setSuggestedBid('2');
    bm.showBidUI(5, () => true);
    expect(suggested().map((b) => b.textContent)).toEqual(['2']);
  });

  it('the ring is CSS: a gold ring on .is-suggested', () => {
    expect(rule('.bid-button.is-suggested')).toMatch(/var\(--gold\)/);
  });
});
