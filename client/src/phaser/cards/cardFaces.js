/**
 * Card faces, drawn procedurally with Canvas2D (roadmap item 18a): a port of
 * the iOS app's CardTextureGenerator.swift, on the same 300 x 435 design
 * canvas with the same layout and colors (tokens.json color.card):
 *
 *   - a white face, corner radius 24, a grey 3-unit border (stroked on the
 *     edge and clipped to the card, as UIBezierPath.stroke into the bitmap);
 *   - a JUMBO corner index (web only, see INDEX: bold 100 rank, 54-unit
 *     suit under it, in a column centred 50 units in; iOS draws bold 40),
 *     the pair rotated 180 degrees at the bottom right;
 *   - a centre pip 84 units tall (iOS: the glyph of a 100-unit font);
 *   - jokers in purple: HI / LO (bold 34), a star and "JOKER" (heavy 36),
 *     with a 4-unit purple border;
 *   - the dark-green back with its inner rounded rectangle and the four suits.
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

/** The atlas frame of the card back, and of the raised card's soft shadow. */
export const BACK_FRAME = 'back';

/** White margin around the back's green panel (design units; ~3 px at DPR 1). */
export const BACK_EDGE = 14;
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

/**
 * The JUMBO corner index (web only; 2026-11 readability study): in a fanned
 * hand only a strip of each card's left edge shows (25.5 px of a 59 px card
 * at 1280 x 800), and iOS's 40-unit rank was ~5.5 px tall there. The index is
 * now a column centred at `col`: the rank's INK starts `top` units down, in
 * bold `rank` units (cap ~0.70 em, ~70 units), condensed horizontally to at
 * most `maxW` units of ink (only "10" needs it); the `suit`-unit suit sits
 * `gap` units under the rank's ink. The column spans col +- maxW / 2 (13-87),
 * inside the tightest hand strip the layout makes (computeTableLayout's
 * handPositions; cardFaces.test.js sweeps it). The bottom-right index is the
 * same drawing rotated 180 degrees about the card's centre. The jokers keep
 * their own corner (drawJokerFace).
 */
export const INDEX = Object.freeze({ col: 50, top: 18, rank: 100, weight: WEIGHT.bold, maxW: 74, gap: 8, suit: 54 });
/** The centre pip's size (design units). */
export const PIP = Object.freeze({ size: 84 });
/** Cap height / em of the UI font where the canvas gives no ink metrics. */
const CAP_EM = 0.7;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The ink box of `str` in the current font, relative to the text origin
 * (left aligned, alphabetic baseline): the browser's actualBoundingBox
 * metrics, else (a context without them) the advance width and the cap
 * height.
 */
export function inkMetrics(ctx, str, size) {
  const m = ctx.measureText(str);
  const hasInk = finite(m.actualBoundingBoxLeft) && finite(m.actualBoundingBoxRight)
    && finite(m.actualBoundingBoxAscent) && m.actualBoundingBoxRight + m.actualBoundingBoxLeft > 0;
  if (!hasInk) return { left: 0, width: m.width || 0.6 * size * str.length, ascent: CAP_EM * size, descent: 0 };
  return {
    left: -m.actualBoundingBoxLeft,
    width: m.actualBoundingBoxRight + m.actualBoundingBoxLeft,
    ascent: m.actualBoundingBoxAscent,
    descent: finite(m.actualBoundingBoxDescent) ? Math.max(0, m.actualBoundingBoxDescent) : 0,
  };
}

function drawIndex(ctx, rankStr, suit, color) {
  const I = INDEX;
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = font(I.weight, I.rank);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const ink = inkMetrics(ctx, rankStr, I.rank);
  const k = ink.width > I.maxW ? I.maxW / ink.width : 1;
  const baseline = I.top + ink.ascent;
  // the ink centred on the column, condensed (x only) to maxW
  ctx.translate(I.col, baseline);
  ctx.scale(k, 1);
  ctx.fillText(rankStr, -ink.left - ink.width / 2, 0);
  ctx.restore();
  drawSuit(ctx, suit, I.col, baseline + ink.descent + I.gap + I.suit / 2, I.suit, color);
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
 * Draw the back (design units): a white card edge like the faces (so an
 * overlapped fan of backs reads as separate cards on the green felt), then
 * iOS's dark-green panel with its lighter border, inner frame and the app
 * icon's four suits (iOS CardTextureGenerator.cardBackTexture).
 */
export function drawBack(ctx) {
  const { w, h, radius } = CARD_DESIGN;
  cardBase(ctx, C.face, C.border, 3);
  const edge = BACK_EDGE;
  roundRectPath(ctx, edge, edge, w - 2 * edge, h - 2 * edge, radius - 8);
  ctx.fillStyle = C.back;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = C.backBorder;
  ctx.stroke();
  const inset = edge + 18;
  roundRectPath(ctx, inset, inset, w - 2 * inset, h - 2 * inset, radius - 14);
  ctx.lineWidth = 2;
  ctx.strokeStyle = C.backInner;
  ctx.stroke();
  // the app icon's four suits, 2 x 2 around the centre (iOS PR 239's back):
  // spade and club in text.primary, heart and diamond in danger.text, as the
  // dark surfaces draw suits; each the glyph of iOS's 58-unit font (its
  // shape 74% of the font, as PIP), 34 units from the centre each way
  for (const [suit, dx, dy] of BACK_SUITS) {
    const color = suit === 'hearts' || suit === 'diamonds' ? COLOR.danger.text : COLOR.text.primary;
    drawSuit(ctx, suit, w / 2 + dx * BACK_SUIT.step, h / 2 + dy * BACK_SUIT.step, BACK_SUIT.size, color);
  }
}

/** The back's suits: which, and where (times BACK_SUIT.step from the centre). */
export const BACK_SUITS = Object.freeze([['spades', -1, -1], ['hearts', 1, -1], ['diamonds', -1, 1], ['clubs', 1, 1]]);
export const BACK_SUIT = Object.freeze({ size: 43, step: 34 });

/** Draw any face: a card object, or BACK_FRAME. */
export function drawCard(ctx, card) {
  if (card === BACK_FRAME) return drawBack(ctx);
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
