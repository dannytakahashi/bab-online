/**
 * The component kit (item 18a): buttons by variant (a primary is never
 * red), the icon button's 44 px target, the Modal's focus trap / Escape /
 * focus restore, and the one Toast queue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readClientFile } from '../../testing/files.js';
import { createButton, createIconButton, createSwitch, setSwitch, createChip, createAvatar, setAvatarTurn, openModal, openModalCount, toast, clearToasts, toastQueueLength } from './index.js';
import { setReducedMotionOverride } from '../motion.js';
import { toastAnnouncers, ANNOUNCE_DELAY_MS, TOAST_SHORT } from './toast.js';

const css = readClientFile('styles/kit.css');
const key = (k, opts = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });

describe('Button / IconButton / Chip / Avatar', () => {
  it('a button carries its variant class and no inline style or hover handler', () => {
    const b = createButton({ label: 'Return to Lobby', variant: 'primary' });
    expect(b.className).toBe('kit-btn kit-btn--primary');
    expect(b.getAttribute('type')).toBe('button');
    expect(b.getAttribute('style')).toBeNull();
    expect(() => createButton({ label: 'x', variant: 'red' })).toThrow();
  });

  it('kit.css: the primary button is the primary token (never danger red), hover and focus are CSS', () => {
    const rule = (sel) => {
      const i = css.indexOf(`${sel} {`);
      expect(i, sel).toBeGreaterThan(-1);
      return css.slice(i, css.indexOf('}', i));
    };
    expect(rule('.kit-btn--primary')).toContain('var(--primary-base)');
    expect(rule('.kit-btn--primary')).not.toMatch(/danger/);
    expect(rule('.kit-btn--danger')).toContain('var(--danger-solid)');
    expect(css).toContain('.kit-btn--primary:hover');
    expect(css).toContain('.kit-btn:focus-visible');
    expect(rule('.kit-btn')).toContain('min-height: var(--hit-target)');
  });

  it('an icon button is named for assistive tech and keeps a 44 px hit target when drawn smaller', () => {
    const b = createIconButton({ icon: '<svg></svg>', label: 'Mute microphone', pressed: false });
    expect(b.getAttribute('aria-label')).toBe('Mute microphone');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(css).toMatch(/\.kit-icon-btn::before \{[^}]*inset: calc\(min\(0px, \(var\(--icon-btn-size\) - var\(--hit-target\)\) \/ 2\)\)/);
  });

  it('a chip and an avatar with a team ring and a turn ring', () => {
    expect(createChip({ label: '3', tone: 'team-a' }).className).toBe('kit-chip kit-chip--team-a');
    const { ring, img } = createAvatar({ src: 'a.png', alt: 'Ann', team: 'b' });
    expect(ring.dataset.team).toBe('b');
    expect(img.alt).toBe('Ann');
    setAvatarTurn(ring, true);
    expect(ring.classList.contains('turn-glow')).toBe(true);
    setAvatarTurn(ring, false);
    expect(ring.classList.contains('turn-glow')).toBe(false);
  });

  it('the turn ring animates opacity only, on a ::after layer, and stops under reduced motion', () => {
    const glow = css.slice(css.indexOf('@keyframes kit-turn-glow'), css.indexOf('}', css.indexOf('to {', css.indexOf('@keyframes kit-turn-glow'))) + 1);
    expect(glow).toContain('opacity');
    expect(glow).not.toMatch(/box-shadow|transform|filter/);
    expect(css).toMatch(/\.turn-glow::after,[\s\S]*?animation: kit-turn-glow/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.turn-glow::after,[\s\S]*?animation: none/);
  });
});

describe('Switch', () => {
  it('a button role=switch with aria-checked and its visible label; a click asks, the caller shows the value', () => {
    const onChange = vi.fn();
    const sw = createSwitch({ label: 'Spectators can talk', checked: true, onChange, id: 'sw' });
    expect(sw.tagName).toBe('BUTTON');
    expect(sw.getAttribute('type')).toBe('button');
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.textContent).toBe('Spectators can talk');
    expect(sw.getAttribute('style')).toBeNull();
    sw.click();
    expect(onChange).toHaveBeenCalledWith(false);
    expect(sw.getAttribute('aria-checked')).toBe('true'); // not flipped by the click
    setSwitch(sw, { checked: false, disabled: true });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.click();
    expect(onChange).toHaveBeenCalledTimes(1); // disabled: nothing asked
    setSwitch(sw, { disabled: false });
    sw.click();
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it('kit.css: a 44 px row, the on state is the success token, focus is visible', () => {
    expect(css).toMatch(/\.kit-switch \{[^}]*min-height: var\(--hit-target\)/);
    expect(css).toMatch(/\.kit-switch\[aria-checked="true"\] \.kit-switch__track \{[^}]*var\(--success\)/);
    expect(css).toContain('.kit-switch:focus-visible');
  });
});

describe('Modal', () => {
  let opener;
  beforeEach(() => {
    opener = createButton({ label: 'Open' });
    document.body.appendChild(opener);
    opener.focus();
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('moves focus in, traps Tab and Shift+Tab, and restores focus on close', () => {
    const a = createButton({ label: 'A' });
    const b = createButton({ label: 'B', variant: 'primary' });
    const m = openModal({ title: 'Leave?', body: document.createTextNode('Sure?'), actions: [a, b] });
    expect(m.dialog.getAttribute('role')).toBe('dialog');
    expect(m.dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(m.dialog.getAttribute('aria-labelledby')).textContent).toBe('Leave?');
    expect(document.activeElement).toBe(a);
    // Tab from the last wraps to the first, Shift+Tab from the first to the last
    b.focus();
    document.dispatchEvent(key('Tab'));
    expect(document.activeElement).toBe(a);
    document.dispatchEvent(key('Tab', { shiftKey: true }));
    expect(document.activeElement).toBe(b);
    // focus outside (the page behind) comes back in on Tab
    opener.focus();
    document.dispatchEvent(key('Tab'));
    expect(m.dialog.contains(document.activeElement)).toBe(true);
    m.close();
    expect(document.activeElement).toBe(opener);
    expect(m.backdrop.isConnected).toBe(false);
    expect(openModalCount()).toBe(0);
  });

  it('Escape closes a dismissible modal (reason escape) and never one that is not', () => {
    const onClose = vi.fn();
    const m = openModal({ title: 'Info', actions: [createButton({ label: 'OK' })], onClose });
    document.dispatchEvent(key('Escape'));
    expect(onClose).toHaveBeenCalledWith('escape');
    expect(m.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);

    const onClose2 = vi.fn();
    const m2 = openModal({ title: 'Game over', actions: [createButton({ label: 'Return to Lobby', variant: 'primary' })], dismissible: false, onClose: onClose2 });
    document.dispatchEvent(key('Escape'));
    expect(onClose2).not.toHaveBeenCalled();
    expect(m2.isOpen()).toBe(true);
    m2.close('action');
    expect(onClose2).toHaveBeenCalledWith('action');
  });

  it('modals stack: only the top one takes Escape and Tab; closing it hands focus back to the one below', () => {
    const inner = createButton({ label: 'Choose' });
    const lower = openModal({ title: 'Profile', body: inner, closable: true, closeLabel: 'Close profile' });
    expect(lower.dialog.querySelector('.kit-modal__close').getAttribute('aria-label')).toBe('Close profile');
    // the close button is not where focus starts
    expect(document.activeElement).toBe(inner);
    const pick = createButton({ label: 'Avatar 1' });
    const upper = openModal({ title: 'Pick', body: pick });
    expect(openModalCount()).toBe(2);
    document.dispatchEvent(key('Tab'));
    expect(upper.dialog.contains(document.activeElement)).toBe(true);
    document.dispatchEvent(key('Escape'));
    expect(upper.isOpen()).toBe(false);
    expect(lower.isOpen()).toBe(true);
    expect(document.activeElement).toBe(inner);
    lower.dialog.querySelector('.kit-modal__close').click();
    expect(lower.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('a modal whose node was removed by hand stops trapping keys', () => {
    const a = openModal({ title: 'Gone', actions: [createButton({ label: 'A' })] });
    const b = openModal({ title: 'Below?', actions: [createButton({ label: 'B' })] });
    b.backdrop.remove();
    expect(openModalCount()).toBe(1);
    document.dispatchEvent(key('Escape'));
    expect(a.isOpen()).toBe(false);
    expect(openModalCount()).toBe(0);
  });

  it('a pinned modal stays on top: one opened meanwhile goes under it, inert, and takes focus only once the pin closes', () => {
    const below = openModal({ title: 'Profile', actions: [createButton({ label: 'Below' })] });
    const keep = createButton({ label: 'Use here', variant: 'primary' });
    const pin = openModal({ title: 'Paused', actions: [keep], dismissible: false, pinned: true, initialFocus: keep });
    // what was open already is inert while the pin is up
    expect(below.backdrop.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(keep);

    const wait = createButton({ label: 'Wait' });
    const later = openModal({ title: 'Player Disconnected', actions: [wait], dismissible: false });
    const dialogFirst = openModal({ title: 'Game over', actions: [createButton({ label: 'Return' })], dismissible: false, initialFocus: 'dialog' });
    expect(openModalCount()).toBe(4);
    expect(document.activeElement).toBe(keep);
    for (const m of [later, dialogFirst]) expect(m.backdrop.hasAttribute('inert')).toBe(true);
    document.dispatchEvent(key('Tab'));
    expect(document.activeElement).toBe(keep);
    document.dispatchEvent(key('Tab', { shiftKey: true }));
    expect(document.activeElement).toBe(keep);
    // one under the pin closes: focus stays on the pin
    later.close('api');
    expect(document.activeElement).toBe(keep);

    // the pin closes: the top one under it is live and focused (its 'dialog' focus)
    pin.close('api');
    expect(document.querySelector('[inert]')).toBeNull();
    expect(document.activeElement).toBe(dialogFirst.dialog);
    dialogFirst.close('action');
    expect(document.activeElement.textContent).toBe('Below');
    below.close('api');
    expect(document.activeElement).toBe(opener);
  });

  it('initialFocus wins; a modal without controls focuses itself', () => {
    const a = createButton({ label: 'A' });
    const b = createButton({ label: 'B' });
    const m = openModal({ actions: [a, b], initialFocus: b });
    expect(document.activeElement).toBe(b);
    m.close();
    const bare = openModal({ title: 'Wait', body: document.createTextNode('...') });
    expect(document.activeElement).toBe(bare.dialog);
    document.dispatchEvent(key('Tab'));
    expect(document.activeElement).toBe(bare.dialog);
    bare.close();
  });
});

describe('Toast: one queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setReducedMotionOverride(false);
  });
  afterEach(() => {
    clearToasts();
    setReducedMotionOverride(null);
    vi.useRealTimers();
  });

  const shown = () => [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent);

  it('shows one toast at a time, the others in order after it', () => {
    toast('Saved', { type: 'success', duration: 1000 });
    toast('Host started the round', { type: 'info', duration: 1000 });
    toast('Heads up', { type: 'warning', duration: 1000 });
    toast('Still waiting', { type: 'warning', duration: 1000 });
    // the warning outranks the success on screen: that one leaves first
    vi.advanceTimersByTime(120);
    expect(shown()).toEqual(['Still waiting']); // (the queued warning took the newer text)
    expect(toastQueueLength()).toBe(2);
    vi.advanceTimersByTime(1000 + 120);
    expect(shown()).toEqual(['Host started the round']);
    vi.advanceTimersByTime(1120);
    expect(shown()).toEqual([]);
    expect(toastQueueLength()).toBe(0);
  });

  it('an error is never held behind a toast of another type (it preempts the one on screen and the queue)', () => {
    toast('Registration successful! Please sign in.', { type: 'success' });
    toast('Tournament starts soon', { type: 'info' });
    toast('Action not accepted', { type: 'warning' });
    toast('Sign-in failed!', { type: 'error' });
    // the success leaves at once (its fade), not after its 5 s
    vi.advanceTimersByTime(120);
    expect(shown()).toEqual(['Sign-in failed!']);
    // then the warning, then the info: nothing is dropped but the preempted toast
    vi.advanceTimersByTime(5120);
    expect(shown()).toEqual(['Action not accepted']);
    vi.advanceTimersByTime(5120);
    expect(shown()).toEqual(['Tournament starts soon']);
    vi.advanceTimersByTime(5120);
    expect(shown()).toEqual([]);
  });

  it('a toast of a lower rank waits its turn behind the one on screen', () => {
    toast('Oops', { type: 'error', duration: 1000 });
    toast('FYI', { type: 'info', duration: 1000 });
    vi.advanceTimersByTime(500);
    expect(shown()).toEqual(['Oops']);
    vi.advanceTimersByTime(500 + 120);
    expect(shown()).toEqual(['FYI']);
  });

  it('a toast of the type on screen replaces it; a queued one of the same type is replaced in place', () => {
    toast('First error', { type: 'error', duration: 1000 });
    toast('Second error', { type: 'error', duration: 1000 });
    expect(shown()).toEqual(['Second error']);
    toast('Info 1', { type: 'info' });
    toast('Info 2', { type: 'info' });
    expect(toastQueueLength()).toBe(2);
    vi.advanceTimersByTime(1120);
    expect(shown()).toEqual(['Info 2']);
  });

  it('errors are announced assertively, the rest politely, by a persistent announcer pair (the card has no live role); all in one region above the table', () => {
    const e = toast('Oops', { type: 'error' });
    expect(e.getAttribute('role')).toBeNull();
    expect(e.getAttribute('aria-live')).toBeNull();
    const region = document.getElementById('kit-toast-region');
    expect(region.contains(e)).toBe(true);
    const { polite, assertive } = toastAnnouncers();
    expect(assertive.getAttribute('role')).toBe('alert');
    expect(assertive.getAttribute('aria-atomic')).toBe('true');
    expect(polite.getAttribute('role')).toBe('status');
    expect(polite.getAttribute('aria-live')).toBe('polite');
    // set a moment after it was cleared, so the reader hears the change
    expect(assertive.textContent).toBe('');
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    expect(assertive.textContent).toBe('Oops');
    expect(polite.textContent).toBe('');
    // the same announcers, never a new pair per toast
    vi.advanceTimersByTime(5200);
    toast('Hello', { type: 'info' });
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    expect(toastAnnouncers().polite).toBe(polite);
    expect(polite.textContent).toBe('Hello');
    expect(assertive.textContent).toBe('');
    expect(region.querySelectorAll('.kit-toast-announcer')).toHaveLength(2);
    expect(css).toMatch(/\.kit-toast-region \{[^}]*z-index: var\(--z-toast\)/);
  });

  it('the announcers are emptied when their toast goes (timed out or tapped), so no stale words linger in the region; a pending announcement goes with it', () => {
    toast('Not your turn.', { type: 'warning', duration: 3000 });
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    const { polite, assertive } = toastAnnouncers();
    expect(polite.textContent).toBe('Not your turn.');
    vi.advanceTimersByTime(3000 + 120);
    expect(shown()).toEqual([]);
    expect(polite.textContent).toBe('');

    const e = toast('Oops', { type: 'error' });
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    expect(assertive.textContent).toBe('Oops');
    e.click();
    vi.advanceTimersByTime(120);
    expect(assertive.textContent).toBe('');

    // tapped before its words were set: they are never set
    const f = toast('Quick', { type: 'info' });
    f.click();
    vi.advanceTimersByTime(200);
    expect(polite.textContent).toBe('');
  });

  it('a preempted toast leaving keeps the words of the one that replaced it', () => {
    toast('Saved', { type: 'success' });
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    toast('Sign-in failed!', { type: 'error' });
    vi.advanceTimersByTime(120 + ANNOUNCE_DELAY_MS);
    expect(shown()).toEqual(['Sign-in failed!']);
    expect(toastAnnouncers().assertive.textContent).toBe('Sign-in failed!');
  });

  it('{announce: false} shows the toast without speaking it', () => {
    toast('Already said', { type: 'warning', announce: false });
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    expect(toastAnnouncers().polite.textContent).toBe('');
    expect(shown()).toEqual(['Already said']);
  });

  it('each type has its aria-hidden icon before the text; the text is exactly the message, and replacing it keeps the icon', () => {
    for (const type of ['info', 'success', 'warning', 'error']) {
      clearToasts();
      const t = toast(`${type} words`, { type });
      const icon = t.querySelector('.kit-toast__icon');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.querySelector('svg')).toBeTruthy();
      expect(t.firstElementChild).toBe(icon);
      expect(t.textContent).toBe(`${type} words`);
      expect(t.classList.contains(`toast-${type}`)).toBe(true);
    }
    const t = toast('newer error', { type: 'error' });
    expect(t.querySelector('.kit-toast__icon')).toBeTruthy();
    expect(t.textContent).toBe('newer error');
  });

  it('a tap dismisses the toast on screen and the next one shows', () => {
    const first = toast('Tap me', { type: 'warning' });
    toast('Waiting', { type: 'info' });
    first.click();
    vi.advanceTimersByTime(130);
    expect(shown()).toEqual(['Waiting']);
    expect(toastQueueLength()).toBe(1);
  });

  it('the same words again restart the timer, nudge the toast and say it again; five quick repeats leave one toast', () => {
    const t = toast('Must follow suit.', { type: 'warning', duration: TOAST_SHORT });
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    expect(toastAnnouncers().polite.textContent).toBe('Must follow suit.');
    vi.advanceTimersByTime(2500);
    for (let i = 0; i < 4; i++) toast('Must follow suit.', { type: 'warning', duration: TOAST_SHORT });
    expect(toastQueueLength()).toBe(1);
    expect(t.classList.contains('is-nudged')).toBe(true);
    // cleared, then said again a moment later
    expect(toastAnnouncers().polite.textContent).toBe('');
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
    expect(toastAnnouncers().polite.textContent).toBe('Must follow suit.');
    // the 3 s started again at the last repeat
    vi.advanceTimersByTime(2800);
    expect(shown()).toEqual(['Must follow suit.']);
    vi.advanceTimersByTime(400);
    expect(shown()).toEqual([]);
  });

  it('a long message in a short slot stays long enough to read (about 1 s per 12 words)', () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    toast(long, { type: 'info', duration: TOAST_SHORT });
    vi.advanceTimersByTime(4000);
    expect(shown()).toEqual([long]);
    vi.advanceTimersByTime(1200);
    expect(shown()).toEqual([]);
  });

  it('kit.css: a pill at the top centre under the safe area (below the connection banner when it shows), no left border, reduced motion stops the slide and the nudge', () => {
    const rule = (sel) => {
      const i = css.indexOf(`${sel} {`);
      expect(i, sel).toBeGreaterThan(-1);
      return css.slice(i, css.indexOf('}', i));
    };
    expect(rule('.kit-toast-region')).toMatch(/top: calc\(env\(safe-area-inset-top, 0px\)/);
    expect(rule('.kit-toast-region')).toMatch(/bottom: auto/);
    expect(rule('body.has-connection-banner .kit-toast-region')).toMatch(/--connection-banner-h/);
    expect(rule('.kit-toast')).not.toMatch(/border-left/);
    expect(rule('.kit-toast')).toMatch(/border-radius: 22px/);
    expect(rule('.kit-toast')).toMatch(/cursor: pointer/);
    expect(rule('.kit-toast.toast-warning')).toMatch(/var\(--warning\)/);
    expect(rule('.kit-toast.toast-error')).toMatch(/var\(--danger-text\)/);
    expect(rule('.kit-toast')).toMatch(/--toast-accent: var\(--team-a\)/);
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.kit-toast,/);
    expect(reduced).toMatch(/\.kit-toast\.is-nudged/);
    expect(reduced).toMatch(/animation: none/);
    // the slide comes from above
    expect(css).toMatch(/@keyframes kit-toast-in \{\s*from \{ opacity: 0; transform: translateY\(-8px\); \}/);
  });

  it('under reduced motion the toast leaves without a fade', () => {
    setReducedMotionOverride(true);
    toast('A', { type: 'info', duration: 500 });
    toast('B', { type: 'success', duration: 500 });
    vi.advanceTimersByTime(500);
    expect(shown()).toEqual(['B']);
    // and a preempting error replaces the one on screen in the same task
    toast('C', { type: 'error', duration: 500 });
    expect(shown()).toEqual(['C']);
  });
});
