/**
 * The web table's layout (roadmap item 17): one pure function of the canvas
 * size that places every anchor on the table, for Phaser and the DOM HUD
 * alike. iOS does the same in iOSClient/.../SpriteKit/TableLayout.swift
 * (item 25); this one mirrors its semantics where they fit:
 *
 *   - one uniform size scale s for every sprite and DOM size (cards,
 *     avatars, plates, trick slots, the bid sheet), never above 1 (today's
 *     1920 x 1080 table);
 *   - s is SOLVED, not guessed: the search tries s = 1, 0.99 ... and takes
 *     the first layout with no rect intersections and nothing off the
 *     canvas, checked by the same findIntersections / findOutside the tests
 *     use (a roomy hand box first, then a compact one, at each s);
 *   - positions are today's fractions of the canvas where they fit (the
 *     1920x1080 table looks as it did) and are pushed apart where they do
 *     not;
 *   - the felt keeps today's proportions of the canvas where the side seats
 *     can move out for it (FELT_WISHES, tried at the solved s: the scale
 *     comes first), and the bid sheet sits inside it;
 *   - each seat's chat/bid bubble gets a direction and width (BUBBLE_DIRS,
 *     BUBBLE_WIDTHS) so that at its largest it never covers the trump, the
 *     hand, the trick or the histories (BUBBLE_KEEPS, in the same check);
 *     so does the spectator badge's bubble (badgeBubbleSpots, chosen after
 *     the seats'; badgeBubbleKeeps adds my box, the voice buttons, the
 *     status pill and the bid sheet);
 *   - a resize runs the whole layout again (GameScene.relayout).
 *
 * Coordinates are canvas pixels (#game-container, origin top-left, y down).
 * The game log lives to the right of the canvas in the --log-w grid column
 * (styles.css); logWidthFor() mirrors its breakpoints and the layout
 * returns the log's rect in canvas coordinates (x >= w).
 *
 * Seats: self, partner, opp1 (left, next in turn), opp2 (right). A pure
 * spectator has no hand: its 'self' seat is the bottom seat, drawn like the
 * partner's (OpponentManager's 'bottom' slot).
 *
 * `solo` (Get Your Bid, owner 2026-11-24: three players, no teams) is the
 * same table with three seats spaced evenly round the felt: no partner, the
 * two others (opp1 next in turn, opp2 after it) raised to the upper left and
 * upper right, and the trick a triangle that points at them (SOLO below).
 * Every layout without it is exactly as before.
 */

import { CARD_CONFIG } from '../config.js';
import { cardTextureSize } from '../cards/CardAtlas.js';
import { TYPE, SPACE } from '../../ui/tokens.js';

/**
 * A card at design scale 1 (CSS px; item 18a: the hi-res faces have the iOS
 * card's 300 x 435 proportions and no padding, so the sprite's bounds ARE
 * the visible card and its hit area).
 */
export const CARD_UNIT = CARD_CONFIG.UNIT;

/** Design scales at s = 1 (today's: hand and trick 1.5, backs and deck 1.2, history 1.0). */
export const BASE_SCALE = { hand: 1.5, trick: 1.5, back: 1.2, history: 1.0, trump: 1.5, deck: 1.2, drawn: 1.5 };

/**
 * Game log column width (the grid's --log-w) by viewport width: the first
 * [maxWidth, width] whose maxWidth >= vw, else 320. styles.css holds the same
 * table (layout.test.js reads it back).
 */
export const LOG_BREAKPOINTS = [[600, 130], [800, 170], [1000, 200], [1200, 240], [1400, 280]];
export const LOG_WIDTH_MAX = 320;
/** The log box sits inside its column with this margin. */
export const LOG_MARGIN = 10;

export function logWidthFor(vw) {
  for (const [max, width] of LOG_BREAKPOINTS) if (vw <= max) return width;
  return LOG_WIDTH_MAX;
}

/**
 * The bid sheet's trick chips (BidManager): a row of 18 px chips 3 px
 * apart, one per trick (up to 16 when the bids overbid the hand).
 */
export const BID_CHIP = { w: 18, gap: 3 };
/** The sheet's padding (12 px) and border (2 px), both sides (BidManager sets them on the sheet). */
export const BID_SHEET_PAD = 12;
export const BID_SHEET_BORDER = 2;
export const BID_SHEET_CHROME = 2 * (BID_SHEET_PAD + BID_SHEET_BORDER);
/**
 * The bid sheet's size at scale 1 (BidManager sets this width; 13 cards is
 * the tallest). 13 chips at their natural width set the width (the widest
 * row; an overbid's extra chips shrink to fit it).
 */
export const BID_SHEET = { w: 13 * BID_CHIP.w + 12 * BID_CHIP.gap + BID_SHEET_CHROME, h: 330 };
/** Status pill text (the longest, lazy mode). */
export const STATUS_TEXT_W = 380;
/**
 * The spectator badge (eye + count; ui/components/SpectatorBadge.js): the
 * voice buttons' height, this many heights wide (room for a 2-digit count;
 * a longer one ellipsizes, the aria-label has it).
 */
export const SPECTATOR_BADGE = { wPerH: 2 };

/**
 * The play zone (the green felt, LayoutManager's #playZoneDom). Before item
 * 17 it was 600 x 400 of a 1920 x 953 design, scaled by the canvas
 * (scene.scale: the window less the log column; 0.3125 of its width, 0.42
 * of its height, so 500 wide at 1920 x 1080 and 350 at 1440 x 790); it
 * keeps those proportions where the seats leave room. Its 4 px border is inside the rect
 * (box-sizing), and the bid sheet sits inside it, `inset` from the edge.
 */
export const FELT = { wFrac: 0.3125, hFrac: 0.42, border: 4 };
/**
 * The avatar badge (owner 2026-11-23: the /help lightbulb, the tutorial's
 * graduation cap; ui/seatPlates.js .hud-seat-badge): a round chip on the
 * ring's top left, `size` x s but, from s `floorFrom` (every desktop table;
 * the solver's s 0.15 fallback, a 14 px avatar, keeps 24 x s), at least
 * `min` px where the seat has room for it (`room` x s: a bigger chip would
 * reach the bubble or the plate at the smaller tables; so 19.2 px at s 0.71,
 * 20 px from s 0.74, where 24 x s is 17.8, and 24 x s from s 0.83). Its
 * bottom right corner is fixed, `right` x s right of the
 * avatar's left edge and `bottom` x s below its top, and the floor grows it
 * up and left from there, so its bottom edge stays `border` px above the
 * frog beside the avatar (the frog's top is 20 x s above the avatar's
 * centre, the badge's 20 x s + border) and it stays inside the seat (clear
 * of the bubble above, the cards and the status pill). `eye` is the spectator eye's spot
 * (`out` x s left of the avatar, `up` x s above it: the ring corner's
 * origin, table.css .hud-ring-corner); beside a lit eye the badge sits one
 * chip right, level with the avatar's top.
 */
export const SEAT_BADGE = Object.freeze({ size: 24, min: 20, room: 27, floorFrom: 0.7, right: 18, bottom: 20, eye: Object.freeze({ out: 6, up: 2 }) });

/**
 * The three-seat table (`solo`): the side seats sit `rise` x s above the
 * trick's line where the top band (the trick history, the trump) leaves
 * room, and the trick's slots are a triangle, mine below the centre
 * (`selfDy`), the others `sideDx` out and `sideDy` above it.
 */
export const SOLO = Object.freeze({ rise: 160, sideDx: 78, sideDy: 50, selfDy: 80 });

/** The felt's width wishes (times the 0.3125 x canvas target), tried in order; 0 is the fallback felt. */
const FELT_WISHES = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0];

/**
 * Chat and bid bubbles (ChatBubble, .hud-bubble-slot): at most `lines`
 * lines of text (a longer chat message ends in an ellipsis; the log has it
 * all), a 10 px tail toward the avatar. The layout gives each seat a
 * direction ('down': the bubble above the avatar, 'left': right of it,
 * 'right': left of it; the name is the tail's side) and a maximum width,
 * so the bubble at its largest never covers the trump, the hand, a trick
 * slot, a trick history or another seat's bubble.
 */
export const BUBBLE = { lines: 3, tail: 10, lineHeight: 1.25 };
/** Each seat's bubble directions, best first. */
const BUBBLE_DIRS = {
  partner: ['left', 'right', 'down'],
  opp1: ['down', 'left', 'right'],
  opp2: ['down', 'right', 'left'],
  self: ['down', 'right', 'left'],
  // a pure spectator's bottom seat has its backs above the avatar (drawn
  // like the partner's): its bubble goes beside it, as the partner's does
  bottom: ['left', 'right', 'down'],
};

/** A seat's bubble directions ('self' is the bottom seat for a pure spectator). */
const bubbleDirsFor = (key, isSpectator) => BUBBLE_DIRS[isSpectator && key === 'self' ? 'bottom' : key];
/**
 * Bubble width steps (times the full width), each tried in every direction
 * before the next: a phone's bubbles narrow (to 79 px on a 390 x 844
 * phone's 260 px canvas) rather than cover the trick or shrink the table.
 */
const BUBBLE_WIDTHS = [1, 0.85, 0.7, 0.6];
/**
 * The spectator badge's chat bubble (a spectator's message, "Zach: hello";
 * ChatBubble.showSpectatorChatBubble, .hud-spectator-bubble): the seats'
 * box, line cap and width steps. Its spots, best first: above the badge
 * ('down' tail) with its right edge on the badge's (growing left), slid
 * right to the canvas margin, with its left edge on the badge's, or slid as
 * far as the tail allows either way; then left of the badge ('right' tail)
 * or right of it ('left'), bottom-aligned with it. `align` is the edge the
 * bubble hangs from ('end': its right edge, 'start': its left edge), so a
 * short message still reaches the tail. The tail points at the badge's
 * middle and keeps BADGE_TAIL_ROOM from the bubble's ends (radius + tail).
 */
const BADGE_TAIL_HALF = 8;
const BADGE_TAIL_ROOM = 12 + BADGE_TAIL_HALF;

const S_MAX = 1;
const S_MIN = 0.15;
const S_STEP = 0.01;
const MARGIN = 10;
const HAND_SPACING = CARD_CONFIG.HAND_SPACING;
const MIN_HAND_SPACING = 16;
const BACK_SPACING = 9;
const MAX_CARDS = 13;
const HISTORY_COLS = 7;
/**
 * My team's trick history: today's block ended 53 design px above the
 * canvas bottom (its second row's centre 95 px up), as the opponents' sits
 * below the status band at the top.
 */
const HISTORY_INSET = 53;
/** The trick history's own scale steps (times s), tried before s shrinks. */
const HISTORY_SCALES = [1, 0.85, 0.7];

/** The hand box shows 13 cards at 2/3 of the natural spacing (or the layout has no hand). */
function handRoomy(L) {
  if (!L.hand) return true;
  const s = L.s;
  return L.hand.rect.w + 0.01 >= L.hand.card.w + (MAX_CARDS - 1) * (HAND_SPACING * 2 / 3) * s + 2 * L.hand.padX;
}

const r1 = (v) => Math.round(v * 100) / 100;

function rect(x, y, w, h) {
  return { x, y, w, h };
}

function around(cx, cy, w, h) {
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** True when two rects share area (touching edges do not count). */
export function intersects(a, b) {
  if (!a || !b) return false;
  const eps = 0.01;
  return a.x + a.w > b.x + eps && b.x + b.w > a.x + eps && a.y + a.h > b.y + eps && b.y + b.h > a.y + eps;
}

export function contains(outer, inner, eps = 0.01) {
  return inner.x >= outer.x - eps && inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.h <= outer.y + outer.h + eps;
}

/**
 * A card on screen at a design scale, drawn from atlas frames of `tex`
 * (px): `scale` is the SPRITE scale (on-screen height / frame height; the one
 * conversion between the atlas bitmap and CSS px), w x h the bounds a
 * sprite at that scale renders and is clicked by, `box` the square the
 * trump's frame is built on (the old 64 px atlas frame around a 62 px
 * card: the trump box keeps its item 17 size).
 */
const BOX_PER_H = 64 / 62;
function cardSize(design, tex) {
  const scale = (CARD_UNIT.h * design) / tex.h;
  const w = scale * tex.w;
  const h = scale * tex.h;
  return { design, scale, w, h, box: CARD_UNIT.h * design * BOX_PER_H };
}

/**
 * The hand card (and every card its size): its frame drawn at exactly one
 * texel per device pixel (scale 1 / dpr), so it is the frame's size in CSS
 * px (the design height to whole, even device pixels: within one device
 * pixel of it). Only when the frame hit its cap (CARD_CONFIG.TEX_MAX_W) is
 * it the design size, upscaled.
 */
function handCardSize(design, tex, dpr) {
  if (tex.h < CARD_UNIT.h * design * dpr - 1 - 1e-6) return cardSize(design, tex);
  const scale = 1 / dpr;
  return { design, scale, w: tex.w * scale, h: tex.h * scale, box: CARD_UNIT.h * design * BOX_PER_H };
}

/**
 * A drawn card in its slot (the draw's own frame, `tex`: the card's height
 * in even device pixels, capped like the atlas's): 1:1 like the hand card.
 */
function slotCardSize(design, dpr) {
  const tex = cardTextureSize(CARD_UNIT.h * design, dpr);
  return { ...handCardSize(design, tex, dpr), tex };
}

/**
 * The draw for deal's words (DrawManager puts them in the HUD; the layout
 * sizes their boxes from them). The same words as the iOS DrawPhaseView,
 * with "Click" for "Tap".
 */
export const DRAW_TEXT = Object.freeze({
  title: 'Draw for Deal',
  rules: 'The two highest cards are partners; the highest deals.',
  prompt: 'Click a card to draw',
});
/** The same for a three-seat table (Get Your Bid: no partners). */
export const DRAW_TEXT_SOLO = Object.freeze({ ...DRAW_TEXT, rules: 'Highest card deals. Everyone plays for themselves.' });

/**
 * Text widths are estimated in em per character (the UI font's bold title,
 * its regular and semibold lines; a little over the system font's own, so
 * a box is never narrower than its text).
 */
const EM = { title: 0.62, rules: 0.52, prompt: 0.56 };

/**
 * The draw for deal (item 17's draw-phase part; iOS DrawPhaseView's
 * structure): one centred column of
 *
 *   title ("Draw for Deal", type xxl) and the rule under it (md),
 *   four slots in draw order, each a seat-style avatar, the name and, a
 *   Theme s3 gap below the name, the drawn card (a dashed placeholder until
 *   it comes), all four cards on one row,
 *   the deck (54 backs, the web's pick-a-card row) and the prompt under it.
 *
 * Type and spacing are the tokens at s (with floors that keep a phone-size
 * canvas legible); only the gaps around the slot row give way when the
 * canvas is short (to the table's gap G, never below), so the draw never
 * decides s: the table does. A drawn card is at least the hand card; where
 * the canvas has height to spare the slot row grows into it (the cards by
 * up to DRAW_GROW.max, their avatars and names by half as much), so the
 * results fill the screen as on iOS instead of a small row in a lot of
 * felt. The slot card is drawn from its own frame (`tex`, DrawManager's
 * cards/drawSlotFaces.js texture) at 1 / DPR, so it stays 1:1 at any size,
 * its centre on a device pixel.
 */
export const DRAW_GROW = Object.freeze({ max: 2, share: 0.6 });

function placeDraw({ cw, ch, s, M, G, q, dpr, deckCard, drawn: handCard, n = 4, text = DRAW_TEXT }) {
  const DRAW_TEXT = text; // (the words this draw shows: the three-seat table's rule differs)
  const cx = cw / 2;
  const avail = Math.max(1, cw - 2 * M);
  const baseFont = {
    title: Math.max(18, TYPE.xxl * s),
    rules: Math.max(12, TYPE.md * s),
    name: Math.max(12, TYPE.md * s),
    prompt: Math.max(13, TYPE.lg * s),
  };
  const baseAvatar = Math.max(20, SPACE.s10 * s);
  // the slot row's growth g: a share of the height left over at the ideal
  // gaps (the base column, below), at most DRAW_GROW.max and at most what
  // four slots (card plus the gap G) fit across
  const baseRuleLines = Math.min(3, Math.max(1, Math.ceil((EM.rules * baseFont.rules * DRAW_TEXT.rules.length) / avail - 1e-9)));
  const baseFixed = baseFont.title * 1.2 + Math.max(4, SPACE.s2 * s) + baseRuleLines * baseFont.rules * 1.35 +
    baseAvatar + Math.max(4, SPACE.s2 * s) + baseFont.name * 1.3 + Math.max(4, SPACE.s3 * s) +
    handCard.h + deckCard.h + Math.max(4, SPACE.s4 * s) + baseFont.prompt * 1.3;
  const room = ch - 2 * M - baseFixed - Math.max(G, SPACE.s8 * s) - Math.max(G, SPACE.s10 * s) - 2;
  const gMax = Math.max(1, Math.min(DRAW_GROW.max, (avail / n - G) / handCard.w));
  const g = clamp(1 + (DRAW_GROW.share * Math.max(0, room)) / (handCard.h + baseAvatar / 2), 1, gMax);
  const half = 1 + (g - 1) / 2;
  const drawn = slotCardSize(handCard.design * g, dpr);
  const font = { ...baseFont, name: baseFont.name * half };
  const avatar = baseAvatar * half;
  // the deck: 54 backs, each 17 * s past the one before (less where narrow)
  const ov = Math.max(0.5, Math.min(17 * s, (avail - deckCard.w) / 53));
  const deckW = 53 * ov + deckCard.w;
  // the slots: one pitch apart, the card plus room for a name (the names
  // keep a gap between them)
  const pitch = Math.max(drawn.w + G, Math.min(drawn.w + 72 * s, avail / n));
  const nameW = Math.max(drawn.w, pitch - Math.max(G, SPACE.s3 * s));
  // the boxes (the rule wraps where it must, at most 3 lines)
  const ruleEst = EM.rules * font.rules * DRAW_TEXT.rules.length;
  const ruleLines = Math.min(3, Math.max(1, Math.ceil(ruleEst / avail - 1e-9)));
  const box = {
    title: { w: Math.min(avail, EM.title * font.title * DRAW_TEXT.title.length), h: font.title * 1.2 },
    rules: { w: Math.min(avail, ruleEst), h: ruleLines * font.rules * 1.35 },
    name: { w: nameW, h: font.name * 1.3 },
    prompt: { w: Math.min(avail, EM.prompt * font.prompt * DRAW_TEXT.prompt.length), h: font.prompt * 1.3 },
  };
  const gap = {
    titleRules: Math.max(4, SPACE.s2 * s),
    avatarName: Math.max(4, SPACE.s2 * s),
    nameCard: Math.max(4, SPACE.s3 * s),
    deckPrompt: Math.max(4, SPACE.s4 * s),
  };
  const fixed = box.title.h + gap.titleRules + box.rules.h + avatar + gap.avatarName + box.name.h +
    gap.nameCard + drawn.h + deckCard.h + gap.deckPrompt + box.prompt.h;
  // the two gaps around the slot row: their tokens (s8, s10) where the
  // canvas is tall enough, down to G each where it is not
  const ideal = { headerRow: Math.max(G, SPACE.s8 * s), rowDeck: Math.max(G, SPACE.s10 * s) };
  // (2 px: the two card rows snap down to device pixels)
  const spare = ch - 2 * M - fixed - 2 * G - 2;
  const give = ideal.headerRow + ideal.rowDeck - 2 * G;
  const k = give > 0 ? clamp(spare / give, 0, 1) : 1;
  const headerRow = G + k * (ideal.headerRow - G);
  const rowDeck = G + k * (ideal.rowDeck - G);
  const total = fixed + headerRow + rowDeck + 2;
  let y = M + Math.max(0, (ch - 2 * M - total) / 2);
  const take = (h) => { const c = y + h / 2; y += h; return c; };
  // a card row: its centre on a device pixel at or below the cursor (the
  // gaps above it never shrink), the rows under it moved down as much
  const takeCard = (h) => {
    const c = Math.ceil((y + h / 2) * dpr - 1e-6) / dpr;
    y = c + h / 2;
    return c;
  };
  const titleY = take(box.title.h);
  y += gap.titleRules;
  const rulesY = take(box.rules.h);
  y += headerRow;
  const avatarY = take(avatar);
  y += gap.avatarName;
  const nameY = take(box.name.h);
  y += gap.nameCard;
  const slotY = takeCard(drawn.h);
  y += rowDeck;
  const deckY = takeCard(deckCard.h);
  y += gap.deckPrompt;
  const promptY = take(box.prompt.h);

  const slots = Array.from({ length: n }, (_, i) => ({ x: q(cx + (i - (n - 1) / 2) * pitch), y: slotY }));
  const deckX0 = cx - deckW / 2 + deckCard.w / 2;
  // (the words and avatars are DOM: no device-pixel snap in y)
  const line = (cy, b, f, extra = {}) => ({ x: q(cx), y: cy, font: f, rect: around(q(cx), cy, b.w, b.h), ...extra });
  return {
    deck: { x0: q(deckX0), y: deckY, overlap: ov, card: deckCard, rect: around(q(cx), deckY, deckW, deckCard.h), enterX: q(Math.min(cw - deckCard.w, cx + 0.26 * cw)) },
    slots,
    slotCard: drawn,
    grow: g,
    slotRects: slots.map((p) => around(p.x, p.y, drawn.w, drawn.h)),
    pitch,
    avatar: { size: avatar, y: avatarY, rects: slots.map((p) => around(p.x, avatarY, avatar, avatar)) },
    name: { dy: nameY - slotY, y: nameY, w: nameW, font: font.name, gap: gap.nameCard, rects: slots.map((p) => around(p.x, nameY, nameW, box.name.h)) },
    title: line(titleY, box.title, font.title),
    rules: line(rulesY, box.rules, font.rules, { lines: ruleLines }),
    prompt: line(promptY, box.prompt, font.prompt),
  };
}

/**
 * Place everything at size scale s. Returns the layout; whether it is clean
 * is for findIntersections / findOutside to say.
 */
function place(cw, ch, s, { isSpectator, watcher = false, compact, logW, dpr, k = 1, felt = 0, histInset = false, tutorial = false, solo = false }) {
  const q = (v) => Math.round(v * dpr) / dpr;
  const M = MARGIN;
  const G = Math.max(4, 8 * s);
  const cx = cw / 2;

  // ---------- sizes ----------
  const border = Math.max(1, Math.round(3 * s));
  const avatarImg = 80 * s;
  const D = avatarImg + 2 * border;
  const plateFont = Math.max(9, 14 * s);
  const plateLH = Math.round(plateFont * 1.2);
  const plateH = plateLH + 6; // 2 px padding + 1 px border, top and bottom
  const plateW = 124 * s;
  const plateGap = 6 * s;
  const blockW = Math.max(D, plateW);
  const frog = 40 * s;
  const frogDx = 60 * s;
  const frogReach = frogDx + frog / 2;

  // the atlas frame: the hand card (the largest on screen) at this s, times
  // the device pixel ratio, so hand cards sample 1:1 (CardAtlas)
  const tex = cardTextureSize(CARD_UNIT.h * BASE_SCALE.hand * s, dpr);
  // a card the hand's size (the trick, the trump, a drawn card) is drawn
  // from the frame 1:1 too; the smaller ones are downscales
  const sized = (key) => (BASE_SCALE[key] === BASE_SCALE.hand
    ? handCardSize(BASE_SCALE[key] * s, tex, dpr)
    : cardSize(BASE_SCALE[key] * s, tex));
  const card = {
    hand: sized('hand'),
    trick: sized('trick'),
    back: sized('back'),
    history: cardSize(BASE_SCALE.history * s * k, tex),
    trump: sized('trump'),
    deck: sized('deck'),
    drawn: sized('drawn'),
  };
  const back = card.back;
  const backSp = BACK_SPACING * s;
  const fanLong = back.w + (MAX_CARDS - 1) * backSp; // a 13-card fan along its axis

  // ---------- top: status pill, partner ----------
  const statusFont = Math.max(10, 14 * s);
  const statusH = Math.round(statusFont * 1.2) + 16 * s + 2;
  const statusW = Math.min(STATUS_TEXT_W * s, cw - 2 * M);
  const status = { rect: rect(q(cx - statusW / 2), q(M), statusW, statusH), font: statusFont };

  const seats = {};
  // A seat hangs off its avatar's centre (snapped): the HUD puts the seat
  // node there and everything else is an offset from it, as in the DOM
  const seatAt = (rawX, rawY, { frogSide }) => {
    const ax = q(rawX);
    const ay = q(rawY);
    const plate = rect(ax - plateW / 2, ay + D / 2 + plateGap, plateW, plateH);
    const avatar = { x: ax, y: ay, size: D, img: avatarImg, border, rect: rect(ax - D / 2, ay - D / 2, D, D) };
    const dealer = { dx: frogSide * frogDx, dy: 0, size: frog };
    dealer.x = ax + dealer.dx;
    dealer.y = ay + dealer.dy;
    dealer.rect = around(dealer.x, dealer.y, frog, frog);
    // the badge: its top left corner from the avatar's centre
    const badgeSize = s >= SEAT_BADGE.floorFrom ? Math.max(SEAT_BADGE.size * s, Math.min(SEAT_BADGE.min, SEAT_BADGE.room * s)) : SEAT_BADGE.size * s;
    const seatBadge = { dx: -D / 2 + SEAT_BADGE.right * s - badgeSize, dy: -D / 2 + SEAT_BADGE.bottom * s - badgeSize, size: badgeSize };
    // the ring corner's origin (the eye's spot), from the avatar's centre
    seatBadge.eye = { dx: -D / 2 - SEAT_BADGE.eye.out * s, dy: -D / 2 - SEAT_BADGE.eye.up * s };
    seatBadge.rect = rect(ax + seatBadge.dx, ay + seatBadge.dy, seatBadge.size, seatBadge.size);
    // (the bubble is chosen once the table is placed: see 'bubbles' below)
    return { avatar, plate, dealer, seatBadge, bubble: null, block: rect(ax - blockW / 2, ay - D / 2, blockW, D + plateGap + plateH) };
  };

  // a bubble's box (at its widest) and where it hangs off its avatar
  const bubbleFont = Math.max(11, 14 * s);
  const bubbleLH = Math.round(bubbleFont * BUBBLE.lineHeight);
  const bubblePadX = Math.max(6, 12 * s);
  const bubblePadY = Math.max(4, 8 * s);
  const bubbleBox = {
    font: bubbleFont,
    lh: bubbleLH,
    padX: bubblePadX,
    padY: bubblePadY,
    lines: BUBBLE.lines,
    tail: BUBBLE.tail,
    w: Math.max(120, 200 * s) + 2 * bubblePadX,
    h: BUBBLE.lines * bubbleLH + 2 * bubblePadY,
  };
  // the anchor is the box's edge nearest the avatar; the tail reaches past it toward the avatar
  // (a side bubble is centred on the avatar, or just below the seat's own
  // backs when they sit above it: the spectator's bottom seat)
  const bubbleAnchor = (seat, dir, clearOwn = false) => {
    const half = seat.avatar.size / 2;
    const c = seat.cards;
    const below = clearOwn && c && c.axis === 'h' && c.y < seat.avatar.y ? Math.max(0, c.rect.y + c.rect.h + bubbleBox.h / 2 - seat.avatar.y) : 0;
    if (dir === 'left') return { dx: half + 12 * s, dy: below };
    if (dir === 'right') return { dx: -(half + 12 * s), dy: below };
    return { dx: 0, dy: -(half + 14 * s) };
  };
  const bubbleRect = (seat, dir, bw, clearOwn = false) => {
    const a = bubbleAnchor(seat, dir, clearOwn);
    const bx = seat.avatar.x + a.dx;
    const by = seat.avatar.y + a.dy;
    const { h: bh, tail } = bubbleBox;
    if (dir === 'left') return rect(bx - tail, by - bh / 2, bw + tail, bh);
    if (dir === 'right') return rect(bx - bw, by - bh / 2, bw + tail, bh);
    return rect(bx - bw / 2, by - bh, bw, bh + tail);
  };

  // (a three-seat table has no partner: the trick may reach the status band)
  let top = M + statusH + G;
  if (!solo) {
    const pAy = M + statusH + G + D / 2;
    seats.partner = seatAt(cx, pAy, { frogSide: -1 });
    const pCardsY = seats.partner.plate.y + plateH + G + back.h / 2;
    seats.partner.cards = { x: q(cx), y: q(pCardsY), axis: 'h', rotation: 0, spacing: backSp, rect: around(q(cx), q(pCardsY), fanLong, back.h) };
    top = pCardsY + back.h / 2 + G;
  }

  // ---------- trick history: opponents top-left (below the status band), my team bottom-left ----------
  // (its own scale s * k, as iOS's trick scale: k = 1, 0.85, 0.7 before s shrinks)
  const hs = s * k;
  const slotW = 54 * hs;
  const slotH = 76 * hs;
  const histPad = 4 * hs;
  const histSpacing = 64 * hs;
  const histRow = 86 * hs;
  const histW = (HISTORY_COLS - 1) * histSpacing + slotW + 2 * histPad;
  const histH = histRow + slotH + 2 * histPad;
  // (mirror: the block fills from its right edge, for a pile on the right of the table)
  const historyBlock = (rawX, rawY, { mirror = false } = {}) => {
    // the block snaps first and its slots hang off the snapped corner
    const bx = q(rawX);
    const by = q(rawY);
    const x0 = mirror ? bx + histW - histPad - slotW / 2 : bx + histPad + slotW / 2;
    const dir = mirror ? -1 : 1;
    const y0 = by + histPad + slotH / 2;
    const slots = [];
    for (let n = 1; n <= MAX_CARDS; n++) {
      const row = n <= HISTORY_COLS ? 0 : 1;
      const col = row === 0 ? n - 1 : n - HISTORY_COLS - 1;
      slots.push({ x: q(x0 + dir * (col * histSpacing + (row === 1 ? histSpacing / 2 : 0))), y: q(y0 + row * histRow) });
    }
    return { rect: rect(bx, by, histW, histH), slots, slotW, slotH, pad: histPad, spacing: histSpacing, rowSpacing: histRow, fanDx: 30 * hs, fanDy: 8 * hs, scale: k };
  };
  // (my team's block keeps today's inset from the bottom, 53 design px as
  // the opponents' from the top, where the table leaves room: histInset,
  // tried as a wish at the solved s; else on the bottom margin)
  const teamBottom = histInset ? Math.max(M, HISTORY_INSET * s) : M;
  const history = {
    opp: historyBlock(M, M + statusH + G),
    team: historyBlock(M, ch - teamBottom - histH),
  };
  // three seats: each opponent's own pile on its side of the table (opp1's
  // top left, as the opponents' always is; opp2's top right, filling from
  // the right edge), and the trump between them, where the partner sat
  if (solo) history.opp2 = historyBlock(cw - M - histW, M + statusH + G, { mirror: true });

  // ---------- bottom: my hand and box, or the spectator's bottom seat ----------
  const handCard = card.hand;
  const lift = 20 * s;
  const handBoxH = compact ? handCard.h + 2 * lift + 4 * s : 230 * s;
  const handPadX = 16 * s;
  const hsiFont = Math.max(8, 12 * s);
  const hsiH = Math.round(hsiFont * 1.2) + 6;
  const hsiW = 96 * s;
  const voiceBtn = Math.max(22, 36 * s);
  const voiceGap = 6 * s;
  // the row: sound effects toggle (ui/components/SoundToggle.js), mic device,
  // mute; for a player at their own seat also the Tutorial button
  // (ui/components/TutorialButton.js, owner 2026-11-21), after the sound one
  const voiceSlots = tutorial && !isSpectator ? 4 : 3;
  const voiceRowW = voiceSlots * voiceBtn + (voiceSlots - 1) * voiceGap;
  let hand = null;
  let bottom;
  let voice;
  let hsi = null;

  if (!isSpectator) {
    // a watcher (the over-the-shoulder view, owner 2026-11-21): the watched
    // seat's box is that player alone (avatar, name, HSI); the watcher's own
    // sound / voice buttons are the corner's, stacked above the spectator
    // badge, so they never read as the watched player's controls
    const ownVoice = !watcher;
    const selfW = Math.max(blockW, hsiW, ownVoice ? voiceRowW : 0);
    // (the same sum, in the same order, as before for a seat: byte-identical layouts)
    const selfH = ownVoice ? D + plateGap + plateH + 4 * s + hsiH + voiceGap + voiceBtn : D + plateGap + plateH + 4 * s + hsiH;
    const handBottom = ch - Math.max(M, 23 * s);
    const handTop = handBottom - handBoxH;
    // widest hand box that clears the team history (left) and my box (right)
    const leftRoom = cx - (M + histW + G);
    const selfLeftReach = Math.max(selfW / 2, frogReach);
    const selfMaxX = cw - M - selfW / 2;
    const rightRoom = (selfMaxX - selfLeftReach - G) - cx;
    const handMin = handCard.w + (MAX_CARDS - 1) * MIN_HAND_SPACING * s + 2 * handPadX;
    const handNatural = handCard.w + (MAX_CARDS - 1) * HAND_SPACING * s + 2 * handPadX;
    const handMax = 2 * Math.min(leftRoom, rightRoom);
    const handW = Math.max(handMin, Math.min(Math.max(0.4 * cw, handNatural), handMax));
    const handRect = rect(q(cx - handW / 2), q(handTop), handW, handBoxH);
    hand = {
      rect: handRect,
      y: q(handTop + handBoxH / 2),
      cx: q(cx),
      spacing: HAND_SPACING * s,
      padX: handPadX,
      lift,
      card: handCard,
    };

    // my box: avatar, name, HSI, voice buttons (today's spot: 78% across, 72% down)
    const selfX = clamp(cw - 0.219 * cw, cx + handW / 2 + G + selfLeftReach, selfMaxX);
    let selfTop = Math.min(0.715 * ch, ch - M - selfH);
    // a watcher's corner: its voice row above the badge (badge: voice
    // button high, SPECTATOR_BADGE.wPerH wide), my box clear above it when
    // they share the right edge
    const stackTop = ch - M - 2 * voiceBtn - voiceGap;
    const stackLeft = cw - M - Math.max(voiceRowW, voiceBtn * SPECTATOR_BADGE.wPerH);
    if (watcher && selfX + selfW / 2 + G > stackLeft) selfTop = Math.min(selfTop, stackTop - G - selfH);
    const ay = selfTop + D / 2;
    seats.self = seatAt(selfX, ay, { frogSide: -1 });
    const hsiY = seats.self.plate.y + plateH + 4 * s;
    hsi = { rect: rect(q(selfX - hsiW / 2), q(hsiY), hsiW, hsiH), font: hsiFont };
    voice = watcher
      ? { rect: rect(q(cw - M - voiceRowW), q(stackTop), voiceRowW, voiceBtn), button: voiceBtn, gap: voiceGap }
      : { rect: rect(q(selfX - voiceRowW / 2), q(hsiY + hsiH + voiceGap), voiceRowW, voiceBtn), button: voiceBtn, gap: voiceGap };
    // (only a layout with the slot says so: every other stays as it was)
    if (voiceSlots === 4) voice.tutorial = true;
    seats.self.hsi = hsi;
    if (ownVoice) seats.self.voice = voice;
    seats.self.block = rect(q(selfX - selfW / 2), q(selfTop), selfW, selfH);
    // the trick may sit beside my box: only the hand bounds it from below
    bottom = handTop - G;
  } else {
    // the bottom seat, mirrored from the partner's: plate on the bottom margin, backs above
    const ay = ch - M - plateH - plateGap - D / 2;
    seats.self = seatAt(cx, ay, { frogSide: -1 });
    const cardsY = ay - D / 2 - G - back.h / 2;
    seats.self.cards = { x: q(cx), y: q(cardsY), axis: 'h', rotation: 0, spacing: backSp, rect: around(q(cx), q(cardsY), fanLong, back.h) };
    voice = { rect: rect(q(cw - M - voiceRowW), q(ch - M - voiceBtn), voiceRowW, voiceBtn), button: voiceBtn, gap: voiceGap };
    bottom = cardsY - back.h / 2 - G;
  }

  // ---------- the trick ----------
  const tc = card.trick;
  const offX = 80 * s;
  const offY = 90 * s;
  const hx = offX + tc.w / 2;
  const hy = offY + tc.h / 2;
  const cyT = top + hy <= bottom - hy ? clamp(ch / 2, top + hy, bottom - hy) : (top + bottom) / 2;
  const slotRect = (x, y) => around(x, y, tc.w, tc.h);
  // (three seats: a triangle inside the same box, each card toward its seat)
  const tSlots = solo ? {
    self: { x: q(cx), y: q(cyT + SOLO.selfDy * s) },
    opponent1: { x: q(cx - SOLO.sideDx * s), y: q(cyT - SOLO.sideDy * s) },
    opponent2: { x: q(cx + SOLO.sideDx * s), y: q(cyT - SOLO.sideDy * s) },
  } : {
    self: { x: q(cx), y: q(cyT + offY) },
    partner: { x: q(cx), y: q(cyT - offY) },
    opponent1: { x: q(cx - offX), y: q(cyT) },
    opponent2: { x: q(cx + offX), y: q(cyT) },
  };
  for (const k of Object.keys(tSlots)) tSlots[k].rect = slotRect(tSlots[k].x, tSlots[k].y);

  // ---------- trump: top right, today's spot where it fits ----------
  const tCard = card.trump;
  const trumpBox = tCard.box + 20 * s;
  const labelFont = Math.max(9, 14 * s);
  const labelAbove = trumpBox / 2 + 15 * s;
  const trumpTopReach = labelAbove + labelFont * 0.6;
  const trumpY = Math.max(0.185 * ch, M + trumpTopReach);

  // ---------- the side opponents (avatar outside, backs between it and the trick) ----------
  const sideFan = { long: fanLong, short: back.h };
  // three seats: the side seats rise toward the upper corners, as far as
  // the top band (the trick history on the left, the trump on the right)
  // leaves their fans room, the same on both sides
  const soloTop = M + statusH + G + histH + G;
  const rise = solo ? clamp(cyT - (soloTop + sideFan.long / 2), 0, SOLO.rise * s) : 0;
  const sideCy = cyT - rise;
  const sideY = sideCy - (plateGap + plateH) / 2; // the avatar+plate block centred on the trick line, as today
  // the felt this pass wishes for (0: none; see FELT_WISHES), and the bid
  // sheet at full size inside it: the side seats make room where they can
  const feltInset = FELT.border + 8 * s;
  const bidFullW = BID_SHEET.w * s;
  const bidFullH = BID_SHEET.h * s;
  const feltHalfWant = felt > 0 ? Math.max(hx + 8 * s, (felt * FELT.wFrac * cw) / 2, bidFullW / 2 + feltInset) : 0;
  const feltReach = feltHalfWant > 0 ? feltHalfWant + G + sideFan.short / 2 : 0;
  const sides = {};
  for (const [key, dir] of [['opp1', -1], ['opp2', 1]]) {
    const cardsInner = cx + dir * (hx + G + sideFan.short / 2); // nearest the trick may come
    const avatarEdge = dir < 0 ? M + Math.max(blockW / 2, frogReach) : cw - M - Math.max(blockW / 2, frogReach);
    const avatarInner = cardsInner + dir * (sideFan.short / 2 + G + blockW / 2);
    const prefA = cx + dir * Math.max(0.2865 * cw, feltReach > 0 ? feltReach + sideFan.short / 2 + G + blockW / 2 : 0);
    const prefC = cx + dir * Math.max(0.2214 * cw, feltReach);
    // the avatar as far out as today, but never inside the cards' room, never off the edge
    const ax = dir < 0 ? Math.max(avatarEdge, Math.min(prefA, avatarInner)) : Math.min(avatarEdge, Math.max(prefA, avatarInner));
    const cardsOuter = ax - dir * (blockW / 2 + G + sideFan.short / 2);
    const cxCards = dir < 0 ? clamp(prefC, cardsOuter, Math.max(cardsOuter, cardsInner)) : clamp(prefC, Math.min(cardsOuter, cardsInner), cardsOuter);
    const seat = seatAt(ax, sideY, { frogSide: dir });
    seat.cards = {
      x: q(cxCards),
      y: q(sideCy),
      axis: 'v',
      rotation: dir < 0 ? -Math.PI / 2 : Math.PI / 2,
      spacing: backSp,
      rect: around(q(cxCards), q(sideCy), sideFan.short, sideFan.long),
    };
    sides[key] = seat;
  }
  seats.opp1 = sides.opp1;
  seats.opp2 = sides.opp2;

  // ---------- play zone (the green felt): today's 600x400 of a 1920x953 window where it fits ----------
  const zoneMaxW = 2 * Math.min(cx - (seats.opp1.cards.rect.x + seats.opp1.cards.rect.w) - G, seats.opp2.cards.rect.x - G - cx);
  const zoneMinW = 2 * hx + 16 * s;
  const zoneMinH = 2 * hy + 16 * s;
  let zone;
  if (felt > 0) {
    // today's proportions of the canvas, or room for the full bid sheet,
    // between the side seats' cards and from the partner's cards to my
    // hand; centred on the trick where it fits, else slid inside that room
    const zoneW = Math.max(zoneMinW, Math.min(Math.max(2 * feltHalfWant, bidFullW + 2 * feltInset), zoneMaxW));
    const roomH = bottom - top;
    const zoneH = Math.max(zoneMinH, Math.min(Math.max(FELT.hFrac * ch, bidFullH + 2 * feltInset), roomH));
    const zy = roomH >= zoneH ? q(clamp(cyT - zoneH / 2, top, bottom - zoneH)) : q(cyT) - zoneH / 2;
    zone = rect(q(cx) - zoneW / 2, zy, zoneW, zoneH);
  } else {
    // the fallback felt: centred on the trick, as far as it reaches both ways
    const zoneMaxH = 2 * Math.min(cyT - top, bottom - cyT);
    const zoneW = Math.max(zoneMinW, Math.min(FELT.wFrac * cw, zoneMaxW));
    const zoneH = Math.max(zoneMinH, Math.min(FELT.hFrac * ch, zoneMaxH));
    zone = around(q(cx), q(cyT), zoneW, zoneH);
  }

  // ---------- trump (sized above): top right, today's spot where it fits ----------
  // (and clear of the partner's bubble at its first choice: right of the avatar, full width)
  let trumpMinX = M + trumpBox / 2;
  if (seats.partner) {
    const partnerBubble = bubbleRect(seats.partner, BUBBLE_DIRS.partner[0], bubbleBox.w);
    const partnerRight = Math.max(seats.partner.cards.rect.x + seats.partner.cards.rect.w, seats.partner.plate.x + plateW, partnerBubble.x + partnerBubble.w);
    trumpMinX = partnerRight + G + trumpBox / 2;
  }
  // (three seats: top centre, between the two opponents' piles)
  const tx = solo ? cx : clamp(cx + 0.26 * cw, Math.min(trumpMinX, cw - M - trumpBox / 2), cw - M - trumpBox / 2);
  const ty = trumpY;
  const trump = {
    x: q(tx),
    y: q(ty),
    card: tCard,
    box: trumpBox,
    label: { x: q(tx), y: q(ty - labelAbove), font: labelFont },
    rect: rect(q(tx - trumpBox / 2), q(ty - trumpTopReach), trumpBox, trumpTopReach + trumpBox / 2),
  };

  // ---------- bid sheet: over the empty trick while bidding, inside the felt ----------
  const feltInner = { w: zone.w - 2 * feltInset, h: zone.h - 2 * feltInset };
  const bidScale = Math.floor(Math.max(0.05, Math.min(s, feltInner.w / BID_SHEET.w, feltInner.h / BID_SHEET.h)) * 1000) / 1000;
  const bidW = BID_SHEET.w * bidScale;
  const bidH = BID_SHEET.h * bidScale;
  const bidX = q(zone.x + zone.w / 2);
  const bidY = q(zone.y + zone.h / 2);
  const bidSheet = { x: bidX, y: bidY, scale: bidScale, rect: around(bidX, bidY, bidW, bidH) };

  // ---------- who is watching: the spectator badge, bottom right, off the felt ----------
  // (eye + count, at the voice buttons' height: SpectatorBadge, .hud-spectators)
  const badgeH = voiceBtn;
  const badgeW = Math.round(badgeH * SPECTATOR_BADGE.wPerH * 100) / 100;
  const badgeAt = (x, y) => rect(q(x), q(y), badgeW, badgeH);
  // then up the right edge, a row at a time (a phone-size canvas, where a
  // bubble needs the corner: the badge gives way, see below)
  const upTheEdge = (y0) => [1, 2, 3, 4].map((k) => badgeAt(cw - M - badgeW, y0 - k * (voiceGap + badgeH)));
  const badgeCandidates = watcher
    ? [
      // a watcher: the corner, right under its voice row (owner 2026-11-21:
      // the controls above the eye; it never gives way to a seat's bubble)
      badgeAt(cw - M - badgeW, ch - M - badgeH),
    ]
    : isSpectator
    ? [
      // beside the corner's voice buttons, then above them
      badgeAt(voice.rect.x - voiceGap - badgeW, voice.rect.y),
      ...upTheEdge(voice.rect.y),
    ]
    : [
      // the table's corner, then beside my voice buttons (right, left)
      badgeAt(cw - M - badgeW, ch - M - badgeH),
      badgeAt(voice.rect.x + voice.rect.w + voiceGap, voice.rect.y),
      badgeAt(voice.rect.x - voiceGap - badgeW, voice.rect.y),
      ...upTheEdge(ch - M - badgeH),
    ];
  const badgeAvoid = [trump.rect, zone, bidSheet.rect, status.rect, ...Object.values(history).map((h) => h.rect),
    ...Object.values(tSlots).map((t) => t.rect), voice.rect];
  if (hand) badgeAvoid.push(hand.rect);
  for (const seat of Object.values(seats)) {
    badgeAvoid.push(seat.avatar.rect, seat.plate, seat.dealer.rect);
    if (seat.cards) badgeAvoid.push(seat.cards.rect);
    if (seat.hsi) badgeAvoid.push(seat.hsi.rect);
  }
  const onCanvas = (r) => contains(rect(0, 0, cw, ch), r);
  const badgeClean = badgeCandidates.filter((r) => onCanvas(r) && !badgeAvoid.some((o) => intersects(o, r)));

  // ---------- bubbles: each seat's direction and width, clear of the game's information ----------
  const keepBase = [trump.rect, ...Object.values(tSlots).map((t) => t.rect), ...Object.values(history).map((h) => h.rect)];
  if (hand) keepBase.push(hand.rect);
  // every seat's pick with `badge` kept clear too; `rank` counts the seats
  // that got their best kind of spot (a pick at all, beside its own backs)
  const pickBubbles = (badge) => {
    const keep = badge ? [...keepBase, badge] : keepBase;
    const chosen = [];
    const picks = {};
    let rank = 0;
    for (const key of ['partner', 'opp1', 'opp2', 'self']) {
      const seat = seats[key];
      if (!seat) continue; // (no partner at a three-seat table)
      const dirs = bubbleDirsFor(key, isSpectator);
      // the spectator's bottom seat: its bubble leaves its own backs visible
      // too where any direction and width can (a wish: a phone smaller than
      // 390 x 844 may have none, and the bubble then covers them while up)
      const own = isSpectator && key === 'self' ? [seat.cards.rect] : [];
      let pick = null;
      for (const avoid of own.length ? [own, []] : [[]]) {
        for (const f of BUBBLE_WIDTHS) {
          for (const dir of dirs) {
            const clearOwn = avoid.length > 0;
            const r = bubbleRect(seat, dir, bubbleBox.w * f, clearOwn);
            if (!onCanvas(r)) continue;
            if (keep.some((o) => intersects(o, r)) || avoid.some((o) => intersects(o, r)) || chosen.some((o) => intersects(o, r))) continue;
            pick = { dir, w: bubbleBox.w * f, rect: r, clearOwn };
            break;
          }
          if (pick) break;
        }
        if (pick) break;
      }
      if (pick) rank += own.length && !pick.clearOwn ? 1 : 2;
      // none fits: the first choice, and the overlap check sends the search to a smaller s
      if (!pick) pick = { dir: dirs[0], w: bubbleBox.w, rect: bubbleRect(seat, dirs[0], bubbleBox.w) };
      chosen.push(pick.rect);
      picks[key] = pick;
    }
    return { picks, rank };
  };
  // the first clean badge spot that costs no bubble its spot (the badge
  // gives way to the bubbles), else the first clean one, else the first
  // (the overlap check then sends the search to a smaller s)
  let badgeRect = badgeClean[0] || badgeCandidates[0];
  let bubblePicks = pickBubbles(badgeRect);
  if (badgeClean.length > 1) {
    const best = pickBubbles(null).rank;
    if (bubblePicks.rank < best) {
      for (const r of badgeClean.slice(1)) {
        const p = pickBubbles(r);
        if (p.rank === best) {
          badgeRect = r;
          bubblePicks = p;
          break;
        }
      }
    }
  }

  // ---------- the badge's own bubble: a spectator's chat, over the eye ----------
  // At its largest (3 lines, the tail) it leaves the game's information, my
  // box, the voice buttons, the status pill, the bid sheet and every seat's
  // bubble visible; it is chosen after the seats' bubbles, so theirs keep
  // their spots (it may cover the felt or another seat, as theirs may).
  const badgeGap = 4 * s;
  const { h: bbH, tail: bbTail } = bubbleBox;
  // every spot for a bubble bw wide by badge b (best first), with the edge it hangs from
  const badgeBubbleSpots = (b, bw) => {
    const bc = b.x + b.w / 2;
    const out = [];
    const up = b.y - badgeGap - bbTail; // the box's bottom; the tail below it
    const above = (align, edge) => {
      const x = align === 'end' ? edge - bw : edge;
      const off = align === 'end' ? edge - bc : bc - edge;
      // the tail on the bubble, clear of its rounded ends
      if (off < BADGE_TAIL_ROOM || bw - off < BADGE_TAIL_ROOM) return;
      const tailOffset = off - BADGE_TAIL_HALF;
      out.push({ tail: 'down', align, x: edge, y: up, rect: rect(x, up - bbH, bw, bbH + bbTail), tailOffset, minW: tailOffset + BADGE_TAIL_ROOM + BADGE_TAIL_HALF, minH: 0 });
    };
    above('end', b.x + b.w);
    if (cw - M > b.x + b.w) above('end', cw - M);
    above('start', b.x);
    above('end', bc + BADGE_TAIL_ROOM);
    above('start', bc - BADGE_TAIL_ROOM);
    // beside it, bottom-aligned (the tail at the badge's middle)
    const bottom = b.y + b.h;
    const sideOff = b.h / 2 - BADGE_TAIL_HALF;
    const minH = Math.max(b.h, sideOff + BADGE_TAIL_ROOM + BADGE_TAIL_HALF);
    if (bbH >= minH) {
      const right = b.x - badgeGap - bbTail;
      out.push({ tail: 'right', align: 'end', x: right, y: bottom, rect: rect(right - bw, bottom - bbH, bw + bbTail, bbH), tailOffset: sideOff, minW: 0, minH });
      const left = b.x + b.w + badgeGap + bbTail;
      out.push({ tail: 'left', align: 'start', x: left, y: bottom, rect: rect(left - bbTail, bottom - bbH, bw + bbTail, bbH), tailOffset: sideOff, minW: 0, minH });
      // a watcher's corner (its voice row right above the badge, wider): beside the pair, its tail toward the badge's row
      if (watcher && voice.rect.x < b.x && b.y >= voice.rect.y + voice.rect.h - 0.5) {
        const r2 = voice.rect.x - badgeGap - bbTail;
        out.push({ tail: 'right', align: 'end', x: r2, y: bottom, rect: rect(r2 - bw, bottom - bbH, bw + bbTail, bbH), tailOffset: sideOff, minW: 0, minH });
      }
    }
    return out.map((o) => ({ ...o, w: bw }));
  };
  const seatRects = (seat) => [seat.avatar.rect, seat.plate, seat.dealer.rect, seat.cards?.rect, seat.hsi?.rect, seat.voice?.rect].filter(Boolean);
  const pickBadgeBubble = (b, picks) => {
    const keep = [...keepBase, ...Object.values(picks).map((p) => p.rect), status.rect, bidSheet.rect, voice.rect, b];
    if (!isSpectator) keep.push(...seatRects(seats.self));
    for (const f of BUBBLE_WIDTHS) {
      for (const spot of badgeBubbleSpots(b, bubbleBox.w * f)) {
        if (onCanvas(spot.rect) && !keep.some((o) => intersects(o, spot.rect))) return spot;
      }
    }
    return null;
  };
  let badgeBubble = pickBadgeBubble(badgeRect, bubblePicks.picks);
  // no room by this spot: the badge's next clean spot that leaves every
  // seat's bubble where it is; else no badge bubble at this size (a
  // transient bubble never shrinks the table: the message is in the log)
  if (!badgeBubble) {
    const same = (p) => Object.keys(bubblePicks.picks).every((k) => {
      const a = bubblePicks.picks[k].rect;
      const b = p.picks[k].rect;
      return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
    });
    for (const r of badgeClean) {
      if (r === badgeRect) continue;
      const p = pickBubbles(r);
      if (!same(p)) continue;
      const bb = pickBadgeBubble(r, p.picks);
      if (bb) {
        badgeRect = r;
        badgeBubble = bb;
        break;
      }
    }
  }
  const spectators = {
    rect: badgeRect,
    h: badgeH,
    w: badgeW,
    font: Math.max(10, 14 * s),
    icon: Math.round(badgeH * 0.5 * 100) / 100,
    // the badge's chat bubble: hung from (x, y) by its `align` edge and its
    // bottom, at most w wide, its tail tailOffset from that edge (from the
    // bottom for a side tail); rect = its largest box, tail included; null
    // where no spot by the badge has room (a phone-size canvas)
    bubble: badgeBubble && {
      tail: badgeBubble.tail,
      align: badgeBubble.align,
      x: r1(badgeBubble.x),
      y: r1(badgeBubble.y),
      w: badgeBubble.w,
      rect: badgeBubble.rect,
      tailOffset: r1(badgeBubble.tailOffset),
      minW: r1(badgeBubble.minW),
      minH: r1(badgeBubble.minH),
    },
  };
  for (const [key, pick] of Object.entries(bubblePicks.picks)) {
    const seat = seats[key];
    const a = bubbleAnchor(seat, pick.dir, !!pick.clearOwn);
    seat.bubble = { dx: a.dx, dy: a.dy, x: seat.avatar.x + a.dx, y: seat.avatar.y + a.dy, tail: pick.dir, w: pick.w, rect: pick.rect };
  }
  const bubbles = { ...bubbleBox };

  // ---------- draw phase (no hand, no seats yet) ----------
  const draw = placeDraw({ cw, ch, s, M, G, q, dpr, deckCard: card.deck, drawn: card.drawn, ...(solo && { n: 3, text: DRAW_TEXT_SOLO }) });

  // teams panel (DrawManager, the HUD's .hud-teams): centred on the canvas,
  // at most the canvas less its margins wide (a long name wraps inside it)
  const teams = {
    x: q(cx),
    y: q(ch / 2),
    maxW: Math.max(1, cw - 2 * M),
    pad: Math.max(SPACE.s3, SPACE.s6 * s),
    gap: Math.max(SPACE.s2, SPACE.s4 * s),
    avatar: Math.max(24, SPACE.s10 * s),
    fonts: { names: Math.max(TYPE.sm, 18 * s), vs: Math.max(TYPE.sm, TYPE.md * s) },
  };

  // ---------- effects (transient: not part of the overlap checks) ----------
  const effects = {
    impact: { x: q(cx), y: q(cyT), scale: 1.2 * s },
    overTrump: { x: q(cx - 180 * s), y: q(cyT - 150 * s), scale: 0.9 * s },
    rainbow: {
      self: { x: seats.self.avatar.x + (isSpectator ? 112 * s : 33 * s), y: seats.self.avatar.y - (isSpectator ? 0 : 147 * s) },
      ...(seats.partner && { partner: { x: seats.partner.avatar.x + 112 * s, y: seats.partner.avatar.y } }),
      opp1: { x: seats.opp1.avatar.x - 95 * s, y: seats.opp1.avatar.y },
      opp2: { x: seats.opp2.avatar.x + 66 * s, y: seats.opp2.avatar.y },
    },
    rainbowScale: s,
  };

  const log = logW > 0
    ? rect(cw + LOG_MARGIN, LOG_MARGIN, logW - 2 * LOG_MARGIN, ch - 2 * LOG_MARGIN)
    : null;

  return {
    w: cw,
    h: ch,
    dpr,
    s: r1(s),
    isSpectator: !!isSpectator,
    // (a watcher's layout says so; every other is as it was)
    ...(watcher && { watcher: true }),
    // (a three-seat table says so too)
    ...(solo && { solo: true }),
    compact: !!compact,
    historyScale: k,
    degraded: false,
    margin: M,
    gap: G,
    logW,
    canvas: rect(0, 0, cw, ch),
    log,
    card,
    cardTexture: { ...tex, dpr },
    seats,
    fonts: { plate: plateFont, plateLH, hsi: hsiFont },
    plate: { w: plateW, h: plateH, gap: plateGap, lh: plateLH, font: plateFont },
    trick: { center: { x: q(cx), y: q(cyT) }, slots: tSlots, zone },
    felt: { wish: felt, inset: feltInset, border: FELT.border },
    bubbles,
    history,
    hand,
    trump,
    bidSheet,
    status,
    voice,
    spectators,
    draw,
    teams,
    effects,
  };
}

/** The groups a bubble must leave visible (the game's information, the spectator badge, and the other bubbles, the badge's included). */
export const BUBBLE_KEEPS = ['trump', 'hand', 'trick:self', 'trick:partner', 'trick:opponent1', 'trick:opponent2',
  'history:team', 'history:opp', 'history:opp2', 'spectators', 'bubble:self', 'bubble:partner', 'bubble:opp1', 'bubble:opp2', 'bubble:spectators'];
/**
 * What the badge's bubble must leave visible besides BUBBLE_KEEPS: the
 * status pill, the bid sheet and the voice buttons, and for a player my box
 * (seat:self: avatar, plate, frog, HSI and the voice buttons under it; a
 * spectator's 'self' is the bottom seat, which it may cover like any seat).
 */
export function badgeBubbleKeeps(isSpectator) {
  return [...BUBBLE_KEEPS, 'status', 'bidSheet', 'voice', ...(isSpectator ? [] : ['seat:self'])];
}

/**
 * Every rect the overlap check knows, with its group: rects of the same
 * group may overlap (a seat's avatar, plate and frog), `allow` lists
 * other groups a rect may cover, `only` (bubbles) the groups it may not.
 * The bid sheet covers the trick slots by design: it is up only while
 * bidding, when no trick card is on the table. A bubble (at its largest)
 * may sit over the felt, the bid sheet and the seats, never over
 * BUBBLE_KEEPS.
 */
export function layoutRects(L) {
  const out = [];
  const add = (id, group, r, allow = [], only = null) => r && out.push({ id, group, rect: r, allow, ...(only ? { only } : {}) });
  for (const [key, seat] of Object.entries(L.seats)) {
    const g = `seat:${key}`;
    add(`${key}.avatar`, g, seat.avatar.rect);
    add(`${key}.plate`, g, seat.plate);
    add(`${key}.dealer`, g, seat.dealer.rect);
    add(`${key}.seatBadge`, g, seat.seatBadge.rect);
    if (seat.cards) add(`${key}.cards`, g, seat.cards.rect);
    if (seat.hsi) add(`${key}.hsi`, g, seat.hsi.rect);
    if (seat.voice) add(`${key}.voice`, g, seat.voice.rect);
  }
  if (L.isSpectator || L.watcher) add('voice', 'voice', L.voice.rect);
  for (const [key, slot] of Object.entries(L.trick.slots)) add(`trick.${key}`, `trick:${key}`, slot.rect, ['zone', 'bidSheet']);
  add('trick.zone', 'zone', L.trick.zone, ['trick:self', 'trick:partner', 'trick:opponent1', 'trick:opponent2', 'bidSheet']);
  add('history.team', 'history:team', L.history.team.rect);
  add('history.opp', 'history:opp', L.history.opp.rect);
  if (L.history.opp2) add('history.opp2', 'history:opp2', L.history.opp2.rect);
  if (L.hand) add('hand', 'hand', L.hand.rect);
  add('trump', 'trump', L.trump.rect);
  add('bidSheet', 'bidSheet', L.bidSheet.rect, ['zone', 'trick:self', 'trick:partner', 'trick:opponent1', 'trick:opponent2']);
  add('status', 'status', L.status.rect);
  if (L.spectators) add('spectators', 'spectators', L.spectators.rect);
  if (L.log) add('log', 'log', L.log);
  for (const [key, seat] of Object.entries(L.seats)) add(`${key}.bubble`, `bubble:${key}`, seat.bubble.rect, [], BUBBLE_KEEPS);
  if (L.spectators?.bubble) add('spectators.bubble', 'bubble:spectators', L.spectators.bubble.rect, [], badgeBubbleKeeps(L.isSpectator));
  return out;
}

/** The draw phase's rects (title, rule, the four avatars, names and cards, the deck, the prompt). */
export function drawRects(L) {
  const d = L.draw;
  return [
    { id: 'draw.title', group: 'title', rect: d.title.rect, allow: [] },
    { id: 'draw.rules', group: 'rules', rect: d.rules.rect, allow: [] },
    { id: 'draw.deck', group: 'deck', rect: d.deck.rect, allow: [] },
    { id: 'draw.prompt', group: 'prompt', rect: d.prompt.rect, allow: [] },
    ...d.avatar.rects.map((r, i) => ({ id: `draw.avatar${i}`, group: `avatar${i}`, rect: r, allow: [] })),
    ...d.slotRects.map((r, i) => ({ id: `draw.slot${i}`, group: `slot${i}`, rect: r, allow: [] })),
    ...d.name.rects.map((r, i) => ({ id: `draw.name${i}`, group: `name${i}`, rect: r, allow: [] })),
  ];
}

/** Pairs of rects from different groups that overlap (and may not). */
export function findIntersections(L, rects = null) {
  const list = rects || [...layoutRects(L), ...drawRects(L)];
  const hits = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.group === b.group) continue;
      if (a.allow.includes(b.group) || b.allow.includes(a.group)) continue;
      if ((a.only && !a.only.includes(b.group)) || (b.only && !b.only.includes(a.group))) continue;
      // two draw-phase rects never meet table rects (they are never up together)
      if (a.id.startsWith('draw.') !== b.id.startsWith('draw.')) continue;
      if (intersects(a.rect, b.rect)) hits.push([a.id, b.id]);
    }
  }
  return hits;
}

/** Rects that leave the canvas (the log: its column beside it). */
export function findOutside(L, rects = null) {
  const list = rects || [...layoutRects(L), ...drawRects(L)];
  const view = rect(0, 0, L.w + (L.logW || 0), L.h);
  return list.filter((r) => !contains(r.id === 'log' ? view : L.canvas, r.rect)).map((r) => r.id);
}

/**
 * The table layout for a canvas of w x h.
 * @param {Object} opts
 * @param {number} opts.w - canvas width (#game-container)
 * @param {number} opts.h - canvas height
 * @param {number} [opts.dpr=1] - device pixel ratio: positions snap to device pixels
 * @param {boolean} [opts.isSpectator=false] - a pure spectator (no hand: the bottom seat)
 * @param {number} [opts.logW=0] - the log column beside the canvas (0: none)
 * @param {boolean} [opts.tutorial=false] - I play my own seat (not a spectator,
 *   not lazy): my voice row reserves a 4th button, the Tutorial button's
 *   (every other layout is as without it)
 * @param {boolean} [opts.watcher=false] - a spectator watching a seat (the
 *   over-the-shoulder view): the seated layout of the watched seat, but my
 *   voice row in the corner above the spectator badge, never under the
 *   watched player's box (owner 2026-11-21; every other layout as without it)
 * @param {boolean} [opts.solo=false] - a three-seat table (Get Your Bid):
 *   no partner seat, the other two raised to the upper corners, a triangular
 *   trick, three draw slots (every other layout as without it)
 */
export function computeTableLayout({ w, h, dpr = 1, isSpectator = false, logW = 0, tutorial = false, watcher = false, solo = false } = {}) {
  const cw = Math.max(1, Number(w) || 1);
  const ch = Math.max(1, Number(h) || 1);
  const d = dpr > 0 ? dpr : 1;
  const watch = !!watcher && !isSpectator;
  const opts = { isSpectator: !!isSpectator, logW: logW || 0, dpr: d, tutorial: !!tutorial && !isSpectator && !watch, ...(watch && { watcher: true }), ...(solo && { solo: true }) };
  // first pass: a hand box that shows a 13-card hand at 2/3 of its spacing;
  // second pass: any hand box that fits
  const clean = (L) => findIntersections(L).length === 0 && findOutside(L).length === 0;
  for (const roomyHand of [true, false]) {
    for (let i = 0; ; i++) {
      const s = r1(S_MAX - i * S_STEP);
      if (s < S_MIN - 1e-9) break;
      for (const k of HISTORY_SCALES) {
        for (const compact of [false, true]) {
          const L = place(cw, ch, s, { ...opts, compact, k });
          if (roomyHand && !handRoomy(L)) continue;
          if (!clean(L)) continue;
          // the felt as close to today's as the seats allow (the side seats
          // move out for it), at the same scale: s comes first; at each felt,
          // my team's history at today's inset from the bottom where it fits
          for (const felt of FELT_WISHES) {
            for (const histInset of [true, false]) {
              if (felt === 0 && !histInset) return L;
              const F = place(cw, ch, s, { ...opts, compact, k, felt, histInset });
              if ((!roomyHand || handRoomy(F)) && clean(F)) return F;
            }
          }
        }
      }
    }
  }
  // the Tutorial button's slot never costs a clean table (the narrowest
  // phones, 360 px, which the phone gate sends to the app): without it there
  if (opts.tutorial) return computeTableLayout({ w, h, dpr, isSpectator, logW, solo });
  const L = place(cw, ch, S_MIN, { ...opts, compact: true, k: HISTORY_SCALES[HISTORY_SCALES.length - 1] });
  L.degraded = true;
  return L;
}

/** The layout of a whole viewport: the log column (logWidthFor) comes off the right. */
export function layoutForViewport({ vw, vh, dpr = 1, isSpectator = false, withLog = true, tutorial = false, watcher = false, solo = false } = {}) {
  const logW = withLog ? logWidthFor(vw) : 0;
  return computeTableLayout({ w: vw - logW, h: vh, dpr, isSpectator, logW, tutorial, watcher, solo });
}

/** Hand card centres for n cards (left to right), spaced to fit the hand box. */
export function handPositions(L, n) {
  if (!L.hand || n <= 0) return [];
  const { rect: box, padX, spacing, card } = L.hand;
  const room = box.w - 2 * padX - card.w;
  const sp = n > 1 ? Math.min(spacing, room / (n - 1)) : 0;
  const total = (n - 1) * sp;
  const x0 = L.hand.cx - total / 2;
  // each centre on a whole device pixel: with the frame's even size the
  // card's edges are too (1:1 sampling; CardAtlas.cardTextureSize)
  const dpr = L.dpr > 0 ? L.dpr : 1;
  return Array.from({ length: n }, (_, i) => ({ x: Math.round((x0 + i * sp) * dpr) / dpr, y: L.hand.y }));
}

/** Card-back centres of a seat's fan (n cards), with the fan's rotation. */
export function fanPositions(L, seatKey, n) {
  const c = L.seats[seatKey]?.cards;
  if (!c || n <= 0) return [];
  const total = (n - 1) * c.spacing;
  return Array.from({ length: n }, (_, i) => (c.axis === 'h'
    ? { x: c.x - total / 2 + i * c.spacing, y: c.y, rotation: c.rotation }
    : { x: c.x, y: c.y - total / 2 + i * c.spacing, rotation: c.rotation }));
}

/** The centre of trick n (1-13) of my team's ('team') or the opponents' ('opp') history. */
export function historySlot(L, side, n) {
  const slots = L.history[side].slots;
  return slots[Math.max(0, Math.min(slots.length - 1, n - 1))];
}

/** Deck card i's centre (0-53) in the draw phase. */
export function deckPosition(L, i) {
  return { x: L.draw.deck.x0 + i * L.draw.deck.overlap, y: L.draw.deck.y };
}

/**
 * The layout a scene draws with: scene.getLayout() when it has one (GameScene),
 * else one computed from scene.scale (manager unit tests, mock scenes).
 */
export function layoutOf(scene) {
  if (scene && typeof scene.getLayout === 'function') return scene.getLayout();
  const w = scene?.scale?.width || 1920;
  const h = scene?.scale?.height || 953;
  const key = `${w}x${h}`;
  if (!scene._layoutFallback || scene._layoutFallback.key !== key) {
    scene._layoutFallback = { key, layout: computeTableLayout({ w, h }) };
  }
  return scene._layoutFallback.layout;
}

/** The /help lightbulb's smallest size (px): legible on a small table. */
export const ASK_MIN = 28;
/** Its hit area at the least (HIG 44 pt; tokens.css --hit-target). */
export const ASK_HIT = 44;
/**
 * What the lightbulb keeps clear of: everything but the hand box itself,
 * the log beside the canvas and the chat bubbles (they come and go, over
 * anything).
 */
function askBlockers(L) {
  return layoutRects(L)
    .filter((r) => r.id !== 'hand' && r.id !== 'log' && !String(r.group).startsWith('bubble'))
    .map((r) => r.rect);
}

/**
 * The lightbulb's hit box: `pad` to the sides of the bulb whose right and
 * bottom edges are (x, y), `up` above it and `down` below it.
 */
export function assistAskHit({ x, size, pad }, y, up, down) {
  return rect(x - size - pad, y - size - up, size + 2 * pad, size + up + down);
}

/**
 * Where the /help lightbulb goes (AssistCard's .hud-assist-ask; tableHud
 * sets --assist-ask-* from it): the voice buttons' size, at least ASK_MIN,
 * at the hand box's right end, its bottom level with the top of the lifted
 * cards. Its hit area is `pad` (at least 6 px) to the sides, so ASK_HIT
 * across, and as tall: `up` above the bulb, `down` below it, all above
 * (down 0) where there is room, so it never reaches over the lifted cards'
 * tops. It stays inside the hand box sideways, clear of my seat's box
 * (avatar, frog, plate, HSI, pips, voice buttons) beside it. On a short
 * table, where the felt's trick zone, the bid sheet (its clock) or the
 * spectator badge is just above, the hit area reaches below the bulb
 * instead, and only where the bulb itself would rise into them does it come
 * down inside the hand box, just far enough to clear them. One spot per
 * layout: the card count never moves it.
 * Null without a hand (a spectator).
 * @returns {{x:number, y:number, size:number, pad:number, up:number, down:number}|null}
 *   x, y: the bulb's right and bottom edges
 */
export function assistAskSpot(L) {
  const h = L?.hand;
  if (!h?.card) return null;
  const size = Math.max(ASK_MIN, L.voice.button);
  const pad = Math.max(6, (ASK_HIT - size) / 2);
  const x = h.rect.x + h.rect.w - pad;
  const a = { x, size, pad };
  const blockers = askBlockers(L);
  const handBottom = h.rect.y + h.rect.h;
  // the bulb itself (with its side pads) clear: a few steps down, each to
  // just below what it hits, never below the hand box
  let y = h.y - h.card.h / 2 - (h.lift || 0);
  for (let i = 0; i < 4; i++) {
    const box = assistAskHit(a, y, 0, 0);
    const over = blockers.filter((r) => intersects(box, r));
    if (!over.length) break;
    y += Math.max(...over.map((r) => r.y + r.h)) - box.y;
  }
  y = Math.min(y, handBottom);
  // then as much of the hit area above it as is free
  const over = blockers.filter((r) => intersects(assistAskHit(a, y, 2 * pad, 0), r));
  const top = over.length ? Math.max(...over.map((r) => r.y + r.h)) : -Infinity;
  const up = Math.min(2 * pad, Math.max(0, y - size - top));
  return { x, y, size, pad, up, down: 2 * pad - up };
}

/** The /help card's gap below a seat it keeps clear of (assistRoomTop). */
export const ASSIST_SEAT_GAP = 6;
/**
 * The least room the card keeps (the advice's chip and headline, a reason):
 * a seat that would leave less (a side seat level with my hand on a squat
 * table) does not cap it.
 */
export const ASSIST_MIN_ROOM = 96;

/**
 * How high the /help card (with a tutorial tip) may reach: just below the
 * lowest other seat's block (avatar and name plate: partner, opponents),
 * or the trump card, that its column, `w` wide centred on `cx`, would cross above `bottom`
 * (the card's foot), so the card never covers a seat's avatar (a seat that
 * would leave it under ASSIST_MIN_ROOM does not count); 0 when none is in
 * the way (tableHud --assist-top / --assist-bid-top; table.css caps the
 * card's height there and it scrolls inside, the advice kept in sight).
 * @param {Object} L - the layout
 * @param {number} cx - the card's centre
 * @param {number} w - the card's widest
 * @param {number} bottom - the card's foot (its top edge never below it)
 * @param {Object} [o]
 * @param {number} [o.minRoom] - a cap that leaves less is ignored (0: every one counts)
 * @returns {number}
 */
export function assistRoomTop(L, cx, w, bottom, { minRoom = ASSIST_MIN_ROOM } = {}) {
  const left = cx - w / 2;
  const right = cx + w / 2;
  let top = 0;
  const keep = ['partner', 'opp1', 'opp2'].map((k) => L?.seats?.[k]?.block);
  for (const b of [...keep, L?.trump?.rect]) {
    if (!b || b.x >= right || b.x + b.w <= left) continue;
    const below = b.y + b.h + ASSIST_SEAT_GAP;
    if (below <= bottom - minRoom) top = Math.max(top, below);
  }
  return top;
}

/**
 * Where the /help card goes above my hand (tableHud --assist-x / -y /
 * -top): centred on the hand, its foot just above the lifted cards; moved
 * sideways (as little as it takes, inside the canvas) where its column
 * would cross my own seat's box beside the hand (a narrow window: the card
 * is wider than the hand box), or, with no room to the side (a phone), its
 * foot just above my seat; reaching up no higher than just below the other
 * seats it crosses (assistRoomTop).
 * @param {Object} L - the layout
 * @param {number} w - the card's widest
 * @returns {{x:number, y:number, top:number}|null} x: its centre, y: its foot; null without a hand
 */
export function assistHandSpot(L, w) {
  const h = L?.hand;
  if (!h?.card) return null;
  const gap = Math.max(4, 6 * L.s);
  const y = h.y - h.card.h / 2 - (h.lift || 0) - gap;
  const edge = Math.max(8, 8 * L.s);
  let x = h.cx;
  const me = L.seats?.self?.block;
  if (me && me.y < y && me.y + me.h > 0 && x - w / 2 < me.x + me.w && x + w / 2 > me.x) {
    // to whichever side of my seat the hand is on
    x = h.cx <= me.x + me.w / 2 ? me.x - gap - w / 2 : me.x + me.w + gap + w / 2;
  }
  x = Math.min(Math.max(x, edge + w / 2), L.w - edge - w / 2);
  // no side room (a phone): its foot above my seat instead, where that leaves room
  let foot = y;
  if (me && me.y < y && x - w / 2 < me.x + me.w && x + w / 2 > me.x) {
    const up = me.y - gap;
    if (up - assistRoomTop(L, x, w, up) >= ASSIST_MIN_ROOM) foot = up;
  }
  return { x, y: foot, top: assistRoomTop(L, x, w, foot) };
}

/**
 * The room above the bid sheet the /help card wants on my bid turn (a tip
 * and the advice's chip, headline and a reason); with less, assistBidSpot
 * looks beside the sheet.
 */
export const ASSIST_BID_ROOM = 160;

/**
 * Where the /help card goes on my bid turn (a bid answer, the tutorial's tip
 * with it; tableHud --assist-bid-*): above the bid sheet, centred on it,
 * reaching up no higher than just below the seats it crosses, where that
 * leaves ASSIST_BID_ROOM; else (a short window: at 1280 x 800 the partner's
 * seat is just above the sheet) the tallest free room beside the sheet,
 * left or right, between the seats (avatar, plate, dealer chip), the
 * histories, the status pill and the trump card, where it is taller (the
 * other seats' face-down fans may go under it; the felt's trick slots are
 * empty while we bid; chat bubbles come and go over anything), its foot no
 * lower than the sheet's, hugging the sheet; else above it (assistRoomTop:
 * over a seat only where nothing leaves ASSIST_MIN_ROOM).
 * @param {Object} L - the layout
 * @param {number} w - the card's widest
 * @returns {{x:number, y:number, top:number, w:number, side:'above'|'left'|'right'}}
 *   x: its centre, y: its foot, top: as high as it may reach, w: its widest there
 */
export function assistBidSpot(L, w) {
  const sheet = L.bidSheet.rect;
  const gap = Math.max(4, 6 * L.s);
  const bottom = sheet.y - gap;
  const above = { x: L.bidSheet.x, y: bottom, top: assistRoomTop(L, L.bidSheet.x, w, bottom), w, side: 'above' };
  // the room above below every seat (and the trump card) it crosses, however little
  const clearTop = assistRoomTop(L, above.x, w, bottom, { minRoom: 0 });
  const aboveRoom = bottom - clearTop;
  if (aboveRoom >= ASSIST_BID_ROOM) return { ...above, top: clearTop };
  const skip = new Set(['hand', 'log', 'bidSheet', 'zone', 'spectators']);
  const blockers = layoutRects(L)
    .filter((r) => !skip.has(r.id) && r.group !== 'zone' && !String(r.group).startsWith('trick') &&
      !String(r.group).startsWith('bubble') && !r.id.endsWith('.cards'))
    .map((r) => r.rect);
  const edge = Math.max(8, 8 * L.s);
  const floor = sheet.y + sheet.h;
  let best = null;
  for (const side of ['left', 'right']) {
    const x0 = side === 'left' ? edge : sheet.x + sheet.w + gap;
    const x1 = side === 'left' ? sheet.x - gap : L.w - edge;
    const width = Math.min(w, x1 - x0);
    if (width < Math.min(240, w)) continue;
    const left = side === 'left' ? x1 - width : x0;
    // the free stretches of that column, top to the sheet's foot
    const spans = blockers
      .filter((r) => r.x < left + width && r.x + r.w > left && r.y < floor)
      .map((r) => [r.y - gap, r.y + r.h + gap])
      .sort((a, b) => a[0] - b[0]);
    let y = edge;
    for (const [a, b] of [...spans, [floor, floor]]) {
      const room = Math.min(a, floor) - y;
      if (room > 0 && (!best || room > best.y - best.top)) best = { x: left + width / 2, y: y + room, top: y, w: width, side };
      y = Math.max(y, b);
    }
  }
  return best && best.y - best.top >= ASSIST_MIN_ROOM && best.y - best.top > aboveRoom ? best : above;
}
