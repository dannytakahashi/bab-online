/**
 * The bid sheet's box is the layout's (BID_SHEET): the bid slot's fit and
 * the overlap check model it, so nothing the sheet draws may stick out of
 * it. Its widest row is the trick chips (one per trick, up to 16 when the
 * bids overbid the hand): 13 chips at their natural width fit the sheet,
 * and an overbid's extra chips shrink to fit instead of overflowing.
 * (jsdom has no layout engine: these check the box model the browser uses.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BidManager } from './BidManager.js';
import { resetGameState, getGameState } from '../../state/GameState.js';
import { BID_SHEET, BID_CHIP, BID_SHEET_CHROME } from '../layout/computeTableLayout.js';

const chipsWidth = (n) => n * BID_CHIP.w + (n - 1) * BID_CHIP.gap;

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
    expect(sheet.style.width).toBe(`${BID_SHEET.w}px`);
    expect(sheet.style.boxSizing).toBe('border-box');
    // the chrome the layout subtracts is the sheet's own (padding + border, both sides)
    expect(2 * parseFloat(sheet.style.padding) + 2 * parseFloat(sheet.style.border)).toBe(BID_SHEET_CHROME);
    expect(bm.trickIndicators).toHaveLength(13);
    for (const chip of bm.trickIndicators) expect(chip.style.width).toBe(`${BID_CHIP.w}px`);
    expect(bm.indicatorRow.style.gap).toBe(`${BID_CHIP.gap}px`);
    expect(chipsWidth(13)).toBeLessThanOrEqual(BID_SHEET.w - BID_SHEET_CHROME);
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
    expect(bm.indicatorRow.style.alignSelf).toBe('stretch');
    expect(parseFloat(bm.indicatorRow.style.minWidth)).toBe(0);
    // ...and every chip may shrink below 18 px
    for (const chip of bm.trickIndicators) {
      expect(chip.style.flexShrink).toBe('1');
      expect(chip.style.flexBasis).toBe(`${BID_CHIP.w}px`);
      expect(parseFloat(chip.style.minWidth)).toBe(0);
    }
  });
});
