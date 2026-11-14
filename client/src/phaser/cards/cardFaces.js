/**
 * Card faces, drawn procedurally with Canvas2D (roadmap item 18a): a port of
 * the iOS app's CardTextureGenerator.swift, on the same 300 x 435 design
 * canvas with the same layout and colors (tokens.json color.card):
 *
 *   - a white face, corner radius 24, a grey 3-unit border (stroked on the
 *     edge and clipped to the card, as UIBezierPath.stroke into the bitmap);
 *   - the rank (system font, bold 40) at the top left, the suit centred
 *     under it, the pair rotated 180 degrees at the bottom right;
 *   - a large centre pip (the glyph of a 100-unit font);
 *   - jokers in purple: HI / LO (bold 34), a star and "JOKER" (heavy 36),
 *     with a 4-unit purple border;
 *   - the back: a red or blue lattice (drawBack; web only, iOS keeps its own).
 *
 * Suits (and the joker's star) are VECTOR PATHS, never text: a suit
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
const SUIT_COLOR = { hearts: C.red, diamonds: C.red, spades: C.black, clubs: C.black, joker: C.joker };

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

/** A five-pointed star (the joker's), centred on (cx, cy), outer radius r. */
export function drawStar(ctx, cx, cy, r, color) {
  const inner = r * 0.382;
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? r : inner;
    const x = cx + rad * Math.cos(a);
    const y = cy + rad * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
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

// Index layout (iOS: rank drawn at (20, 16), the suit under it at the
// rank's line height less 2). Canvas draws text from its baseline: the
// system font's ascender is ~0.95 em, so the bold 40 rank's baseline is
// 16 + 38; the 32-unit suit glyph's ink (~0.72 em, 23 units) sits on the
// next line, centred 80 units down.
const INDEX = { x: 20, rankBaseline: 54, suitCenterY: 80, suitSize: 24 };
const PIP = { size: 74 };

function drawIndex(ctx, rankStr, suit, color) {
  ctx.fillStyle = color;
  ctx.font = font(WEIGHT.bold, 40);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(rankStr, INDEX.x, INDEX.rankBaseline);
  const rankW = ctx.measureText(rankStr).width || 24;
  drawSuit(ctx, suit, INDEX.x + rankW / 2, INDEX.suitCenterY, INDEX.suitSize, color);
}

/** Draw a standard face (design units). */
export function drawStandardFace(ctx, card) {
  const { w, h } = CARD_DESIGN;
  cardBase(ctx, C.face, C.border, 3);
  const color = SUIT_COLOR[card.suit];
  const rankStr = rankLabel(card.rank);
  drawIndex(ctx, rankStr, card.suit, color);
  ctx.save();
  ctx.translate(w, h);
  ctx.rotate(Math.PI);
  drawIndex(ctx, rankStr, card.suit, color);
  ctx.restore();
  drawSuit(ctx, card.suit, w / 2, h / 2, PIP.size, color);
}

/** Draw a joker (design units): HI / LO, a star and JOKER, all purple. */
export function drawJokerFace(ctx, card) {
  const { w, h } = CARD_DESIGN;
  cardBase(ctx, C.face, C.joker, 4);
  const label = String(card.rank).toUpperCase() === 'HI' ? 'HI' : 'LO';
  const corner = () => {
    ctx.fillStyle = C.joker;
    ctx.font = font(WEIGHT.bold, 34);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, 20, 16 + 32);
  };
  corner();
  ctx.save();
  ctx.translate(w, h);
  ctx.rotate(Math.PI);
  corner();
  ctx.restore();
  drawStar(ctx, w / 2, h / 2 - 40, 27, C.joker);
  ctx.fillStyle = C.joker;
  ctx.font = font(WEIGHT.heavy, 36);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('JOKER', w / 2, h / 2 + 40 + 13);
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
