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
 * applied, gives each named seat:
 *   - the record's badges for that seat,
 *   - Century: users.stats.gamesPlayed >= 100,
 *   - Child Labor: badgeProgress.overtrumped >= 50,
 *   - Chemistry: 20 human game records with this game's partner on the
 *     same team (gameRecords.teamNPlayers, which rename / merge keep in
 *     step; this game's record is already inserted).
 * Every award is its own guarded $push (`badges.id: {$ne: id}`), so running
 * it twice for a record (a replay, the pending-stats resume, a tombstone)
 * awards nothing twice, and a matched write is exactly "newly earned": that
 * is what the player's private `badgesAwarded {gameId, badges}` lists, sent
 * to their live socket when it has the clientHello cap `badges` (the web
 * and iOS 1.2.7 (41)). A player who is offline just finds the badge on their
 * profile. Never throws: a badge must not fail the stats chain.
 */

'use strict';

const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');
const { hasCap } = require('./clientInfo');
const { LIMITS, isBadgeId, partnerOf, publicBadge } = require('../game/badges');
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
    if (!isPlainObject(statsDeltas) || statsDeltas.bucket === 'botStats') return false;
    const byPos = statsDeltas.bucketByPosition;
    return !(isPlainObject(byPos) && byPos[position] === 'botStats');
}

/** Human game records with both players on the same team. */
function gamesTogether(gameRecords, a, b) {
    return gameRecords.countDocuments({
        withBots: { $ne: true },
        $or: [
            { $and: [{ team1Players: a }, { team1Players: b }] },
            { $and: [{ team2Players: a }, { team2Players: b }] }
        ]
    });
}

/**
 * The lifetime badges `username` qualifies for and does not have yet.
 * @param {Object} doc - the user's {stats, badgeProgress, badges}
 * @param {string|null} partner - this game's partner (a human name), or null
 */
async function lifetimeBadges(doc, username, partner, gameRecords) {
    const has = new Set((Array.isArray(doc.badges) ? doc.badges : []).map((b) => b?.id));
    const out = [];
    if (!has.has('century') && (doc.stats?.gamesPlayed || 0) >= LIMITS.centuryGames) out.push('century');
    if (!has.has('child-labor') && (doc.badgeProgress?.overtrumped || 0) >= LIMITS.overTrumped) out.push('child-labor');
    if (!has.has('chemistry') && gameRecords && isName(partner) && partner !== username) {
        if (await gamesTogether(gameRecords, username, partner) >= LIMITS.chemistryGames) out.push('chemistry');
    }
    return out;
}

/**
 * Give `username` each badge of `ids` they do not have.
 * @returns {Promise<string[]>} the ids newly earned
 */
async function grant(users, username, ids, { at, gameId = null }) {
    const earned = [];
    for (const id of [...new Set(ids)].filter(isBadgeId)) {
        const entry = { id, at };
        if (gameId) entry.gameId = gameId;
        const res = await users.updateOne(
            { username, mergedInto: { $exists: false }, 'badges.id': { $ne: id } },
            { $push: { badges: entry } }
        );
        if (res?.modifiedCount > 0) earned.push(id);
    }
    return earned;
}

/**
 * Award what one game record earned (see the header). Safe to run again
 * for the same record.
 * @param {{gameId: string, completedAt?: Date, statsDeltas?: Object}} record
 * @param {{users: Collection, gameRecords?: Collection}} collections
 * @returns {Promise<Array<{username: string, badges: string[]}>>} who newly earned what
 */
async function awardForRecord(record, { users, gameRecords }) {
    const out = [];
    const sd = record?.statsDeltas;
    if (!users || !isPlainObject(sd) || !isPlainObject(sd.names)) return out;
    const at = record.completedAt instanceof Date ? record.completedAt : new Date();
    const done = new Set();
    for (const [posKey, username] of Object.entries(sd.names)) {
        const position = Number(posKey);
        if (!isName(username) || done.has(username) || !humanSeat(sd, posKey)) continue;
        done.add(username);
        try {
            const doc = await users.findOne(
                { username, mergedInto: { $exists: false } },
                { projection: { 'stats.gamesPlayed': 1, badgeProgress: 1, badges: 1 } }
            );
            if (!doc) continue;
            const fromGame = isPlainObject(sd.badges) && Array.isArray(sd.badges[posKey]) ? sd.badges[posKey] : [];
            const partner = sd.names[partnerOf(position)];
            const lifetime = await lifetimeBadges(doc, username, partner, gameRecords);
            const has = new Set((Array.isArray(doc.badges) ? doc.badges : []).map((b) => b?.id));
            const wanted = [...fromGame, ...lifetime].filter((id) => !has.has(id));
            if (wanted.length === 0) continue;
            const earned = await grant(users, username, wanted, { at, gameId: record.gameId });
            if (earned.length > 0) {
                out.push({ username, badges: earned });
                authLogger.info('Badges awarded', { username, gameId: record.gameId, badges: earned });
            }
        } catch (error) {
            authLogger.error('Error awarding badges', { username, gameId: record?.gameId, error: error.message });
        }
    }
    return out;
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
            const list = badges.map((id) => publicBadge(id)).filter(Boolean);
            if (list.length > 0) socket.emit('badgesAwarded', { gameId, badges: list });
        } catch (error) {
            authLogger.warn('Could not send badgesAwarded', { username, gameId, error: error.message });
        }
    }
}

/** awardForRecord + notify, never rejecting (the stats chain calls it). */
async function awardAndNotify(record, collections) {
    try {
        const awards = await awardForRecord(record, collections);
        notify(awards, record?.gameId);
        return awards;
    } catch (error) {
        authLogger.error('Badge awards failed', { gameId: record?.gameId, error: error.message });
        return [];
    }
}

module.exports = { BADGES_CAP, setIo, humanSeat, gamesTogether, grant, awardForRecord, notify, awardAndNotify };
