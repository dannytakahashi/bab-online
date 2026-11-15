/**
 * Timers whose callback can never crash the server.
 *
 * A throw in a bare setTimeout/setInterval callback reaches
 * uncaughtException, which shuts the whole process down (utils/shutdown.js)
 * and drops every game. These wrappers log the failure (logger.error with
 * the label and stack) and carry on. Same timing and the same handle as the
 * plain call, so clearTimeout/clearInterval/unref work unchanged.
 * Game-owned timers use game.setTimer (GameState), which guards the same way.
 */

const { logger } = require('./logger');

function logFailure(label, error) {
    logger.error('Timer callback failed', {
        timer: label,
        error: error?.message ?? String(error),
        stack: error?.stack
    });
}

/** `fn` wrapped so a sync throw or an async rejection is logged, never thrown. */
function guard(fn, label) {
    return function guardedTimerCallback(...args) {
        try {
            const result = fn.apply(this, args);
            if (result && typeof result.then === 'function') {
                result.then(undefined, (error) => logFailure(label, error));
            }
        } catch (error) {
            logFailure(label, error);
        }
    };
}

/** setTimeout that logs instead of crashing. @returns the timer handle */
function safeTimeout(fn, ms, label) {
    return setTimeout(guard(fn, label), ms);
}

/** setInterval that logs instead of crashing; one failed tick does not stop it. */
function safeInterval(fn, ms, label) {
    return setInterval(guard(fn, label), ms);
}

module.exports = { safeTimeout, safeInterval, guard };
