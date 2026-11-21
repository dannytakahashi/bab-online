/**
 * The over-the-shoulder view's own bits of the table HUD (state/shoulder.js;
 * docs/claude/spectators.md "Over-the-shoulder view"), read-only:
 *
 *   .hud-shoulder-clock   the watched seat's bid clock while it bids: a pill
 *                         where the bid sheet would be ("Alice is bidding ·
 *                         23"), whole seconds as the bidder's own countdown
 *                         (countdownMs: its margin; --warning for the last
 *                         BID_CLOCK_LOW_S); there is no bid sheet for a
 *                         watcher (owner 2026-11-21)
 *   .hud-shoulder-paused  the watched hand area while the table is paused
 *                         (no stale cards): "Paused: Alice's hand comes back
 *                         when the game resumes."
 *
 * syncShoulderHud(state) is a projection of GameState (idempotent); the
 * scene calls it on every render, turn change and bid clock change.
 */
import { hudRoot, getHud } from '../tableHud.js';
import { isShoulder, pausedText, possessive } from '../../state/shoulder.js';
import { countdownMs, bidClockNow, BID_CLOCK_LOW_S } from '../../state/bidClock.js';

let clockEl = null;
let pausedEl = null;
let timer = null;

function node(cls) {
  const e = document.createElement('div');
  e.className = cls;
  hudRoot().appendChild(e);
  return e;
}

function clearTimer() {
  clearTimeout(timer);
  timer = null;
}

/** The watched seat's running clock, while that seat is still to bid. */
function watchedClock(s) {
  if (!isShoulder(s) || s.shoulder.paused) return null;
  const clock = s.bidClock;
  if (!clock || clock.position !== s.shoulder.position || !s.isBidding) return null;
  if (s.bids?.[clock.position] !== undefined) return null;
  return clock;
}

function tick(s) {
  clearTimer();
  const clock = watchedClock(s);
  if (!clock) {
    clockEl?.remove();
    clockEl = null;
    return;
  }
  const ms = countdownMs(clock, bidClockNow());
  if (ms <= 0) {
    clockEl?.remove();
    clockEl = null;
    return;
  }
  const secs = Math.ceil(ms / 1000);
  if (!clockEl || !clockEl.isConnected) {
    clockEl = node('hud-shoulder-clock');
    clockEl.setAttribute('role', 'timer');
  }
  const name = s.getPlayerNameByPosition?.(clock.position) || '';
  clockEl.textContent = `${name} is bidding · ${secs}`;
  clockEl.setAttribute('aria-label', `${possessive(name)} bid: ${secs} seconds left`);
  clockEl.classList.toggle('is-low', secs <= BID_CLOCK_LOW_S);
  timer = setTimeout(() => tick(s), ms - (secs - 1) * 1000 + 1);
}

/**
 * Draw the shoulder view's clock pill and paused area from the state.
 * @param {Object} s - GameState
 */
export function syncShoulderHud(s) {
  if (typeof document === 'undefined' || !s || !getHud({ create: false })) return;
  const paused = isShoulder(s) && s.shoulder.paused;
  if (paused) {
    if (!pausedEl || !pausedEl.isConnected) {
      pausedEl = node('hud-shoulder-paused');
      pausedEl.setAttribute('role', 'status');
    }
    pausedEl.textContent = pausedText(s.getPlayerNameByPosition?.(s.shoulder.position) || '');
  } else {
    pausedEl?.remove();
    pausedEl = null;
  }
  tick(s);
}

/** Take it all down (the table goes; tests). */
export function clearShoulderHud() {
  clearTimer();
  clockEl?.remove();
  pausedEl?.remove();
  clockEl = null;
  pausedEl = null;
}

/** What is up (tests): {clock: text|null, paused: text|null}. */
export function shoulderHudState() {
  return {
    clock: clockEl?.isConnected ? clockEl.textContent : null,
    paused: pausedEl?.isConnected ? pausedEl.textContent : null,
  };
}
