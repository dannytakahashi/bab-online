/**
 * The component kit (item 18a): buttons by variant (a primary is never
 * red), the icon button's 44 px target, the Modal's focus trap / Escape /
 * focus restore, and the one Toast queue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readClientFile } from '../../testing/files.js';
import { createButton, createIconButton, createChip, createAvatar, setAvatarTurn, openModal, openModalCount, toast, clearToasts, toastQueueLength } from './index.js';
import { setReducedMotionOverride } from '../motion.js';

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

  it('errors are announced assertively, the rest politely; all in one region above the table', () => {
    const e = toast('Oops', { type: 'error' });
    expect(e.getAttribute('role')).toBe('alert');
    const region = document.getElementById('kit-toast-region');
    expect(region.contains(e)).toBe(true);
    expect(css).toMatch(/\.kit-toast-region \{[^}]*z-index: var\(--z-toast\)/);
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
