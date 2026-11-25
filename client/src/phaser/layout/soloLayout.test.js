/**
 * The three-seat table (Get Your Bid, owner 2026-11-24: "the three players
 * evenly spaced around" the centre, the cards played "representative of
 * where the three players are sitting"): computeTableLayout({solo: true})
 * has no partner seat, raises the other two toward the upper corners and
 * makes the trick a triangle. It is solved by the same search, so it must
 * be clean (no overlaps, nothing off the canvas) wherever the base table
 * is, and every layout without `solo` is exactly as before.
 */
import { describe, it, expect } from 'vitest';
import {
  computeTableLayout, findIntersections, findOutside, logWidthFor, SOLO, DRAW_TEXT, DRAW_TEXT_SOLO,
} from './computeTableLayout.js';

const SIZES = [[2560, 1440], [1920, 1080], [1920, 953], [1600, 900], [1440, 790], [1366, 768], [1280, 800], [1280, 720], [1024, 768], [800, 600]];
const at = (vw, vh, opts = {}) => {
  const logW = logWidthFor(vw);
  return computeTableLayout({ w: vw - logW, h: vh, logW, ...opts });
};

describe('the three-seat layout', () => {
  it.each(SIZES)('%i x %i: clean for a seat and for a spectator, at the base table\'s scale or close to it', (vw, vh) => {
    for (const isSpectator of [false, true]) {
      const L = at(vw, vh, { isSpectator, solo: true });
      expect(L.solo).toBe(true);
      expect(L.degraded).toBe(false);
      expect(findIntersections(L)).toEqual([]);
      expect(findOutside(L)).toEqual([]);
      const base = at(vw, vh, { isSpectator });
      expect(L.s).toBeGreaterThanOrEqual(base.s - 0.05);
    }
  });

  it('no partner: three seats, three trick slots, three draw slots and the solo rule', () => {
    const L = at(1920, 1080, { solo: true });
    expect(Object.keys(L.seats).sort()).toEqual(['opp1', 'opp2', 'self']);
    expect(Object.keys(L.trick.slots).sort()).toEqual(['opponent1', 'opponent2', 'self']);
    expect(L.effects.rainbow.partner).toBeUndefined();
    expect(L.draw.slots).toHaveLength(3);
    expect(DRAW_TEXT_SOLO.rules).not.toMatch(/partner/i);
    expect(DRAW_TEXT.rules).toMatch(/partners/);
    // the three draw slots are centred on the canvas
    expect(L.draw.slots[1].x).toBeCloseTo(L.w / 2, 0);
  });

  it('a trick pile each (owner 2026-11-24: "the opponents tricks on the table need to be separated"): the left opponent\'s top left, the right one\'s top right filling from the right, the trump between them', () => {
    const L = at(1920, 1080, { solo: true });
    expect(Object.keys(L.history).sort()).toEqual(['opp', 'opp2', 'team']);
    const { opp, opp2 } = L.history;
    expect(opp2.rect.y).toBe(opp.rect.y);
    expect(opp.rect.x + opp.rect.w).toBeLessThan(L.trump.rect.x);
    expect(opp2.rect.x).toBeGreaterThan(L.trump.rect.x + L.trump.rect.w);
    expect(L.trump.x).toBeCloseTo(L.w / 2, 0);
    // mirrored: the same margins, its first slot at the right end
    expect(L.w - (opp2.rect.x + opp2.rect.w)).toBeCloseTo(opp.rect.x, 1);
    expect(opp2.slots[0].x).toBeGreaterThan(opp2.slots[1].x);
    expect(opp.slots[0].x).toBeLessThan(opp.slots[1].x);
    for (const s of opp2.slots) {
      expect(s.x - opp2.slotW / 2).toBeGreaterThanOrEqual(opp2.rect.x - 0.01);
      expect(s.x + opp2.slotW / 2).toBeLessThanOrEqual(opp2.rect.x + opp2.rect.w + 0.01);
    }
    // the base table has its two piles and its trump where they were
    const base = at(1920, 1080);
    expect(Object.keys(base.history).sort()).toEqual(['opp', 'team']);
    expect(base.trump.x).toBeGreaterThan(base.w / 2);
  });

  it('the other two sit above the trick\'s line, mirrored, and the trick points at the three seats', () => {
    const L = at(1920, 1080, { solo: true });
    const { center, slots } = L.trick;
    for (const key of ['opp1', 'opp2']) {
      expect(L.seats[key].avatar.y).toBeLessThan(center.y - 0.5 * SOLO.rise * L.s);
      expect(L.seats[key].cards.y).toBeLessThan(center.y);
    }
    expect(L.seats.opp1.avatar.y).toBe(L.seats.opp2.avatar.y);
    expect(L.seats.opp1.avatar.x).toBeLessThan(center.x);
    expect(L.seats.opp2.avatar.x).toBeGreaterThan(center.x);
    // my card below the centre, theirs above it on their own sides
    expect(slots.self.y).toBeGreaterThan(center.y);
    expect(slots.self.x).toBeCloseTo(center.x, 0);
    expect(slots.opponent1.y).toBeLessThan(center.y);
    expect(slots.opponent2.y).toBe(slots.opponent1.y);
    expect(slots.opponent1.x).toBeLessThan(center.x);
    expect(slots.opponent2.x).toBeGreaterThan(center.x);
    // the base table keeps its side seats on the trick's line
    const base = at(1920, 1080);
    expect(base.seats.opp1.cards.y).toBe(base.trick.center.y);
    expect(base.trick.slots.partner).toBeTruthy();
  });

  it.each(SIZES)('%i x %i: a layout without solo is exactly as before', (vw, vh) => {
    const logW = logWidthFor(vw);
    for (const opts of [{}, { isSpectator: true }, { tutorial: true }, { watcher: true }]) {
      const plain = computeTableLayout({ w: vw - logW, h: vh, logW, ...opts });
      expect(computeTableLayout({ w: vw - logW, h: vh, logW, ...opts, solo: false })).toEqual(plain);
      expect(plain.solo).toBeUndefined();
      expect(plain.seats.partner).toBeTruthy();
    }
  });
});
