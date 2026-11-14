/**
 * The JUMBO corner index (web readability, 2026-11): the rank in bold 100
 * design units (iOS: 40), the suit 54 (iOS: 24) 8 units under the rank's
 * ink, the column centred 50 units in, "10" condensed to 74 units of ink,
 * an 84-unit centre pip; and, at every table size, the index inside the
 * strip of each card the fanned hand leaves showing (computeTableLayout's
 * handPositions), the measure of whether the bigger index helps at all.
 *
 * Faces are drawn on the recording context (jsdom has no canvas): it has
 * no ink metrics, so the face falls back to the advance width (0.6 em per
 * character there) and a 0.70 em cap; one test hands it a browser's
 * actualBoundingBox metrics instead.
 */
import { describe, it, expect } from 'vitest';
import { recordingContext } from '../../testing/recordingContext.js';
import { ALL_CARDS, CARD_DESIGN, INDEX, PIP, SUIT_WIDTH, drawCard, inkMetrics } from './cardFaces.js';
import { layoutForViewport, handPositions } from '../layout/computeTableLayout.js';
import { COLOR } from '../../ui/tokens.js';

const C = COLOR.card;
const STANDARD = ALL_CARDS.filter((c) => c.suit !== 'joker');
const colorOf = (suit) => (suit === 'hearts' || suit === 'diamonds' ? C.red : C.black);
const fontPx = (font) => parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
const pt = (m, x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
function box(m, x0, y0, x1, y1) {
  const ps = [pt(m, x0, y0), pt(m, x1, y0), pt(m, x0, y1), pt(m, x1, y1)];
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Draw a card and read back WHERE its index and pip went, in design units:
 * each rank's ink box (from the same metrics the face used) and each suit
 * shape's box (its SUIT_WIDTH, the full 100-unit height).
 */
function drawn(card, ctx = recordingContext()) {
  drawCard(ctx, card);
  const ranks = ctx.calls.filter((c) => c.op === 'fillText').map((c) => {
    const probe = recordingContext();
    if (ctx.metrics) probe.measureText = ctx.measureText;
    probe.font = c.font;
    const ink = inkMetrics(probe, c.args[0], fontPx(c.font));
    const x = c.args[1] + ink.left;
    return { font: c.font, size: fontPx(c.font), m: c.m, ...box(c.m, x, -ink.ascent, x + ink.width, ink.descent) };
  });
  const sw = SUIT_WIDTH[card.suit];
  const suits = ctx.calls.filter((c) => c.op === 'fill' && c.fillStyle === colorOf(card.suit))
    .map((c) => ({ size: c.m.a * 100 * Math.sign(c.m.a), ...box(c.m, 50 - 50 * sw, 0, 50 + 50 * sw, 100), m: c.m }));
  // the order the face draws: rank, suit (top left), rank, suit (bottom right), pip
  return { ranks, tl: { rank: ranks[0], suit: suits[0] }, br: { rank: ranks[1], suit: suits[1] }, pip: suits[2] };
}
const cx = (b) => (b.x0 + b.x1) / 2;
const cy = (b) => (b.y0 + b.y1) / 2;

describe('the jumbo corner index (design units, 300 x 435)', () => {
  it('the designed numbers', () => {
    expect(INDEX).toEqual({ col: 50, top: 18, rank: 100, weight: 700, maxW: 74, gap: 8, suit: 54 });
    expect(PIP.size).toBe(84);
  });

  it('every face: a bold 100 rank whose ink starts 18 down, centred on x = 50, at most 74 wide; the 54-unit suit 8 under it; an 84 pip', () => {
    for (const card of STANDARD) {
      const label = `${card.rank} ${card.suit}`;
      const { ranks, tl, pip } = drawn(card);
      expect(ranks, label).toHaveLength(2);
      expect(tl.rank.font.startsWith('700 100px '), label).toBe(true);
      expect(tl.rank.y0, label).toBeCloseTo(18, 6);
      expect(cx(tl.rank), label).toBeCloseTo(50, 6);
      expect(tl.rank.x1 - tl.rank.x0, label).toBeLessThanOrEqual(74 + 1e-9);
      // the cap: 0.70 em of 100, so the rank is ~70 units tall (iOS: ~28)
      expect(tl.rank.y1 - tl.rank.y0, label).toBeCloseTo(70, 6);
      expect(tl.suit.size, label).toBeCloseTo(54, 6);
      expect(cx(tl.suit), label).toBeCloseTo(50, 6);
      expect(tl.suit.y0, label).toBeCloseTo(tl.rank.y1 + 8, 6);
      expect(pip.size, label).toBeCloseTo(84, 6);
      expect(cx(pip), label).toBeCloseTo(CARD_DESIGN.w / 2, 6);
      expect(cy(pip), label).toBeCloseTo(CARD_DESIGN.h / 2, 6);
    }
  });

  it('the bottom-right index is the top-left one turned 180 degrees about the centre', () => {
    const { w, h } = CARD_DESIGN;
    for (const card of STANDARD) {
      const { tl, br } = drawn(card);
      expect(br.rank.m.a).toBeCloseTo(-tl.rank.m.a, 6);
      for (const part of ['rank', 'suit']) {
        expect(br[part].x0).toBeCloseTo(w - tl[part].x1, 6);
        expect(br[part].x1).toBeCloseTo(w - tl[part].x0, 6);
        expect(br[part].y0).toBeCloseTo(h - tl[part].y1, 6);
        expect(br[part].y1).toBeCloseTo(h - tl[part].y0, 6);
      }
    }
  });

  it('"10" is condensed to fit its column (74 units of ink, 13 to 87); single ranks keep their width', () => {
    const ten = drawn({ suit: 'hearts', rank: '10' }).tl.rank;
    expect(ten.x0).toBeCloseTo(13, 6);
    expect(ten.x1).toBeCloseTo(87, 6);
    expect(ten.m.a).toBeCloseTo(74 / 120, 6); // the recording font's "10" is 120 wide
    const king = drawn({ suit: 'spades', rank: 'K' }).tl.rank;
    expect(king.m.a).toBeCloseTo(1, 6);
    expect(king.x1 - king.x0).toBeCloseTo(60, 6);
  });

  it('with a browser\'s ink metrics: ink (not advance) is centred and condensed, and a descender pushes the suit down', () => {
    // SF-like ink at 100 px: "10" 112 wide with a 4-unit left bearing; Q's tail 6 below the baseline
    const INK = { 10: [-4, 116, 71, 0], Q: [-3, 68, 72, 6], K: [-6, 66, 70, 0] };
    const metered = () => {
      const ctx = recordingContext();
      ctx.metrics = true;
      ctx.measureText = function measureText(t) {
        const [l, r, a, d] = INK[t] || [-2, 58, 70, 0];
        return { width: 64 * String(t).length, actualBoundingBoxLeft: l, actualBoundingBoxRight: r, actualBoundingBoxAscent: a, actualBoundingBoxDescent: d };
      };
      return ctx;
    };
    const ten = drawn({ suit: 'clubs', rank: '10' }, metered()).tl;
    expect(ten.rank.x0).toBeCloseTo(13, 6);
    expect(ten.rank.x1).toBeCloseTo(87, 6);
    expect(ten.rank.m.a).toBeCloseTo(74 / 112, 6);
    expect(ten.rank.y0).toBeCloseTo(18, 6);
    const q = drawn({ suit: 'hearts', rank: 'Q' }, metered()).tl;
    expect(q.rank.m.a).toBeCloseTo(1, 6);
    expect(cx(q.rank)).toBeCloseTo(50, 6);
    expect(q.rank.y0).toBeCloseTo(18, 6);
    expect(q.suit.y0).toBeCloseTo(18 + 72 + 6 + 8, 6);
    const k = drawn({ suit: 'spades', rank: 'K' }, metered()).tl;
    expect(cx(k.rank)).toBeCloseTo(50, 6);
    expect(k.suit.y0).toBeCloseTo(18 + 70 + 8, 6);
  });

  it('both indices stay on the card (inside its rounded corner and border) and clear of the pip', () => {
    const { w, h, radius } = CARD_DESIGN;
    const border = 1.5; // half the 3-unit stroke lands inside the clip
    const onCard = (x, y) => {
      if (x < border || y < border || x > w - border || y > h - border) return false;
      const ccx = Math.min(Math.max(x, radius), w - radius);
      const ccy = Math.min(Math.max(y, radius), h - radius);
      return Math.hypot(x - ccx, y - ccy) <= radius - border;
    };
    for (const card of STANDARD) {
      const { tl, br, pip } = drawn(card);
      for (const b of [tl.rank, tl.suit, br.rank, br.suit]) {
        for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
          expect(onCard(x, y), `${card.rank} ${card.suit} (${x.toFixed(1)}, ${y.toFixed(1)})`).toBe(true);
        }
      }
      expect(tl.suit.y1).toBeLessThan(pip.y0);
      expect(br.suit.y0).toBeGreaterThan(pip.y1);
    }
  });
});

describe('the index in the fanned hand (computeTableLayout)', () => {
  // the index column's right edge over every face: rank ink or suit, whichever is wider
  const inkRight = Math.max(...STANDARD.map((card) => {
    const { tl } = drawn(card);
    return Math.max(tl.rank.x1, tl.suit.x1);
  }));
  const capUnits = 0.7 * Math.max(...drawn({ suit: 'spades', rank: 'K' }).ranks.map((r) => r.size));
  /** The narrowest strip a hand of 2-13 cards shows, in CSS px and design units. */
  function tightest(L) {
    let px = Infinity;
    for (let n = 2; n <= 13; n++) {
      const p = handPositions(L, n);
      for (let i = 1; i < n; i++) px = Math.min(px, p[i].x - p[i - 1].x);
    }
    return { px, units: (px / L.card.hand.w) * CARD_DESIGN.w };
  }

  it('the column ends 87 units in (the "10", condensed)', () => {
    expect(inkRight).toBeCloseTo(87, 6);
  });

  it('desktop sweep (800-2560 x 500-1440, DPR 1 and 2): the whole index shows, a device pixel clear of the next card', () => {
    const covered = [];
    let worst = null;
    for (let vw = 800; vw <= 2560; vw += 40) {
      for (let vh = 500; vh <= 1440; vh += 40) {
        for (const dpr of [1, 2]) {
          const L = layoutForViewport({ vw, vh, dpr });
          const t = tightest(L);
          const needPx = (inkRight / CARD_DESIGN.w) * L.card.hand.w + 1 / dpr;
          if (needPx > t.px + 1e-9) covered.push(`${vw}x${vh}@${dpr}: strip ${t.px} px, index needs ${needPx.toFixed(2)}`);
          if (!worst || t.units < worst.units) worst = { at: `${vw}x${vh}@${dpr}`, ...t };
        }
      }
    }
    expect(covered).toEqual([]);
    // today's tightest strip is ~126 units (840x500 at DPR 1): 39 to spare
    expect(worst.units).toBeGreaterThan(inkRight + 30);
  });

  it('phone sizes too (360-760 x 360-900; the phone gate sends phones to the app): the index ink is inside the strip', () => {
    const covered = [];
    for (let vw = 360; vw <= 760; vw += 40) {
      for (let vh = 360; vh <= 900; vh += 30) {
        for (const dpr of [1, 2, 3]) {
          const L = layoutForViewport({ vw, vh, dpr });
          if (!L.hand) continue;
          const t = tightest(L);
          if (inkRight >= t.units) covered.push(`${vw}x${vh}@${dpr}: ${t.units.toFixed(1)} units`);
        }
      }
    }
    expect(covered).toEqual([]);
  });

  it('the rank reads: at least 12 CSS px tall in the hand at the common laptop and desktop sizes (iOS\'s 40-unit rank: ~5.5)', () => {
    for (const [vw, vh] of [[1280, 720], [1280, 800], [1366, 768], [1440, 900], [1512, 982], [1728, 1117], [1920, 1080], [2560, 1440]]) {
      for (const dpr of [1, 2]) {
        const L = layoutForViewport({ vw, vh, dpr });
        const cap = (capUnits / CARD_DESIGN.h) * L.card.hand.h;
        expect(cap, `${vw}x${vh}@${dpr}`).toBeGreaterThanOrEqual(12);
      }
    }
  });
});
