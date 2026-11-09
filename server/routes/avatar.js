/**
 * GET/HEAD /avatar/:username[?v=<16 hex>] — a custom profile picture over
 * HTTP (roadmap item 10; docs/avatars.md).
 *
 * Public-internet facing. What it exposes is no more than any socket can
 * already read without signing in (getLeaderboard / searchPlayers /
 * getPlayerProfile return every customProfilePic and confirm which names
 * exist), and less: the body is always our own re-encoded WebP (sharp
 * output, <= 256 px, metadata stripped), never the stored bytes. Every
 * miss — unknown or deleted user, merged-away name, no custom picture,
 * invalid name, hostile or undecodable picture, pipeline off — gets the
 * same byte-identical 404, so a reason never leaks.
 *
 * Caching: `?v=` is the version of the stored picture (avatarStore
 * versionOf). Only a URL whose v is the current one is served immutable
 * for a year; a stale or absent v gets the current picture with
 * max-age=60 (stale clients still see the new avatar). The ETag is the
 * current version.
 *
 * Hammering: a versioned hit whose owner was confirmed in the last 10
 * minutes is served from memory (no DB read). Misses are cached for 60 s
 * per name (avatarStore.markMissing). Per client IP (utils/clientIp trust
 * rules: X-Real-IP only behind a proxy peer; unknown -> no per-IP key) a
 * token bucket of 120 requests refilling 2/s; globally at most 8 DB
 * lookups at once. Concurrent requests for one name share one lookup, and a
 * request waits up to 1.5 s for a lookup slot (at most 256 waiting) before
 * a 503; the derive queue is bounded too (503 when full). No file system
 * access: there is no path to traverse.
 *
 * Format: WebP, except when the request's Accept lists image types but not
 * image/webp (Safari 14/15 on macOS 10.15 and older send
 * "image/png,image/svg+xml,image/*;q=0.8,..."): then a PNG of the same
 * rendition. Every image response says Vary: Accept. No Accept, or a bare
 * * / *, gets WebP (curl, native clients).
 *
 * Mounted BEFORE express.static(client) in server/index.js. The response's
 * own Content-Security-Policy (sandbox) replaces the page CSP; the page's
 * img-src 'self' already allows same-origin /avatar URLs.
 */

'use strict';

const express = require('express');
const { getClientIp } = require('../utils/clientIp');
const { createModuleLogger } = require('../utils/logger');

const logger = createModuleLogger('avatar');

const V_RE = /^[0-9a-f]{16}$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex
const OWNER_RECHECK_MS = 10 * 60 * 1000;
const BUCKET = { burst: 120, perSec: 2, maxIps: 10000 };
const MAX_LOOKUPS = 8;
const LOOKUP_WAIT_MS = 1500;
const MAX_LOOKUP_WAITERS = 256;

/** Does this Accept header ask for images but not WebP (a browser that cannot decode it)? */
function wantsPng(accept) {
    if (typeof accept !== 'string' || accept.length === 0) return false;
    const a = accept.toLowerCase();
    return a.includes('image/') && !a.includes('image/webp');
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=60, must-revalidate';

/**
 * @param {Object} deps
 * @param {Function} deps.getUsersCollection
 * @param {Object} deps.avatarStore - server/avatar/avatarStore
 * @param {Function} [deps.now]
 * @param {Object} [deps.limits] - {burst, perSec, maxIps, maxLookups, lookupWaitMs, maxLookupWaiters} overrides (tests)
 */
function createAvatarRouter({ getUsersCollection, avatarStore, now = () => Date.now(), limits = {} }) {
    const router = express.Router();
    const bucketCfg = { ...BUCKET, ...limits };
    const maxLookups = limits.maxLookups ?? MAX_LOOKUPS;
    const lookupWaitMs = limits.lookupWaitMs ?? LOOKUP_WAIT_MS;
    const maxWaiters = limits.maxLookupWaiters ?? MAX_LOOKUP_WAITERS;
    const buckets = new Map(); // ip -> {tokens, at} (Map order = LRU)
    let lookups = 0;
    const waiters = [];        // {grant, timer} waiting for a lookup slot (FIFO)
    const pending = new Map(); // username -> Promise<doc|null> (one findOne per name at a time)

    /** A lookup slot: true when granted (now or within lookupWaitMs), false otherwise. */
    function acquire() {
        if (lookups < maxLookups) {
            lookups++;
            return Promise.resolve(true);
        }
        if (waiters.length >= maxWaiters) return Promise.resolve(false);
        return new Promise((resolve) => {
            const w = { grant: resolve, timer: null };
            w.timer = setTimeout(() => {
                const i = waiters.indexOf(w);
                if (i >= 0) waiters.splice(i, 1);
                resolve(false);
            }, lookupWaitMs);
            if (w.timer.unref) w.timer.unref();
            waiters.push(w);
        });
    }

    function release() {
        const w = waiters.shift();
        if (w) {
            clearTimeout(w.timer);
            w.grant(true); // the slot passes straight to the next waiter
        } else {
            lookups--;
        }
    }

    const busy = () => Object.assign(new Error('lookup busy'), { code: 'LOOKUP_BUSY' });

    /** The user's doc (projection), shared by concurrent requests for the same name. */
    function lookup(users, username) {
        let p = pending.get(username);
        if (p) return p;
        p = (async () => {
            if (!(await acquire())) throw busy();
            try {
                return await users.findOne({ username }, { projection: { customProfilePic: 1, mergedInto: 1 } });
            } finally {
                release();
            }
        })();
        pending.set(username, p);
        const clear = () => { if (pending.get(username) === p) pending.delete(username); };
        p.then(clear, clear);
        return p;
    }

    function take(ip) {
        if (!ip) return true; // unknown client address: global bounds only
        const t = now();
        let b = buckets.get(ip);
        if (b) {
            buckets.delete(ip);
            b.tokens = Math.min(bucketCfg.burst, b.tokens + ((t - b.at) / 1000) * bucketCfg.perSec);
            b.at = t;
        } else {
            b = { tokens: bucketCfg.burst, at: t };
        }
        buckets.set(ip, b);
        while (buckets.size > bucketCfg.maxIps) buckets.delete(buckets.keys().next().value);
        if (b.tokens < 1) return false;
        b.tokens -= 1;
        return true;
    }

    const common = (res) => {
        res.removeHeader('X-Powered-By');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    };

    function notFound(res) {
        common(res);
        res.status(404);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.removeHeader('ETag');
        res.end('Not found');
    }

    function unavailable(res, status, retryAfter, body) {
        common(res);
        res.status(status);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', String(retryAfter));
        res.end(body);
    }

    async function serve(req, res, entry, cur, immutable) {
        const png = wantsPng(req.headers.accept);
        let body = entry.webp;
        if (png) {
            body = await avatarStore.pngFor(cur, entry);
            if (!body) return unavailable(res, 503, 5, 'Service unavailable');
        }
        const etag = png ? `"${cur}-png"` : `"${cur}"`;
        common(res);
        res.setHeader('Vary', 'Accept');
        res.setHeader('Content-Type', png ? 'image/png' : 'image/webp');
        res.setHeader('Content-Length', String(body.length));
        res.setHeader('ETag', etag);
        res.setHeader('Content-Disposition', `inline; filename="avatar.${png ? 'png' : 'webp'}"`);
        res.setHeader('Cache-Control', immutable ? IMMUTABLE : REVALIDATE);
        if (req.headers['if-none-match'] === etag) {
            res.status(304);
            res.end();
            return undefined;
        }
        res.status(200);
        res.end(req.method === 'HEAD' ? undefined : body);
        return undefined;
    }

    router.use('/avatar', async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        try {
            const ip = getClientIp({ handshake: { address: req.socket?.remoteAddress, headers: req.headers } });
            if (!take(ip)) return unavailable(res, 429, 30, 'Too many requests');

            // req.path is the raw (still percent-encoded) rest of the path
            const rawName = req.path.slice(1);
            if (!rawName || rawName.includes('/')) return notFound(res);
            let username;
            try {
                username = decodeURIComponent(rawName);
            } catch {
                return notFound(res);
            }
            if (username.length < 1 || username.length > 50 || CONTROL_RE.test(username)) return notFound(res);
            const v = typeof req.query.v === 'string' && V_RE.test(req.query.v) ? req.query.v : null;

            if (!avatarStore.available()) return notFound(res);

            // Fast path: a versioned hit whose owner we confirmed recently
            if (v) {
                const e = avatarStore.peek(v);
                const seen = e && e.status === 'ok' ? e.owners.get(username) : undefined;
                if (seen !== undefined && now() - seen < OWNER_RECHECK_MS) return await serve(req, res, e, v, true);
            }

            if (avatarStore.isMissing(username)) return notFound(res);
            const users = getUsersCollection();
            if (!users) return unavailable(res, 503, 5, 'Service unavailable');
            let doc;
            try {
                doc = await lookup(users, username);
            } catch (e) {
                if (e.code !== 'LOOKUP_BUSY') logger.warn('avatar lookup failed', { error: e.message });
                return unavailable(res, 503, 5, 'Service unavailable');
            }
            const raw = doc && !doc.mergedInto ? doc.customProfilePic : null;
            if (typeof raw !== 'string' || !raw.startsWith('data:image')) {
                avatarStore.markMissing(username);
                return notFound(res);
            }
            const cur = avatarStore.versionOf(raw);
            let e;
            try {
                e = await avatarStore.ensure(username, raw);
            } catch (err) {
                if (err.code === 'AVATAR_BUSY') return unavailable(res, 503, 5, 'Service unavailable');
                throw err;
            }
            // a transient derive failure (retried after 60 s) is not a miss
            if (e && e.status === 'error') return unavailable(res, 503, 5, 'Service unavailable');
            if (!e || e.status !== 'ok') return notFound(res);
            avatarStore.markOwner(cur, username);
            return await serve(req, res, e, cur, v === cur);
        } catch (err) {
            logger.error('avatar route error', { error: err.message });
            if (!res.headersSent) return unavailable(res, 503, 5, 'Service unavailable');
            return undefined;
        }
    });

    router._stats = () => ({ ips: buckets.size, lookups, waiting: waiters.length, pending: pending.size });
    return router;
}

module.exports = { createAvatarRouter, wantsPng, OWNER_RECHECK_MS };
