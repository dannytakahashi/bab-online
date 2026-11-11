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
 * @param {{users}} db
 * @param {Object} user - the user document (at least _id, sessionTokens, sessionToken)
 * @param {string} hash - bcrypt hash of the new password
 * @param {{now?: Date, stampField?: string}} [options]
 * @returns {Promise<number>} how many saved sessions were revoked
 */
async function writePasswordHash(db, user, hash, { now = new Date(), stampField = 'passwordResetByAdminAt' } = {}) {
    await db.users.updateOne(
        { _id: user._id },
        {
            $set: { password: hash, [stampField]: now },
            ...REVOKE_ALL_SESSIONS
        }
    );
    return (user.sessionTokens?.length || 0) + (user.sessionToken ? 1 : 0);
}

/** The sign-up password rule (validators.js signUp: 1-100 characters). */
function checkPasswordRule(newPassword) {
    return typeof newPassword === 'string' && newPassword.length >= 1 && newPassword.length <= 100;
}

/**
 * @param {{users}} db
 * @param {string} username
 * @param {string} newPassword
 * @returns {Promise<{username: string, revokedSessions: number}>}
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
    const revokedSessions = await writePasswordHash(db, user, hash, { now });
    return { username, revokedSessions };
}

module.exports = { setPassword, writePasswordHash, checkPasswordRule, generateFriendlyPassword, WORDS };
