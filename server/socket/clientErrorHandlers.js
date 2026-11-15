/**
 * Client error reports (c2s clientError; contract/src/c2s.js).
 *
 *   clientError {kind, message, stack?, where?, build?, page?}
 *
 * Web (client/src/telemetry/clientErrors.js) and iOS from the build after
 * 1.2.1 build 9 (ErrorReporter.swift) send one per kind per session: an
 * uncaught error, an unhandled rejection, a table seq gap, a failed table
 * step, an undecodable snapshot. Production web strips console.log and an
 * App Store build has no console we can read, so this log line is the only
 * place those errors show up.
 *
 * Never answered, never serverError (a client would toast it): a bad
 * payload, a report over a limit and every report while CLIENT_ERRORS=off
 * are dropped silently. Limits: 5 a minute and 50 a day per socket
 * (socket.data, dies with the socket), per client IP and server-wide
 * (rateLimiter.buckets clientErrorIp / clientErrorGlobal, which a reconnect
 * does not reset). Logged at warn with the signed-in username only; every
 * text field goes through scrub() first (URL queries and fragments, emails,
 * ids, long digit runs, IPs, quoted text such as a JSON snippet or a chat
 * line), and nothing else of the socket (no IP) is logged.
 */

'use strict';

const gameManager = require('../game/GameManager');
const rateLimiter = require('./rateLimiter');
const { validate } = require('./validators');
const { ipBucketKey } = require('../utils/clientIp');
const { socketLogger } = require('../utils/logger');

const PER_MINUTE = 5;
const PER_DAY = 50;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// One warn line when the server-wide cap bites, at most every 10 minutes
const CAP_WARN_EVERY_MS = 10 * 60 * 1000;
let lastCapWarnAt = 0;

/** CLIENT_ERRORS=off (also false / 0 / disabled / no): every report is ignored. Read per call. */
function enabled(env = process.env) {
    const v = String(env.CLIENT_ERRORS || '').trim().toLowerCase();
    return !['off', 'false', '0', 'disabled', 'no'].includes(v);
}

// A quoted run that is just an identifier or a property path ('x' in
// "reading 'x'") is kept: it says where it broke and is nobody's data
const IDENTIFIER = /^[A-Za-z_$][\w$.\-/]{0,63}$/;
const quoted = (q) => (m, inner) => (IDENTIFIER.test(inner) ? m : `${q}…${q}`);

/**
 * `text` with anything that could be someone's data replaced. Runs on
 * every field of every report, whatever the client already did.
 */
function scrub(text) {
    if (typeof text !== 'string' || !text) return '';
    // keep bundle positions (main-abc.js:1:234567): a long column is not a number of anyone's
    const positions = [];
    let s = text.replace(/(\.(?:m?js|swift)):(\d+)(?::(\d+))?/g, (m) => {
        positions.push(m);
        return `\u0000${positions.length - 1}\u0000`;
    });
    s = s
        // control characters (a forged multi-line log entry), tabs and newlines kept
        .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        // URLs: scheme, host and path only (a query or fragment can carry a token)
        .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#'"<>()]*)[?#][^\s'"<>()]*/gi, '$1')
        // relative paths with a query or fragment
        .replace(/(\/[^\s?#'"<>()]*)[?#][^\s'"<>()]*/g, '$1')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
        // token-like runs (base64url, JWT pieces; '/' left out so a bundle path survives)
        .replace(/[A-Za-z0-9+_-]{32,}={0,2}/g, '<redacted>')
        .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
        .replace(/\d{6,}/g, '<n>')
        // a picture URL names a player; a home folder names the developer
        .replace(/\/avatar\/[^\s/'"<>()]+/g, '/avatar/<user>')
        .replace(/\/(Users|home)\/[^\s/'"<>()]+/g, '/$1/<user>')
        // quoted text: JSON.parse and friends quote their input, which can be a chat line
        .replace(/"([^"\n]{0,500})"/g, quoted('"'))
        .replace(/(?<![A-Za-z])'([^'\n]{0,500})'(?![A-Za-z])/g, quoted('\''))
        .replace(/`([^`\n]{0,500})`/g, quoted('`'))
        .replace(/“([^”\n]{0,500})”/g, quoted('“'));
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => positions[Number(i)] ?? '');
}

/** Per-socket budget: 5 a minute, 50 a day (socket.data; a new socket starts fresh, the IP bucket does not). */
function socketAllows(socket, now) {
    if (!socket.data) socket.data = {};
    const b = socket.data.clientErrors || (socket.data.clientErrors = { recent: [], dayStart: now, day: 0 });
    if (now - b.dayStart >= DAY_MS) {
        b.dayStart = now;
        b.day = 0;
    }
    b.recent = b.recent.filter((t) => now - t < MINUTE_MS);
    if (b.recent.length >= PER_MINUTE || b.day >= PER_DAY) {
        if (!b.noted) {
            b.noted = true;
            socketLogger.debug('Client error reports dropped (socket limit)', { socketId: socket.id });
        }
        return false;
    }
    b.recent.push(now);
    b.day++;
    return true;
}

/** The per-IP and server-wide buckets, both checked before either is charged. */
function bucketsAllow(socket, now) {
    const ip = socket.data?.clientIp;
    const ipKey = ip ? ipBucketKey(ip) : null;
    if (ipKey && !rateLimiter.peek('clientErrorIp', ipKey, now).ok) return false;
    if (!rateLimiter.peek('clientErrorGlobal', 'all', now).ok) {
        if (now - lastCapWarnAt >= CAP_WARN_EVERY_MS) {
            lastCapWarnAt = now;
            socketLogger.warn('Client error reports capped (server-wide limit)', {});
        }
        return false;
    }
    if (ipKey) rateLimiter.take('clientErrorIp', ipKey, now);
    rateLimiter.take('clientErrorGlobal', 'all', now);
    return true;
}

/** The report Joi accepts, or null (dropped silently, like a refused voice signal). */
function checked(data) {
    try {
        return validate('clientError', data);
    } catch (_) {
        return null;
    }
}

/** clientError (registered with safeHandler: no wrapper schema, no reply). */
function clientError(socket, io, data, now = Date.now()) {
    if (!enabled()) return;
    const report = checked(data);
    if (!report) return;
    if (!socketAllows(socket, now) || !bucketsAllow(socket, now)) return;
    const username = gameManager.getUserBySocketId(socket.id)?.username ?? null;
    const client = socket.data?.client;
    socketLogger.warn('Client error', {
        kind: report.kind,
        message: scrub(report.message),
        stack: report.stack ? scrub(report.stack) : undefined,
        where: report.where ? scrub(report.where) : undefined,
        build: report.build ? scrub(report.build) : undefined,
        page: report.page || undefined,
        client: client?.client ?? (socket.data?.appBuild != null ? 'ios' : null),
        version: client?.version ?? null,
        appBuild: socket.data?.appBuild ?? null,
        username,
        socketId: socket.id
    });
}

/** Test helper. */
function _reset() {
    lastCapWarnAt = 0;
}

module.exports = { clientError, scrub, enabled, PER_MINUTE, PER_DAY, _reset };
