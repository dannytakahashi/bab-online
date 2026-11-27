/**
 * A fake Cloudflare Realtime SFU for Jest (server/voice/sfu/cloudflareClient.js
 * through `_setFetchForTests`). It keeps sessions and tracks the way the
 * 2026-11-26 spike saw the real one behave (spike/sfu/API-FLOW.md):
 *   - sessions/new 201 {sessionId} (hex; the real one is 64 hex chars, this one 32)
 *   - tracks/new with local tracks + an offer: answer, the given mids
 *   - tracks/new with remote tracks: a new mid per track (freed mids reused),
 *     requiresImmediateRenegotiation + the SFU's offer; a track that does not
 *     exist: errorCode not_found_track_error with HTTP 200, one marked empty:
 *     empty_track_error
 *   - tracks/new with an offer and our own local track again: the ICE restart
 *     answer; renegotiate with an offer: 406 (as live)
 *   - renegotiate (answer), tracks/close (negotiated or force), GET
 *   - a session marked gone answers 410 session_error to everything
 * Faults: `fail(op, sessionId, body) -> {status, json} | 'hang' | null`
 * (hang: never answers until the request's abort signal fires).
 * Every call is recorded in `calls` ({op, sessionId, auth, body}); the
 * Authorization header must be `Bearer ${secret}` (else 401).
 * SDP strings are obviously fake (never secret-shaped).
 */

'use strict';

const crypto = require('crypto');

function createFakeCloudflare({ appId = 'fakeapp', secret = 'fake-secret-for-tests', delayMs = 0 } = {}) {
    const sessions = new Map();
    const calls = [];
    const fake = { sessions, calls, fail: null, delayMs, appId, secret };

    const json = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
    const offer = (s) => ({ type: 'offer', sdp: `v=0\r\no=- fake ${s.id}\r\n${[...s.tracks.keys()].map((m) => `a=mid:${m}`).join('\r\n')}\r\n` });
    const answer = (s) => ({ type: 'answer', sdp: `v=0\r\no=- fake-answer ${s.id}\r\n` });

    function nextMid(s) {
        let m = 0;
        while (s.tracks.has(String(m))) m++;
        return String(m);
    }

    function opName(method, rest, body) {
        if (method === 'POST' && rest === '/sessions/new') return 'sessions/new';
        if (method === 'GET') return 'get';
        if (rest.endsWith('/tracks/new')) {
            const local = (body?.tracks || []).some((t) => t.location === 'local');
            if (!local) return 'pull';
            const s = sessions.get(rest.split('/')[2]);
            const again = s && (body.tracks || []).every((t) => t.location === 'local' && s.tracks.get(t.mid)?.trackName === t.trackName);
            return again ? 'iceRestart' : 'push';
        }
        if (rest.endsWith('/renegotiate')) return 'renegotiate';
        if (rest.endsWith('/tracks/close')) return 'close';
        return 'unknown';
    }

    async function handle(method, rest, body) {
        if (method === 'POST' && rest === '/sessions/new') {
            const id = crypto.randomBytes(16).toString('hex');
            sessions.set(id, { id, tracks: new Map(), gone: false, empty: new Set() });
            return json(201, { sessionId: id });
        }
        const m = /^\/sessions\/([^/]+)(\/.*)?$/.exec(rest);
        if (!m) return json(404, { errorCode: 'not_found' });
        const s = sessions.get(m[1]);
        if (!s) return json(400, { errorCode: 'internal_error', errorDescription: 'Backend error' });
        if (s.gone) return json(410, { errorCode: 'session_error', errorDescription: 'Session appears to be disconnected. Please check if the PeerConnection is connected.' });
        const sub = m[2] || '';
        if (method === 'GET' && sub === '') {
            return json(200, { tracks: [...s.tracks.entries()].map(([mid, t]) => ({ location: t.location, mid, trackName: t.trackName, sessionId: t.sessionId, status: 'active' })), dataChannels: [] });
        }
        if (method === 'POST' && sub === '/tracks/new') {
            const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
            if (tracks.length === 0) return json(406, { errorCode: 'invalid_request', errorDescription: 'Expecting at least 1 track' });
            if (tracks[0].location === 'local') {
                if (body.sessionDescription?.type !== 'offer') return json(400, { errorCode: 'invalid_request' });
                for (const t of tracks) s.tracks.set(String(t.mid), { location: 'local', trackName: t.trackName });
                return json(200, { requiresImmediateRenegotiation: false, sessionDescription: answer(s), tracks: tracks.map((t) => ({ mid: String(t.mid), trackName: t.trackName })) });
            }
            const out = tracks.map((t) => {
                const pub = sessions.get(t.sessionId);
                const has = pub && !pub.gone && [...pub.tracks.values()].some((x) => x.location === 'local' && x.trackName === t.trackName);
                if (!has) return { sessionId: t.sessionId, trackName: t.trackName, mid: '', errorCode: 'not_found_track_error', errorDescription: 'Track not found on remote peer' };
                if (pub.empty.has(t.trackName)) return { sessionId: t.sessionId, trackName: t.trackName, mid: '', errorCode: 'empty_track_error', errorDescription: 'No track data from remote peer' };
                const mid = nextMid(s);
                s.tracks.set(mid, { location: 'remote', trackName: t.trackName, sessionId: t.sessionId });
                return { sessionId: t.sessionId, trackName: t.trackName, mid };
            });
            return json(200, { requiresImmediateRenegotiation: true, sessionDescription: offer(s), tracks: out });
        }
        if (method === 'PUT' && sub === '/renegotiate') {
            if (body?.sessionDescription?.type !== 'answer') return json(406, { errorCode: 'invalid_request', errorDescription: 'sessionDescription.type=answer is expected' });
            return json(200, {});
        }
        if (method === 'PUT' && sub === '/tracks/close') {
            const mids = (body?.tracks || []).map((t) => String(t.mid));
            const res = mids.map((mid) => (s.tracks.delete(mid) ? { mid } : { mid, errorCode: 'not_found_track_error', errorDescription: 'Track not found' }));
            const out = { requiresImmediateRenegotiation: false, tracks: res };
            if (body.sessionDescription) out.sessionDescription = answer(s);
            return json(200, out);
        }
        return json(404, { errorCode: 'not_found' });
    }

    fake.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const prefix = `/v1/apps/${appId}`;
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        const rest = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname;
        const sessionId = /^\/sessions\/([^/]+)/.exec(rest)?.[1] ?? null;
        const op = opName(method, rest, body);
        const auth = init.headers?.Authorization;
        calls.push({ op, method, sessionId: sessionId === 'new' ? null : sessionId, auth, body });
        if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs)); // eslint-disable-line no-promise-executor-return
        if (!u.pathname.startsWith(prefix)) return json(404, { errorCode: 'not_found' });
        if (auth !== `Bearer ${secret}`) return json(401, { errorCode: 'unauthorized' });
        const f = fake.fail ? fake.fail(op, sessionId, body) : null;
        if (f === 'hang') {
            return new Promise((_, reject) => {
                init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            });
        }
        if (f) return json(f.status, f.json ?? {});
        return handle(method, rest, body);
    };

    fake.env = (extra = {}) => ({
        VOICE_SFU: 'tournament',
        CF_SFU_APP_ID: appId,
        CF_SFU_APP_SECRET: secret,
        CF_SFU_API_BASE: 'http://fake-cloudflare.invalid',
        ...extra,
    });
    fake.goneSession = (id) => { const s = sessions.get(id); if (s) s.gone = true; };
    fake.callsOf = (op) => calls.filter((c) => c.op === op);
    return fake;
}

module.exports = { createFakeCloudflare };
