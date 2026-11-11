/**
 * Per-device session tokens ("stay signed in").
 *
 * Each device that signs in gets its own random token; the user document
 * stores only a SHA-256 hash of it in `sessionTokens`, newest last, capped
 * at MAX_SESSIONS and expiring SESSION_TTL_MS after last use. Signing in on
 * one device no longer invalidates the others, so a player who plays on a
 * phone and a computer isn't sent back to the password screen every time.
 *
 * Users created before this change have a single plaintext `sessionToken`;
 * it's still accepted and is migrated into `sessionTokens` on next use.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const MAX_SESSIONS = 5;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isLive(entry, now) {
    const lastUsed = new Date(entry.lastUsedAt || entry.createdAt || 0).getTime();
    return now.getTime() - lastUsed < SESSION_TTL_MS;
}

/** Live sessions, with a legacy plaintext token folded in as a hashed entry. */
function currentSessions(user, now) {
    const sessions = (user.sessionTokens || []).filter(e => e && e.hash && isLive(e, now));
    if (user.sessionToken && !sessions.some(e => e.hash === hashToken(user.sessionToken))) {
        sessions.unshift({ hash: hashToken(user.sessionToken), createdAt: now, lastUsedAt: now });
    }
    return sessions;
}

/**
 * Issue a token for a new device.
 * @returns {{token: string, hash: string, update: Object}} update is a Mongo update document
 */
function issueSession(user, now = new Date()) {
    const token = uuidv4();
    const hash = hashToken(token);
    const sessions = [...currentSessions(user || {}, now), { hash, createdAt: now, lastUsedAt: now }]
        .slice(-MAX_SESSIONS);
    return {
        token,
        hash,
        update: { $set: { sessionTokens: sessions }, $unset: { sessionToken: '' } }
    };
}

/**
 * Check a token presented by a device.
 * @returns {{hash: string, update: Object}|null} null if invalid/expired
 */
function verifySession(user, token, now = new Date()) {
    if (!user || !token) return null;
    const hash = hashToken(token);
    const sessions = currentSessions(user, now);
    const entry = sessions.find(e => e.hash === hash);
    if (!entry) return null;
    entry.lastUsedAt = now;
    return {
        hash,
        update: { $set: { sessionTokens: sessions }, $unset: { sessionToken: '' } }
    };
}

/**
 * Is `hash` (a socket's socket.data.sessionHash) still one of the user's
 * live sessions? False once the sessions were revoked (sign out
 * everywhere, a password reset) even while that socket stays connected.
 */
function hasLiveSession(user, hash, now = new Date()) {
    if (!user || !hash) return false;
    return currentSessions(user, now).some(e => e.hash === hash);
}

module.exports = {
    MAX_SESSIONS,
    hasLiveSession,
    SESSION_TTL_MS,
    hashToken,
    issueSession,
    verifySession
};
