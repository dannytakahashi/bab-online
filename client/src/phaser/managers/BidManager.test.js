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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BidManager } from './BidManager.js';
import { resetGameState, getGameState } from '../../state/GameState.js';
import { BID_SHEET, BID_CHIP, BID_SHEET_CHROME, BID_SHEET_PAD, BID_SHEET_BORDER } from '../layout/computeTableLayout.js';
import { readClientFile } from '../../testing/files.js';

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
});
