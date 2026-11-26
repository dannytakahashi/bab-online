/**
 * Badges, the database side (owner 2026-11-24 / 25; rules and catalog in
 * server/game/badges.js).
 *
 * Storage: `users.badges` [{id, at, gameId}] (one entry per badge, first
 * time earned) and `users.badgeProgress.overtrumped` (the lifetime count
 * behind Child Labor, $inc'd with the game's stats under the same
 * statsGames guard: profileHandlers.applyPendingStats).
 *
 * A finished human game's record carries what it earned, by position:
 * `statsDeltas.badges {<pos>: [ids]}` and `statsDeltas.overtrumped
 * {<pos>: n}` (profileHandlers.buildGameEndRecord; only for seats whose
 * stats go to the human bucket, so a bot game or a /help-assisted win
 * carries none). awardForRecord, run after the stats of that record are
 * applied and BEFORE its statsPending is cleared (applyPendingStats keeps
 * a player's pending entry while their award has not gone through, so the
 * boot sweep, resumePendingGameStats, finishes it: a badge earned in a game
 * is never lost to a failed write or a crash), gives each named seat:
 *   - the record's badges for that seat,
 *   - Century: users.stats.gamesPlayed >= 100,
 *   - Child Labor: badgeProgress.overtrumped >= 50,
 *   - Chemistry: 20 game records with this game's partner on the same
 *     team where BOTH partners' seats went to the human bucket
 *     (statsDeltas.bucket / bucketByPosition, as the stats did; a record
 *     from before statsDeltas: not withBots), so an opponent's /help win
 *     still counts for the pair (gameRecords.teamNPlayers, which rename /
 *     merge keep in step, on the multikey indexes database.ensureIndexes
 *     builds; this game's record is already inserted).
 * Every award is its own guarded $push (`badges.id: {$ne: id}`), so running
 * it twice for a record (a replay, the pending-stats resume, a tombstone)
 * awards nothing twice, and a matched write is exactly "newly earned": that
 * is what the player's private `badgesAwarded {gameId, badges}` lists (in
 * catalog order, the profile's order for one game's badges), sent
 * to their live socket when it has the clientHello cap `badges` (the web;
 * no iOS build). A player who is offline just finds the badge on their
 * profile. Every read and write goes through the caller's `retry` (the
 * stats chain's withRetry), each badge's write on its own: one that still
 * fails leaves the player in `failed` and the others are kept. Never
 * throws: a badge must not fail the stats chain.
 */

'use strict';

const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');
const { hasCap } = require('./clientInfo');
const { BADGE_IDS, LIMITS, isBadgeId, partnerOf, publicBadge, recordSeatCounts } = require('../game/badges');
const { DELETED_NAME } = require('../admin/nameHold');

const BADGES_CAP = 'badges';

/** The io the award notices go out on (set by the game-end path; null: no notices). */
let liveIo = null;
function setIo(io) {
    if (io) liveIo = io;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isName = (v) => typeof v === 'string' && v.length > 0 && v !== DELETED_NAME;

/** Does this seat of the record count as a human game for its player? */
function humanSeat(statsDeltas, position) {
    return isPlainObject(statsDeltas) && recordSeatCounts({ statsDeltas }, position);
}

/** Run once: the default `retry` (no backoff). */
const once = (_step, fn) => fn();

/**
 * One team's clause of gamesTogether: both names in teamNPlayers, and both
 * of the team's seats in the human bucket (badges.recordSeatCounts as a
 * query: a statsDeltas record by its buckets, an older one by withBots).
 */
function togetherOnTeam(team, [p, q], a, b) {
    const bySeat = (pos) => ({ [`statsDeltas.bucketByPosition.${pos}`]: { $ne: 'botStats' } });
    return {
        $and: [
            { [`${team}Players`]: a },
            { [`${team}Players`]: b },
            {
                $or: [
                    { statsDeltas: { $exists: true }, 'statsDeltas.bucket': { $ne: 'botStats' }, ...bySeat(p), ...bySeat(q) },
                    { statsDeltas: { $exists: false }, withBots: { $ne: true } }
                ]
            }
        ]
    };
}

/**
 * Game records with both players on the same team and both partners'
 * seats in the human bucket (an opponent's /help win does not take it
 * away; a seat /help moved, or a bot game, does).
 */
function gamesTogether(gameRecords, a, b) {
    return gameRecords.countDocuments({
        $or: [togetherOnTeam('team1', [1, 3], a, b), togetherOnTeam('team2', [2, 4], a, b)]
    });
}

/**
 * The lifetime badges `username` qualifies for and does not have yet.
 * @param {Object} doc - the user's {stats, badgeProgress, badges}
 * @param {string|null} partner - this game's partner (a human name), or null
 */
async function lifetimeBadges(doc, username, partner, gameRecords, retry = once) {
    const has = new Set((Array.isArray(doc.badges) ? doc.badges : []).map((b) => b?.id));
    const out = [];
    if (!has.has('century') && (doc.stats?.gamesPlayed || 0) >= LIMITS.centuryGames) out.push('century');
    if (!has.has('child-labor') && (doc.badgeProgress?.overtrumped || 0) >= LIMITS.overTrumped) out.push('child-labor');
    if (!has.has('chemistry') && gameRecords && isName(partner) && partner !== username) {
        if (await retry('badgeChemistry', () => gamesTogether(gameRecords, username, partner)) >= LIMITS.chemistryGames) out.push('chemistry');
    }
    return out;
}

/** Catalog order (the profile's order for badges of one game). */
const byCatalog = (ids) => [...ids].sort((x, y) => BADGE_IDS.indexOf(x) - BADGE_IDS.indexOf(y));

/**
 * Give `username` each badge of `ids` they do not have, each its own
 * guarded write through `retry`; a write that still fails is logged and
 * the rest still go in.
 * @returns {Promise<{earned: string[], failed: string[]}>} the ids newly
 *   earned and the ids whose write failed, both in catalog order
 */
async function grantEach(users, username, ids, { at, gameId = null, retry = once }) {
    const earned = [];
    const failed = [];
    for (const id of byCatalog(new Set(ids)).filter(isBadgeId)) {
        const entry = { id, at };
        if (gameId) entry.gameId = gameId;
        try {
            const res = await retry('badge', () => users.updateOne(
                { username, mergedInto: { $exists: false }, 'badges.id': { $ne: id } },
                { $push: { badges: entry } }
            ));
            if (res?.modifiedCount > 0) earned.push(id);
        } catch (error) {
            failed.push(id);
            authLogger.error('Error awarding a badge', { username, gameId, badge: id, error: error.message });
        }
    }
    return { earned, failed };
}

/** grantEach, the ids newly earned only. */
async function grant(users, username, ids, opts) {
    return (await grantEach(users, username, ids, opts)).earned;
}

/**
 * Award what one game record earned (see the header). Safe to run again
 * for the same record.
 * @param {{gameId: string, completedAt?: Date, statsDeltas?: Object}} record
 * @param {{users: Collection, gameRecords?: Collection, retry?: Function}} collections
 *   retry(step, fn): runs fn, retrying a failure (default: once)
 * @returns {Promise<{awards: Array<{username: string, badges: string[]}>, failed: string[]}>}
 *   who newly earned what, and the players whose award did not fully go
 *   through (the caller keeps them pending)
 */
async function awardRecord(record, { users, gameRecords, retry = once }) {
    const awards = [];
    const failed = [];
    const sd = record?.statsDeltas;
    if (!users || !isPlainObject(sd) || !isPlainObject(sd.names)) return { awards, failed };
    const at = record.completedAt instanceof Date ? record.completedAt : new Date();
    const done = new Set();
    for (const [posKey, username] of Object.entries(sd.names)) {
        const position = Number(posKey);
        if (!isName(username) || done.has(username) || !humanSeat(sd, posKey)) continue;
        done.add(username);
        try {
            const doc = await retry('badgeRead', () => users.findOne(
                { username, mergedInto: { $exists: false } },
                { projection: { 'stats.gamesPlayed': 1, badgeProgress: 1, badges: 1 } }
            ));
            if (!doc) continue;
            const fromGame = isPlainObject(sd.badges) && Array.isArray(sd.badges[posKey]) ? sd.badges[posKey] : [];
            const partner = sd.names[partnerOf(position)];
            const lifetime = await lifetimeBadges(doc, username, partner, gameRecords, retry);
            const has = new Set((Array.isArray(doc.badges) ? doc.badges : []).map((b) => b?.id));
            const wanted = [...fromGame, ...lifetime].filter((id) => !has.has(id));
            if (wanted.length === 0) continue;
            const result = await grantEach(users, username, wanted, { at, gameId: record.gameId, retry });
            if (result.failed.length > 0) failed.push(username);
            if (result.earned.length > 0) {
                awards.push({ username, badges: result.earned });
                authLogger.info('Badges awarded', { username, gameId: record.gameId, badges: result.earned });
            }
        } catch (error) {
            failed.push(username);
            authLogger.error('Error awarding badges', { username, gameId: record?.gameId, error: error.message });
        }
    }
    return { awards, failed };
}

/** awardRecord, who newly earned what only. */
async function awardForRecord(record, collections) {
    return (await awardRecord(record, collections)).awards;
}

/** Tell each player who is online (and whose client shows badges) what they just earned. */
function notify(awards, gameId) {
    const io = liveIo;
    if (!io || !Array.isArray(awards)) return;
    for (const { username, badges } of awards) {
        try {
            const user = gameManager.currentUsers.find((u) => u.username === username);
            const socket = user && io.sockets?.sockets?.get(user.socketId);
            if (!socket || !hasCap(socket, BADGES_CAP)) continue;
            const list = byCatalog(badges).map((id) => publicBadge(id)).filter(Boolean);
            if (list.length > 0) socket.emit('badgesAwarded', { gameId, badges: list });
        } catch (error) {
            authLogger.warn('Could not send badgesAwarded', { username, gameId, error: error.message });
        }
    }
}

/**
 * awardRecord + notify, never rejecting (the stats chain calls it).
 * @returns {Promise<{awards: Array, failed: string[]|null}>} failed: null
 *   when the award could not run at all (every named player is then
 *   unfinished)
 */
async function awardAndNotify(record, collections) {
    try {
        const { awards, failed } = await awardRecord(record, collections);
        notify(awards, record?.gameId);
        return { awards, failed };
    } catch (error) {
        authLogger.error('Badge awards failed', { gameId: record?.gameId, error: error.message });
        return { awards: [], failed: null };
    }
}

module.exports = { BADGES_CAP, setIo, humanSeat, gamesTogether, grant, grantEach, awardRecord, awardForRecord, notify, awardAndNotify };
