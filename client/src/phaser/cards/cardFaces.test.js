/**
 * The web card faces (owner decisions, 2026-11): ONE jumbo corner index at
 * the top left (bold ~100 rank, the "10" at its full width, never
 * condensed; a 54-unit suit under it), no rotated index at the bottom
 * right, a 200-unit centre pip filling the card under the index; and the
 * "faithful" jokers (the old sprite redrawn: slate outline, light-blue
 * border and panel, the dollar glyph) with HI (red) / LO (black) as their
 * corner index. And, at every desktop table size, the whole index inside
 * the strip of each card the fanned hand leaves showing
 * (computeTableLayout's handPositions).
 *
 * Faces are drawn on the recording context (jsdom has no canvas). Its
 * measureText gives no ink metrics (0.6 em advance per character), so most
 * tests hand it the measured ink metrics of the system font's bold (SF Pro,
 * Chrome on macOS, 100 px), scaled to the font size in use.
 */
import { describe, it, expect } from 'vitest';
import { recordingContext } from '../../testing/recordingContext.js';
import {
  ALL_CARDS, CARD_DESIGN, INDEX, PIP, SUIT_WIDTH, JOKER_INK, drawCard, rankSize, jokerWordSize,
} from './cardFaces.js';
import { layoutForViewport, handPositions } from '../layout/computeTableLayout.js';
import { COLOR, FONT_UI } from '../../ui/tokens.js';

const C = COLOR.card;
const STANDARD = ALL_CARDS.filter((c) => c.suit !== 'joker');
const JOKERS = ALL_CARDS.filter((c) => c.suit === 'joker');
const colorOf = (suit) => (suit === 'hearts' || suit === 'diamonds' ? C.red : C.black);
const fontPx = (font) => parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)[1]);

/**
 * SF Pro bold at 100 px, measured in the browser (canvas measureText):
 * [advance, actualBoundingBoxLeft, actualBoundingBoxRight, ascent, descent].
 */
const SF_BOLD_100 = {
  A: [69.24, -1.34, 67.87, 70.46, 0], K: [65.33, -5.86, 64.99, 70.46, 0], Q: [75.24, -3.64, 71.61, 71.68, 6.62],
  J: [55.81, -1.51, 49.39, 70.46, 1.22], 10: [113.57, -4.32, 109.5, 71.68, 1.22], 9: [65.23, -4.66, 61.23, 71.68, 1.22],
  8: [64.89, -4.05, 60.84, 71.68, 1.22], 7: [57.23, -3.1, 53.52, 70.46, 0], 6: [65.23, -3.98, 60.55, 71.68, 1.22],
  5: [62.5, -5.62, 59.28, 70.46, 1.22], 4: [64.75, -3.52, 61.87, 70.46, 0], 3: [62.99, -3.74, 58.59, 71.68, 1.22],
  2: [60.3, -4.15, 56.2, 71.68, 0], HI: [99.41, -5.86, 93.55, 70.46, 0], LO: [126.61, -5.86, 122.97, 71.68, 1.22],
};
/** A recording context whose measureText returns the SF ink metrics at its font size. */
function sfContext() {
  const ctx = recordingContext();
  ctx.measureText = (t) => {
    const k = fontPx(ctx.font) / 100;
    const [w, l, r, a, d] = SF_BOLD_100[t].map((v) => v * k);
    return { width: w, actualBoundingBoxLeft: l, actualBoundingBoxRight: r, actualBoundingBoxAscent: a, actualBoundingBoxDescent: d };
  };
  return ctx;
}
/** Ink box of a fillText record (design units), from the SF metrics. */
function inkOf(rec) {
  const k = fontPx(rec.font) / 100;
  const [, l, r, a, d] = SF_BOLD_100[rec.args[0]].map((v) => v * k);
  const x = rec.at.x;
  const y = rec.at.y;
  return { x0: x - l, x1: x + r, y0: y - a, y1: y + d, baseline: y };
}
/** A suit fill's box (its SUIT_WIDTH, the 100-unit box's full height), from its transform. */
function suitBox(rec, suit) {
  const size = rec.m.a * 100;
  const cx = rec.m.e + 50 * rec.m.a;
  const cy = rec.m.f + 50 * rec.m.d;
  const hw = (SUIT_WIDTH[suit] * size) / 2;
  return { size, cx, cy, x0: cx - hw, x1: cx + hw, y0: cy - size / 2, y1: cy + size / 2 };
}
function drawn(card, ctx = sfContext()) {
  drawCard(ctx, card);
  const texts = ctx.calls.filter((c) => c.op === 'fillText');
  const suits = card.suit === 'joker' ? [] : ctx.calls.filter((c) => c.op === 'fill' && c.fillStyle === colorOf(card.suit));
  return { ctx, texts, suits };
}
/** Any text, or suit / word-colored fill, drawn turned 180 degrees (a bottom-right index copy). */
const turned = (ctx) => ctx.calls.filter((c) => (c.op === 'fillText' || (c.op === 'fill' && [C.red, C.black].includes(c.fillStyle)))
  && c.m.a < 0 && c.m.d < 0);

describe('the jumbo corner index (design units, 300 x 435)', () => {
  it('the designed numbers', () => {
    expect(INDEX).toEqual({ left: 12, col: 50, top: 18, rank: 100, weight: 700, maxInkW: 106, gap: 8, suit: 54 });
    expect(PIP).toEqual({ size: 200, cx: 150, cy: 293 });
  });

  it('every standard face: ONE rank (bold 100 with the system font), its ink 18 down and centred on x = 50 (never nearer the edge than 12), unscaled', () => {
    for (const card of STANDARD) {
      const label = `${card.rank} ${card.suit}`;
      const { texts } = drawn(card);
      expect(texts.map((t) => t.args[0]), label).toEqual([card.rank]);
      const [t] = texts;
      expect(t.font, label).toBe(`700 100px ${FONT_UI}`);
      expect(t.fillStyle, label).toBe(colorOf(card.suit));
      // drawn at its natural width: no condensing, no rotation
      expect([t.m.a, t.m.b, t.m.c, t.m.d], label).toEqual([1, 0, 0, 1]);
      const ink = inkOf(t);
      expect(ink.y0, label).toBeLessThanOrEqual(18 + 1e-9);
      expect(ink.y0, label).toBeGreaterThan(16.5); // a round glyph's overshoot only
      expect(ink.x0, label).toBeGreaterThanOrEqual(12 - 1e-9);
      if (card.rank !== '10') expect((ink.x0 + ink.x1) / 2, label).toBeCloseTo(50, 6);
      // one baseline for every rank: the flat cap's (K: 70.46) under the top
      expect(ink.baseline, label).toBeCloseTo(18 + 70.46, 6);
    }
  });

  it('the "10" is FULL WIDTH: its whole 105-unit ink, from 12 to 117.2, inside the column (12 + 106)', () => {
    for (const suit of ['hearts', 'spades', 'diamonds', 'clubs']) {
      const [t] = drawn({ suit, rank: '10' }).texts;
      const ink = inkOf(t);
      expect(t.m.a).toBe(1);
      expect(ink.x1 - ink.x0).toBeCloseTo(105.18, 2);
      expect(ink.x0).toBeCloseTo(12, 6);
      expect(ink.x1).toBeLessThanOrEqual(INDEX.left + INDEX.maxInkW);
    }
  });

  it('a font whose "10" is wider than the column shrinks EVERY rank alike (never condenses the 10)', () => {
    // the recording context's own measure: 0.6 em a character, "10" = 120 at 100
    const plain = recordingContext();
    expect(rankSize(plain)).toBeCloseTo((100 * 106) / 120, 9);
    const sizes = new Set();
    for (const card of STANDARD) {
      const { texts } = drawn(card, recordingContext());
      expect(texts).toHaveLength(1);
      expect(texts[0].m.a).toBe(1);
      sizes.add(fontPx(texts[0].font));
    }
    expect([...sizes]).toHaveLength(1);
    expect([...sizes][0]).toBeCloseTo(88.33, 2);
    // and with SF, whose "10" fits, every rank stays at 100
    expect(rankSize(sfContext())).toBe(100);
  });

  it('the suit: 54 units, its box 8 under the baseline, centred under the rank\'s ink', () => {
    for (const card of STANDARD) {
      const label = `${card.rank} ${card.suit}`;
      const { texts, suits } = drawn(card);
      expect(suits, label).toHaveLength(2); // the index's suit and the pip: nothing else
      const ink = inkOf(texts[0]);
      const s = suitBox(suits[0], card.suit);
      expect(s.size, label).toBeCloseTo(54, 6);
      expect(s.y0, label).toBeCloseTo(ink.baseline + 8, 6);
      expect(s.cx, label).toBeCloseTo((ink.x0 + ink.x1) / 2, 6);
    }
  });

  it('no bottom-right index: one rank, one index suit and the pip, nothing turned 180 degrees', () => {
    for (const card of ALL_CARDS) {
      const { ctx, texts, suits } = drawn(card);
      const label = `${card.rank} ${card.suit}`;
      expect(turned(ctx), label).toEqual([]);
      expect(texts, label).toHaveLength(1);
      if (card.suit !== 'joker') expect(suits, label).toHaveLength(2);
      // nothing in the old bottom-right index's place but the pip
      for (const t of texts) expect(t.at.x < CARD_DESIGN.w / 2 && t.at.y < CARD_DESIGN.h / 2, label).toBe(true);
    }
  });

  it('the centre pip: 200 units, centred across the card and in the space under the index, clear of it, on the card', () => {
    const { w, h } = CARD_DESIGN;
    for (const card of STANDARD) {
      const label = `${card.rank} ${card.suit}`;
      const { texts, suits } = drawn(card);
      const pip = suitBox(suits[1], card.suit);
      const idx = suitBox(suits[0], card.suit);
      const ink = inkOf(texts[0]);
      expect(pip.size, label).toBeCloseTo(200, 6);
      expect(pip.cx, label).toBeCloseTo(w / 2, 6);
      expect(pip.cy, label).toBeCloseTo(293, 6);
      // clear of the index (rank ink and suit) by 30+ units
      expect(pip.y0 - Math.max(idx.y1, ink.y1), label).toBeGreaterThan(30);
      // the gap above it and the margin below it match (balanced in the free space)
      expect(Math.abs((pip.y0 - idx.y1) - (h - pip.y1)), label).toBeLessThan(2);
      expect(pip.x0, label).toBeGreaterThan(40);
      expect(pip.x1, label).toBeLessThan(w - 40);
      // 2.7x iOS's 74-unit pip
      expect(pip.size / 74).toBeGreaterThan(2.7);
    }
  });
});

describe('the jokers (the faithful sprite, HI / LO as the corner index)', () => {
  it('HI in card red, LO in card black: the one word, top left, the ranks\' bold, its ink at the index\'s top and left', () => {
    for (const [rank, color] of [['HI', C.red], ['LO', C.black]]) {
      const { ctx, texts } = drawn({ suit: 'joker', rank });
      expect(texts.map((t) => t.args[0])).toEqual([rank]); // no top-right label, no JOKER
      const [t] = texts;
      expect(t.fillStyle).toBe(color);
      expect([t.m.a, t.m.b, t.m.c, t.m.d]).toEqual([1, 0, 0, 1]);
      expect(t.font.startsWith('700 ')).toBe(true);
      const ink = inkOf(t);
      expect(ink.y0).toBeGreaterThan(16.5);
      expect(ink.y0).toBeLessThanOrEqual(18 + 1e-9);
      expect(ink.x0).toBeGreaterThanOrEqual(12 - 1e-9);
      expect(ink.x1).toBeLessThanOrEqual(INDEX.left + INDEX.maxInkW + 1e-9);
      // nothing in the old top-right label's place (x > 150, above the panel)
      expect(texts.filter((x) => x.at.x > 150)).toEqual([]);
      // no rotated copy at the bottom right
      expect(turned(ctx)).toEqual([]);
      // the word sits on a white patch that the inner border passes behind
      const patch = ctx.calls.filter((c) => c.op === 'fillRect' && c.fillStyle === C.face);
      expect(patch).toHaveLength(1);
      expect(ctx.calls.indexOf(patch[0])).toBeLessThan(ctx.calls.indexOf(t));
    }
  });

  it('both words one size: the ranks\' 100, shrunk alike so the wider "LO" keeps inside the index column (SF: ~90.5)', () => {
    const size = jokerWordSize(sfContext());
    // SF's bold "LO" has 117.1 units of ink at 100
    expect(size).toBeCloseTo((100 * 106) / (122.97 - 5.86), 6);
    const hi = drawn({ suit: 'joker', rank: 'HI' }).texts[0];
    const lo = drawn({ suit: 'joker', rank: 'LO' }).texts[0];
    expect(fontPx(hi.font)).toBeCloseTo(size, 9);
    expect(fontPx(lo.font)).toBeCloseTo(size, 9);
    expect(inkOf(lo).x1 - inkOf(lo).x0).toBeCloseTo(106, 6);
  });

  it('faithful: the slate outline, the light-blue border and panel, white flourishes and the black dollar, no purple, no star', () => {
    for (const card of JOKERS) {
      const { ctx } = drawn(card);
      const strokes = (color) => ctx.calls.filter((c) => c.op === 'stroke' && c.strokeStyle === color);
      expect(strokes(JOKER_INK.outline).map((c) => c.lineWidth)).toEqual([12]);
      expect(strokes(JOKER_INK.frame).map((c) => c.lineWidth)).toEqual([6.5]);
      expect(ctx.calls.filter((c) => c.op === 'fill' && c.fillStyle === JOKER_INK.frame)).toHaveLength(1);
      // 4 flourishes: an L and a ring each
      expect(strokes(JOKER_INK.flourish)).toHaveLength(8);
      // the dollar: the S, the bars with their loop, the serifs
      expect(strokes(JOKER_INK.glyph)).toHaveLength(3);
      expect(ctx.calls.some((c) => c.fillStyle === C.joker || c.strokeStyle === C.joker)).toBe(false);
      // the panel on the design canvas: sprite x 21..43, y 16..48 -> 71..229 x 101.5..333.5, clear of the word
      const panel = ctx.calls.find((c) => c.op === 'fill' && c.fillStyle === JOKER_INK.frame);
      expect(panel.m.a * 21 + panel.m.e).toBeCloseTo((10 * 300) / 42, 6);
      expect(panel.m.d * 16 + panel.m.f).toBeCloseTo((14 * 435) / 60, 6);
      const word = inkOf(drawn(card).texts[0]);
      expect(word.y1 + 6).toBeLessThan(panel.m.d * 16 + panel.m.f);
    }
  });
});

describe('the index in the fanned hand (computeTableLayout)', () => {
  // the index column's right edge over every face: rank ink, suit, joker word
  const inkRight = Math.max(...ALL_CARDS.map((card) => {
    const { texts, suits } = drawn(card);
    const xs = [inkOf(texts[0]).x1];
    if (suits[0]) xs.push(suitBox(suits[0], card.suit).x1);
    return Math.max(...xs);
  }));
  /** The narrowest strip a hand of 2-13 cards shows, in CSS px and design units. */
  function tightest(L) {
    let px = Infinity;
    for (let n = 2; n <= 13; n++) {
      const p = handPositions(L, n);
      for (let i = 1; i < n; i++) px = Math.min(px, p[i].x - p[i - 1].x);
    }
    return { px, units: (px / L.card.hand.w) * CARD_DESIGN.w };
  }

  it('the column ends at most 118 units in (12 + 106): the full-width "10" at 117.2, the joker\'s "LO" at 118', () => {
    expect(inkRight).toBeCloseTo(INDEX.left + INDEX.maxInkW, 6);
    const ten = inkOf(drawn({ suit: 'clubs', rank: '10' }).texts[0]);
    expect(ten.x1).toBeCloseTo(12 + 105.18, 2);
  });

  it('desktop sweep (800-2560 x 500-1440, DPR 1 and 2): the whole index, "10" included, shows a device pixel clear of the next card', () => {
    const covered = [];
    const minSpacing = [];
    let worst = null;
    for (let vw = 800; vw <= 2560; vw += 40) {
      for (let vh = 500; vh <= 1440; vh += 40) {
        for (const dpr of [1, 2]) {
          const L = layoutForViewport({ vw, vh, dpr });
          const t = tightest(L);
          const needPx = (inkRight / CARD_DESIGN.w) * L.card.hand.w + 1 / dpr;
          if (needPx > t.px + 1e-9) covered.push(`${vw}x${vh}@${dpr}: strip ${t.px} px, index needs ${needPx.toFixed(2)}`);
          // the hand box's MIN_HAND_SPACING floor (16 x s, ~72-75 units: it
          // would cover the "10") is never what a hand gets
          if (t.px <= 16 * L.s + 1 / dpr) minSpacing.push(`${vw}x${vh}@${dpr}`);
          if (!worst || t.units < worst.units) worst = { at: `${vw}x${vh}@${dpr}`, ...t };
        }
      }
    }
    expect(covered).toEqual([]);
    expect(minSpacing).toEqual([]);
    // the tightest: 840x500 at DPR 1, a 16 px strip of a 38 px card (126 units)
    expect(worst.at).toBe('840x500@1');
    expect(worst.units).toBeCloseTo(126.3, 1);
  });

  it('the study\'s sizes: 1280x800 (25.5 px of a 59 px card at DPR 2) and 1440x900 leave room past the "10"', () => {
    for (const [vw, vh, dpr, px] of [[1280, 800, 2, 25.5], [1280, 800, 1, 25], [1440, 900, 2, 30], [1440, 900, 1, 30]]) {
      const L = layoutForViewport({ vw, vh, dpr });
      const t = tightest(L);
      expect(t.px).toBe(px);
      expect(t.units - inkRight, `${vw}x${vh}@${dpr}`).toBeGreaterThan(8);
      // the rank's cap height in the hand, CSS px (iOS's 40 rank: ~5.5)
      expect((70.46 / CARD_DESIGN.h) * L.card.hand.h).toBeGreaterThan(13.5);
    }
  });
});
