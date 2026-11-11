/**
 * The black #transition-overlay between the teams screen and the first deal
 * (DrawManager.handleTeamsAnnounced fades it in, GameScene.handleCreateUI
 * fades it out). It sits above everything (z-index 99999), so any path that
 * leaves the draw without createUI's fade (abort, leave, rejoin, reconnect
 * failure) must remove it, or the player is left on a black screen.
 *
 * The handle lives in this module (no window global). Whether the first
 * deal waits for the fade is the TableDirector's business (uiReady); a
 * removal tells it through onTransitionRemoved.
 */

export const TRANSITION_OVERLAY_ID = 'transition-overlay';

// Bumped by every removal: a fade-out that finishes after a rejoin or an
// exit removed its overlay checks it and does nothing
let generation = 0;
let current = null;
const removalListeners = new Set();

export function transitionGeneration() {
  return generation;
}

export function getTransitionOverlay() {
  if (current && current.isConnected) return current;
  return document.getElementById(TRANSITION_OVERLAY_ID);
}

/**
 * The overlay's state (table.css .transition-overlay, z-index token
 * 'transition'): opaque or clear, blocking the page or not, and how long
 * the opacity fade takes (--overlay-ms; 0: at once). The fade durations are
 * game pacing (phaser/pacing.js teamsFade, createUI's fade-out), not tokens.
 * @param {HTMLElement} el
 * @param {Object} state
 * @param {boolean} [state.opaque]
 * @param {boolean} [state.blocking]
 * @param {number} [state.ms] - the opacity transition (0 or none: instant)
 */
export function setOverlayState(el, { opaque, blocking, ms } = {}) {
  if (!el) return el;
  if (ms !== undefined) {
    el.style.setProperty('--overlay-ms', `${Math.max(0, ms || 0)}ms`);
    el.classList.toggle('is-instant', !(ms > 0));
  }
  if (blocking !== undefined) el.classList.toggle('is-blocking', !!blocking);
  if (opaque !== undefined) el.classList.toggle('is-opaque', !!opaque);
  return el;
}

/** The overlay's current opacity state (true: black). */
export function isOverlayOpaque(el) {
  return !!el?.classList.contains('is-opaque');
}

/**
 * Create the overlay (clear with a fade, or already opaque).
 * @param {Object} [options]
 * @param {number} [options.opacity=0] - 0 clear, 1 opaque
 * @param {number} [options.transitionMs] - its opacity fade
 * @param {boolean} [options.blocking=false] - pointer-events all
 */
export function createTransitionOverlay({ opacity = 0, transitionMs, blocking = false } = {}) {
  const el = document.createElement('div');
  el.id = TRANSITION_OVERLAY_ID;
  el.className = 'transition-overlay';
  setOverlayState(el, { opaque: opacity >= 1, blocking, ms: transitionMs || 0 });
  document.body.appendChild(el);
  current = el;
  return el;
}

/** The overlay finished its own fade-out: forget it (no generation bump). */
export function releaseTransitionOverlay(el) {
  el?.remove();
  if (current === el) current = null;
}

/** Called with no arguments after every removeTransitionOverlay. */
export function onTransitionRemoved(fn) {
  removalListeners.add(fn);
  return () => removalListeners.delete(fn);
}

/**
 * Remove every transition overlay and forget the handle.
 * @returns {boolean} whether one was removed
 */
export function removeTransitionOverlay() {
  let removed = false;
  if (current) {
    if (current.isConnected) removed = true;
    current.remove();
  }
  document.querySelectorAll(`#${TRANSITION_OVERLAY_ID}`).forEach((el) => {
    el.remove();
    removed = true;
  });
  current = null;
  generation++;
  removalListeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.error('transition overlay listener failed', err);
    }
  });
  return removed;
}
