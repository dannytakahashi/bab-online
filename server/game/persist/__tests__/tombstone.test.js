/**
 * The terminal claim and the ENDED tombstone (deploy survival PR 4, the
 * plan's 2.3), LIVE_PERSIST write, real games over persistHarness's liveDb:
 *   - gameEnd turns the game's doc into the ENDED tombstone (kind 'ended',
 *     ended.record = the gameRecords doc) BEFORE its stats start, and the
 *     tombstone goes only once that record's insert is acknowledged;
 *   - a tournament table's tombstone also waits for a tournament write
 *     that lists it in completedGames;
 *   - a kill between the record's fire and its insert leaves the
 *     tombstone, and recording it later (what PR 5's adoption will do,
 *     twice here, racing) gives one gameRecords doc and the stats once;
 *   - abort: a casual game's doc is deleted, a tournament table becomes an
 *     `aborted` tombstone with no record until its tournament lists it;
 *   - write mode never fences at the end: a claim that fails or finds no
 *     doc still records the stats as today.
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const { makeIo, mulberry32 } = require('../../../testUtils/gameDriver');
const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const gameLifecycle = require('../../../socket/gameLifecycle');
const chatHandlers = require('../../../socket/chatHandlers');
const tournamentHandlers = require('../../../socket/tournamentHandlers');
const profileHandlers = require('../../../socket/profileHandlers');
const shutdown = require('../../../utils/shutdown');
const liveStore = require('../liveStore');
const { setupTournament, liveTables } = require('../../../testUtils/tournamentDriver');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

let realRandom;
let io;
let log;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(5);
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    log = [];
    io = makeIo(log);
});

afterEach(() => {
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    gameManager._resetForTests();
    botController._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    shutdown._resetShutdownStateForTests({ abandonRetries: true });
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const install = (opts = {}) => kit.installStore(mockDb, { getIo: () => io, ...opts });
const plain = kit.plain;
const records = () => db().gameRecords.docs;
const withoutId = ({ _id, ...rest }) => rest;

/** Every human at the table goes /lazy: the bots play their seats to the end. */
async function lazy(sockets) {
    for (const s of sockets) await chatHandlers.chatMessage(s, io, { message: '/lazy' });
}

/** A table with Hal (lazy) and 3 bots, dealt and saved. */
async function halsGame(store) {
    const ctx = await kit.startGame(io, log, { humans: ['Hal'] });
    await lazy(ctx.sockets);
    await h.flushStore(store);
    expect(kit.savedGame(db(), ctx.game.gameId)).toMatchObject({ kind: 'live' });
    return ctx;
}

const playToEnd = (game) => kit.advanceUntil(() => game.isTerminal(), { step: 1000, cap: 3 * 3600000 });

describe('gameEnd', () => {
    test('the ENDED tombstone holds the record and is written before the stats start; it goes once the insert is acknowledged', async () => {
        const store = install();
        const order = [];
        const liveUpdate = db().liveGames.updateOne;
        db().liveGames.updateOne = (filter, update, ...rest) => {
            if (update?.$set?.kind === 'ended') order.push('claim');
            return liveUpdate(filter, update, ...rest);
        };
        const recordFind = db().gameRecords.findOne;
        db().gameRecords.findOne = (...args) => {
            order.push('stats');
            return recordFind(...args);
        };
        const { game } = await halsGame(store);
        // The record's insert stalls: the tombstone must stay meanwhile
        db().faults.stall({ collections: 'gameRecords', ops: 'insertOne' });
        await playToEnd(game);
        await h.flushStore(store);
        expect(game.stage).toBe(Phase.ENDED);
        expect(order[0]).toBe('claim');
        expect(order).toContain('stats');
        const tomb = kit.savedGame(db(), game.gameId);
        expect(tomb).toMatchObject({ kind: 'ended', owner: 'boot-A', released: false });
        expect(tomb.ended).toMatchObject({
            score: plain(game.score), tournamentId: null, aborted: false,
            seats: [1, 2, 3, 4].map((position) => expect.objectContaining({ position })),
        });
        expect(tomb.ended.record).toMatchObject({ gameId: game.gameId, withBots: true, statsPending: [{ position: expect.any(Number), username: 'Hal' }] });
        // The live state stays as last written (the claim only adds kind and ended)
        expect(tomb.state).toBeTruthy();
        expect(records()).toHaveLength(0);

        db().faults.release();
        await h.flushStore(store);
        await jest.advanceTimersByTimeAsync(0);
        await h.flushStore(store);
        expect(records()).toHaveLength(1);
        // One record, the one the tombstone held
        expect(plain(withoutId(records()[0]))).toEqual(plain({ ...tomb.ended.record, statsPending: undefined }));
        expect(kit.savedGame(db(), game.gameId)).toBeNull();
        expect(store.health().docsOwned).toBe(0);
    }, 60000);

    test('a game with no human owner (nothing to record): the tombstone goes at once', async () => {
        const store = install();
        const { game } = await kit.startGame(io, log, { humans: [] });
        await h.flushStore(store);
        await playToEnd(game);
        await h.flushStore(store);
        expect(records()).toHaveLength(0);
        expect(kit.savedGame(db(), game.gameId)).toBeNull();
        expect(db().faults.calls.filter((c) => c.collection === 'liveGames' && c.op === 'deleteOne')).toHaveLength(1);
    }, 60000);

    test('the insert failing for good: the tombstone stays (it expires by TTL, or an adopter records it)', async () => {
        const store = install();
        profileHandlers._setStatsRetryDelaysForTests([10, 10]);
        try {
            const { game } = await halsGame(store);
            db().faults.fail({ collections: 'gameRecords', ops: 'insertOne' });
            await playToEnd(game);
            await jest.advanceTimersByTimeAsync(1000);
            await h.flushStore(store);
            expect(records()).toHaveLength(0);
            expect(kit.savedGame(db(), game.gameId)).toMatchObject({ kind: 'ended' });
        } finally {
            profileHandlers._setStatsRetryDelaysForTests();
        }
    }, 60000);

    test('a kill between the record firing and its insert: the tombstone survives, and recording it later (twice, racing) inserts one record and credits once', async () => {
        const store = install();
        const { game } = await halsGame(store);
        db().faults.stall({ collections: 'gameRecords', ops: 'insertOne' });
        await playToEnd(game);
        await h.flushStore(store);
        const tomb = plain(kit.savedGame(db(), game.gameId));
        expect(tomb.kind).toBe('ended');
        // SIGKILL: the insert on the wire never arrives, the process's
        // chains and retries are gone (persistHarness.killInstance's resets)
        expect(db().faults.abandon()).toBe(1);
        db().faults.clear();
        profileHandlers._resetStatsWritesForTests();
        shutdown._resetShutdownStateForTests({ abandonRetries: true });
        liveStore._resetForTests();
        expect(records()).toHaveLength(0);
        const before = plain(db().users.docs.find((u) => u.username === 'Hal').botStats || {});
        expect(before.gamesPlayed || 0).toBe(0);

        // What the adoption of an ENDED tombstone does (PR 5): record it.
        // Two adopters at once: the unique gameId index keeps it to one
        const replay = (n) => profileHandlers.recordGameStats({ gameId: `${tomb._id}` }, { record: tomb.ended.record })
            .then(() => n);
        await Promise.all([replay(1), (profileHandlers._resetStatsWritesForTests(), replay(2))]);
        await jest.advanceTimersByTimeAsync(0);
        expect(records()).toHaveLength(1);
        expect(records()[0].gameId).toBe(game.gameId);
        const hal = db().users.docs.find((u) => u.username === 'Hal');
        expect(hal.botStats.gamesPlayed).toBe(1);
        expect(hal.statsGames.filter((e) => e.id === game.gameId)).toHaveLength(1);
        expect(records()[0].statsPending).toBeUndefined();
    }, 60000);

    test('write mode never fences at the end: a claim that cannot be written still records the stats', async () => {
        const store = install();
        const { game } = await halsGame(store);
        db().faults.fail({ collections: 'liveGames', ops: 'updateOne' });
        await playToEnd(game);
        await h.flushStore(store);
        await jest.advanceTimersByTimeAsync(0);
        expect(records()).toHaveLength(1);
        expect(db().users.docs.find((u) => u.username === 'Hal').botStats.gamesPlayed).toBe(1);
        expect(log.filter((l) => l.event === 'lobbiesUpdated' && l.at >= log.find((x) => x.event === 'gameEnd').at).length).toBeGreaterThan(0);
    }, 60000);

    test('a claim that finds the doc gone answers error, never fenced (write mode)', async () => {
        const store = install();
        const { game } = await halsGame(store);
        db().liveGames.docs.length = 0;
        game.terminate(null, Phase.ABORTED);
        gameManager._retire(game, null);
        expect(store.claimable(game)).toBe(true);
        await expect(store.claimEnded(game, { tournamentId: 'T-x' })).resolves.toBe('error');
    });
});

describe('abort', () => {
    test("a casual game's doc is deleted", async () => {
        const store = install();
        const { game } = await halsGame(store);
        await gameLifecycle.abortGame(io, game, 'test');
        await h.flushStore(store);
        expect(kit.savedGame(db(), game.gameId)).toBeNull();
        expect(records()).toHaveLength(0);
    });

    test('a pre-deal abort writes nothing and awaits nothing', async () => {
        const store = install();
        const { game } = await kit.startGame(io, log, { humans: ['Hal'], until: () => true });
        expect(store.claimable(game)).toBe(false);
        await gameLifecycle.abortGame(io, game, 'test');
        await h.flushStore(store);
        expect(db().faults.calls.filter((c) => c.collection === 'liveGames')).toEqual([]);
    });
});

describe('tournament tables', () => {
    async function dealtRound(store, n = 4) {
        const ctx = await setupTournament(n, { io, log });
        const starting = tournamentHandlers.beginTournament(ctx.sockets[0], io);
        await kit.advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.stage === Phase.BIDDING));
        await starting;
        await h.flushStore(store);
        const tables = liveTables(ctx.t);
        for (const g of tables) expect(kit.savedGame(db(), g.gameId)).toMatchObject({ kind: 'live', tournamentId: ctx.t.tournamentId });
        return { ...ctx, tables };
    }

    test('an ended table keeps its tombstone until a tournament write listing it in completedGames is acknowledged', async () => {
        const store = install();
        const ctx = await dealtRound(store);
        const [table] = ctx.tables;
        db().faults.stall({ collections: 'liveTournaments', ops: 'updateOne' });
        await lazy(ctx.sockets);
        await playToEnd(table);
        await jest.advanceTimersByTimeAsync(0);
        await kit.advanceUntil(() => records().length === 1, { step: 10, cap: 5000 });
        // The record is in, but the tournament's doc does not list the table yet
        expect(kit.savedGame(db(), table.gameId)).toMatchObject({ kind: 'ended', ended: { tournamentId: ctx.t.tournamentId, aborted: false } });
        expect(ctx.t.rounds[0].completedGames.has(table.gameId)).toBe(true);
        db().faults.release();
        await h.flushStore(store);
        const tdoc = kit.savedTournament(db(), ctx.t.tournamentId);
        expect(tdoc.state.rounds[0].completedGames).toContain(table.gameId);
        expect(kit.savedGame(db(), table.gameId)).toBeNull();
    }, 60000);

    test('an aborted table becomes an aborted tombstone with no record, deleted once the tournament lists it', async () => {
        const store = install();
        const ctx = await dealtRound(store, 8);
        expect(ctx.tables).toHaveLength(2);
        const [table] = ctx.tables;
        db().faults.stall({ collections: 'liveTournaments', ops: 'updateOne' });
        await gameLifecycle.abortGame(io, table, 'test');
        await h.flushStore(store).catch(() => {});
        expect(kit.savedGame(db(), table.gameId)).toMatchObject({ kind: 'ended', ended: { aborted: true, record: null, tournamentId: ctx.t.tournamentId } });
        db().faults.release();
        await h.flushStore(store);
        expect(kit.savedGame(db(), table.gameId)).toBeNull();
        expect(records()).toHaveLength(0);
    }, 60000);

    test('a cancelled tournament: its tables (unmapped first) are deleted, and so is its doc', async () => {
        const store = install();
        const ctx = await dealtRound(store);
        await tournamentHandlers.cancelTournament(ctx.sockets.find((s) => s.id === ctx.t.createdBy), io);
        await jest.advanceTimersByTimeAsync(0);
        await h.flushStore(store);
        expect(kit.savedTournament(db(), ctx.t.tournamentId)).toBeNull();
        for (const g of ctx.tables) expect(kit.savedGame(db(), g.gameId)).toBeNull();
        expect(db().liveGames.docs).toEqual([]);
    }, 60000);
});
