/**
 * GET /health: is the process up, and what would a deploy interrupt?
 *
 * Always 200 and cheap (no DB round trip): it is the liveness view and what
 * the owner checks before pushing. /ready (DB ping, 503 without it) is
 * the Railway deploy healthcheck (.railway/railway.ts). The endpoint is
 * public, so it carries counts only, never usernames or ids.
 */

const { getDbState } = require('../database');

// The Socket.IO server, set once at startup (server/index.js)
let ioRef = null;
function setHealthIo(io) {
    ioRef = io;
}

/**
 * Live counts: connected sockets, live games with a human seat owner (the
 * ambient demo and other bot-only tables excluded), tournaments not yet
 * complete, open lobbies. null when the count could not be read.
 */
function liveCounts(io = ioRef, gameManager = require('../game/GameManager')) {
    let sockets = null;
    try {
        sockets = io ? io.of('/').sockets.size : 0;
    } catch {
        sockets = null;
    }
    let counts;
    try {
        counts = gameManager.getHealthCounts();
    } catch {
        counts = { games: null, tournaments: null, lobbies: null };
    }
    return { sockets, ...counts };
}

/**
 * Deploy survival (server/game/persist/liveStore.js): {mode (LIVE_PERSIST
 * as read at boot), effectiveMode (what runs: 'on' only with the unique
 * gameId index, else 'write'), uniqueGameIdIndex (gameRecords' unique
 * gameId index: true / false / null before it is probed; check it is true
 * before setting write), docsOwned (live docs this process holds),
 * adopted (games this process adopted), lastSweepAt (ISO time of the last
 * adoption sweep, null before one), bootSwept (the first sweep finished;
 * /ready waits for it in 'on')}. Counts and flags only. null if unreadable.
 */
function persistHealth() {
    try {
        return require('../game/persist/liveStore').getLiveStore().health();
    } catch {
        return null;
    }
}

/**
 * /help (server/socket/assistHandlers.js): {answered, quick (rules-only
 * answers because the searched-answer budget was spent), errors} since
 * boot. Counts only. null if unreadable.
 */
function assistHealth() {
    try {
        return require('../socket/assistHandlers').assistHealth();
    } catch {
        return null;
    }
}

function healthBody({ io = ioRef, gameManager, dbState = safeDbState, persist = persistHealth, assist = assistHealth } = {}) {
    const mem = process.memoryUsage();
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
            used: Math.round(mem.heapUsed / 1024 / 1024),
            total: Math.round(mem.heapTotal / 1024 / 1024),
            unit: 'MB'
        },
        db: dbState(),
        live: liveCounts(io, gameManager),
        persist: persist(),
        assist: assist()
    };
}

function safeDbState() {
    try {
        return getDbState();
    } catch {
        return 'disconnected';
    }
}

function healthHandler(req, res) {
    res.json(healthBody());
}

module.exports = { setHealthIo, healthHandler, healthBody, liveCounts, persistHealth, assistHealth };
