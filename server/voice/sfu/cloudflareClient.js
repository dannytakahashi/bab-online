/**
 * Cloudflare Realtime SFU: the HTTP client (docs/claude/voice.md, "SFU voice
 * (server)"). The server is the only holder of the app secret: clients ask
 * through the socket (server/socket/sfuHandlers.js) and never see it.
 *
 * Base {CF_SFU_API_BASE or https://rtc.live.cloudflare.com}/v1/apps/{appId},
 * `Authorization: Bearer <app secret>`, JSON. The calls (API 2024-05-21,
 * developers.cloudflare.com/realtime/sfu/api/, plus what the 2026-11-26 spike
 * measured: spike/sfu/API-FLOW.md, REPORT.md, reconnect/RECONNECT.md):
 *
 *   newSession()                       POST sessions/new -> 201 {sessionId}
 *   push(sid, offer, [{mid, trackName}])  POST sessions/{sid}/tracks/new,
 *                                      local tracks + our offer -> answer
 *   pull(sid, [{sessionId, trackName}])   POST tracks/new, remote tracks (no
 *                                      SDP) -> the SFU's offer when
 *                                      requiresImmediateRenegotiation
 *   renegotiate(sid, answer)           PUT sessions/{sid}/renegotiate
 *   close(sid, mids, {offer, force})   PUT sessions/{sid}/tracks/close
 *   iceRestart(sid, offer, {mid, trackName})  the UNDOCUMENTED form the spike
 *                                      found: POST tracks/new with the
 *                                      iceRestart offer, re-declaring our own
 *                                      local track (same mid and trackName).
 *                                      PUT renegotiate with an offer answers
 *                                      406, tracks/new with no tracks 406.
 *   getSession(sid)                    GET sessions/{sid} (tracks + status)
 *
 * Every call resolves (never rejects) to
 *   {ok, status, body, error, ms}
 * where `error` is null or {code, status, cfCode, retryable}:
 *   session_gone      HTTP 410 (Cloudflare's `session_error` "Session appears
 *                     to be disconnected": ~35 s after the peer lost
 *                     connectivity; each such call waits ~5 s first). The
 *                     session is dead: make a new one, never retry on it.
 *   timeout           no answer within config.timeoutMs() (default 8 s, above
 *                     Cloudflare's own 5 s wait, so a dead session answers 410)
 *   network           fetch failed (DNS, reset)
 *   cloudflare_error  any other non-2xx, or a 2xx with a top-level errorCode
 *                     (retryable for 5xx, 406, 409 and 429)
 *   bad_response      a 2xx whose body is not what the call returns
 *   unavailable       the app is not configured
 * HTTP 200 with failed TRACKS is not an error here: `body.tracks[i].errorCode`
 * (empty_track_error, not_found_track_error, ...) is the caller's to read,
 * and a pull with failed tracks may still carry an offer that must be answered.
 *
 * Nothing logs a secret, an SDP or a body: the caller logs op, status, codes
 * and timing only.
 */

'use strict';

const config = require('./config');
const { safeTimeout } = require('../../utils/safeTimer');

const RETRYABLE_STATUS = new Set([406, 409, 429, 500, 502, 503, 504]);
// Bounds on what we read back from Cloudflare (never trust a body's size)
// (a GET of a big room's listener lists every pull it holds)
const MAX_TRACKS_BACK = 1024;
const MAX_TEXT = 256;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

let fetchImpl = (...a) => globalThis.fetch(...a);

/** Tests: route the client's HTTP through a fake (null restores the real fetch). */
function _setFetchForTests(fn) {
    fetchImpl = fn || ((...a) => globalThis.fetch(...a));
}

const clip = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : null);

function sd(v) {
    if (!v || typeof v !== 'object' || typeof v.sdp !== 'string' || !['offer', 'answer'].includes(v.type)) return null;
    return { type: v.type, sdp: v.sdp };
}

/** One returned track, keeping only what we pass on. */
function trackOut(t) {
    if (!t || typeof t !== 'object') return null;
    return {
        mid: typeof t.mid === 'string' && t.mid !== '' ? t.mid.slice(0, 32) : null,
        trackName: clip(t.trackName),
        sessionId: clip(t.sessionId),
        errorCode: clip(t.errorCode),
        errorDescription: clip(t.errorDescription),
        // GET sessions/{sid} only
        location: t.location === 'local' || t.location === 'remote' ? t.location : null,
        status: clip(t.status),
    };
}

/** The normalized body of a tracks / renegotiate / close answer. */
function normalize(json) {
    return {
        sessionId: typeof json?.sessionId === 'string' ? json.sessionId.slice(0, MAX_TEXT) : null,
        requiresImmediateRenegotiation: json?.requiresImmediateRenegotiation === true,
        sessionDescription: sd(json?.sessionDescription),
        tracks: Array.isArray(json?.tracks) ? json.tracks.slice(0, MAX_TRACKS_BACK).map(trackOut).filter(Boolean) : [],
    };
}

/**
 * One Cloudflare call. Never rejects.
 * @returns {Promise<{ok, status, body, error, ms}>}
 */
async function call(method, subpath, body, { env = process.env } = {}) {
    const cfg = config.appConfig(env);
    const t0 = Date.now();
    if (!cfg) return { ok: false, status: null, body: null, error: { code: 'unavailable', status: null, cfCode: null, retryable: false }, ms: 0 };
    const ac = new AbortController();
    const timer = safeTimeout(() => ac.abort(), config.timeoutMs(env), 'sfuFetchTimeout');
    if (timer && typeof timer.unref === 'function') timer.unref();
    let res;
    let text;
    try {
        res = await fetchImpl(`${cfg.base}/v1/apps/${encodeURIComponent(cfg.appId)}${subpath}`, {
            method,
            headers: { Authorization: `Bearer ${cfg.secret}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ac.signal,
        });
        text = await res.text();
    } catch (_) {
        // Only the kind of failure: an error message could carry the URL
        const code = ac.signal.aborted ? 'timeout' : 'network';
        return { ok: false, status: null, body: null, error: { code, status: null, cfCode: null, retryable: true }, ms: Date.now() - t0 };
    } finally {
        clearTimeout(timer);
    }
    const ms = Date.now() - t0;
    let json = null;
    try {
        json = text ? JSON.parse(text) : {};
    } catch (_) {
        json = null;
    }
    const cfCode = json && typeof json.errorCode === 'string' ? json.errorCode.slice(0, 64) : null;
    if (res.status === 410) {
        return { ok: false, status: 410, body: null, error: { code: 'session_gone', status: 410, cfCode, retryable: false }, ms };
    }
    if (!res.ok || json === null || cfCode) {
        const code = res.ok && json === null ? 'bad_response' : 'cloudflare_error';
        return { ok: false, status: res.status, body: null, error: { code, status: res.status, cfCode, retryable: RETRYABLE_STATUS.has(res.status) }, ms };
    }
    return { ok: true, status: res.status, body: json, error: null, ms };
}

const sess = (sid) => `/sessions/${encodeURIComponent(sid)}`;
const badResponse = (r) => ({ ...r, ok: false, body: null, error: { code: 'bad_response', status: r.status, cfCode: null, retryable: true } });

/** POST sessions/new -> {sessionId}. */
async function newSession(opts) {
    const r = await call('POST', '/sessions/new', undefined, opts);
    if (!r.ok) return r;
    const sessionId = typeof r.body?.sessionId === 'string' ? r.body.sessionId : null;
    if (!sessionId || !ID_RE.test(sessionId)) return badResponse(r);
    return { ...r, body: { sessionId } };
}

/** Push our local tracks: our offer in, Cloudflare's answer out. */
async function push(sessionId, offer, tracks, opts) {
    const r = await call('POST', `${sess(sessionId)}/tracks/new`, {
        sessionDescription: { type: 'offer', sdp: offer.sdp },
        tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })),
    }, opts);
    return r.ok ? { ...r, body: normalize(r.body) } : r;
}

/** Pull remote tracks (no SDP): the SFU offers when requiresImmediateRenegotiation. */
async function pull(sessionId, tracks, opts) {
    const r = await call('POST', `${sess(sessionId)}/tracks/new`, {
        tracks: tracks.map((t) => ({ location: 'remote', sessionId: t.sessionId, trackName: t.trackName })),
    }, opts);
    return r.ok ? { ...r, body: normalize(r.body) } : r;
}

/** Our answer to the SFU's offer. */
async function renegotiate(sessionId, answer, opts) {
    const r = await call('PUT', `${sess(sessionId)}/renegotiate`, { sessionDescription: { type: 'answer', sdp: answer.sdp } }, opts);
    return r.ok ? { ...r, body: normalize(r.body) } : r;
}

/** Close tracks by mid: negotiated (our offer, Cloudflare's answer) or forced (no SDP). */
async function close(sessionId, mids, { offer = null, force = false } = {}, opts) {
    const body = { tracks: mids.map((mid) => ({ mid: String(mid) })), force: force === true };
    if (offer) body.sessionDescription = { type: 'offer', sdp: offer.sdp };
    const r = await call('PUT', `${sess(sessionId)}/tracks/close`, body, opts);
    return r.ok ? { ...r, body: normalize(r.body) } : r;
}

/**
 * ICE restart on the same session (undocumented, found by the spike): the
 * client's iceRestart offer through tracks/new, re-declaring our own local
 * track (same mid and trackName). Cloudflare answers.
 */
async function iceRestart(sessionId, offer, local, opts) {
    return push(sessionId, offer, [local], opts);
}

/** GET sessions/{sid}: its tracks and their status. */
async function getSession(sessionId, opts) {
    const r = await call('GET', sess(sessionId), undefined, opts);
    return r.ok ? { ...r, body: normalize(r.body) } : r;
}

module.exports = {
    newSession,
    push,
    pull,
    renegotiate,
    close,
    iceRestart,
    getSession,
    _call: call,
    _setFetchForTests,
};
