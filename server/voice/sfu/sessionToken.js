/**
 * Proof that a Cloudflare session belongs to a member, which survives a
 * server restart (the roster is in memory, the media sessions live at
 * Cloudflare: after a deploy every client re-registers its SAME session with
 * sfuResume, and the new process must not take a session id on trust, or a
 * client could claim another member's session and close its tracks).
 *
 * token = base64url(HMAC-SHA256(key, "sfu1|<tournamentId>|<username>|<sessionId>"))
 * key   = HMAC-SHA256(CF_SFU_APP_SECRET, "bab-sfu-session-token-v1")
 *
 * Every instance with the same app secret verifies every other's tokens; a
 * rotated secret invalidates them (the clients then make new sessions). The
 * token is given only to the member that created the session (sfuReply op
 * session) and is never logged.
 */

'use strict';

const crypto = require('crypto');
const config = require('./config');

const LABEL = 'bab-sfu-session-token-v1';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function key(env) {
    const cfg = config.appConfig(env);
    if (!cfg) return null;
    return crypto.createHmac('sha256', cfg.secret).update(LABEL).digest();
}

/** The token for (tournamentId, username, sessionId), or null when the app is not configured. */
function sign({ tournamentId, username, sessionId }, env = process.env) {
    const k = key(env);
    if (!k) return null;
    return crypto.createHmac('sha256', k).update(`sfu1|${tournamentId}|${username}|${sessionId}`).digest('base64url');
}

/** Does `token` prove the session is `username`'s in this tournament? Constant time. */
function verify({ tournamentId, username, sessionId, token }, env = process.env) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
    const want = sign({ tournamentId, username, sessionId }, env);
    if (!want) return false;
    const a = Buffer.from(want);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { sign, verify, TOKEN_RE };
