/**
 * Test harness: a recording context (recordingContext.js) whose measureText
 * gives the ink metrics a browser gives for the card faces' two fonts:
 *
 *   - the bundled card font ("BAB Card Index", Arvo Bold), from its glyph
 *     metrics (cardFontMetrics.json, written with the font by
 *     scripts/build-card-font.py; no kerning between these glyphs). Chrome's
 *     measureText of the loaded font matches them to 0.01 px;
 *   - the system UI font's bold (SF Pro, Chrome on macOS, measured at 100 px).
 *
 * `cardFont: false` is a page where the bundled font has not loaded: a
 * font string that names it measures (and draws) in the system fallback.
 */
import ARVO from './cardFontMetrics.json';
import { recordingContext } from './recordingContext.js';

export const CARD_FONT_METRICS = ARVO;

/**
 * SF Pro bold at 100 px, measured in the browser (canvas measureText):
 * [advance, actualBoundingBoxLeft, actualBoundingBoxRight, ascent, descent].
 */
export const SF_BOLD_100 = {
  A: [69.24, -1.34, 67.87, 70.46, 0], K: [65.33, -5.86, 64.99, 70.46, 0], Q: [75.24, -3.64, 71.61, 71.68, 6.62],
  J: [55.81, -1.51, 49.39, 70.46, 1.22], 10: [113.57, -4.32, 109.5, 71.68, 1.22], 9: [65.23, -4.66, 61.23, 71.68, 1.22],
  8: [64.89, -4.05, 60.84, 71.68, 1.22], 7: [57.23, -3.1, 53.52, 70.46, 0], 6: [65.23, -3.98, 60.55, 71.68, 1.22],
  5: [62.5, -5.62, 59.28, 70.46, 1.22], 4: [64.75, -3.52, 61.87, 70.46, 0], 3: [62.99, -3.74, 58.59, 71.68, 1.22],
  2: [60.3, -4.15, 56.2, 71.68, 0], HI: [99.41, -5.86, 93.55, 70.46, 0], LO: [126.61, -5.86, 122.97, 71.68, 1.22],
  I: [26.46, -5.86, 20.61, 70.46, 0], 0: [65.58, -4.08, 61.5, 71.68, 1.22],
};

export const fontPx = (font) => parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
const namesCardFont = (font) => font.includes(`"${ARVO.family}"`);

/** The card font's metrics of `str` at 100 px (null when a glyph is not in the subset). */
function arvo100(str) {
  const k = 100 / ARVO.unitsPerEm;
  const gs = [...String(str)].map((ch) => ARVO.glyphs[ch]);
  if (!gs.length || gs.some((g) => !g)) return null;
  let pen = 0;
  let right = 0;
  for (const g of gs) {
    right = pen + g.xMax;
    pen += g.advance;
  }
  return [pen * k, -gs[0].xMin * k, right * k, Math.max(...gs.map((g) => g.yMax)) * k, Math.max(0, ...gs.map((g) => -g.yMin)) * k];
}

/** [advance, bbLeft, bbRight, ascent, descent] of `str` in `font`. */
export function measure(font, str, { cardFont = true } = {}) {
  const k = fontPx(font) / 100;
  const m100 = (cardFont && namesCardFont(font) && arvo100(str)) || SF_BOLD_100[str];
  if (!m100) throw new Error(`no test metrics for "${str}" in ${font}`);
  return m100.map((v) => v * k);
}

/** A recording context measuring with the fonts above. */
export function cardFontContext({ cardFont = true } = {}) {
  const ctx = recordingContext();
  ctx.measureText = (t) => {
    const [w, l, r, a, d] = measure(ctx.font, t, { cardFont });
    return { width: w, actualBoundingBoxLeft: l, actualBoundingBoxRight: r, actualBoundingBoxAscent: a, actualBoundingBoxDescent: d };
  };
  return ctx;
}

/** The ink box (design units) a fillText record drew, from these metrics and its transform. */
export function inkOfText(rec, opts) {
  const [, l, r, a, d] = measure(rec.font, rec.args[0], opts);
  const x = rec.at.x;
  const y = rec.at.y;
  return { x0: x - l * rec.m.a, x1: x + r * rec.m.a, y0: y - a * rec.m.d, y1: y + d * rec.m.d, baseline: y };
}
