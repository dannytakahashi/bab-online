/**
 * Cut for a buck's ring (spec section 6, "Ring geometry"; the iOS CutRing
 * mirrors it): the players on an ellipse around the deck, pure and
 * unit-tested (ringLayout.test.js: n 2..20 at 360 / 768 / 1280 px, no
 * overlaps, in bounds, me at 6 o'clock).
 *
 *   - the players in participants order, rotated so I sit at 6 o'clock,
 *     then clockwise (ringOrder); positions never change during the cut
 *   - seats at equal arc length on the ellipse (its perimeter by
 *     Ramanujan's second formula, the arc itself sampled)
 *   - avatar d = clamp(0.45 x spacing, 32, 64), card w = clamp(0.42 x
 *     spacing, 30, maxCardW); when that would overlap (many players on a
 *     small stage) everything shrinks together until it fits: the ring is
 *     "compressed", never overlapping
 *   - the name under the avatar (as wide as the spacing allows); the cards
 *     on the inward ray, never rotated, with room for the older cards'
 *     offsets (STACK_OFFSET, up to 3; from 13 players a thin stack edge)
 *   - the deck in the middle, at least a 44 px target
 *
 * Every number is in CSS px of the stage box (0, 0 at its top left).
 */

export const CARD_RATIO = 435 / 300;
export const AVATAR_MIN = 32;
export const AVATAR_MAX = 64;
export const CARD_MIN = 30;
export const CARD_MAX = 72;
/** The deck's least size (a 44 px hit target). */
export const DECK_MIN = 44;
/** Older cards behind the newest, as a share of the card width (up to 12 players). */
export const STACK_OFFSET = 0.16;
/** From this many players the older cards are a thin stack edge (px each). */
export const DENSE_FROM = 13;
export const DENSE_EDGE = 3;
/** Older cards drawn per player; the rest are the "+n" chip. */
export const STACK_SHOWN = 3;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Ramanujan's second approximation of an ellipse's perimeter. */
export function ellipsePerimeter(a, b) {
  if (a <= 0 || b <= 0) return 4 * Math.max(a, b, 0);
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/**
 * The ring's order: `players` rotated so `me` comes first (6 o'clock),
 * then clockwise. A spectator (me not playing) keeps the order as is.
 */
export function ringOrder(players, me) {
  const list = Array.isArray(players) ? players.slice() : [];
  const i = me == null ? -1 : list.indexOf(me);
  return i <= 0 ? list : [...list.slice(i), ...list.slice(0, i)];
}

/**
 * Angles (screen radians: x = cx + rx cos t, y = cy + ry sin t, y down) of
 * n points at equal arc length, the first at the bottom (t = pi / 2), then
 * clockwise on screen (t increasing: bottom, left, top, right).
 */
export function equalArcAngles(rx, ry, n) {
  if (n <= 0) return [];
  const STEPS = 720;
  const start = Math.PI / 2;
  const cum = [0];
  let px = rx * Math.cos(start);
  let py = ry * Math.sin(start);
  for (let i = 1; i <= STEPS; i++) {
    const t = start + (2 * Math.PI * i) / STEPS;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    cum.push(cum[i - 1] + Math.hypot(x - px, y - py));
    px = x;
    py = y;
  }
  const total = cum[STEPS];
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / n;
    while (j < STEPS && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const f = (target - cum[j]) / seg;
    out.push(start + (2 * Math.PI * (j + f)) / STEPS);
  }
  return out;
}

/** Axis-aligned rects {x, y, w, h} (top left) overlap (touching edges do not). */
export function rectsOverlap(a, b, eps = 0.01) {
  return a.x + a.w - eps > b.x && b.x + b.w - eps > a.x && a.y + a.h - eps > b.y && b.y + b.h - eps > a.y;
}

/** The room the older cards take beside the newest (the stack's width). */
export function stackAllowance(n, cardW) {
  return n >= DENSE_FROM ? DENSE_EDGE * STACK_SHOWN : STACK_OFFSET * cardW * STACK_SHOWN;
}

/**
 * One try at a size factor f (1: the spec's clamps; below 1: compressed).
 * @returns the layout, with `ok` false when anything overlaps or spills
 */
export function solve({ w, h, n, nameH, maxCardW, f }) {
  const pad = 4;
  const gap = Math.max(3, 6 * f);
  let d = AVATAR_MAX * f;
  let cw = Math.min(maxCardW, CARD_MAX) * f;
  let nameW = Math.max(d, 64);
  let rx = 0;
  let ry = 0;
  let cx = w / 2;
  let cy = h / 2;
  let spacing = 0;
  for (let it = 0; it < 6; it++) {
    const padX = Math.max(d / 2, nameW / 2) + pad;
    const padTop = d / 2 + pad;
    const padBottom = d / 2 + 2 + nameH + pad;
    rx = Math.max(1, w / 2 - padX);
    ry = Math.max(1, (h - padTop - padBottom) / 2);
    // a ring, not a flat band: the long axis at most 1.7 x the short
    rx = Math.min(rx, ry * 1.7);
    ry = Math.min(ry, rx * 1.35);
    cx = w / 2;
    cy = padTop + (h - padTop - padBottom) / 2;
    spacing = ellipsePerimeter(rx, ry) / Math.max(1, n);
    d = clamp(0.45 * spacing, AVATAR_MIN, AVATAR_MAX) * f;
    cw = clamp(0.42 * spacing, CARD_MIN, Math.min(maxCardW, CARD_MAX)) * f;
    // names are truncated with an ellipsis: wide enough for about 9 letters
    nameW = Math.max(d, Math.min(spacing - 8, Math.max(d + 16, 76)));
  }
  const ch = cw * CARD_RATIO;
  const stackW = stackAllowance(n, cw);
  const angles = equalArcAngles(rx, ry, n);
  const seats = angles.map((t, order) => {
    const x = cx + rx * Math.cos(t);
    const y = cy + ry * Math.sin(t);
    let ux = cx - x;
    let uy = cy - y;
    const len = Math.hypot(ux, uy) || 1;
    ux /= len;
    uy /= len;
    const avatar = { x: x - d / 2, y: y - d / 2, w: d, h: d };
    const name = { x: x - nameW / 2, y: y + d / 2 + 2, w: nameW, h: nameH };
    // the stack's rect (the older cards to the newest card's left) centred at (px, py)
    const stackAt = (px, py) => ({ x: px - (cw + stackW) / 2, y: py - ch / 2, w: cw + stackW, h: ch });
    // out along the inward ray until it clears the seat's own avatar and
    // name by `gap` (a grown copy of both)
    const grow = (r) => ({ x: r.x - gap, y: r.y - gap, w: r.w + 2 * gap, h: r.h + 2 * gap });
    const own = [grow(avatar), grow(name)];
    let dist = 0;
    while (dist < len && own.some((r) => rectsOverlap(stackAt(x + ux * dist, y + uy * dist), r))) dist += 1;
    const cardCx = x + ux * dist;
    const cardCy = y + uy * dist;
    const stack = stackAt(cardCx, cardCy);
    return {
      order,
      angle: t,
      x,
      y,
      avatar,
      name,
      // the newest card's rect; the older ones sit to its left (stackW)
      card: { x: stack.x + stackW, y: stack.y, w: cw, h: ch },
      stack,
    };
  });

  // the deck: the biggest box near the centre that touches no card and no
  // seat (a fan is wider than tall: 2 : 1, down to square when that gives
  // more room), centred across and moved up or down to where there is room
  const blockers = seats.flatMap((s) => [s.stack, s.avatar, s.name]);
  const fits = (box) => !blockers.some((b) => rectsOverlap(box, b));
  const cap = Math.max(DECK_MIN, ch * 2.1);
  let deck = { x: cx, y: cy, w: 0, h: 0 };
  const shifts = [0];
  for (let k = 1; k <= 8; k++) shifts.push((k / 8) * ry * 0.45, -(k / 8) * ry * 0.45);
  for (const dy of shifts) {
    for (const aspect of [2, 1.7, 1.35, 1]) {
      const boxAt = (k) => ({ x: cx - (aspect * k) / 2, y: cy + dy - k / 2, w: aspect * k, h: k });
      let lo = 0;
      let hi = Math.min(rx, ry) * 2;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if (fits(boxAt(mid))) lo = mid; else hi = mid;
      }
      // at most about twice a card's height: a big stage keeps a modest deck
      const box = boxAt(Math.min(lo, cap));
      // the centre wins a tie; a shifted box must be clearly bigger
      const better = box.w * box.h > deck.w * deck.h * (dy === 0 ? 1 : 1.15) + 0.5;
      if (box.h >= DECK_MIN - 0.01 && better) deck = box;
    }
    if (deck.h >= cap - 0.01) break;
  }
  if (deck.w === 0) deck = { x: cx - DECK_MIN / 2, y: cy - DECK_MIN / 2, w: 0, h: 0 };

  let why = deck.h >= DECK_MIN - 0.01 && deck.w >= DECK_MIN - 0.01 ? null : 'deck';
  const inBounds = (r) => r.x >= -0.01 && r.y >= -0.01 && r.x + r.w <= w + 0.01 && r.y + r.h <= h + 0.01;
  for (let i = 0; !why && i < seats.length; i++) {
    const a = seats[i];
    if (!inBounds(a.avatar) || !inBounds(a.name) || !inBounds(a.stack)) why = `bounds ${i}`;
    else if (rectsOverlap(a.stack, a.avatar) || rectsOverlap(a.stack, a.name)) why = `own ${i}`;
    for (let j = i + 1; !why && j < seats.length; j++) {
      const b = seats[j];
      if (rectsOverlap(a.avatar, b.avatar) || rectsOverlap(a.avatar, b.name) || rectsOverlap(a.name, b.avatar) || rectsOverlap(a.name, b.name)) why = `seats ${i} ${j}`;
      else if (rectsOverlap(a.stack, b.stack)) why = `cards ${i} ${j}`;
      else if (rectsOverlap(a.stack, b.avatar) || rectsOverlap(a.stack, b.name) || rectsOverlap(b.stack, a.avatar) || rectsOverlap(b.stack, a.name)) why = `card-seat ${i} ${j}`;
    }
  }
  const ok = !why;
  return { ok, why, w, h, n, f, cx, cy, rx, ry, spacing, avatarD: d, cardW: cw, cardH: ch, nameW, nameH, stackW, dense: n >= DENSE_FROM, seats, deck };
}

/**
 * The ring for n players on a w x h stage.
 *
 * @param {Object} o
 * @param {number} o.w - stage width (CSS px)
 * @param {number} o.h - stage height
 * @param {number} o.n - players (2..20 drawn as a ring; more still lay out, smaller)
 * @param {number} [o.meIndex] - kept for the iOS signature: the caller rotates
 *   the players with ringOrder, so seat 0 (6 o'clock) is always me
 * @param {number} [o.nameH] - the name line's height (px)
 * @param {number} [o.maxCardW] - the card width cap
 * @returns {{ok, cx, cy, rx, ry, avatarD, cardW, cardH, nameW, nameH, stackW, dense, seats: Array, deck}}
 *   seats[k] is ring position k (0: 6 o'clock, then clockwise)
 */
export function ringLayout({ w, h, n, meIndex = 0, nameH = 16, maxCardW: cardCap = CARD_MAX } = {}) {
  let maxCardW = cardCap;
  void meIndex;
  const count = Math.max(0, Math.floor(n || 0));
  const W = Math.max(1, w || 0);
  const H = Math.max(1, h || 0);
  // the cards stay in proportion to the stage (a narrow stage keeps its
  // avatars big rather than shrinking everything for one big card)
  maxCardW = Math.min(maxCardW, Math.max(CARD_MIN, Math.min(W, H) * 0.14));
  let best = solve({ w: W, h: H, n: count, nameH, maxCardW, f: 1 });
  if (best.ok || count === 0) return best;
  // shrink together until it fits: the largest size factor that does (a
  // scan, not a bisection: the deck's floor makes "fits" not monotonic)
  let found = null;
  for (let f = 0.975; f >= 0.2 && !found; f -= 0.025) {
    const tryIt = solve({ w: W, h: H, n: count, nameH: Math.max(11, Math.round(nameH * Math.min(1, f + 0.2))), maxCardW, f });
    if (tryIt.ok) found = tryIt;
  }
  best = found || solve({ w: W, h: H, n: count, nameH: 11, maxCardW, f: 0.2 });
  return best;
}
