/**
 * The live persist store against a REAL mongod (CI's mongo:6 service, or a
 * local one; deploy survival PR 4): the startup indexes and TTL options of
 * liveGames / liveTournaments / serverInstances, the unique gameId probe,
 * a fenced update's matchedCount 0 on the real driver, E11000 on a
 * re-sent insert, the BSON round trip of a played game (hydrate reads it
 * back), the doc size with a full log, write latency, and the tombstone
 * recorded once under a racing replay (the real unique index).
 *
 * Uses a scratch database bab_jest_persist_<pid>_<ts>, dropped in afterAll.
 * Never touches 'babonline' (connectDB is never called). Localhost only;
 * with no reachable mongod every test returns early and passes, unless
 * REQUIRE_REAL_MONGO=1 (CI), where that fails the file.
 */

// Read before anything loads dotenv (server/database.js does)
const ENV_URI = process.env.MONGO_URI;
const REQUIRED = process.env.REQUIRE_REAL_MONGO === '1';

const { MongoClient, BSON } = require('mongodb');

const mockHolder = { current: null };
jest.mock('../../../database', () => {
    const actual = jest.requireActual('../../../database');
    const coll = (name) => () => mockHolder.current?.[name] ?? null;
    return {
        ...actual,
        getDB: () => null,
        getUsersCollection: coll('users'),
        getGameRecordsCollection: coll('gameRecords'),
        getReportsCollection: coll('reports'),
        getLiveGamesCollection: coll('liveGames'),
        getLiveTournamentsCollection: coll('liveTournaments'),
        getServerInstancesCollection: coll('serverInstances'),
        whenReady: async () => true,
    };
});

const database = jest.requireActual('../../../database');
const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const { makeIo, mulberry32 } = require('../../../testUtils/gameDriver');
const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const gameCodec = require('../gameCodec');
const liveStore = require('../liveStore');
const profileHandlers = require('../../../socket/profileHandlers');
const chatHandlers = require('../../../socket/chatHandlers');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

function baseUri() {
    if (!ENV_URI) return null;
    const m = /^(mongodb:\/\/[^/?]+)/.exec(ENV_URI);
    return m ? m[1] : null;
}

function isLocal(uri) {
    return /^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(uri || '');
}

let client = null;
let rawDb = null;
const dbName = `bab_jest_persist_${process.pid}_${Date.now()}`;
const NAMES = ['users', 'gameRecords', 'reports', 'liveGames', 'liveTournaments', 'serverInstances'];

beforeAll(async () => {
    const base = baseUri();
    if (!isLocal(base)) {
        if (REQUIRED) throw new Error('liveStore.realMongo: REQUIRE_REAL_MONGO=1 but MONGO_URI is not a localhost mongod');
        console.info('liveStore.realMongo: MONGO_URI is not a localhost mongod, skipping');
        return;
    }
    expect(dbName).not.toBe('babonline');
    try {
        client = await new MongoClient(base, { serverSelectionTimeoutMS: 1500 }).connect();
        rawDb = client.db(dbName);
    } catch (e) {
        client = null;
        if (REQUIRED) throw new Error(`liveStore.realMongo: REQUIRE_REAL_MONGO=1 but no mongod at ${base}: ${e.message}`);
        console.info('liveStore.realMongo: no mongod, skipping');
    }
}, 20000);

afterAll(async () => {
    if (!client) return;
    try {
        await rawDb.dropDatabase();
    } finally {
        await client.close();
    }
});

let realRandom;
let io;
let log;

beforeEach(async () => {
    realRandom = Math.random;
    Math.random = mulberry32(19);
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    log = [];
    io = makeIo(log);
    if (!client) return;
    for (const name of NAMES) await rawDb.collection(name).drop().catch(() => {});
    mockHolder.current = Object.fromEntries(NAMES.map((n) => [n, rawDb.collection(n)]));
    // The memoryDb-shaped helpers the kit uses to seed users
    mockHolder.current.users.docs = [];
    mockHolder.current.users._insert = () => {};
    await database.ensureIndexes({ ...mockHolder.current, passwordResets: undefined, adminAudit: undefined });
});

afterEach(() => {
    liveStore._resetForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const coll = (name) => mockHolder.current[name];
// Real I/O: wait on real immediates (never faked here) until the store is idle
const ioTurn = () => new Promise((r) => setImmediate(r));
const settle = async (store) => {
    for (let i = 0; i < 2000 && store.pending() > 0; i++) {
        if (h.fakeTimersOn()) await jest.advanceTimersByTimeAsync(0);
        await ioTurn();
    }
    expect(store.pending()).toBe(0);
};
const savedDoc = (id) => coll('liveGames').findOne({ _id: id });

/**
 * A real table (bots, plus `humans`) dealt on fake game timers (real
 * immediates and I/O for the driver), then back on real timers unless
 * `keepFake`.
 */
async function dealt(store, humans = [], { keepFake = false } = {}) {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const ctx = await kit.startGame(io, log, { humans });
    await settle(store);
    if (!keepFake) jest.useRealTimers();
    return ctx;
}

test('indexes: owner, released, the expireAt TTL (0 s), member lookup, the instance TTL (1 day); the unique gameId probe', async () => {
    if (!client) return;
    const keysOf = async (name) => (await coll(name).indexes()).map((i) => ({ key: i.key, ...(i.expireAfterSeconds !== undefined && { ttl: i.expireAfterSeconds }) }));
    expect(await keysOf('liveGames')).toEqual(expect.arrayContaining([
        { key: { released: 1 } }, { key: { owner: 1 } }, { key: { expireAt: 1 }, ttl: 0 },
    ]));
    expect(await keysOf('liveTournaments')).toEqual(expect.arrayContaining([
        { key: { released: 1 } }, { key: { owner: 1 } }, { key: { expireAt: 1 }, ttl: 0 }, { key: { 'state.players.username': 1 } },
    ]));
    expect(await keysOf('serverInstances')).toEqual(expect.arrayContaining([{ key: { beatAt: 1 }, ttl: 86400 }]));
    await expect(database.probeGameIdIndex(coll('gameRecords'))).resolves.toBe(true);
    await coll('gameRecords').dropIndex('gameId_1');
    await coll('gameRecords').createIndex({ gameId: 1 }, { name: 'gameId_nonunique' });
    await expect(database.probeGameIdIndex(coll('gameRecords'))).resolves.toBe(false);
});

test('a played game: insert, then updates; the BSON round trip equals serialize(game) and hydrates; a full log stays under 64 KB; latency', async () => {
    if (!client) return;
    const store = kit.installStore(mockHolder, { getIo: () => io });
    const { game } = await dealt(store);
    const t0 = Date.now();
    const latencies = [];
    const updateOne = coll('liveGames').updateOne.bind(coll('liveGames'));
    jest.spyOn(coll('liveGames'), 'updateOne').mockImplementation(async (...args) => {
        const s = Date.now();
        try {
            return await updateOne(...args);
        } finally {
            latencies.push(Date.now() - s);
        }
    });
    for (let i = 0; i < 520; i++) {
        // Game-sized lines (a bid, a trick, a score)
        game.addLogEntry(`🤖 Mary bids ${i % 13}`, (i % 4) + 1, 'bid');
        if (i % 20 === 0) await settle(store);
    }
    await settle(store);
    const doc = await savedDoc(game.gameId);
    expect(kit.comparable(doc)).toEqual(kit.comparable(gameCodec.serialize(game)));
    expect(doc.log).toHaveLength(500);
    expect(doc.expireAt).toBeInstanceOf(Date);
    expect(doc.expireAt.getTime() - doc.createdAt.getTime()).toBe(24 * 3600000);
    const size = BSON.calculateObjectSize(doc);
    expect(size).toBeLessThan(64 * 1024);
    // hydrate reads the stored doc back (the codec's own fields)
    const { game: back } = gameCodec.hydrate({ v: doc.v, gameId: doc._id, stage: doc.stage, tournamentId: doc.tournamentId, state: doc.state, log: doc.log, logTotal: doc.logTotal, bots: doc.bots });
    expect(back.validateGameState().errors).toEqual([]);
    back._cancelAllTimers();
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
    console.info(`liveStore.realMongo: ${latencies.length} updates, p50 ${latencies[Math.floor(latencies.length / 2)]} ms, p99 ${p99} ms, doc ${size} B, ${Date.now() - t0} ms total`);
    expect(p99).toBeLessThan(250);
});

test('the real driver: a fenced update matches 0 and a re-sent insert is E11000 (what the store branches on); another owner fences the store', async () => {
    if (!client) return;
    // fenceOnLoss: PR 5's 'on' (write mode stops persisting instead: liveStore.test)
    const store = kit.installStore(mockHolder, { getIo: () => io, fenceOnLoss: true });
    const { game, sockets } = await dealt(store, ['Hal']);
    const res = await coll('liveGames').updateOne({ _id: game.gameId, owner: 'boot-Z', released: false }, { $set: { x: 1 } });
    expect(res.matchedCount).toBe(0);
    const err = await coll('liveGames').insertOne({ _id: game.gameId }).catch((e) => e);
    expect(err.code).toBe(11000);

    await coll('liveGames').updateOne({ _id: game.gameId }, { $set: { owner: 'boot-B' } });
    game.addLogEntry('after the takeover', null, 'system');
    await settle(store);
    expect(game.frozen).toBe(true);
    expect(sockets[0].conn.close).toHaveBeenCalledTimes(1);
    expect(await savedDoc(game.gameId)).toMatchObject({ owner: 'boot-B' });
});

test('the tombstone on the real unique index: a racing replay records it once', async () => {
    if (!client) return;
    const store = kit.installStore(mockHolder, { getIo: () => io });
    await coll('users').insertOne({ username: 'Hal', profilePic: 3 });
    const { game, sockets } = await dealt(store, ['Hal'], { keepFake: true });
    await chatHandlers.chatMessage(sockets[0], io, { message: '/lazy' });
    for (let i = 0; i < 3 * 3600 && !game.isTerminal(); i++) {
        await jest.advanceTimersByTimeAsync(1000);
        await ioTurn();
    }
    expect(game.stage).toBe(Phase.ENDED);
    for (let i = 0; i < 2000 && (await coll('gameRecords').countDocuments({ gameId: game.gameId })) === 0; i++) {
        await jest.advanceTimersByTimeAsync(10);
        await ioTurn();
    }
    await settle(store);
    jest.useRealTimers();
    expect(await coll('gameRecords').countDocuments({ gameId: game.gameId })).toBe(1);
    expect(await savedDoc(game.gameId)).toBeNull();
    const record = await coll('gameRecords').findOne({ gameId: game.gameId });
    const { _id, ...replayed } = record;
    profileHandlers._resetStatsWritesForTests();
    await Promise.all([
        profileHandlers.recordGameStats({ gameId: game.gameId }, { record: { ...replayed } }),
        (profileHandlers._resetStatsWritesForTests(), profileHandlers.recordGameStats({ gameId: game.gameId }, { record: { ...replayed } })),
    ]);
    expect(await coll('gameRecords').countDocuments({ gameId: game.gameId })).toBe(1);
    expect((await coll('users').findOne({ username: 'Hal' })).botStats.gamesPlayed).toBe(1);
}, 60000);

test('the instance doc: insert, a beat that upserts after a lost doc, TTL field beatAt is a Date', async () => {
    if (!client) return;
    const store = kit.installStore(mockHolder, { getIo: () => io, deploymentId: 'dep-real' });
    await store.start({ io });
    expect(await coll('serverInstances').findOne({ _id: 'boot-A' })).toMatchObject({ mode: 'write', deploymentId: 'dep-real', beatSeq: 0 });
    await coll('serverInstances').deleteMany({});
    await new Promise((r) => setTimeout(r, liveStore.HEARTBEAT_MS + 200));
    const doc = await coll('serverInstances').findOne({ _id: 'boot-A' });
    expect(doc).toMatchObject({ mode: 'write', beatSeq: 1, shuttingDown: false });
    expect(doc.beatAt).toBeInstanceOf(Date);
    const out = await store.shutdown();
    expect(out.timedOut).toBe(false);
    expect((await coll('serverInstances').findOne({ _id: 'boot-A' })).shuttingDown).toBe(true);
}, 20000);

