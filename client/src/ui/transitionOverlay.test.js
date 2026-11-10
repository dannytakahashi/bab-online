import { describe, it, expect, afterEach } from 'vitest';
import { getTransitionOverlay, removeTransitionOverlay, transitionGeneration, TRANSITION_OVERLAY_ID } from './transitionOverlay.js';

function addOverlay({ global = true } = {}) {
  const el = document.createElement('div');
  el.id = TRANSITION_OVERLAY_ID;
  document.body.appendChild(el);
  if (global) window._transitionOverlay = el;
  return el;
}

describe('transition overlay', () => {
  afterEach(() => {
    document.querySelectorAll(`#${TRANSITION_OVERLAY_ID}`).forEach((el) => el.remove());
    window._transitionOverlay = null;
  });

  it('removes the global overlay and any stray copy, and bumps the generation', () => {
    const a = addOverlay();
    const b = addOverlay({ global: false });
    const gen = transitionGeneration();
    expect(getTransitionOverlay()).toBe(a);
    expect(removeTransitionOverlay()).toBe(true);
    expect([a.isConnected, b.isConnected, window._transitionOverlay]).toEqual([false, false, null]);
    expect(getTransitionOverlay()).toBeNull();
    expect(transitionGeneration()).toBe(gen + 1);
  });

  it('is a no-op without an overlay (but still invalidates waiting deals)', () => {
    const gen = transitionGeneration();
    expect(removeTransitionOverlay()).toBe(false);
    expect(transitionGeneration()).toBe(gen + 1);
  });
});
