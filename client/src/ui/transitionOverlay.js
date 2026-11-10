/**
 * The black #transition-overlay between the teams screen and the first deal
 * (DrawManager.handleTeamsAnnounced fades it in, GameScene.handleCreateUI
 * fades it out). It sits above everything (z-index 99999), so any path that
 * leaves the draw without createUI's fade (abort, leave, rejoin, reconnect
 * failure) must remove it, or the player is left on a black screen.
 */

export const TRANSITION_OVERLAY_ID = 'transition-overlay';

// Bumped by every removal: a deal that waits for createUI's fade
// ('gameUIReady') checks it, so a fade cut short by a rejoin or an exit
// never replays that deal into a later game's fade
let generation = 0;

export function transitionGeneration() {
  return generation;
}

export function getTransitionOverlay() {
  return window._transitionOverlay || document.getElementById(TRANSITION_OVERLAY_ID);
}

/**
 * Remove every transition overlay and forget the global handle.
 * @returns {boolean} whether one was removed
 */
export function removeTransitionOverlay() {
  let removed = false;
  if (window._transitionOverlay) {
    window._transitionOverlay.remove();
    removed = true;
  }
  document.querySelectorAll(`#${TRANSITION_OVERLAY_ID}`).forEach((el) => {
    el.remove();
    removed = true;
  });
  window._transitionOverlay = null;
  generation++;
  return removed;
}
