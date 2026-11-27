/**
 * Cloudflare SFU voice, the server (PR 1; server/voice/sfu/,
 * server/socket/sfuHandlers.js, docs/claude/voice.md "SFU voice (server)"),
 * through real tournaments on the handlers (stub io / sockets, fake timers,
 * the in-memory DB) and a fake Cloudflare (server/testUtils/fakeCloudflare.js):
 *   - the flag: off = today's mesh room exactly (cap 20); on without the app
 *     configured = the mesh at most 8; on = an SFU room, decided at its first
 *     entry and kept while anyone is in it
 *   - the mesh is never in an SFU room: no voicePeerList / Joined / Left or
 *     tournamentVoiceStatus there, mesh signals refused, an old client (no
 *     sfuVoice) gets nothing at all
 *   - the roster: sfuRoster on entry, sfuMember joined / session / published
 *     / unpublished / reconnecting / resumed / left, the bootId, the grace
 *     (38 s) and its expiry, resume with the session token (also after a
 *     restart), the line past the ceiling, cancel
 *   - the relayed API: session, push, pull (per-track errors with HTTP 200),
 *     renegotiate, close, ICE restart (the spike's form), resume, leave; 410,
 *     timeouts, the serial queue (order, superseded, busy), every refusal
 *     (requestId, limit, Joi, membership, someone else's session, cross-room
 *     pulls, blocked pairs, a block mid-call and its force close)
 *   - nothing logged carries the secret, a token or an SDP
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const tournamentHandlers = require('../tournamentHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const voice = require('../voiceHandlers');
const safety = require('../safetyHandlers');
const sfu = require('../sfuHandlers');
const gameVoice = require('../../voice/gameVoice');
const tournamentVoice = require('../../voice/tournamentVoice');
const sfuRoom = require('../../voice/sfu/sfuRoom');
const sfuConfig = require('../../voice/sfu/config');
const cf = require('../../voice/sfu/cloudflareClient');
const sessionToken = require('../../voice/sfu/sessionToken');
const { createSessionQueues } = require('../../voice/sfu/sessionQueue');
const { bootId } = require('../../utils/instanceId');
const { rateLimiter } = require('../errorHandler');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { newIo, kill, newUser, liveTables, advanceUntil } = require('../../testUtils/tournamentDriver');
const { Phase } = require('../../game/GamePhase');
const { createFakeCloudflare } = require('../../testUtils/fakeCloudflare');

const WEB = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice', 'tournamentVoiceStatus', 'cutForABuck'];
const KINDS = {
    sfu: { client: 'web', caps: [...WEB, 'sfuVoice'] },
    web: { client: 'web', caps: WEB }, // today's web: no sfuVoice
};
const MESH = new Set(['voicePeerList', 'voicePeerJoined', 'voicePeerLeft', 'tournamentVoiceStatus']);
const OFFER = { type: 'offer', sdp: ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', 'a=sendonly', ''].join('\r\n') };
const ANSWER = { type: 'answer', sdp: ['v=0', 'o=- 3 4 IN IP4 127.0.0.1', 's=-', 't=0 0', ''].join('\r\n') };
const ENV_KEYS = ['VOICE_SFU', 'CF_SFU_APP_ID', 'CF_SFU_APP_SECRET', 'CF_SFU_API_BASE', 'VOICE_SFU_ROOM_MAX', 'VOICE_SFU_GRACE_MS', 'VOICE_SFU_TIMEOUT_MS', 'TOURNAMENT_VOICE_MAX'];

let fake;
let savedEnv;
let logs;
let seq = 0;
let made = 0;
let req = 0;

function setEnv(env) {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
}

beforeEach(() => {
    seq++;
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    fake = createFakeCloudflare();
    cf._setFetchForTests(fake.fetch);
    setEnv(fake.env());
    sfuConfig._resetWarningsForTests();
    logs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation((msg, meta) => logs.push({ level: m, msg, meta }));
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    tournamentHandlers._resetCleanupTimersForTests();
    sfuRoom._resetForTests();
    rateLimiter.clearAll?.();
    cf._setFetchForTests(null);
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

function member(ctx, name, kind = 'sfu', blocked = []) {
    const s = newUser(ctx.io, ctx.log, name);
    s.data.client = { client: KINDS[kind].client, version: '1', build: null, caps: KINDS[kind].caps };
    voice.rememberBlockList(s, blocked);
    s.username = name;
    return s;
}

/** A tournament made by kinds[0], joined by the rest; blocks: index -> indexes it blocked. */
async function tournament(kinds, { io = null, blocks = {} } = {}) {
    const ctx = io ? { ...io } : newIo();
    const tag = `s${seq}x${++made}`;
    const names = kinds.map((k, i) => `p${i}_${tag}`);
    const sockets = kinds.map((k, i) => member(ctx, names[i], k, (blocks[i] || []).map((j) => names[j])));
    tournamentHandlers.createTournament(sockets[0], ctx.io);
    const t = gameManager.getPlayerTournament(sockets[0].id);
    for (const s of sockets.slice(1)) await tournamentHandlers.joinTournament(s, ctx.io, { tournamentId: t.tournamentId });
    return { ...ctx, t, sockets };
}

const to = (l) => (typeof l.to === 'string' ? l.to.replace(/^self:/, '') : l.to);
const since = (ctx, mark, event) => ctx.log.slice(mark).filter((l) => l.event === event);
const rostersTo = (ctx, mark, sid) => since(ctx, mark, 'sfuRoster').filter((l) => to(l) === sid).map((l) => l.data);
const membersTo = (ctx, mark, sid) => since(ctx, mark, 'sfuMember').filter((l) => to(l) === sid).map((l) => l.data);
const meshSince = (ctx, mark) => ctx.log.slice(mark).filter((l) => MESH.has(l.event));

/** Send `event` from `socket` and return its sfuReply. */
async function ask(ctx, socket, event, data = {}) {
    const requestId = `r${++req}`;
    const mark = ctx.log.length;
    await sfu[event](socket, ctx.io, { requestId, ...data });
    const replies = ctx.log.slice(mark).filter((l) => l.event === 'sfuReply' && l.data.requestId === requestId);
    expect(replies).toHaveLength(1);
    expect(to(replies[0])).toBe(socket.id);
    return replies[0].data;
}

/** A session for `s`; with `publish`, its mic pushed too. */
async function joinVoice(ctx, s, { publish = false } = {}) {
    const r = await ask(ctx, s, 'sfuSession');
    expect(r).toMatchObject({ op: 'session', ok: true });
    if (publish) {
        const p = await ask(ctx, s, 'sfuPush', { sessionId: r.sessionId, offer: OFFER, mid: '0', trackName: 'mic' });
        expect(p).toMatchObject({ op: 'push', ok: true, answer: { type: 'answer' } });
    }
    return r;
}

const entryOf = (ctx, s) => ctx.t.voiceRoom.sfu.entries.get(s.username);

// ==================== the flag ====================

describe('the flag', () => {
    test('off: the tournament room is today\'s mesh (lists, cap 20); no SFU event; SFU requests answered not_in_room', async () => {
        setEnv({ CF_SFU_APP_ID: fake.appId, CF_SFU_APP_SECRET: fake.secret });
        const ctx = await tournament(['sfu', 'sfu', 'web']);
        const [a, b, c] = ctx.sockets;
        expect(ctx.t.voiceRoom.mode).toBe('mesh');
        expect(tournamentVoice.meshMax()).toBe(20);
        const lists = since(ctx, 0, 'voicePeerList').map((l) => [to(l), l.data.peers.map((p) => p.socketId)]);
        expect(lists).toEqual([[b.id, [a.id]], [c.id, [a.id, b.id]]]);
        expect(since(ctx, 0, 'sfuRoster')).toEqual([]);
        expect(since(ctx, 0, 'sfuMember')).toEqual([]);
        expect(gameVoice.voiceRoomOf(a.id)).toBe(`tournament:${ctx.t.tournamentId}`);
        const r = await ask(ctx, a, 'sfuSession');
        expect(r).toMatchObject({ ok: false, op: 'session', error: { code: 'not_in_room', retryable: false } });
        expect(fake.calls).toEqual([]);
    });

    test('off with TOURNAMENT_VOICE_MAX: unchanged (the env still sets the mesh cap)', async () => {
        setEnv({ TOURNAMENT_VOICE_MAX: '12' });
        expect(tournamentVoice.meshMax()).toBe(12);
        setEnv({ VOICE_SFU: 'off', TOURNAMENT_VOICE_MAX: '20' });
        expect(tournamentVoice.meshMax()).toBe(20);
        setEnv({ VOICE_SFU: 'bogus' });
        expect(sfuConfig.mode()).toBe('off');
        expect(tournamentVoice.meshMax()).toBe(20);
    });

    test('on without the Cloudflare app: the room stays a mesh, at most 8 ("keep 8 as the direct limit"), one warning', async () => {
        setEnv({ VOICE_SFU: 'tournament' });
        expect(tournamentVoice.meshMax()).toBe(8);
        const ctx = await tournament(Array(9).fill('sfu'));
        expect(ctx.t.voiceRoom.mode).toBe('mesh');
        expect(tournamentVoice.admitted(ctx.t)).toHaveLength(8);
        const ninth = ctx.sockets[8];
        expect(since(ctx, 0, 'tournamentVoiceStatus').filter((l) => to(l) === ninth.id).map((l) => l.data)).toEqual([{ admitted: false, cap: 8 }]);
        expect(logs.filter((l) => l.level === 'warn' && /CF_SFU_APP_ID/.test(l.msg))).toHaveLength(1);
        // a lower TOURNAMENT_VOICE_MAX still wins
        setEnv({ VOICE_SFU: 'tournament', TOURNAMENT_VOICE_MAX: '4' });
        expect(tournamentVoice.meshMax()).toBe(4);
    });

    test('on: an SFU room, fixed while anyone is in it; an empty room takes the flag again', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        expect(ctx.t.voiceRoom.mode).toBe('sfu');
        setEnv({});
        const c = member(ctx, `late_${seq}`);
        await tournamentHandlers.joinTournament(c, ctx.io, { tournamentId: ctx.t.tournamentId });
        expect(ctx.t.voiceRoom.mode).toBe('sfu');
        expect(sfuRoom.isMember(ctx.t, c.id)).toBe(true);
        // everyone leaves the room (seated at tables, say): the next entry takes the flag (off: a mesh room)
        const all = [...ctx.sockets, c];
        tournamentVoice.leave(ctx.io, ctx.t, all.map((s) => s.id));
        expect(ctx.t.voiceRoom.members.size).toBe(0);
        expect(ctx.t.voiceRoom.sfu.entries.size).toBe(0);
        const mark = ctx.log.length;
        for (const s of all) tournamentVoice.enter(ctx.io, ctx.t, s.id);
        expect(ctx.t.voiceRoom.mode).toBe('mesh');
        expect(since(ctx, mark, 'voicePeerList')).toHaveLength(2);
        expect(since(ctx, mark, 'sfuRoster')).toEqual([]);
    });

    test('config: clamps and defaults', () => {
        expect(sfuConfig.roomMax({})).toBe(100);
        expect(sfuConfig.roomMax({ VOICE_SFU_ROOM_MAX: '1' })).toBe(2);
        expect(sfuConfig.roomMax({ VOICE_SFU_ROOM_MAX: '9999' })).toBe(500);
        expect(sfuConfig.roomMax({ VOICE_SFU_ROOM_MAX: 'x' })).toBe(100);
        expect(sfuConfig.graceMs({})).toBe(38000);
        expect(sfuConfig.graceMs({ VOICE_SFU_GRACE_MS: '1' })).toBe(5000);
        expect(sfuConfig.timeoutMs({})).toBe(8000);
        expect(sfuConfig.appConfig({ CF_SFU_APP_ID: 'bad id!', CF_SFU_APP_SECRET: 'x' })).toBeNull();
        // the fake base is ignored in production
        expect(sfuConfig.appConfig({ CF_SFU_APP_ID: 'a', CF_SFU_APP_SECRET: 'x', CF_SFU_API_BASE: 'http://x.invalid', NODE_ENV: 'production' }).base).toBe('https://rtc.live.cloudflare.com');
    });
});

// ==================== the mesh is never in an SFU room ====================

describe('the mesh is never in an SFU room', () => {
    test('join, relist, leave, disconnect, the main room and cancel send no mesh event; mesh signals are refused; TURN is still a voice peer\'s', async () => {
        const ctx = await tournament(['sfu', 'sfu', 'web', 'sfu']);
        const [a, b, old, d] = ctx.sockets;
        await tournamentHandlers.joinTournament(b, ctx.io, { tournamentId: ctx.t.tournamentId }); // a relist
        mainRoomHandlers.joinMainRoom(d, ctx.io);
        await kill(ctx.io, old);
        const e = member(ctx, `e_${seq}`);
        await tournamentHandlers.joinTournament(e, ctx.io, { tournamentId: ctx.t.tournamentId });
        expect(meshSince(ctx, 0)).toEqual([]);
        // mesh relays between two SFU members: refused ('sfu_room')
        const mark = ctx.log.length;
        voice.voiceOffer(a, ctx.io, { targetSocketId: b.id, offer: OFFER });
        expect(since(ctx, mark, 'voiceOffer')).toEqual([]);
        expect(logs.some((l) => l.msg === 'Voice signal dropped' && l.meta.reason === 'sfu_room')).toBe(true);
        expect(gameVoice.voiceRoomOf(a.id)).toBe(`sfu:${ctx.t.tournamentId}`);
        await tournamentHandlers.cancelTournament(a, ctx.io);
        expect(meshSince(ctx, 0)).toEqual([]);
    });

    test('a round seats the members: out of the SFU room (out / left), and their table stays a mesh (announced at seating)', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        await joinVoice(ctx, a, { publish: true });
        const mark = ctx.log.length;
        for (const s of ctx.sockets) tournamentHandlers.tournamentReady(s, ctx.io);
        const starting = tournamentHandlers.beginTournament(a, ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => [Phase.BIDDING, Phase.PLAYING].includes(g.stage)), 100, 120000);
        await starting;
        expect(rostersTo(ctx, mark, a.id).map((r) => r.status)).toEqual(['out']);
        expect(rostersTo(ctx, mark, b.id).map((r) => r.status)).toEqual(['out']);
        expect(ctx.t.voiceRoom.sfu.entries.size).toBe(0);
        // the table: the mesh, one pair from the later seat
        const lists = since(ctx, mark, 'voicePeerList');
        expect(lists).toHaveLength(1);
        expect(gameVoice.voiceRoomOf(a.id)).toBe(`game:${liveTables(ctx.t)[0].gameId}`);
    });

    test('an old client (no sfuVoice) in an SFU room gets no voice at all: no roster, no mesh peers, no SFU requests', async () => {
        const ctx = await tournament(['sfu', 'web', 'sfu']);
        const [a, old, c] = ctx.sockets;
        expect(ctx.log.filter((l) => to(l) === old.id && /^(sfu|voice)/.test(l.event))).toEqual([]);
        expect(gameVoice.voiceRoomOf(old.id)).toBeNull();
        expect(await ask(ctx, old, 'sfuSession')).toMatchObject({ ok: false, error: { code: 'not_in_room' } });
        // the SFU members never see it either
        for (const s of [a, c]) {
            for (const r of rostersTo(ctx, 0, s.id)) expect(r.members.map((m) => m.username)).not.toContain(old.username);
        }
    });
});

// ==================== the roster ====================

describe('the roster', () => {
    test('entry: sfuRoster to the newcomer (bootId, cap, grace, self, the others), sfuMember joined to the rest', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        const [ra] = rostersTo(ctx, 0, a.id);
        expect(ra).toMatchObject({ tournamentId: ctx.t.tournamentId, bootId, status: 'admitted', cap: 100, graceMs: 38000, self: { sessionId: null, trackName: null, state: 'live' }, members: [] });
        const [rb] = rostersTo(ctx, 0, b.id);
        expect(rb.members).toEqual([{ username: a.username, sessionId: null, trackName: null, state: 'live' }]);
        expect(membersTo(ctx, 0, a.id)).toEqual([expect.objectContaining({ bootId, event: 'joined', member: { username: b.username, sessionId: null, trackName: null, state: 'live' } })]);
        // rev grows
        expect(membersTo(ctx, 0, a.id)[0].rev).toBeGreaterThan(ra.rev);
    });

    test('session and published reach the others; pull answers the tracks and the SFU offer; renegotiate', async () => {
        const ctx = await tournament(['sfu', 'sfu', 'sfu']);
        const [a, b, c] = ctx.sockets;
        let mark = ctx.log.length;
        const sa = await joinVoice(ctx, a, { publish: true });
        expect(membersTo(ctx, mark, b.id).map((m) => [m.event, m.member.sessionId, m.member.trackName])).toEqual([['session', sa.sessionId, null], ['published', sa.sessionId, 'mic']]);
        expect(sessionToken.verify({ tournamentId: ctx.t.tournamentId, username: a.username, sessionId: sa.sessionId, token: sa.sessionToken })).toBe(true);
        const sb = await joinVoice(ctx, b);
        mark = ctx.log.length;
        const pull = await ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] });
        expect(pull).toMatchObject({ op: 'pull', ok: true, sessionId: sb.sessionId, requiresImmediateRenegotiation: true, offer: { type: 'offer' } });
        expect(pull.tracks).toEqual([{ username: a.username, sessionId: sa.sessionId, trackName: 'mic', mid: '0', errorCode: null, errorDescription: null }]);
        expect(await ask(ctx, b, 'sfuRenegotiate', { sessionId: sb.sessionId, answer: ANSWER })).toEqual({ requestId: expect.any(String), op: 'renegotiate', ok: true, sessionId: sb.sessionId });
        // pulls change nothing for the others
        expect(membersTo(ctx, mark, c.id)).toEqual([]);
        // the Cloudflare calls: the secret only in the header, remote tracks for the pull
        const pullCall = fake.callsOf('pull')[0];
        expect(pullCall.auth).toBe(`Bearer ${fake.secret}`);
        expect(pullCall.body).toEqual({ tracks: [{ location: 'remote', sessionId: sa.sessionId, trackName: 'mic' }] });
        expect(fake.callsOf('push')[0].body).toEqual({ sessionDescription: OFFER, tracks: [{ location: 'local', mid: '0', trackName: 'mic' }] });
        expect(entryOf(ctx, b).pulls.get('0')).toEqual({ sessionId: sa.sessionId, trackName: 'mic', username: a.username });
        // c entering now sees a's track in its roster
        const late = member(ctx, `late_${seq}`);
        mark = ctx.log.length;
        await tournamentHandlers.joinTournament(late, ctx.io, { tournamentId: ctx.t.tournamentId });
        const [rl] = rostersTo(ctx, mark, late.id);
        expect(rl.members.find((m) => m.username === a.username)).toEqual({ username: a.username, sessionId: sa.sessionId, trackName: 'mic', state: 'live' });
    });

    test('per-track errors with HTTP 200 (empty_track_error, not_found_track_error) are passed on with the offer', async () => {
        const ctx = await tournament(['sfu', 'sfu', 'sfu']);
        const [a, b, c] = ctx.sockets;
        const sa = await joinVoice(ctx, a, { publish: true });
        const sc = await joinVoice(ctx, c, { publish: true });
        const sb = await joinVoice(ctx, b);
        fake.sessions.get(sa.sessionId).empty.add('mic');
        // c's session is gone at Cloudflare (its own 410 not seen yet): its track is not found
        fake.sessions.get(sc.sessionId).tracks.clear();
        const pull = await ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }, { sessionId: sc.sessionId, trackName: 'mic' }] });
        expect(pull.ok).toBe(true);
        expect(pull.offer).toMatchObject({ type: 'offer' });
        expect(pull.tracks.map((t) => [t.username, t.mid, t.errorCode])).toEqual([[a.username, null, 'empty_track_error'], [c.username, null, 'not_found_track_error']]);
        expect(entryOf(ctx, b).pulls.size).toBe(0);
    });

    test('close: a pull leaves the record; my own track unpublishes; force needs no offer, negotiated does', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        const sa = await joinVoice(ctx, a, { publish: true });
        const sb = await joinVoice(ctx, b, { publish: true });
        await ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] });
        const pulledMid = [...entryOf(ctx, b).pulls.keys()][0];
        expect(await ask(ctx, b, 'sfuClose', { sessionId: sb.sessionId, mids: [pulledMid] })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        const neg = await ask(ctx, b, 'sfuClose', { sessionId: sb.sessionId, mids: [pulledMid], offer: OFFER });
        expect(neg).toMatchObject({ op: 'close', ok: true, answer: { type: 'answer' }, tracks: [{ mid: pulledMid, errorCode: null }] });
        expect(entryOf(ctx, b).pulls.size).toBe(0);
        const mark = ctx.log.length;
        const own = await ask(ctx, b, 'sfuClose', { sessionId: sb.sessionId, mids: ['0'], force: true });
        expect(own).toMatchObject({ op: 'close', ok: true, answer: null });
        expect(fake.callsOf('close').at(-1).body).toEqual({ tracks: [{ mid: '0' }], force: true });
        expect(membersTo(ctx, mark, a.id).map((m) => [m.event, m.member.trackName])).toEqual([['unpublished', null]]);
        // published again later (the first unmute after a re-join)
        expect(await ask(ctx, b, 'sfuPush', { sessionId: sb.sessionId, offer: OFFER, mid: '0', trackName: 'mic' })).toMatchObject({ ok: true });
    });

    test('ICE restart: no_local_track before the first push; after it, tracks/new with the offer re-declaring my track', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a] = ctx.sockets;
        const sa = await joinVoice(ctx, a);
        expect(await ask(ctx, a, 'sfuIceRestart', { sessionId: sa.sessionId, offer: OFFER })).toMatchObject({ ok: false, error: { code: 'no_local_track', retryable: false } });
        expect(fake.calls.filter((c) => c.op === 'iceRestart')).toEqual([]);
        await ask(ctx, a, 'sfuPush', { sessionId: sa.sessionId, offer: OFFER, mid: '0', trackName: 'mic' });
        const r = await ask(ctx, a, 'sfuIceRestart', { sessionId: sa.sessionId, offer: OFFER });
        expect(r).toMatchObject({ op: 'iceRestart', ok: true, answer: { type: 'answer' }, tracks: [{ mid: '0', trackName: 'mic', errorCode: null }] });
        expect(fake.callsOf('iceRestart')[0].body).toEqual({ sessionDescription: OFFER, tracks: [{ location: 'local', mid: '0', trackName: 'mic' }] });
        // one track per session: another mid or name is refused
        expect(await ask(ctx, a, 'sfuPush', { sessionId: sa.sessionId, offer: OFFER, mid: '1', trackName: 'mic2' })).toMatchObject({ ok: false, error: { code: 'already_published' } });
    });

    test('leave: the others hear my session end at once; idempotent', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        const sa = await joinVoice(ctx, a, { publish: true });
        const mark = ctx.log.length;
        expect(await ask(ctx, a, 'sfuLeave', { sessionId: sa.sessionId })).toEqual({ requestId: expect.any(String), op: 'leave', ok: true });
        expect(membersTo(ctx, mark, b.id).map((m) => [m.event, m.member.sessionId])).toEqual([['session', null]]);
        expect(await ask(ctx, a, 'sfuLeave', {})).toMatchObject({ ok: true });
        expect(await ask(ctx, a, 'sfuPush', { sessionId: sa.sessionId, offer: OFFER, mid: '0', trackName: 'mic' })).toMatchObject({ ok: false, error: { code: 'not_your_session' } });
    });

    test('a drop: reconnecting for the grace; back on a new socket and resumed with the token: resumed, nobody re-pulls', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        // begin, so a disconnect keeps the membership (reattach by username)
        ctx.t.phase = 'between_rounds';
        const sa = await joinVoice(ctx, a, { publish: true });
        let mark = ctx.log.length;
        await kill(ctx.io, a);
        expect(membersTo(ctx, mark, b.id).map((m) => [m.event, m.member.state, m.member.sessionId])).toEqual([['reconnecting', 'reconnecting', sa.sessionId]]);
        await jest.advanceTimersByTimeAsync(20000);
        const a2 = member(ctx, a.username);
        mark = ctx.log.length;
        await tournamentHandlers.joinTournament(a2, ctx.io, { tournamentId: ctx.t.tournamentId });
        const [ra] = rostersTo(ctx, mark, a2.id);
        expect(ra.self).toEqual({ sessionId: sa.sessionId, trackName: 'mic', state: 'reconnecting' });
        // still reconnecting (a new socket that has not resumed): nothing new for b
        expect(membersTo(ctx, mark, b.id)).toEqual([]);
        // ops on the session before the resume: not yet mine on this socket
        expect(await ask(ctx, a2, 'sfuIceRestart', { sessionId: sa.sessionId, offer: OFFER })).toMatchObject({ ok: false, error: { code: 'not_your_session' } });
        expect(await ask(ctx, a2, 'sfuResume', { sessionId: sa.sessionId, sessionToken: 'b'.repeat(43), trackName: 'mic', mid: '0' })).toMatchObject({ ok: false, error: { code: 'bad_token' } });
        expect(await ask(ctx, a2, 'sfuResume', { sessionId: sa.sessionId, sessionToken: sa.sessionToken, trackName: 'mic', mid: null })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        mark = ctx.log.length;
        expect(await ask(ctx, a2, 'sfuResume', { sessionId: sa.sessionId, sessionToken: sa.sessionToken, trackName: 'mic', mid: '0' })).toMatchObject({ op: 'resume', ok: true });
        expect(membersTo(ctx, mark, b.id).map((m) => [m.event, m.member])).toEqual([['resumed', { username: a.username, sessionId: sa.sessionId, trackName: 'mic', state: 'live' }]]);
        // the grace timer is gone: nothing at 38 s
        mark = ctx.log.length;
        await jest.advanceTimersByTimeAsync(30000);
        expect(membersTo(ctx, mark, b.id)).toEqual([]);
        expect(await ask(ctx, a2, 'sfuIceRestart', { sessionId: sa.sessionId, offer: OFFER })).toMatchObject({ ok: true });
    });

    test('grace expiry: a member who never comes back is left after 38 s (not before)', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        await joinVoice(ctx, a, { publish: true });
        const mark = ctx.log.length;
        await kill(ctx.io, a);
        await jest.advanceTimersByTimeAsync(37000);
        expect(membersTo(ctx, mark, b.id).map((m) => m.event)).toEqual(['reconnecting']);
        await jest.advanceTimersByTimeAsync(1500);
        expect(membersTo(ctx, mark, b.id).map((m) => m.event)).toEqual(['reconnecting', 'left']);
        expect(entryOf(ctx, a)).toBeUndefined();
    });

    test('grace expiry while back on a new socket without resuming: the session is cleared (session null), the member stays', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        ctx.t.phase = 'between_rounds';
        await joinVoice(ctx, a, { publish: true });
        await kill(ctx.io, a);
        const a2 = member(ctx, a.username);
        await tournamentHandlers.joinTournament(a2, ctx.io, { tournamentId: ctx.t.tournamentId });
        const mark = ctx.log.length;
        await jest.advanceTimersByTimeAsync(39000);
        expect(membersTo(ctx, mark, b.id).map((m) => [m.event, m.member.sessionId, m.member.state])).toEqual([['session', null, 'live']]);
        // a member without a session that drops is just gone (nothing to keep)
        const m2 = ctx.log.length;
        await kill(ctx.io, a2);
        expect(membersTo(ctx, m2, b.id).map((m) => m.event)).toEqual(['left']);
    });

    test('a server restart (new bootId, empty roster): the member re-registers its SAME session with the token', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        const sa = await joinVoice(ctx, a, { publish: true });
        const sb = await joinVoice(ctx, b);
        await ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] });
        // a deploy: the new process knows nothing of the room (voiceRoom is
        // never saved; the tournament is adopted) and the members enter it
        // again with their next tournamentJoined
        ctx.t.voiceRoom = { order: 0, members: new Map() };
        const mark = ctx.log.length;
        for (const s of [a, b]) tournamentVoice.enter(ctx.io, ctx.t, s.id);
        expect(rostersTo(ctx, mark, a.id)[0].bootId).toBe(bootId);
        expect(rostersTo(ctx, mark, a.id)[0].self).toEqual({ sessionId: null, trackName: null, state: 'live' });
        expect(await ask(ctx, a, 'sfuResume', { sessionId: sa.sessionId, sessionToken: sa.sessionToken, trackName: 'mic', mid: '0' })).toMatchObject({ ok: true });
        expect(await ask(ctx, b, 'sfuResume', { sessionId: sb.sessionId, sessionToken: sb.sessionToken, trackName: null, mid: null, pulls: [{ mid: '0', sessionId: sa.sessionId, trackName: 'mic' }] })).toMatchObject({ ok: true });
        expect(membersTo(ctx, mark, b.id).filter((m) => m.member.username === a.username).at(-1).member).toEqual({ username: a.username, sessionId: sa.sessionId, trackName: 'mic', state: 'live' });
        expect(entryOf(ctx, b).pulls.get('0')).toEqual({ sessionId: sa.sessionId, trackName: 'mic', username: a.username });
        // another member's session with my name: refused
        expect(await ask(ctx, b, 'sfuResume', { sessionId: sa.sessionId, sessionToken: sa.sessionToken, trackName: null, mid: null })).toMatchObject({ ok: false, error: { code: 'bad_token' } });
    });

    test('the line past the ceiling (VOICE_SFU_ROOM_MAX): sfuRoster waiting, then admitted when one leaves; only SFU members count', async () => {
        process.env.VOICE_SFU_ROOM_MAX = '2';
        const ctx = await tournament(['sfu', 'web', 'sfu', 'sfu']);
        const [a, , c, d] = ctx.sockets;
        expect(rostersTo(ctx, 0, c.id).map((r) => r.status)).toEqual(['admitted']);
        expect(rostersTo(ctx, 0, d.id)).toEqual([expect.objectContaining({ status: 'waiting', cap: 2, self: null, members: [] })]);
        expect(await ask(ctx, d, 'sfuSession')).toMatchObject({ ok: false, error: { code: 'not_in_room' } });
        const mark = ctx.log.length;
        await tournamentHandlers.leaveTournament(a, ctx.io);
        expect(rostersTo(ctx, mark, d.id).map((r) => r.status)).toEqual(['admitted']);
        expect(membersTo(ctx, mark, c.id).map((m) => [m.event, m.member.username])).toEqual([['left', a.username], ['joined', d.username]]);
        expect(meshSince(ctx, 0)).toEqual([]);
    });

    test('leaving to a table, the main room, cancel: out to the leaver, left to the rest; cancel keeps nobody reconnecting', async () => {
        const ctx = await tournament(['sfu', 'sfu', 'sfu']);
        const [a, b, c] = ctx.sockets;
        await joinVoice(ctx, b, { publish: true });
        let mark = ctx.log.length;
        mainRoomHandlers.joinMainRoom(c, ctx.io);
        expect(rostersTo(ctx, mark, c.id).map((r) => r.status)).toEqual(['out']);
        expect(membersTo(ctx, mark, a.id).map((m) => m.event)).toEqual(['left']);
        mark = ctx.log.length;
        await tournamentHandlers.cancelTournament(a, ctx.io);
        expect(rostersTo(ctx, mark, a.id).map((r) => r.status)).toEqual(['out']);
        expect(rostersTo(ctx, mark, b.id).map((r) => r.status)).toEqual(['out']);
        expect(since(ctx, mark, 'sfuMember')).toEqual([]);
        expect(ctx.t.voiceRoom.sfu.entries.size).toBe(0);
        expect(logs.some((l) => l.msg === 'Voice SFU: room stats' && l.meta.why === 'closed' && l.meta.calls === 2)).toBe(true);
    });
});

// ==================== refusals ====================

describe('refusals', () => {
    test('no requestId: dropped silently; invalid payload: invalid; never serverError', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a] = ctx.sockets;
        const mark = ctx.log.length;
        await sfu.sfuSession(a, ctx.io, {});
        await sfu.sfuSession(a, ctx.io, null);
        await sfu.sfuPull(a, ctx.io, { requestId: 'x'.repeat(65), sessionId: 'abc', tracks: [] });
        expect(ctx.log.slice(mark)).toEqual([]);
        expect(await ask(ctx, a, 'sfuPull', { sessionId: 'abc', tracks: [] })).toMatchObject({ ok: false, op: 'pull', sessionId: 'abc', error: { code: 'invalid', retryable: false } });
        expect(since(ctx, 0, 'serverError')).toEqual([]);
    });

    test('rate limits: sfuSession 6 a minute, the rest 300 per 10 s together; rate_limited with retryAfterMs', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a] = ctx.sockets;
        for (let i = 0; i < 6; i++) expect((await ask(ctx, a, 'sfuSession')).ok).toBe(true);
        expect(await ask(ctx, a, 'sfuSession')).toMatchObject({ ok: false, error: { code: 'rate_limited', retryable: true, retryAfterMs: 1000 } });
        expect(fake.callsOf('sessions/new')).toHaveLength(6);
        for (let i = 0; i < 300; i++) await sfu.sfuLeave(a, ctx.io, { requestId: `l${i}` });
        expect(await ask(ctx, a, 'sfuLeave')).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
        expect(rateLimiter.limits.sfuCall).toEqual({ max: 300, windowMs: 10000 });
    });

    test('not a member: not signed in, a spectator, another tournament\'s; someone else\'s session: not_your_session', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        const sa = await joinVoice(ctx, a, { publish: true });
        const sb = await joinVoice(ctx, b);
        expect(await ask(ctx, b, 'sfuPush', { sessionId: sa.sessionId, offer: OFFER, mid: '0', trackName: 'mic' })).toMatchObject({ ok: false, error: { code: 'not_your_session' } });
        expect(await ask(ctx, b, 'sfuClose', { sessionId: sa.sessionId, mids: ['0'], force: true })).toMatchObject({ ok: false, error: { code: 'not_your_session' } });
        expect(await ask(ctx, b, 'sfuLeave', { sessionId: sa.sessionId })).toMatchObject({ ok: true });
        expect(entryOf(ctx, a).sessionId).toBe(sa.sessionId);
        const stranger = newUser(ctx.io, ctx.log, `x_${seq}`);
        stranger.data.client = KINDS.sfu;
        expect(await ask(ctx, stranger, 'sfuSession')).toMatchObject({ ok: false, error: { code: 'not_in_room' } });
        // another tournament's member cannot pull this one's tracks
        const other = await tournament(['sfu', 'sfu'], { io: { io: ctx.io, log: ctx.log } });
        const so = await joinVoice({ ...ctx, t: other.t }, other.sockets[0]);
        const before = fake.callsOf('pull').length;
        const pull = await ask(ctx, other.sockets[0], 'sfuPull', { sessionId: so.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] });
        expect(pull).toMatchObject({ ok: true, offer: null, requiresImmediateRenegotiation: false, tracks: [{ sessionId: sa.sessionId, trackName: 'mic', mid: null, errorCode: 'not_in_room', username: null }] });
        expect(fake.callsOf('pull')).toHaveLength(before);
        // my own track, an unpublished one, a duplicate: refused per track
        const own = await ask(ctx, a, 'sfuPull', { sessionId: sa.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }, { sessionId: sb.sessionId, trackName: 'mic' }] });
        expect(own.tracks.map((t) => t.errorCode)).toEqual(['own_track', 'not_in_room']);
        const dup = await ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }, { sessionId: sa.sessionId, trackName: 'mic' }] });
        expect(dup.tracks.map((t) => t.errorCode)).toEqual([null, 'duplicate']);
        // open pulls per session are capped at the room's ceiling (Cloudflare allows the same track again and again)
        process.env.VOICE_SFU_ROOM_MAX = '2';
        expect((await ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] })).tracks[0].errorCode).toBe(null);
        expect((await ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] })).tracks[0].errorCode).toBe('too_many_pulls');
        expect(entryOf(ctx, b).pulls.size).toBe(2);
    });

    test('a blocked pair: never in each other\'s roster, pulls refused; a block mid-call: left both ways, force close 5 s later', async () => {
        // c blocked a
        const ctx = await tournament(['sfu', 'sfu', 'sfu'], { blocks: { 2: [0] } });
        const [a, b, c] = ctx.sockets;
        expect(rostersTo(ctx, 0, c.id)[0].members.map((m) => m.username)).toEqual([b.username]);
        const sa = await joinVoice(ctx, a, { publish: true });
        const sb = await joinVoice(ctx, b, { publish: true });
        const sc = await joinVoice(ctx, c);
        expect(membersTo(ctx, 0, c.id).some((m) => m.member.username === a.username)).toBe(false);
        expect((await ask(ctx, c, 'sfuPull', { sessionId: sc.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] })).tracks[0].errorCode).toBe('blocked');
        // a and b pull each other, then b blocks a
        await ask(ctx, a, 'sfuPull', { sessionId: sa.sessionId, tracks: [{ sessionId: sb.sessionId, trackName: 'mic' }] });
        await ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] });
        const mark = ctx.log.length;
        await safety.blockUser(b, ctx.io, { username: a.username });
        expect(membersTo(ctx, mark, a.id).map((m) => [m.event, m.member.username])).toEqual([['left', b.username]]);
        expect(membersTo(ctx, mark, b.id).map((m) => [m.event, m.member.username])).toEqual([['left', a.username]]);
        expect(meshSince(ctx, mark)).toEqual([]);
        // b closes its own pull (a well-behaved client); a does not
        const bMid = [...entryOf(ctx, b).pulls.keys()][0];
        await ask(ctx, b, 'sfuClose', { sessionId: sb.sessionId, mids: [bMid], force: true });
        const closesBefore = fake.callsOf('close').length;
        await jest.advanceTimersByTimeAsync(sfuRoom.BLOCK_ENFORCE_MS + 10);
        const forced = fake.callsOf('close').slice(closesBefore);
        expect(forced).toEqual([expect.objectContaining({ sessionId: sa.sessionId, body: { tracks: [{ mid: expect.any(String) }], force: true } })]);
        expect(entryOf(ctx, a).pulls.size).toBe(0);
        // and no new pull between them
        expect((await ask(ctx, a, 'sfuPull', { sessionId: sa.sessionId, tracks: [{ sessionId: sb.sessionId, trackName: 'mic' }] })).tracks[0].errorCode).toBe('blocked');
    });
});

// ==================== Cloudflare failures and the queue ====================

describe('Cloudflare failures and the queue', () => {
    test('410 on my session: session_gone (not retryable), my session cleared, the room told, queued work answered session_gone', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        const sa = await joinVoice(ctx, a, { publish: true });
        fake.goneSession(sa.sessionId);
        const mark = ctx.log.length;
        const p1 = ask(ctx, a, 'sfuIceRestart', { sessionId: sa.sessionId, offer: OFFER });
        const p2 = ask(ctx, a, 'sfuRenegotiate', { sessionId: sa.sessionId, answer: ANSWER });
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toMatchObject({ ok: false, error: { code: 'session_gone', retryable: false, status: 410, cfCode: 'session_error' } });
        expect(r2).toMatchObject({ ok: false, error: { code: 'session_gone' } });
        // only one call reached Cloudflare: the second never ran on the dead session
        expect(fake.calls.filter((c) => c.sessionId === sa.sessionId && ['iceRestart', 'renegotiate'].includes(c.op))).toHaveLength(1);
        expect(membersTo(ctx, mark, b.id).map((m) => [m.event, m.member.sessionId, m.member.trackName])).toEqual([['session', null, null]]);
        expect(entryOf(ctx, a).sessionId).toBeNull();
        // a new session works at once
        const again = await joinVoice(ctx, a, { publish: true });
        expect(again.sessionId).not.toBe(sa.sessionId);
    });

    test('a timeout: timeout (retryable, retryAfterMs) after VOICE_SFU_TIMEOUT_MS; other errors keep Cloudflare\'s status and code', async () => {
        process.env.VOICE_SFU_TIMEOUT_MS = '2000';
        const ctx = await tournament(['sfu', 'sfu']);
        const [a] = ctx.sockets;
        fake.fail = (op) => (op === 'sessions/new' ? 'hang' : null);
        const pending = ask(ctx, a, 'sfuSession');
        await jest.advanceTimersByTimeAsync(2100);
        expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout', retryable: true, retryAfterMs: 1000 } });
        fake.fail = (op) => (op === 'sessions/new' ? { status: 503, json: { errorCode: 'unavailable' } } : null);
        expect(await ask(ctx, a, 'sfuSession')).toMatchObject({ ok: false, error: { code: 'cloudflare_error', retryable: true, status: 503, cfCode: 'unavailable' } });
        fake.fail = (op) => (op === 'sessions/new' ? { status: 400, json: { errorCode: 'invalid_request' } } : null);
        expect(await ask(ctx, a, 'sfuSession')).toMatchObject({ ok: false, error: { code: 'cloudflare_error', retryable: false, status: 400 } });
        fake.fail = null;
        // wrong secret: Cloudflare's 401, never the secret in a log
        process.env.CF_SFU_APP_SECRET = 'not-the-fake-secret';
        expect(await ask(ctx, a, 'sfuSession')).toMatchObject({ ok: false, error: { code: 'cloudflare_error', status: 401 } });
        expect(logs.some((l) => l.msg === 'Voice SFU: Cloudflare call failed' && l.meta.op === 'sessions/new' && l.meta.code === 'timeout')).toBe(true);
    });

    test('one serial queue per session: calls never overlap and keep their order; a new session supersedes the old one\'s queued work', async () => {
        const ctx = await tournament(['sfu', 'sfu', 'sfu']);
        const [a, b, c] = ctx.sockets;
        const sa = await joinVoice(ctx, a, { publish: true });
        const sc = await joinVoice(ctx, c, { publish: true });
        const sb = await joinVoice(ctx, b);
        // hold Cloudflare's answers until released
        const order = [];
        let open = 0;
        let maxOpen = 0;
        const gates = [];
        const real = fake.fetch;
        cf._setFetchForTests(async (url, init) => {
            open++;
            maxOpen = Math.max(maxOpen, open);
            const body = init.body ? JSON.parse(init.body) : null;
            order.push(body?.tracks?.[0]?.sessionId ?? body?.sessionDescription?.type ?? 'x');
            await new Promise((r) => gates.push(r));
            open--;
            return real(url, init);
        });
        const p1 = ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] });
        const p2 = ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sc.sessionId, trackName: 'mic' }] });
        const p3 = ask(ctx, b, 'sfuRenegotiate', { sessionId: sb.sessionId, answer: ANSWER });
        await jest.advanceTimersByTimeAsync(0);
        expect(gates).toHaveLength(1);
        gates.shift()();
        await jest.advanceTimersByTimeAsync(0);
        expect(gates).toHaveLength(1);
        // b replaces its session while p2 runs: p3 (queued) is superseded and never called
        cf._setFetchForTests(real);
        const fresh = await ask(ctx, b, 'sfuSession');
        expect(fresh.ok).toBe(true);
        gates.shift()();
        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
        expect(maxOpen).toBe(1);
        expect(order).toEqual([sa.sessionId, sc.sessionId]);
        expect(r1).toMatchObject({ ok: true });
        // p2 ran, but its session is no longer b's: superseded (nothing recorded for the old session)
        expect(r2).toMatchObject({ ok: false, error: { code: 'superseded' } });
        expect(r3).toMatchObject({ ok: false, error: { code: 'superseded' } });
        expect(entryOf(ctx, b).sessionId).toBe(fresh.sessionId);
        expect(entryOf(ctx, b).pulls.size).toBe(0);
    });

    test('the queue: busy past its depth; drop answers every job not started', async () => {
        const q = createSessionQueues({ maxDepth: 2 });
        let release;
        const first = q.run('k', () => new Promise((r) => { release = r; }));
        const second = q.run('k', async () => 'two');
        expect(await q.run('k', async () => 'three')).toEqual({ dropped: 'busy' });
        expect(q.depth('k')).toBe(2);
        expect(q.drop('k', 'superseded')).toBe(1);
        expect(await second).toEqual({ dropped: 'superseded' });
        release('one');
        expect(await first).toBe('one');
        expect(await q.run('k', async () => { throw new Error('boom'); })).toMatchObject({ dropped: 'error' });
        await jest.advanceTimersByTimeAsync(0);
        expect(q.size()).toBe(0);
    });

    test('nothing logged carries the secret, a session token or an SDP', async () => {
        const ctx = await tournament(['sfu', 'sfu']);
        const [a, b] = ctx.sockets;
        const sa = await joinVoice(ctx, a, { publish: true });
        const sb = await joinVoice(ctx, b);
        await ask(ctx, b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] });
        await ask(ctx, b, 'sfuRenegotiate', { sessionId: sb.sessionId, answer: ANSWER });
        fake.goneSession(sb.sessionId);
        await ask(ctx, b, 'sfuRenegotiate', { sessionId: sb.sessionId, answer: ANSWER });
        await ask(ctx, a, 'sfuResume', { sessionId: sa.sessionId, sessionToken: 'z'.repeat(43), trackName: 'mic', mid: '0' });
        await tournamentHandlers.cancelTournament(a, ctx.io);
        const text = JSON.stringify(logs);
        expect(logs.length).toBeGreaterThan(5);
        expect(text).not.toContain(fake.secret);
        expect(text).not.toContain(sa.sessionToken);
        expect(text).not.toContain('v=0');
        expect(text).not.toContain('z'.repeat(43));
    });
});
