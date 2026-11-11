/**
 * ICE servers for voice chat: short-lived Cloudflare Realtime TURN
 * credentials (owner, 2026-11-11), STUN only when TURN is not available.
 *
 * Cloudflare: POST {base}/v1/turn/keys/{KEY_ID}/credentials/generate-ice-servers
 * with `Authorization: Bearer <API_TOKEN>` and `{ ttl }` (seconds) answers
 * 201 `{ iceServers: [ {urls: [stun...]}, {urls: [turn..., turns...],
 * username, credential} ] }` (developers.cloudflare.com/realtime/turn/
 * generate-credentials). URLs on port 53 are dropped (browsers block the
 * port, so a candidate there only times out).
 *
 * Env (set on Railway by the owner; never logged, never sent to a client):
 *   CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN   both set = TURN on
 *   CLOUDFLARE_TURN_API_BASE   tests / dev only: a fake Cloudflare (ignored,
 *                              with one warning, when NODE_ENV=production)
 *
 * Credentials live TTL_SEC (4 h: a long game or tournament plus its lobby)
 * and are cached per username in memory while at least REUSE_MIN_REMAINING_SEC
 * (1 h) is left, i.e. for 3 of the 4 hours; concurrent requests share one
 * call. The Cloudflare call times out after FETCH_TIMEOUT_MS; any failure
 * (env unset, timeout, network, non-2xx, unexpected body) answers STUN only,
 * exactly the servers the clients used before, and a failed call holds off
 * new calls for FAILURE_BACKOFF_MS. At most MAX_MINTS_PER_MINUTE calls per
 * process per minute (cost guard; past it, STUN only).
 *
 * In-memory only (no database, nothing per user survives a restart), so an
 * account merge or deletion needs nothing here: an entry expires with its TTL.
 */

'use strict';

const { socketLogger } = require('../utils/logger');

/** What both clients hard-coded before TURN (and still use without it). */
const STUN_SERVERS = Object.freeze([
    Object.freeze({ urls: Object.freeze(['stun:stun.l.google.com:19302']) }),
    Object.freeze({ urls: Object.freeze(['stun:stun1.l.google.com:19302']) }),
]);

const DEFAULT_API_BASE = 'https://rtc.live.cloudflare.com';
const TTL_SEC = 4 * 60 * 60;
const REUSE_MIN_REMAINING_SEC = 60 * 60;
// Credentials are treated as expiring this much before Cloudflare's TTL
const EXPIRY_SKEW_SEC = 60;
const FETCH_TIMEOUT_MS = 2500;
const FAILURE_BACKOFF_MS = 60 * 1000;
const MAX_MINTS_PER_MINUTE = 120;
const MAX_CACHE_ENTRIES = 5000;

const MAX_URLS = 12;
const MAX_SERVERS = 8;
const MAX_FIELD = 512;
const ICE_URL = /^(stun|turn|turns):[^\s]{1,250}$/i;
const PORT_53 = /:53(?:[?/]|$)/;
const isTurnUrl = (u) => /^turns?:/i.test(u);

let warnedBase = false;

/** The TURN settings from the environment, or null (TURN off). */
function turnConfig(env = process.env) {
    const keyId = String(env.CLOUDFLARE_TURN_KEY_ID || '').trim();
    const token = String(env.CLOUDFLARE_TURN_API_TOKEN || '').trim();
    if (!keyId || !token) return null;
    // The key id goes into the URL path
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(keyId)) return null;
    let base = DEFAULT_API_BASE;
    const override = String(env.CLOUDFLARE_TURN_API_BASE || '').trim();
    if (override) {
        if (env.NODE_ENV === 'production') {
            if (!warnedBase) {
                warnedBase = true;
                socketLogger.warn('Voice TURN: CLOUDFLARE_TURN_API_BASE is ignored in production');
            }
        } else if (/^https?:\/\/[^\s]+$/.test(override)) {
            base = override.replace(/\/+$/, '');
        }
    }
    return { keyId, token, base };
}

/**
 * Keep only well-formed ICE servers from a Cloudflare reply: urls (strings
 * starting stun: / turn: / turns:, port 53 dropped), plus username and
 * credential for an entry with TURN urls. Null unless a TURN server remains.
 */
function sanitizeIceServers(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.iceServers)) return null;
    const out = [];
    for (const s of body.iceServers.slice(0, MAX_SERVERS)) {
        if (!s || typeof s !== 'object') continue;
        const raw = Array.isArray(s.urls) ? s.urls : [s.urls];
        const urls = raw.filter((u) => typeof u === 'string' && ICE_URL.test(u) && !PORT_53.test(u)).slice(0, MAX_URLS);
        if (urls.length === 0) continue;
        if (urls.some(isTurnUrl)) {
            const ok = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD;
            if (!ok(s.username) || !ok(s.credential)) continue;
            out.push({ urls, username: s.username, credential: s.credential });
        } else {
            out.push({ urls });
        }
    }
    return out.some((e) => e.urls.some(isTurnUrl)) ? out : null;
}

/** The STUN-only answer (fresh arrays: callers may serialize or mutate). */
function stunOnly() {
    return { iceServers: STUN_SERVERS.map((s) => ({ urls: [...s.urls] })), turn: false, expiresInSec: null };
}

/**
 * @param {Object} [deps]
 * @param {Function} [deps.fetch] - defaults to the global fetch (Node 18+)
 * @param {Function} [deps.now] - ms clock
 * @param {Function} [deps.env] - () => environment object
 * @param {Object} [deps.logger]
 */
function createTurnCredentials(deps = {}) {
    const doFetch = deps.fetch || ((...a) => globalThis.fetch(...a));
    const now = deps.now || Date.now;
    const getEnv = deps.env || (() => process.env);
    const log = deps.logger || socketLogger;

    const cache = new Map();      // username -> {iceServers, expiresAt}
    const inflight = new Map();   // username -> Promise<answer>
    let backoffUntil = 0;
    let windowStart = 0;
    let mintsInWindow = 0;

    const answerFrom = (entry, t) => ({
        iceServers: entry.iceServers.map((s) => ({ ...s, urls: [...s.urls] })),
        turn: true,
        expiresInSec: Math.max(0, Math.floor((entry.expiresAt - t) / 1000)),
    });

    /** A cached entry that is still valid at all (even under the reuse bar). */
    function validEntry(username, t) {
        const e = cache.get(username);
        if (!e) return null;
        if (e.expiresAt <= t) {
            cache.delete(username);
            return null;
        }
        return e;
    }

    function takeBudget(t) {
        if (t - windowStart >= 60 * 1000) {
            windowStart = t;
            mintsInWindow = 0;
        }
        if (mintsInWindow >= MAX_MINTS_PER_MINUTE) return false;
        mintsInWindow++;
        return true;
    }

    function store(username, iceServers, t) {
        cache.delete(username);
        cache.set(username, { iceServers, expiresAt: t + (TTL_SEC - EXPIRY_SKEW_SEC) * 1000 });
        if (cache.size <= MAX_CACHE_ENTRIES) return;
        for (const [k, e] of cache) if (e.expiresAt <= t) cache.delete(k);
        while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    }

    /** One Cloudflare call; resolves to sanitized ICE servers or null. Never throws. */
    async function mint(cfg) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        if (timer && typeof timer.unref === 'function') timer.unref();
        try {
            const res = await doFetch(`${cfg.base}/v1/turn/keys/${encodeURIComponent(cfg.keyId)}/credentials/generate-ice-servers`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ttl: TTL_SEC }),
                signal: ac.signal,
            });
            if (!res || !res.ok) {
                log.warn('Voice TURN: credential request refused', { status: res ? res.status : null });
                return null;
            }
            const servers = sanitizeIceServers(await res.json());
            if (!servers) log.warn('Voice TURN: unexpected credential response shape');
            return servers;
        } catch (err) {
            // Only the kind of failure: an error message could carry the URL
            log.warn('Voice TURN: credential request failed', { reason: ac.signal.aborted ? 'timeout' : 'network' });
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * ICE servers for `username`: cached TURN credentials, freshly minted
     * ones, or STUN only. Never rejects.
     * @returns {Promise<{iceServers: Array, turn: boolean, expiresInSec: number|null}>}
     */
    async function getIceServers(username) {
        const cfg = turnConfig(getEnv());
        if (!cfg || typeof username !== 'string' || !username) return stunOnly();
        const t = now();
        const hit = validEntry(username, t);
        if (hit && hit.expiresAt - t >= REUSE_MIN_REMAINING_SEC * 1000) return answerFrom(hit, t);
        if (inflight.has(username)) return inflight.get(username);
        // Cloudflare failing or the budget spent: the old entry while it lasts
        if (t < backoffUntil || !takeBudget(t)) return hit ? answerFrom(hit, t) : stunOnly();
        const p = mint(cfg).then((servers) => {
            const t2 = now();
            if (servers) {
                backoffUntil = 0;
                store(username, servers, t2);
                return answerFrom(cache.get(username), t2);
            }
            backoffUntil = t2 + FAILURE_BACKOFF_MS;
            const old = validEntry(username, t2);
            return old ? answerFrom(old, t2) : stunOnly();
        }).finally(() => inflight.delete(username));
        inflight.set(username, p);
        return p;
    }

    function _reset() {
        cache.clear();
        inflight.clear();
        backoffUntil = 0;
        windowStart = 0;
        mintsInWindow = 0;
    }

    return { getIceServers, _reset, _cache: cache };
}

const shared = createTurnCredentials();

module.exports = {
    getIceServers: (username) => shared.getIceServers(username),
    _reset: () => shared._reset(),
    createTurnCredentials,
    sanitizeIceServers,
    turnConfig,
    stunOnly,
    STUN_SERVERS,
    TTL_SEC,
    REUSE_MIN_REMAINING_SEC,
    FETCH_TIMEOUT_MS,
    FAILURE_BACKOFF_MS,
    MAX_MINTS_PER_MINUTE,
};
