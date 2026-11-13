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
  intersects, contains, BASE_SCALE, BID_SHEET, FELT, BUBBLE, BUBBLE_KEEPS, SPECTATOR_BADGE, badgeBubbleKeeps,
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
function bubbleProblems(L, { ownBacks = true } = {}) {
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
  // a pure spectator's bottom seat has its backs above its avatar: its
  // bubble goes beside them, not over them (it used to hide the whole fan)
  if (ownBacks && L.isSpectator && intersects(L.seats.self.bubble.rect, L.seats.self.cards.rect)) out.push('bottom bubble covers its own backs');
  if (Math.hypot(L.seats.self.bubble.dx, L.seats.self.bubble.dy) > 80) out.push('self bubble beyond 80 px');
  return out;
}

/**
 * The spectator badge (eye + count) in the table's bottom-right area: on the
 * canvas, off the felt, clear of the hand, the trick slots, the histories,
 * every seat (my box: avatar, plate, frog, HSI), the voice buttons, the
 * trump, the status pill, the bid sheet and every bubble at its largest.
 * Checked from the rects themselves, not the solver's groups.
 */
function badgeProblems(L) {
  const out = [];
  const b = L.spectators?.rect;
  if (!b) return ['no spectator badge'];
  if (!contains(L.canvas, b)) out.push('badge off the canvas');
  const keep = [['felt', L.trick.zone], ['trump', L.trump.rect], ['bidSheet', L.bidSheet.rect], ['status', L.status.rect],
    ['voice', L.voice.rect], ['history.team', L.history.team.rect], ['history.opp', L.history.opp.rect],
    ...Object.entries(L.trick.slots).map(([k, t]) => [`trick.${k}`, t.rect])];
  if (L.hand) keep.push(['hand', L.hand.rect]);
  for (const seat of SEATS) {
    const st = L.seats[seat];
    keep.push([`${seat}.avatar`, st.avatar.rect], [`${seat}.plate`, st.plate], [`${seat}.dealer`, st.dealer.rect], [`${seat}.bubble`, st.bubble.rect]);
    if (st.cards) keep.push([`${seat}.cards`, st.cards.rect]);
    if (st.hsi) keep.push([`${seat}.hsi`, st.hsi.rect]);
  }
  for (const [id, r] of keep) if (intersects(b, r)) out.push(`badge covers ${id}`);
  // the bottom-right quarter of the table, at the voice buttons' height
  if (b.x + b.w / 2 < L.w / 2 || b.y + b.h / 2 < L.h / 2) out.push('badge not in the bottom right');
  if (Math.abs(b.h - L.voice.button) > 0.01 || Math.abs(b.w - SPECTATOR_BADGE.wPerH * L.voice.button) > 0.01) out.push('badge size');
  return out;
}

/**
 * The spectator badge's chat bubble (a spectator's "Zach: hello") at its
 * largest (the spot's width, 3 lines, the tail): on the canvas, its tail at
 * the badge's middle, clear of the hand, the trump, the trick slots, both
 * histories, the status pill, the bid sheet, the voice buttons, the badge,
 * every seat's bubble at its largest and, for a player, my box (avatar,
 * plate, frog, HSI). Checked from the rects themselves. No spot (null) is
 * not a problem here: the callers say where that is allowed.
 */
function badgeBubbleProblems(L) {
  const bb = L.spectators.bubble;
  if (!bb) return [];
  const out = [];
  const B = L.bubbles;
  const badge = L.spectators.rect;
  const h = B.lines * B.lh + 2 * B.padY;
  const size = bb.tail === 'down' ? [bb.w, h + B.tail] : [bb.w + B.tail, h];
  if (Math.abs(bb.rect.w - size[0]) > 0.01 || Math.abs(bb.rect.h - size[1]) > 0.01) out.push('badge bubble rect is not its max size');
  if (!contains(L.canvas, bb.rect)) out.push('badge bubble off the canvas');
  if (bb.w + 0.01 < B.w * 0.6) out.push('badge bubble narrower than the BUBBLE_WIDTHS steps');
  const keep = [['trump', L.trump.rect], ['history.team', L.history.team.rect], ['history.opp', L.history.opp.rect],
    ['status', L.status.rect], ['bidSheet', L.bidSheet.rect], ['voice', L.voice.rect], ['badge', badge],
    ...Object.entries(L.trick.slots).map(([k, t]) => [`trick.${k}`, t.rect]),
    ...SEATS.map((k) => [`${k}.bubble`, L.seats[k].bubble.rect])];
  if (L.hand) keep.push(['hand', L.hand.rect]);
  if (!L.isSpectator) {
    const me = L.seats.self;
    keep.push(['self.avatar', me.avatar.rect], ['self.plate', me.plate], ['self.dealer', me.dealer.rect], ['self.hsi', me.hsi.rect]);
  }
  for (const [id, r] of keep) if (intersects(bb.rect, r)) out.push(`badge bubble covers ${id}`);
  // the tail at the badge's middle, on the bubble (clear of its rounded ends), next to the badge
  const half = 8;
  if (bb.tail === 'down') {
    const tx = bb.align === 'end' ? bb.x - bb.tailOffset - half : bb.x + bb.tailOffset + half;
    if (Math.abs(tx - (badge.x + badge.w / 2)) > 0.02) out.push('badge bubble tail not at the badge');
    if (tx - half < bb.rect.x + 10 || tx + half > bb.rect.x + bb.rect.w - 10) out.push('badge bubble tail off the bubble');
    if (Math.abs((bb.align === 'end' ? bb.rect.x + bb.rect.w : bb.rect.x) - bb.x) > 0.02) out.push('badge bubble not hung from its edge');
    const below = bb.rect.y + bb.rect.h;
    if (below > badge.y + 0.01 || badge.y - below > 4 * L.s + 0.01) out.push('badge bubble not just above the badge');
    if (bb.minW > bb.w || bb.minW < bb.tailOffset + 2 * half) out.push('badge bubble min width');
  } else {
    const ty = bb.y - bb.tailOffset - half;
    if (Math.abs(ty - (badge.y + badge.h / 2)) > 0.02) out.push('badge bubble tail not at the badge');
    if (Math.abs(bb.y - (badge.y + badge.h)) > 0.02) out.push('badge bubble not bottom-aligned with the badge');
    const side = bb.tail === 'right' ? badge.x - (bb.rect.x + bb.rect.w) : bb.rect.x - (badge.x + badge.w);
    if (side < -0.01 || side > 4 * L.s + 0.01) out.push('badge bubble not just beside the badge');
    if (bb.minH > h || bb.minH < bb.tailOffset + 2 * half) out.push('badge bubble min height');
  }
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
          'history.team', 'history.opp', 'bidSheet', 'log', 'trump', 'status', 'spectators']));
        expect(badgeProblems(L), `${label} spectator badge`).toEqual([]);
        // a spectator's chat by the badge: a spot at every named viewport, in the overlap check
        expect(L.spectators.bubble, `${label} badge bubble`).toBeTruthy();
        expect(ids).toContain('spectators.bubble');
        expect(badgeBubbleProblems(L), `${label} badge bubble`).toEqual([]);
        // (it may cover another seat, as the seats' bubbles may; here it covers none)
        for (const seat of SEATS) {
          const st = L.seats[seat];
          for (const r of [st.avatar.rect, st.plate, st.dealer.rect, st.cards?.rect, st.hsi?.rect].filter(Boolean)) {
            expect(intersects(L.spectators.bubble.rect, r), `${label} badge bubble over ${seat}`).toBe(false);
          }
        }
        if (isSpectator && vw === 390) {
          // a phone's 260 px canvas: the bottom seat's bubble needs the
          // corner beside its backs, so the badge sits up the right edge
          expect(L.spectators.rect.x + L.spectators.rect.w).toBeCloseTo(L.w - L.margin, 0);
          expect(L.spectators.rect.y).toBeLessThan(L.voice.rect.y);
        } else if (isSpectator) {
          // beside the corner's voice buttons, on their row
          expect(L.spectators.rect.y).toBe(L.voice.rect.y);
          expect(L.spectators.rect.x + L.spectators.rect.w).toBeLessThanOrEqual(L.voice.rect.x);
        } else if (vw === 390) {
          // a phone's 260 px canvas: my box fills the corner's column, so the
          // badge goes a row up the right edge where its bubble has room
          expect(L.spectators.rect.x + L.spectators.rect.w).toBeCloseTo(L.w - L.margin, 0);
          expect(L.spectators.rect.y + L.spectators.rect.h).toBeLessThan(L.h - L.margin);
        } else {
          // the table's bottom-right corner, its bubble opening upward from it
          expect(L.spectators.rect.x + L.spectators.rect.w).toBeCloseTo(L.w - L.margin, 0);
          expect(L.spectators.rect.y + L.spectators.rect.h).toBeCloseTo(L.h - L.margin, 0);
          expect(L.spectators.bubble.tail).toBe('down');
        }
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
    // (all fractions of the canvas: scene.scale is the window less the log)
    expect(L.seats.opp1.avatar.x).toBeCloseTo(800 - 458.3, 0);
    expect(L.seats.opp2.avatar.x).toBeCloseTo(800 + 458.3, 0);
    // (the backs sit a few px further out than today: the plate's 124 px reserve)
    expect(Math.abs(L.seats.opp1.cards.x - (800 - 354.2))).toBeLessThan(4);
    expect(Math.abs(L.seats.opp2.cards.x - (800 + 354.2))).toBeLessThan(4);
    expect(L.trump.x).toBeCloseTo(1216, 0);
    expect(L.trump.y).toBeCloseTo(200, 0);
    expect(L.trick.center).toEqual({ x: 800, y: 540 });
    // the felt: today's 600 x 400 of 1920 x 953, scaled by the canvas: 500 wide
    expect(L.trick.zone.w).toBeCloseTo(500, 0);
    expect(L.trick.zone.h).toBeCloseTo(453.6, 0);
    expect(L.bidSheet.scale).toBe(1);
    // my box right of the hand (today x = 1250); the hand box 40% of the canvas
    expect(L.seats.self.avatar.x).toBeCloseTo(1250, 0);
    expect(L.hand.rect.w).toBeCloseTo(640, 0);
    // today's card sizes (design scales 1.5 / 1.2 / 1; item 18a: the
    // hi-res face is 62 px tall at design 1, as the old card) and the 80 px avatars
    expect([L.card.hand.design, L.card.back.design, L.card.history.design]).toEqual([1.5, 1.2, 1]);
    // (93 px at design 1.5, to the frame's even 92 device px: 1:1 and whole-pixel edges)
    expect(L.card.hand.h).toBe(92);
    expect(L.card.hand.w).toBe(64);
    // at DPR 1 the hand card samples its atlas frame 1:1
    expect(L.cardTexture).toMatchObject({ w: 64, h: 92, dpr: 1 });
    expect(L.card.hand.scale).toBe(1);
    expect(L.seats.partner.avatar.img).toBe(80);
  });
});

describe('the trick histories keep today\'s insets', () => {
  it('1920x1080: my team\'s block as far from the bottom as the opponents\' from the top (row 2 centred 95 px up)', () => {
    for (const isSpectator of [false, true]) {
      const L = layoutForViewport({ vw: 1920, vh: 1080, isSpectator });
      expect(L.history.opp.slots[0].y).toBeCloseTo(95, 0);
      expect(L.history.team.slots[0].y).toBeCloseTo(1080 - 95 - 86, 0);
      expect(L.history.team.slots[7].y).toBeCloseTo(1080 - 95, 0);
    }
  });

  it('the inset is a wish: where the table needs the room the block sits on the bottom margin, never off the canvas', () => {
    let inset = 0;
    let n = 0;
    for (let vw = 800; vw <= 2560; vw += 80) {
      for (let vh = 500; vh <= 1440; vh += 80) {
        const L = layoutForViewport({ vw, vh });
        const gapBelow = L.h - (L.history.team.rect.y + L.history.team.rect.h);
        n++;
        if (Math.abs(gapBelow - Math.max(L.margin, 53 * L.s)) < 0.51) inset++;
        else expect(gapBelow, `${vw}x${vh}`).toBeCloseTo(L.margin, 0);
      }
    }
    expect(inset).toBeGreaterThan(n * 0.9);
  });
});

/**
 * The draw for deal is iOS DrawPhaseView's column (PR 239): title, rule,
 * four slots (avatar, name, a Theme s3 gap, the card), the deck and its
 * prompt, centred on the canvas, its type and spacing the tokens at s.
 */
describe('the draw for deal (iOS DrawPhaseView\'s column)', () => {
  const bottom = (r) => r.y + r.h;
  const column = (d) => [['title', d.title.rect], ['rules', d.rules.rect], ['avatar', d.avatar.rects[0]],
    ['name', d.name.rects[0]], ['card', d.slotRects[0]], ['deck', d.deck.rect], ['prompt', d.prompt.rect]];

  it('1440x900 (s = 1): the tokens (title xxl, rule md, a 40 px avatar), the hand card, centred, the gaps at their tokens', () => {
    const L = layoutForViewport({ vw: 1440, vh: 900, withLog: false });
    const d = L.draw;
    expect(L.s).toBe(1);
    expect([d.title.font, d.rules.font, d.name.font, d.prompt.font, d.avatar.size]).toEqual([32, 16, 16, 20, 40]);
    // a drawn card is the hand card (its frame 1:1, like the hand)
    expect([d.slotCard.w, d.slotCard.h, d.slotCard.scale]).toEqual([L.card.hand.w, L.card.hand.h, L.card.hand.scale]);
    // the slots one pitch apart about the centre, the cards on one row
    expect(d.slots.map((p) => p.x)).toEqual([720 - 1.5 * d.pitch, 720 - 0.5 * d.pitch, 720 + 0.5 * d.pitch, 720 + 1.5 * d.pitch]);
    expect(new Set(d.slots.map((p) => p.y)).size).toBe(1);
    // the gaps: s2 title-rule, s8 rule-avatars, s2 avatar-name, s3 name-card, s10 cards-deck, s4 deck-prompt
    // (a card row's centre snaps down to a device pixel: a gap above it grows by less than one)
    const gaps = column(d).slice(1).map(([, r], i) => r.y - bottom(column(d)[i][1]));
    [8, 32, 8, 12, 40, 16].forEach((token, i) => {
      expect(gaps[i], `gap ${i}`).toBeGreaterThanOrEqual(token - 0.01);
      expect(gaps[i], `gap ${i}`).toBeLessThan(token + 1);
    });
    // the cards' centres on device pixels (the hand card samples 1:1)
    expect(Number.isInteger(d.slots[0].y) && Number.isInteger(d.deck.y)).toBe(true);
    // centred: as much room above the title as below the prompt (the snap's 2 px aside)
    expect(Math.abs(d.title.rect.y - (L.h - bottom(d.prompt.rect)))).toBeLessThan(3.01);
  });

  it('at every size: one column top to bottom, each name s3 (or 4 px) above its card, every card on one row, nothing overlapping or outside', () => {
    for (let vw = 800; vw <= 2560; vw += 80) {
      for (let vh = 500; vh <= 1440; vh += 80) {
        const L = layoutForViewport({ vw, vh, withLog: false });
        const d = L.draw;
        const label = `${vw}x${vh}`;
        const col = column(d);
        for (let i = 1; i < col.length; i++) {
          expect(col[i][1].y, `${label}: ${col[i][0]} below ${col[i - 1][0]}`).toBeGreaterThanOrEqual(bottom(col[i - 1][1]) - 0.01);
        }
        for (let i = 0; i < 4; i++) {
          expect(d.slotRects[i].y - bottom(d.name.rects[i]), `${label}: name ${i} to its card`).toBeGreaterThanOrEqual(Math.max(4, 12 * L.s) - 0.01);
          expect(d.slotRects[i].y, `${label}: card ${i} level`).toBe(d.slotRects[0].y);
          expect(d.name.rects[i].w, `${label}: a name at least its card wide`).toBeGreaterThanOrEqual(d.slotCard.w - 0.01);
        }
        expect(findIntersections(L, drawRects(L)), label).toEqual([]);
        expect(findOutside(L, drawRects(L)), label).toEqual([]);
      }
    }
  });

  it('the rule wraps (and its box grows) only where one line does not fit', () => {
    const wide = layoutForViewport({ vw: 1440, vh: 900, withLog: false }).draw.rules;
    const phone = layoutForViewport({ vw: 390, vh: 844, withLog: false });
    expect(wide.lines).toBe(1);
    expect(phone.draw.rules.rect.w).toBeLessThanOrEqual(phone.w - 2 * phone.margin + 0.01);
    expect(phone.draw.rules.rect.h).toBeCloseTo(phone.draw.rules.lines * phone.draw.rules.font * 1.35, 6);
  });
});

describe('computeTableLayout over a grid of sizes (800-2560 x 500-1440)', () => {
  it('is clean everywhere, for a player and a spectator', () => {
    const bad = [];
    const noBadgeBubble = [];
    let n = 0;
    for (let vw = 800; vw <= 2560; vw += 40) {
      for (let vh = 500; vh <= 1440; vh += 40) {
        for (const [, isSpectator] of ROLES) {
          const L = layoutForViewport({ vw, vh, isSpectator });
          n++;
          const hits = findIntersections(L);
          const out = findOutside(L);
          if (L.degraded || hits.length || out.length) bad.push({ vw, vh, isSpectator, degraded: L.degraded, hits, out });
          const more = [...feltProblems(L), ...bubbleProblems(L), ...badgeProblems(L), ...badgeBubbleProblems(L)];
          if (more.length) bad.push({ vw, vh, isSpectator, more });
          if (!L.spectators.bubble) noBadgeBubble.push(`${vw}x${vh} ${isSpectator ? 'spectator' : 'player'}`);
          for (const seat of SEATS) {
            const s = L.seats[seat];
            if (dist(s.bubble, s.avatar) > 80 || dist(s.dealer, s.avatar) > 80) bad.push({ vw, vh, seat, far: true });
          }
        }
      }
    }
    expect(n).toBeGreaterThan(2000);
    expect(bad).toEqual([]);
    // the badge's bubble has a spot everywhere but one squat window (a
    // 500 px tall canvas: my box and my bubble fill the corner's column),
    // where a spectator's message is only in the log
    expect(noBadgeBubble).toEqual(['880x500 player']);
  });

  it('phones too (360-760 x 360-900): no overlaps, the felt holds the bid sheet, no bubble hides the game', () => {
    const bad = [];
    for (let vw = 360; vw <= 760; vw += 40) {
      for (let vh = 360; vh <= 900; vh += 60) {
        for (const [, isSpectator] of ROLES) {
          const L = layoutForViewport({ vw, vh, isSpectator });
          // (below 390 x 480 a spectator's bottom bubble has nowhere beside its backs: it may cover them while up)
          const all = [...findIntersections(L).map((h) => h.join(' x ')), ...findOutside(L), ...feltProblems(L), ...bubbleProblems(L, { ownBacks: vw >= 390 || vh >= 480 }),
            ...badgeProblems(L).filter((p) => p !== 'badge not in the bottom right'), ...badgeBubbleProblems(L)];
          if (L.degraded || all.length) bad.push({ vw, vh, isSpectator, degraded: L.degraded, all });
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('the felt keeps today\'s proportions where the seats allow (0.3125 x 0.42 of the canvas), never less than 80%', () => {
    let short = 0;
    for (let vw = 800; vw <= 2560; vw += 80) {
      for (let vh = 500; vh <= 1440; vh += 80) {
        const L = layoutForViewport({ vw, vh });
        const ratio = L.trick.zone.w / (FELT.wFrac * L.w);
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
      for (const k of ['hand', 'trick', 'back', 'trump', 'deck', 'drawn']) expect(L.card[k].design).toBeCloseTo(BASE_SCALE[k] * L.s, 6);
      expect(L.card.history.design).toBeCloseTo(BASE_SCALE.history * L.s * L.historyScale, 6);
      // one atlas frame for every card: a sprite's scale times the frame is its on-screen size
      for (const k of Object.keys(L.card)) {
        expect(L.card[k].scale * L.cardTexture.h).toBeCloseTo(L.card[k].h, 6);
        expect(L.card[k].scale * L.cardTexture.w).toBeCloseTo(L.card[k].w, 6);
        if (L.card[k].design === L.card.hand.design) {
          // the hand's size: the frame 1:1 (the design height in whole, even device px)
          expect(L.card[k].h * L.dpr).toBeCloseTo(L.cardTexture.h, 6);
          expect(L.cardTexture.h % 2).toBe(0);
          expect(Math.abs(L.card[k].h - 62 * L.card[k].design)).toBeLessThanOrEqual(1 / L.dpr + 1e-9);
        } else {
          expect(L.card[k].h).toBeCloseTo(62 * L.card[k].design, 6);
        }
      }
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

  it('1440x790: the felt is today\'s 350 px and holds the full-size bid sheet; the partner\'s bubble clears the trump', () => {
    for (const isSpectator of [false, true]) {
      const L = layoutForViewport({ vw: 1440, vh: 790, isSpectator });
      expect(L.s).toBe(1);
      // 0.3125 of the 1120 px canvas, as today; the side seats at today's spots
      expect(L.trick.zone.w).toBeCloseTo(350, 0);
      expect(Math.abs(L.seats.opp1.avatar.x - (560 - 550 * 1120 / 1920))).toBeLessThan(8);
      expect(Math.abs(L.seats.opp2.avatar.x - (560 + 550 * 1120 / 1920))).toBeLessThan(8);
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
      'trick:self', 'trick:partner', 'trick:opponent1', 'trick:opponent2', 'spectators']));
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

  it('the badge\'s bubble is in the same check: it may cover the felt and the other seats, never the game, my box, the voice buttons, the pill, the bid sheet or a bubble', () => {
    expect(BUBBLE_KEEPS).toContain('bubble:spectators');
    expect(badgeBubbleKeeps(false)).toEqual(expect.arrayContaining([...BUBBLE_KEEPS, 'status', 'bidSheet', 'voice', 'seat:self']));
    expect(badgeBubbleKeeps(true)).not.toContain('seat:self');
    for (const [, isSpectator] of ROLES) {
      const L = layoutForViewport({ vw: 1440, vh: 790, isSpectator });
      const rects = layoutRects(L);
      const bb = rects.find((r) => r.id === 'spectators.bubble');
      expect(bb.only).toEqual(badgeBubbleKeeps(isSpectator));
      const others = rects.filter((r) => r.id !== 'spectators.bubble');
      const at = (r) => findIntersections(L, [...others, { ...bb, rect: { ...r } }]).filter((h) => h.includes('spectators.bubble'));
      const must = [['trump', L.trump.rect], ['status', L.status.rect], ['bidSheet', L.bidSheet.rect], ['history.team', L.history.team.rect],
        ['trick.self', L.trick.slots.self.rect], ['self.bubble', L.seats.self.bubble.rect], ['partner.bubble', L.seats.partner.bubble.rect], ['spectators', L.spectators.rect]];
      if (isSpectator) must.push(['voice', L.voice.rect]);
      else must.push(['hand', L.hand.rect], ['self.avatar', L.seats.self.avatar.rect], ['self.hsi', L.seats.self.hsi.rect], ['self.voice', L.voice.rect]);
      for (const [id, r] of must) expect(at(r).map((h) => h.find((x) => x !== 'spectators.bubble')), id).toContain(id);
      // ...a seat's bubble moved onto it is caught from the other side too
      const sb = rects.find((r) => r.id === 'opp2.bubble');
      expect(findIntersections(L, [...rects.filter((r) => r.id !== 'opp2.bubble'), { ...sb, rect: { ...bb.rect } }]))
        .toEqual(expect.arrayContaining([expect.arrayContaining(['opp2.bubble', 'spectators.bubble'])]));
      // but the felt and another seat are fine
      const z = L.trick.zone;
      expect(at({ x: z.x + 1, y: z.y + 1, w: 8, h: 8 })).toEqual([]);
      expect(at(L.seats.opp1.avatar.rect)).toEqual([]);
    }
  });

  it('the badge\'s bubble narrows on a small canvas (the BUBBLE_WIDTHS steps) rather than overlap', () => {
    const big = layoutForViewport({ vw: 1920, vh: 1080 });
    expect(big.spectators.bubble.w).toBeCloseTo(big.bubbles.w, 6);
    const widths = new Set();
    for (const [vw, vh] of [[1024, 668], [1280, 620], [844, 390], [960, 540], [800, 600]]) {
      for (const [, isSpectator] of ROLES) {
        const L = layoutForViewport({ vw, vh, isSpectator });
        widths.add(Math.round((L.spectators.bubble.w / L.bubbles.w) * 100));
        expect(badgeBubbleProblems(L)).toEqual([]);
      }
    }
    // some of them took a narrower step, none went below the last
    expect([...widths].some((f) => f < 100)).toBe(true);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(60);
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
