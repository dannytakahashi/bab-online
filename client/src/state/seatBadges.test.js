/**
 * The avatar badges' state (state/seatBadges.js, GameState helpAsked /
 * tutorialSeats; owner 2026-11-23): every event that sets or clears one,
 * the snapshot's seats, the own-seat rule, the cap over the lightbulb, and
 * the seat plates' chip (ui/seatPlates.js: data-badge, words, the pop only
 * when asked, a fade under reduced motion).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GameState } from './GameState.js';
import { seatBadgeOf, seatBadgeLabel, helpNoticeSeat, tutorialTag, isOwnSeat, BADGE } from './seatBadges.js';
import { buildAvatarRing, updateSeatBadges, updateSeatPlates } from '../ui/seatPlates.js';
import { setReducedMotionOverride } from '../ui/motion.js';

const help = (position) => ({ message: 'x used /help.', type: 'system', help: { position } });
const tut = (position, on) => ({ message: 'x turned on the tutorial.', type: 'system', tutorial: { position, on } });
const seats = (extra = {}) => [1, 2, 3, 4].map((position) => ({
  position, username: `p${position}`, pic: 1, hasCustomPic: false, customPic: null, ownerUsername: `p${position}`,
  controller: 'human', presence: 'connected', isBot: false, lazy: false, offered: false, graceDeadline: null,
  resignableAt: null, cardsInHand: 5, ...(extra[position] || {}),
}));
const snap = (over = {}) => ({
  v: 2, gameId: 'g1', stage: 'BIDDING', partial: [], viewer: { role: 'seat', position: 1 },
  hand: [], deal: { handNo: 1, dealSeq: 1, handSize: 5, dealer: 4 }, turn: { position: 2, action: 'bid' },
  bids: { byPosition: [null, null, null, null], order: [1, 2, 3, 4] }, trick: null,
  tricks: { team1: 0, team2: 0 }, score: { team1: 0, team2: 0 }, rainbows: { team1: 0, team2: 0 },
  seats: seats(), ...over,
});

/** A seat-1 player at the table, seat 2 on turn. */
function seated() {
  const s = new GameState();
  s.applySnapshot(snap());
  return s;
}

describe('the wire helpers', () => {
  it('read the help notice\'s seat and the tutorial\'s tag; anything else is null', () => {
    expect(helpNoticeSeat(help(3))).toBe(3);
    for (const bad of [null, {}, { help: {} }, { help: { position: 0 } }, { help: { position: 5 } }, { help: { position: '2' } }]) {
      expect(helpNoticeSeat(bad)).toBeNull();
    }
    expect(tutorialTag(tut(2, true))).toEqual({ position: 2, on: true });
    expect(tutorialTag(tut(2, false))).toEqual({ position: 2, on: false });
    for (const bad of [null, {}, { tutorial: { position: 2 } }, { tutorial: { position: 7, on: true } }, { tutorial: { position: 2, on: 'yes' } }]) {
      expect(tutorialTag(bad)).toBeNull();
    }
  });

  it('the words: the seat\'s name, then what it shows', () => {
    expect(seatBadgeLabel(BADGE.HELP, 'ann')).toBe('ann, asked for help this turn');
    expect(seatBadgeLabel(BADGE.TUTORIAL, 'ann')).toBe('ann, tutorial on');
    expect(seatBadgeLabel(null, 'ann')).toBe('');
  });
});

describe('GameState: what sets a lightbulb and what puts it out', () => {
  it('the live help notice sets it (once); the seat\'s own bid puts it out, another seat\'s does not', () => {
    const s = seated();
    expect(s.applyLogEntry(help(2))).toBe(2);
    expect(s.applyLogEntry(help(2))).toBeNull();
    expect(s.helpAsked).toEqual({ 2: true });
    s.applyBid({ position: 3, bid: '1' });
    expect(s.helpAsked).toEqual({ 2: true });
    s.applyBid({ position: 2, bid: '2' });
    expect(s.helpAsked).toEqual({});
  });

  it('a plain system line (no help, no tag) changes nothing', () => {
    const s = seated();
    expect(s.applyLogEntry({ message: 'x used /help.', type: 'system' })).toBeNull();
    expect(s.applyLogEntry({ message: 'hi', type: 'system', fault: { position: 2, bid: 1, took: 0 } })).toBeNull();
    expect(s.helpAsked).toEqual({});
    expect(s.tutorialSeats).toEqual({});
  });

  it('the seat\'s card puts it out', () => {
    const s = seated();
    s.applyDoneBidding({ lead: 2 });
    s.applyLogEntry(help(2));
    s.applyCardPlayed({ position: 3, card: { suit: 'hearts', rank: '2' } });
    expect(s.helpAsked).toEqual({ 2: true });
    s.applyCardPlayed({ position: 2, card: { suit: 'hearts', rank: '3' } });
    expect(s.helpAsked).toEqual({});
  });

  it('an updateTurn to another seat puts it out; one to the same seat keeps it', () => {
    const s = seated();
    s.applyLogEntry(help(2));
    s.applyTurn({ currentTurn: 2 });
    expect(s.helpAsked).toEqual({ 2: true });
    s.applyTurn({ currentTurn: 3 });
    expect(s.helpAsked).toEqual({});
  });

  for (const [what, apply] of [
    ['doneBidding', (s) => s.applyDoneBidding({ lead: 2 })],
    ['handComplete', (s) => s.applyHandComplete({ score: { team1: 0, team2: 0 } })],
    ['the hand\'s reset', (s) => s.resetForNewHand()],
    ['a new deal (gameStart)', (s) => s.applyDeal({ gameId: 'g1', hand: [], dealer: 1, currentHand: 4 })],
    ['the redeal (destroyHands)', (s) => s.applyDestroyHands()],
    ['gameEnd', (s) => s.applyGameEnd({ score: { team1: 10, team2: 0 } })],
    ['leaving the table (reset)', (s) => s.reset()],
    ['the seat going lazy or replaced (clearHelpAsked)', (s) => s.clearHelpAsked(2)],
  ]) {
    it(`${what} puts it out`, () => {
      const s = seated();
      s.applyLogEntry(help(2));
      apply(s);
      expect(s.helpAsked).toEqual({});
    });
  }

  it('the caps outlive the hand, the deal and the game\'s end; leaving the table forgets them', () => {
    const s = seated();
    s.applyLogEntry(tut(3, true));
    s.applyDoneBidding({ lead: 2 });
    s.applyHandComplete({});
    s.resetForNewHand();
    s.applyDestroyHands();
    s.applyDeal({ gameId: 'g1', hand: [], dealer: 1, currentHand: 4 });
    s.applyGameEnd({});
    s.clearHelpAsked(3);
    expect(s.tutorialSeats).toEqual({ 3: true });
    s.reset();
    expect(s.tutorialSeats).toEqual({});
  });

  it('the tutorial\'s tag: on puts the cap on, off takes it off; a repeat changes nothing', () => {
    const s = seated();
    expect(s.applyLogEntry(tut(3, true))).toBe(3);
    expect(s.applyLogEntry(tut(3, true))).toBeNull();
    expect(s.tutorialSeats).toEqual({ 3: true });
    expect(s.applyLogEntry(tut(3, false))).toBe(3);
    expect(s.applyLogEntry(tut(3, false))).toBeNull();
    expect(s.tutorialSeats).toEqual({});
  });
});

describe('GameState: a snapshot sets both from its seats', () => {
  it('seats[].askedHelp and seats[].tutorial (present only when true)', () => {
    const s = new GameState();
    s.applySnapshot(snap({ seats: seats({ 2: { askedHelp: true }, 4: { tutorial: true } }) }));
    expect(s.helpAsked).toEqual({ 2: true });
    expect(s.tutorialSeats).toEqual({ 4: true });
  });

  it('a same-game snapshot without the keys takes both off (and so does an older server\'s)', () => {
    const s = seated();
    s.applyLogEntry(help(2));
    s.applyLogEntry(tut(3, true));
    s.applySnapshot(snap());
    expect(s.helpAsked).toEqual({});
    expect(s.tutorialSeats).toEqual({});
  });

  it('only === true counts; the snapshot\'s log never toggles anything', () => {
    const s = new GameState();
    s.applySnapshot(snap({
      seats: seats({ 2: { askedHelp: 'yes' }, 3: { tutorial: 1 } }),
      log: [{ message: 'p3 turned on the tutorial.', type: 'system' }, { message: 'p2 used /help.', type: 'system', help: { position: 2 } }],
    }));
    expect(s.helpAsked).toEqual({});
    expect(s.tutorialSeats).toEqual({});
  });
});

describe('who sees which badge (seatBadgeOf)', () => {
  it('the cap wins over a lightbulb; nothing else shows none', () => {
    const s = seated();
    s.applyLogEntry(help(2));
    s.applyLogEntry(tut(2, true));
    expect(seatBadgeOf(s, 2)).toBe(BADGE.TUTORIAL);
    s.applyLogEntry(tut(2, false));
    expect(seatBadgeOf(s, 2)).toBe(BADGE.HELP);
    expect(seatBadgeOf(s, 3)).toBeNull();
    expect(seatBadgeOf(s, 0)).toBeNull();
  });

  it('never on my own seat, as a seat holder or a lazy watcher', () => {
    const s = seated();
    s.applyLogEntry(tut(1, true));
    s.applyLogEntry(help(1));
    expect(isOwnSeat(s, 1)).toBe(true);
    expect(seatBadgeOf(s, 1)).toBeNull();
    s.applySnapshot(snap({ viewer: { role: 'lazyWatcher', position: 1 }, seats: seats({ 1: { tutorial: true } }) }));
    expect(s.isLazy).toBe(true);
    expect(seatBadgeOf(s, 1)).toBeNull();
  });

  it('a pure spectator sees every seat\'s, the bottom one too; a watcher the watched seat\'s', () => {
    const s = new GameState();
    s.applySnapshot(snap({ viewer: { role: 'spectator', position: null }, seats: seats({ 1: { tutorial: true }, 2: { askedHelp: true } }) }));
    expect(s.isSpectator).toBe(true);
    expect(s.position).toBe(1);
    expect([1, 2, 3, 4].map((p) => seatBadgeOf(s, p))).toEqual(['tutorial', 'help', null, null]);
    s.applySnapshot(snap({
      viewer: { role: 'spectator', position: null, shoulder: { position: 2, hand: [{ suit: 'hearts', rank: '2' }], hsi: null } },
      seats: seats({ 2: { askedHelp: true } }),
    }));
    expect(s.shoulder).toEqual({ position: 2, paused: false });
    expect(s.position).toBe(2);
    expect(seatBadgeOf(s, 2)).toBe(BADGE.HELP);
  });
});

describe('the seat ring\'s chip (ui/seatPlates.js)', () => {
  let root;
  let pops;
  beforeEach(() => {
    root = document.createElement('div');
    for (const p of [1, 2, 3, 4]) {
      const img = document.createElement('img');
      root.appendChild(buildAvatarRing(img, p));
    }
    document.body.appendChild(root);
    pops = [];
    HTMLElement.prototype.animate = function animate(frames, opts) {
      pops.push({ el: this, frames, opts });
      return { cancel() {} };
    };
  });
  afterEach(() => {
    root.remove();
    delete HTMLElement.prototype.animate;
    setReducedMotionOverride(null);
  });
  const chip = (p) => root.querySelector(`.hud-avatar-ring[data-position="${p}"] .hud-seat-badge`);

  it('in the ring\'s top left corner, after the eye: both glyphs, aria-hidden, none shown', () => {
    const corner = root.querySelector('.hud-avatar-ring[data-position="2"] > .hud-ring-corner');
    expect([...corner.children].map((c) => c.className)).toEqual(['hud-watch-chip', 'hud-seat-badge']);
    expect([...chip(2).querySelectorAll('svg')].map((v) => [v.getAttribute('class'), v.getAttribute('aria-hidden')]))
      .toEqual([['hud-seat-badge__bulb', 'true'], ['hud-seat-badge__cap', 'true']]);
    expect(chip(2).dataset.badge).toBeUndefined();
  });

  it('draws each seat\'s badge with its words; pops only the seats asked for; none on my own seat', () => {
    const s = seated();
    s.applyLogEntry(help(2));
    s.applyLogEntry(tut(3, true));
    s.applyLogEntry(tut(1, true));
    updateSeatBadges(root, s);
    expect([1, 2, 3, 4].map((p) => chip(p).dataset.badge ?? null)).toEqual([null, 'help', 'tutorial', null]);
    expect(chip(2).title).toBe('p2, asked for help this turn');
    expect(chip(3).getAttribute('aria-label')).toBe('p3, tutorial on');
    expect(chip(3).getAttribute('role')).toBe('img');
    expect(pops).toEqual([]);
    // the seat plates' projection draws them too, never with a pop
    s.applyBid({ position: 2, bid: '1' });
    updateSeatPlates(root, s);
    expect(chip(2).dataset.badge).toBeUndefined();
    expect(chip(2).hasAttribute('role')).toBe(false);
    expect(pops).toEqual([]);
    s.applyLogEntry(help(3));
    updateSeatBadges(root, s, { pop: [3] });
    expect(pops.map((p) => p.el)).toEqual([chip(3)]);
    // a pop for a seat that shows nothing (an off tag) animates nothing
    updateSeatBadges(root, s, { pop: [4] });
    expect(pops).toHaveLength(1);
  });

  it('the pop: up a little and settle; under reduced motion a fade, no scale', () => {
    const s = seated();
    s.applyLogEntry(help(2));
    updateSeatBadges(root, s, { pop: [2] });
    expect(pops[0].frames.map((f) => f.transform)).toEqual(['scale(0.6)', 'scale(1.18)', 'scale(1)']);
    expect(pops[0].opts.duration).toBe(250);
    setReducedMotionOverride(true);
    updateSeatBadges(root, s, { pop: [2] });
    expect(pops[1].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(pops[1].frames.some((f) => 'transform' in f)).toBe(false);
  });

  it('without the Web Animations API (an old browser) the badge simply shows', () => {
    delete HTMLElement.prototype.animate;
    const s = seated();
    s.applyLogEntry(help(2));
    expect(() => updateSeatBadges(root, s, { pop: [2] })).not.toThrow();
    expect(chip(2).dataset.badge).toBe('help');
  });
});
