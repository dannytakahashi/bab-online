/**
 * Card faces, drawn procedurally with Canvas2D (roadmap item 18a): a port of
 * the iOS app's CardTextureGenerator.swift, on the same 300 x 435 design
 * canvas with the same layout and colors (tokens.json color.card):
 *
 *   - a white face, corner radius 24, a grey 3-unit border (stroked on the
 *     edge and clipped to the card, as UIBezierPath.stroke into the bitmap);
 *   - web only (2026-11): ONE jumbo corner index, top left (bold ~100
 *     rank, the full-width "10" never condensed, a 54-unit suit under it;
 *     INDEX), no rotated index at the bottom right, and a big centre pip
 *     filling the card under it (PIP);
 *   - jokers: the old pixel-art sprites redrawn as vectors (slate outline,
 *     light-blue border and panel, the dollar glyph), the word HI (red) or
 *     LO (black) as the corner index;
 *   - the back: a red or blue lattice (drawBack; web only, iOS keeps its own).
 *
 * Suits (and the joker's glyph) are VECTOR PATHS, never text: a suit
 * character can come out as a color emoji on some platforms and font
 * fallback differs between them, a path is the same everywhere. Only the
 * rank letters and the joker words are text, in the UI font (the system
 * stack: SF on Apple devices, as on iOS).
 *
 * Every function draws in design units (300 x 435); the caller maps the
 * design canvas onto its bitmap (CardAtlas: one cell per card).
 */
import { COLOR, FONT_UI, WEIGHT } from '../../ui/tokens.js';
import { RANK_ORDER, SUITS } from '../../constants/ranks.js';
import { getCardImageKey } from '../../utils/cards.js';

/** The design canvas (iOS cardPixelWidth / cardPixelHeight / cornerRadius). */
export const CARD_DESIGN = Object.freeze({ w: 300, h: 435, radius: 24 });
/** Height / width of a card. */
export const CARD_ASPECT = CARD_DESIGN.h / CARD_DESIGN.w;

/**
 * The atlas frames of the card back, one per ink (red on odd hands and the
 * draw for deal, blue on even hands: backFrameForHand), and of the raised
 * card's soft shadow.
 */
export const BACK_FRAMES = Object.freeze({ red: 'back-red', blue: 'back-blue' });
export const SHADOW_FRAME = 'shadow';

const C = COLOR.card;
const SUIT_COLOR = { hearts: C.red, diamonds: C.red, spades: C.black, clubs: C.black };

/** Every face the game deals: 52 + HI / LO jokers, as {suit, rank}. */
export const ALL_CARDS = Object.freeze([
  ...SUITS.flatMap((suit) => RANK_ORDER.map((rank) => ({ suit, rank }))),
  { suit: 'joker', rank: 'HI' },
  { suit: 'joker', rank: 'LO' },
]);

/** The atlas frame names: 54 faces (getCardImageKey), then the back. */
export const FACE_FRAMES = Object.freeze(ALL_CARDS.map((c) => getCardImageKey(c)));

const font = (weight, size) => `${weight} ${size}px ${FONT_UI}`;

/** The rounded-rect path of a card (or any box), in the current transform. */
export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * The suit shapes in a 100 x 100 box (the glyph's full height is 100).
 * Each is one closed path filled nonzero. Proportions follow the system
 * font's suit glyphs.
 */
const SUIT_PATHS = {
  hearts(ctx) {
    ctx.moveTo(50, 96);
    ctx.bezierCurveTo(22, 74, 2, 56, 2, 32);
    ctx.bezierCurveTo(2, 15, 14, 4, 28, 4);
    ctx.bezierCurveTo(39, 4, 46, 11, 50, 21);
    ctx.bezierCurveTo(54, 11, 61, 4, 72, 4);
    ctx.bezierCurveTo(86, 4, 98, 15, 98, 32);
    ctx.bezierCurveTo(98, 56, 78, 74, 50, 96);
    ctx.closePath();
  },
  diamonds(ctx) {
    ctx.moveTo(50, 2);
    ctx.bezierCurveTo(62, 20, 74, 36, 86, 50);
    ctx.bezierCurveTo(74, 64, 62, 80, 50, 98);
    ctx.bezierCurveTo(38, 80, 26, 64, 14, 50);
    ctx.bezierCurveTo(26, 36, 38, 20, 50, 2);
    ctx.closePath();
  },
  spades(ctx) {
    ctx.moveTo(50, 2);
    ctx.bezierCurveTo(64, 20, 98, 38, 98, 62);
    ctx.bezierCurveTo(98, 77, 87, 86, 75, 86);
    ctx.bezierCurveTo(65, 86, 58, 81, 54, 74);
    ctx.bezierCurveTo(55, 84, 60, 92, 68, 98);
    ctx.lineTo(32, 98);
    ctx.bezierCurveTo(40, 92, 45, 84, 46, 74);
    ctx.bezierCurveTo(42, 81, 35, 86, 25, 86);
    ctx.bezierCurveTo(13, 86, 2, 77, 2, 62);
    ctx.bezierCurveTo(2, 38, 36, 20, 50, 2);
    ctx.closePath();
  },
  clubs(ctx) {
    const lobe = (cx, cy, r) => {
      ctx.moveTo(cx + r, cy);
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.closePath();
    };
    lobe(50, 25, 22);
    lobe(26, 58, 22);
    lobe(74, 58, 22);
    lobe(50, 52, 14);
    ctx.moveTo(46, 60);
    ctx.bezierCurveTo(46, 78, 41, 90, 32, 98);
    ctx.lineTo(68, 98);
    ctx.bezierCurveTo(59, 90, 54, 78, 54, 60);
    ctx.closePath();
  },
};

/** Width of each suit shape in its 100-unit box (for centring under the rank). */
export const SUIT_WIDTH = { hearts: 0.96, diamonds: 0.72, spades: 0.96, clubs: 0.92 };

/** Fill a suit shape whose box is centred on (cx, cy), `size` units tall. */
export function drawSuit(ctx, suit, cx, cy, size, color = SUIT_COLOR[suit]) {
  const path = SUIT_PATHS[suit];
  if (!path) throw new Error(`no suit path for ${suit}`);
  const k = size / 100;
  ctx.save();
  ctx.translate(cx - 50 * k, cy - 50 * k);
  ctx.scale(k, k);
  ctx.beginPath();
  path(ctx);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** The face's white rounded rect, its border stroked on the edge and clipped to the card. */
function cardBase(ctx, fill, stroke, lineWidth) {
  const { w, h, radius } = CARD_DESIGN;
  roundRectPath(ctx, 0, 0, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.save();
  roundRectPath(ctx, 0, 0, w, h, radius);
  ctx.clip();
  roundRectPath(ctx, 0, 0, w, h, radius);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
}

/** iOS rank strings: A K Q J, 2-10, HI / LO. */
export function rankLabel(rank) {
  return String(rank).toUpperCase();
}

/**
 * The JUMBO corner index (web only; the 2026-11 readability study): in a
 * fanned hand only a strip of each card's left edge shows (25.5 px of a
 * 59 px card at 1280 x 800, 126 design units at the tightest size the
 * layout makes), and iOS's bold 40 rank was ~5.5 px tall there. One index,
 * top left only (no rotated copy at the bottom right):
 *
 *   - the rank in bold `rank` units (cap ~0.70 em, ~70 units), its ink
 *     `top` units down, centred on the column x = `col` but never closer
 *     than `left` to the card's edge, and NEVER condensed: a full-width
 *     "10" (SF bold: 105 units of ink at 100) runs from `left` to at most
 *     `left + maxInkW` (118, inside the tightest strip less a device pixel;
 *     cardFaces.test.js sweeps it with computeTableLayout). Where a font's
 *     "10" is wider than maxInkW, EVERY rank shrinks to the same smaller
 *     size (rankSize), so the ranks always match;
 *   - the `suit`-unit suit `gap` units under the rank's baseline, centred
 *     under the rank's ink.
 */
export const INDEX = Object.freeze({ left: 12, col: 50, top: 18, rank: 100, weight: WEIGHT.bold, maxInkW: 106, gap: 8, suit: 54 });
/**
 * The centre pip: no bottom-right index any more, so the suit grows to
 * fill the card under the index: `size` units (iOS: the glyph of a 100
 * font, 74), centred across the card and centred in the space between the
 * index (its bottom ~151) and the card's bottom edge.
 */
export const PIP = Object.freeze({ size: 200, cx: 150, cy: 293 });
/** Cap height / em of the UI font where the canvas gives no ink metrics. */
const CAP_EM = 0.705;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The ink box of `str` in the context's current font, relative to the text
 * origin (left aligned, alphabetic baseline): the browser's
 * actualBoundingBox metrics, else (a context without them) the advance
 * width and the cap height.
 */
export function inkMetrics(ctx, str, size) {
  const m = ctx.measureText(str);
  const hasInk = finite(m.actualBoundingBoxLeft) && finite(m.actualBoundingBoxRight)
    && finite(m.actualBoundingBoxAscent) && m.actualBoundingBoxRight + m.actualBoundingBoxLeft > 0;
  if (!hasInk) return { left: 0, width: m.width || 0.6 * size * String(str).length, ascent: CAP_EM * size, descent: 0 };
  return {
    left: -m.actualBoundingBoxLeft,
    width: m.actualBoundingBoxRight + m.actualBoundingBoxLeft,
    ascent: m.actualBoundingBoxAscent,
    descent: finite(m.actualBoundingBoxDescent) ? Math.max(0, m.actualBoundingBoxDescent) : 0,
  };
}

/** Ink width of `str` at `size` in the index weight (restores the context's font). */
function inkWidthAt(ctx, str, size, weight = INDEX.weight) {
  const was = ctx.font;
  ctx.font = font(weight, size);
  const wd = inkMetrics(ctx, str, size).width;
  ctx.font = was;
  return wd;
}

/**
 * The rank size every face uses with this context's font: INDEX.rank,
 * unless the font's full-width "10" has more than INDEX.maxInkW of ink;
 * then all ranks shrink alike until it fits (never a condensed "10").
 */
export function rankSize(ctx) {
  const wd = inkWidthAt(ctx, '10', INDEX.rank);
  return wd > INDEX.maxInkW ? (INDEX.rank * INDEX.maxInkW) / wd : INDEX.rank;
}

/**
 * Draw the word `str` as the corner index: bold `size`, ink top at
 * `at.top`, ink centred on INDEX.col and kept `at.left` from the edge
 * (INDEX's, or the joker word's JOKER_WORD), at its natural width.
 * Returns its ink box and baseline.
 */
function indexWord(ctx, str, size, color, at = INDEX) {
  ctx.save();
  ctx.font = font(INDEX.weight, size);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const ink = inkMetrics(ctx, str, size);
  // one baseline for every rank: a flat cap's ascent ("K"), not each glyph's overshoot
  const baseline = at.top + inkMetrics(ctx, 'K', size).ascent;
  const x0 = Math.max(at.left, INDEX.col - ink.width / 2);
  ctx.fillStyle = color;
  ctx.fillText(str, x0 - ink.left, baseline);
  ctx.restore();
  return { x0, x1: x0 + ink.width, top: baseline - ink.ascent, baseline, bottom: baseline + ink.descent };
}

function drawIndex(ctx, rankStr, suit, color) {
  const r = indexWord(ctx, rankStr, rankSize(ctx), color);
  drawSuit(ctx, suit, (r.x0 + r.x1) / 2, r.baseline + INDEX.gap + INDEX.suit / 2, INDEX.suit, color);
}

/** Draw a standard face (design units): the corner index and one big pip. */
export function drawStandardFace(ctx, card) {
  cardBase(ctx, C.face, C.border, 3);
  const color = SUIT_COLOR[card.suit];
  drawIndex(ctx, rankLabel(card.rank), card.suit, color);
  drawSuit(ctx, card.suit, PIP.cx, PIP.cy, PIP.size, color);
}

// ---------------------------------------------------------------------------
// The jokers: the old 64 x 64 pixel-art sprites (pre PR #207) redrawn as
// vectors (the owner's "faithful" variant A): a slate outline, a light-blue
// inner border, a light-blue centre panel with white corner flourishes and
// the black double-bar dollar glyph. The word HI (card red) or LO (card
// black) is the corner index in the ranks' bold (drawn once: no top-right
// label, no rotated bottom-right copy), inset a little further than the
// ranks (JOKER_WORD) to clear the joker's wider slate outline.

/** The sprites' colours (the words use the deck's card red / black). */
export const JOKER_INK = Object.freeze({
  outline: '#4d5766', // the sprite's dark slate edge
  frame: '#c7d7ec', // the light-blue inner border and centre panel
  flourish: '#ffffff',
  glyph: '#000000',
});
/** The sprite's card (x 11..52, y 2..61: 42 x 60 px) onto the design canvas. */
const SPRITE = Object.freeze({ x: 11, y: 2, sx: CARD_DESIGN.w / 42, sy: CARD_DESIGN.h / 60 });
/**
 * Where the joker word's ink starts: the outline shows 6 units (half its
 * 12-unit stroke, clipped to the card), so at the ranks' left 12 the word
 * touched it (~1 px at DPR 1); 20 / 24 leaves the ranks' own 12-unit
 * margin inside the outline. Its right edge stays at the index column's
 * (INDEX.left + INDEX.maxInkW, 118), so `maxInkW` is that less `left`.
 */
export const JOKER_WORD = Object.freeze({
  left: 20,
  top: 24,
  maxInkW: INDEX.left + INDEX.maxInkW - 20,
});
/** White kept round the joker's word, cutting the inner border behind it. */
const JOKER_WORD_PAD = 6;

/**
 * The joker word's size: the rank size, unless the wider word ("LO") would
 * then pass JOKER_WORD.maxInkW; then both words shrink alike.
 */
export function jokerWordSize(ctx) {
  const size = rankSize(ctx);
  const wd = Math.max(inkWidthAt(ctx, 'HI', size), inkWidthAt(ctx, 'LO', size));
  return wd > JOKER_WORD.maxInkW ? (size * JOKER_WORD.maxInkW) / wd : size;
}

/** One open stroked path. */
function strokeWith(ctx, color, lw, build) {
  ctx.beginPath();
  build();
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/** The sprite's boxy dollar (in sprite pixels, centred on (0, 0)). */
function jokerDollar(ctx, color, lw) {
  const p = (x, y) => [x - 32, y - 32.5];
  const M = (x, y) => ctx.moveTo(...p(x, y));
  const L = (x, y) => ctx.lineTo(...p(x, y));
  const B = (a, b, c, d, e, f) => ctx.bezierCurveTo(...p(a, b), ...p(c, d), ...p(e, f));
  // the S
  strokeWith(ctx, color, lw, () => {
    M(36.5, 28.9);
    L(36.5, 27.2);
    B(36.5, 26.1, 35.7, 25.5, 34.6, 25.5);
    L(29.1, 25.5);
    B(28.0, 25.5, 27.5, 26.2, 27.5, 27.3);
    L(27.5, 30.6);
    B(27.5, 31.5, 28.3, 31.9, 29.2, 32.2);
    L(34.3, 34.2);
    B(35.7, 34.7, 36.5, 35.5, 36.5, 36.7);
    L(36.5, 38.0);
    B(36.5, 39.0, 35.8, 39.5, 34.8, 39.5);
    L(28.9, 39.5);
    B(28.0, 39.5, 27.5, 38.9, 27.5, 38.0);
    L(27.5, 36.6);
  });
  // the two bars and the loop that joins them under the S
  strokeWith(ctx, color, lw, () => {
    M(29.5, 23.5);
    L(29.5, 39.6);
    B(29.5, 41.9, 34.5, 41.9, 34.5, 39.6);
    L(34.5, 23.5);
  });
  // top serifs
  strokeWith(ctx, color, lw, () => {
    M(27.9, 23.5); L(31.1, 23.5);
    M(32.9, 23.5); L(36.1, 23.5);
  });
}

/** A panel corner flourish (sprite pixels, the corner at (0, 0)): an L bracket and a ring. */
function jokerFlourish(ctx, color, lw) {
  strokeWith(ctx, color, lw, () => {
    ctx.moveTo(6, 1.5);
    ctx.lineTo(1.5, 1.5);
    ctx.lineTo(1.5, 6);
  });
  ctx.beginPath();
  ctx.arc(2.5, 2.5, 0.95, 0, Math.PI * 2);
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.stroke();
}

/** Draw a joker (design units). */
export function drawJokerFace(ctx, card) {
  const { w, h } = CARD_DESIGN;
  const hi = rankLabel(card.rank) === 'HI';
  ctx.save();
  cardBase(ctx, C.face, JOKER_INK.outline, 12); // ~6 units show: the sprite's 1 px edge
  // the light-blue inner border (sprite: a 1 px line 3 px in)
  roundRectPath(ctx, 25, 25, w - 50, h - 50, 7);
  ctx.lineWidth = 6.5;
  ctx.strokeStyle = JOKER_INK.frame;
  ctx.stroke();

  ctx.save();
  ctx.scale(SPRITE.sx, SPRITE.sy);
  ctx.translate(-SPRITE.x, -SPRITE.y);
  // the centre panel (sprite x 21..43, y 16..48) and its four flourishes
  roundRectPath(ctx, 21, 16, 22, 32, 0.6);
  ctx.fillStyle = JOKER_INK.frame;
  ctx.fill();
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    ctx.save();
    ctx.translate(sx > 0 ? 21 : 43, sy > 0 ? 16 : 48);
    ctx.scale(sx, sy);
    jokerFlourish(ctx, JOKER_INK.flourish, 0.95);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(32, 32.5);
  jokerDollar(ctx, JOKER_INK.glyph, 1);
  ctx.restore();
  ctx.restore();

  // the corner index: HI red / LO black, on a white patch the border passes behind
  const word = hi ? 'HI' : 'LO';
  const size = jokerWordSize(ctx);
  ctx.save();
  ctx.font = font(INDEX.weight, size);
  const ink = inkMetrics(ctx, word, size);
  const capTop = JOKER_WORD.top;
  const capBottom = JOKER_WORD.top + inkMetrics(ctx, 'K', size).ascent;
  ctx.restore();
  const x0 = Math.max(JOKER_WORD.left, INDEX.col - ink.width / 2);
  const pad = JOKER_WORD_PAD;
  ctx.fillStyle = C.face;
  ctx.fillRect(x0 - pad, capTop - pad, ink.width + 2 * pad, capBottom + ink.descent - capTop + 2 * pad);
  indexWord(ctx, word, size, hi ? C.red : C.black, JOKER_WORD);
  ctx.restore();
}

/**
 * The card back (owner, 2026-11-13): a classic single-ink LATTICE, the
 * same after a half turn: a cream card with the faces' grey edge, a white
 * margin, an ink panel with a beaded band and a thin inner rule, a
 * double-line diamond trellis with dots and lozenges at its crossings, and
 * a harlequin lozenge medallion. Two inks, red and blue (tokens
 * card.backRed / card.backBlue), alternate by hand (backFrameForHand).
 *
 * Small sizes hint themselves: the drawing reads the device pixels per
 * design unit from the context's transform (the atlas's cell transform) and
 * doubles the lattice pitch (same tone) until a cell is >= 5.5 device px,
 * drops the sub-pixel ink splits and dots, keeps every structural rule at
 * >= ~1 device px and the medallion's moat wide, and at the smallest sizes
 * draws the medallion as one bold white diamond.
 */
const BACK_MARGIN = 16; // white margin around the ink panel
const BACK_BAND = 15; // the border band inside the panel
const BACK_FIELD = BACK_MARGIN + BACK_BAND + 3.5; // the lattice field's inset
const BACK_BEAD_PITCH = 9;

/** The rounded rect `d` units inside the card, corner radius r. */
const backInset = (ctx, d, r) => roundRectPath(ctx, d, d, CARD_DESIGN.w - 2 * d, CARD_DESIGN.h - 2 * d, r);
const backDot = (ctx, x, y, r) => { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); };
const backLozenge = (ctx, x, y, a, b) => { ctx.moveTo(x, y - b); ctx.lineTo(x + a, y); ctx.lineTo(x, y + b); ctx.lineTo(x - a, y); ctx.closePath(); };
const clamp01 = (v) => Math.max(0, Math.min(1, v));
/** How much of a repeat of `period` units survives at k device px per unit (0 = average it away). */
const backDetail = (period, k) => clamp01((period * k - 3) / 4);

/** The band's bead centres on the rect `d` units in, about `pitch` apart, `cornerGap` clear of the corners. */
function backBandPoints(d, pitch, cornerGap) {
  const { w: W, h: H } = CARD_DESIGN;
  const pts = [];
  const side = (x0, y0, x1, y1) => {
    const full = Math.hypot(x1 - x0, y1 - y0);
    const len = full - 2 * cornerGap;
    const n = Math.max(1, Math.round(len / pitch));
    for (let i = 0; i <= n; i++) {
      const t = (cornerGap + (i * len) / n) / full;
      pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
  };
  side(d, d, W - d, d); side(d, H - d, W - d, H - d);
  side(d, d, d, H - d); side(W - d, d, W - d, H - d);
  return pts;
}

/** The card, its margin, the ink panel, its beaded band and inner rule. */
function backPanel(ctx, ink, k) {
  const { w: W, h: H, radius: R } = CARD_DESIGN;
  const paper = C.backPaper;
  const minW = (u) => Math.max(u, 0.9 / k); // a structural rule never thinner than ~1 device px
  cardBase(ctx, paper, C.border, 3);
  const M = BACK_MARGIN;
  backInset(ctx, M, R - M + 1);
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.strokeStyle = paper;
  ctx.fillStyle = paper;
  const a = backDetail(BACK_BEAD_PITCH, k);
  ctx.globalAlpha = Math.max(a, 0.35);
  ctx.lineWidth = 1.4;
  backInset(ctx, M + 3, R - M - 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = minW(1.6);
  backInset(ctx, M + BACK_BAND, 4);
  ctx.stroke();
  const c = M + 3 + (BACK_BAND - 3) / 2;
  ctx.globalAlpha = 0.45 + 0.55 * a;
  ctx.beginPath();
  for (const [x, y] of backBandPoints(c, BACK_BEAD_PITCH, 6)) backDot(ctx, x, y, 1.9);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (const [x, y] of [[c, c], [W - c, c], [c, H - c], [W - c, H - c]]) backLozenge(ctx, x, y, 4, 4);
  ctx.fill();
}

/** Smallest power-of-two multiple of `pitch` (up to `cap`) whose repeat is at least `minPx` device px. */
function backHint(pitch, k, minPx, cap) {
  let f = 1;
  while (pitch * f * k < minPx && f < cap) f *= 2;
  return f;
}

/** The trellis (clipped to the field) and the medallion. */
function backLattice(ctx, ink, k) {
  const { w: W, h: H } = CARD_DESIGN;
  const F = BACK_FIELD;
  const paper = C.backPaper;
  const cx = W / 2;
  const cy = H / 2;
  // cells sized so the field's edges run through rows of crossings: 10
  // half-cells across each half of the field, 12 down each half
  const DX = (W - 2 * F) / 10;
  const DY = (H - 2 * F) / 12;
  const f = backHint(DX, k, 5.5, 4);
  const dx = DX * f;
  const dy = DY * f;
  const ext = Math.ceil(16 / f);
  const fine = 1.2 * f * k >= 0.5; // the double line's ink split and the dots still resolve
  const minW = (u) => Math.max(u, 0.9 / k);
  ctx.save();
  backInset(ctx, F, 3);
  ctx.clip();
  const lines = () => {
    ctx.beginPath();
    for (let n = -ext; n < ext; n++) {
      const c = n + 0.5;
      ctx.moveTo(cx + dx * (c + ext), cy - dy * ext); ctx.lineTo(cx + dx * (c - ext), cy + dy * ext);
      ctx.moveTo(cx + dx * (c - ext), cy - dy * ext); ctx.lineTo(cx + dx * (c + ext), cy + dy * ext);
    }
  };
  ctx.strokeStyle = paper;
  if (fine) {
    lines(); ctx.lineWidth = 3.8 * f; ctx.stroke();
    lines(); ctx.lineWidth = 1.2 * f; ctx.strokeStyle = ink; ctx.stroke();
    ctx.beginPath();
    for (let i = -ext; i <= ext; i++) {
      for (let j = -2 * ext; j <= 2 * ext; j++) {
        const odd = Math.abs(j % 2) === 1;
        const y = cy + (dy * j) / 2;
        const xd = cx + dx * (i + (odd ? 0.5 : 0));
        const xn = cx + dx * (i + (odd ? 0 : 0.5));
        if (Math.abs(y - cy) > H / 2 - F - 4) continue; // none cut in half by the field's edge
        if (Math.abs(xd - cx) < W / 2 - F - 4) backDot(ctx, xd, y, 1.5 * f);
        if (Math.abs(xn - cx) < W / 2 - F - 4) backLozenge(ctx, xn, y, 2.6 * f, 3.4 * f);
      }
    }
    ctx.fillStyle = paper;
    ctx.fill();
  } else {
    // one line carrying the double line's white (same tone), no dots
    lines(); ctx.lineWidth = 2.4 * f; ctx.stroke();
  }
  ctx.restore();
  // the medallion: a lozenge 3 cells across in a dark moat, a white rule,
  // an inner rule, four white lozenges (one bold diamond when too small)
  const mx = 1.5 * DX;
  const my = 1.5 * DY;
  const moat = Math.max(3, 1.4 / k);
  ctx.beginPath();
  backLozenge(ctx, cx, cy, mx + moat, my + (moat * DY) / DX);
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.strokeStyle = paper;
  ctx.fillStyle = paper;
  ctx.beginPath();
  backLozenge(ctx, cx, cy, mx, my);
  ctx.lineWidth = minW(2.2);
  ctx.stroke();
  if (1.1 * k >= 0.4) {
    ctx.beginPath();
    backLozenge(ctx, cx, cy, mx - 4.8, my - (4.8 * DY) / DX);
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }
  ctx.beginPath();
  if (0.32 * DX * k >= 1.6) {
    for (const [ox, oy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) backLozenge(ctx, cx + (ox * DX) / 2, cy + (oy * DY) / 2, 0.32 * DX, 0.32 * DY);
  } else {
    backLozenge(ctx, cx, cy, 0.62 * DX, 0.62 * DY);
  }
  ctx.fill();
}

/** Device px per design unit under the context's current transform (1 when it cannot say). */
function devicePerUnit(ctx) {
  const t = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const k = t ? Math.hypot(t.a, t.b) : NaN;
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/** Draw the lattice back in one ink (design units). */
export function drawBack(ctx, ink = C.backRed) {
  const k = devicePerUnit(ctx);
  ctx.save();
  backPanel(ctx, ink, k);
  backLattice(ctx, ink, k);
  ctx.restore();
}

const BACK_INK = { [BACK_FRAMES.red]: C.backRed, [BACK_FRAMES.blue]: C.backBlue };

/** A frame name that is one of the backs. */
export const isBackFrame = (name) => typeof name === 'string' && Object.prototype.hasOwnProperty.call(BACK_INK, name);

/**
 * The back for a hand (owner, 2026-11-13: alternate red and blue between
 * hands): hand 1 red, hand 2 blue, hand 3 red, ... (GameState.handNo, 1-13;
 * a zero-bid redeal keeps its hand, so its colour). No hand yet (0: the
 * draw for deal) or an unknown number is red.
 */
export function backFrameForHand(handNo) {
  const n = Number(handNo);
  return Number.isInteger(n) && n >= 1 && n % 2 === 0 ? BACK_FRAMES.blue : BACK_FRAMES.red;
}

/** Draw any face: a card object, or a back frame (BACK_FRAMES). */
export function drawCard(ctx, card) {
  if (isBackFrame(card)) return drawBack(ctx, BACK_INK[card]);
  if (card.suit === 'joker') return drawJokerFace(ctx, card);
  return drawStandardFace(ctx, card);
}

/**
 * The raised card's soft shadow, in a cell of w x h PIXELS (no design
 * transform: canvas shadows are in device space). The blurred card shape
 * is inset by `margin`; CardManager draws the sprite scaled up by
 * w / (w - 2 margin) so the shape matches the card it lifts.
 */
export function drawShadow(ctx, w, h, margin) {
  const r = (CARD_DESIGN.radius / CARD_DESIGN.w) * (w - 2 * margin);
  const far = w * 4;
  ctx.save();
  // only the shadow lands in the cell: the shape itself is drawn `far`
  // to the left, outside the clip (and never over a neighbouring cell)
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.shadowColor = C.shadow;
  ctx.shadowBlur = margin * 0.9;
  ctx.shadowOffsetX = far;
  ctx.shadowOffsetY = 0;
  roundRectPath(ctx, margin - far, margin, w - 2 * margin, h - 2 * margin, r);
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.restore();
}
