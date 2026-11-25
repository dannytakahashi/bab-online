/**
 * Cut for a buck's ring geometry (spec section 9, Web): n 2..20 at the
 * stage sizes of a 360 / 768 / 1280 px window, no overlaps, in bounds, me
 * at 6 o'clock, then clockwise, equal arcs.
 */
import { describe, it, expect } from 'vitest';
import { ringLayout, ringOrder, ellipsePerimeter, equalArcAngles, rectsOverlap, DENSE_FROM, DECK_MIN, AVATAR_MAX, CARD_MAX } from './ringLayout.js';

// the stage a window of that width gives the cut (its bar and status above,
// the chat beside it from 760 px, under it below)
const STAGES = [
  { window: 360, w: 344, h: 400 },
  { window: 768, w: 380, h: 470 },
  { window: 1280, w: 760, h: 520 },
];

const all = (L) => L.seats.flatMap((s) => [
  { kind: 'avatar', order: s.order, r: s.avatar },
  { kind: 'name', order: s.order, r: s.name },
  { kind: 'stack', order: s.order, r: s.stack },
]);

describe('ringLayout', () => {
  for (const stage of STAGES) {
    for (let n = 2; n <= 20; n++) {
      it(`${n} players at ${stage.window} px: in bounds, nothing overlaps, the deck clear`, () => {
        const L = ringLayout({ w: stage.w, h: stage.h, n });
        expect(L.ok).toBe(true);
        expect(L.seats).toHaveLength(n);
        const boxes = all(L);
        for (const b of boxes) {
          expect(b.r.x).toBeGreaterThanOrEqual(-0.01);
          expect(b.r.y).toBeGreaterThanOrEqual(-0.01);
          expect(b.r.x + b.r.w).toBeLessThanOrEqual(stage.w + 0.01);
          expect(b.r.y + b.r.h).toBeLessThanOrEqual(stage.h + 0.01);
        }
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            // a seat's own avatar and name touch by design
            if (a.order === b.order && a.kind !== 'stack' && b.kind !== 'stack') continue;
            expect(rectsOverlap(a.r, b.r), `${a.kind} ${a.order} vs ${b.kind} ${b.order}`).toBe(false);
          }
          expect(rectsOverlap(boxes[i].r, L.deck), `${boxes[i].kind} ${boxes[i].order} vs the deck`).toBe(false);
        }
        expect(L.deck.h).toBeGreaterThanOrEqual(DECK_MIN - 0.01);
        expect(L.deck.w).toBeGreaterThanOrEqual(DECK_MIN - 0.01);
        expect(L.dense).toBe(n >= DENSE_FROM);
      });
    }
  }

  it('me at 6 o\'clock (bottom centre), then clockwise: left, top, right', () => {
    const L = ringLayout({ w: 760, h: 520, n: 4 });
    const [me, left, top, right] = L.seats;
    expect(me.x).toBeCloseTo(L.cx, 3);
    expect(me.y).toBeGreaterThan(L.cy);
    expect(left.x).toBeLessThan(L.cx);
    expect(top.y).toBeLessThan(L.cy);
    expect(right.x).toBeGreaterThan(L.cx);
    // the cards on the inward ray: mine above me, the top player's below them
    expect(me.card.y + me.card.h).toBeLessThan(me.avatar.y);
    expect(top.card.y).toBeGreaterThan(top.avatar.y + top.avatar.h);
  });

  it('the spec\'s clamps when there is room: a 64 px avatar, a 72 px card', () => {
    const L = ringLayout({ w: 760, h: 520, n: 2 });
    expect(L.avatarD).toBe(AVATAR_MAX);
    expect(L.cardW).toBe(CARD_MAX);
    expect(ringLayout({ w: 760, h: 520, n: 2, maxCardW: 50 }).cardW).toBe(50);
  });

  it('seats at equal arc length (Ramanujan perimeter)', () => {
    const rx = 300;
    const ry = 180;
    const angles = equalArcAngles(rx, ry, 7);
    // the arc between neighbours, integrated finely: all equal
    const arc = (a, b) => {
      let s = 0;
      const steps = 2000;
      for (let i = 0; i < steps; i++) {
        const t0 = a + ((b - a) * i) / steps;
        const t1 = a + ((b - a) * (i + 1)) / steps;
        s += Math.hypot(rx * (Math.cos(t1) - Math.cos(t0)), ry * (Math.sin(t1) - Math.sin(t0)));
      }
      return s;
    };
    const arcs = angles.map((t, i) => arc(t, i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI));
    const per = ellipsePerimeter(rx, ry) / 7;
    for (const a of arcs) expect(Math.abs(a - per) / per).toBeLessThan(0.005);
    expect(ellipsePerimeter(100, 100)).toBeCloseTo(2 * Math.PI * 100, 6);
    expect(angles[0]).toBeCloseTo(Math.PI / 2, 6);
  });

  it('ringOrder puts me first, keeps the order after me, and leaves a spectator\'s order', () => {
    expect(ringOrder(['al', 'bo', 'me', 'cy'], 'me')).toEqual(['me', 'cy', 'al', 'bo']);
    expect(ringOrder(['al', 'bo'], 'zed')).toEqual(['al', 'bo']);
    expect(ringOrder(['me', 'al'], 'me')).toEqual(['me', 'al']);
  });
});
