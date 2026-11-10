/**
 * The table layout (roadmap item 17): one pure function places every
 * anchor, and at every viewport nothing overlaps and nothing leaves the
 * canvas. The checks are the solver's own (findIntersections /
 * findOutside), so these tests also say the search found a clean layout
 * (not a degraded one) everywhere in the range.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeTableLayout, layoutForViewport, layoutRects, drawRects, findIntersections, findOutside,
  logWidthFor, LOG_BREAKPOINTS, LOG_WIDTH_MAX, handPositions, fanPositions, historySlot, deckPosition,
  intersects, contains, BASE_SCALE, BID_SHEET, FELT, BUBBLE, BUBBLE_KEEPS,
} from './computeTableLayout.js';

const NAMED = [[1920, 1080], [1440, 790], [1280, 620], [1024, 668], [844, 390], [390, 844]];
const ROLES = [['player', false], ['spectator', true]];
const SEATS = ['self', 'partner', 'opp1', 'opp2'];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function checkClean(L, label) {
  expect(L.degraded, `${label}: degraded`).toBe(false);
  expect(findIntersections(L), `${label}: intersections`).toEqual([]);
  expect(findOutside(L), `${label}: outside the canvas`).toEqual([]);
}

const inset = (r, d) => ({ x: r.x + d, y: r.y + d, w: r.w - 2 * d, h: r.h - 2 * d });

/**
 * The felt holds the bid sheet (inside its border) and the four trick
 * slots; problems as strings (the sweep collects them).
 */
function feltProblems(L) {
  const out = [];
  const felt = L.trick.zone;
  if (!contains(inset(felt, FELT.border), L.bidSheet.rect)) out.push('bid sheet outside the felt');
  // (within a pixel: the felt and the slots snap to device pixels separately)
  for (const [k, t] of Object.entries(L.trick.slots)) if (!contains(felt, t.rect, 1)) out.push(`trick.${k} outside the felt`);
  return out;
}

/**
 * Each seat's bubble at its largest (the layout's width for the seat, the
 * full BUBBLE.lines of text and the tail) inside the canvas and clear of
 * the trump, my hand, the four trick slots, both histories and the other
 * seats' bubbles. Checked here from the rects themselves, not through the
 * solver's own group lists.
 */
function bubbleProblems(L) {
  const out = [];
  const B = L.bubbles;
  const keep = [['trump', L.trump.rect], ['history.team', L.history.team.rect], ['history.opp', L.history.opp.rect],
    ...Object.entries(L.trick.slots).map(([k, t]) => [`trick.${k}`, t.rect])];
  if (L.hand) keep.push(['hand', L.hand.rect]);
  const seen = [];
  for (const seat of SEATS) {
    const b = L.seats[seat].bubble;
    // the rect is the one CSS draws at most: width, 3 lines + padding, the tail
    const h = B.lines * B.lh + 2 * B.padY;
    const along = b.tail === 'down' ? [b.w, h + B.tail] : [b.w + B.tail, h];
    if (Math.abs(b.rect.w - along[0]) > 0.01 || Math.abs(b.rect.h - along[1]) > 0.01) out.push(`${seat} bubble rect is not its max size`);
    if (!contains(L.canvas, b.rect)) out.push(`${seat} bubble off the canvas`);
    for (const [id, r] of keep) if (intersects(b.rect, r)) out.push(`${seat} bubble covers ${id}`);
    for (const [other, r] of seen) if (intersects(b.rect, r)) out.push(`${seat} bubble covers ${other}'s`);
    seen.push([seat, b.rect]);
  }
  if (Math.hypot(L.seats.self.bubble.dx, L.seats.self.bubble.dy) > 80) out.push('self bubble beyond 80 px');
  return out;
}

describe('computeTableLayout at the named viewports', () => {
  for (const [vw, vh] of NAMED) {
    for (const [role, isSpectator] of ROLES) {
      it(`${vw}x${vh} ${role}: no intersections, all inside, bubbles and frogs by their avatars`, () => {
        const L = layoutForViewport({ vw, vh, isSpectator });
        const label = `${vw}x${vh} ${role}`;
        checkClean(L, label);
        expect(L.w + L.logW).toBe(vw);

        // the groups the roadmap lists are all in the check
        const ids = layoutRects(L).map((r) => r.id);
        for (const seat of SEATS) {
          expect(ids).toEqual(expect.arrayContaining([`${seat}.avatar`, `${seat}.plate`, `${seat}.dealer`]));
          if (seat !== 'self' || isSpectator) expect(ids).toContain(`${seat}.cards`);
        }
        expect(ids).toEqual(expect.arrayContaining(['trick.self', 'trick.partner', 'trick.opponent1', 'trick.opponent2',
          'history.team', 'history.opp', 'bidSheet', 'log', 'trump', 'status']));
        expect(ids.includes('hand')).toBe(!isSpectator);

        // the log is its own column, right of the canvas, inside the viewport
        expect(L.log.x).toBeGreaterThanOrEqual(L.w);
        expect(L.log.x + L.log.w).toBeLessThanOrEqual(vw);

        for (const seat of SEATS) {
          const s = L.seats[seat];
          // the bubble's anchor and the frog are the avatar's (ui-4, webclient-7)
          expect(dist(s.bubble, s.avatar), `${label} ${seat} bubble`).toBeLessThanOrEqual(80);
          expect(dist(s.dealer, s.avatar), `${label} ${seat} frog`).toBeLessThanOrEqual(80);
          expect(s.bubble.x).toBe(s.avatar.x + s.bubble.dx);
          expect(s.dealer.x).toBe(s.avatar.x + s.dealer.dx);
          expect(contains(L.canvas, { x: s.bubble.x, y: s.bubble.y, w: 0, h: 0 })).toBe(true);
        }

        // the felt holds the bid sheet and the trick; no bubble hides game information
        expect(feltProblems(L), `${label} felt`).toEqual([]);
        expect(bubbleProblems(L), `${label} bubbles`).toEqual([]);
        expect(L.bubbles.lines).toBe(BUBBLE.lines);

        // the trick slots never overlap each other
        const slots = Object.values(L.trick.slots).map((t) => t.rect);
        for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) expect(intersects(slots[i], slots[j])).toBe(false);

        // 13 hand cards, lifted, stay in the hand box
        if (L.hand) {
          for (const p of handPositions(L, 13)) {
            const card = { x: p.x - L.hand.card.w / 2, y: p.y - L.hand.card.h / 2 - L.hand.lift, w: L.hand.card.w, h: L.hand.card.h + L.hand.lift };
            expect(contains(L.hand.rect, card), `${label} hand card`).toBe(true);
          }
        }
        // a 13-card fan stays in its seat's card rect
        for (const seat of ['partner', 'opp1', 'opp2']) {
          const r = L.seats[seat].cards.rect;
          for (const p of fanPositions(L, seat, 13)) expect(contains(r, { x: p.x - 0.5, y: p.y - 0.5, w: 1, h: 1 })).toBe(true);
        }
        // the history's 13 slots stay in their blocks
        for (const side of ['team', 'opp']) {
          const h = L.history[side];
          for (let n = 1; n <= 13; n++) {
            const p = historySlot(L, side, n);
            expect(contains(h.rect, { x: p.x - h.slotW / 2, y: p.y - h.slotH / 2, w: h.slotW, h: h.slotH }), `${label} ${side} trick ${n}`).toBe(true);
          }
        }
      });
    }

    it(`${vw}x${vh} draw phase (no log yet): the deck, the four draws, their names and the title are apart and inside`, () => {
      const L = layoutForViewport({ vw, vh, withLog: false });
      expect(L.w).toBe(vw);
      expect(findIntersections(L, drawRects(L))).toEqual([]);
      expect(findOutside(L, drawRects(L))).toEqual([]);
      // every deck card's centre is on the deck row, inside the deck rect
      for (const i of [0, 26, 53]) {
        const p = deckPosition(L, i);
        expect(contains(L.draw.deck.rect, { x: p.x - 0.5, y: p.y - 0.5, w: 1, h: 1 })).toBe(true);
      }
    });
  }

  it('1920x1080 keeps today\'s table (the canvas is 1600 wide: the log takes 320)', () => {
    const L = layoutForViewport({ vw: 1920, vh: 1080 });
    expect(L.s).toBe(1);
    expect(L.w).toBe(1600);
    // today: opponents at centre -/+ 550 * 1600/1920, their backs at 425 * that,
    // the trump at (centre + 500*sx, centre - 300*sy), the felt 600x400 of 1920x953
    expect(L.seats.opp1.avatar.x).toBeCloseTo(800 - 458.3, 0);
    expect(L.seats.opp2.avatar.x).toBeCloseTo(800 + 458.3, 0);
    // (the backs sit a few px further out than today: the plate's 124 px reserve)
    expect(Math.abs(L.seats.opp1.cards.x - (800 - 354.2))).toBeLessThan(4);
    expect(Math.abs(L.seats.opp2.cards.x - (800 + 354.2))).toBeLessThan(4);
    expect(L.trump.x).toBeCloseTo(1216, 0);
    expect(L.trump.y).toBeCloseTo(200, 0);
    expect(L.trick.center).toEqual({ x: 800, y: 540 });
    // the felt: today's 600 x 400 of 1920 x 953 (it scaled with the window)
    expect(L.trick.zone.w).toBeCloseTo(600, 0);
    expect(L.trick.zone.h).toBeCloseTo(453.6, 0);
    expect(L.bidSheet.scale).toBe(1);
    // my box right of the hand (today x = 1250); the hand box 40% of the canvas
    expect(L.seats.self.avatar.x).toBeCloseTo(1250, 0);
    expect(L.hand.rect.w).toBeCloseTo(640, 0);
    // today's sprite scales and the 80 px avatars
    expect(L.card.hand.scale).toBe(1.5);
    expect(L.card.back.scale).toBe(1.2);
    expect(L.card.history.scale).toBe(1);
    expect(L.seats.partner.avatar.img).toBe(80);
  });
});

describe('computeTableLayout over a grid of sizes (800-2560 x 500-1440)', () => {
  it('is clean everywhere, for a player and a spectator', () => {
    const bad = [];
    let n = 0;
    for (let vw = 800; vw <= 2560; vw += 40) {
      for (let vh = 500; vh <= 1440; vh += 40) {
        for (const [, isSpectator] of ROLES) {
          const L = layoutForViewport({ vw, vh, isSpectator });
          n++;
          const hits = findIntersections(L);
          const out = findOutside(L);
          if (L.degraded || hits.length || out.length) bad.push({ vw, vh, isSpectator, degraded: L.degraded, hits, out });
          const more = [...feltProblems(L), ...bubbleProblems(L)];
          if (more.length) bad.push({ vw, vh, isSpectator, more });
          for (const seat of SEATS) {
            const s = L.seats[seat];
            if (dist(s.bubble, s.avatar) > 80 || dist(s.dealer, s.avatar) > 80) bad.push({ vw, vh, seat, far: true });
          }
        }
      }
    }
    expect(n).toBeGreaterThan(2000);
    expect(bad).toEqual([]);
  });

  it('phones too (360-760 x 360-900): no overlaps, the felt holds the bid sheet, no bubble hides the game', () => {
    const bad = [];
    for (let vw = 360; vw <= 760; vw += 40) {
      for (let vh = 360; vh <= 900; vh += 60) {
        for (const [, isSpectator] of ROLES) {
          const L = layoutForViewport({ vw, vh, isSpectator });
          const all = [...findIntersections(L).map((h) => h.join(' x ')), ...findOutside(L), ...feltProblems(L), ...bubbleProblems(L)];
          if (L.degraded || all.length) bad.push({ vw, vh, isSpectator, degraded: L.degraded, all });
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('the felt keeps today\'s proportions where the seats allow (0.3125 x 0.42 of the window), never less than 80%', () => {
    let short = 0;
    for (let vw = 800; vw <= 2560; vw += 80) {
      for (let vh = 500; vh <= 1440; vh += 80) {
        const L = layoutForViewport({ vw, vh });
        const ratio = L.trick.zone.w / (FELT.wFrac * vw);
        expect(ratio, `${vw}x${vh}`).toBeGreaterThanOrEqual(0.8 - 1e-9);
        if (ratio < 0.98) short++;
      }
    }
    expect(short).toBeLessThan(10);
  });

  it('every size scales uniformly: one s for every card, avatar and slot, never above 1', () => {
    for (const [vw, vh] of [...NAMED, [2560, 1440], [800, 500], [1700, 1300]]) {
      const L = layoutForViewport({ vw, vh });
      expect(L.s).toBeGreaterThan(0);
      expect(L.s).toBeLessThanOrEqual(1);
      for (const k of ['hand', 'trick', 'back', 'trump', 'deck', 'drawn']) expect(L.card[k].scale).toBeCloseTo(BASE_SCALE[k] * L.s, 6);
      expect(L.card.history.scale).toBeCloseTo(BASE_SCALE.history * L.s * L.historyScale, 6);
      expect(L.seats.opp1.avatar.img).toBeCloseTo(80 * L.s, 6);
      expect(L.history.team.slotW).toBeCloseTo(54 * L.s * L.historyScale, 6);
      // the history's slot and its spacing scale together (ui-6: 54 px slots on 37 px spacing)
      expect(L.history.team.spacing).toBeGreaterThan(L.history.team.slotW);
      expect(L.bidSheet.rect.w).toBeCloseTo(BID_SHEET.w * L.bidSheet.scale, 1);
    }
  });

  it('a phone gets a smaller table, never an overlapping one', () => {
    const big = layoutForViewport({ vw: 1920, vh: 1080 });
    for (const [vw, vh] of [[844, 390], [390, 844]]) {
      const L = layoutForViewport({ vw, vh });
      expect(L.s).toBeLessThan(big.s);
      checkClean(L, `${vw}x${vh}`);
    }
  });
});

describe('computeTableLayout contract', () => {
  it('is pure: the same input gives the same layout', () => {
    const a = computeTableLayout({ w: 1120, h: 790, dpr: 2, logW: 320 });
    const b = computeTableLayout({ w: 1120, h: 790, dpr: 2, logW: 320 });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('snaps anchors to device pixels', () => {
    const L = computeTableLayout({ w: 1123, h: 791, dpr: 2 });
    for (const seat of SEATS) {
      expect((L.seats[seat].avatar.x * 2) % 1).toBe(0);
      expect((L.seats[seat].avatar.y * 2) % 1).toBe(0);
    }
    for (const slot of Object.values(L.trick.slots)) expect((slot.x * 2) % 1).toBe(0);
  });

  it('1440x790: the felt is today\'s 450 px and holds the full-size bid sheet; the partner\'s bubble clears the trump', () => {
    for (const isSpectator of [false, true]) {
      const L = layoutForViewport({ vw: 1440, vh: 790, isSpectator });
      expect(L.s).toBe(1);
      expect(L.trick.zone.w).toBeCloseTo(450, 0);
      expect(L.trick.zone.h).toBeGreaterThanOrEqual(isSpectator ? 316 : 331);
      expect(contains(inset(L.trick.zone, FELT.border), L.bidSheet.rect)).toBe(true);
      if (!isSpectator) expect(L.bidSheet.scale).toBe(1);
      const p = L.seats.partner.bubble;
      expect(p.tail).toBe('left');
      expect(p.w).toBeCloseTo(L.bubbles.w, 6); // full width: the trump made room
      expect(intersects(p.rect, L.trump.rect)).toBe(false);
    }
  });

  it('a bubble that would cover the trump turns or narrows (never the trump: BUBBLE_KEEPS)', () => {
    expect(BUBBLE_KEEPS).toEqual(expect.arrayContaining(['trump', 'hand', 'history:team', 'history:opp',
      'trick:self', 'trick:partner', 'trick:opponent1', 'trick:opponent2']));
    const L = layoutForViewport({ vw: 1440, vh: 790 });
    const rects = layoutRects(L);
    const bubble = rects.find((r) => r.id === 'partner.bubble');
    expect(bubble.only).toEqual(BUBBLE_KEEPS);
    // moved onto the trump, the check reports it
    const onTrump = { ...bubble, rect: { ...L.trump.rect } };
    expect(findIntersections(L, [...rects.filter((r) => r.id !== 'partner.bubble'), onTrump]))
      .toEqual(expect.arrayContaining([expect.arrayContaining(['partner.bubble', 'trump'])]));
    // ...but over the felt, the bid sheet's corner or a seat it is fine
    const z = L.trick.zone;
    const b = L.bidSheet.rect;
    for (const r of [{ x: z.x + 1, y: z.y + 1, w: 12, h: 12 }, { x: b.x, y: b.y, w: 12, h: 12 }, L.seats.opp2.avatar.rect, L.seats.self.plate]) {
      expect(findIntersections(L, [...rects.filter((o) => o.id !== 'partner.bubble'), { ...bubble, rect: r }])).toEqual([]);
    }
  });

  it('the bid sheet may cover only the empty trick (it is up only while bidding)', () => {
    const L = layoutForViewport({ vw: 1440, vh: 790 });
    const sheet = layoutRects(L).find((r) => r.id === 'bidSheet');
    expect(sheet.allow.sort()).toEqual(['trick:opponent1', 'trick:opponent2', 'trick:partner', 'trick:self', 'zone']);
    // ...and it does sit over the trick
    expect(intersects(sheet.rect, L.trick.slots.self.rect) || intersects(sheet.rect, L.trick.slots.partner.rect)).toBe(true);
  });

  it('a pure spectator has a bottom seat with card backs and no hand; a player has my box, HSI and voice slot', () => {
    const spec = layoutForViewport({ vw: 1440, vh: 790, isSpectator: true });
    const seat = layoutForViewport({ vw: 1440, vh: 790 });
    expect(spec.hand).toBeNull();
    expect(spec.seats.self.cards).toBeTruthy();
    expect(spec.seats.self.avatar.x).toBe(spec.trick.center.x);
    expect(seat.hand).toBeTruthy();
    expect(seat.seats.self.cards).toBeUndefined();
    expect(contains(seat.seats.self.block, seat.seats.self.hsi.rect)).toBe(true);
    expect(contains(seat.seats.self.block, seat.voice.rect)).toBe(true);
    // a spectator's voice buttons sit in the table's corner, not under the log (ui-20)
    expect(contains(spec.canvas, spec.voice.rect)).toBe(true);
  });

  it('logWidthFor mirrors the --log-w breakpoints in styles.css (one source of the log column)', () => {
    const ROOT = existsSync(resolve(process.cwd(), 'client')) ? resolve(process.cwd(), 'client') : process.cwd();
    const css = readFileSync(resolve(ROOT, 'styles.css'), 'utf8');
    const rootDefault = css.match(/:root\s*{\s*--log-w:\s*(\d+)px;/);
    expect(Number(rootDefault[1])).toBe(LOG_WIDTH_MAX);
    const found = [...css.matchAll(/@media \(max-width: (\d+)px\) {\s*:root {\s*--log-w: (\d+)px;/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(found.sort((a, b) => a[0] - b[0])).toEqual(LOG_BREAKPOINTS);
    // no rule sizes the canvas or the log any other way (ui-8)
    expect(css).not.toMatch(/calc\(100vw - \d+px\)/);
    expect(css).not.toMatch(/80vw/);
    const components = readFileSync(resolve(ROOT, 'styles/components.css'), 'utf8');
    const chat = components.match(/\.chat-container {[^}]*}/)[0];
    expect(chat).not.toMatch(/min-width/);
    expect(chat).toMatch(/var\(--log-w/);
    for (const [max, w] of LOG_BREAKPOINTS) {
      expect(logWidthFor(max)).toBe(w);
    }
    expect(logWidthFor(1401)).toBe(LOG_WIDTH_MAX);
  });
});
