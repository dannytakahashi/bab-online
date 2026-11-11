/**
 * Seat plates (item 18a, ui-d3): a team ring per seat, the seat's bid as a
 * chip, the team's tricks as pips; the seat's text stays its name. And the
 * table backdrops (the rail, the hand panel) take the layout's rects as CSS
 * variables, with their look in classes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildAvatarRing, updateSeatPlates, teamLetter } from './seatPlates.js';
import { LayoutManager, placeBackdrop } from '../phaser/managers/LayoutManager.js';
import { computeTableLayout } from '../phaser/layout/computeTableLayout.js';

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

    // playing: my team bid 3 + 2 and won 2; the opponents bid B (0) + 1 and won 2 (one over)
    updateSeatPlates(root, { position: 1, isBidding: false, bids: { 1: '3', 2: 'B', 3: '2', 4: '1' }, teamTricks: 2, oppTricks: 2 });
    expect(pips(0)).toHaveLength(5);
    expect(pips(0).filter((p) => p.classList.contains('is-won'))).toHaveLength(2);
    expect(pips(1)).toHaveLength(2);
    expect(pips(1).filter((p) => p.classList.contains('is-won'))).toHaveLength(1);
    expect(pips(1).filter((p) => p.classList.contains('is-over'))).toHaveLength(1);
    expect(ring(1).querySelector('.hud-pips').dataset.team).toBe('b');
    // the seat's text is still just its name (tests and assistive tech read it)
    expect(seats.map((s) => s.textContent)).toEqual(['Ann', 'Bob', 'Cat', 'Dan']);
    expect(ring(0).querySelector('.hud-bid-chip').getAttribute('aria-hidden')).toBe('true');
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
