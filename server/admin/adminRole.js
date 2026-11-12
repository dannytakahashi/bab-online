/**
 * The admin role: `users.isAdmin: true` (with `adminSince` and `adminSetBy`
 * for the record). The first admin is set by the owner with
 * scripts/set-admin.js; after that admins add and remove admins from the
 * web panel (server/socket/adminHandlers.js).
 *
 * Rules:
 *   - a merged tombstone (`mergedInto`) is never an admin: setting it is
 *     refused, merging an admin away is refused (planMerge), and the
 *     tombstone write unsets the fields (accountMerge TOMBSTONE_UNSET);
 *   - removing an admin flag never leaves zero admins (the panel's
 *     last-admin guard). The guard is enforced after the write: remove,
 *     count, and put the flag back if nobody is left, so two admins
 *     removing each other at the same moment cannot both succeed.
 *
 * The flag is authority only as read from the database at request time;
 * the `isAdmin: true` on signInResponse / restoreSessionResponse is display
 * only (the web menu entry).
 */

'use strict';

const { AdminError } = require('./adminError');

const ADMIN_FILTER = { isAdmin: true, mergedInto: { $exists: false } };

/** Is this user document an admin right now? */
function isAdminDoc(user) {
    return Boolean(user) && user.isAdmin === true && !user.mergedInto;
}

/** Current admins, by name. Read-only. */
async function listAdmins(db) {
    const rows = await db.users.find(ADMIN_FILTER, { projection: { username: 1, adminSince: 1, adminSetBy: 1 } }).toArray();
    return rows
        .map(u => ({ username: u.username, adminSince: u.adminSince || null, adminSetBy: u.adminSetBy || null }))
        .sort((a, b) => a.username.localeCompare(b.username));
}

function countAdmins(db) {
    return db.users.countDocuments(ADMIN_FILTER);
}

/** The account a flag change targets: exists and is not a tombstone. */
async function findTarget(db, username) {
    const user = await db.users.findOne({ username }, { projection: { username: 1, mergedInto: 1, isAdmin: 1, adminSince: 1, adminSetBy: 1 } });
    if (!user) throw new AdminError('not_found', `No account is named "${username}" (names are case-sensitive).`);
    if (user.mergedInto) {
        throw new AdminError('refused', `"${username}" was merged into "${user.mergedInto}" and can't be an admin.`);
    }
    return user;
}

/**
 * Make `username` an admin, or remove its flag.
 *
 * @param {{users}} db
 * @param {string} username
 * @param {boolean} on
 * @param {{now?: Date, by?: string, allowNoAdmins?: boolean}} [options]
 *        by: who did it (stored as adminSetBy); allowNoAdmins: the owner's
 *        CLI may remove the last admin (it is the root of trust)
 * @returns {Promise<{username: string, isAdmin: boolean, changed: boolean}>}
 */
async function setAdminFlag(db, username, on, { now = new Date(), by = null, allowNoAdmins = false } = {}) {
    const user = await findTarget(db, username);
    if (on) {
        if (user.isAdmin === true) return { username, isAdmin: true, changed: false };
        const res = await db.users.updateOne(
            { _id: user._id, mergedInto: { $exists: false } },
            { $set: { isAdmin: true, adminSince: now, adminSetBy: by } }
        );
        if (!res.matchedCount) throw new AdminError('refused', `"${username}" changed while this ran. Try again.`);
        return { username, isAdmin: true, changed: true };
    }

    if (user.isAdmin !== true) return { username, isAdmin: false, changed: false };
    const res = await db.users.updateOne(
        { _id: user._id, isAdmin: true },
        { $unset: { isAdmin: '', adminSince: '', adminSetBy: '' } }
    );
    if (!res.modifiedCount) return { username, isAdmin: false, changed: false };
    if (!allowNoAdmins && (await countAdmins(db)) === 0) {
        // Put it back: the last admin stays
        const restore = { isAdmin: true };
        if (user.adminSince) restore.adminSince = user.adminSince;
        if (user.adminSetBy) restore.adminSetBy = user.adminSetBy;
        await db.users.updateOne({ _id: user._id, mergedInto: { $exists: false } }, { $set: restore });
        throw new AdminError('last_admin', `"${username}" is the only admin. Make someone else an admin first.`);
    }
    return { username, isAdmin: false, changed: true };
}

module.exports = { ADMIN_FILTER, isAdminDoc, listAdmins, countAdmins, setAdminFlag };
