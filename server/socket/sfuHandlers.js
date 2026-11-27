/**
 * Cloudflare Realtime SFU voice: the relayed API (docs/claude/voice.md,
 * "SFU voice (server)", is the client protocol). A client never talks to
 * Cloudflare's API and never holds the app secret: it asks here, the server
 * checks the ask and calls Cloudflare (server/voice/sfu/cloudflareClient.js).
 *
 * c2s (each with a requestId; each answered by exactly one private
 * `sfuReply {requestId, op, ok, ...}`; a payload without a usable requestId
 * is dropped silently, like a voice signal):
 *   sfuSession      a new Cloudflare session for me (replaces any I had)
 *   sfuPush         publish my one audio track: my offer -> Cloudflare's answer
 *   sfuPull         pull published tracks of other members (<= 64 per ask):
 *                   per-track results + the SFU's offer to answer
 *   sfuRenegotiate  my answer to the SFU's offer
 *   sfuClose        close tracks on my session (negotiated with my offer, or
 *                   force); closing my own track unpublishes it
 *   sfuIceRestart   my iceRestart offer -> answer, on the same session (the
 *                   form the spike found: tracks/new re-declaring my track)
 *   sfuResume       re-register a session I hold after a reconnect or a
 *                   server restart (proved by the sessionToken sfuSession gave)
 *   sfuLeave        I am done with my session
 *
 * Checked on every ask, in order: the requestId; the per-socket limit
 * (rateLimiter sfuSession / sfuCall); the Joi schema (validators.schemas.sfu*);
 * an admitted member of a tournament's SFU room (sfuRoom.memberOf: signed in,
 * on its lobby screen, the cap sfuVoice, inside the room's ceiling); the
 * session is the caller's own current one (created or resumed on this
 * socket); a pull only of another member's current published track in the
 * same room, never of a blocked pair. Every refusal is a reply with
 * ok false and an error code the client's state machine acts on (never
 * serverError, which would toast), because a client waits for each answer.
 *
 * Every Cloudflare call runs on the session's serial queue
 * (sfuRoom.queues), re-checked when its turn comes (a job whose session was
 * replaced answers `superseded` without a call). A 410 clears the member's
 * session at once (its queued jobs answer session_gone) and the room hears
 * of it. Logged: op, status, codes and timing, never an SDP, a token or the
 * secret.
 */

'use strict';

const gameManager = require('../game/GameManager');
const { rateLimiter } = require('./errorHandler');
const { validate } = require('./validators');
const cf = require('../voice/sfu/cloudflareClient');
const sfuRoom = require('../voice/sfu/sfuRoom');
const sessionToken = require('../voice/sfu/sessionToken');
const { socketLogger } = require('../utils/logger');

const RETRY_AFTER_MS = 1000;

/** The error part of a refusal. */
const err = (code, { retryable = false, retryAfterMs = null, status = null, cfCode = null } = {}) =>
    ({ code, retryable, retryAfterMs, status, cfCode });

/** A Cloudflare failure as the client sees it. */
function cfError(r) {
    const e = r.error || {};
    switch (e.code) {
        case 'session_gone': return err('session_gone', { status: 410, cfCode: e.cfCode });
        case 'timeout': return err('timeout', { retryable: true, retryAfterMs: RETRY_AFTER_MS });
        case 'network': return err('cloudflare_unreachable', { retryable: true, retryAfterMs: RETRY_AFTER_MS });
        case 'unavailable': return err('unavailable');
        case 'bad_response': return err('cloudflare_error', { retryable: true, retryAfterMs: RETRY_AFTER_MS, status: e.status ?? null });
        default: return err('cloudflare_error', { retryable: !!e.retryable, retryAfterMs: e.retryable ? RETRY_AFTER_MS : null, status: e.status ?? null, cfCode: e.cfCode ?? null });
    }
}

/** A queue job that never ran. */
function droppedError(reason) {
    switch (reason) {
        case 'busy': return err('busy', { retryable: true, retryAfterMs: 500 });
        case 'session_gone': return err('session_gone');
        case 'not_in_room': return err('not_in_room');
        case 'superseded': return err('superseded');
        default: return err('server_error', { retryable: true, retryAfterMs: RETRY_AFTER_MS });
    }
}

const trackResult = (t) => ({ mid: t.mid, trackName: t.trackName, errorCode: t.errorCode, errorDescription: t.errorDescription });

/**
 * The ops: [op, c2s event / Joi schema, rate-limit key, run(ctx) -> reply fields | {error}].
 * ctx = {socket, io, data, t, entry, username, reply}.
 */
const OPS = {};
function op(name, event, limitKey, run) {
    OPS[event] = { name, event, limitKey, run };
    const fn = async (socket, io, raw) => handle(OPS[event], socket, io, raw);
    // Named as the event: an exception that escapes handle (a bug) is the
    // wrapper's serverError naming it, like every other registration
    Object.defineProperty(fn, 'name', { value: event });
    return fn;
}

async function handle(spec, socket, io, raw) {
    const requestId = typeof raw?.requestId === 'string' && raw.requestId.length > 0 && raw.requestId.length <= 64 ? raw.requestId : null;
    if (requestId === null) {
        socketLogger.debug('Voice SFU: request dropped', { event: spec.event, socketId: socket.id, reason: 'no_request_id' });
        return;
    }
    const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId.slice(0, 128) : null;
    const refuse = (error) => {
        socketLogger.debug('Voice SFU: request refused', { event: spec.event, socketId: socket.id, code: error.code });
        socket.emit('sfuReply', { requestId, op: spec.name, ok: false, sessionId, error });
    };
    if (!rateLimiter.check(socket.id, spec.limitKey)) return refuse(err('rate_limited', { retryable: true, retryAfterMs: RETRY_AFTER_MS }));
    let data;
    try {
        data = validate(spec.event, raw);
    } catch (_) {
        return refuse(err('invalid'));
    }
    const user = gameManager.getUserBySocketId(socket.id);
    const m = user?.username ? sfuRoom.memberOf(socket.id) : null;
    if (!m) return refuse(err('not_in_room'));
    try {
        const out = await spec.run({ socket, io, data, t: m.t, entry: m.entry, username: m.entry.username });
        if (out.error) return refuse(out.error);
        socket.emit('sfuReply', { requestId, op: spec.name, ok: true, ...out });
    } catch (e) {
        socketLogger.error('Voice SFU: request failed', { event: spec.event, socketId: socket.id, error: e?.message });
        refuse(err('server_error', { retryable: true, retryAfterMs: RETRY_AFTER_MS }));
    }
    return undefined;
}

/** The caller's own current session, or the refusal. */
function ownSession(ctx) {
    const { t, entry, socket, data } = ctx;
    if (!sfuRoom.ownsSession(t, entry, socket.id, data.sessionId)) return { error: err('not_your_session') };
    return null;
}

/**
 * Run `call` on the session's queue; re-check ownership when its turn comes,
 * count it, and turn a 410 into a cleared session.
 */
async function onSession(ctx, opName, call) {
    const { t, entry, socket, io, data } = ctx;
    const sessionId = data.sessionId;
    const res = await sfuRoom.queues.run(sessionId, async () => {
        if (!sfuRoom.ownsSession(t, entry, socket.id, sessionId)) return { dropped: entry.sessionId === sessionId ? 'not_in_room' : 'superseded' };
        const r = await call(sessionId);
        sfuRoom.countCall(t, opName, r);
        logCall(t, opName, r);
        if (!r.ok && r.error?.code === 'session_gone' && entry.sessionId === sessionId) {
            sfuRoom.endSession(io, t, entry, 'session_gone');
        }
        return { r };
    });
    if (res.dropped) return { error: droppedError(res.dropped) };
    if (!res.r.ok) return { error: cfError(res.r) };
    // The member's session was replaced or it left while Cloudflare answered
    if (!sfuRoom.ownsSession(t, entry, socket.id, sessionId)) return { error: err('superseded'), late: res.r };
    return { r: res.r };
}

function logCall(t, opName, r) {
    if (r.ok) {
        const trackErrors = (r.body?.tracks || []).filter((x) => x.errorCode).map((x) => x.errorCode);
        socketLogger.debug('Voice SFU: Cloudflare call', { tournamentId: t.tournamentId, op: opName, status: r.status, ms: r.ms, trackErrors });
        return;
    }
    const level = r.error?.code === 'session_gone' ? 'info' : 'warn';
    socketLogger[level]('Voice SFU: Cloudflare call failed', { tournamentId: t.tournamentId, op: opName, status: r.status, code: r.error?.code, cfCode: r.error?.cfCode, ms: r.ms });
}

// ---------- the ops ----------

const sfuSession = op('session', 'sfuSession', 'sfuSession', async (ctx) => {
    const { t, entry, socket, io, username } = ctx;
    const key = `member:${t.tournamentId}:${username}`;
    const res = await sfuRoom.queues.run(key, async () => {
        if (!sfuRoom.memberOf(socket.id) || sfuRoom.memberOf(socket.id).entry !== entry) return { dropped: 'not_in_room' };
        const r = await cf.newSession();
        sfuRoom.countCall(t, 'sessions/new', r);
        logCall(t, 'sessions/new', r);
        return { r };
    });
    if (res.dropped) return { error: droppedError(res.dropped) };
    if (!res.r.ok) return { error: cfError(res.r) };
    // Left the room while Cloudflare answered: the session is never used (Cloudflare drops it)
    const still = sfuRoom.memberOf(socket.id);
    if (!still || still.entry !== entry) return { error: err('not_in_room') };
    const sessionId = res.r.body.sessionId;
    const token = sessionToken.sign({ tournamentId: t.tournamentId, username, sessionId });
    if (!token) return { error: err('unavailable') };
    sfuRoom.setSession(io, t, entry, sessionId);
    socketLogger.info('Voice SFU: session created', { tournamentId: t.tournamentId, username, ms: res.r.ms });
    return { sessionId, sessionToken: token };
});

const sfuPush = op('push', 'sfuPush', 'sfuCall', async (ctx) => {
    const { t, entry, io, data } = ctx;
    const refused = ownSession(ctx);
    if (refused) return refused;
    // One audio track per session; the same one again is a retry
    if (entry.localMid && (entry.localMid !== data.mid || entry.trackName !== data.trackName)) return { error: err('already_published') };
    const out = await onSession(ctx, 'tracks/new(push)', (sid) => cf.push(sid, data.offer, [{ mid: data.mid, trackName: data.trackName }]));
    if (out.error) return out;
    const body = out.r.body;
    if (!body.sessionDescription || body.sessionDescription.type !== 'answer') return { error: err('cloudflare_error', { retryable: true, retryAfterMs: RETRY_AFTER_MS, status: out.r.status }) };
    const tracks = body.tracks.map(trackResult);
    const mine = tracks.find((x) => x.mid === data.mid) ?? tracks[0];
    if (mine && !mine.errorCode) sfuRoom.published(io, t, entry, data.trackName, data.mid);
    return { sessionId: data.sessionId, answer: body.sessionDescription, tracks };
});

const sfuPull = op('pull', 'sfuPull', 'sfuCall', async (ctx) => {
    const { t, entry, io, data } = ctx;
    const refused = ownSession(ctx);
    if (refused) return refused;
    const { allowed, refused: notAllowed } = sfuRoom.checkPulls(io, t, entry, data.tracks);
    if (allowed.length === 0) {
        return { sessionId: data.sessionId, requiresImmediateRenegotiation: false, offer: null, tracks: notAllowed };
    }
    const out = await onSession(ctx, 'tracks/new(pull)', (sid) => cf.pull(sid, allowed));
    if (out.error) return out;
    const body = out.r.body;
    // Cloudflare answers the tracks in request order; match by name, else by index
    const results = allowed.map((a, i) => {
        const back = body.tracks.find((x) => x.sessionId === a.sessionId && x.trackName === a.trackName) ?? body.tracks[i] ?? null;
        return {
            username: a.username,
            sessionId: a.sessionId,
            trackName: a.trackName,
            mid: back?.mid ?? null,
            errorCode: back ? back.errorCode : 'no_result',
            errorDescription: back ? back.errorDescription : null,
        };
    });
    sfuRoom.pulledOk(t, entry, results);
    const offer = body.sessionDescription && body.sessionDescription.type === 'offer' ? body.sessionDescription : null;
    return { sessionId: data.sessionId, requiresImmediateRenegotiation: body.requiresImmediateRenegotiation && !!offer, offer, tracks: [...results, ...notAllowed] };
});

const sfuRenegotiate = op('renegotiate', 'sfuRenegotiate', 'sfuCall', async (ctx) => {
    const refused = ownSession(ctx);
    if (refused) return refused;
    const out = await onSession(ctx, 'renegotiate', (sid) => cf.renegotiate(sid, ctx.data.answer));
    if (out.error) return out;
    return { sessionId: ctx.data.sessionId };
});

const sfuClose = op('close', 'sfuClose', 'sfuCall', async (ctx) => {
    const { t, entry, io, data } = ctx;
    const refused = ownSession(ctx);
    if (refused) return refused;
    const force = data.force === true;
    const out = await onSession(ctx, force ? 'tracks/close(force)' : 'tracks/close', (sid) => cf.close(sid, data.mids, { offer: force ? null : data.offer, force }));
    if (out.error) return out;
    const body = out.r.body;
    const tracks = body.tracks.map(trackResult);
    // A mid Cloudflare reported an error for stays open
    const failed = new Set(tracks.filter((x) => x.errorCode && x.mid).map((x) => x.mid));
    sfuRoom.closed(io, t, entry, data.mids.filter((mid) => !failed.has(mid)));
    const answer = body.sessionDescription && body.sessionDescription.type === 'answer' ? body.sessionDescription : null;
    return { sessionId: data.sessionId, answer, tracks };
});

const sfuIceRestart = op('iceRestart', 'sfuIceRestart', 'sfuCall', async (ctx) => {
    const { entry, data } = ctx;
    const refused = ownSession(ctx);
    if (refused) return refused;
    // The working form re-declares our own published track; a session that
    // pushed nothing has none, so its recovery is a new session
    if (!entry.localMid || !entry.trackName) return { error: err('no_local_track') };
    const local = { mid: entry.localMid, trackName: entry.trackName };
    const out = await onSession(ctx, 'tracks/new(iceRestart)', (sid) => cf.iceRestart(sid, data.offer, local));
    if (out.error) return out;
    const body = out.r.body;
    if (!body.sessionDescription || body.sessionDescription.type !== 'answer') return { error: err('cloudflare_error', { retryable: true, retryAfterMs: RETRY_AFTER_MS, status: out.r.status }) };
    return { sessionId: data.sessionId, answer: body.sessionDescription, tracks: body.tracks.map(trackResult) };
});

const sfuResume = op('resume', 'sfuResume', 'sfuCall', async (ctx) => {
    const { t, entry, io, data, username } = ctx;
    if ((data.trackName === null) !== (data.mid === null)) return { error: err('invalid') };
    if (!sessionToken.verify({ tournamentId: t.tournamentId, username, sessionId: data.sessionId, token: data.sessionToken })) {
        socketLogger.warn('Voice SFU: resume with a token that does not match', { tournamentId: t.tournamentId, username });
        return { error: err('bad_token') };
    }
    sfuRoom.resume(io, t, entry, { sessionId: data.sessionId, trackName: data.trackName, mid: data.mid, pulls: data.pulls || [] });
    socketLogger.info('Voice SFU: session resumed', { tournamentId: t.tournamentId, username, published: !!data.trackName, pulls: (data.pulls || []).length });
    return { sessionId: data.sessionId };
});

const sfuLeave = op('leave', 'sfuLeave', 'sfuCall', async (ctx) => {
    const { t, entry, io, socket, data } = ctx;
    // Idempotent: a session that is not (or no longer) mine is simply not mine to end
    const target = data.sessionId ?? entry.sessionId;
    if (target && sfuRoom.ownsSession(t, entry, socket.id, target)) sfuRoom.endSession(io, t, entry, 'superseded');
    return {};
});

module.exports = {
    OPS,
    sfuSession,
    sfuPush,
    sfuPull,
    sfuRenegotiate,
    sfuClose,
    sfuIceRestart,
    sfuResume,
    sfuLeave,
};
