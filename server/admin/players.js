/**
 * The admin panel's player rows: the Players table (listPlayers: every
 * account, newest first, capped at LIST_MAX) and the name search
 * (searchPlayers), with what an admin needs and nothing more — created (the _id timestamp), last seen (the
 * newest saved-session use: sign-in or restore), online now, games played
 * (human games, and bot games separately),
 * the admin flag, and for a tombstone the account it points at (merged
 * into it, or `renamed`: the old name a rename left), and for an account
 * whose rename stopped partway the old name (`renameUnfinished`: the
 * panel offers Finish rename).
 *
 * Never password data: the projection reads no password, no session hash
 * (only each session entry's timestamps), no IP, no picture.
 */

'use strict';

const LIMIT = 25;
const MAX_QUERY = 50;
/**
 * The Players table lists at most this many accounts (newest first) and
 * says so above the table when there are more (production has about 180).
 * The rows are small (no picture, no password, no session data), so 500
 * is one modest reply; past it the owner pages by sorting and filtering
 * the newest ones, or the cap is raised.
 */
const LIST_MAX = 500;

const PROJECTION = {
    username: 1, mergedInto: 1, renamedAt: 1, isAdmin: 1, 'stats.gamesPlayed': 1, 'botStats.gamesPlayed': 1, 'renamePending.from': 1,
    'sessionTokens.lastUsedAt': 1, 'sessionTokens.createdAt': 1
};

function iso(d) {
    if (!d) return null;
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function lastSeen(user) {
    let best = 0;
    for (const s of user.sessionTokens || []) {
        const t = new Date(s?.lastUsedAt || s?.createdAt || 0).getTime();
        if (t > best) best = t;
    }
    return best ? new Date(best).toISOString() : null;
}

function playerRow(user, isOnline) {
    return {
        username: user.username,
        createdAt: typeof user._id?.getTimestamp === 'function' ? iso(user._id.getTimestamp()) : null,
        lastSeenAt: user.mergedInto ? null : lastSeen(user),
        online: !user.mergedInto && Boolean(isOnline(user.username)),
        // human games (the leaderboard's default), and games with bots
        gamesPlayed: user.mergedInto ? 0 : Number(user.stats?.gamesPlayed) || 0,
        botGamesPlayed: user.mergedInto ? 0 : Number(user.botStats?.gamesPlayed) || 0,
        isAdmin: !user.mergedInto && user.isAdmin === true,
        mergedInto: user.mergedInto || null,
        // a rename's redirect (accountRename.js), not a merged account
        renamed: Boolean(user.mergedInto && user.renamedAt),
        // accountRename.js renamePending: the old name, while unfinished
        renameUnfinished: !user.mergedInto && typeof user.renamePending?.from === 'string' ? user.renamePending.from : null
    };
}

/**
 * Case-insensitive substring search (the player search's escaped regex),
 * tombstones included and marked. Exact name first, then live accounts,
 * then alphabetical.
 *
 * @param {{users}} db
 * @param {string} query
 * @param {{isOnline?: (username: string) => boolean}} [options]
 */
async function searchPlayers(db, query, { isOnline = () => false } = {}) {
    const q = String(query || '').trim();
    if (!q || q.length > MAX_QUERY) return [];
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const users = await db.users.find(
        { username: { $regex: escaped, $options: 'i' } },
        { projection: PROJECTION }
    ).limit(LIMIT).toArray();
    const lower = q.toLowerCase();
    return users
        .map(u => playerRow(u, isOnline))
        .sort((a, b) => (Number(b.username.toLowerCase() === lower) - Number(a.username.toLowerCase() === lower))
            || (Number(Boolean(a.mergedInto)) - Number(Boolean(b.mergedInto)))
            || a.username.localeCompare(b.username));
}

/**
 * Every account for the Players table, newest first (by _id time), at most
 * `limit`; tombstones included and marked (the table offers them Delete
 * only). `total` is the true count, so the panel can say when the list is
 * capped. Sorting and filtering happen in the panel.
 *
 * @param {{users}} db
 * @param {{isOnline?: (username: string) => boolean, limit?: number}} [options]
 * @returns {Promise<{players: Object[], total: number, limit: number}>}
 */
async function listPlayers(db, { isOnline = () => false, limit = LIST_MAX } = {}) {
    const [total, users] = await Promise.all([
        db.users.countDocuments({}),
        db.users.find({}, { projection: PROJECTION }).sort({ _id: -1 }).limit(limit).toArray()
    ]);
    return { players: users.map(u => playerRow(u, isOnline)), total, limit };
}

module.exports = { searchPlayers, listPlayers, playerRow, LIMIT, LIST_MAX, PROJECTION };
