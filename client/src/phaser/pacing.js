/**
 * Animation timing sized to the server's resume holds (server/game/pacing.js,
 * contract/README.md "Resume holds"). `resumeInMs` is how long the server
 * holds the table from emission; it is measured from receipt and never
 * compared with a clock. Every function falls back to the fixed durations
 * when the field is missing (an older server, a replayed event).
 */

import { ANIMATION_CONFIG } from './config.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Fly-in of a played card. The card that completes a trick carries
 * resumeInMs (time until trickComplete collects it): it lands within a
 * quarter of the hold, so the full trick stays visible even after an owner
 * retune shortens the hold.
 */
export function flyInMs(resumeInMs) {
  if (!finite(resumeInMs)) return ANIMATION_CONFIG.CARD_PLAY;
  return Math.min(ANIMATION_CONFIG.CARD_PLAY, Math.max(120, resumeInMs / 4));
}

/** Opponent card flip: delay, shrink, grow (ms). */
export const FLIP = Object.freeze({ DELAY: 30, HALF: 120 });

/**
 * Trick collect. Only a hand's last trickComplete carries resumeInMs (time
 * until handComplete): the collect fits in half of it.
 */
export function collectMs(resumeInMs) {
  if (!finite(resumeInMs)) return ANIMATION_CONFIG.CARD_COLLECT;
  return Math.min(ANIMATION_CONFIG.CARD_COLLECT, Math.max(150, resumeInMs / 2));
}

/**
 * Team announcement fade to black, ending when createUI arrives (the server
 * holds the announcement resumeInMs; 3000 before the field existed).
 * @returns {{fadeDelay: number, fadeDuration: number}}
 */
export function teamsFade(resumeInMs) {
  const inMs = finite(resumeInMs) ? Math.max(0, resumeInMs) : 3000;
  const fadeDuration = Math.min(1000, Math.max(300, Math.round(inMs / 3)));
  return { fadeDelay: Math.max(0, inMs - fadeDuration), fadeDuration };
}
