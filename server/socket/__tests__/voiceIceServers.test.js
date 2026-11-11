/**
 * Voice ICE servers (owner, 2026-11-11: Cloudflare Realtime TURN, the PCM
 * relay goes): server/voice/turnCredentials.js mints short-lived TURN
 * credentials with a mocked fetch, and voiceHandlers.getVoiceIceServers
 * answers voiceIceServers. Every emit here goes through gameDriver's
 * makeSocket, so the contract guard validates each payload.
 *
 * Covered: success (request shape, port-53 filter), timeout, 4xx / 5xx,
 * malformed body, env unset, per-user cache and single flight, refresh once
 * under an hour is left, failure backoff, the per-minute budget, the API
 * base override only outside production, unauthenticated / non-peer sockets
 * refused (STUN, no Cloudflare call), the wrapper rate limit, and that the
 * token never reaches a log line or a payload.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const gameManager = require('../../game/GameManager');
const voice = require('../voiceHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const { asyncHandler, rateLimiter } = require('../errorHandler');
const turn = require('../../voice/turnCredentials');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, logger, authLogger } = require('../../utils/logger');

const KEY_ID = 'k3yid0123456789abcdef';
const TOKEN = 'tok_SECRET_9f8e7d6c5b4a';
const USERNAME_CF = 'a1b2c3d4e5f6';
const CREDENTIAL_CF = 'cred_XYZ_123';

/** The documented 201 body (developers.cloudflare.com/realtime/turn/generate-credentials). */
const CF_BODY = {
    iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
        {
            urls: [
                'turn:turn.cloudflare.com:3478?transport=udp',
                'turn:turn.cloudflare.com:53?transport=udp',
                'turn:turn.cloudflare.com:3478?transport=tcp',
                'turn:turn.cloudflare.com:80?transport=tcp',
                'turns:turn.cloudflare.com:5349?transport=tcp',
                'turns:turn.cloudflare.com:443?transport=tcp',
            ],
            username: USERNAME_CF,
            credential: CREDENTIAL_CF,
        },
    ],
};

const okResponse = (body = CF_BODY, status = 201) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const ENV_KEYS = ['CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_API_TOKEN', 'CLOUDFLARE_TURN_API_BASE', 'NODE_ENV'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setTurnEnv = () => {
    process.env.CLOUDFLARE_TURN_KEY_ID = KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = TOKEN;
};

let logged;
let log;
let io;
let seq = 0;

beforeEach(() => {
    seq++;
    log = [];
    io = makeIo(log);
    logged = [];
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, logger, authLogger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) {
            jest.spyOn(l, m).mockImplementation((...args) => { logged.push(args); });
        }
    }
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation((...args) => { logged.push(args); });
    for (const k of ENV_KEYS) if (k !== 'NODE_ENV') delete process.env[k];
    turn._reset();
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    gameManager.playerLobbies.clear();
    jest.useRealTimers();
    jest.restoreAllMocks();
    turn._reset();
});

afterAll(() => rateLimiter.shutdown());

/** The token (and key id) never show up in a log line or an emitted payload. */
function expectNoSecrets() {
    const text = JSON.stringify(logged) + JSON.stringify(log);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(KEY_ID);
}

function user(tag) {
    const id = `ice${seq}-${tag}`;
    const s = makeSocket(id, log, io);
    gameManager.registerUser(id, `${tag}${seq}`);
    voice.rememberBlockList(s, []);
    return s;
}

function lobbyMember() {
    const a = user('a');
    const b = user('b');
    mainRoomHandlers.joinMainRoom(a, io);
    mainRoomHandlers.joinMainRoom(b, io);
    mainRoomHandlers.createLobby(a, io, {});
    mainRoomHandlers.joinLobby(b, io, { lobbyId: gameManager.getPlayerLobby(a.id).id });
    return a;
}

const replies = () => log.filter((l) => l.event === 'voiceIceServers');

describe('sanitizeIceServers', () => {
    test('keeps stun / turn / turns URLs, drops port 53, carries the TURN credentials only', () => {
        expect(turn.sanitizeIceServers(CF_BODY)).toEqual([
            { urls: ['stun:stun.cloudflare.com:3478'] },
            {
                urls: [
                    'turn:turn.cloudflare.com:3478?transport=udp',
                    'turn:turn.cloudflare.com:3478?transport=tcp',
                    'turn:turn.cloudflare.com:80?transport=tcp',
                    'turns:turn.cloudflare.com:5349?transport=tcp',
                    'turns:turn.cloudflare.com:443?transport=tcp',
                ],
                username: USERNAME_CF,
                credential: CREDENTIAL_CF,
            },
        ]);
    });

    test.each([
        ['no body', null],
        ['no iceServers', { servers: [] }],
        ['STUN only', { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] }],
        ['TURN without a credential', { iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u' }] }],
        ['foreign schemes', { iceServers: [{ urls: ['http://evil.example/x', 'javascript:alert(1)'], username: 'u', credential: 'c' }] }],
        ['only port 53', { iceServers: [{ urls: ['turn:turn.cloudflare.com:53?transport=udp'], username: 'u', credential: 'c' }] }],
    ])('%s: null', (_label, body) => {
        expect(turn.sanitizeIceServers(body)).toBeNull();
    });

    test('extra fields are dropped; a single urls string is accepted', () => {
        const out = turn.sanitizeIceServers({ iceServers: [{ urls: 'turns:turn.cloudflare.com:443?transport=tcp', username: 'u', credential: 'c', credentialType: 'password', x: 1 }] });
        expect(out).toEqual([{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }]);
    });
});

describe('turnConfig', () => {
    test('both variables or nothing; the key id must be path-safe', () => {
        expect(turn.turnConfig({})).toBeNull();
        expect(turn.turnConfig({ CLOUDFLARE_TURN_KEY_ID: KEY_ID })).toBeNull();
        expect(turn.turnConfig({ CLOUDFLARE_TURN_API_TOKEN: TOKEN })).toBeNull();
        expect(turn.turnConfig({ CLOUDFLARE_TURN_KEY_ID: '../x', CLOUDFLARE_TURN_API_TOKEN: TOKEN })).toBeNull();
        expect(turn.turnConfig({ CLOUDFLARE_TURN_KEY_ID: KEY_ID, CLOUDFLARE_TURN_API_TOKEN: TOKEN }).base).toBe('https://rtc.live.cloudflare.com');
    });

    test('the API base override works outside production only', () => {
        const env = { CLOUDFLARE_TURN_KEY_ID: KEY_ID, CLOUDFLARE_TURN_API_TOKEN: TOKEN, CLOUDFLARE_TURN_API_BASE: 'http://127.0.0.1:9999/' };
        expect(turn.turnConfig({ ...env, NODE_ENV: 'development' }).base).toBe('http://127.0.0.1:9999');
        expect(turn.turnConfig({ ...env, NODE_ENV: 'production' }).base).toBe('https://rtc.live.cloudflare.com');
    });
});

describe('createTurnCredentials (mocked fetch and clock)', () => {
    let clock;
    const env = { CLOUDFLARE_TURN_KEY_ID: KEY_ID, CLOUDFLARE_TURN_API_TOKEN: TOKEN };
    const make = (fetch, e = env) => turn.createTurnCredentials({ fetch, now: () => clock, env: () => e, logger: socketLogger });
    beforeEach(() => { clock = 1_700_000_000_000; });

    test('success: one POST with the bearer token and the TTL; TURN servers with the remaining validity', async () => {
        const fetch = jest.fn(async () => okResponse());
        const t = make(fetch);
        const a = await t.getIceServers('alice');
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe(`https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
        expect(JSON.parse(init.body)).toEqual({ ttl: turn.TTL_SEC });
        expect(init.signal).toBeDefined();
        expect(a.turn).toBe(true);
        expect(a.expiresInSec).toBe(turn.TTL_SEC - 60);
        expect(a.iceServers[1]).toMatchObject({ username: USERNAME_CF, credential: CREDENTIAL_CF });
        expect(JSON.stringify(a)).not.toContain(TOKEN);
        expect(JSON.stringify(a)).not.toMatch(/:53[?"]/);
        expectNoSecrets();
    });

    test('env unset: STUN only (the servers both clients used before), no call', async () => {
        const fetch = jest.fn();
        const a = await make(fetch, {}).getIceServers('alice');
        expect(fetch).not.toHaveBeenCalled();
        expect(a).toEqual({
            iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }, { urls: ['stun:stun1.l.google.com:19302'] }],
            turn: false,
            expiresInSec: null,
        });
    });

    test('cache: reused per user until under an hour is left, then minted again; other users mint their own', async () => {
        const fetch = jest.fn(async () => okResponse());
        const t = make(fetch);
        await t.getIceServers('alice');
        clock += 2.9 * 3600 * 1000; // 1 h 05 min left (TTL 4 h minus the 60 s skew)
        const again = await t.getIceServers('alice');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(again.expiresInSec).toBe(Math.floor(turn.TTL_SEC - 60 - 2.9 * 3600));
        clock += 0.2 * 3600 * 1000; // under an hour left
        const fresh = await t.getIceServers('alice');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fresh.expiresInSec).toBe(turn.TTL_SEC - 60);
        await t.getIceServers('bob');
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    test('single flight: concurrent requests of one user share one call', async () => {
        let release;
        const fetch = jest.fn(() => new Promise((r) => { release = () => r(okResponse()); }));
        const t = make(fetch);
        const p = [t.getIceServers('alice'), t.getIceServers('alice'), t.getIceServers('alice')];
        release();
        const out = await Promise.all(p);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(out.every((a) => a.turn)).toBe(true);
    });

    test.each([[400], [401], [403], [404], [429], [500], [503]])('HTTP %i: STUN only, the status logged, never the token', async (status) => {
        const fetch = jest.fn(async () => okResponse({ errors: [{ message: 'nope' }] }, status));
        const a = await make(fetch).getIceServers('alice');
        expect(a.turn).toBe(false);
        expect(a.iceServers).toEqual(turn.stunOnly().iceServers);
        expect(socketLogger.warn).toHaveBeenCalledWith('Voice TURN: credential request refused', { status });
        expectNoSecrets();
    });

    test('a malformed 201 body: STUN only', async () => {
        const fetch = jest.fn(async () => okResponse({ iceServers: [{ urls: ['stun:x:3478'] }] }));
        expect((await make(fetch).getIceServers('alice')).turn).toBe(false);
        expect(socketLogger.warn).toHaveBeenCalledWith('Voice TURN: unexpected credential response shape');
    });

    test('a network error: STUN only, logged without its message (it could carry the URL)', async () => {
        const fetch = jest.fn(async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); });
        expect((await make(fetch).getIceServers('alice')).turn).toBe(false);
        expect(socketLogger.warn).toHaveBeenCalledWith('Voice TURN: credential request failed', { reason: 'network' });
        expectNoSecrets();
    });

    test('timeout: the call is aborted after FETCH_TIMEOUT_MS and answers STUN; then a backoff with no calls', async () => {
        jest.useFakeTimers();
        const fetch = jest.fn((_url, init) => new Promise((_r, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        const t = make(fetch);
        let done = null;
        const p = t.getIceServers('alice').then((a) => { done = a; });
        await jest.advanceTimersByTimeAsync(turn.FETCH_TIMEOUT_MS - 1);
        expect(done).toBeNull();
        await jest.advanceTimersByTimeAsync(1);
        await p;
        expect(done.turn).toBe(false);
        expect(socketLogger.warn).toHaveBeenCalledWith('Voice TURN: credential request failed', { reason: 'timeout' });
        // backoff: no new call for FAILURE_BACKOFF_MS
        expect((await t.getIceServers('bob')).turn).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
        clock += turn.FAILURE_BACKOFF_MS;
        fetch.mockImplementation(async () => okResponse());
        expect((await t.getIceServers('bob')).turn).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('a failure while an old entry is still valid answers that entry', async () => {
        const fetch = jest.fn(async () => okResponse());
        const t = make(fetch);
        await t.getIceServers('alice');
        clock += 3.5 * 3600 * 1000; // under an hour left, still valid
        fetch.mockImplementation(async () => okResponse({}, 502));
        const a = await t.getIceServers('alice');
        expect(a.turn).toBe(true);
        expect(a.expiresInSec).toBe(Math.floor(turn.TTL_SEC - 60 - 3.5 * 3600));
        clock += 3600 * 1000; // expired, and Cloudflare in backoff
        expect((await t.getIceServers('alice')).turn).toBe(false);
    });

    test('budget: at most MAX_MINTS_PER_MINUTE calls a minute, then STUN until the window rolls', async () => {
        const fetch = jest.fn(async () => okResponse());
        const t = make(fetch);
        for (let i = 0; i < turn.MAX_MINTS_PER_MINUTE; i++) expect((await t.getIceServers(`u${i}`)).turn).toBe(true);
        expect((await t.getIceServers('one-more')).turn).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(turn.MAX_MINTS_PER_MINUTE);
        clock += 60 * 1000;
        expect((await t.getIceServers('one-more')).turn).toBe(true);
    });

    test('the API base override is used outside production (a fake Cloudflare for dev / live checks)', async () => {
        const fetch = jest.fn(async () => okResponse());
        await make(fetch, { ...env, CLOUDFLARE_TURN_API_BASE: 'http://127.0.0.1:4555', NODE_ENV: 'development' }).getIceServers('alice');
        expect(fetch.mock.calls[0][0]).toBe(`http://127.0.0.1:4555/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
    });
});

describe('getVoiceIceServers handler (the shared instance, global fetch mocked)', () => {
    test('env unset: a lobby member gets STUN with the requestId echoed; Cloudflare never called', async () => {
        const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse());
        const a = lobbyMember();
        await voice.getVoiceIceServers(a, io, { requestId: 'ice-1' });
        expect(replies()).toHaveLength(1);
        expect(replies()[0]).toMatchObject({ to: `self:${a.id}`, data: { turn: false, expiresInSec: null, requestId: 'ice-1' } });
        expect(fetch).not.toHaveBeenCalled();
    });

    test('TURN on: a lobby member gets Cloudflare servers; a second request uses the cache', async () => {
        setTurnEnv();
        const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse());
        const a = lobbyMember();
        await voice.getVoiceIceServers(a, io, {});
        await voice.getVoiceIceServers(a, io, undefined);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [r1, r2] = replies();
        expect(r1.data.turn).toBe(true);
        expect(r1.data).not.toHaveProperty('requestId');
        expect(r1.data.iceServers.find((s) => s.username)).toMatchObject({ username: USERNAME_CF, credential: CREDENTIAL_CF });
        expect(r2.data.turn).toBe(true);
        expectNoSecrets();
    });

    test('a game seat owner is a voice peer too', async () => {
        setTurnEnv();
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse());
        const s = user('g');
        gameManager.playerGames.set(s.id, 'some-game');
        try {
            await voice.getVoiceIceServers(s, io, {});
        } finally {
            gameManager.playerGames.delete(s.id);
        }
        expect(replies()[0].data.turn).toBe(true);
    });

    test('refused: an unauthenticated socket and a signed-in socket outside any lobby or game get STUN, no Cloudflare call', async () => {
        setTurnEnv();
        const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse());
        const anon = makeSocket(`ice${seq}-anon`, log, io);
        await voice.getVoiceIceServers(anon, io, { requestId: 'x' });
        const loner = user('loner');
        mainRoomHandlers.joinMainRoom(loner, io);
        await voice.getVoiceIceServers(loner, io, {});
        expect(replies().map((r) => r.data.turn)).toEqual([false, false]);
        expect(replies()[0].data.requestId).toBe('x');
        expect(fetch).not.toHaveBeenCalled();
    });

    test('signed out while Cloudflare answered: STUN, the credentials are not sent', async () => {
        setTurnEnv();
        let release;
        jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((r) => { release = () => r(okResponse()); }));
        const a = lobbyMember();
        const p = voice.getVoiceIceServers(a, io, {});
        gameManager.removeUserSocket(a.id);
        release();
        await p;
        expect(replies()[0].data.turn).toBe(false);
        expect(JSON.stringify(log)).not.toContain(CREDENTIAL_CF);
    });

    test('Cloudflare down (5xx): STUN, so voice behaves as before', async () => {
        setTurnEnv();
        jest.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse({}, 500));
        const a = lobbyMember();
        await voice.getVoiceIceServers(a, io, {});
        expect(replies()[0].data).toEqual({ iceServers: turn.stunOnly().iceServers, turn: false, expiresInSec: null });
        expectNoSecrets();
    });

    test('the wrapper (index.js): no payload or null (socket.io\'s explicit undefined) is fine; Joi refuses a bad requestId; over 20 a minute the socket gets error rateLimit', async () => {
        const wrapped = asyncHandler('getVoiceIceServers', voice.getVoiceIceServers);
        const a = lobbyMember();
        await wrapped(a, io, undefined);
        await wrapped(a, io, null);
        expect(replies()).toHaveLength(2);
        await wrapped(a, io, { requestId: '' });
        expect(log.filter((l) => l.event === 'error' && l.to === `self:${a.id}`)).toHaveLength(1);
        log.length = 0;
        for (let i = 0; i < 25; i++) await wrapped(a, io, {});
        expect(replies()).toHaveLength(17); // the three calls above spent three
        expect(log.filter((l) => l.event === 'error').map((l) => l.data.type)).toEqual(Array(8).fill('rateLimit'));
    });
});
