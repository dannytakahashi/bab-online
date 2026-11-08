/**
 * Game pacing: the ONLY home of the server's presentation delays (how long
 * the table is held so people can see what happened, and how long bots
 * "think"). Safety timers (reconnect grace, abandon, draw watchdog) live in
 * SeatState.js and are not pacing.
 *
 * Consumers read `pacing(game).X` at call time; never destructure at import
 * (tests and the ambient overlay swap the active values).
 *
 * Profiles (env BAB_PACING):
 *   standard (default)  the tuned values below
 *   legacy              the values before the retune (owner rollback knob)
 *   fast                dev only: every value at its floor (ignored, with a
 *                       warning, when NODE_ENV=production)
 *   zero                tests only (throws unless NODE_ENV=test)
 *
 * Bot think ranges are [min, span] pairs: delay = min + r * span, with one
 * Math.random() per action (BotPlayer.getActionDelay).
 *
 * Resume semantics: a hold (GameState.hold / scheduleResume) sets
 * game.resume = {kind, at}; the wire carries the remaining time as a
 * relative `resumeInMs` (contract/README.md), never an absolute time.
 */

'use strict';

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** The values before the retune (df59149). */
const LEGACY = {
    LOBBY_START_MS: 1500,
    PREDRAW_COUNTDOWN_MS: 2000,
    BOT_DRAW_STAGGER_MS: 800,
    BOT_DRAW: [500, 500],
    DRAW_REVEAL_MS: 1000,
    SEATING_TO_TEAMS_MS: 1000,
    TEAMS_MS: 3000,
    FIRST_HAND_TURN_MS: 1000,
    BOT_FIRST_BID: [1000, 1000],
    BOT_BID: [1000, 1000],
    BOT_LEAD_AFTER_BIDDING: [800, 700],
    BOT_PLAY: [800, 700],
    BOT_FORCED_PLAY: [800, 700],
    BOT_LEAD_AFTER_TRICK: [800, 700],
    TRICK_VIEW_MS: 2000,
    HAND_END_MS: 2000,
    GAME_END_MS: 2000,
    BOT_TRUMP_QUIP_MS: 5000,
    BOT_CHAT: [500, 500],
    ROUND_ANNOUNCE_MS: 1500,
    TABLE_COUNTDOWN_MS: 2000,
    AMBIENT_CHECK_MS: 15000,
    AMBIENT_RESTART_MS: 30000,
};

const STANDARD = { ...LEGACY };

const ZERO = Object.fromEntries(Object.entries(LEGACY).map(([k, v]) => [k, Array.isArray(v) ? [0, 0] : 0]));
// The ambient poll must stay a real interval (0 would spin)
ZERO.AMBIENT_CHECK_MS = 1;

const PROFILES = {
    standard: STANDARD,
    legacy: LEGACY,
    zero: ZERO,
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const isTest = () => process.env.NODE_ENV === 'test';
const freeze = (p) => Object.freeze(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Array.isArray(v) ? Object.freeze([...v]) : v])));

function profileFromEnv() {
    const name = process.env.BAB_PACING || 'standard';
    if (name === 'zero' && !isTest()) throw new Error('BAB_PACING=zero is test-only');
    if (name === 'fast' && process.env.NODE_ENV === 'production') {
        // eslint-disable-next-line no-console
        console.warn('BAB_PACING=fast is ignored in production; using standard');
        return PROFILES.standard;
    }
    if (!PROFILES[name]) {
        // eslint-disable-next-line no-console
        console.warn(`Unknown BAB_PACING=${name}; using standard`);
        return PROFILES.standard;
    }
    return PROFILES[name];
}

let active = null;

/**
 * The active pacing values (frozen).
 * @param {Object} [game] - accepted for the per-game overlay (ambient demo
 *   games before the deal)
 */
function pacing(game) { // eslint-disable-line no-unused-vars
    if (!active) active = freeze(profileFromEnv());
    return active;
}

/** Test-only: switch to a named profile, or the active one with overrides. */
function setPacingForTests(nameOrOverrides) {
    if (!isTest()) throw new Error('setPacingForTests is test-only');
    if (typeof nameOrOverrides === 'string') {
        if (!PROFILES[nameOrOverrides]) throw new Error(`Unknown pacing profile ${nameOrOverrides}`);
        active = freeze(PROFILES[nameOrOverrides]);
    } else {
        active = freeze({ ...pacing(), ...nameOrOverrides });
    }
    return active;
}

/** Test-only: back to the env-selected profile (server/testUtils/pacingReset.js). */
function resetPacing() {
    if (!isTest()) throw new Error('resetPacing is test-only');
    active = null;
    tracer = null;
}

/** delay = min + r * span for a [min, span] range. */
function fromRange(range, r) {
    return range[0] + r * range[1];
}

// ---------------------------------------------------------------------------
// Trace hook (server/socket/__tests__/pacingBudget.test.js): every hold and
// every bot schedule reports (kind, ms). A null check in production.
// ---------------------------------------------------------------------------

let tracer = null;

function trace(kind, ms, game = null) {
    if (tracer) tracer(kind, ms, game);
}

function setTracer(fn) {
    if (!isTest()) throw new Error('setTracer is test-only');
    tracer = fn;
}

pacing.PROFILES = PROFILES;
pacing.setPacingForTests = setPacingForTests;
pacing.resetPacing = resetPacing;
pacing.fromRange = fromRange;
pacing.trace = trace;
pacing.setTracer = setTracer;

module.exports = pacing;
