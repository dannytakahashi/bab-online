/**
 * Per-socket limits on the events that had none (restoreSession,
 * rejoinGame, joinLobby, joinAsSpectator, getProfile, updateProfilePic,
 * and the no-payload joinMainRoom, playerReady, playerUnready, leaveLobby,
 * addBot through safeHandler's `limit`),
 * through the handlers setupSocketHandlers registers: within the limit
 * every event reaches its handler, past it the usual serverError
 * {code:'rateLimit'} answers and the handler is not called, and a new
 * socket (every reconnect) starts fresh. Also the unknown-key warning.
 */

const fs = require('fs');
const path = require('path');
const rateLimiter = require('../rateLimiter');
const { socketLogger } = require('../../utils/logger');
const authHandlers = require('../authHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const profileHandlers = require('../profileHandlers');

const UUID = '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f';

let n = 0;
function connect() {
    const handlers = new Map();
    const socket = {
        id: `ev-${++n}`,
        data: {},
        handshake: { address: '203.0.113.4', headers: {} },
        emit: jest.fn(),
        join: jest.fn(),
        leave: jest.fn(),
        on: (event, fn) => handlers.set(event, fn),
    };
    const { setupSocketHandlers } = require('../index');
    setupSocketHandlers({ on: (ev, cb) => cb(socket) });
    socket.send = async (event, data) => {
        await handlers.get(event)(data);
        await new Promise((r) => setImmediate(r));
    };
    return socket;
}
const errors = (socket) => socket.emit.mock.calls.filter(([e]) => e === 'serverError').map(([, p]) => p);

// [event, payload, the handler module + function the wrapper calls (null: the real handler)]
const CASES = [
    ['restoreSession', { username: 'alan', sessionToken: UUID }, [authHandlers, 'restoreSession'], { max: 10, windowMs: 60000 }],
    ['rejoinGame', { gameId: UUID, username: 'alan' }, [reconnectHandlers, 'rejoinGame'], { max: 10, windowMs: 60000 }],
    ['joinLobby', { lobbyId: UUID }, [mainRoomHandlers, 'joinLobby'], { max: 20, windowMs: 30000 }],
    ['joinAsSpectator', { gameId: UUID }, [mainRoomHandlers, 'joinAsSpectator'], { max: 20, windowMs: 30000 }],
    ['updateProfilePic', { profilePic: 12 }, [profileHandlers, 'updateProfilePic'], { max: 30, windowMs: 60000 }],
    ['joinMainRoom', undefined, [mainRoomHandlers, 'joinMainRoom'], { max: 30, windowMs: 60000 }],
    ['playerReady', undefined, [lobbyHandlers, 'playerReady'], { max: 20, windowMs: 10000 }],
    ['playerUnready', undefined, [lobbyHandlers, 'playerUnready'], { max: 20, windowMs: 10000 }],
    ['leaveLobby', undefined, [lobbyHandlers, 'leaveLobby'], { max: 20, windowMs: 30000 }],
    ['addBot', { personality: 'mary' }, [lobbyHandlers, 'addBot'], { max: 20, windowMs: 30000 }],
];

beforeEach(() => {
    rateLimiter.requests.clear();
    jest.spyOn(socketLogger, 'warn').mockImplementation(() => {});
    jest.spyOn(socketLogger, 'debug').mockImplementation(() => {});
    jest.spyOn(socketLogger, 'info').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe.each(CASES)('%s', (event, payload, [mod, fn], limit) => {
    test(`allows ${limit.max} per ${limit.windowMs / 1000} s on one socket, then answers serverError rateLimit`, async () => {
        expect(rateLimiter.limits[event]).toEqual(limit);
        const handler = jest.spyOn(mod, fn).mockImplementation(() => undefined);
        const s = connect();
        for (let i = 0; i < limit.max; i++) await s.send(event, payload);
        expect(handler).toHaveBeenCalledTimes(limit.max);
        expect(errors(s)).toEqual([]);

        await s.send(event, payload);
        expect(handler).toHaveBeenCalledTimes(limit.max);
        expect(errors(s)).toEqual([{ code: 'rateLimit', message: 'Too many requests, please slow down', handler: event }]);
    });

    test('a reconnect (a new socket, same IP) is never refused because the old socket spent its budget', async () => {
        const handler = jest.spyOn(mod, fn).mockImplementation(() => undefined);
        const old = connect();
        for (let i = 0; i <= limit.max; i++) await old.send(event, payload);
        const fresh = connect();
        await fresh.send(event, payload);
        expect(errors(fresh)).toEqual([]);
        expect(handler).toHaveBeenCalledTimes(limit.max + 1);
    });

    test('the window slides: allowed again once it has passed', async () => {
        jest.spyOn(mod, fn).mockImplementation(() => undefined);
        let clock = 1.9e12;
        jest.spyOn(Date, 'now').mockImplementation(() => clock);
        const s = connect();
        for (let i = 0; i <= limit.max; i++) await s.send(event, payload);
        expect(errors(s)).toHaveLength(1);
        clock += limit.windowMs + 1;
        await s.send(event, payload);
        expect(errors(s)).toHaveLength(1);
    });
});

test('restoreSession on a flaky network: a burst of reconnects, each a new socket restoring at once, all go through', async () => {
    const handler = jest.spyOn(authHandlers, 'restoreSession').mockImplementation(() => undefined);
    for (let i = 0; i < 50; i++) {
        const s = connect();
        await s.send('restoreSession', { username: 'alan', sessionToken: UUID });
        expect(errors(s)).toEqual([]);
    }
    expect(handler).toHaveBeenCalledTimes(50);
});

describe('getProfile (no schema: checked in profileHandlers.getProfile)', () => {
    test('20 per 10 s answer profileResponse; the 21st gets serverError rateLimit and no profileResponse', async () => {
        expect(rateLimiter.limits.getProfile).toEqual({ max: 20, windowMs: 10000 });
        const s = connect(); // not signed in: the real handler answers 'User not found'
        for (let i = 0; i < 20; i++) await s.send('getProfile', { scope: 'all' });
        const replies = () => s.emit.mock.calls.filter(([e]) => e === 'profileResponse');
        expect(replies()).toHaveLength(20);
        expect(errors(s)).toEqual([]);
        await s.send('getProfile', {});
        expect(replies()).toHaveLength(20);
        expect(errors(s)).toEqual([{ code: 'rateLimit', message: 'Too many requests, please slow down', handler: 'getProfile' }]);
    });
});

describe('unknown limit keys', () => {
    const warned = () => socketLogger.warn.mock.calls.filter(([m]) => /has no limit/.test(m));

    test('outside production an event with no limit warns once per key, and is still allowed', () => {
        rateLimiter.warnedUnknown.clear();
        expect(rateLimiter.check('u-1', 'brandNewEvent')).toBe(true);
        expect(rateLimiter.check('u-2', 'brandNewEvent')).toBe(true);
        expect(rateLimiter.check('u-1', 'anotherNewEvent')).toBe(true);
        expect(warned().map(([, d]) => d.event)).toEqual(['brandNewEvent', 'anotherNewEvent']);
    });

    test('production: allowed and silent, as before', () => {
        rateLimiter.warnedUnknown.clear();
        const env = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            expect(rateLimiter.check('u-1', 'brandNewEvent')).toBe(true);
        } finally {
            process.env.NODE_ENV = env;
        }
        expect(warned()).toEqual([]);
    });

    test('every socket.on event in socket/index.js has a limit: its wrapper key, safeHandler\'s limit, or one checked in its handler; or it is listed as unlimited', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
        // Registered without a wrapper limit and checked inside the handler (each with its own over-limit reply)
        // The SFU requests share keys (sfuHandlers.OPS: sfuSession, sfuCall), answered sfuReply rate_limited
        const SFU_KEYS = Object.fromEntries(Object.values(require('../sfuHandlers').OPS).map((o) => [o.event, o.limitKey]));
        const IN_HANDLER = ['clientHello', 'clientError', 'getProfile', 'getLeaderboard', 'getRecords', 'voiceOffer', 'voiceAnswer', 'voiceIceCandidate', ...Object.keys(SFU_KEYS)];
        const regs = [...src.matchAll(/socket\.on\('([a-zA-Z]+)',[^\n]*\n\s*([^\n]*)/g)].map((m) => [m[1], m[2]]);
        expect(regs.length).toBeGreaterThan(50);
        const unlimitedNow = [];
        for (const [event, line] of regs) {
            if (event === 'disconnect') continue;
            const wrapped = /^(?:asyncHandler|syncHandler)\('([a-zA-Z]+)'/.exec(line);
            const safeLimit = /^safeHandler\([^)]*\{ limit: '([a-zA-Z]+)' \}\)/.exec(line);
            const key = (wrapped && !/rateLimit: false/.test(line) && wrapped[1]) || (safeLimit && safeLimit[1]) || null;
            const ok = key
                ? Boolean(rateLimiter.limits[key]) || rateLimiter.unlimited.has(key)
                // clientError counts per socket in socket.data and per IP / server-wide in buckets
                : IN_HANDLER.includes(event) && (Boolean(rateLimiter.limits[event]) || Boolean(rateLimiter.buckets[`${event}Ip`]) || Boolean(rateLimiter.limits[SFU_KEYS[event]]));
            if (!ok) unlimitedNow.push(event);
        }
        expect(unlimitedNow).toEqual([]);
        for (const event of IN_HANDLER) {
            expect({ event, registeredUnwrapped: regs.some(([e, l]) => e === event && (/^safeHandler\(/.test(l) || /rateLimit: false/.test(l))) })
                .toEqual({ event, registeredUnwrapped: true });
        }
    });

    test('every key a wrapper in socket/index.js checks has a limit or is listed as deliberately unlimited', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
        const keys = [...src.matchAll(/(?:asyncHandler|syncHandler)\('([a-zA-Z]+)'(?![^\n]*rateLimit: false)/g)].map((m) => m[1]);
        expect(keys.length).toBeGreaterThan(30);
        const missing = [...new Set(keys)].filter((k) => !rateLimiter.limits[k] && !rateLimiter.unlimited.has(k));
        expect(missing).toEqual([]);
        rateLimiter.warnedUnknown.clear();
        for (const k of rateLimiter.unlimited) rateLimiter.check('u-3', k);
        expect(warned()).toEqual([]);
    });
});
