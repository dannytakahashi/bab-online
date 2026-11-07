/**
 * Admin password reset: set a new password for a player who forgot theirs
 * (the owner then tells them the new password in person or by text).
 * Revokes every saved session so other devices must sign in with it.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

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
 * @param {{users}} db
 * @param {string} username
 * @param {string} newPassword
 * @returns {Promise<{username: string, revokedSessions: number}>}
 */
async function setPassword(db, username, newPassword, { now = new Date(), rounds = 10 } = {}) {
    if (typeof newPassword !== 'string' || newPassword.length < 1 || newPassword.length > 100) {
        throw new Error('Password must be 1-100 characters.');
    }
    const user = await db.users.findOne({ username });
    if (!user) throw new Error(`Account "${username}" does not exist.`);
    if (user.mergedInto) {
        throw new Error(`"${username}" was merged into "${user.mergedInto}". Reset "${user.mergedInto}" instead.`);
    }

    const hash = await bcrypt.hash(newPassword, rounds);
    await db.users.updateOne(
        { _id: user._id },
        {
            $set: { password: hash, passwordResetByAdminAt: now },
            $unset: { sessionToken: '', sessionTokens: '' }
        }
    );
    const revokedSessions = (user.sessionTokens?.length || 0) + (user.sessionToken ? 1 : 0);
    return { username, revokedSessions };
}

module.exports = { setPassword, generateFriendlyPassword, WORDS };
