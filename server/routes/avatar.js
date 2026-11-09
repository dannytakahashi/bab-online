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
 * lookups at once and the bounded derive queue (503 when full). No file
 * system access: there is no path to traverse.
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

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=60, must-revalidate';

/**
 * @param {Object} deps
 * @param {Function} deps.getUsersCollection
 * @param {Object} deps.avatarStore - server/avatar/avatarStore
 * @param {Function} [deps.now]
 * @param {Object} [deps.limits] - {burst, perSec, maxIps, maxLookups} overrides (tests)
 */
function createAvatarRouter({ getUsersCollection, avatarStore, now = () => Date.now(), limits = {} }) {
    const router = express.Router();
    const bucketCfg = { ...BUCKET, ...limits };
    const maxLookups = limits.maxLookups ?? MAX_LOOKUPS;
    const buckets = new Map(); // ip -> {tokens, at} (Map order = LRU)
    let lookups = 0;

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

    function serve(req, res, entry, cur, immutable) {
        common(res);
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Content-Length', String(entry.webp.length));
        res.setHeader('ETag', `"${cur}"`);
        res.setHeader('Content-Disposition', 'inline; filename="avatar.webp"');
        res.setHeader('Cache-Control', immutable ? IMMUTABLE : REVALIDATE);
        if (req.headers['if-none-match'] === `"${cur}"`) {
            res.status(304);
            res.end();
            return;
        }
        res.status(200);
        res.end(req.method === 'HEAD' ? undefined : entry.webp);
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
                if (seen !== undefined && now() - seen < OWNER_RECHECK_MS) return serve(req, res, e, v, true);
            }

            if (avatarStore.isMissing(username)) return notFound(res);
            const users = getUsersCollection();
            if (!users) return unavailable(res, 503, 5, 'Service unavailable');
            if (lookups >= maxLookups) return unavailable(res, 503, 5, 'Service unavailable');
            lookups++;
            let doc;
            try {
                doc = await users.findOne({ username }, { projection: { customProfilePic: 1, mergedInto: 1 } });
            } catch (e) {
                logger.warn('avatar lookup failed', { error: e.message });
                return unavailable(res, 503, 5, 'Service unavailable');
            } finally {
                lookups--;
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
            if (!e || e.status !== 'ok') return notFound(res);
            avatarStore.markOwner(cur, username);
            return serve(req, res, e, cur, v === cur);
        } catch (err) {
            logger.error('avatar route error', { error: err.message });
            if (!res.headersSent) return unavailable(res, 503, 5, 'Service unavailable');
            return undefined;
        }
    });

    router._stats = () => ({ ips: buckets.size, lookups });
    return router;
}

module.exports = { createAvatarRouter, OWNER_RECHECK_MS };
