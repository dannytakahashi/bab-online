/**
 * The over-the-shoulder view's own bit of the table HUD (state/shoulder.js;
 * docs/claude/spectators.md "Over-the-shoulder view"), read-only:
 *
 *   .hud-shoulder-paused  the watched hand area while the table is paused
 *                         (no stale cards): "Paused: Alice's hand comes back
 *                         when the game resumes."
 *
 * (The watched seat's bid clock is its read-only bid sheet's countdown:
 * BidManager readOnly, owner 2026-11-21; the earlier pill is gone.)
 *
 * syncShoulderHud(state) is a projection of GameState (idempotent); the
 * scene calls it on every render, turn change and seat-plate update.
 */
import { hudRoot, getHud } from '../tableHud.js';
import { isShoulder, pausedText } from '../../state/shoulder.js';

let pausedEl = null;

/**
 * Draw the shoulder view's paused area from the state.
 * @param {Object} s - GameState
 */
export function syncShoulderHud(s) {
  if (typeof document === 'undefined' || !s || !getHud({ create: false })) return;
  const paused = isShoulder(s) && s.shoulder.paused;
  if (paused) {
    if (!pausedEl || !pausedEl.isConnected) {
      pausedEl = document.createElement('div');
      pausedEl.className = 'hud-shoulder-paused';
      pausedEl.setAttribute('role', 'status');
      hudRoot().appendChild(pausedEl);
    }
    pausedEl.textContent = pausedText((s.getSeatOwnerName?.(s.shoulder.position) ?? s.getPlayerNameByPosition?.(s.shoulder.position)) || '');
  } else {
    pausedEl?.remove();
    pausedEl = null;
  }
}

/** Take it down (the table goes; tests). */
export function clearShoulderHud() {
  pausedEl?.remove();
  pausedEl = null;
}

/** What is up (tests): {paused: text|null}. */
export function shoulderHudState() {
  return { paused: pausedEl?.isConnected ? pausedEl.textContent : null };
}
