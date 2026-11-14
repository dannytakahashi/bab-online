/**
 * contract/V1_REMOVALS.md #1: every app-level server error reaches the
 * socket as `serverError {code, message, handler}` ONLY. Phase A
 * (2026-11-11) sent it as the twin of the v1 `error`; phase B (2026-11-12,
 * once iOS 1.1.0 was gated) dropped `error`, validators.withValidation and
 * the error event's variants (validation, handler, message, rejected).
 * handler is the c2s event on every path. Real handlers and wrappers on
 * stub io/sockets (contract guard on).
 */

const fs = require('fs');
const path = require('path');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const gameManager = require('../../game/GameManager');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const chatHandlers = require('../chatHandlers');
const gameHandlers = require('../gameHandlers');
const { asyncHandler, syncHandler, rateLimiter } = require('../errorHandler');
const serverError = require('../serverError');
const { serverErrorOf, CODES } = serverError;
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const ROOT = path.join(__dirname, '..', '..', '..');

let seq = 0;
let log;
let io;

beforeEach(() => {
    seq++;
    log = [];
    io = makeIo(log);
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn', 'error']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.currentUsers = [];
    jest.restoreAllMocks();
});
afterAll(() => rateLimiter.shutdown());

function user(tag) {
    const s = makeSocket(`se${seq}-${tag}`, log, io);
    gameManager.registerUser(s.id, `se_${tag}${seq}`);
    rateLimiter.clearSocket(s.id);
    return s;
}
/** [event, data] pairs this socket got, error and serverError only (error must never appear). */
const errorsTo = (s) => log.filter((l) => (l.to === `self:${s.id}` || l.to === s.id) && (l.event === 'error' || l.event === 'serverError'))
    .map((l) => [l.event, l.data]);

test('a handler refusal: serverError {code: rejected, message, handler} and no error', () => {
    const s = user('a');
    lobbyHandlers.addBot(s, io); // not in a lobby
    mainRoomHandlers.mainRoomChat(s, io, { message: 'x' }); // not in the main room
    expect(errorsTo(s)).toEqual([
        ['serverError', { code: 'rejected', message: 'Not in a lobby', handler: 'addBot' }],
        ['serverError', { code: 'rejected', message: 'Not in main room', handler: 'mainRoomChat' }],
    ]);
});

test('the wrappers: validation, rate limit and an unexpected exception are one serverError each, coded by their kind', async () => {
    const s = user('b');
    await asyncHandler('playerBid', gameHandlers.playerBid)(s, io, { bid: 'X' });
    const boom = syncHandler('joinLobby', () => { throw new Error('boom'); });
    boom(s, io, { lobbyId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' });
    const createLobby = asyncHandler('createLobby', async () => {});
    for (let i = 0; i < 6; i++) await createLobby(s, io, {}); // limit 5 per minute
    const got = errorsTo(s);
    expect(got.map(([e, d]) => [e, d.code, d.handler])).toEqual([
        ['serverError', 'validation', 'playerBid'], ['serverError', 'server', 'joinLobby'], ['serverError', 'rateLimit', 'createLobby'],
    ]);
    expect(got[1][1].message).toBe('An error occurred processing your request');
    expect(got[2][1].message).toBe('Too many requests, please slow down');
    // no internal detail leaks
    expect(JSON.stringify(got)).not.toContain('boom');
});

test('a tournament refusal names its handler', async () => {
    const s = user('c');
    await tournamentHandlers.beginTournament(s, io);
    expect(errorsTo(s).map(([e, d]) => [e, d.handler, d.code])).toEqual([['serverError', 'beginTournament', 'rejected']]);
});

test('a chat command error at the table: serverError only (handler chatMessage)', () => {
    const ids = [1, 2, 3, 4].map((n) => `se${seq}-g${n}`);
    ids.forEach((id, i) => gameManager.registerUser(id, `se_g${i}${seq}`));
    const socks = ids.map((id) => makeSocket(id, log, io));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, `se_g${i}${seq}`, i + 1, 1, false));
    socks.forEach((x) => x.join(game.roomName));
    game.forcePhase('BIDDING');
    chatHandlers.chatMessage(socks[0], io, { message: '/active' }); // not in lazy mode
    expect(errorsTo(socks[0])).toEqual([
        ['serverError', { code: 'rejected', message: 'Not in lazy mode.', handler: 'chatMessage' }],
    ]);
});

test('serverErrorOf: the code enum, message and handler fallbacks; the v1 helpers are gone', () => {
    expect(CODES).toEqual(['rateLimit', 'validation', 'server', 'rejected']);
    expect(serverErrorOf({ type: 'rateLimit', message: 'm', handler: 'h' })).toEqual({ code: 'rateLimit', message: 'm', handler: 'h' });
    expect(serverErrorOf({ type: 'weird', message: 'm' })).toEqual({ code: 'rejected', message: 'm', handler: null });
    expect(serverErrorOf({ message: 'm' }, 'joinLobby')).toEqual({ code: 'rejected', message: 'm', handler: 'joinLobby' });
    expect(serverErrorOf(undefined)).toEqual({ code: 'rejected', message: 'Something went wrong', handler: null });
    expect(Object.keys(serverError).sort()).toEqual(['CODES', 'emitError', 'serverErrorOf']);
    expect(require('../validators')).not.toHaveProperty('withValidation');
});

/** A socket wired through the real setupSocketHandlers registrations. */
function wiredSocket(id) {
    const listeners = new Map();
    let armed = false;
    const socket = {
        get id() {
            // armed: the first read throws (an unexpected exception inside whatever runs first)
            if (armed) { armed = false; throw new Error('boom'); }
            return id;
        },
        data: {}, rooms: new Set(),
        on: (ev, fn) => listeners.set(ev, fn),
        emit: (event, data) => log.push({ to: `self:${id}`, event, data }),
        join: () => {}, leave: () => {}, to: () => ({ emit: () => {} }),
    };
    const { setupSocketHandlers } = require('../index');
    setupSocketHandlers({ on: (ev, cb) => cb(socket) });
    return { listeners, arm: () => { armed = true; }, disarm: () => { armed = false; }, errors: () => errorsTo({ id }) };
}

test('every registered c2s event: one serverError naming that event on every wrapper path, never error', async () => {
    const { listeners, arm, disarm, errors } = wiredSocket(`se${seq}-wired`);
    const events = [...listeners.keys()].filter((e) => e !== 'disconnect');
    expect(events).toEqual(expect.arrayContaining(['clientHello', 'mainRoomChat', 'lobbyChat', 'tournamentChat', 'chatMessage', 'addBot']));
    const bad = [];
    const check = (ev, path, { atLeastOne }) => {
        const got = errors();
        log.length = 0;
        if (atLeastOne && got.length === 0) bad.push(`${ev} ${path}: no serverError`);
        for (const [e, d] of got) {
            if (e !== 'serverError') bad.push(`${ev} ${path}: sent ${e}`);
            if (d.handler !== ev) bad.push(`${ev} ${path}: ${e}.handler ${d.handler}`);
            if (!CODES.includes(d.code)) bad.push(`${ev} ${path}: code ${d.code}`);
        }
    };
    const rateKeys = [];
    // 1. rate limit (every rate-limited registration)
    const spy = jest.spyOn(rateLimiter, 'check').mockImplementation((sid, key) => { rateKeys.push(key); return false; });
    for (const ev of events) {
        log.length = 0;
        await listeners.get(ev)({});
        check(ev, 'rateLimit', { atLeastOne: false });
    }
    spy.mockRestore();
    // the chat events still share the chatMessage bucket
    expect(rateKeys.filter((k) => k === 'chatMessage')).toHaveLength(4);
    // 2. an unexpected exception, every registration, with a payload that
    // gets past its checks (the contract's first example); clientHello: its
    // schema, which runs first
    const { schema } = require('../../../contract');
    for (const ev of events) {
        log.length = 0;
        if (ev === 'clientHello') await listeners.get(ev)('not an object');
        else {
            const data = schema.c2s[ev]?.examples?.[0] ?? {};
            arm();
            await listeners.get(ev)(data);
        }
        disarm();
        check(ev, 'exception', { atLeastOne: true });
    }
    expect(bad).toEqual([]);
});

test('no server file emits the app-level error any more, and withValidation is gone', () => {
    const offenders = [];
    const walk = (dir) => {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, f.name);
            if (f.isDirectory()) { if (f.name !== '__tests__' && f.name !== 'testUtils') walk(p); continue; }
            if (!f.name.endsWith('.js')) continue;
            fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
                if (/emit\(\s*['"]error['"]|sendToPlayer\([^)]*['"]error['"]|\bwithValidation\b/.test(l)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}`);
            });
        }
    };
    walk(path.join(ROOT, 'server'));
    expect(offenders).toEqual([]);
});

test('the contract and the generated constants: no s2c error (baseline too), serverError stays', () => {
    const { schema } = require('../../../contract');
    const baseline = require('../../../contract/v1-baseline.schema.json');
    expect(schema.s2c).not.toHaveProperty('error');
    expect(baseline.s2c).not.toHaveProperty('error');
    expect(schema.s2c.serverError.status).toBe('active');
    expect(schema.s2c.serverError.emittedFrom).toEqual(['server/socket/serverError.js:emitError', 'server/socket/chatHandlers.js:sendError']);
    const web = fs.readFileSync(path.join(ROOT, 'client/src/constants/events.js'), 'utf8');
    expect(web).not.toMatch(/\n {2}ERROR: 'error',\n/);
    expect(web).toMatch(/\n {2}SERVER_ERROR: 'serverError',\n/);
    const swift = fs.readFileSync(path.join(ROOT, 'iOSClient/BABOnline/Constants/SocketEvents.swift'), 'utf8');
    expect(swift).not.toMatch(/static let error = "error"/);
    expect(swift).toMatch(/static let serverError = "serverError"/);
    const layout = require('../../../contract/layout.json');
    expect(layout.exclude.swift).not.toHaveProperty('error');
});
