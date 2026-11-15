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

// Clients get the restart notice this long before their sockets close
const NOTICE_MS = 1000;
// Then this long for remaining operations to finish
const SETTLE_MS = 500;
// Upper bound on the whole shutdown: whatever wedges, the process exits
// (under the drainingSeconds proposed in .railway/railway.ts, so once that is
// applied it is never SIGKILLed first)
const HARD_EXIT_MS = 10000;
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
 * @param {{games?: Function, noticeMs?: number, settleMs?: number, hardExitMs?: number}} [opts] -
 *   games: () => iterable of the live GameStates (server/index.js: the GameManager's), told
 *   of the update before serverShutdown; the waits are for tests only
 * @returns {{shutdown: Function, onUncaughtException: Function, onUnhandledRejection: Function}}
 *   the handlers (registered on `process` here; returned for tests, since
 *   Jest owns process-level uncaughtException while a test runs)
 */
function setupGracefulShutdown(server, io, opts = {}) {
    const { games = () => [], noticeMs = NOTICE_MS, settleMs = SETTLE_MS, hardExitMs = HARD_EXIT_MS } = opts;
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

module.exports = { setupGracefulShutdown, noticeGames, GAME_NOTICE, CRASH_NOTICE, NOTICE_MS, SETTLE_MS, HARD_EXIT_MS };
