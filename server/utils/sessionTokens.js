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
 *
 * Revoking (sign out everywhere, a password reset, a merge retiring the
 * account) bumps `sessionEpoch` along with removing the sessions
 * (REVOKE_ALL_SESSIONS). issueSession / verifySession rewrite the whole
 * array they read, so their writes must go through `filter`: it matches only
 * while the epoch is still the one that read saw. A write that loses the
 * race to a revoke matches nothing (matchedCount 0) instead of putting every
 * revoked session back; the caller then treats the session as invalid.
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

/**
 * The update filter for a write built from `user`: matches only while no
 * revoke happened since that read (no sessionEpoch yet = never revoked).
 */
function sessionStateFilter(user) {
    const epoch = user ? user.sessionEpoch : undefined;
    return { sessionEpoch: epoch === undefined || epoch === null ? { $exists: false } : epoch };
}

/** The revoke every path shares: drop all saved sessions and bump the epoch. */
const REVOKE_ALL_SESSIONS = Object.freeze({
    $unset: Object.freeze({ sessionToken: '', sessionTokens: '' }),
    $inc: Object.freeze({ sessionEpoch: 1 })
});

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
 * @returns {{token: string, hash: string, filter: Object, update: Object}} update is a Mongo
 *          update document; add `filter` to the write's filter (sessionStateFilter)
 */
function issueSession(user, now = new Date()) {
    const token = uuidv4();
    const hash = hashToken(token);
    const sessions = [...currentSessions(user || {}, now), { hash, createdAt: now, lastUsedAt: now }]
        .slice(-MAX_SESSIONS);
    return {
        token,
        hash,
        filter: sessionStateFilter(user),
        update: { $set: { sessionTokens: sessions }, $unset: { sessionToken: '' } }
    };
}

/**
 * Check a token presented by a device.
 * @returns {{hash: string, filter: Object, update: Object}|null} null if invalid/expired;
 *          add `filter` to the write's filter (sessionStateFilter)
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
        filter: sessionStateFilter(user),
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
    REVOKE_ALL_SESSIONS,
    hasLiveSession,
    sessionStateFilter,
    SESSION_TTL_MS,
    hashToken,
    issueSession,
    verifySession
};
