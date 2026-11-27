/**
 * Graceful shutdown handler
 * Ensures clean shutdown on SIGTERM/SIGINT signals and on a crash.
 *
 * Exit codes matter on Railway: the service restarts ON_FAILURE only
 * (Railway's default, .railway/railway.ts), so a deploy's SIGTERM exits 0 (no restart) and an
 * uncaughtException exits 1 (restarted). A crash that exited 0 left the site
 * down until the next deploy.
 *
 * Two paths (docs/claude/server-infra.md, Deploys):
 *   today's (LIVE_PERSIST off or write, or 'on' without the unique gameId
 *   index): server.close, the game-log line to every live table (a deploy
 *   ends the game; "restart" wording on a crash), serverShutdown, write
 *   mode's self-delete, NOTICE_MS, io.close, the end-of-game writes in
 *   flight (7.5 s at most), SETTLE_MS, exit
 *   the handoff (effective 'on'; opts.handoff, server/game/persist/handoff.js):
 *   server.close, serverShutdown at t=0 (clients show "Restarting..."),
 *   every client event dropped from then on (a socket.use gate), the
 *   handoff (settle 0.5 s, freeze, successor check 1 s, flush 4 s: the
 *   tables' final state released to an 'on' successor, or deleted), THEN
 *   one game-log line per table matching what was acknowledged (CONTINUE,
 *   ENDED = today's line, UNKNOWN; on a crash the release's own pair),
 *   NOTICE_MS, io.close by 6.5 s (under iOS's 8 s disconnect wait), the
 *   writes in flight (7 s at most), SETTLE_MS, exit. A shutdown with no
 *   live table stays microtask-only up to the notice wait.
 * HARD_EXIT_MS (15 s, 5 s under drainingSeconds 20) caps either path.
 */

const { logger } = require('./logger');
const { safeTimeout } = require('./safeTimer');
const { connectionStats } = require('./connectionStats');

/** Connected sockets on `io` (as /health counts them), null if unreadable. */
function socketCount(io) {
    try {
        return io ? io.of('/').sockets.size : 0;
    } catch {
        return null;
    }
}

// Clients get the restart notice this long before their sockets close
const NOTICE_MS = 1000;
// Then this long for remaining operations to finish
const SETTLE_MS = 500;
// Upper bound on the whole shutdown: whatever wedges, the process exits
// (5 s under the drainingSeconds of 20 in .railway/railway.ts, so it is
// never SIGKILLed first; 10 s before the handoff, deploy survival PR 5)
const HARD_EXIT_MS = 15000;
// Kept free of the in-flight wait so the graceful path, not the hard
// deadline, normally ends the process
const DRAIN_MARGIN_MS = 1000;
// Today's path waits for in-flight writes as long as it always has (what
// the 10 s deadline left after the fixed waits: 7.5 s)
const LEGACY_HARD_EXIT_MS = 10000;
// The handoff path: settle 500 + successor 1000 + flush 4000 (handoff.js)
// + NOTICE_MS = 6.5 s to io.close; the in-flight wait gets what is left of
// HARD_EXIT_MS after that, SETTLE_MS and the margin (7 s)
const HANDOFF_SPAN_MS = 6500;

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
        // Tests only (_resetShutdownStateForTests abandonRetries): the wait never ends
        wake.abandon = () => {
            clearTimeout(timer);
            wakers.delete(wake);
        };
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

/**
 * Tests only: forget the shutdown state between cases. Pending retry waits
 * end now (their writes retry at once), or, with `abandonRetries` (a
 * killed process: testUtils/persistHarness.js killInstance), never end, so
 * the dead process's retries never run.
 */
function _resetShutdownStateForTests({ abandonRetries = false } = {}) {
    shuttingDown = false;
    inFlight.clear();
    for (const wake of [...wakers]) {
        if (abandonRetries) wake.abandon();
        else wake();
    }
    shuttingDown = false;
    drainDeadline = 0;
}

// The game-log line every live table gets with the notice: games live in
// memory, so a restart ends them (only gameEnd writes stats). A crash is no
// update, so it gets the neutral wording. With the handoff (effective
// 'on') each is said only when it is true: a table's doc is gone
const GAME_NOTICE = "This game was interrupted by a server update. It won't count toward stats.";
const CRASH_NOTICE = "This game was interrupted by a server restart. It won't count toward stats.";
// The handoff's lines (owner, 2026-11-16): released to an 'on' successor
const CONTINUE_NOTICE = 'The server is updating. This game will continue in a few seconds.';
// Neither the release nor the delete acknowledged: it may come back
const UNKNOWN_NOTICE = "This game was interrupted by a server update. If it isn't back in a few seconds, it won't count toward stats.";
// A crash: released, or not acknowledged
const CRASH_RELEASED_NOTICE = 'The server hit an error and is restarting. This game should continue in a moment, possibly a move earlier.';
const CRASH_UNKNOWN_NOTICE = "This game was interrupted by a server restart. If it isn't back in a moment, it won't count toward stats.";

// A tournament released to an 'on' successor (owner answer a, 2026-11-16;
// deploy survival PR 6): its room's tournamentMessage system line
const TOURNAMENT_CONTINUE_LINE = 'The server is updating. The tournament will continue in a few seconds.';

/** The line for a handoff outcome (handoff.js run / crash). */
const OUTCOME_NOTICE = Object.freeze({
    continue: CONTINUE_NOTICE,
    ended: GAME_NOTICE,
    unknown: UNKNOWN_NOTICE,
    crashContinue: CRASH_RELEASED_NOTICE,
    crashUnknown: CRASH_UNKNOWN_NOTICE,
    crashEnded: CRASH_NOTICE
});

/**
 * Tell every live table, in its game log, that the update ends it. One
 * broken game never keeps the others (or the shutdown) from going on.
 * A table the handoff froze (persist/handoff.js) gets the line as the same
 * sequenced room event (the next seq after the last one it sent, so no
 * client sees a gap), but not stored and with no save: its state is
 * already saved (or deleted), and the successor's rejoin snapshot (seq
 * 1000 further on) replaces the client's log.
 * @param {string|Function} [message] - GAME_NOTICE (a stop: SIGTERM/SIGINT)
 *   or CRASH_NOTICE, or (game) => the line for that table (null: none)
 * @returns {number} tables told
 */
function noticeGames(io, games, message = GAME_NOTICE) {
    let told = 0;
    for (const game of games()) {
        try {
            if (game.isTerminal?.()) continue;
            const line = typeof message === 'function' ? message(game) : message;
            if (!line) continue;
            if (game.frozen) {
                io.to(game.roomName).emit('gameLogEntry', { message: line, type: 'system', seq: ++game.eventSeq });
            } else {
                game.addLogEntry(line, null, 'system');
                game.broadcast(io, 'gameLogEntry', { message: line, type: 'system' });
            }
            told++;
        } catch (error) {
            logger.error('Shutdown notice to a game failed', { gameId: game?.gameId, error: error.message });
        }
    }
    return told;
}

/** handoff.enabled(), false if it throws. */
function safeEnabled(handoff) {
    try {
        return typeof handoff.enabled === 'function' ? handoff.enabled() === true : false;
    } catch {
        return false;
    }
}

/**
 * Setup graceful shutdown handlers
 * @param {http.Server} server - HTTP server instance
 * @param {SocketIO.Server} io - Socket.IO server instance
 * @param {{games?: Function, persist?: Object, handoff?: Object, noticeMs?: number, settleMs?: number, hardExitMs?: number, drainMs?: number}} [opts] -
 *   games: () => iterable of the live GameStates (server/index.js: the GameManager's), told
 *   of the update before serverShutdown; persist: the live persist store in
 *   LIVE_PERSIST write or on (server/game/persist/liveStore.js; server/index.js
 *   passes it only then): on today's path, right after the notice and serverShutdown, its
 *   shutdown() stops every live write and deletes this process's saved games
 *   and tournaments (bounded at 2 s, waited for like an in-flight write);
 *   handoff: persist/handoff.js (server/index.js passes it with
 *   LIVE_PERSIST=on): when handoff.enabled() at the signal (effective
 *   'on'), the handoff path above replaces the notice, the self-delete and
 *   today's budget (handoff.run on a stop, handoff.crash on a crash);
 *   the waits are for tests only
 * @returns {{shutdown: Function, onUncaughtException: Function, onUnhandledRejection: Function}}
 *   the handlers (registered on `process` here; returned for tests, since
 *   Jest owns process-level uncaughtException while a test runs)
 */
function setupGracefulShutdown(server, io, opts = {}) {
    const { games = () => [], persist = null, handoff = null, noticeMs = NOTICE_MS, settleMs = SETTLE_MS, hardExitMs = HARD_EXIT_MS } = opts;
    // The handoff path, decided at the signal (effective 'on' is known only
    // once the store has started)
    let handingOff = false;
    // Every client event is dropped while a handoff runs: an action now
    // would change a table whose final state is being written (the
    // clients resync from the successor's snapshot)
    if (handoff && io && typeof io.on === 'function') {
        io.on('connection', (socket) => {
            if (typeof socket.use !== 'function') return;
            socket.use((packet, next) => {
                if (handingOff) return;
                next();
            });
        });
    }
    // Write mode's self-delete, after today's notice (never a release: a
    // 'write' process hands nothing off). Its docs are never adopted
    // (ownerMode 'write'); any it fails to delete expire by TTL
    const deleteLiveDocs = () => {
        if (!persist || typeof persist.shutdown !== 'function') return;
        trackInFlight(Promise.resolve().then(() => persist.shutdown()).catch((error) => {
            logger.error('Live doc delete at shutdown failed', { error: error.message });
        }));
    };
    // What is left of the hard deadline after the fixed waits (today's
    // path keeps its 10 s budget's 7.5 s)
    const legacyDrainMs = opts.drainMs ?? Math.max(0, Math.min(hardExitMs, LEGACY_HARD_EXIT_MS) - noticeMs - settleMs - DRAIN_MARGIN_MS);
    const handoffDrainMs = opts.drainMs ?? Math.max(0, hardExitMs - HANDOFF_SPAN_MS - settleMs - DRAIN_MARGIN_MS);
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
        // With the deploy measurements (docs/claude/server-infra.md, Deploys):
        // `at` (the console timestamp has whole seconds only), and whether
        // clients were still arriving here when the signal came
        logger.info(`Received ${signal}, starting graceful shutdown`, {
            exitCode,
            at: new Date().toISOString(),
            ...connectionStats(),
            sockets: socketCount(io)
        });
        // Each tournament SFU room's last stats line (logged every 60 s otherwise)
        try {
            require('../voice/sfu/sfuRoom').logAllStats('shutdown');
        } catch (error) {
            logger.error('Voice SFU: stats at shutdown failed', { error: error.message });
        }
        handingOff = !!(io && handoff && safeEnabled(handoff));
        const drainMs = handingOff ? handoffDrainMs : legacyDrainMs;
        // Pending stats retries run now instead of after their backoff,
        // then every SHUTDOWN_RETRY_MS until the drain ends
        beginShutdown(Date.now() + (handingOff ? HANDOFF_SPAN_MS : (io ? noticeMs : 0)) + drainMs);

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

            if (handingOff) {
                // serverShutdown at t=0, as today (no client reads its text)
                io.emit('serverShutdown', {
                    message: 'Server is restarting, please reconnect shortly'
                });
                let result = null;
                try {
                    result = exitCode === 0 ? await handoff.run(io) : await handoff.crash(io);
                } catch (error) {
                    logger.error('Handoff failed', { error: error.message });
                }
                // One line per table, matching what was acknowledged (a
                // table the handoff did not list gets today's line)
                try {
                    const outcomes = new Map((result?.tables || []).map((t) => [t.game, t.outcome]));
                    const fallback = exitCode === 0 ? GAME_NOTICE : CRASH_NOTICE;
                    const tables = [...new Set([...outcomes.keys(), ...games()])];
                    const told = noticeGames(io, () => tables, (game) => OUTCOME_NOTICE[outcomes.get(game)] || fallback);
                    if (told) logger.info('Shutdown notice sent to games', { games: told });
                } catch (error) {
                    logger.error('Shutdown notice to games failed', { error: error.message });
                }
                // A tournament whose release was acknowledged (PR 6): one
                // system line to its room (never stored: the store is closed)
                for (const { tournament, outcome } of result?.tournaments || []) {
                    if (outcome !== 'continue' || !tournament?.roomName) continue;
                    try {
                        const { systemLine } = require('../socket/tournamentLiveness');
                        io.to(tournament.roomName).emit('tournamentMessage', systemLine(TOURNAMENT_CONTINUE_LINE));
                    } catch (error) {
                        logger.error('Shutdown notice to a tournament failed', { tournamentId: tournament.tournamentId, error: error.message });
                    }
                }

                await new Promise(resolve => safeTimeout(resolve, noticeMs, 'shutdownNotice'));
                io.close(() => {
                    logger.info('Socket.IO server closed');
                });
            } else if (io) {
                // Notify connected clients: players at a table first, in the game log
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
                deleteLiveDocs();

                // Give clients time to receive the message
                await new Promise(resolve => setTimeout(resolve, noticeMs));

                // Close socket connections
                io.close(() => {
                    logger.info('Socket.IO server closed');
                });
            } else {
                deleteLiveDocs();
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
    CONTINUE_NOTICE,
    TOURNAMENT_CONTINUE_LINE,
    UNKNOWN_NOTICE,
    CRASH_RELEASED_NOTICE,
    CRASH_UNKNOWN_NOTICE,
    OUTCOME_NOTICE,
    HANDOFF_SPAN_MS,
    DRAIN_MARGIN_MS,
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
