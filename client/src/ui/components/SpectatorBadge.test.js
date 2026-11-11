/**
 * Who is watching (SpectatorBadge): eye + count in the HUD slot, hidden at
 * 0, a 44 px kit IconButton with "N people watching", a popover listing the
 * names with avatars (click / Enter, hover with a mouse; Escape and an
 * outside click close it), reduced motion respected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderSpectatorBadge, removeSpectatorBadge, isSpectatorListOpen, watchingLabel, EYE_ICON } from './SpectatorBadge.js';
import { clearHud, applyHudLayout } from '../tableHud.js';
import { computeTableLayout } from '../../phaser/layout/computeTableLayout.js';
import { setReducedMotionOverride } from '../motion.js';

const W = (names, count = names.length) => ({ spectators: names.map((n, i) => ({ username: n, pic: i % 2 ? null : i + 1 })), count });
const slot = () => document.querySelector('#table-hud > .hud-spectators');
const btn = () => slot()?.querySelector('button.spectator-badge');
const pop = () => slot()?.querySelector('#spectator-list');
const names = () => [...pop().querySelectorAll('li .spectator-popover__name')].map((n) => n.textContent);
const key = (k, target = document.activeElement || document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const pointer = (type, target, pointerType = 'mouse') => {
  const e = new Event(type, { bubbles: type === 'pointerdown' });
  e.pointerType = pointerType;
  target.dispatchEvent(e);
};

beforeEach(() => {
  document.body.innerHTML = '<div id="game-container"></div>';
  applyHudLayout(computeTableLayout({ w: 1120, h: 790, logW: 320 }));
});

afterEach(() => {
  removeSpectatorBadge();
  clearHud();
  setReducedMotionOverride(null);
});

describe('the badge', () => {
  it('is hidden at 0 and not even built until someone watches', () => {
    expect(renderSpectatorBadge(W([]))).toBeNull();
    expect(slot()).toBeNull();
    renderSpectatorBadge(W(['ann']));
    expect(slot().hidden).toBe(false);
    renderSpectatorBadge(W([]));
    expect(slot().hidden).toBe(true);
  });

  it('shows the eye (a drawn SVG, no emoji) and the count, with an accessible label', () => {
    renderSpectatorBadge(W(['ann', 'bob']));
    const b = btn();
    expect(b.classList.contains('kit-icon-btn')).toBe(true); // the kit's 44 px hit target
    expect(b.querySelector('svg')).not.toBeNull();
    expect(EYE_ICON).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(b.querySelector('.spectator-badge__count').textContent).toBe('2');
    expect(b.getAttribute('aria-label')).toBe('2 people watching');
    expect(watchingLabel(1)).toBe('1 person watching');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('aria-controls')).toBe('spectator-list');
    // a disclosure, not a menu: aria-haspopup="true" would announce a menu that is not there
    expect(b.hasAttribute('aria-haspopup')).toBe(false);
  });

  it('sits where the layout says (CSS variables on the HUD, no inline geometry on the node)', () => {
    renderSpectatorBadge(W(['ann']));
    const hud = document.getElementById('table-hud');
    const L = computeTableLayout({ w: 1120, h: 790, logW: 320 });
    expect(hud.style.getPropertyValue('--spec-x')).toBe(`${L.spectators.rect.x}px`);
    expect(hud.style.getPropertyValue('--spec-y')).toBe(`${L.spectators.rect.y}px`);
    expect(hud.style.getPropertyValue('--spec-h')).toBe(`${L.spectators.rect.h}px`);
    expect(slot().getAttribute('style')).toBeNull();
  });
});

describe('the list', () => {
  it('a click opens the names with their avatars as a list; a second click closes it', () => {
    renderSpectatorBadge(W(['ann', 'bob', 'me']), { me: 'me' });
    btn().click();
    expect(isSpectatorListOpen()).toBe(true);
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(pop().getAttribute('role')).toBe('group');
    expect(pop().getAttribute('aria-label')).toBe('People watching');
    const ul = pop().querySelector('ul');
    expect(ul.getAttribute('role')).toBe('list'); // kept under list-style: none (WebKit)
    expect(ul.hasAttribute('aria-label')).toBe(false); // the group names it once
    expect(names()).toEqual(['ann', 'bob', 'me (you)']);
    const imgs = [...pop().querySelectorAll('li img')].map((i) => i.getAttribute('src'));
    expect(imgs[0]).toBe('assets/avatars/v1/profile1.webp');
    expect(imgs[1]).toBe('assets/default_avatar.png'); // no stock pic (a custom one without a rendition)
    btn().click();
    expect(isSpectatorListOpen()).toBe(false);
  });

  it('a custom picture is its /avatar URL', () => {
    renderSpectatorBadge({ spectators: [{ username: 'cus', pic: null, avatarUrl: '/avatar/cus?v=0123456789abcdef' }], count: 1 });
    btn().click();
    expect(pop().querySelector('li img').getAttribute('src')).toBe('/avatar/cus?v=0123456789abcdef');
  });

  it('Escape closes it and puts the focus back on the badge; an outside click closes it', () => {
    renderSpectatorBadge(W(['ann']));
    btn().focus();
    btn().click();
    key('Escape');
    expect(isSpectatorListOpen()).toBe(false);
    expect(document.activeElement).toBe(btn());
    btn().click();
    pointer('pointerdown', slot().querySelector('li'));
    expect(isSpectatorListOpen()).toBe(true); // inside: stays
    pointer('pointerdown', document.getElementById('game-container'));
    expect(isSpectatorListOpen()).toBe(false);
  });

  it('Escape on a hover-opened list leaves the focus where it is (the chat input) and lets the key through', () => {
    const chat = document.createElement('input');
    document.body.appendChild(chat);
    let reached = 0;
    chat.addEventListener('keydown', (e) => { if (e.key === 'Escape') reached++; });
    renderSpectatorBadge(W(['ann']));
    chat.focus();
    pointer('pointerenter', slot());
    expect(isSpectatorListOpen()).toBe(true);
    key('Escape', chat);
    expect(isSpectatorListOpen()).toBe(false);
    expect(document.activeElement).toBe(chat);
    expect(reached).toBe(1);
    chat.remove();
  });

  it('Escape after a click that left no focus (Safari) still puts it on the badge', () => {
    renderSpectatorBadge(W(['ann']));
    btn().click();
    btn().blur();
    key('Escape', document.body);
    expect(isSpectatorListOpen()).toBe(false);
    expect(document.activeElement).toBe(btn());
  });

  it('fades in: the hidden style is flushed before is-open, so the opacity transition runs', () => {
    renderSpectatorBadge(W(['ann']));
    const p = pop();
    const reads = [];
    Object.defineProperty(p, 'offsetWidth', {
      configurable: true,
      get() { reads.push({ shown: !p.hidden, open: p.classList.contains('is-open') }); return 0; },
    });
    btn().click();
    expect(p.classList.contains('is-open')).toBe(true);
    expect(reads).toContainEqual({ shown: true, open: false });
  });

  it('a mouse hover opens it and leaving closes it; a click while hovered pins it open; touch does not hover', () => {
    renderSpectatorBadge(W(['ann']));
    pointer('pointerenter', slot());
    expect(isSpectatorListOpen()).toBe(true);
    pointer('pointerleave', slot());
    expect(isSpectatorListOpen()).toBe(false);
    pointer('pointerenter', slot());
    btn().click();
    pointer('pointerleave', slot());
    expect(isSpectatorListOpen()).toBe(true);
    btn().click();
    pointer('pointerenter', slot(), 'touch');
    expect(isSpectatorListOpen()).toBe(false);
  });

  it('updates in place while open; past the cap it says how many more; at 0 it closes and hides', () => {
    renderSpectatorBadge(W(['ann', 'bob']));
    btn().click();
    const first = pop().querySelector('li');
    renderSpectatorBadge(W(['ann', 'bob', 'cat'], 63));
    expect(pop().querySelector('li')).toBe(first);
    expect(names()).toEqual(['ann', 'bob', 'cat']);
    expect(pop().querySelector('.spectator-popover__more').textContent).toBe('and 60 more');
    expect(btn().querySelector('.spectator-badge__count').textContent).toBe('63');
    renderSpectatorBadge(W([]));
    expect(isSpectatorListOpen()).toBe(false);
    expect(slot().hidden).toBe(true);
  });

  it('opens without its fade under reduced motion', () => {
    setReducedMotionOverride(true);
    renderSpectatorBadge(W(['ann']));
    btn().click();
    expect(pop().classList.contains('is-instant')).toBe(true);
    btn().click();
    setReducedMotionOverride(false);
    btn().click();
    expect(pop().classList.contains('is-instant')).toBe(false);
  });

  it('removeSpectatorBadge takes the node and its document listeners down', () => {
    renderSpectatorBadge(W(['ann']));
    btn().click();
    removeSpectatorBadge();
    expect(slot()).toBeNull();
    expect(() => key('Escape', document.body)).not.toThrow();
    expect(isSpectatorListOpen()).toBe(false);
  });
});
