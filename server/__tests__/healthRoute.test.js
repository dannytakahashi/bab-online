/**
 * GET /health (server/routes/health.js): always 200 and cheap, with the DB
 * state from the driver (no round trip) and live counts for a deploy
 * decision. The endpoint is public: counts only, never a username or id.
 * GET /ready stays the readiness check (503 without a DB).
 */

const http = require('http');
const express = require('express');

const mockDbState = { value: 'disconnected', db: null };
jest.mock('../database', () => ({
    ...jest.requireActual('../database'),
    getDbState: () => mockDbState.value,
    getDB: () => mockDbState.db,
}));

const routes = require('../routes');
const { setHealthIo, healthBody } = require('../routes/health');
const gameManager = require('../game/GameManager');

let server;
let base;

beforeAll(async () => {
    const app = express();
    app.use('/', routes);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    setHealthIo(null);
    await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
    gameManager.games.clear();
    gameManager.tournaments.clear();
    gameManager.lobbies.clear();
    mockDbState.value = 'disconnected';
    mockDbState.db = null;
    jest.restoreAllMocks();
});

async function get(path) {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
}

/** A GameState stand-in with just what getHealthCounts reads. */
function fakeGame(id, { owners = [], entrants = null, isDemo = false, terminal = false } = {}) {
    return {
        gameId: id,
        isDemo,
        isTerminal: () => terminal,
        seatList: () => owners.map((ownerUsername, i) => ({ position: i + 1, ownerUsername })),
        entrants: entrants && new Map(entrants.map((e, i) => [`s${i}`, e])),
    };
}

test('shape: 200 with status, db and live counts, nothing that names anyone', async () => {
    const sockets = new Map([['a', {}], ['b', {}], ['c', {}]]);
    setHealthIo({ of: (ns) => { expect(ns).toBe('/'); return { sockets }; } });
    mockDbState.value = 'connected';

    gameManager.games.set('g-human', fakeGame('g-human', { owners: ['Alice', null, null, null] }));
    gameManager.games.set('g-lazy', fakeGame('g-lazy', { owners: [null, 'Bob', null, null] }));
    gameManager.games.set('g-draw', fakeGame('g-draw', { entrants: [{ username: 'Cy', isBot: false }, { username: 'Mary', isBot: true }] }));
    gameManager.games.set('g-bots', fakeGame('g-bots', { owners: [null, null, null, null] }));
    gameManager.games.set('g-demo', fakeGame('g-demo', { owners: [null, null, null, null], isDemo: true }));
    gameManager.games.set('g-ended', fakeGame('g-ended', { owners: ['Dee', null, null, null], terminal: true }));
    gameManager.tournaments.set('t1', { phase: 'round_active', players: new Map() });
    gameManager.tournaments.set('t2', { phase: 'lobby', players: new Map() });
    gameManager.tournaments.set('t3', { phase: 'complete', players: new Map() });
    gameManager.lobbies.set('l1', { players: [{ username: 'Eve' }] });

    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['assist', 'db', 'live', 'memory', 'persist', 'status', 'timestamp', 'uptime']);
    expect(body.status).toBe('ok');
    // /help counts since boot (assistHandlers.assistHealth): numbers only
    expect(Object.keys(body.assist).sort()).toEqual(['answered', 'errors', 'quick']);
    expect(Object.values(body.assist).every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
    expect(body.db).toBe('connected');
    expect(body.live).toEqual({ sockets: 3, games: 3, tournaments: 2, lobbies: 1 });
    expect(body.memory).toMatchObject({ unit: 'MB' });
    expect(typeof body.uptime).toBe('number');
    const text = JSON.stringify(body);
    for (const leak of ['Alice', 'Bob', 'Cy', 'Dee', 'Eve', 'g-human', 't1', 'l1']) expect(text).not.toContain(leak);
});

test('no DB: /health still 200 with db "disconnected"; /ready is 503', async () => {
    setHealthIo(null);
    const health = await get('/health');
    expect(health.status).toBe(200);
    expect(health.body.db).toBe('disconnected');
    expect(health.body.live).toEqual({ sockets: 0, games: 0, tournaments: 0, lobbies: 0 });

    const ready = await get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.checks.database).toBe('failed');
});

test("/ready: 200 once the DB answers a ping; the first 200 is logged once, with its time (deploy measurement)", async () => {
    const { logger } = require('../utils/logger');
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    // Today's /ready, whatever LIVE_PERSIST this run has (an 'on' store not
    // started would answer 503 sweeping: the describe below)
    const liveStore = require('../game/persist/liveStore');
    liveStore._setForTests(liveStore.createLiveStore({ mode: 'off', getCollections: () => ({}) }));
    mockDbState.db = { admin: () => ({ ping: async () => ({ ok: 1 }) }) };
    const first = await get('/ready');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: 'ready', checks: { database: 'ok' } });
    await get('/ready');
    mockDbState.db = null;
    expect((await get('/ready')).status).toBe(503);
    const lines = info.mock.calls.filter(([msg]) => msg === 'Ready: first 200');
    expect(lines).toHaveLength(1);
    expect(lines[0][1].at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    liveStore._resetForTests();
});

test('a count that throws never fails /health: that count is null', async () => {
    setHealthIo({ of: () => { throw new Error('io gone'); } });
    jest.spyOn(gameManager, 'getHealthCounts').mockImplementation(() => { throw new Error('broken'); });
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(body.live).toEqual({ sockets: null, games: null, tournaments: null, lobbies: null });
});

test('healthBody takes its sources as arguments', () => {
    const body = healthBody({
        io: { of: () => ({ sockets: new Map([['x', {}]]) }) },
        gameManager: { getHealthCounts: () => ({ games: 7, tournaments: 1, lobbies: 2 }) },
        dbState: () => 'connected',
    });
    expect(body).toMatchObject({ status: 'ok', db: 'connected', live: { sockets: 1, games: 7, tournaments: 1, lobbies: 2 } });
});

test('real GameState entrants: a human entrant counts before seating, bot entrants only do not', () => {
    const GameState = require('../game/GameState');
    const entrant = (socketId, username, isBot) => ({ socketId, username, isBot });
    const human = new GameState('hc-human');
    human.initEntrants([entrant('h1', 'Hal', false), entrant('bot:Mary:1', 'Mary', true), entrant('bot:Ann:2', 'Ann', true), entrant('bot:Tom:3', 'Tom', true)]);
    const bots = new GameState('hc-bots');
    bots.initEntrants([entrant('bot:Mary:4', 'Mary', true), entrant('bot:Ann:5', 'Ann', true), entrant('bot:Tom:6', 'Tom', true), entrant('bot:Sal:7', 'Sal', true)]);
    gameManager.games.set(human.gameId, human);
    gameManager.games.set(bots.gameId, bots);
    expect(gameManager.getHealthCounts().games).toBe(1);
});

describe('persist block (deploy survival: LIVE_PERSIST and the unique gameId index)', () => {
    const liveStore = require('../game/persist/liveStore');
    const database = require('../database');
    const KEYS = ['adopted', 'bootSwept', 'docsOwned', 'effectiveMode', 'lastSweepAt', 'mode', 'uniqueGameIdIndex'];

    afterEach(() => liveStore._resetForTests());

    test.each([
        ['off', 'off'],
        ['write', 'write'],
        // 'on' without the unique gameId index (null: not probed yet) runs as 'write'
        ['on', 'write'],
    ])('LIVE_PERSIST=%s: mode and effectiveMode %s, counts only, no instance id', async (mode, effectiveMode) => {
        const store = liveStore.createLiveStore({
            mode, bootId: 'boot-id-not-shown', getCollections: () => ({}),
            gameIdIndexUnique: () => database.getGameIdIndexUnique(),
            logger: { info() {}, warn() {} },
        });
        liveStore._setForTests(store);
        const { status, body } = await get('/health');
        expect(status).toBe(200);
        expect(Object.keys(body.persist).sort()).toEqual(KEYS);
        expect(body.persist).toEqual({
            mode, effectiveMode, uniqueGameIdIndex: null, docsOwned: 0, adopted: 0, lastSweepAt: null, bootSwept: false,
        });
        expect(JSON.stringify(body)).not.toContain('boot-id-not-shown');
    });

    test('uniqueGameIdIndex is what the startup probe read from gameRecords', async () => {
        liveStore._setForTests(liveStore.createLiveStore({ mode: 'off', getCollections: () => ({}) }));
        const unique = { indexes: async () => [{ key: { _id: 1 }, name: '_id_' }, { key: { gameId: 1 }, name: 'gameId_1', unique: true }] };
        const fallback = { indexes: async () => [{ key: { gameId: 1 }, name: 'gameId_nonunique' }] };
        await expect(database.probeGameIdIndex(unique)).resolves.toBe(true);
        await expect(database.probeGameIdIndex(fallback)).resolves.toBe(false);
        await expect(database.probeGameIdIndex({ indexes: async () => { throw new Error('down'); } })).resolves.toBe(null);
        const spy = jest.spyOn(database, 'getGameIdIndexUnique');
        spy.mockReturnValue(false);
        expect((await get('/health')).body.persist.uniqueGameIdIndex).toBe(false);
        spy.mockReturnValue(true);
        expect((await get('/health')).body.persist.uniqueGameIdIndex).toBe(true);
    });

    test("'on': effectiveMode 'on' only with the unique gameId index (else 'write'); after the boot sweep adopted, lastSweepAt, bootSwept", async () => {
        const h = require('../testUtils/persistHarness');
        const db = h.liveDb();
        for (const [unique, effective] of [[false, 'write'], [null, 'write'], [true, 'on']]) {
            const store = liveStore.createLiveStore({
                mode: 'on', bootId: 'boot-on', getCollections: () => db, gameIdIndexUnique: () => unique,
                logger: { info() {}, warn() {} }
            });
            liveStore._setForTests(store);
            await store.start();
            await store.whenBootSwept();
            const { body } = await get('/health');
            expect(body.persist).toMatchObject({ mode: 'on', effectiveMode: effective, uniqueGameIdIndex: unique });
            if (effective === 'on') {
                expect(body.persist).toMatchObject({ adopted: 0, bootSwept: true, lastSweepAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
            } else {
                expect(body.persist).toMatchObject({ bootSwept: false, lastSweepAt: null });
            }
            store.close();
        }
    });

    test('a store that throws never fails /health: persist is null', async () => {
        liveStore._setForTests({ health: () => { throw new Error('broken'); }, install() {}, close() {} });
        const { status, body } = await get('/health');
        expect(status).toBe(200);
        expect(body.persist).toBeNull();
    });
});

describe("/ready with LIVE_PERSIST=on (deploy survival PR 5): 503 until the boot sweep's first pass, 200 by 20 s", () => {
    const liveStore = require('../game/persist/liveStore');
    const h = require('../testUtils/persistHarness');

    afterEach(() => liveStore._resetForTests());

    function onStore(db, { mono }) {
        const warns = [];
        const store = liveStore.createLiveStore({
            mode: 'on', bootId: 'boot-ready', getCollections: () => db, gameIdIndexUnique: () => true,
            monoNow: () => mono.t, logger: { info() {}, warn: (msg) => warns.push(msg) }
        });
        store.warns = warns;
        liveStore._setForTests(store);
        return store;
    }

    test('sweeping: 503 {database ok, liveGames sweeping}; 200 once swept; never waits on a live owner\'s doc', async () => {
        mockDbState.db = { admin: () => ({ ping: async () => ({ ok: 1 }) }) };
        jest.spyOn(require('../utils/logger').logger, 'info').mockImplementation(() => {});
        const db = h.liveDb();
        // A live owner's unreleased doc: pending, never waited on
        db.serverInstances._insert({ _id: 'boot-live', mode: 'on', startedAt: new Date(), beatAt: new Date(), beatSeq: 1 });
        db.liveGames._insert({ _id: 'g-live', owner: 'boot-live', ownerMode: 'on', kind: 'live', released: false, rev: 1, v: 3 });
        const release = db.faults.stall({ collections: 'liveGames', ops: 'find' });
        const mono = { t: 0 };
        const store = onStore(db, { mono });
        // Before start: not ready either
        expect((await get('/ready')).status).toBe(503);
        await store.start();
        const sweeping = await get('/ready');
        expect(sweeping.status).toBe(503);
        expect(sweeping.body).toEqual({ status: 'not ready', checks: { database: 'ok', liveGames: 'sweeping' } });
        release();
        await store.whenBootSwept();
        const ready = await get('/ready');
        expect(ready.status).toBe(200);
        expect(ready.body).toEqual({ status: 'ready', checks: { database: 'ok' } });
        expect(db.liveGames.docs.find((d) => d._id === 'g-live')).toMatchObject({ owner: 'boot-live', released: false });
        store.close();
    });

    test('a boot sweep that never finishes: 503 until 20 s after start, then 200 with one log line', async () => {
        mockDbState.db = { admin: () => ({ ping: async () => ({ ok: 1 }) }) };
        jest.spyOn(require('../utils/logger').logger, 'info').mockImplementation(() => {});
        const db = h.liveDb();
        db.faults.stall({ collections: 'liveGames', ops: 'find' });
        const mono = { t: 1000 };
        const store = onStore(db, { mono });
        await store.start();
        mono.t += liveStore.BOOT_SWEEP_CAP_MS - 1;
        expect((await get('/ready')).status).toBe(503);
        mono.t += 1;
        expect((await get('/ready')).status).toBe(200);
        expect((await get('/ready')).status).toBe(200);
        expect(liveStore.BOOT_SWEEP_CAP_MS).toBe(20000);
        expect(store.warns.filter((m) => /Ready without the boot sweep/.test(m))).toHaveLength(1);
        store.close();
        db.faults.release();
    });

    test('write and off: /ready is today\'s (no sweep to wait for)', async () => {
        mockDbState.db = { admin: () => ({ ping: async () => ({ ok: 1 }) }) };
        jest.spyOn(require('../utils/logger').logger, 'info').mockImplementation(() => {});
        for (const mode of ['off', 'write']) {
            liveStore._setForTests(liveStore.createLiveStore({ mode, getCollections: () => ({}), logger: { info() {}, warn() {} } }));
            expect((await get('/ready')).status).toBe(200);
        }
    });
});
