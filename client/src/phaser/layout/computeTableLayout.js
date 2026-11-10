/**
 * The web table's layout (roadmap item 17): one pure function of the canvas
 * size that places every anchor on the table, for Phaser and the DOM HUD
 * alike. iOS does the same in iOSClient/.../SpriteKit/TableLayout.swift
 * (item 25); this one mirrors its semantics where they fit:
 *
 *   - one uniform size scale s for every sprite and DOM size (cards,
 *     avatars, plates, trick slots, the bid sheet), never above 1 (the card
 *     art is 64 px; item 18 brings hi-res cards);
 *   - s is SOLVED, not guessed: the search tries s = 1, 0.99 ... and takes
 *     the first layout with no rect intersections and nothing off the
 *     canvas, checked by the same findIntersections / findOutside the tests
 *     use (a roomy hand box first, then a compact one, at each s);
 *   - positions are today's fractions of the canvas where they fit (the
 *     1920x1080 table looks as it did) and are pushed apart where they do
 *     not;
 *   - the felt keeps today's proportions of the window where the side seats
 *     can move out for it (FELT_WISHES, tried at the solved s: the scale
 *     comes first), and the bid sheet sits inside it;
 *   - each seat's chat/bid bubble gets a direction and width (BUBBLE_DIRS,
 *     BUBBLE_WIDTHS) so that at its largest it never covers the trump, the
 *     hand, the trick or the histories (BUBBLE_KEEPS, in the same check);
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
 */

import { CARD_CONFIG } from '../config.js';

/** The 64 px atlas frame and the card inside it (CARD_CONFIG.CARD_BOUNDS). */
export const FRAME = CARD_CONFIG.FRAME_WIDTH;
export const CARD_VISIBLE = { w: CARD_CONFIG.CARD_BOUNDS.width, h: CARD_CONFIG.CARD_BOUNDS.height };

/** Sprite scales at s = 1 (today's: hand and trick 1.5, backs and deck 1.2, history 1.0). */
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
/** The sheet's padding (12 px) and border (2 px), both sides. */
export const BID_SHEET_CHROME = 2 * (12 + 2);
/**
 * The bid sheet's size at scale 1 (BidManager sets this width; 13 cards is
 * the tallest). 13 chips at their natural width set the width (the widest
 * row; an overbid's extra chips shrink to fit it).
 */
export const BID_SHEET = { w: 13 * BID_CHIP.w + 12 * BID_CHIP.gap + BID_SHEET_CHROME, h: 330 };
/** Status pill text (the longest, lazy mode). */
export const STATUS_TEXT_W = 380;

/**
 * The play zone (the green felt, LayoutManager's #playZoneDom). Before item
 * 17 it was 600 x 400 of a 1920 x 953 design, scaled by the window
 * (0.3125 of the width, 0.42 of the height); it keeps those proportions
 * where the seats leave room. Its 4 px border is inside the rect
 * (box-sizing), and the bid sheet sits inside it, `inset` from the edge.
 */
export const FELT = { wFrac: 0.3125, hFrac: 0.42, border: 4 };
/** The felt's width wishes (times the 0.3125 x viewport target), tried in order; 0 is the fallback felt. */
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
};
/**
 * Bubble width steps (times the full width), each tried in every direction
 * before the next: a phone's bubbles narrow (to 79 px on a 390 x 844
 * phone's 260 px canvas) rather than cover the trick or shrink the table.
 */
const BUBBLE_WIDTHS = [1, 0.85, 0.7, 0.6];

const S_MAX = 1;
const S_MIN = 0.15;
const S_STEP = 0.01;
const MARGIN = 10;
const HAND_SPACING = CARD_CONFIG.HAND_SPACING;
const MIN_HAND_SPACING = 16;
const BACK_SPACING = 9;
const MAX_CARDS = 13;
const HISTORY_COLS = 7;
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

/** Card sizes on screen for a sprite scale (the visible card, not the frame). */
function cardSize(scale) {
  return { scale, w: CARD_VISIBLE.w * scale, h: CARD_VISIBLE.h * scale, frame: FRAME * scale };
}

/**
 * Place everything at size scale s. Returns the layout; whether it is clean
 * is for findIntersections / findOutside to say.
 */
function place(cw, ch, s, { isSpectator, compact, logW, dpr, k = 1, felt = 0 }) {
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

  const card = {
    hand: cardSize(BASE_SCALE.hand * s),
    trick: cardSize(BASE_SCALE.trick * s),
    back: cardSize(BASE_SCALE.back * s),
    history: cardSize(BASE_SCALE.history * s * k),
    trump: cardSize(BASE_SCALE.trump * s),
    deck: cardSize(BASE_SCALE.deck * s),
    drawn: cardSize(BASE_SCALE.drawn * s),
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
    // (the bubble is chosen once the table is placed: see 'bubbles' below)
    return { avatar, plate, dealer, bubble: null, block: rect(ax - blockW / 2, ay - D / 2, blockW, D + plateGap + plateH) };
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
  const bubbleAnchor = (seat, dir) => {
    const half = seat.avatar.size / 2;
    if (dir === 'left') return { dx: half + 12 * s, dy: 0 };
    if (dir === 'right') return { dx: -(half + 12 * s), dy: 0 };
    return { dx: 0, dy: -(half + 14 * s) };
  };
  const bubbleRect = (seat, dir, bw) => {
    const a = bubbleAnchor(seat, dir);
    const bx = seat.avatar.x + a.dx;
    const by = seat.avatar.y + a.dy;
    const { h: bh, tail } = bubbleBox;
    if (dir === 'left') return rect(bx - tail, by - bh / 2, bw + tail, bh);
    if (dir === 'right') return rect(bx - bw, by - bh / 2, bw + tail, bh);
    return rect(bx - bw / 2, by - bh, bw, bh + tail);
  };

  const pAy = M + statusH + G + D / 2;
  seats.partner = seatAt(cx, pAy, { frogSide: -1 });
  const pCardsY = seats.partner.plate.y + plateH + G + back.h / 2;
  seats.partner.cards = { x: q(cx), y: q(pCardsY), axis: 'h', rotation: 0, spacing: backSp, rect: around(q(cx), q(pCardsY), fanLong, back.h) };
  const top = pCardsY + back.h / 2 + G;

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
  const historyBlock = (rawX, rawY) => {
    // the block snaps first and its slots hang off the snapped corner
    const bx = q(rawX);
    const by = q(rawY);
    const x0 = bx + histPad + slotW / 2;
    const y0 = by + histPad + slotH / 2;
    const slots = [];
    for (let n = 1; n <= MAX_CARDS; n++) {
      const row = n <= HISTORY_COLS ? 0 : 1;
      const col = row === 0 ? n - 1 : n - HISTORY_COLS - 1;
      slots.push({ x: q(x0 + col * histSpacing + (row === 1 ? histSpacing / 2 : 0)), y: q(y0 + row * histRow) });
    }
    return { rect: rect(bx, by, histW, histH), slots, slotW, slotH, pad: histPad, spacing: histSpacing, rowSpacing: histRow, fanDx: 30 * hs, fanDy: 8 * hs, scale: k };
  };
  const history = {
    opp: historyBlock(M, M + statusH + G),
    team: historyBlock(M, ch - M - histH),
  };

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
  const voiceRowW = 2 * voiceBtn + voiceGap;
  let hand = null;
  let bottom;
  let voice;
  let hsi = null;

  if (!isSpectator) {
    const selfW = Math.max(blockW, hsiW, voiceRowW);
    const selfH = D + plateGap + plateH + 4 * s + hsiH + voiceGap + voiceBtn;
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
    const selfTop = Math.min(0.715 * ch, ch - M - selfH);
    const ay = selfTop + D / 2;
    seats.self = seatAt(selfX, ay, { frogSide: -1 });
    const hsiY = seats.self.plate.y + plateH + 4 * s;
    hsi = { rect: rect(q(selfX - hsiW / 2), q(hsiY), hsiW, hsiH), font: hsiFont };
    voice = { rect: rect(q(selfX - voiceRowW / 2), q(hsiY + hsiH + voiceGap), voiceRowW, voiceBtn), button: voiceBtn, gap: voiceGap };
    seats.self.hsi = hsi;
    seats.self.voice = voice;
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
  const tSlots = {
    self: { x: q(cx), y: q(cyT + offY) },
    partner: { x: q(cx), y: q(cyT - offY) },
    opponent1: { x: q(cx - offX), y: q(cyT) },
    opponent2: { x: q(cx + offX), y: q(cyT) },
  };
  for (const k of Object.keys(tSlots)) tSlots[k].rect = slotRect(tSlots[k].x, tSlots[k].y);

  // ---------- the side opponents (avatar outside, backs between it and the trick) ----------
  const sideY = cyT - (plateGap + plateH) / 2; // the avatar+plate block centred on the trick line, as today
  const sideFan = { long: fanLong, short: back.h };
  // the felt this pass wishes for (0: none; see FELT_WISHES), and the bid
  // sheet at full size inside it: the side seats make room where they can
  const feltInset = FELT.border + 8 * s;
  const bidFullW = BID_SHEET.w * s;
  const bidFullH = BID_SHEET.h * s;
  const feltHalfWant = felt > 0 ? Math.max(hx + 8 * s, (felt * FELT.wFrac * (cw + (logW || 0))) / 2, bidFullW / 2 + feltInset) : 0;
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
      y: q(cyT),
      axis: 'v',
      rotation: dir < 0 ? -Math.PI / 2 : Math.PI / 2,
      spacing: backSp,
      rect: around(q(cxCards), q(cyT), sideFan.short, sideFan.long),
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
    // today's proportions of the window, or room for the full bid sheet,
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

  // ---------- trump: top right, today's spot where it fits ----------
  const tCard = card.trump;
  const trumpBox = tCard.frame + 20 * s;
  const labelFont = Math.max(9, 14 * s);
  const labelAbove = trumpBox / 2 + 15 * s;
  const trumpTopReach = labelAbove + labelFont * 0.6;
  // (and clear of the partner's bubble at its first choice: right of the avatar, full width)
  const partnerBubble = bubbleRect(seats.partner, BUBBLE_DIRS.partner[0], bubbleBox.w);
  const partnerRight = Math.max(seats.partner.cards.rect.x + seats.partner.cards.rect.w, seats.partner.plate.x + plateW, partnerBubble.x + partnerBubble.w);
  const tx = clamp(cx + 0.26 * cw, Math.min(partnerRight + G + trumpBox / 2, cw - M - trumpBox / 2), cw - M - trumpBox / 2);
  const ty = Math.max(0.185 * ch, M + trumpTopReach);
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

  // ---------- bubbles: each seat's direction and width, clear of the game's information ----------
  const keep = [trump.rect, ...Object.values(tSlots).map((t) => t.rect), history.team.rect, history.opp.rect];
  if (hand) keep.push(hand.rect);
  const chosen = [];
  for (const key of ['partner', 'opp1', 'opp2', 'self']) {
    const seat = seats[key];
    const dirs = BUBBLE_DIRS[key];
    let pick = null;
    for (const f of BUBBLE_WIDTHS) {
      for (const dir of dirs) {
        const r = bubbleRect(seat, dir, bubbleBox.w * f);
        if (!contains(rect(0, 0, cw, ch), r)) continue;
        if (keep.some((o) => intersects(o, r)) || chosen.some((o) => intersects(o, r))) continue;
        pick = { dir, w: bubbleBox.w * f, rect: r };
        break;
      }
      if (pick) break;
    }
    // none fits: the first choice, and the overlap check sends the search to a smaller s
    if (!pick) pick = { dir: dirs[0], w: bubbleBox.w, rect: bubbleRect(seat, dirs[0], bubbleBox.w) };
    chosen.push(pick.rect);
    const a = bubbleAnchor(seat, pick.dir);
    seat.bubble = { dx: a.dx, dy: a.dy, x: seat.avatar.x + a.dx, y: seat.avatar.y + a.dy, tail: pick.dir, w: pick.w, rect: pick.rect };
  }
  const bubbles = { ...bubbleBox };

  // ---------- draw phase (no hand, no seats yet) ----------
  const deckCard = card.deck;
  const ov = Math.max(0.5, Math.min(17 * s, (cw - 2 * M - deckCard.w) / 53));
  const deckW = 53 * ov + deckCard.w;
  const deckY = ch / 2;
  const deckX0 = cx - deckW / 2 + deckCard.w / 2;
  const drawn = card.drawn;
  const nameMaxW = 160 * s;
  const drawSp = Math.min(200 * s, (cw - 2 * M - Math.max(drawn.w, nameMaxW)) / 3);
  const nameW = Math.max(drawn.w, Math.min(nameMaxW, drawSp - G));
  const drawSlotY = deckY - deckCard.h / 2 - G - 40 * s - drawn.h / 2;
  const nameFont = Math.max(10, 24 * s);
  const nameY = drawSlotY - drawn.h / 2 - G - nameFont * 0.6;
  const titleFont = Math.max(14, 48 * s);
  const titleY = Math.min(0.084 * ch, nameY - nameFont * 0.6 - G - titleFont * 0.6);
  const drawSlots = [0, 1, 2, 3].map((i) => ({ x: q(cx + (i - 1.5) * drawSp), y: q(drawSlotY) }));
  const draw = {
    deck: { x0: q(deckX0), y: q(deckY), overlap: ov, card: deckCard, rect: around(q(cx), q(deckY), deckW, deckCard.h), enterX: q(Math.min(cw - deckCard.w, cx + 0.26 * cw)) },
    slots: drawSlots,
    slotCard: drawn,
    slotRects: drawSlots.map((p) => around(p.x, p.y, drawn.w, drawn.h)),
    name: { dy: -(drawn.h / 2 + G + nameFont * 0.6), font: nameFont, rects: drawSlots.map((p) => around(p.x, p.y - (drawn.h / 2 + G + nameFont * 0.6), nameW, nameFont * 1.2)) },
    title: { x: q(cx), y: q(titleY), font: titleFont, rect: around(q(cx), q(titleY), Math.min(cw - 2 * M, 420 * s), titleFont * 1.2) },
  };

  // teams overlay (DrawManager): centred on the canvas
  const teams = { x: q(cx), y: q(ch / 2), dy: 50 * s, fonts: { label: Math.max(12, 32 * s), names: Math.max(11, 28 * s), vs: Math.max(10, 24 * s) } };

  // ---------- effects (transient: not part of the overlap checks) ----------
  const effects = {
    impact: { x: q(cx), y: q(cyT), scale: 1.2 * s },
    overTrump: { x: q(cx - 180 * s), y: q(cyT - 150 * s), scale: 0.9 * s },
    rainbow: {
      self: { x: seats.self.avatar.x + (isSpectator ? 112 * s : 33 * s), y: seats.self.avatar.y - (isSpectator ? 0 : 147 * s) },
      partner: { x: seats.partner.avatar.x + 112 * s, y: seats.partner.avatar.y },
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
    compact: !!compact,
    historyScale: k,
    degraded: false,
    margin: M,
    gap: G,
    logW,
    canvas: rect(0, 0, cw, ch),
    log,
    card,
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
    draw,
    teams,
    effects,
  };
}

/** The groups a bubble must leave visible (the game's information, and the other seats' bubbles). */
export const BUBBLE_KEEPS = ['trump', 'hand', 'trick:self', 'trick:partner', 'trick:opponent1', 'trick:opponent2',
  'history:team', 'history:opp', 'bubble:self', 'bubble:partner', 'bubble:opp1', 'bubble:opp2'];

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
    if (seat.cards) add(`${key}.cards`, g, seat.cards.rect);
    if (seat.hsi) add(`${key}.hsi`, g, seat.hsi.rect);
    if (seat.voice) add(`${key}.voice`, g, seat.voice.rect);
  }
  if (L.isSpectator) add('voice', 'voice', L.voice.rect);
  for (const [key, slot] of Object.entries(L.trick.slots)) add(`trick.${key}`, `trick:${key}`, slot.rect, ['zone', 'bidSheet']);
  add('trick.zone', 'zone', L.trick.zone, ['trick:self', 'trick:partner', 'trick:opponent1', 'trick:opponent2', 'bidSheet']);
  add('history.team', 'history:team', L.history.team.rect);
  add('history.opp', 'history:opp', L.history.opp.rect);
  if (L.hand) add('hand', 'hand', L.hand.rect);
  add('trump', 'trump', L.trump.rect);
  add('bidSheet', 'bidSheet', L.bidSheet.rect, ['zone', 'trick:self', 'trick:partner', 'trick:opponent1', 'trick:opponent2']);
  add('status', 'status', L.status.rect);
  if (L.log) add('log', 'log', L.log);
  for (const [key, seat] of Object.entries(L.seats)) add(`${key}.bubble`, `bubble:${key}`, seat.bubble.rect, [], BUBBLE_KEEPS);
  return out;
}

/** The draw phase's rects (the deck, the four drawn cards, their names, the title). */
export function drawRects(L) {
  const d = L.draw;
  return [
    { id: 'draw.title', group: 'title', rect: d.title.rect, allow: [] },
    { id: 'draw.deck', group: 'deck', rect: d.deck.rect, allow: [] },
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
 */
export function computeTableLayout({ w, h, dpr = 1, isSpectator = false, logW = 0 } = {}) {
  const cw = Math.max(1, Number(w) || 1);
  const ch = Math.max(1, Number(h) || 1);
  const d = dpr > 0 ? dpr : 1;
  const opts = { isSpectator: !!isSpectator, logW: logW || 0, dpr: d };
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
          // move out for it), at the same scale: s comes first
          for (const felt of FELT_WISHES) {
            if (felt === 0) return L;
            const F = place(cw, ch, s, { ...opts, compact, k, felt });
            if ((!roomyHand || handRoomy(F)) && clean(F)) return F;
          }
        }
      }
    }
  }
  const L = place(cw, ch, S_MIN, { ...opts, compact: true, k: HISTORY_SCALES[HISTORY_SCALES.length - 1] });
  L.degraded = true;
  return L;
}

/** The layout of a whole viewport: the log column (logWidthFor) comes off the right. */
export function layoutForViewport({ vw, vh, dpr = 1, isSpectator = false, withLog = true } = {}) {
  const logW = withLog ? logWidthFor(vw) : 0;
  return computeTableLayout({ w: vw - logW, h: vh, dpr, isSpectator, logW });
}

/** Hand card centres for n cards (left to right), spaced to fit the hand box. */
export function handPositions(L, n) {
  if (!L.hand || n <= 0) return [];
  const { rect: box, padX, spacing, card } = L.hand;
  const room = box.w - 2 * padX - card.w;
  const sp = n > 1 ? Math.min(spacing, room / (n - 1)) : 0;
  const total = (n - 1) * sp;
  const x0 = L.hand.cx - total / 2;
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * sp, y: L.hand.y }));
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
