/**
 * The web card faces (owner decisions, 2026-11): ONE jumbo corner index at
 * the top left, no rotated index at the bottom right, a centre pip in the
 * space under the index; the "faithful" jokers (the old sprite redrawn:
 * slate outline, light-blue border and panel, the dollar glyph) with HI
 * (red) / LO (black) as their corner index. Since 2026-11-13 ("Feedback is
 * arvo"): the ranks and HI / LO in the bundled card font (Arvo Bold, as
 * "BAB Card Index"; the system UI font as its fallback), the "10" a sans
 * capital I and the slab 0, a 160-unit pip with a clear gap under the
 * corner suit. And, at every desktop table size, the whole index inside
 * the strip of each card the fanned hand leaves showing (computeTableLayout's
 * handPositions), in Arvo and in the fallback.
 *
 * Faces are drawn on the recording context (jsdom has no canvas), measuring
 * with the fonts' real ink metrics (testing/cardFontContext.js): Arvo's from
 * the subset's glyphs, SF's measured in Chrome.
 */
import { describe, it, expect } from 'vitest';
import { recordingContext } from '../../testing/recordingContext.js';
import { cardFontContext, inkOfText, fontPx, CARD_FONT_METRICS } from '../../testing/cardFontContext.js';
import {
  ALL_CARDS, CARD_DESIGN, INDEX, TEN, PIP, SUIT_WIDTH, JOKER_INK, JOKER_WORD, drawCard, rankSize, jokerWordSize, rankRun,
} from './cardFaces.js';
import { CARD_FONT, CARD_FONT_FAMILY } from './cardFont.js';
import { layoutForViewport, handPositions } from '../layout/computeTableLayout.js';
import { COLOR, FONT_UI } from '../../ui/tokens.js';

const C = COLOR.card;
const STANDARD = ALL_CARDS.filter((c) => c.suit !== 'joker');
const JOKERS = ALL_CARDS.filter((c) => c.suit === 'joker');
const colorOf = (suit) => (suit === 'hearts' || suit === 'diamonds' ? C.red : C.black);
const UPEM = CARD_FONT_METRICS.unitsPerEm;
const G = CARD_FONT_METRICS.glyphs;
/** Arvo's flat cap ("K") per px of font size, and the size for a 70-unit cap. */
const ARVO_CAP = G.K.yMax / UPEM;
const ARVO_SIZE = 70 / ARVO_CAP;
/** SF bold's flat cap per px (the fallback). */
const SF_CAP = 0.7046;

/** Both fonts the faces can be drawn in: the loaded card font, and the fallback before it loads. */
const FONTS = [
  { name: 'Arvo (loaded)', opts: { cardFont: true }, cap: ARVO_SIZE },
  { name: 'system fallback', opts: { cardFont: false }, cap: 70 / SF_CAP },
].map((f) => ({ ...f, size: rankSize(cardFontContext(f.opts)) }));

/** A suit fill's box (its SUIT_WIDTH, the 100-unit box's full height), from its transform. */
function suitBox(rec, suit) {
  const size = rec.m.a * 100;
  const cx = rec.m.e + 50 * rec.m.a;
  const cy = rec.m.f + 50 * rec.m.d;
  const hw = (SUIT_WIDTH[suit] * size) / 2;
  return { size, cx, cy, x0: cx - hw, x1: cx + hw, y0: cy - size / 2, y1: cy + size / 2 };
}
function drawn(card, opts = { cardFont: true }, ctx = cardFontContext(opts)) {
  drawCard(ctx, card);
  const texts = ctx.calls.filter((c) => c.op === 'fillText');
  const suits = card.suit === 'joker' ? [] : ctx.calls.filter((c) => c.op === 'fill' && c.fillStyle === colorOf(card.suit));
  const inks = texts.map((t) => inkOfText(t, opts));
  // the word's ink: all its pieces (the "10" is two)
  const ink = inks.length ? {
    x0: Math.min(...inks.map((i) => i.x0)), x1: Math.max(...inks.map((i) => i.x1)),
    y0: Math.min(...inks.map((i) => i.y0)), y1: Math.max(...inks.map((i) => i.y1)), baseline: inks[0].baseline,
  } : null;
  return { ctx, texts, suits, inks, ink };
}
/** Any text, or suit / word-colored fill, drawn turned 180 degrees (a bottom-right index copy). */
const turned = (ctx) => ctx.calls.filter((c) => (c.op === 'fillText' || (c.op === 'fill' && [C.red, C.black].includes(c.fillStyle)))
  && c.m.a < 0 && c.m.d < 0);
const cardFontAt = (size) => `700 ${size}px ${CARD_FONT}`;

describe('the card font: Arvo Bold as "BAB Card Index", the system font as its fallback', () => {
  it('the font stack names the bundled face first, then the UI font', () => {
    expect(CARD_FONT_FAMILY).toBe('BAB Card Index');
    expect(CARD_FONT).toBe(`"BAB Card Index", ${FONT_UI}`);
    expect(CARD_FONT_METRICS.family).toBe(CARD_FONT_FAMILY);
  });

  it('every rank and joker word is drawn in the card font stack, except the 10\'s "1": the UI font\'s capital I', () => {
    for (const card of ALL_CARDS) {
      const { texts } = drawn(card);
      const label = `${card.rank} ${card.suit}`;
      for (const t of texts) {
        if (t.args[0] === 'I' && card.rank === '10') expect(t.font, label).toMatch(new RegExp(`^700 [0-9.]+px ${FONT_UI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
        else expect(t.font, label).toMatch(/^700 [0-9.]+px "BAB Card Index", -apple-system/);
      }
    }
  });
});

describe('the jumbo corner index (design units, 300 x 435)', () => {
  it('the designed numbers', () => {
    expect(INDEX).toEqual({ left: 12, col: 50, top: 18, cap: 70, weight: 700, maxInkW: 106, gap: 5, suit: 54 });
    expect(TEN).toEqual({ iScaleX: 1.02, gap: 6 });
    expect(PIP).toEqual({ size: 160, cx: 150, cy: 300 });
  });

  it('every standard face: ONE rank, a 70-unit cap (Arvo 94.6 px; the fallback 99.3), its ink 18 down, centred on x = 50, unscaled', () => {
    for (const f of FONTS) {
      // the size for a 70-unit cap: the 10 fits, so nothing shrinks
      expect(f.size, f.name).toBeCloseTo(f.cap, 6);
      for (const card of STANDARD.filter((c) => c.rank !== '10')) {
        const label = `${f.name}: ${card.rank} ${card.suit}`;
        const { texts, ink } = drawn(card, f.opts);
        expect(texts.map((t) => t.args[0]), label).toEqual([card.rank]);
        const [t] = texts;
        expect(t.font, label).toBe(cardFontAt(f.size));
        expect(t.fillStyle, label).toBe(colorOf(card.suit));
        expect([t.m.a, t.m.b, t.m.c, t.m.d], label).toEqual([1, 0, 0, 1]);
        expect(ink.y0, label).toBeLessThanOrEqual(18 + 1e-9);
        expect(ink.y0, label).toBeGreaterThan(16); // a round glyph's overshoot only
        expect((ink.x0 + ink.x1) / 2, label).toBeCloseTo(50, 6);
        // one baseline for every rank: the flat cap's, 70 under the top
        expect(ink.baseline, label).toBeCloseTo(18 + 70, 6);
      }
    }
    expect(ARVO_SIZE).toBeCloseTo(94.6, 1);
  });

  it('the "10" is a sans capital I (the UI font, its cap the slab figure height, widened 1.02) and the slab 0, a 6-unit ink gap', () => {
    for (const f of FONTS) {
      for (const suit of ['hearts', 'spades', 'diamonds', 'clubs']) {
        const label = `${f.name}: 10 ${suit}`;
        const { texts, inks, ink } = drawn({ suit, rank: '10' }, f.opts);
        expect(texts.map((t) => t.args[0]), label).toEqual(['I', '0']);
        const [one, zero] = texts;
        expect(one.font.endsWith(`px ${FONT_UI}`), label).toBe(true);
        expect(zero.font, label).toBe(cardFontAt(f.size));
        for (const t of texts) expect(t.fillStyle, label).toBe(colorOf(suit));
        // the I widened to the slab 0's stroke, never condensed or rotated
        expect([one.m.a, one.m.b, one.m.c, one.m.d], label).toEqual([1.02, 0, 0, 1]);
        expect(zero.m.a, label).toBe(1);
        // the I's cap is the slab's flat figure height (its "7": 70), on the ranks' baseline
        expect(inks[0].y1 - inks[0].y0, label).toBeCloseTo(70, 6);
        expect(inks[0].baseline, label).toBeCloseTo(88, 6);
        expect(inks[1].baseline, label).toBeCloseTo(88, 6);
        // the small ink gap, I then 0
        expect(inks[1].x0 - inks[0].x1, label).toBeCloseTo(6, 6);
        // centred like every rank, never nearer the edge than 12 (the fallback's wider 0)
        expect(ink.x0, label).toBeCloseTo(Math.max(12, 50 - (ink.x1 - ink.x0) / 2), 6);
        expect(ink.x1, label).toBeLessThanOrEqual(INDEX.left + INDEX.maxInkW);
      }
    }
    // in Arvo: 75.5 units of ink from x = 12.2 (the study's "10")
    const { ink } = drawn({ suit: 'clubs', rank: '10' });
    expect(ink.x1 - ink.x0).toBeCloseTo(75.5, 1);
    expect(ink.x0).toBeCloseTo(12.2, 1);
    // and no "1" glyph anywhere (the slab 1 reads as an I with a flag)
    for (const card of ALL_CARDS) expect(drawn(card).texts.some((t) => t.args[0].includes('1'))).toBe(false);
  });

  it('a font whose "10" is wider than the column shrinks EVERY rank alike (never condenses the 10)', () => {
    // the recording context's own measure: 0.6 em a character, no ink metrics
    const plain = recordingContext();
    const size = rankSize(plain);
    const run = rankRun(plain, '10', 70 / 0.705);
    expect(run.right - run.left).toBeGreaterThan(INDEX.maxInkW);
    expect(size).toBeCloseTo(((70 / 0.705) * INDEX.maxInkW) / (run.right - run.left), 9);
    const sizes = new Set();
    for (const card of STANDARD) {
      const { texts } = drawn(card, undefined, recordingContext());
      sizes.add(fontPx(texts[texts.length - 1].font));
      expect(texts[texts.length - 1].m.a).toBe(1);
    }
    expect([...sizes]).toEqual([size]);
  });

  it('the suit: 54 units, its box 5 under the deepest rank descender (Arvo\'s Q tail: 23.2 under the baseline), centred under the rank', () => {
    const qTail = (-G.Q.yMin / UPEM) * ARVO_SIZE;
    expect(qTail + 5).toBeCloseTo(23.2, 1);
    for (const f of FONTS) {
      const drop = f.opts.cardFont ? qTail + 5 : 0.0662 * f.size + 5;
      for (const card of STANDARD) {
        const label = `${f.name}: ${card.rank} ${card.suit}`;
        const { suits, ink } = drawn(card, f.opts);
        expect(suits, label).toHaveLength(2); // the index's suit and the pip: nothing else
        const s = suitBox(suits[0], card.suit);
        expect(s.size, label).toBeCloseTo(54, 6);
        expect(s.y0, label).toBeCloseTo(ink.baseline + drop, 6);
        expect(s.y0, label).toBeGreaterThan(ink.y1 + 4); // clear of every descender (the Q)
        expect(s.cx, label).toBeCloseTo((ink.x0 + ink.x1) / 2, 6);
      }
    }
  });

  it('no bottom-right index: one rank (the 10: its I and 0), one index suit and the pip, nothing turned 180 degrees', () => {
    for (const card of ALL_CARDS) {
      const { ctx, texts, suits } = drawn(card);
      const label = `${card.rank} ${card.suit}`;
      expect(turned(ctx), label).toEqual([]);
      expect(texts, label).toHaveLength(card.rank === '10' ? 2 : 1);
      if (card.suit !== 'joker') expect(suits, label).toHaveLength(2);
      for (const t of texts) expect(t.at.x < CARD_DESIGN.w / 2 && t.at.y < CARD_DESIGN.h / 2, label).toBe(true);
    }
  });

  it('the centre pip: 160 units, its own element: 48+ units clear under the corner suit, balanced in the space below, on the card', () => {
    const { w, h } = CARD_DESIGN;
    for (const f of FONTS) {
      for (const card of STANDARD) {
        const label = `${f.name}: ${card.rank} ${card.suit}`;
        const { suits, ink } = drawn(card, f.opts);
        const pip = suitBox(suits[1], card.suit);
        const idx = suitBox(suits[0], card.suit);
        expect(pip.size, label).toBeCloseTo(160, 6);
        expect(pip.cx, label).toBeCloseTo(w / 2, 6);
        expect(pip.cy, label).toBeCloseTo(300, 6);
        // a clear gap under the corner suit (the 200 pip left 28: it read as stacked on it)
        expect(pip.y0 - Math.max(idx.y1, ink.y1), label).toBeGreaterThanOrEqual(48);
        // smaller than the 200-unit pip, still twice iOS's 74
        expect(pip.size, label).toBeLessThan(200);
        expect(pip.size / 74, label).toBeGreaterThan(2);
        expect(pip.x0, label).toBeGreaterThan(70);
        expect(pip.x1, label).toBeLessThan(w - 70);
        expect(h - pip.y1, label).toBeGreaterThanOrEqual(48);
      }
    }
    // in Arvo the gap above it and the margin below it match (balanced)
    const { suits } = drawn({ suit: 'hearts', rank: 'Q' });
    const pip = suitBox(suits[1], 'hearts');
    const idx = suitBox(suits[0], 'hearts');
    expect(Math.abs((pip.y0 - idx.y1) - (h - pip.y1))).toBeLessThan(1);
  });
});

describe('the jokers (the faithful sprite, HI / LO as the corner index)', () => {
  it('HI in card red, LO in card black: the one word, top left, the card font, its ink 12 units inside the slate outline', () => {
    for (const f of FONTS) {
      for (const [rank, color] of [['HI', C.red], ['LO', C.black]]) {
        const label = `${f.name}: ${rank}`;
        const { ctx, texts, ink } = drawn({ suit: 'joker', rank }, f.opts);
        expect(texts.map((t) => t.args[0]), label).toEqual([rank]); // no top-right label, no JOKER
        const [t] = texts;
        expect(t.fillStyle, label).toBe(color);
        expect([t.m.a, t.m.b, t.m.c, t.m.d], label).toEqual([1, 0, 0, 1]);
        expect(t.font, label).toBe(cardFontAt(jokerWordSize(cardFontContext(f.opts))));
        expect(JOKER_WORD).toEqual({ left: 20, top: 24, maxInkW: 98 });
        expect(ink.y0, label).toBeGreaterThan(22.5);
        expect(ink.y0, label).toBeLessThanOrEqual(24 + 1e-9);
        expect(ink.x0, label).toBeGreaterThanOrEqual(6 + 12 - 1e-9);
        expect(ink.x1, label).toBeLessThanOrEqual(INDEX.left + INDEX.maxInkW + 1e-9);
        expect(texts.filter((x) => x.at.x > 150), label).toEqual([]);
        expect(turned(ctx), label).toEqual([]);
        const patch = ctx.calls.filter((c) => c.op === 'fillRect' && c.fillStyle === C.face);
        expect(patch, label).toHaveLength(1);
        expect(ctx.calls.indexOf(patch[0]), label).toBeLessThan(ctx.calls.indexOf(t));
      }
    }
  });

  it('both words one size: shrunk alike so the wider "LO" ends with the index column at 118 (Arvo: a 53.7-unit cap; SF ~83.7 px)', () => {
    const loArvo = (G.L.advance + G.O.xMax - G.L.xMin) / UPEM;
    const size = jokerWordSize(cardFontContext());
    expect(size).toBeCloseTo(98 / loArvo, 6);
    expect(size * ARVO_CAP).toBeCloseTo(53.7, 1);
    expect(jokerWordSize(cardFontContext({ cardFont: false }))).toBeCloseTo((100 * 98) / (122.97 - 5.86), 6);
    const hi = drawn({ suit: 'joker', rank: 'HI' });
    const lo = drawn({ suit: 'joker', rank: 'LO' });
    expect(fontPx(hi.texts[0].font)).toBeCloseTo(size, 9);
    expect(fontPx(lo.texts[0].font)).toBeCloseTo(size, 9);
    expect(lo.ink.x1 - lo.ink.x0).toBeCloseTo(98, 6);
    expect(lo.ink.x1).toBeCloseTo(INDEX.left + INDEX.maxInkW, 6);
  });

  it('faithful: the slate outline, the light-blue border and panel, white flourishes and the black dollar, no purple, no star', () => {
    for (const card of JOKERS) {
      const { ctx, ink } = drawn(card);
      const strokes = (color) => ctx.calls.filter((c) => c.op === 'stroke' && c.strokeStyle === color);
      expect(strokes(JOKER_INK.outline).map((c) => c.lineWidth)).toEqual([12]);
      expect(strokes(JOKER_INK.frame).map((c) => c.lineWidth)).toEqual([6.5]);
      expect(ctx.calls.filter((c) => c.op === 'fill' && c.fillStyle === JOKER_INK.frame)).toHaveLength(1);
      expect(strokes(JOKER_INK.flourish)).toHaveLength(8);
      expect(strokes(JOKER_INK.glyph)).toHaveLength(3);
      expect(ctx.calls.some((c) => c.fillStyle === C.joker || c.strokeStyle === C.joker)).toBe(false);
      // the panel: sprite x 21..43, y 16..48 -> 71..229 x 101.5..333.5, clear of the word
      const panel = ctx.calls.find((c) => c.op === 'fill' && c.fillStyle === JOKER_INK.frame);
      expect(panel.m.a * 21 + panel.m.e).toBeCloseTo((10 * 300) / 42, 6);
      expect(panel.m.d * 16 + panel.m.f).toBeCloseTo((14 * 435) / 60, 6);
      expect(ink.y1 + 6).toBeLessThan(panel.m.d * 16 + panel.m.f);
    }
  });
});

describe('the index in the fanned hand (computeTableLayout)', () => {
  /** The index column's right edge over every face (rank ink, suit, joker word) in one font. */
  const inkRightIn = (opts) => Math.max(...ALL_CARDS.map((card) => {
    const { suits, ink } = drawn(card, opts);
    const xs = [ink.x1];
    if (suits[0]) xs.push(suitBox(suits[0], card.suit).x1);
    return Math.max(...xs);
  }));
  const RIGHT = Object.fromEntries(FONTS.map((f) => [f.name, inkRightIn(f.opts)]));
  /** The narrowest strip a hand of 2-13 cards shows, in CSS px and design units. */
  function tightest(L) {
    let px = Infinity;
    for (let n = 2; n <= 13; n++) {
      const p = handPositions(L, n);
      for (let i = 1; i < n; i++) px = Math.min(px, p[i].x - p[i - 1].x);
    }
    return { px, units: (px / L.card.hand.w) * CARD_DESIGN.w };
  }

  it('the column ends at most 118 units in (12 + 106), in Arvo and in the fallback: the joker\'s "LO" at 118, the 10 well inside', () => {
    for (const f of FONTS) expect(RIGHT[f.name], f.name).toBeCloseTo(INDEX.left + INDEX.maxInkW, 6);
    expect(drawn({ suit: 'clubs', rank: '10' }).ink.x1).toBeLessThan(90);
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
          for (const f of FONTS) {
            const needPx = (RIGHT[f.name] / CARD_DESIGN.w) * L.card.hand.w + 1 / dpr;
            if (needPx > t.px + 1e-9) covered.push(`${f.name} ${vw}x${vh}@${dpr}: strip ${t.px} px, index needs ${needPx.toFixed(2)}`);
          }
          if (t.px <= 16 * L.s + 1 / dpr) minSpacing.push(`${vw}x${vh}@${dpr}`);
          if (!worst || t.units < worst.units) worst = { at: `${vw}x${vh}@${dpr}`, ...t };
        }
      }
    }
    expect(covered).toEqual([]);
    expect(minSpacing).toEqual([]);
    expect(worst.at).toBe('840x500@1');
    expect(worst.units).toBeCloseTo(126.3, 1);
  });

  it('the study\'s sizes: 1280x800 (25.5 px of a 59 px card at DPR 2) and 1440x900 leave room past the index', () => {
    for (const [vw, vh, dpr, px] of [[1280, 800, 2, 25.5], [1280, 800, 1, 25], [1440, 900, 2, 30], [1440, 900, 1, 30]]) {
      const L = layoutForViewport({ vw, vh, dpr });
      const t = tightest(L);
      expect(t.px).toBe(px);
      expect(t.units - RIGHT['Arvo (loaded)'], `${vw}x${vh}@${dpr}`).toBeGreaterThan(8);
      // the rank's cap height in the hand, CSS px (iOS's 40 rank: ~5.5)
      expect((70 / CARD_DESIGN.h) * L.card.hand.h).toBeGreaterThan(13.5);
    }
  });
});
