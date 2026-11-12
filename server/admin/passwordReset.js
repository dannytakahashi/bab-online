/**
 * One-time password reset links (owner, 2026-11-11: "a one-time link with
 * a Copy button. NO email sending"). An admin makes a link in the web panel
 * and texts it to the player; the player opens it (the standalone /reset
 * page, server/routes/passwordReset.js), sets a new password, and every
 * saved device is signed out.
 *
 * Collection `passwordResets`, one document per link:
 *   { tokenHash, username, userId, state: 'open'|'used'|'revoked',
 *     createdAt, expiresAt, createdBy, usedAt?, revokedAt? }
 *
 *   - the token is 32 bytes from crypto.randomBytes (256 bits), base64url
 *     (43 characters); only its SHA-256 (sessionTokens.hashToken) is
 *     stored, so a database read never yields a working link;
 *   - valid for RESET_TTL_MS (24 h) and once: the claim is ONE
 *     findOneAndUpdate on {tokenHash, state:'open', expiresAt > now}, so two
 *     tabs submitting the same link get exactly one success;
 *   - a new link for the same player revokes the older open ones (and a
 *     partial unique index on {username} where state is 'open' keeps it to
 *     one even when two admins click at once: database.js);
 *   - every refusal of a token (malformed, unknown, expired, used,
 *     revoked, its account gone or merged) is the same INVALID_LINK result,
 *     so the page cannot be used to learn anything.
 *
 * Never log, audit or return the token anywhere but to the admin who made
 * it (adminResponse) — and never the password.
 */

'use strict';

const crypto = require('crypto');
const { hashToken } = require('../utils/sessionTokens');
const { writePasswordHash, checkPasswordRule } = require('./setPassword');
const { AdminError } = require('./adminError');

const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const INVALID_LINK = Object.freeze({ ok: false, error: 'invalid_link' });
const INVALID_PASSWORD = Object.freeze({ ok: false, error: 'invalid_password' });

function newToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Make a reset link for `username` (revoking any older open one).
 *
 * @param {{users, passwordResets}} db
 * @param {string} username
 * @param {{now?: Date, by?: string}} [options]
 * @returns {Promise<{token: string, username: string, expiresAt: Date, revoked: number}>}
 *          token is the secret: hand it to the admin, nowhere else
 */
async function createResetLink(db, username, { now = new Date(), by = null } = {}) {
    const user = await db.users.findOne({ username }, { projection: { username: 1, mergedInto: 1 } });
    if (!user) throw new AdminError('not_found', `No account is named "${username}" (names are case-sensitive).`);
    if (user.mergedInto) {
        throw new AdminError('refused', `"${username}" was merged into "${user.mergedInto}". Make the link for "${user.mergedInto}" instead.`);
    }

    let revoked = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await db.passwordResets.updateMany(
            { username, state: 'open' },
            { $set: { state: 'revoked', revokedAt: now } }
        );
        revoked += res.modifiedCount || 0;
        const token = newToken();
        const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
        try {
            await db.passwordResets.insertOne({
                tokenHash: hashToken(token),
                username,
                userId: user._id,
                state: 'open',
                createdAt: now,
                expiresAt,
                createdBy: by
            });
            return { token, username, expiresAt, revoked };
        } catch (error) {
            // Another admin's link for the same player landed between the
            // revoke and the insert (the one-open-link index): revoke again
            if (error && error.code === 11000) continue;
            throw error;
        }
    }
    throw new AdminError('refused', 'Another reset link for this player is being made right now. Try again.');
}

/** Is this string shaped like one of our tokens? (Cheap pre-filter.) */
function isTokenShaped(token) {
    return typeof token === 'string' && TOKEN_RE.test(token);
}

/**
 * Use a reset link: set the new password and sign out every device.
 *
 * Order: cheap checks (shape, password rule, an open unexpired link exists)
 * → hash the password (slow) → claim the link atomically → write the
 * password. The claim comes after the hash so the window between claiming
 * and writing is one update; if that write fails the claim is released, so
 * a database hiccup does not burn the player's link.
 *
 * @param {{users, passwordResets}} db
 * @param {string} token
 * @param {string} password
 * @param {{now?: Date, hash: (pw: string) => Promise<string>}} options
 * @returns {Promise<{ok: true, username: string, revokedSessions: number, socketId: string|null}
 *                  | {ok: false, error: 'invalid_link'|'invalid_password'}>}
 */
async function useResetLink(db, token, password, { now = new Date(), hash }) {
    if (!isTokenShaped(token)) return INVALID_LINK;
    if (!checkPasswordRule(password)) return INVALID_PASSWORD;

    const tokenHash = hashToken(token);
    const openFilter = { tokenHash, state: 'open', expiresAt: { $gt: now } };
    const pending = await db.passwordResets.findOne(openFilter, { projection: { _id: 1 } });
    if (!pending) return INVALID_LINK;

    const passwordHash = await hash(password);

    const claimed = await db.passwordResets.findOneAndUpdate(
        openFilter,
        { $set: { state: 'used', usedAt: now } },
        { returnDocument: 'after', projection: { username: 1, userId: 1 } }
    );
    if (!claimed) return INVALID_LINK; // the other tab won

    const user = await db.users.findOne(
        { _id: claimed.userId, username: claimed.username },
        { projection: { username: 1, mergedInto: 1, sessionTokens: 1, sessionToken: 1 } }
    );
    if (!user || user.mergedInto) return INVALID_LINK; // deleted or merged since

    try {
        const { revokedSessions, socketId } = await writePasswordHash(db, user, passwordHash, { now, stampField: 'passwordResetByLinkAt' });
        return { ok: true, username: user.username, revokedSessions, socketId };
    } catch (error) {
        await db.passwordResets.updateOne(
            { _id: claimed._id, state: 'used', usedAt: now },
            { $set: { state: 'open' }, $unset: { usedAt: '' } }
        ).catch(() => {});
        throw error;
    }
}

module.exports = {
    RESET_TTL_MS,
    TOKEN_BYTES,
    INVALID_LINK,
    INVALID_PASSWORD,
    createResetLink,
    useResetLink,
    isTokenShaped
};
