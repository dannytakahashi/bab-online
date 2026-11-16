/**
 * Graceful shutdown handler
 * Ensures clean shutdown on SIGTERM/SIGINT signals and on a crash.
 *
 * Exit codes matter on Railway: the service restarts ON_FAILURE only
 * (Railway's default, .railway/railway.ts), so a deploy's SIGTERM exits 0 (no restart) and an
 * uncaughtException exits 1 (restarted). A crash that exited 0 left the site
 * down until the next deploy.
 */

const { logger } = require('./logger');
const { safeTimeout } = require('./safeTimer');

// Clients get the restart notice this long before their sockets close
const NOTICE_MS = 1000;
// Then this long for remaining operations to finish
const SETTLE_MS = 500;
// Upper bound on the whole shutdown: whatever wedges, the process exits
// (under the drainingSeconds of 15 in .railway/railway.ts, so it is never
// SIGKILLed first)
const HARD_EXIT_MS = 10000;
// Kept free of the in-flight wait so the graceful path, not the hard
// deadline, normally ends the process
const DRAIN_MARGIN_MS = 1000;

// Writes a shutdown waits for: the stats of games that already ENDED
// (profileHandlers registers them). A shutdown never records a game itself
// (RestartNoticeTests in the iOS tests pin that). Each entry leaves the set
// once it settles.
const inFlight = new Set();
let shuttingDown = false;
// Pending retry waits (retryDelay), cut short when a shutdown starts
const wakers = new Set();
// During a shutdown a retry waits at most this long, and retries go on
// until the drain's deadline: a short outage (a failover during the
// deploy) must not use up every retry in a few milliseconds
const SHUTDOWN_RETRY_MS = 250;
let drainDeadline = 0;

/**
 * Register a write a graceful shutdown should wait for (bounded by
 * HARD_EXIT_MS). Returns the same promise.
 */
function trackInFlight(promise) {
    const entry = Promise.resolve(promise).then(() => {}, () => {}).finally(() => inFlight.delete(entry));
    inFlight.add(entry);
    return promise;
}

/** Number of tracked writes not settled yet. */
function inFlightCount() {
    return inFlight.size;
}

/** True once a shutdown has started. */
function isShuttingDown() {
    return shuttingDown;
}

/**
 * Wait `ms` before a retry, or less: a shutdown starting meanwhile ends the
 * wait at once, and during a shutdown the wait is SHUTDOWN_RETRY_MS at most
 * (the in-flight wait is short).
 */
function retryDelay(ms) {
    if (shuttingDown) ms = Math.min(ms, SHUTDOWN_RETRY_MS);
    return new Promise(resolve => {
        const wake = () => {
            clearTimeout(timer);
            wakers.delete(wake);
            resolve();
        };
        const timer = safeTimeout(wake, ms, 'retryDelay');
        timer.unref?.();
        wakers.add(wake);
    });
}

/**
 * True while a shutdown's drain still has time for one more retry: a write
 * that has used up its retries keeps going until then.
 */
function shutdownAllowsRetry() {
    return shuttingDown && Date.now() + SHUTDOWN_RETRY_MS < drainDeadline;
}

function beginShutdown(deadline) {
    shuttingDown = true;
    drainDeadline = deadline;
    for (const wake of [...wakers]) wake();
}

/**
 * Wait for every tracked write (new ones too, e.g. a bot game ending
 * during the wait) for at most `ms`. Never throws.
 * @returns {Promise<boolean>} true if all settled in time
 */
async function drainInFlight(ms) {
    if (inFlight.size === 0) return true;
    logger.info('Waiting for in-flight writes before exit', { count: inFlight.size, maxMs: ms });
    let timer;
    const timedOut = new Promise(resolve => {
        timer = safeTimeout(() => resolve(false), ms, 'shutdownDrain');
        timer.unref?.();
    });
    let done = false;
    try {
        while (inFlight.size > 0) {
            const settled = await Promise.race([Promise.allSettled([...inFlight]).then(() => true), timedOut]);
            if (!settled) break;
        }
        done = inFlight.size === 0;
    } finally {
        clearTimeout(timer);
    }
    if (!done) logger.warn('Exiting with writes still in flight', { count: inFlight.size, maxMs: ms });
    return done;
}

/** Tests only: forget the shutdown state between cases. */
function _resetShutdownStateForTests() {
    shuttingDown = false;
    inFlight.clear();
    for (const wake of [...wakers]) wake();
    shuttingDown = false;
    drainDeadline = 0;
}

// The game-log line every live table gets with the notice: games live in
// memory, so a restart ends them (only gameEnd writes stats). A crash is no
// update, so it gets the neutral wording
const GAME_NOTICE = "This game was interrupted by a server update. It won't count toward stats.";
const CRASH_NOTICE = "This game was interrupted by a server restart. It won't count toward stats.";

/**
 * Tell every live table, in its game log, that the update ends it. One
 * broken game never keeps the others (or the shutdown) from going on.
 * @param {string} [message] - GAME_NOTICE (a stop: SIGTERM/SIGINT) or CRASH_NOTICE
 * @returns {number} tables told
 */
function noticeGames(io, games, message = GAME_NOTICE) {
    let told = 0;
    for (const game of games()) {
        try {
            if (game.isTerminal?.()) continue;
            game.addLogEntry(message, null, 'system');
            game.broadcast(io, 'gameLogEntry', { message, type: 'system' });
            told++;
        } catch (error) {
            logger.error('Shutdown notice to a game failed', { gameId: game?.gameId, error: error.message });
        }
    }
    return told;
}

/**
 * Setup graceful shutdown handlers
 * @param {http.Server} server - HTTP server instance
 * @param {SocketIO.Server} io - Socket.IO server instance
 * @param {{games?: Function, noticeMs?: number, settleMs?: number, hardExitMs?: number, drainMs?: number}} [opts] -
 *   games: () => iterable of the live GameStates (server/index.js: the GameManager's), told
 *   of the update before serverShutdown; the waits are for tests only
 * @returns {{shutdown: Function, onUncaughtException: Function, onUnhandledRejection: Function}}
 *   the handlers (registered on `process` here; returned for tests, since
 *   Jest owns process-level uncaughtException while a test runs)
 */
function setupGracefulShutdown(server, io, opts = {}) {
    const { games = () => [], noticeMs = NOTICE_MS, settleMs = SETTLE_MS, hardExitMs = HARD_EXIT_MS } = opts;
    // What is left of the hard deadline after the fixed waits
    const drainMs = opts.drainMs ?? Math.max(0, hardExitMs - noticeMs - settleMs - DRAIN_MARGIN_MS);
    // The first reason decides the code: a crash during a deploy's SIGTERM
    // still exits 0 (the platform asked it to stop), a second signal during
    // a crash shutdown still exits 1 (so it is restarted)
    let pendingExitCode = null;

    const shutdown = async (signal, exitCode = 0) => {
        if (pendingExitCode !== null) {
            logger.warn('Shutdown already in progress, forcing exit', { signal, exitCode: pendingExitCode });
            process.exit(pendingExitCode);
            return;
        }

        pendingExitCode = exitCode;
        // Also the code if the event loop drains before process.exit runs
        process.exitCode = exitCode;
        logger.info(`Received ${signal}, starting graceful shutdown`, { exitCode });
        // Pending stats retries run now instead of after their backoff,
        // then every SHUTDOWN_RETRY_MS until the drain ends
        beginShutdown(Date.now() + (io ? noticeMs : 0) + drainMs);

        const hardExit = setTimeout(() => {
            logger.error('Graceful shutdown timed out, forcing exit', { signal, exitCode, hardExitMs });
            process.exit(exitCode);
        }, hardExitMs);
        hardExit.unref?.();

        try {
            // Stop accepting new connections
            server.close(() => {
                logger.info('HTTP server closed');
            });

            // Notify connected clients: players at a table first, in the game log
            if (io) {
                try {
                    // exitCode 1 is a crash (onUncaughtException), not a deploy's stop
                    const told = noticeGames(io, games, exitCode === 0 ? GAME_NOTICE : CRASH_NOTICE);
                    if (told) logger.info('Shutdown notice sent to games', { games: told });
                } catch (error) {
                    logger.error('Shutdown notice to games failed', { error: error.message });
                }
                io.emit('serverShutdown', {
                    message: 'Server is restarting, please reconnect shortly'
                });

                // Give clients time to receive the message
                await new Promise(resolve => setTimeout(resolve, noticeMs));

                // Close socket connections
                io.close(() => {
                    logger.info('Socket.IO server closed');
                });
            }

            // End-of-game writes still running (a game that ended just
            // before the signal, or a retry): stats must not be lost
            await drainInFlight(drainMs);

            // Allow remaining operations to complete
            await new Promise(resolve => setTimeout(resolve, settleMs));
            logger.info('Graceful shutdown complete', { exitCode });
        } catch (error) {
            // A throw here (a half-broken server after a crash) must still exit
            logger.error('Graceful shutdown failed, exiting', { error: error.message, stack: error.stack });
        } finally {
            clearTimeout(hardExit);
        }
        process.exit(exitCode);
    };

    const onUncaughtException = (error) => {
        logger.error('Uncaught exception', {
            error: error?.message,
            stack: error?.stack
        });
        shutdown('uncaughtException', 1);
    };

    const onUnhandledRejection = (reason) => {
        logger.error('Unhandled rejection', {
            reason: reason?.message || String(reason),
            stack: reason?.stack
        });
        // Log but don't shutdown for unhandled rejections
    };

    // Handle termination signals
    process.on('SIGTERM', () => shutdown('SIGTERM', 0));
    process.on('SIGINT', () => shutdown('SIGINT', 0));

    // Handle uncaught errors
    process.on('uncaughtException', onUncaughtException);
    process.on('unhandledRejection', onUnhandledRejection);

    logger.debug('Graceful shutdown handlers registered');
    return { shutdown, onUncaughtException, onUnhandledRejection };
}

module.exports = {
    setupGracefulShutdown,
    noticeGames,
    GAME_NOTICE,
    CRASH_NOTICE,
    trackInFlight,
    inFlightCount,
    isShuttingDown,
    retryDelay,
    shutdownAllowsRetry,
    drainInFlight,
    _resetShutdownStateForTests,
    NOTICE_MS,
    SETTLE_MS,
    HARD_EXIT_MS
};
