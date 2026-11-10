import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getTransitionOverlay, removeTransitionOverlay, transitionGeneration, TRANSITION_OVERLAY_ID,
  createTransitionOverlay, releaseTransitionOverlay, onTransitionRemoved,
} from './transitionOverlay.js';

function strayOverlay() {
  const el = document.createElement('div');
  el.id = TRANSITION_OVERLAY_ID;
  document.body.appendChild(el);
  return el;
}

describe('transition overlay', () => {
  afterEach(() => {
    document.querySelectorAll(`#${TRANSITION_OVERLAY_ID}`).forEach((el) => el.remove());
  });

  it('removes the overlay it created and any stray copy, and bumps the generation', () => {
    const a = createTransitionOverlay({ opacity: 0, transitionMs: 800 });
    const b = strayOverlay();
    const gen = transitionGeneration();
    expect(getTransitionOverlay()).toBe(a);
    expect(a.style.transition).toContain('800ms');
    expect(removeTransitionOverlay()).toBe(true);
    expect([a.isConnected, b.isConnected]).toEqual([false, false]);
    expect(getTransitionOverlay()).toBeNull();
    expect(transitionGeneration()).toBe(gen + 1);
    // no window global any more
    expect(window._transitionOverlay).toBeUndefined();
  });

  it('is a no-op without an overlay (but still invalidates waiting deals)', () => {
    const gen = transitionGeneration();
    expect(removeTransitionOverlay()).toBe(false);
    expect(transitionGeneration()).toBe(gen + 1);
  });

  it('tells its listeners about every removal (the director cancels the fade gate)', () => {
    const fn = vi.fn();
    const off = onTransitionRemoved(fn);
    removeTransitionOverlay();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    removeTransitionOverlay();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a finished fade releases its own overlay without a generation bump', () => {
    const el = createTransitionOverlay({ opacity: 1, blocking: true });
    expect(el.style.pointerEvents).toBe('all');
    const gen = transitionGeneration();
    releaseTransitionOverlay(el);
    expect(el.isConnected).toBe(false);
    expect(getTransitionOverlay()).toBeNull();
    expect(transitionGeneration()).toBe(gen);
  });
});
