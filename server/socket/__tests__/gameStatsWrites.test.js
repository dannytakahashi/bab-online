/**
 * End-of-game writes (profileHandlers.recordGameStats): the record first
 * with its deltas and pending players, each player's guarded $inc, then the
 * pending list cleared. Failing writes (memoryDb with injected failures and
 * lost replies) are retried and never counted twice; a replay or the
 * startup sweep (resumePendingGameStats) adds nothing already applied; a
 * graceful shutdown waits for writes in flight. The real driver's unique
 * gameId index is in realMongo.test.js.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports
}));

const gameManager = require('../../game/GameManager');
const profile = require('../profileHandlers');
const shutdownMod = require('../../utils/shutdown');
const { authLogger, logger } = require('../../utils/logger');

const users = () => mockDb.current.users;
const guardIds = (name) => (users().docs.find(d => d.username === name).statsGames || []).map(g => g.id);
const records = () => mockDb.current.gameRecords;
const statsOf = (name, bucket = 'stats') => users().docs.find(d => d.username === name)?.[bucket] || {};

/** A finished human game: Ann/Cat (team 1) beat Ben/Dan. */
function finishedGame({ gameId = 'g-1', bots = [] } = {}) {
    const humans = { 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' };
    const seats = [1, 2, 3, 4].map(pos => bots.includes(pos)
        ? { position: pos, controller: 'bot', ownerUsername: null }
        : { position: pos, controller: 'human', ownerUsername: humans[pos] });
    return {
        gameId,
        score: { team1: 420, team2: 150 },
        seatList: () => seats,
        seat: (pos) => seats[pos - 1],
        getOriginalPlayer: (pos) => ({ username: bots.includes(pos) ? `🤖 Bot${pos}` : humans[pos] }),
        handStats: { totalHands: 13, team1Sets: 1, team2Sets: 3, team1SetPoints: 20, team2SetPoints: 90 },
        playerStats: {
            1: { totalBids: 5, totalTricks: 6, setsCaused: 0, totalHSI: 300, totalBags: 2 },
            2: { totalBids: 4, totalTricks: 3, setsCaused: 2, totalHSI: 250 },
            3: { totalBids: 2, totalTricks: 2, setsCaused: 1, totalHSI: 200 },
            4: { totalBids: 3, totalTricks: 2, setsCaused: 1, totalHSI: 150 }
        }
    };
}

let warns;
let errors;

beforeEach(() => {
    gameManager.deletedUsernames.clear();
    shutdownMod._resetShutdownStateForTests();
    profile._resetCachesForTests();
    profile._setStatsRetryDelaysForTests([1, 1, 1, 1, 1]);
    mockDb.current = createMemoryDb({
        users: ['Ann', 'Ben', 'Cat', 'Dan'].map(username => ({ username }))
    });
    warns = [];
    errors = [];
    jest.spyOn(authLogger, 'warn').mockImplementation((msg, meta) => warns.push({ msg, meta }));
    jest.spyOn(authLogger, 'error').mockImplementation((msg, meta) => errors.push({ msg, meta }));
    jest.spyOn(authLogger, 'info').mockImplementation(() => {});
    jest.spyOn(authLogger, 'debug').mockImplementation(() => {});
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    profile._setStatsRetryDelaysForTests();
    shutdownMod._resetShutdownStateForTests();
});

/** The first `n` calls of `method` on `collection` fail (before touching the data). */
function failFirst(collection, method, n, error = new Error('connection reset')) {
    const real = collection[method].bind(collection);
    let left = n;
    return jest.spyOn(collection, method).mockImplementation(async (...args) => {
        if (left-- > 0) throw error;
        return real(...args);
    });
}

/** The first `n` calls of `method` succeed but their reply is lost (the write is done). */
function loseReplies(collection, method, n) {
    const real = collection[method].bind(collection);
    let left = n;
    return jest.spyOn(collection, method).mockImplementation(async (...args) => {
        const out = await real(...args);
        if (left-- > 0) throw new Error('socket closed before the reply');
        return out;
    });
}

const EXPECTED_ANN = {
    gamesPlayed: 1, wins: 1, losses: 0, draws: 0, totalPoints: 420, totalTricksBid: 5, totalTricksTaken: 6,
    totalHands: 13, totalSets: 1, totalSetPoints: 20, totalFaults: 0, totalHSI: 300
};
// The record's delta is exactly the bucket's 12 counters; the superlatives'
// per-seat bags sit beside it (statsDeltas.bags), never $inc'd into a bucket
const EXPECTED_ANN_DELTA = EXPECTED_ANN;

describe('one game, no failures', () => {
    test('one record with the deltas by position and no pending list; each player counted once and guarded by the game id', async () => {
        await profile.recordGameStats(finishedGame());
        expect(records().docs).toHaveLength(1);
        const rec = records().docs[0];
        expect(rec.statsPending).toBeUndefined();
        expect(rec.statsDeltas.bucket).toBe('stats');
        expect(Object.keys(rec.statsDeltas.byPosition).sort()).toEqual(['1', '2', '3', '4']);
        expect(rec.statsDeltas.byPosition[1]).toEqual(EXPECTED_ANN_DELTA);
        // Usernames only in the durable seat names (superlatives), never in the deltas
        const { names, ...deltas } = rec.statsDeltas;
        expect(names).toEqual({ 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' });
        // bags only for a seat whose game counted them (this fake game: seat 1 only)
        expect(rec.statsDeltas.bags).toEqual({ 1: 2 });
        expect(JSON.stringify(deltas)).not.toMatch(/Ann|Ben|Cat|Dan/);
        expect(statsOf('Ann')).toEqual(EXPECTED_ANN);
        expect(statsOf('Ben')).toMatchObject({ gamesPlayed: 1, wins: 0, losses: 1, totalPoints: 150, totalFaults: 2 });
        for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) {
            expect(guardIds(name)).toEqual(['g-1']);
        }
        expect(warns).toEqual([]);
        expect(errors).toEqual([]);
    });

    test('a bot game goes to botStats, the deltas say so', async () => {
        await profile.recordGameStats(finishedGame({ bots: [2, 4] }));
        expect(records().docs[0]).toMatchObject({ withBots: true, statsDeltas: { bucket: 'botStats' } });
        expect(Object.keys(records().docs[0].statsDeltas.byPosition).sort()).toEqual(['1', '3']);
        expect(statsOf('Ann', 'botStats').gamesPlayed).toBe(1);
        expect(statsOf('Ann')).toEqual({});
        expect(statsOf('Ben', 'botStats')).toEqual({});
    });

    test('the per-user guard keeps the last STATS_GAMES_KEPT game ids', async () => {
        for (let i = 0; i < profile.STATS_GAMES_KEPT + 3; i++) {
            await profile.recordGameStats(finishedGame({ gameId: `g-${i}` }));
        }
        const ann = users().docs.find(d => d.username === 'Ann');
        expect(ann.stats.gamesPlayed).toBe(profile.STATS_GAMES_KEPT + 3);
        expect(ann.statsGames).toHaveLength(profile.STATS_GAMES_KEPT);
        expect(ann.statsGames[ann.statsGames.length - 1]).toMatchObject({ id: `g-${profile.STATS_GAMES_KEPT + 2}`, at: expect.any(Date) });
    });

    test('a player who deleted their account mid-game: no name in the record, nobody credited for them', async () => {
        gameManager.deletedUsernames.add('Ben');
        users().docs = users().docs.filter(d => d.username !== 'Ben');
        const insert = jest.spyOn(records(), 'insertOne');
        await profile.recordGameStats(finishedGame());
        const inserted = insert.mock.calls[0][0];
        expect(inserted.team2Players).toEqual(['[deleted]', 'Dan']);
        expect(inserted.statsPending.map(e => e.username)).toEqual(['Ann', 'Cat', 'Dan']);
        expect(JSON.stringify(records().docs[0])).not.toMatch(/Ben/);
    });
});

describe('replays never count twice', () => {
    test('the same game recorded again (sequentially): one record, every counter once', async () => {
        await profile.recordGameStats(finishedGame());
        await profile.recordGameStats(finishedGame());
        expect(records().docs).toHaveLength(1);
        expect(statsOf('Ann')).toEqual(EXPECTED_ANN);
    });

    test('two calls at once share one chain', async () => {
        const game = finishedGame();
        const a = profile.recordGameStats(game);
        const b = profile.recordGameStats(game);
        expect(b).toBe(a);
        await Promise.all([a, b]);
        expect(records().docs).toHaveLength(1);
        expect(statsOf('Ann').gamesPlayed).toBe(1);
    });

    test('an insert that lost E11000 to another writer reuses the stored record (and its pending list)', async () => {
        // Another process already wrote the record and applied Ann only
        await profile.recordGameStats(finishedGame());
        records().docs[0].statsPending = [{ position: 2, username: 'Ben' }];
        jest.spyOn(records(), 'findOne').mockResolvedValueOnce(null); // the look-first misses it
        const insert = jest.spyOn(records(), 'insertOne').mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
        await profile.recordGameStats(finishedGame());
        expect(insert).toHaveBeenCalledTimes(1);
        expect(records().docs).toHaveLength(1);
        expect(records().docs[0].statsPending).toBeUndefined();
        // Ben's guard already held g-1: nothing new anywhere
        expect(statsOf('Ann').gamesPlayed).toBe(1);
        expect(statsOf('Ben').gamesPlayed).toBe(1);
    });
});

describe('failing writes are retried, never double counted', () => {
    test('the record insert fails twice: retried with backoff, one record, stats once', async () => {
        const insert = failFirst(records(), 'insertOne', 2);
        await profile.recordGameStats(finishedGame());
        expect(insert).toHaveBeenCalledTimes(3);
        expect(records().docs).toHaveLength(1);
        expect(statsOf('Ann')).toEqual(EXPECTED_ANN);
        expect(warns.filter(w => w.msg === 'End-of-game write failed; retrying').map(w => w.meta.step)).toEqual(['record', 'record']);
    });

    test('an insert whose reply is lost: the retry finds the stored record, no second insert', async () => {
        const insert = loseReplies(records(), 'insertOne', 1);
        await profile.recordGameStats(finishedGame());
        expect(insert).toHaveBeenCalledTimes(1);
        expect(records().docs).toHaveLength(1);
        expect(records().docs[0].statsPending).toBeUndefined();
        expect(statsOf('Ann')).toEqual(EXPECTED_ANN);
    });

    test('a stats $inc whose reply is lost is retried and still counts once (the guard)', async () => {
        const update = loseReplies(users(), 'updateOne', 2);
        await profile.recordGameStats(finishedGame());
        expect(update).toHaveBeenCalledTimes(6);
        for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) expect(statsOf(name).gamesPlayed).toBe(1);
        expect(records().docs[0].statsPending).toBeUndefined();
    });

    test('a $inc that fails on every attempt: the others apply, the record keeps only that player pending; the sweep finishes it once', async () => {
        const real = users().updateOne.bind(users());
        let benDown = true;
        jest.spyOn(users(), 'updateOne').mockImplementation(async (filter, update) => {
            if (benDown && filter.username === 'Ben') throw new Error('timed out');
            return real(filter, update);
        });
        await profile.recordGameStats(finishedGame());
        expect(statsOf('Ann').gamesPlayed).toBe(1);
        expect(statsOf('Ben').gamesPlayed).toBeUndefined();
        expect(records().docs[0].statsPending).toEqual([{ position: 2, username: 'Ben' }]);
        expect(errors.map(e => e.msg)).toEqual(['Error recording game stats']);
        expect(errors[0].meta).toMatchObject({ username: 'Ben', gameId: 'g-1', bucket: 'stats', delta: { gamesPlayed: 1, losses: 1 } });

        benDown = false;
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        expect(statsOf('Ben')).toMatchObject({ gamesPlayed: 1, losses: 1, totalFaults: 2, totalHSI: 250 });
        expect(statsOf('Ann').gamesPlayed).toBe(1);
        expect(records().docs[0].statsPending).toBeUndefined();
        // A second sweep finds nothing
        expect(await profile.resumePendingGameStats()).toEqual({ records: 0, failed: 0 });
        expect(statsOf('Ben').gamesPlayed).toBe(1);
    });

    test('a crash between the $incs and the mark: the sweep re-applies the whole list and nobody is counted twice', async () => {
        failFirst(records(), 'updateOne', 99); // the mark never lands
        await profile.recordGameStats(finishedGame());
        expect(records().docs[0].statsPending).toHaveLength(4);
        expect(errors.map(e => e.msg)).toEqual(['Could not mark game stats applied']);
        jest.restoreAllMocks();
        jest.spyOn(authLogger, 'info').mockImplementation(() => {});
        jest.spyOn(authLogger, 'debug').mockImplementation(() => {});
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) expect(statsOf(name).gamesPlayed).toBe(1);
        expect(records().docs[0].statsPending).toBeUndefined();
    });

    test('the record cannot be written at all: the stats still go in once, the deltas are logged', async () => {
        failFirst(records(), 'findOne', 99);
        await profile.recordGameStats(finishedGame());
        expect(records().docs).toHaveLength(0);
        expect(errors.map(e => e.msg)).toEqual(['Error recording game result']);
        expect(errors[0].meta.statsDeltas.byPosition[1]).toEqual(EXPECTED_ANN_DELTA);
        expect(statsOf('Ann')).toEqual(EXPECTED_ANN);
        // and a later replay of the same game still adds nothing
        jest.restoreAllMocks();
        await profile.recordGameStats(finishedGame());
        expect(statsOf('Ann')).toEqual(EXPECTED_ANN);
    });

    test('recordGameStats never rejects', async () => {
        jest.spyOn(gameManager.deletedUsernames, 'has').mockImplementation(() => { throw new Error('boom'); });
        await expect(profile.recordGameStats(finishedGame())).resolves.toBeUndefined();
        expect(errors.map(e => e.msg)).toContain('End-of-game writes failed');
    });
});

/** Ann's guard window as `n` games pushed `agoMs` ago (oldest first). */
function fillWindow(name, n, agoMs) {
    const at = new Date(Date.now() - agoMs);
    users().docs.find(d => d.username === name).statsGames = Array.from({ length: n }, (_, i) => ({ id: `old-${i}`, at }));
}

describe('the guard window and accounts that changed', () => {
    test('applied, the mark lost, then 50 more games: the sweep does not count the game again (the window no longer reaches it)', async () => {
        const mark = failFirst(records(), 'updateOne', 99);
        await profile.recordGameStats(finishedGame({ gameId: 'g-0' }));
        expect(records().docs[0].statsPending).toHaveLength(4);
        mark.mockRestore();
        for (let i = 1; i <= profile.STATS_GAMES_KEPT; i++) {
            await profile.recordGameStats(finishedGame({ gameId: `g-${i}` }));
        }
        expect(guardIds('Ann')).not.toContain('g-0');
        expect(statsOf('Ann').gamesPlayed).toBe(profile.STATS_GAMES_KEPT + 1);
        warns.length = 0;
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        expect(statsOf('Ann').gamesPlayed).toBe(profile.STATS_GAMES_KEPT + 1);
        expect(records().docs.find(r => r.gameId === 'g-0').statsPending).toBeUndefined();
        const notCredited = warns.filter(w => w.msg === 'Game stats not credited: the guard window no longer reaches this game');
        expect(notCredited.map(w => w.meta.username).sort()).toEqual(['Ann', 'Ben', 'Cat', 'Dan']);
        expect(notCredited.find(w => w.meta.username === 'Ann').meta).toMatchObject({ gameId: 'g-0', bucket: 'stats', delta: EXPECTED_ANN_DELTA });
    });

    test('a full window that reaches back past the game: credited as usual', async () => {
        fillWindow('Ann', profile.STATS_GAMES_KEPT, profile.STATS_GUARD_SKEW_MS + 60000);
        await profile.recordGameStats(finishedGame());
        expect(statsOf('Ann')).toEqual(EXPECTED_ANN);
        expect(guardIds('Ann')).toHaveLength(profile.STATS_GAMES_KEPT);
        expect(guardIds('Ann').at(-1)).toBe('g-1');
        expect(warns).toEqual([]);
    });

    test('a full window newer than a pending game (swept late): not credited, warned with the delta', async () => {
        await records().insertOne({
            gameId: 'g-late',
            completedAt: new Date(Date.now() - 2 * profile.STATS_GUARD_SKEW_MS),
            statsDeltas: { bucket: 'stats', byPosition: { 1: EXPECTED_ANN } },
            statsPending: [{ position: 1, username: 'Ann' }]
        });
        fillWindow('Ann', profile.STATS_GAMES_KEPT, 1000);
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        expect(statsOf('Ann')).toEqual({});
        expect(warns.map(w => w.msg)).toEqual(['Game stats not credited: the guard window no longer reaches this game']);
        // with room in the window the same late game is credited
        records().docs[0].statsPending = [{ position: 1, username: 'Ann' }];
        fillWindow('Ann', profile.STATS_GAMES_KEPT - 1, 1000);
        await profile.resumePendingGameStats();
        expect(statsOf('Ann')).toEqual(EXPECTED_ANN);
    });

    test('renamed while pending: the tombstone is never credited, the new name is not either (warned with the delta)', async () => {
        failFirst(users(), 'updateOne', 99);
        await profile.recordGameStats(finishedGame());
        expect(records().docs[0].statsPending).toHaveLength(4);
        jest.restoreAllMocks();
        jest.spyOn(authLogger, 'warn').mockImplementation((msg, meta) => warns.push({ msg, meta }));
        jest.spyOn(authLogger, 'info').mockImplementation(() => {});
        jest.spyOn(authLogger, 'debug').mockImplementation(() => {});
        // the admin rename: the account becomes Anna, a tombstone keeps Ann
        users().docs.find(d => d.username === 'Ann').username = 'Anna';
        await users().insertOne({ username: 'Ann', mergedInto: 'Anna', mergedAt: new Date(), renamedAt: new Date() });
        warns.length = 0;
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        const tomb = users().docs.find(d => d.username === 'Ann');
        expect(tomb.stats).toBeUndefined();
        expect(tomb.statsGames).toBeUndefined();
        expect(statsOf('Anna')).toEqual({});
        expect(statsOf('Ben').gamesPlayed).toBe(1);
        expect(warns.map(w => w.msg)).toEqual(['Game stats not credited: the account was renamed or merged']);
        expect(warns[0].meta).toMatchObject({ username: 'Ann', mergedInto: 'Anna', gameId: 'g-1', delta: EXPECTED_ANN });
        expect(records().docs[0].statsPending).toBeUndefined();
    });

    test('an account deleted while its game is pending leaves statsPending; an emptied list is cleared by the sweep', async () => {
        const { eraseAccount } = require('../../admin/accountDelete');
        const real = users().updateOne.bind(users());
        jest.spyOn(users(), 'updateOne').mockImplementation(async (filter, update) => {
            if (filter.username === 'Ben') throw new Error('timed out');
            return real(filter, update);
        });
        await profile.recordGameStats(finishedGame());
        expect(records().docs[0].statsPending).toEqual([{ position: 2, username: 'Ben' }]);
        jest.restoreAllMocks();
        jest.spyOn(authLogger, 'info').mockImplementation(() => {});
        jest.spyOn(authLogger, 'debug').mockImplementation(() => {});
        jest.spyOn(authLogger, 'warn').mockImplementation(() => {});
        const ben = users().docs.find(d => d.username === 'Ben');
        await eraseAccount(mockDb.current, { _id: ben._id, username: 'Ben' }, { pullBlocks: false });
        const rec = records().docs[0];
        expect(rec.statsPending).toEqual([]);
        expect(JSON.stringify(rec)).not.toMatch(/Ben/);
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        expect(records().docs[0].statsPending).toBeUndefined();
    });
});

describe('graceful shutdown waits for writes in flight', () => {
    const fakeServer = () => ({ close: jest.fn() });

    test('a write retrying with a long backoff finishes before the exit (the shutdown cuts the backoff short)', async () => {
        profile._setStatsRetryDelaysForTests([60000, 60000]);
        failFirst(users(), 'updateOne', 1);
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
        const listeners = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'].map(e => [e, process.listeners(e)]);
        const { shutdown } = shutdownMod.setupGracefulShutdown(fakeServer(), null, { noticeMs: 0, settleMs: 0, hardExitMs: 5000 });
        try {
            const write = profile.recordGameStats(finishedGame());
            expect(shutdownMod.inFlightCount()).toBe(1);
            const started = Date.now();
            await shutdown('SIGTERM', 0);
            expect(Date.now() - started).toBeLessThan(3000);
            expect(exit).toHaveBeenCalledWith(0);
            await write;
            for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) expect(statsOf(name).gamesPlayed).toBe(1);
            expect(shutdownMod.inFlightCount()).toBe(0);
        } finally {
            for (const [event, before] of listeners) {
                for (const l of process.listeners(event)) if (!before.includes(l)) process.removeListener(event, l);
            }
        }
    });

    test('a short outage during the shutdown: the retries keep going (briefly) until it ends, so nothing is lost', async () => {
        profile._setStatsRetryDelaysForTests([60000, 60000, 60000]);
        const downUntil = Date.now() + 600;
        for (const [coll, method] of [[records(), 'insertOne'], [records(), 'findOne'], [records(), 'updateOne'], [users(), 'updateOne']]) {
            const real = coll[method].bind(coll);
            jest.spyOn(coll, method).mockImplementation(async (...args) => {
                if (Date.now() < downUntil) throw new Error('not primary');
                return real(...args);
            });
        }
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
        const listeners = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'].map(e => [e, process.listeners(e)]);
        // the default hard exit: a 8.5 s drain with no notice or settle
        const { shutdown } = shutdownMod.setupGracefulShutdown(fakeServer(), null, { noticeMs: 0, settleMs: 0 });
        try {
            const write = profile.recordGameStats(finishedGame());
            const started = Date.now();
            await shutdown('SIGTERM', 0);
            const took = Date.now() - started;
            expect(took).toBeGreaterThanOrEqual(400);
            expect(took).toBeLessThan(4000);
            expect(exit).toHaveBeenCalledWith(0);
            await write;
            expect(records().docs).toHaveLength(1);
            expect(records().docs[0].statsPending).toBeUndefined();
            for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) expect(statsOf(name).gamesPlayed).toBe(1);
            expect(errors).toEqual([]);
        } finally {
            for (const [event, before] of listeners) {
                for (const l of process.listeners(event)) if (!before.includes(l)) process.removeListener(event, l);
            }
        }
    });

    test('retries during a shutdown stop at the drain deadline', async () => {
        profile._setStatsRetryDelaysForTests([60000]);
        jest.spyOn(records(), 'findOne').mockRejectedValue(new Error('down'));
        jest.spyOn(users(), 'updateOne').mockRejectedValue(new Error('down'));
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
        const listeners = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'].map(e => [e, process.listeners(e)]);
        const { shutdown } = shutdownMod.setupGracefulShutdown(fakeServer(), null, { noticeMs: 0, settleMs: 0, hardExitMs: 5000, drainMs: 800 });
        try {
            const write = profile.recordGameStats(finishedGame());
            const started = Date.now();
            await shutdown('SIGTERM', 0);
            await write;
            await new Promise(r => setImmediate(r));
            // the whole chain gave up by the deadline (plus one short wait per step)
            expect(Date.now() - started).toBeLessThan(2500);
            expect(shutdownMod.inFlightCount()).toBe(0);
            expect(exit).toHaveBeenCalledWith(0);
            expect(errors.map(e => e.msg)).toEqual(expect.arrayContaining(['Error recording game result', 'Error recording game stats']));
        } finally {
            for (const [event, before] of listeners) {
                for (const l of process.listeners(event)) if (!before.includes(l)) process.removeListener(event, l);
            }
        }
    });

    test('a write that never settles is waited for at most drainMs, then the process exits anyway', async () => {
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
        const listeners = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'].map(e => [e, process.listeners(e)]);
        const { shutdown } = shutdownMod.setupGracefulShutdown(fakeServer(), null, { noticeMs: 0, settleMs: 0, hardExitMs: 5000, drainMs: 50 });
        try {
            shutdownMod.trackInFlight(new Promise(() => {}));
            await shutdown('SIGTERM', 0);
            expect(exit).toHaveBeenCalledWith(0);
            expect(logger.warn).toHaveBeenCalledWith('Exiting with writes still in flight', { count: 1, maxMs: 50 });
        } finally {
            for (const [event, before] of listeners) {
                for (const l of process.listeners(event)) if (!before.includes(l)) process.removeListener(event, l);
            }
        }
    });

    test('drainInFlight also waits for writes that start during the wait', async () => {
        let releaseFirst;
        shutdownMod.trackInFlight(new Promise(r => { releaseFirst = r; }));
        let secondDone = false;
        const drained = shutdownMod.drainInFlight(2000);
        releaseFirst();
        shutdownMod.trackInFlight(new Promise(r => setImmediate(r)).then(() => { secondDone = true; }));
        await expect(drained).resolves.toBe(true);
        expect(secondDone).toBe(true);
    });
});

/**
 * The per-seat bucket reader (statsDeltas.bucketByPosition, plan H2a): a
 * record may route single seats to another bucket than the whole game's
 * (a player whose own /help use made the game bot-assisted for them). It
 * ships before anything writes it, so an older process never meets a
 * record it would credit to the wrong bucket.
 */
describe('per-seat buckets (statsDeltas.bucketByPosition)', () => {
    const DELTAS = () => profile.buildGameEndRecord(finishedGame()).statsDeltas.byPosition;
    const ALL_PENDING = [
        { position: 1, username: 'Ann' }, { position: 2, username: 'Ben' },
        { position: 3, username: 'Cat' }, { position: 4, username: 'Dan' }
    ];
    /** A record a previous process left pending (as the boot sweep finds it). */
    async function pendingRecord(statsDeltas, { gameId = 'g-mix', pending = ALL_PENDING } = {}) {
        await records().insertOne({
            gameId,
            completedAt: new Date(),
            statsDeltas,
            statsPending: pending.map(e => ({ ...e }))
        });
    }
    const bucketsOf = (name) => {
        const doc = users().docs.find(d => d.username === name);
        return { stats: doc.stats?.gamesPlayed || 0, botStats: doc.botStats?.gamesPlayed || 0 };
    };

    test('nothing writes it yet: a finished game\'s record carries only bucket, byPosition, the seat names and bags', async () => {
        await profile.recordGameStats(finishedGame());
        await profile.recordGameStats(finishedGame({ gameId: 'g-2', bots: [2, 4] }));
        for (const rec of records().docs) expect(Object.keys(rec.statsDeltas).sort()).toEqual(['bags', 'bucket', 'byPosition', 'names']);
    });

    test('the boot sweep routes a mixed-bucket record per seat: the marked seat to its bucket, every other seat to the whole game\'s; once', async () => {
        const infos = [];
        authLogger.info.mockImplementation((msg, meta) => infos.push({ msg, meta }));
        await pendingRecord({ bucket: 'stats', bucketByPosition: { 2: 'botStats' }, byPosition: DELTAS() });
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        expect(bucketsOf('Ann')).toEqual({ stats: 1, botStats: 0 });
        expect(bucketsOf('Ben')).toEqual({ stats: 0, botStats: 1 });
        expect(bucketsOf('Cat')).toEqual({ stats: 1, botStats: 0 });
        expect(bucketsOf('Dan')).toEqual({ stats: 1, botStats: 0 });
        // Ben's whole delta lands in botStats, nothing of it in stats
        expect(statsOf('Ben', 'botStats')).toMatchObject({ gamesPlayed: 1, losses: 1, totalPoints: 150, totalFaults: 2, totalHSI: 250 });
        expect(users().docs.find(d => d.username === 'Ben').stats).toBeUndefined();
        // The log line carries each seat's own bucket
        const recorded = Object.fromEntries(infos.filter(i => i.msg === 'Game stats recorded').map(i => [i.meta.username, i.meta.bucket]));
        expect(recorded).toEqual({ Ann: 'stats', Ben: 'botStats', Cat: 'stats', Dan: 'stats' });
        expect(records().docs[0].statsPending).toBeUndefined();
        // A second sweep, and a re-marked pending list, add nothing
        expect(await profile.resumePendingGameStats()).toEqual({ records: 0, failed: 0 });
        records().docs[0].statsPending = ALL_PENDING.map(e => ({ ...e }));
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        expect(bucketsOf('Ben')).toEqual({ stats: 0, botStats: 1 });
        expect(bucketsOf('Ann')).toEqual({ stats: 1, botStats: 0 });
        expect(warns).toEqual([]);
        expect(errors).toEqual([]);
    });

    test('the other way round: a whole-game botStats record can route a seat to stats', async () => {
        await pendingRecord({ bucket: 'botStats', bucketByPosition: { 3: 'stats' }, byPosition: DELTAS() });
        await profile.resumePendingGameStats();
        expect(bucketsOf('Ann')).toEqual({ stats: 0, botStats: 1 });
        expect(bucketsOf('Cat')).toEqual({ stats: 1, botStats: 0 });
    });

    test('the live chain (a prebuilt record, as the ENDED tombstone hands it over) routes per seat, and a replay counts once', async () => {
        const record = profile.buildGameEndRecord(finishedGame());
        record.statsDeltas.bucketByPosition = { 1: 'botStats' };
        await profile.recordGameStats(finishedGame(), { record });
        await profile.recordGameStats(finishedGame(), { record });
        expect(records().docs).toHaveLength(1);
        expect(records().docs[0].statsDeltas.bucketByPosition).toEqual({ 1: 'botStats' });
        expect(statsOf('Ann', 'botStats')).toEqual(EXPECTED_ANN);
        expect(statsOf('Ann')).toEqual({});
        expect(bucketsOf('Ben')).toEqual({ stats: 1, botStats: 0 });
    });

    test('a record that could not be written still routes per seat (the in-memory copy)', async () => {
        failFirst(records(), 'findOne', 99);
        const record = profile.buildGameEndRecord(finishedGame());
        record.statsDeltas.bucketByPosition = { 4: 'botStats' };
        await profile.recordGameStats(finishedGame(), { record });
        expect(records().docs).toHaveLength(0);
        expect(bucketsOf('Dan')).toEqual({ stats: 0, botStats: 1 });
        expect(bucketsOf('Cat')).toEqual({ stats: 1, botStats: 0 });
    });

    test('an unknown per-seat value, or none for a seat, falls back to the whole-game bucket', async () => {
        await pendingRecord({
            bucket: 'stats',
            bucketByPosition: { 1: 'users', 2: null, 3: 'botStats.wins', 5: 'botStats' },
            byPosition: DELTAS()
        });
        await profile.resumePendingGameStats();
        for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) expect(bucketsOf(name)).toEqual({ stats: 1, botStats: 0 });
        // A value that is not a bucket never becomes a field path
        const ann = users().docs.find(d => d.username === 'Ann');
        expect(ann.users).toBeUndefined();
        expect(users().docs.find(d => d.username === 'Cat').botStats).toBeUndefined();
    });

    test.each([
        ['a non-object', 'botStats'],
        ['an array', ['botStats', 'botStats', 'botStats', 'botStats', 'botStats']],
        ['null', null]
    ])('a malformed bucketByPosition (%s) is ignored', async (_label, bucketByPosition) => {
        await pendingRecord({ bucket: 'stats', bucketByPosition, byPosition: DELTAS() });
        await profile.resumePendingGameStats();
        for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) expect(bucketsOf(name)).toEqual({ stats: 1, botStats: 0 });
    });

    test.each([
        ['stats', { stats: 1, botStats: 0 }],
        ['botStats', { stats: 0, botStats: 1 }],
        [undefined, { stats: 1, botStats: 0 }],
        ['something-else', { stats: 1, botStats: 0 }]
    ])('old records (no bucketByPosition, bucket %s) replay exactly as before', async (bucket, expected) => {
        const statsDeltas = { byPosition: DELTAS() };
        if (bucket !== undefined) statsDeltas.bucket = bucket;
        await pendingRecord(statsDeltas);
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) expect(bucketsOf(name)).toEqual(expected);
        const target = expected.botStats ? 'botStats' : 'stats';
        expect(statsOf('Ann', target)).toEqual(EXPECTED_ANN);
    });

    test('a record from before statsDeltas (no deltas at all) credits nobody and clears its list, as before', async () => {
        await pendingRecord(undefined);
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        for (const name of ['Ann', 'Ben', 'Cat', 'Dan']) expect(bucketsOf(name)).toEqual({ stats: 0, botStats: 0 });
        expect(records().docs[0].statsPending).toBeUndefined();
    });

    test('a not-credited warning and a failed write name the seat\'s own bucket', async () => {
        fillWindow('Ben', profile.STATS_GAMES_KEPT, 1000);
        const real = users().updateOne.bind(users());
        jest.spyOn(users(), 'updateOne').mockImplementation(async (filter, update) => {
            if (filter.username === 'Cat') throw new Error('timed out');
            return real(filter, update);
        });
        await records().insertOne({
            gameId: 'g-old',
            completedAt: new Date(Date.now() - 2 * profile.STATS_GUARD_SKEW_MS),
            statsDeltas: { bucket: 'stats', bucketByPosition: { 2: 'botStats', 3: 'botStats' }, byPosition: DELTAS() },
            statsPending: ALL_PENDING.map(e => ({ ...e }))
        });
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 1 });
        expect(warns.find(w => w.msg === 'Game stats not credited: the guard window no longer reaches this game').meta)
            .toMatchObject({ username: 'Ben', gameId: 'g-old', bucket: 'botStats' });
        expect(errors.find(e => e.msg === 'Error recording game stats').meta).toMatchObject({ username: 'Cat', bucket: 'botStats' });
        expect(records().docs[0].statsPending).toEqual([{ position: 3, username: 'Cat' }]);
        expect(bucketsOf('Ann')).toEqual({ stats: 1, botStats: 0 });
        expect(bucketsOf('Ben')).toEqual({ stats: 0, botStats: 0 });
    });
});
