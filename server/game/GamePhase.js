/**
 * Authoritative server game phase FSM.
 *
 * GameState holds the current stage in `_stage` and only changes it through
 * transition() / tryTransition() / terminate(). The table below lists every
 * legal edge; ENDED and ABORTED are absorbing (no ENDED -> ABORTED: the iOS
 * client resets its game on abortGame, so it must never follow gameEnd).
 *
 * v1 payloads never see stage names: `game.phase` and `game.bidding` are
 * getters that project the stage onto the legacy values both clients read
 * (WIRE_PHASE / NOT_BIDDING below), so getClientState, spectatorJoined and
 * every other v1 payload are unchanged. Snapshot v2 (snapshotV2.js) carries
 * `stage` verbatim: renaming a stage breaks v2 clients.
 */

const { gameLogger } = require('../utils/logger');

const Phase = Object.freeze({
    CREATED: 'CREATED',
    DRAWING: 'DRAWING',
    DRAW_RESOLVING: 'DRAW_RESOLVING',
    TEAMS_ANNOUNCED: 'TEAMS_ANNOUNCED',
    DEALING: 'DEALING',
    BIDDING: 'BIDDING',
    REDEAL: 'REDEAL',
    PLAYING: 'PLAYING',
    TRICK_RESOLVING: 'TRICK_RESOLVING',
    HAND_RESOLVING: 'HAND_RESOLVING',
    ENDED: 'ENDED',
    ABORTED: 'ABORTED'
});

const A = Phase.ABORTED;

// 23 legal edges: 13 forward + 10 aborts (every non-terminal stage may abort).
// ENDED is reachable only from HAND_RESOLVING.
const TRANSITIONS = Object.freeze({
    CREATED: Object.freeze([Phase.DRAWING, A]),
    DRAWING: Object.freeze([Phase.DRAW_RESOLVING, A]),
    DRAW_RESOLVING: Object.freeze([Phase.TEAMS_ANNOUNCED, A]),
    TEAMS_ANNOUNCED: Object.freeze([Phase.DEALING, A]),
    DEALING: Object.freeze([Phase.BIDDING, A]),
    BIDDING: Object.freeze([Phase.PLAYING, Phase.REDEAL, A]),
    REDEAL: Object.freeze([Phase.DEALING, A]),
    PLAYING: Object.freeze([Phase.TRICK_RESOLVING, A]),
    TRICK_RESOLVING: Object.freeze([Phase.PLAYING, Phase.HAND_RESOLVING, A]),
    HAND_RESOLVING: Object.freeze([Phase.DEALING, Phase.ENDED, A]),
    ENDED: Object.freeze([]),
    ABORTED: Object.freeze([])
});

// Legacy wire value of `phase` (getClientState, spectatorJoined, toJSON).
// The legacy server never sent 'playing': phase stayed 'bidding' through play.
const WIRE_PHASE = Object.freeze({
    CREATED: 'waiting',
    DRAWING: 'drawing',
    DRAW_RESOLVING: 'drawing',
    TEAMS_ANNOUNCED: 'drawing',
    DEALING: 'bidding',
    BIDDING: 'bidding',
    REDEAL: 'bidding',
    PLAYING: 'bidding',
    TRICK_RESOLVING: 'bidding',
    HAND_RESOLVING: 'bidding',
    ENDED: 'waiting',
    ABORTED: 'waiting'
});

// Wire `bidding` is false only in these stages (true before the deal, as the
// legacy constructor default was)
const NOT_BIDDING = new Set([Phase.REDEAL, Phase.PLAYING, Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING]);

// Stages in which a socket mapped to the game may not hold a seat yet
const PRE_SEATING = new Set([Phase.CREATED, Phase.DRAWING, Phase.DRAW_RESOLVING]);

const isTerminal = (p) => p === Phase.ENDED || p === Phase.ABORTED;
const isLegal = (from, to) => TRANSITIONS[from]?.includes(to) === true;

// Read at call time so tests (and BAB_FSM_STRICT=1 in staging) throw on a
// violation; production logs and fails closed
const isStrict = () => process.env.NODE_ENV === 'test' || process.env.BAB_FSM_STRICT === '1';
const shouldCheckInvariants = () => process.env.BAB_FSM_CHECK === '1';

// Shared across jest.resetModules() so the per-test guard sees violations
// recorded by a re-required copy of this module
const VIOLATIONS_KEY = '__babFsmViolations';
if (!Array.isArray(globalThis[VIOLATIONS_KEY])) globalThis[VIOLATIONS_KEY] = [];
const violations = globalThis[VIOLATIONS_KEY];

/**
 * Record an FSM violation (illegal transition, legacy flag write, broken
 * invariant). Logged always; thrown in strict mode.
 */
function reportViolation(kind, details = {}) {
    const err = new Error(`FSM ${kind}: ${JSON.stringify(details)}`);
    violations.push({ kind, ...details, stack: err.stack });
    gameLogger.error('FSM violation', { kind, ...details });
    if (isStrict()) throw err;
}

module.exports = {
    Phase,
    TRANSITIONS,
    WIRE_PHASE,
    NOT_BIDDING,
    PRE_SEATING,
    isTerminal,
    isLegal,
    wirePhase: (p) => WIRE_PHASE[p],
    reportViolation,
    getViolations: () => violations.slice(),
    resetViolations: () => { violations.length = 0; },
    shouldCheckInvariants
};
