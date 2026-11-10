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
 * Create the overlay (opacity 0 with a CSS transition, or already opaque).
 * @param {Object} [options]
 * @param {number} [options.opacity=0]
 * @param {number} [options.transitionMs] - CSS opacity transition
 * @param {boolean} [options.blocking=false] - pointer-events all
 */
export function createTransitionOverlay({ opacity = 0, transitionMs, blocking = false } = {}) {
  const el = document.createElement('div');
  el.id = TRANSITION_OVERLAY_ID;
  el.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: black;
    opacity: ${opacity};
    z-index: 99999;
    pointer-events: ${blocking ? 'all' : 'none'};
    ${transitionMs ? `transition: opacity ${transitionMs}ms ease-out;` : ''}
  `;
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
