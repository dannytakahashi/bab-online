/**
 * connectDB: retry with backoff until Mongo answers, readiness for the auth
 * handlers, and per-index warn-and-continue (an index failure is never
 * reported as a connection failure). MongoClient is mocked: nothing connects.
 */

const mockConnect = jest.fn();
jest.mock('mongodb', () => ({
    ...jest.requireActual('mongodb'),
    MongoClient: { connect: (...args) => mockConnect(...args) }
}));

function fakeClient({ failIndex = null } = {}) {
    const collections = {};
    const collection = (name) => {
        collections[name] ??= {
            name,
            createIndex: jest.fn(async (keys) => {
                if (failIndex && failIndex(name, keys)) {
                    throw Object.assign(new Error(`cannot build ${name}`), { code: 67 });
                }
                return 'ok';
            })
        };
        return collections[name];
    };
    return { client: { db: jest.fn(() => ({ collection })) }, collections };
}

let database;
let dbLogger;
let savedEnv;

// The runner's own MONGO_URI / DB_NAME must not leak in: CI's URI ends in
// /test, which (rightly) adds the "path names another database" warning
// to every connect. Each test starts from a URI with no path.
const PATHLESS_URI = 'mongodb://127.0.0.1:27017';

function loadDatabase() {
    jest.resetModules();
    database = require('../database');
    dbLogger = require('../utils/logger').dbLogger;
    jest.spyOn(dbLogger, 'error').mockImplementation(() => {});
    jest.spyOn(dbLogger, 'warn').mockImplementation(() => {});
    jest.spyOn(dbLogger, 'info').mockImplementation(() => {});
}

beforeEach(() => {
    savedEnv = { MONGO_URI: process.env.MONGO_URI, DB_NAME: process.env.DB_NAME };
    process.env.MONGO_URI = PATHLESS_URI;
    delete process.env.DB_NAME;
    jest.resetModules();
    jest.useFakeTimers();
    mockConnect.mockReset();
    database = require('../database');
    dbLogger = require('../utils/logger').dbLogger;
    jest.spyOn(dbLogger, 'error').mockImplementation(() => {});
    jest.spyOn(dbLogger, 'warn').mockImplementation(() => {});
    jest.spyOn(dbLogger, 'info').mockImplementation(() => {});
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

test('a MONGO_URI path naming another database is one warning (CI\'s /test); the same name or no path is none', async () => {
    jest.restoreAllMocks();
    process.env.MONGO_URI = `${PATHLESS_URI}/test`;
    loadDatabase();
    mockConnect.mockResolvedValueOnce(fakeClient().client);
    await database.connectDB();
    const uriWarnings = () => dbLogger.warn.mock.calls.filter(c => /MONGO_URI path/.test(c[0]));
    expect(uriWarnings()).toHaveLength(1);
    expect(uriWarnings()[0][1]).toEqual({ uriDatabase: 'test', database: 'babonline' });

    jest.restoreAllMocks();
    process.env.MONGO_URI = `${PATHLESS_URI}/babonline`;
    loadDatabase();
    mockConnect.mockResolvedValueOnce(fakeClient().client);
    await database.connectDB();
    expect(uriWarnings()).toHaveLength(0);
});

test('retries with backoff (2 s, 4 s, ...) and becomes ready on the first successful connect', async () => {
    const { client, collections } = fakeClient();
    mockConnect
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(client);

    let connected = false;
    const done = database.connectDB().then(() => { connected = true; });
    const ready = database.whenReady(60000);

    await jest.advanceTimersByTimeAsync(1999);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(3999);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(connected).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await done;

    expect(mockConnect).toHaveBeenCalledTimes(3);
    await expect(ready).resolves.toBe(true);
    expect(database.getUsersCollection()).toBe(collections.users);
    expect(dbLogger.error).toHaveBeenCalledTimes(2);
    expect(dbLogger.error.mock.calls.map(c => c[1].retryInMs)).toEqual([2000, 4000]);
    expect(collections.users.createIndex).toHaveBeenCalledWith({ username: 1 }, { unique: true });
});

test('the backoff is capped at 30 s', async () => {
    mockConnect.mockRejectedValue(new Error('down'));
    database.connectDB();
    await jest.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 16000 + 30000 + 30000);
    expect(dbLogger.error.mock.calls.map(c => c[1].retryInMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    const ready = database.whenReady(10);
    await jest.advanceTimersByTimeAsync(10);
    await expect(ready).resolves.toBe(false);
});

test('an index that cannot be built is a warning, the others still build, and connectDB resolves', async () => {
    const { client, collections } = fakeClient({ failIndex: (name, keys) => name === 'gameRecords' && 'completedAt' in keys });
    mockConnect.mockResolvedValueOnce(client);
    await database.connectDB();
    expect(dbLogger.error).not.toHaveBeenCalled();
    expect(dbLogger.warn).toHaveBeenCalledTimes(1);
    expect(dbLogger.warn.mock.calls[0][0]).toMatch(/gameRecords\.completedAt_-1/);
    expect(collections.reports.createIndex).toHaveBeenCalledWith({ createdAt: -1 }, {});
    expect(collections.users.createIndex).toHaveBeenCalledWith({ username: 1 }, { unique: true });
    // the same collection's other indexes still build
    expect(collections.gameRecords.createIndex).toHaveBeenCalledWith({ gameId: 1 }, { partialFilterExpression: { gameId: { $exists: true } }, unique: true });
    await expect(database.whenReady(10)).resolves.toBe(true);
});

test('every connect attempt passes serverSelectionTimeoutMS 5000 (driver default 30 s)', async () => {
    const { client } = fakeClient();
    mockConnect.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(client);
    const done = database.connectDB();
    await jest.advanceTimersByTimeAsync(2000);
    await done;
    expect(database.SERVER_SELECTION_TIMEOUT_MS).toBe(5000);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    for (const [, options] of mockConnect.mock.calls) {
        expect(options).toEqual({ serverSelectionTimeoutMS: 5000 });
    }
});

test("getDbState follows the driver's topology events, no round trip", async () => {
    const { client } = fakeClient();
    const listeners = {};
    client.on = jest.fn((event, fn) => { listeners[event] = fn; });
    mockConnect.mockResolvedValueOnce(client);
    expect(database.getDbState()).toBe('disconnected');
    await database.connectDB();
    expect(database.getDbState()).toBe('connected');

    const change = (...servers) => listeners.topologyDescriptionChanged({
        newDescription: { servers: new Map(servers.map((s, i) => [`h${i}:27017`, s])) },
    });
    change({ type: 'Unknown', isWritable: false });
    expect(database.getDbState()).toBe('disconnected');
    expect(dbLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/unreachable/));
    change({ type: 'RSSecondary', isWritable: false }, { type: 'RSPrimary', isWritable: true });
    expect(database.getDbState()).toBe('connected');
    expect(dbLogger.info).toHaveBeenCalledWith('MongoDB reachable again');
});

describe('deploy survival collections (liveGames, liveTournaments, serverInstances)', () => {
    const optionsOf = (coll) => coll.createIndex.mock.calls.map(([keys, options]) => [keys, options]);

    test('connectDB assigns them and ensureIndexes builds their indexes and TTLs', async () => {
        const { client, collections } = fakeClient();
        mockConnect.mockResolvedValueOnce(client);
        await database.connectDB();
        expect(database.getLiveGamesCollection()).toBe(collections.liveGames);
        expect(database.getLiveTournamentsCollection()).toBe(collections.liveTournaments);
        expect(database.getServerInstancesCollection()).toBe(collections.serverInstances);
        const docIndexes = [
            [{ released: 1 }, {}],
            [{ owner: 1 }, {}],
            // A doc lives at most a day: expireAt is its game's createdAt + 24 h
            [{ expireAt: 1 }, { expireAfterSeconds: 0 }],
        ];
        expect(optionsOf(collections.liveGames)).toEqual(docIndexes);
        expect(optionsOf(collections.liveTournaments)).toEqual([...docIndexes, [{ 'state.players.username': 1 }, {}]]);
        expect(optionsOf(collections.serverInstances)).toEqual([[{ beatAt: 1 }, { expireAfterSeconds: 86400 }]]);
        expect(dbLogger.warn).not.toHaveBeenCalled();
    });

    test('the backup/restore excludes (dbBackup.LIVE_COLLECTIONS) name exactly the live collections connectDB opens', async () => {
        const { client, collections } = fakeClient();
        mockConnect.mockResolvedValueOnce(client);
        await database.connectDB();
        const live = [database.getLiveGamesCollection(), database.getLiveTournamentsCollection(), database.getServerInstancesCollection()]
            .map((c) => c.name);
        const { LIVE_COLLECTIONS } = require('../admin/dbBackup');
        expect([...LIVE_COLLECTIONS].sort()).toEqual([...live].sort());
        // Every other collection connectDB opens is backed up: a new live-state
        // collection must be added to LIVE_COLLECTIONS (and the privacy policy)
        expect(Object.keys(collections).filter((n) => !LIVE_COLLECTIONS.includes(n)).sort())
            .toEqual(['adminAudit', 'gameRecords', 'passwordResets', 'reports', 'users']);
    });

    test('a caller that passes no live collection (restore-db.js) builds none of them, with no warning', async () => {
        const { client, collections } = fakeClient();
        const c = client.db().collection;
        const results = await database.ensureIndexes({
            users: c('users'), gameRecords: c('gameRecords'), reports: c('reports'), passwordResets: c('passwordResets'), adminAudit: c('adminAudit'),
        });
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        expect(collections.liveGames).toBeUndefined();
        expect(collections.liveTournaments).toBeUndefined();
        expect(collections.serverInstances).toBeUndefined();
        expect(dbLogger.warn).not.toHaveBeenCalled();
    });

    test.each([
        ['the unique index', true, [{ key: { _id: 1 }, name: '_id_' }, { key: { gameId: 1 }, name: 'gameId_1', unique: true }]],
        ['the non-unique fallback', false, [{ key: { _id: 1 }, name: '_id_' }, { key: { gameId: 1 }, name: 'gameId_nonunique' }]],
        ['a compound unique index is not it', false, [{ key: { gameId: 1, x: 1 }, name: 'gameId_1_x_1', unique: true }]],
    ])('getGameIdIndexUnique: %s -> %s (the /health precondition for LIVE_PERSIST=on)', async (_label, expected, indexes) => {
        const { client, collections } = fakeClient();
        client.db().collection('gameRecords').indexes = jest.fn(async () => indexes);
        collections.gameRecords.dropIndex = jest.fn(async () => {});
        expect(database.getGameIdIndexUnique()).toBeNull();
        mockConnect.mockResolvedValueOnce(client);
        await database.connectDB();
        expect(database.getGameIdIndexUnique()).toBe(expected);
    });

    test('gameRecords that cannot list its indexes: unknown (null), no warning', async () => {
        const { client } = fakeClient();
        mockConnect.mockResolvedValueOnce(client);
        await database.connectDB();
        expect(database.getGameIdIndexUnique()).toBeNull();
        expect(dbLogger.warn).not.toHaveBeenCalled();
    });
});
