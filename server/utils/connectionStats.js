/**
 * Socket.IO connection arrivals, for the deploy measurements (deploy
 * survival plan, ops step 1): when the last connection came and how many
 * came in the last minute, read by the SIGTERM log line
 * (server/utils/shutdown.js). A SIGTERM line that still shows recent
 * connections means the old instance was still being routed to up to the
 * signal (how Railway routes during the overlap is not verified; this is
 * how to see it).
 * No dependencies (shutdown.js reads it); counts only, never an id or IP.
 */

'use strict';

const WINDOW_MS = 60000;

// Arrival times (Date.now()) within the last WINDOW_MS, oldest first
let recent = [];
let last = null;
let total = 0;

function prune(now) {
    let i = 0;
    while (i < recent.length && recent[i] <= now - WINDOW_MS) i++;
    if (i > 0) recent = recent.slice(i);
}

/**
 * Note one connection.
 * @returns {boolean} true for the first connection of this process
 */
function noteConnection(now = Date.now()) {
    prune(now);
    recent.push(now);
    last = now;
    total++;
    return total === 1;
}

/**
 * @returns {{lastConnectionAt: string|null, connectionsInLast60s: number, connectionsTotal: number}}
 *   lastConnectionAt as an ISO time with milliseconds
 */
function connectionStats(now = Date.now()) {
    prune(now);
    return {
        lastConnectionAt: last === null ? null : new Date(last).toISOString(),
        connectionsInLast60s: recent.length,
        connectionsTotal: total,
    };
}

/** Tests only. */
function _resetForTests() {
    recent = [];
    last = null;
    total = 0;
}

module.exports = { noteConnection, connectionStats, WINDOW_MS, _resetForTests };
