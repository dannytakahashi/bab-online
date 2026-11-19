/**
 * The persist store's change hooks (deploy survival, the plan's 2.3): the
 * game and tournament code tells the store "this one changed", and nothing
 * else. Dependency-free, so GameState and TournamentState can require it
 * without a cycle.
 *
 * Passive by contract: a listener never draws Math.random, never emits,
 * never throws into the caller and never makes game code wait (it only
 * marks the entity dirty; liveStore writes it in a later setImmediate).
 * With no listener set (LIVE_PERSIST off, the default) every hook is one
 * null check.
 *
 * Callers:
 *   gameChanged(game)        GameState.nextSeq (every room broadcast and
 *                            every deal), _afterSeat (every seat edge),
 *                            _applyTransition (every stage change) and
 *                            addLogEntry (every log line)
 *   tournamentChanged(t)     TournamentState._changed(): its mutators,
 *                            broadcast, and the fields tournamentHandlers /
 *                            tournamentLiveness write directly
 *   beforeRun(game)          a game timer, lifecycle pause or bot action of
 *                            `game` is about to run (GameState.setTimer,
 *                            GameState.pause, BotController._arm). 'on'
 *                            only: the store runs its holder self-fence
 *                            check first (a process that thaws from a
 *                            freeze runs its overdue timers before the 1 s
 *                            check would), which may suspend the game (and
 *                            every other casual table); the caller then
 *                            holds the run for the thaw. The check itself
 *                            emits nothing: the self-fence's pause lines go
 *                            out from a later immediate (liveStore
 *                            sendPauseNotices). No listener in off / write
 */

'use strict';

let gameListener = null;
let tournamentListener = null;
let runListener = null;
let current = null;

/** liveStore only: install `listeners` ({game, tournament}), replacing any. */
function setListeners(listeners = {}) {
    current = listeners;
    gameListener = typeof listeners.game === 'function' ? listeners.game : null;
    tournamentListener = typeof listeners.tournament === 'function' ? listeners.tournament : null;
    runListener = typeof listeners.beforeRun === 'function' ? listeners.beforeRun : null;
}

/** Remove `listeners` if they are the installed ones (another store's stay). */
function clearListeners(listeners) {
    if (listeners !== current) return;
    current = null;
    gameListener = null;
    tournamentListener = null;
    runListener = null;
}

function gameChanged(game) {
    if (gameListener === null) return;
    try {
        gameListener(game);
    } catch {
        // A listener never breaks game code (liveStore logs its own errors)
    }
}

function tournamentChanged(t) {
    if (tournamentListener === null) return;
    try {
        tournamentListener(t);
    } catch {
        // As above
    }
}

function beforeRun(game) {
    if (runListener === null) return;
    try {
        runListener(game);
    } catch {
        // As above
    }
}

/** True while a store listens (tests). */
function listening() {
    return gameListener !== null || tournamentListener !== null;
}

module.exports = { setListeners, clearListeners, gameChanged, tournamentChanged, beforeRun, listening };
