/**
 * "Find a player" for the admin panel: name search with what an admin
 * needs and nothing more — created (the _id timestamp), last seen (the
 * newest saved-session use: sign-in or restore), online now, games played,
 * the admin flag, and for a merged tombstone the account it points at.
 *
 * Never password data: the projection reads no password, no session hash
 * (only each session entry's timestamps), no IP, no picture.
 */

'use strict';

const LIMIT = 25;
const MAX_QUERY = 50;

const PROJECTION = {
    username: 1, mergedInto: 1, isAdmin: 1, 'stats.gamesPlayed': 1,
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
        gamesPlayed: user.mergedInto ? 0 : Number(user.stats?.gamesPlayed) || 0,
        isAdmin: !user.mergedInto && user.isAdmin === true,
        mergedInto: user.mergedInto || null
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

module.exports = { searchPlayers, playerRow, LIMIT, PROJECTION };
