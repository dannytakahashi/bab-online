/**
 * Admin password reset: set a new password for a player who forgot theirs
 * (the owner then tells them the new password in person or by text).
 * Revokes every saved session so other devices must sign in with it.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { REVOKE_ALL_SESSIONS } = require('../utils/sessionTokens');

// Short, unambiguous words that are easy to read aloud and type on a phone
const WORDS = [
    'apple', 'bear', 'birch', 'cedar', 'clover', 'coral', 'daisy', 'eagle',
    'fern', 'finch', 'garden', 'harbor', 'hazel', 'honey', 'island', 'lemon',
    'maple', 'meadow', 'mint', 'olive', 'otter', 'peach', 'pebble', 'pine',
    'plum', 'river', 'robin', 'sage', 'spruce', 'sunny', 'tulip', 'willow'
];

/** e.g. "maple-otter-42" */
function generateFriendlyPassword() {
    const pick = () => WORDS[crypto.randomInt(WORDS.length)];
    return `${pick()}-${pick()}-${crypto.randomInt(10, 100)}`;
}

/**
 * The password write both resets share (this CLI, and a one-time reset link:
 * server/admin/passwordReset.js): the new hash, a timestamp field naming
 * which reset it was, and every saved session revoked (the per-device
 * sessionTokens and the legacy plaintext sessionToken, with sessionEpoch
 * bumped so an in-flight sign-in or restore cannot write them back), so
 * every device has to sign in with the new password.
 *
 * One atomic findOneAndUpdate that returns the document as it was (like
 * the panel's Sign out everywhere): the count of sessions revoked is the
 * one actually removed, and its socketId names the newest live connection,
 * so the caller can sign it out even when the game manager has not
 * registered it yet (a sign-in or restore whose write landed just before
 * this one: authHandlers.signOutUser's socketId option).
 *
 * @param {{users}} db
 * @param {Object} user - the user document (at least _id)
 * @param {string} hash - bcrypt hash of the new password
 * @param {{now?: Date, stampField?: string}} [options]
 * @returns {Promise<{revokedSessions: number, socketId: string|null}>}
 */
async function writePasswordHash(db, user, hash, { now = new Date(), stampField = 'passwordResetByAdminAt' } = {}) {
    const before = await db.users.findOneAndUpdate(
        { _id: user._id },
        {
            $set: { password: hash, [stampField]: now },
            ...REVOKE_ALL_SESSIONS
        },
        { returnDocument: 'before', projection: { socketId: 1, 'sessionTokens.hash': 1, sessionToken: 1 } }
    );
    const was = before || {};
    return {
        revokedSessions: (was.sessionTokens?.length || 0) + (was.sessionToken ? 1 : 0),
        socketId: typeof was.socketId === 'string' ? was.socketId : null
    };
}

/** The sign-up password rule (validators.js signUp: 1-100 characters). */
function checkPasswordRule(newPassword) {
    return typeof newPassword === 'string' && newPassword.length >= 1 && newPassword.length <= 100;
}

/**
 * Cancel every open reset link of an account (passwordResets, made in the
 * admin panel: server/admin/passwordReset.js). Every action that locks an
 * account down runs it: this CLI's setPassword and the panel's Sign out
 * everywhere, so a link that leaked (texted to the wrong number, read off
 * a lost phone) stops working at once instead of for the rest of its 24 h.
 * Using a link needs nothing here: its own claim already marked it used.
 * Run BEFORE the account write: if it fails, nothing was changed.
 *
 * @param {{passwordResets?}} db - no passwordResets collection: nothing to cancel
 * @param {{username: string}} user
 * @param {{now?: Date}} [options]
 * @returns {Promise<number>} how many open links were cancelled
 */
async function revokeOpenResetLinks(db, user, { now = new Date() } = {}) {
    if (!db.passwordResets) return 0;
    const res = await db.passwordResets.updateMany(
        { username: user.username, state: 'open' },
        { $set: { state: 'revoked', revokedAt: now } }
    );
    return res.modifiedCount || 0;
}

/**
 * @param {{users, passwordResets?}} db
 * @param {string} username
 * @param {string} newPassword
 * @returns {Promise<{username: string, revokedSessions: number, revokedLinks: number}>}
 */
async function setPassword(db, username, newPassword, { now = new Date(), rounds = 10 } = {}) {
    if (!checkPasswordRule(newPassword)) {
        throw new Error('Password must be 1-100 characters.');
    }
    const user = await db.users.findOne({ username });
    if (!user) throw new Error(`Account "${username}" does not exist.`);
    if (user.mergedInto) {
        throw new Error(`"${username}" was merged into "${user.mergedInto}". Reset "${user.mergedInto}" instead.`);
    }

    const hash = await bcrypt.hash(newPassword, rounds);
    const revokedLinks = await revokeOpenResetLinks(db, user, { now });
    const { revokedSessions } = await writePasswordHash(db, user, hash, { now });
    return { username, revokedSessions, revokedLinks };
}

module.exports = { setPassword, writePasswordHash, revokeOpenResetLinks, checkPasswordRule, generateFriendlyPassword, WORDS };
