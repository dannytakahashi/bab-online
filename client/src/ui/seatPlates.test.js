/**
 * Seat plates (item 18a, ui-d3): a team ring per seat, the seat's bid as a
 * chip, the team's tricks as pips; the seat's text stays its name. And the
 * table backdrops (the rail, the hand panel) take the layout's rects as CSS
 * variables, with their look in classes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildAvatarRing, updateSeatPlates, teamLetter } from './seatPlates.js';
import { GameState } from '../state/GameState.js';
import { snapshotFromLegacy } from '../state/legacySnapshot.js';
import { LayoutManager, placeBackdrop } from '../phaser/managers/LayoutManager.js';
import { computeTableLayout } from '../phaser/layout/computeTableLayout.js';
import { readClientFile } from '../testing/files.js';

function seat(position, name) {
  const container = document.createElement('div');
  container.className = 'opponent-avatar-container';
  const img = document.createElement('img');
  img.className = 'opponent-avatar-img hud-avatar-img';
  container.appendChild(buildAvatarRing(img, position));
  const plate = document.createElement('div');
  plate.className = 'hud-plate';
  plate.textContent = name;
  container.appendChild(plate);
  return container;
}

describe('seat rings', () => {
  afterEach(() => document.body.replaceChildren());

  it('team A is seats 1 and 3, team B seats 2 and 4', () => {
    expect([1, 2, 3, 4].map(teamLetter)).toEqual(['a', 'b', 'a', 'b']);
    const s = seat(2, 'Bob');
    expect(s.querySelector('.hud-avatar-ring').dataset.team).toBe('b');
  });

  it('the bid chip and the pips follow the table, and the seat\'s text stays its name', () => {
    const root = document.createElement('div');
    const seats = [seat(1, 'Ann'), seat(2, 'Bob'), seat(3, 'Cat'), seat(4, 'Dan')];
    root.append(...seats);
    document.body.appendChild(root);
    const ring = (i) => seats[i].querySelector('.hud-avatar-ring');
    const chip = (i) => ring(i).querySelector('.hud-bid-chip');
    const pips = (i) => [...ring(i).querySelectorAll('.hud-pip')];

    // bidding: chips for the bids placed, no pips yet
    updateSeatPlates(root, { position: 1, isBidding: true, bids: { 1: '3', 2: 'B' }, teamTricks: 0, oppTricks: 0 });
    expect(chip(0).dataset.bid).toBe('3');
    expect(chip(1).dataset.bid).toBe('B');
    expect(chip(1).classList.contains('is-bore')).toBe(true);
    expect(chip(2).dataset.bid).toBe('');
    expect(pips(0)).toHaveLength(0);

    // playing (8 cards): seat 1 bid 3 and won 2 of them; seat 4 bid 1 and won 2 (one over)
    updateSeatPlates(root, {
      position: 1, isBidding: false, currentHand: 8, bids: { 1: '3', 2: '2', 3: '2', 4: '1' },
      tricksByPosition: { 1: 2, 2: 0, 3: 0, 4: 2 }, teamTricks: 2, oppTricks: 2,
    });
    expect(pips(0)).toHaveLength(3);
    expect(pips(0).filter((p) => p.classList.contains('is-won'))).toHaveLength(2);
    expect(pips(3)).toHaveLength(2);
    expect(pips(3).filter((p) => p.classList.contains('is-won'))).toHaveLength(1);
    expect(pips(3).filter((p) => p.classList.contains('is-over'))).toHaveLength(1);
    expect(ring(3).querySelector('.hud-pips').dataset.team).toBe('b');
    // the seat's text is still just its name (tests and assistive tech read it)
    expect(seats.map((s) => s.textContent)).toEqual(['Ann', 'Bob', 'Cat', 'Dan']);
    expect(ring(0).querySelector('.hud-bid-chip').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('per-player pips (owner, 2026-11-11), projected from GameState', () => {
  afterEach(() => document.body.replaceChildren());

  /** The four rings, and per seat: [slots, won, over, title] */
  function table() {
    const root = document.createElement('div');
    root.append(...[1, 2, 3, 4].map((p) => seat(p, `p${p}`)));
    document.body.appendChild(root);
    const view = () => Object.fromEntries([1, 2, 3, 4].map((p) => {
      const box = root.querySelector(`.hud-avatar-ring[data-position="${p}"] .hud-pips`);
      const all = [...box.children];
      return [p, [all.length, all.filter((x) => x.classList.contains('is-won')).length,
        all.filter((x) => x.classList.contains('is-over')).length, box.title]];
    }));
    return { root, view };
  }
  const hand = (n) => Array.from({ length: n }, (_, i) => ({ suit: 'spades', rank: String(i + 2) }));
  /** A live hand: dealt, bid (bids[i] is seat i+1's), tricks won by `winners` in order. */
  function play(state, { position = 1, size = 10, bids, winners = [] }) {
    state.applyDeal({ gameId: 'g1', position, currentHand: size, dealer: 4, trump: { suit: 'hearts', rank: '9' }, hand: hand(size) });
    bids.forEach((bid, i) => state.applyBid({ position: i + 1, bid }));
    state.applyDoneBidding({ bids, lead: 1 });
    for (const w of winners) state.applyTrickComplete({ winner: w });
  }
  const v2 = (extra = {}) => ({
    v: 2, gameId: 'g1', seq: 9, stage: 'PLAYING', partial: [],
    viewer: { role: 'seat', position: 1, ownerView: 'seat', canAct: false },
    hand: hand(5), deal: { handNo: 1, handSize: 10, dealer: 4, bidder: 1, dealSeq: 1 },
    trump: { suit: 'hearts', rank: '9' }, trumpBroken: false, turn: { position: 1, action: 'play' },
    bids: { byPosition: ['3', '2', '2', '1'], order: [1, 2, 3, 4], teamBids: { team1: 5, team2: 3 }, mults: { team1: 1, team2: 1 } },
    trick: { number: 6, leadPosition: 1, cards: [] },
    tricks: { team1: 3, team2: 2 }, tricksByPosition: [1, 2, 2, 0],
    score: { team1: 0, team2: 0 }, rainbows: { team1: 0, team2: 0 }, hsi: null,
    seats: [], entrants: null, draw: null, spectatorCount: 0, tournament: null, log: [],
    ...extra,
  });

  it('each seat shows its own bid and its own tricks; a trick past its bid is over; a 0 bid has no slots', () => {
    const state = new GameState();
    const { root, view } = table();
    play(state, { bids: ['3', '0', '2', '1'], winners: [1, 3, 3, 3, 2, 1] });
    updateSeatPlates(root, state);
    expect(state.tricksByPosition).toEqual({ 1: 2, 2: 1, 3: 3, 4: 0 });
    expect(view()).toEqual({
      1: [3, 2, 0, '2 of 3'],
      // the 0 bid: no slots, its one trick an over pip
      2: [1, 0, 1, '1 of 0'],
      // partners differ now (the team-level pips showed 5/5 on both)
      3: [3, 2, 1, '3 of 2'],
      4: [1, 0, 0, '0 of 1'],
    });
  });

  it('a 0 bid with no tricks shows nothing; the pips stay hidden during bidding', () => {
    const state = new GameState();
    const { root, view } = table();
    state.applyDeal({ gameId: 'g1', position: 1, currentHand: 4, dealer: 4, trump: { suit: 'hearts', rank: '9' }, hand: hand(4) });
    state.applyBid({ position: 1, bid: '2' });
    state.applyBid({ position: 3, bid: '1' });
    updateSeatPlates(root, state);
    expect(view()[1]).toEqual([0, 0, 0, '']);
    state.applyBid({ position: 2, bid: '0' });
    state.applyBid({ position: 4, bid: '1' });
    state.applyDoneBidding({ bids: ['2', '0', '1', '1'], lead: 1 });
    updateSeatPlates(root, state);
    expect(view()[2]).toEqual([0, 0, 0, '']);
    expect(view()[1]).toEqual([2, 0, 0, '0 of 2']);
  });

  it('a bore seat shows the whole hand (10 cards) filled with the TEAM\'s tricks; its partner stays per-player', () => {
    const state = new GameState();
    const { root, view } = table();
    play(state, { size: 10, bids: ['B', '1', '2', '0'], winners: [1, 3, 1, 1, 3, 1, 3] });
    updateSeatPlates(root, state);
    expect(view()[1]).toEqual([10, 7, 0, 'Team 7 of 10 (bore)']);
    expect(view()[3]).toEqual([3, 2, 1, '3 of 2']);
    const box = root.querySelector('.hud-avatar-ring[data-position="1"] .hud-pips');
    expect(box.classList.contains('is-bore')).toBe(true);
    expect(root.querySelector('.hud-avatar-ring[data-position="3"] .hud-pips').classList.contains('is-bore')).toBe(false);
  });

  it('both partners bored: both rings show the team target; the 13-card hand caps at MAX_PIPS 13', () => {
    const state = new GameState();
    const { root, view } = table();
    play(state, { size: 13, bids: ['1', 'B', '0', '2B'], winners: [2, 4, 4] });
    updateSeatPlates(root, state);
    expect(view()[2]).toEqual([13, 3, 0, 'Team 3 of 13 (bore)']);
    expect(view()[4]).toEqual([13, 3, 0, 'Team 3 of 13 (bore)']);
  });

  it('a spectator (viewing from seat 1) sees every seat by its absolute position', () => {
    const state = new GameState();
    const { root, view } = table();
    state.applySnapshot(v2({ viewer: { role: 'spectator', position: null, ownerView: null, canAct: false }, hand: null }));
    expect(state.isSpectator).toBe(true);
    updateSeatPlates(root, state);
    expect(view()).toEqual({ 1: [3, 1, 0, '1 of 3'], 2: [2, 2, 0, '2 of 2'], 3: [2, 2, 0, '2 of 2'], 4: [1, 0, 0, '0 of 1'] });
    // and from seat 2's side the same seats show the same pips
    state.applySnapshot(v2({ viewer: { role: 'seat', position: 2, ownerView: 'seat', canAct: false } }));
    updateSeatPlates(root, state);
    expect(view()).toEqual({ 1: [3, 1, 0, '1 of 3'], 2: [2, 2, 0, '2 of 2'], 3: [2, 2, 0, '2 of 2'], 4: [1, 0, 0, '0 of 1'] });
  });

  it('after a v2 snapshot the per-seat counts are its tricksByPosition, even with unknown trick winners; play goes on from them', () => {
    const state = new GameState();
    const { root, view } = table();
    // no trickHistory (an older server): the stacks are placeholders with no winner
    state.applySnapshot(v2());
    expect(state.trickHistory.every((t) => t.winner === null)).toBe(true);
    updateSeatPlates(root, state);
    expect(view()[1]).toEqual([3, 1, 0, '1 of 3']);
    expect(view()[3]).toEqual([2, 2, 0, '2 of 2']);
    state.applyTrickComplete({ winner: 3 });
    updateSeatPlates(root, state);
    expect(view()[3]).toEqual([3, 2, 1, '3 of 2']);
    // a served history that disagrees with tricksByPosition does not override it
    state.applySnapshot(v2({ trickHistory: Array.from({ length: 5 }, (_, i) => ({ winner: i < 3 ? 1 : 2, lead: 1, cards: hand(4) })) }));
    expect(state.tricksByPosition).toEqual({ 1: 1, 2: 2, 3: 2, 4: 0 });
  });

  it('a legacy (v1) snapshot cannot know the seats: a team with tricks shows the team count, a team with none 0 each, the next deal is per seat again', () => {
    const state = new GameState();
    const { root, view } = table();
    const v1 = {
      gameId: 'g1', position: 1, currentHand: 10, trump: { suit: 'hearts', rank: '9' }, hand: hand(6), isBidding: false,
      playerBids: ['3', '2', '2', '1'], tricks: { team1: 3, team2: 1 }, playedCards: [null, null, null, null],
    };
    const snap = snapshotFromLegacy(v1);
    expect(snap.tricksByPosition).toEqual([0, 0, 0, 0]);
    state.applySnapshot(snap);
    expect(state.tricksByPosition).toEqual({ 1: null, 2: null, 3: null, 4: null });
    updateSeatPlates(root, state);
    // not "0 of 3" (wrong): the team's 3 of its 5
    expect(view()[1]).toEqual([5, 3, 0, 'Team 3 of 5']);
    expect(view()[3]).toEqual([5, 3, 0, 'Team 3 of 5']);
    expect(view()[2]).toEqual([3, 1, 0, 'Team 1 of 3']);
    // a team with no tricks yet is known: 0 each
    state.applySnapshot(snapshotFromLegacy({ ...v1, tricks: { team1: 3, team2: 0 } }));
    expect(state.tricksByPosition).toEqual({ 1: null, 2: 0, 3: null, 4: 0 });
    updateSeatPlates(root, state);
    expect(view()[2]).toEqual([2, 0, 0, '0 of 2']);
    // the next deal is live again: per seat
    play(state, { bids: ['1', '1', '1', '1'], winners: [3] });
    updateSeatPlates(root, state);
    expect(view()[3]).toEqual([1, 1, 0, '1 of 1']);
    expect(view()[1]).toEqual([1, 0, 0, '0 of 1']);
  });

  it('a new deal starts every seat at 0', () => {
    const state = new GameState();
    play(state, { bids: ['3', '2', '2', '1'], winners: [1, 2] });
    state.applyDeal({ gameId: 'g1', position: 1, currentHand: 8, dealer: 1, trump: { suit: 'clubs', rank: '2' }, hand: hand(8) });
    expect(state.tricksByPosition).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0 });
    expect(state.renderModel().tricksByPosition).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0 });
  });
});

describe('the pip box\'s label is reachable', () => {
  // A browser shows a title only for the element under the pointer or its
  // ancestors: a pip box that is not hit-tested (pointer-events: none on it
  // or its pips) never shows "2 of 3" or "Team 7 of 10 (bore)".
  const css = readClientFile('styles/table.css');
  /** Every rule whose selector list names the pip box or a pip, with its declarations. */
  const pipRules = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)]
    .map((m) => [m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), m[2]])
    .filter(([sel]) => /\.hud-pips?\b/.test(sel));

  it('no rule turns hit-testing off for the pip box or its pips', () => {
    expect(pipRules.length).toBeGreaterThan(0);
    const off = pipRules.filter(([, body]) => /pointer-events:\s*none/.test(body)).map(([sel]) => sel);
    expect(off).toEqual([]);
  });

  it('a bore box is marked on the table too (touch has no tooltip)', () => {
    const bore = pipRules.filter(([sel]) => sel.split(',').some((x) => x.trim() === '.hud-pips.is-bore'));
    expect(bore.map(([, body]) => body).join('')).toMatch(/var\(--danger-solid\)/);
  });

  it('the box sets its title and the bore class from the table', () => {
    const root = document.createElement('div');
    root.append(seat(1, 'Ann'));
    updateSeatPlates(root, { position: 1, isBidding: false, currentHand: 10, bids: { 1: 'B', 3: '2' }, tricksByPosition: { 1: 0, 2: 0, 3: 7, 4: 0 }, teamTricks: 7, oppTricks: 0 });
    const box = root.querySelector('.hud-pips');
    expect(box.title).toBe('Team 7 of 10 (bore)');
    expect(box.classList.contains('is-bore')).toBe(true);
  });
});

describe('table backdrops', () => {
  afterEach(() => document.body.replaceChildren());

  it('the rail and the hand panel take the layout\'s rects as CSS variables; their look is a class', () => {
    const container = document.createElement('div');
    container.id = 'game-container';
    document.body.appendChild(container);
    const L = computeTableLayout({ w: 1600, h: 1080 });
    const lm = new LayoutManager({ getLayout: () => L });
    lm.createDomBackgrounds();
    const rail = document.getElementById('playZoneDom');
    expect(rail.className).toBe('table-backdrop table-rail');
    const v = (el, k) => el.style.getPropertyValue(k);
    expect([v(rail, '--x'), v(rail, '--y'), v(rail, '--w'), v(rail, '--h')]).toEqual([L.trick.zone.x, L.trick.zone.y, L.trick.zone.w, L.trick.zone.h].map((n) => `${Math.round(n * 100) / 100}px`));
    const hand = document.getElementById('handBorderDom');
    expect(hand.className).toBe('table-backdrop hand-border');
    expect(v(hand, '--w')).toBe(`${Math.round(L.hand.rect.w * 100) / 100}px`);
    // a spectator's layout has no hand: the panel hides
    placeBackdrop(hand, null);
    expect(hand.hidden).toBe(true);
    for (const el of container.children) {
      expect(Array.from({ length: el.style.length }, (_, i) => el.style[i]).filter((k) => !k.startsWith('--'))).toEqual([]);
    }
  });
});
