/**
 * Stats scopes (owner, 2026-11-13: "you can choose to see standings
 * including human and bot games, human only, or human plus bot only").
 *
 * Two buckets per user, the same 12 fields each:
 *   users.stats     human games (no bot or resign-bot seat at the end); the
 *                   bucket every shipped client and every existing reader sees
 *   users.botStats  games with a bot or resign-bot seat at the end
 * and gameRecords entries of bot games carry `withBots: true` (absent = a
 * human game; older documents need no migration).
 *
 * Readers take a scope: 'human' (the default: today's exact reply), 'bots'
 * (botStats / withBots records) or 'all' (the two buckets summed field by
 * field, every record). Anything missing, non-object or unknown is 'human'.
 */

'use strict';

const SCOPES = Object.freeze(['human', 'bots', 'all']);

const STAT_KEYS = Object.freeze([
    'wins', 'losses', 'draws', 'gamesPlayed', 'totalPoints',
    'totalTricksBid', 'totalTricksTaken', 'totalHands', 'totalSets',
    'totalSetPoints', 'totalFaults', 'totalHSI'
]);

/** A profile's stats before its first game. */
const emptyStats = () => ({
    wins: 0,
    losses: 0,
    draws: 0,
    gamesPlayed: 0,
    totalPoints: 0,
    totalTricksBid: 0,
    totalTricksTaken: 0,
    totalHands: 0,
    totalSets: 0,
    totalSetPoints: 0,
    totalFaults: 0,
    totalHSI: 0
});

/** The 12 fields of a stored bucket as numbers (missing = 0). */
function pickStats(stats) {
    const out = {};
    for (const key of STAT_KEYS) out[key] = Number(stats?.[key]) || 0;
    return out;
}

/** Two buckets summed field by field (the 'all' scope). */
function sumBuckets(a, b) {
    const out = {};
    for (const key of STAT_KEYS) out[key] = (Number(a?.[key]) || 0) + (Number(b?.[key]) || 0);
    return out;
}

/**
 * The scope a request asks for, and whether it named one at all. Only a
 * request that carried a `scope` key gets the scope echoed back, so a
 * payload-less request (iOS, every existing caller) gets today's exact
 * bytes.
 *
 * @returns {{scope: 'human'|'bots'|'all', echo: boolean}}
 */
function normalizeScope(data) {
    const isObj = data !== null && typeof data === 'object' && !Array.isArray(data);
    const echo = isObj && Object.prototype.hasOwnProperty.call(data, 'scope');
    const scope = echo && SCOPES.includes(data.scope) ? data.scope : 'human';
    return { scope, echo };
}

module.exports = { SCOPES, STAT_KEYS, emptyStats, pickStats, sumBuckets, normalizeScope };
