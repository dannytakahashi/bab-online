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

beforeEach(() => {
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
    const { client, collections } = fakeClient({ failIndex: (name) => name === 'gameRecords' });
    mockConnect.mockResolvedValueOnce(client);
    await database.connectDB();
    expect(dbLogger.error).not.toHaveBeenCalled();
    expect(dbLogger.warn).toHaveBeenCalledTimes(1);
    expect(dbLogger.warn.mock.calls[0][0]).toMatch(/gameRecords\.completedAt_-1/);
    expect(collections.reports.createIndex).toHaveBeenCalledWith({ createdAt: -1 }, {});
    expect(collections.users.createIndex).toHaveBeenCalledWith({ username: 1 }, { unique: true });
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
