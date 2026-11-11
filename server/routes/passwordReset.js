/**
 * The player's side of a reset link (server/admin/passwordReset.js):
 *
 *   GET  /reset                  the standalone page (client/dist/reset.html)
 *   POST /api/password-reset     {token, password} → {ok, error?, message}
 *
 * The link is https://<host>/reset#<token>. The token is in the URL
 * FRAGMENT, which a browser never sends to a server: it is not in the GET
 * request line, so no request logger, proxy or Railway edge log ever sees
 * it, and a fragment is never part of a Referer. The page reads it from
 * location.hash, drops it from the address bar, and POSTs it in the JSON
 * body (requestLogger logs the URL only, never a body). The page and the
 * API also send Referrer-Policy: no-referrer and Cache-Control: no-store.
 *
 * The page bypasses the phone gate by construction: it is its own HTML
 * with its own small entry (src/reset/resetPage.js, the kit and tokens),
 * not index.html, so neither the gate (src/boot/) nor the game bundle
 * loads. The player gets the link by text, usually on a phone.
 *
 * The API is CSRF-safe without a token of its own: it reads no cookie (the
 * app has none), takes JSON only (a cross-site form cannot send
 * application/json without a CORS preflight, which this route never
 * answers), and refuses a cross-site Origin / Sec-Fetch-Site outright.
 * Same-origin, inside the page CSP (connect-src 'self').
 *
 * Every refusal of a link (malformed, unknown, expired, used, superseded,
 * merged or deleted account) is the same 400 {error:'invalid_link'}, so
 * the endpoint says nothing about accounts or links. Rate limits:
 *   - a token bucket per client (utils/clientIp trust rules; an IPv6
 *     address counts by its /64, which one home or server holds) of 10
 *     attempts, refilling 10 per 15 minutes, charged for every POST;
 *   - one bucket for everyone together (60, refilling 1 a second) and at
 *     most 4 password hashes at once, both charged ONLY for an attempt
 *     that will hash: a well-formed token naming an open, unexpired link.
 *     Junk (a malformed or unknown token) never touches them, so nobody
 *     without a real link can drain them and lock real players out; the
 *     256-bit tokens make guessing pointless anyway, so these bound the
 *     bcrypt work, not guessing. A request with an unknown client address
 *     skips the per-client bucket, and only reaches the hash with a real
 *     link.
 * Success signs out every live socket of the player (forceLogout, the
 * normal signed-out flow) after their saved sessions were revoked.
 */

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const express = require('express');
const passwordHash = require('../utils/passwordHash');
const { getClientIp } = require('../utils/clientIp');
const { useResetLink, INVALID_LINK } = require('../admin/passwordReset');
const { recordAudit } = require('../admin/audit');
const { createModuleLogger } = require('../utils/logger');

const logger = createModuleLogger('auth');

const CLIENT = path.join(__dirname, '..', '..', 'client');

const MESSAGES = {
    ok: 'Password changed. Sign in with your new password on the app or the website.',
    invalid_link: 'This reset link is not valid any more. It may have expired or been used already. Ask for a new link.',
    invalid_password: 'Password must be 1-100 characters.',
    invalid_request: 'Something was wrong with that request. Reload the page and try again.',
    rate_limited: 'Too many attempts. Wait a few minutes and try again.',
    unavailable: 'The server is busy. Try again in a moment.',
    forbidden: 'This page only works on the BAB Online website.'
};

const BUCKET = { burst: 10, perSec: 10 / (15 * 60), maxIps: 10000, globalBurst: 60, globalPerSec: 1 };
const MAX_IN_FLIGHT = 4;

const NO_STORE = (res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
};

/**
 * The per-client bucket key: an IPv4 address as is, an IPv6 address by its
 * /64 (a home or VPS gets a whole /64, so per-address keys would let one
 * client rotate through billions of buckets).
 */
function clientKey(ip) {
    if (!net.isIPv6(ip)) return ip;
    let s = ip.toLowerCase().split('%')[0];
    if (s.includes('.')) { // an embedded IPv4 tail (e.g. 64:ff9b::192.0.2.1)
        const cut = s.lastIndexOf(':') + 1;
        const n = s.slice(cut).split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
        s = `${s.slice(0, cut)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const [h, t] = s.split('::');
    const head = h ? h.split(':') : [];
    const tail = t ? t.split(':') : [];
    const groups = t === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** Thrown by the gated hash: the reset never reached bcrypt. */
const gateError = (code) => Object.assign(new Error(code), { code });

function send(res, status, error) {
    NO_STORE(res);
    const body = error === 'ok' ? { ok: true, message: MESSAGES.ok } : { ok: false, error, message: MESSAGES[error] };
    res.status(status).json(body);
}

/** Origin / Sec-Fetch-Site say this POST came from our own page (or say nothing: curl, old browsers). */
function sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
}

/**
 * @param {Object} deps
 * @param {() => {users, passwordResets, adminAudit}} deps.getDb
 * @param {() => Object} deps.getIo - the Socket.IO server (created after the routes)
 * @param {(io, username) => number} deps.signOutUser
 * @param {(pw: string) => Promise<string>} [deps.hash]
 * @param {() => number} [deps.now]
 * @param {string} [deps.clientDir]
 * @param {Object} [deps.limits] - {burst, perSec, maxIps, globalBurst, globalPerSec, maxInFlight} (tests)
 */
function createPasswordResetRouter({ getDb, getIo, signOutUser, hash = (pw) => passwordHash.hash(pw, 10), now = () => Date.now(), clientDir = CLIENT, limits = {} }) {
    const router = express.Router();
    const page = path.join(clientDir, 'dist', 'reset.html');
    const bucketCfg = { ...BUCKET, ...limits };
    const maxInFlight = limits.maxInFlight ?? MAX_IN_FLIGHT;
    const buckets = new Map();
    const global = { tokens: bucketCfg.globalBurst, at: now() };
    let inFlight = 0;

    function takeGlobal() {
        const t = now();
        global.tokens = Math.min(bucketCfg.globalBurst, global.tokens + ((t - global.at) / 1000) * bucketCfg.globalPerSec);
        global.at = t;
        if (global.tokens < 1) return false;
        global.tokens -= 1;
        return true;
    }

    function take(ip) {
        if (!ip) return true; // unknown address: only a real link reaches the global bucket and the hash
        const key = clientKey(ip);
        const t = now();
        let b = buckets.get(key);
        if (b) {
            buckets.delete(key);
            b.tokens = Math.min(bucketCfg.burst, b.tokens + ((t - b.at) / 1000) * bucketCfg.perSec);
            b.at = t;
        } else {
            b = { tokens: bucketCfg.burst, at: t };
            if (buckets.size >= bucketCfg.maxIps) buckets.delete(buckets.keys().next().value);
        }
        buckets.set(key, b);
        if (b.tokens < 1) return false;
        b.tokens -= 1;
        return true;
    }

    router.get('/reset', (req, res, next) => {
        fs.stat(page, (err) => {
            NO_STORE(res);
            res.setHeader('X-Frame-Options', 'DENY');
            if (err) {
                res.status(503).type('text/plain').send('Web client not built: run `npm run build:client`.');
                return;
            }
            res.sendFile(page, { cacheControl: false }, (sendErr) => {
                if (sendErr && !res.headersSent) next(sendErr);
            });
        });
    });

    /**
     * The hash useResetLink calls, and only once the token named an open,
     * unexpired link: so the global bucket and the in-flight cap are
     * charged for real attempts, never for junk.
     */
    async function gatedHash(pw) {
        if (inFlight >= maxInFlight) throw gateError('RESET_BUSY');
        if (!takeGlobal()) throw gateError('RESET_RATE_LIMITED');
        inFlight++;
        try {
            return await hash(pw);
        } finally {
            inFlight--;
        }
    }

    const json = express.json({ limit: '2kb', strict: true, type: () => true });

    router.post('/api/password-reset', (req, res, next) => {
        if (!sameOrigin(req)) return send(res, 403, 'forbidden');
        if (!req.is('application/json')) return send(res, 415, 'invalid_request');
        const ip = getClientIp({ handshake: { address: req.socket?.remoteAddress, headers: req.headers } });
        if (!take(ip)) return send(res, 429, 'rate_limited');
        return json(req, res, (err) => {
            // A parse error carries the raw body: never log it
            if (err) return send(res, 400, 'invalid_request');
            return next();
        });
    }, async (req, res) => {
        const { token, password } = req.body || {};
        const db = getDb();
        try {
            if (!db.users || !db.passwordResets) return send(res, 503, 'unavailable');
            const result = await useResetLink(db, token, password, { now: new Date(now()), hash: gatedHash });
            if (!result.ok) return send(res, 400, result === INVALID_LINK ? 'invalid_link' : 'invalid_password');
            const disconnected = signOutUser(getIo(), result.username);
            logger.info('Password changed by reset link', { username: result.username, revokedSessions: result.revokedSessions, disconnected });
            await recordAudit(db, {
                actor: result.username,
                action: 'useResetLink',
                target: result.username,
                result: 'ok',
                detail: `password changed; ${result.revokedSessions} saved session(s) revoked, ${disconnected} live connection(s) signed out`
            });
            return send(res, 200, 'ok');
        } catch (error) {
            if (error.code === 'RESET_RATE_LIMITED') return send(res, 429, 'rate_limited');
            if (error.code === 'RESET_BUSY') return send(res, 503, 'unavailable');
            logger.error('Password reset by link failed', { error: error.code === 'HASH_BUSY' ? 'hash busy' : error.message });
            return send(res, 503, 'unavailable');
        }
    });

    return router;
}

module.exports = { createPasswordResetRouter, MESSAGES, sameOrigin, clientKey };
