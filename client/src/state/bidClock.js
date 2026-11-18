/**
 * The bid clock on the web client (owner 2026-11-18; server
 * server/socket/bidClock.js, wire contract/README.md "Bid clock"): a human
 * seat that has not bid 10 s into its bid turn gets a clock (the room event
 * bidClock, unsequenced; snapshot v2 bidClock while it runs); when it runs
 * out the server bids 0 for the seat.
 *
 * GameState.bidClock = {position, deadline, durationMs} or null, where
 * deadline is this page's monotonic clock (bidClockNow) at receipt + inMs:
 * relative time, never compared with a wall clock. Readers:
 *   - audio/tableSounds.js: the tune, END-aligned with the deadline (its end
 *     cue lands on the server's bid 0), for everyone at the table
 *   - phaser/managers/BidManager.js: the bidder's countdown, against
 *     deadline - BID_CLOCK_UI_MARGIN_MS (the receipt is late by the one-way
 *     delay, so a bid made with "1" showing could otherwise reach the server
 *     after it already bid 0)
 *
 * Imports nothing: safe anywhere.
 */

/** The countdown ends this long before the local deadline (critic C2). */
export const BID_CLOCK_UI_MARGIN_MS = 750;
/** The countdown turns to the warning colour at this many seconds. */
export const BID_CLOCK_LOW_S = 10;
/** A countdown at 0 with no word from the server: the bid is offered again this long after (the server did not time out). */
export const BID_CLOCK_EXPIRED_GRACE_MS = 5000;
/** The tune's file (scripts/build-sounds.py, sounds-src/sounds.json). */
export const BID_CLOCK_SOUND = 'bidclock';
/** A tune within this of where it should be keeps playing (no restart: a resync does not stutter). */
export const TUNE_RESYNC_MS = 750;
/** Less than this left: the tune is not started. */
export const TUNE_MIN_START_MS = 1000;
/** A timeout's stop lets the tune ring out if at most this much of it is left locally. */
export const TUNE_RING_MAX_MS = 1500;
/** Every other stop fades out over this (seconds). */
export const TUNE_FADE_S = 0.12;

const defaultNow = () => globalThis.performance?.now?.() ?? Date.now();
let nowImpl = defaultNow;

/** The page's monotonic clock in ms (performance.now). */
export function bidClockNow() {
  return nowImpl();
}

/** Tests: a clock to use instead (null puts performance.now back). */
export function setBidClockNow(fn) {
  nowImpl = typeof fn === 'function' ? fn : defaultNow;
}

const isPos = (v) => Number.isInteger(v) && v >= 1 && v <= 4;

/**
 * A snapshot's bidClock {position, inMs, durationMs}: valid or not.
 * @returns {boolean}
 */
export function validBidClock(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && isPos(raw.position) &&
    Number.isInteger(raw.inMs) && raw.inMs >= 0 && Number.isInteger(raw.durationMs) && raw.durationMs >= 1;
}

/**
 * A bidClock event, checked: {gameId, position, running: true, inMs,
 * durationMs} or {gameId, position, running: false, reason}; null when
 * malformed.
 */
export function parseBidClockEvent(data) {
  if (!data || typeof data !== 'object' || !isPos(data.position)) return null;
  const gameId = typeof data.gameId === 'string' ? data.gameId : null;
  if (data.running === true) {
    if (!validBidClock(data)) return null;
    return { gameId, position: data.position, running: true, inMs: data.inMs, durationMs: data.durationMs };
  }
  if (data.running === false) {
    return { gameId, position: data.position, running: false, reason: typeof data.reason === 'string' ? data.reason : null };
  }
  return null;
}

/** The state's clock from a relative {position, inMs, durationMs} received at `now`. */
export function clockFrom({ position, inMs, durationMs }, now = bidClockNow()) {
  return { position, deadline: now + inMs, durationMs };
}

/** ms until the countdown reaches 0 (the margin before the deadline); negative once past. */
export function countdownMs(clock, now = bidClockNow()) {
  return clock.deadline - BID_CLOCK_UI_MARGIN_MS - now;
}

/** Whole seconds the countdown shows (ceil, never below 0). */
export function countdownSeconds(clock, now = bidClockNow()) {
  return Math.max(0, Math.ceil(countdownMs(clock, now) / 1000));
}
