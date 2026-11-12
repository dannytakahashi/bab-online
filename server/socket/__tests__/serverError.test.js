/**
 * contract/V1_REMOVALS.md #1 phase A (2026-11-11): every app-level `error`
 * is followed, on the same socket, by `serverError {code, message,
 * handler}`, and both copies carry the same handler (the c2s event), so a
 * client reading both channels (iOS 1.2's ServerErrorDeduper) drops the
 * second one. A refusal's `error` gains `handler` (variant rejected,
 * additive); the wrappers' error payloads are otherwise unchanged. Real
 * handlers and wrappers on stub io/sockets (contract guard on).
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
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const chatHandlers = require('../chatHandlers');
const gameHandlers = require('../gameHandlers');
const { asyncHandler, syncHandler, rateLimiter } = require('../errorHandler');
const { errorOf, serverErrorOf, CODES } = require('../serverError');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

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
/** [event, data] pairs this socket got, error and serverError only. */
const errorsTo = (s) => log.filter((l) => (l.to === `self:${s.id}` || l.to === s.id) && (l.event === 'error' || l.event === 'serverError'))
    .map((l) => [l.event, l.data]);

test('a handler refusal: error {message, handler}, then serverError {code: rejected, handler}', () => {
    const s = user('a');
    lobbyHandlers.addBot(s, io); // not in a lobby
    mainRoomHandlers.mainRoomChat(s, io, { message: 'x' }); // not in the main room
    expect(errorsTo(s)).toEqual([
        ['error', { message: 'Not in a lobby', handler: 'addBot' }],
        ['serverError', { code: 'rejected', message: 'Not in a lobby', handler: 'addBot' }],
        ['error', { message: 'Not in main room', handler: 'mainRoomChat' }],
        ['serverError', { code: 'rejected', message: 'Not in main room', handler: 'mainRoomChat' }],
    ]);
});

test('the wrappers: validation, rate limit and an unexpected exception keep their type as the code', async () => {
    const s = user('b');
    await asyncHandler('playerBid', gameHandlers.playerBid)(s, io, { bid: 'X' });
    const boom = syncHandler('joinLobby', () => { throw new Error('boom'); });
    boom(s, io, { lobbyId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f' });
    const createLobby = asyncHandler('createLobby', async () => {});
    for (let i = 0; i < 6; i++) await createLobby(s, io, {}); // limit 5 per minute
    const got = errorsTo(s);
    expect(got).toHaveLength(6);
    for (let i = 0; i < got.length; i += 2) {
        const [[e1, err], [e2, twin]] = [got[i], got[i + 1]];
        expect([e1, e2]).toEqual(['error', 'serverError']);
        expect(twin).toEqual({ code: err.type, message: err.message, handler: err.handler });
    }
    expect(got.filter(([e]) => e === 'serverError').map(([, d]) => [d.code, d.handler])).toEqual([
        ['validation', 'playerBid'], ['server', 'joinLobby'], ['rateLimit', 'createLobby'],
    ]);
    // no internal detail leaks into either
    expect(JSON.stringify(got)).not.toContain('boom');
});

test('a tournament refusal names its handler', async () => {
    const s = user('c');
    await tournamentHandlers.beginTournament(s, io);
    expect(errorsTo(s).map(([e, d]) => [e, d.handler || null, d.code || null])).toEqual([
        ['error', 'beginTournament', null], ['serverError', 'beginTournament', 'rejected'],
    ]);
});

test('a chat command error at the table also gets its twin (handler chatMessage)', () => {
    const ids = [1, 2, 3, 4].map((n) => `se${seq}-g${n}`);
    ids.forEach((id, i) => gameManager.registerUser(id, `se_g${i}${seq}`));
    const socks = ids.map((id) => makeSocket(id, log, io));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, `se_g${i}${seq}`, i + 1, 1, false));
    socks.forEach((x) => x.join(game.roomName));
    game.forcePhase('BIDDING');
    chatHandlers.chatMessage(socks[0], io, { message: '/active' }); // not in lazy mode
    expect(errorsTo(socks[0])).toEqual([
        ['error', { message: 'Not in lazy mode.', handler: 'chatMessage' }],
        ['serverError', { code: 'rejected', message: 'Not in lazy mode.', handler: 'chatMessage' }],
    ]);
});

test('serverErrorOf: the code enum, message and handler fallbacks', () => {
    expect(CODES).toEqual(['rateLimit', 'validation', 'server', 'rejected']);
    expect(serverErrorOf({ type: 'rateLimit', message: 'm', handler: 'h' })).toEqual({ code: 'rateLimit', message: 'm', handler: 'h' });
    expect(serverErrorOf({ type: 'weird', message: 'm' })).toEqual({ code: 'rejected', message: 'm', handler: null });
    expect(serverErrorOf({ message: 'm' }, 'joinLobby')).toEqual({ code: 'rejected', message: 'm', handler: 'joinLobby' });
    expect(serverErrorOf(undefined)).toEqual({ code: 'rejected', message: 'Something went wrong', handler: null });
    // errorOf: the caller's handler goes on the error copy too, never over the payload's own
    expect(errorOf({ message: 'm' }, 'addBot')).toEqual({ message: 'm', handler: 'addBot' });
    expect(errorOf({ type: 'rateLimit', message: 'm', handler: 'h' }, 'x')).toEqual({ type: 'rateLimit', message: 'm', handler: 'h' });
    expect(errorOf({ message: 'm' })).toEqual({ message: 'm' });
});

/**
 * iOS 1.2's ServerErrorDeduper.accept (ios/release-1.2,
 * Networking/SocketService.swift): the other channel's copy is dropped
 * when the handlers are equal and (with no handler) the messages are.
 */
function deduper() {
    let last = null;
    return (channel, d) => {
        const handler = typeof d.handler === 'string' ? d.handler : null;
        if (last && last.channel !== channel && last.handler === handler && (handler !== null || last.message === d.message)) {
            last = null;
            return false;
        }
        last = { channel, message: d.message, handler };
        return true;
    };
}
/** How many failures a client reading both channels would show. */
const shown = (pairs) => {
    const accept = deduper();
    return pairs.filter(([e, d]) => accept(e === 'error' ? 'error' : 'serverError', d)).length;
};

test('refusal pairs (error + serverError): the same handler on both, so a dual-channel client shows each once', async () => {
    const s = user('d');
    lobbyHandlers.addBot(s, io);
    lobbyHandlers.playerReady(s, io);
    mainRoomHandlers.mainRoomChat(s, io, { message: 'x' });
    await tournamentHandlers.beginTournament(s, io);
    await asyncHandler('playerBid', gameHandlers.playerBid)(s, io, { bid: 'X' }); // a wrapper pair
    const got = errorsTo(s);
    expect(got).toHaveLength(10);
    for (let i = 0; i < got.length; i += 2) {
        expect([got[i][0], got[i + 1][0]]).toEqual(['error', 'serverError']);
        expect(typeof got[i][1].handler).toBe('string');
        expect(got[i][1].handler).toBe(got[i + 1][1].handler);
    }
    expect(shown(got)).toBe(5);
    // the deduper model itself: a twin without a handler on one side is not deduped
    expect(shown([['error', { message: 'Lobby is full' }], ['serverError', { code: 'rejected', message: 'Lobby is full', handler: 'addBot' }]])).toBe(2);
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

test('every registered c2s event: error and serverError name that event on every wrapper path', async () => {
    const { listeners, arm, disarm, errors } = wiredSocket(`se${seq}-wired`);
    const events = [...listeners.keys()].filter((e) => e !== 'disconnect');
    expect(events).toEqual(expect.arrayContaining(['clientHello', 'mainRoomChat', 'lobbyChat', 'tournamentChat', 'chatMessage', 'addBot']));
    const bad = [];
    const check = (ev, path, { atLeastOne }) => {
        const got = errors();
        log.length = 0;
        if (atLeastOne && got.length === 0) bad.push(`${ev} ${path}: no error`);
        for (const [e, d] of got) if (d.handler !== ev) bad.push(`${ev} ${path}: ${e}.handler ${d.handler}`);
        if (shown(got) * 2 !== got.length) bad.push(`${ev} ${path}: not deduped`);
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
    // gets past its checks (the contract's first example: the voice relays
    // drop a bad one silently before reading the socket); clientHello: its
    // schema, which runs first
    const { schema } = require('../../../contract');
    for (const ev of events) {
        log.length = 0;
        if (ev === 'clientHello') await listeners.get(ev)('not an object');
        else {
            // voiceRelayAudio forwards only binary audio (a Buffer on the server)
            const data = ev === 'voiceRelayAudio' ? { targetSocketId: 's1', audio: Buffer.alloc(4) } : (schema.c2s[ev]?.examples?.[0] ?? {});
            arm();
            await listeners.get(ev)(data);
        }
        disarm();
        check(ev, 'exception', { atLeastOne: true });
    }
    expect(bad).toEqual([]);
});

test('no app-level error is emitted any other way (every site goes through emitError / sendError)', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..');
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        const lines = src.split('\n');
        lines.forEach((l, i) => {
            if (!/emit\('error'|sendToPlayer\([^)]*'error'/.test(l)) return;
            // the helper itself, chat's sendError (followed by its twin) and the dead withValidation
            if (f === 'serverError.js' || (f === 'chatHandlers.js' && /serverError/.test(lines[i + 1] || '')) || f === 'validators.js') return;
            offenders.push(`${f}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
});
