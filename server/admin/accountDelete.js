/**
 * Deleting an account: ONE implementation for the player's own Delete
 * account (authHandlers.deleteAccount; App Store Guideline 5.1.1(v)) and
 * the admin panel's (adminHandlers deleteAccount, owner 2026-11-11:
 * "ability to delete accounts from the admin panel").
 *
 * What a deletion removes or changes, keyed by the username:
 *   - open password reset links: revoked first (passwordResets keeps the
 *     used / revoked records as history; the link page refuses a deleted
 *     account anyway, this closes the link itself);
 *   - gameRecords: the name becomes '[deleted]' in team1Players /
 *     team2Players (shared documents: the other players keep their games);
 *   - other players' blockedUsers: for an ADMIN delete the name is pulled,
 *     so a new account that later takes the freed name does not start out
 *     blocked; a player's OWN delete keeps them (pullBlocks: false), so a
 *     blocked player cannot clear every block on their name by deleting
 *     the account and signing up again as the same name;
 *   - reports: KEPT for the record (the owner keeps the history of who
 *     reported whom), marked `reporterDeletedAt` / `reportedDeletedAt`, so
 *     a report about a deleted account is never read as one about a new
 *     account with the same name;
 *   - the user document itself (password hash, sessions, stats and with
 *     them the leaderboard row, pictures, block list, admin fields),
 *     deleted by _id AND name: if the account was renamed meanwhile (the
 *     CLI, another process; the panel and the self-delete share one queue,
 *     mergeQueue.js) nothing is deleted and eraseAccount throws;
 *   - the tombstones that point at it (`mergedInto: <name>`: accounts
 *     merged into it and the redirects its renames left), so nothing tied
 *     to the person remains and those names are free again.
 * Not changed: adminAudit (a log of what happened, by the names of the
 * time). Data first, the user document last: a failure partway leaves the
 * account in place, and deleting again finishes the job (every step is
 * safe to repeat).
 *
 * In memory (forgetAccount): the leaderboard / records caches, the avatar
 * store, `gameManager.deletedUsernames` (an in-flight game cannot write
 * the name back into a new game record), and the voice block lists of the
 * players whose lists changed (refreshBlockLists, without telling their
 * clients: a dead name in a client's list is harmless, and the App Store
 * iOS build shows every blockListUpdated as a "Block list updated." alert).
 *
 * Deleting a TOMBSTONE (deleteTombstone) is different: it removes only
 * that document, which frees the name. The account it points at keeps its
 * games and stats; for a merged name its `mergedFrom` entry moves to
 * `mergedFromFreed` (history kept), because `mergedFrom` is the merge's
 * "already merged" guard: a new account that signs up with the freed name
 * and is merged into the same account later gets its stats added.
 */

'use strict';

const { revokeOpenResetLinks } = require('./setPassword');
const { createModuleLogger } = require('../utils/logger');

const logger = createModuleLogger('admin');

const DELETED_NAME = '[deleted]';

/**
 * @param {{users, gameRecords?, reports?, passwordResets?}} db
 * @param {{_id: *, username: string}} user - the account, already checked by the caller
 * @param {{now?: Date}} [options]
 * @returns {Promise<{resetLinks: number, gameRecords: number, blockLists: number, blockers: string[], reports: number, tombstones: number}>}
 */
async function eraseAccount(db, user, { now = new Date(), pullBlocks = true } = {}) {
    const { username } = user;
    const out = { resetLinks: 0, gameRecords: 0, blockLists: 0, blockers: [], reports: 0, tombstones: 0 };

    out.resetLinks = await revokeOpenResetLinks(db, user, { now });

    if (db.gameRecords) {
        for (const team of ['team1Players', 'team2Players']) {
            const res = await db.gameRecords.updateMany(
                { [team]: username },
                { $set: { [`${team}.$[p]`]: DELETED_NAME } },
                { arrayFilters: [{ p: username }] }
            );
            out.gameRecords += res?.modifiedCount || 0;
        }
    }

    // Who blocked this name (their live sockets are told afterwards)
    const blockers = pullBlocks ? await db.users.find(
        { blockedUsers: username, _id: { $ne: user._id } },
        { projection: { username: 1 } }
    ).toArray() : [];
    if (blockers.length) {
        const res = await db.users.updateMany(
            { blockedUsers: username, _id: { $ne: user._id } },
            { $pull: { blockedUsers: username } }
        );
        out.blockLists = res?.modifiedCount || 0;
        out.blockers = blockers.map(b => b.username);
    }

    if (db.reports) {
        for (const [field, mark] of [['reporter', 'reporterDeletedAt'], ['reported', 'reportedDeletedAt']]) {
            const res = await db.reports.updateMany(
                { [field]: username, [mark]: { $exists: false } },
                { $set: { [mark]: now } }
            );
            out.reports += res?.modifiedCount || 0;
        }
    }

    const gone = await db.users.deleteOne({ _id: user._id, username, mergedInto: { $exists: false } });
    if (!gone?.deletedCount) {
        // Renamed or merged since the caller read it: never delete the
        // document under another name (deleting again finds it by its name)
        throw new Error(`eraseAccount: "${username}" changed before its document was deleted`);
    }
    out.tombstones = (await db.users.deleteMany({ mergedInto: username }))?.deletedCount || 0;
    return out;
}

/**
 * Delete one tombstone (a merged account, or the redirect a rename left):
 * that document only. Refused (null) when the name is not a tombstone by
 * the time of the write.
 * @returns {Promise<{username: string, mergedInto: string}|null>}
 */
async function deleteTombstone(db, username, { now = new Date() } = {}) {
    const doc = await db.users.findOne({ username, mergedInto: { $exists: true } }, { projection: { username: 1, mergedInto: 1 } });
    if (!doc) return null;
    // First (safe to repeat): the kept account's merge record of this name
    // stops counting as "already merged"
    const kept = await db.users.findOne(
        { username: doc.mergedInto, 'mergedFrom.username': username },
        { projection: { mergedFrom: 1 } }
    );
    const entries = (kept?.mergedFrom || []).filter(e => e && e.username === username);
    if (entries.length) {
        await db.users.updateOne(
            { _id: kept._id },
            {
                $pull: { mergedFrom: { username } },
                $push: { mergedFromFreed: { $each: entries.map(e => ({ ...e, nameFreedAt: now })) } }
            }
        );
    }
    const res = await db.users.deleteOne({ _id: doc._id, mergedInto: { $exists: true } });
    return res?.deletedCount ? { username: doc.username, mergedInto: doc.mergedInto } : null;
}

/**
 * The in-process state a deletion must reach (the caller signs the live
 * sockets out itself).
 * @param {Object} io
 * @param {{users}} db
 * @param {string} username
 * @param {{blockers?: string[]}} [erased] - eraseAccount's result
 * @returns {Promise<number>} live sockets whose block list was refreshed
 */
function forgetAccount(io, db, username, erased = {}) {
    const gameManager = require('../game/GameManager');
    const profile = require('../socket/profileHandlers');
    profile.invalidateLeaderboard?.();
    profile.invalidateRecords?.();
    require('../avatar/avatarStore').forgetUser?.(username);
    // Keep an in-flight game from re-inserting this username into a new
    // game record after the anonymization
    gameManager.deletedUsernames?.add(username);
    return refreshBlockLists(io, db, erased.blockers || [], { emit: false });
}

/**
 * Players whose saved block list changed (a deletion pulled a name, a
 * rename re-pointed one): their live sockets get the new list for voice
 * signaling (socket.data.blockedUsers). With `emit` (a rename) the clients
 * get it too, since they hide blocked players' chat by name and the
 * renamed player's chat would otherwise show: blockListUpdated, the reply
 * both clients already handle, with `silent: true` when asked (web then
 * updates without its "Block list updated" toast; the App Store iOS build
 * ignores the field and shows its "Block list updated." alert). Read from
 * the database, so it is the list as saved. Best effort: a failure only
 * means the list refreshes at the player's next sign-in.
 * @returns {Promise<number>} sockets updated
 */
async function refreshBlockLists(io, db, usernames, { emit = true, silent = false } = {}) {
    if (!usernames.length || !io?.sockets?.sockets || !db?.users) return 0;
    const gameManager = require('../game/GameManager');
    const { rememberBlockList } = require('../socket/voiceHandlers');
    let n = 0;
    try {
        const docs = await db.users.find({ username: { $in: usernames } }, { projection: { username: 1, blockedUsers: 1 } }).toArray();
        const lists = new Map(docs.map(d => [d.username, d.blockedUsers || []]));
        const owners = new Map((gameManager.currentUsers || []).map(u => [u.socketId, u.username]));
        for (const [id, sock] of io.sockets.sockets) {
            const name = owners.get(id) || sock?.data?.username;
            if (!lists.has(name)) continue;
            rememberBlockList(sock, lists.get(name));
            if (emit) sock.emit('blockListUpdated', { success: true, blockedUsers: lists.get(name), ...(silent ? { silent: true } : {}) });
            n++;
        }
    } catch (error) {
        logger.warn('Live block lists not refreshed (they refresh at the next sign-in)', { error: error.message });
    }
    return n;
}

module.exports = { eraseAccount, deleteTombstone, forgetAccount, refreshBlockLists, DELETED_NAME };
