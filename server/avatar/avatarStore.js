/**
 * Avatar rendition store (roadmap item 10; docs/avatars.md).
 *
 * Lazy, byte-bounded, never blocking the game path:
 *   - versionOf(raw): sha256 of the stored custom picture (16 hex), the `v`
 *     of /avatar/<username>?v=<v>. 'r1' is the rendition revision: bump it
 *     when the encoder settings change and every URL changes with it.
 *   - warm(username, raw): synchronous, never throws; starts deriving a
 *     rendition that is missing (getUserProfilePic calls it on every
 *     lookup, so the derive runs while the draw reveal holds the table).
 *   - ensure(username, raw): awaits the rendition (profile replies, HTTP).
 *   - peek(v): synchronous; what emit-time mapping (avatarWire.js) reads.
 * Each version is derived at most once at a time (inflight), by at most 2
 * concurrent derives with a queue of at most 64 (full: warm is a no-op and
 * the payload keeps today's value; ensure rejects with code AVATAR_BUSY).
 * EVERY decode in the process runs under that semaphore: stored pictures
 * (warm/ensure), new uploads (deriveUpload) and the PNG renditions for
 * non-WebP browsers (pngFor). So at most 2 libvips decodes run at once
 * (2 of libuv's 4 threadpool threads; fs, dns and zlib keep the rest).
 * A transient failure (libvips timeout, a thrown derive) is cached for 60 s
 * only (status 'error'), then derived again; 'hostile' and 'undecodable'
 * are verdicts on the bytes and stay cached.
 *
 * Memory: renditions live in an LRU bounded by BYTES (webp + inline data
 * URL, default 32 MB, AVATAR_CACHE_MB); raw stored strings are never kept
 * (a queued derive references the stored string, which its caller holds
 * anyway, until it runs; at most 64 are queued).
 * `owners` records which usernames were seen holding a version and when:
 * the HTTP fast path serves a versioned hit without a DB read only while
 * that check is younger than 10 minutes. `missing` is the HTTP negative
 * cache (60 s, at most 5,000 names).
 *
 * Nothing here touches Math.random or the database.
 */

'use strict';

const crypto = require('crypto');
const config = require('../config');
const image = require('./image');
const { createModuleLogger } = require('../utils/logger');

const logger = createModuleLogger('avatar');

const RENDITION_REV = 'r1';
const MISSING_TTL_MS = 60000;
const MISSING_MAX = 5000;
/** Bytes charged for an entry without a rendition (hostile / undecodable / error). */
const NEGATIVE_ENTRY_BYTES = 256;
/** A transient derive failure is retried after this long. */
const ERROR_TTL_MS = 60000;
/** PNG renditions (non-WebP browsers only): a small byte-bounded LRU of their own. */
const PNG_CACHE_BYTES = 4 * 1024 * 1024;

const defaults = () => ({
    enabled: config.avatar.pipeline === 'on',
    legacyInline: config.avatar.legacyInline,
    cacheBytes: config.avatar.cacheBytes,
    maxConcurrent: 2,
    maxQueue: 64,
    now: () => Date.now(),
});

let opts = defaults();
let byV = new Map();        // v -> entry (Map order = LRU order, oldest first)
let bytes = 0;
let inflight = new Map();   // v -> Promise<entry>
let pngByV = new Map();     // v -> Buffer (LRU)
let pngBytes = 0;
let pngInflight = new Map(); // v -> Promise<Buffer|null>
let missing = new Map();    // username -> expiresAt
let running = 0;
let queue = [];             // thunks waiting for a derive slot
let gen = 0;                // bumped by _reset: late completions are ignored
let stats = { derives: 0, deriveMs: 0, hits: 0, evictions: 0, busy: 0, errors: 0 };

/** Is the pipeline on (switch on and sharp loaded)? */
function available() {
    return opts.enabled && image.available();
}

/** 16-hex version of a stored custom picture string. */
function versionOf(raw) {
    return crypto.createHash('sha256').update(`bab-avatar-${RENDITION_REV}\n`).update(raw).digest('hex').slice(0, 16);
}

function busyError() {
    const e = new Error('Avatar renderer busy');
    e.code = 'AVATAR_BUSY';
    return e;
}

/** The cached entry for v (LRU order untouched); an expired 'error' entry is dropped. */
function get(v) {
    const e = byV.get(v);
    if (e && e.expiresAt !== undefined && e.expiresAt <= opts.now()) {
        byV.delete(v);
        bytes -= e.bytes;
        return undefined;
    }
    return e;
}

function store(v, entry) {
    if (byV.has(v)) {
        bytes -= byV.get(v).bytes;
        byV.delete(v);
    }
    if (entry.bytes > opts.cacheBytes) return; // larger than the whole budget: serve once, never cache
    byV.set(v, entry);
    bytes += entry.bytes;
    while (bytes > opts.cacheBytes) {
        const [oldV, old] = byV.entries().next().value;
        byV.delete(oldV);
        bytes -= old.bytes;
        stats.evictions++;
    }
}

/** Run `fn` under the derive semaphore; null when the queue is full. */
function schedule(fn) {
    if (running >= opts.maxConcurrent && queue.length >= opts.maxQueue) return null;
    return new Promise((resolve) => {
        const g = gen;
        const run = () => {
            running++;
            Promise.resolve().then(fn).then(resolve, () => resolve(null)).finally(() => {
                if (g !== gen) return;
                running--;
                const next = queue.shift();
                if (next) next();
            });
        };
        if (running < opts.maxConcurrent) run();
        else queue.push(run);
    });
}

function errorEntry() {
    return { status: 'error', owners: new Map(), bytes: NEGATIVE_ENTRY_BYTES, expiresAt: opts.now() + ERROR_TTL_MS };
}

async function deriveEntry(raw) {
    const t0 = Date.now();
    let r;
    const buf = image.parseDataUrl(raw);
    if (!buf) {
        // Not a data URL we accept (an MIME outside the upload allowlist, or
        // longer than any upload could be): never decoded
        r = { status: 'hostile', reason: /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(raw) ? 'size' : 'format' };
    } else {
        r = await image.derive(buf, { strict: false });
    }
    stats.derives++;
    stats.deriveMs += Date.now() - t0;
    if (r.status === 'error') return errorEntry();
    const entry = { status: r.status, owners: new Map(), bytes: NEGATIVE_ENTRY_BYTES };
    if (r.status === 'ok') {
        entry.webp = r.webp;
        entry.inline = image.toInline(r.webp);
        entry.width = r.width;
        entry.bytes = r.webp.length + entry.inline.length;
    } else {
        entry.reason = r.reason || null;
    }
    return entry;
}

/** Start (or join) the derive of version v. Null when the queue is full. */
function start(v, raw) {
    if (inflight.has(v)) return inflight.get(v);
    const p = schedule(() => deriveEntry(raw));
    if (!p) {
        stats.busy++;
        return null;
    }
    const startedWith = inflight;
    const done = p.then((entry) => {
        // null: the derive threw (schedule turns that into null): transient
        const e = entry || errorEntry();
        if (e.status === 'error') stats.errors++;
        if (e.status === 'hostile') logger.warn('Stored avatar is not a safe image (placeholder shown)', { v, reason: e.reason });
        // A reset (tests) while deriving: drop the result
        if (inflight === startedWith) {
            inflight.delete(v);
            store(v, e);
        }
        return e;
    });
    inflight.set(v, done);
    return done;
}

/** Record that `username` was seen holding version v (now). */
function markOwner(v, username) {
    const e = get(v);
    if (e && username) e.owners.set(username, opts.now());
}

/**
 * Synchronous: the version of `raw`, deriving it in the background when
 * missing. Never awaits, never throws; null with the pipeline off.
 */
function warm(username, raw) {
    try {
        if (!available() || typeof raw !== 'string') return null;
        const v = versionOf(raw);
        if (get(v)) markOwner(v, username);
        else start(v, raw);
        return v;
    } catch (e) {
        logger.error('avatar warm failed', { error: e.message });
        return null;
    }
}

/**
 * The entry for `raw` (derived now if needed), marked as `username`'s.
 * Null with the pipeline off. Rejects with code AVATAR_BUSY when the
 * derive queue is full.
 */
async function ensure(username, raw) {
    if (!available() || typeof raw !== 'string') return null;
    const v = versionOf(raw);
    let e = get(v);
    if (e) {
        touch(v, e);
        stats.hits++;
    } else {
        const p = start(v, raw);
        if (!p) throw busyError();
        e = await p;
    }
    if (get(v)) markOwner(v, username);
    else if (username) e.owners.set(username, opts.now());
    return e;
}

function touch(v, e) {
    byV.delete(v);
    byV.set(v, e);
}

/** The entry for version v, {status:'pending'} while deriving, or undefined. */
function peek(v) {
    const e = get(v);
    if (e) {
        touch(v, e);
        return e;
    }
    return inflight.has(v) ? { status: 'pending' } : undefined;
}

/**
 * A new upload, already derived (profileHandlers.uploadProfilePic stores
 * the canonical WebP data URL `inline` whose bytes are `webp`): its own
 * rendition, so the first fetch needs no derive. Returns the version.
 */
function seed(username, inline, webp) {
    if (!available()) return null;
    const v = versionOf(inline);
    const e = { status: 'ok', webp, inline, owners: new Map(), bytes: webp.length + inline.length };
    store(v, e);
    markOwner(v, username);
    return v;
}

/**
 * Decode a NEW upload (image.derive strict) under the shared semaphore.
 * {status:'busy'} when the queue is full; {status:'error'} if it threw.
 */
async function deriveUpload(buf) {
    const p = schedule(() => image.derive(buf, { strict: true }));
    if (!p) {
        stats.busy++;
        return { status: 'busy' };
    }
    return (await p) || { status: 'error' };
}

/**
 * The PNG rendition of an 'ok' entry of version v (derived from its WebP
 * under the semaphore, cached in a 4 MB LRU). Null when the queue is full
 * or the encode failed.
 */
async function pngFor(v, entry) {
    const hit = pngByV.get(v);
    if (hit) {
        pngByV.delete(v);
        pngByV.set(v, hit);
        return hit;
    }
    if (pngInflight.has(v)) return pngInflight.get(v);
    if (!entry || entry.status !== 'ok' || !entry.webp) return null;
    const p = schedule(() => image.toPng(entry.webp));
    if (!p) {
        stats.busy++;
        return null;
    }
    const startedWith = pngInflight;
    const done = p.then((png) => {
        if (pngInflight === startedWith) {
            pngInflight.delete(v);
            if (png && png.length <= PNG_CACHE_BYTES) {
                pngByV.set(v, png);
                pngBytes += png.length;
                while (pngBytes > PNG_CACHE_BYTES) {
                    const [oldV, old] = pngByV.entries().next().value;
                    pngByV.delete(oldV);
                    pngBytes -= old.length;
                }
            }
        }
        return png || null;
    });
    pngInflight.set(v, done);
    return done;
}

/** A picture change or account deletion: no version is `username`'s any more. */
function forgetUser(username) {
    for (const e of byV.values()) e.owners.delete(username);
    missing.delete(username);
}

/** HTTP negative cache: `username` has no custom avatar (for 60 s). */
function markMissing(username) {
    missing.delete(username);
    missing.set(username, opts.now() + MISSING_TTL_MS);
    while (missing.size > MISSING_MAX) missing.delete(missing.keys().next().value);
}

function isMissing(username) {
    const until = missing.get(username);
    if (until === undefined) return false;
    if (until <= opts.now()) {
        missing.delete(username);
        return false;
    }
    return true;
}

/** Override settings (tests, the dev launcher). */
function configure(o = {}) {
    opts = { ...opts, ...o };
}

/** Tests: empty everything and restore the configured defaults. */
function _reset() {
    gen++;
    opts = defaults();
    byV = new Map();
    bytes = 0;
    inflight = new Map();
    pngByV = new Map();
    pngBytes = 0;
    pngInflight = new Map();
    missing = new Map();
    running = 0;
    queue = [];
    stats = { derives: 0, deriveMs: 0, hits: 0, evictions: 0, busy: 0, errors: 0 };
}

module.exports = {
    RENDITION_REV,
    ERROR_TTL_MS,
    available,
    versionOf,
    warm,
    ensure,
    peek,
    markOwner,
    seed,
    deriveUpload,
    pngFor,
    forgetUser,
    markMissing,
    isMissing,
    configure,
    _reset,
    legacyInlineMode: () => opts.legacyInline,
    now: () => opts.now(),
    stats: () => ({ ...stats, entries: byV.size, bytes, inflight: inflight.size, running, queued: queue.length, missing: missing.size, pngEntries: pngByV.size, pngBytes }),
};
