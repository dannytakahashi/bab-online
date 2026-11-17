/**
 * The live persist store (server/game/persist/liveStore.js; deploy
 * survival PR 4, the plan's 2.3) in write mode, over persistHarness's
 * liveDb (memoryDb with fault injection) and real games:
 *   - coalescing: a synchronous run is one write, changes during a write
 *     in flight make exactly one follow-up, rev counts writes;
 *   - the first write is the only insert: never an insert or upsert after
 *     its ack; an ambiguous insert that landed is read back (E11000) and
 *     updated; another owner's doc under the id is a fence;
 *   - matchedCount 0, every cause: gone near expireAt -> stop and play on;
 *     gone early, another owner, mine but released -> fence (retired,
 *     frozen, sockets engine-closed, no emit, never recreated);
 *   - the stored doc always ends equal to serialize(game) (chaos runs);
 *   - a tainted game keeps its last good doc;
 *   - log lines $push'ed ($slice -500), the whole log after a failure or a
 *     rename;
 *   - expireAt = createdAt + 24 h, stop and delete at 23 h 50 m;
 *   - a Mongo outage or stall never holds a game up (no await but the
 *     claim), logs are rate-limited and name ids only, no unhandled
 *     rejection; a null collection skips;
 *   - modes: off does nothing, on runs as write (one log line);
 *   - the serverInstances doc: insert at start, heartbeat with beatSeq and
 *     the live ids, $addToSet at creation; no sweep in write mode.
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
const liveStore = require('../liveStore');
const gameCodec = require('../gameCodec');
const persistHooks = require('../hooks');
const contractCheck = require('../../../testUtils/contractCheck');
const { runSeedInner } = require('../../../testUtils/chaosEngine');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

let realRandom;
let errorLogs;
let io;
let log;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(11);
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    log = [];
    io = makeIo(log);
});

afterEach(() => {
    liveStore._resetForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
// One entry per op (a stalled op is recorded again when it goes on)
const liveOps = (op) => db().faults.calls.filter((c) => c.collection === 'liveGames' && (!op || c.op === op) && c.outcome !== 'stalled');
const install = (opts = {}) => kit.installStore(mockDb, { getIo: () => io, ...opts });
const expectDocMatches = (game) => expect(kit.comparable(kit.savedGame(db(), game.gameId))).toEqual(kit.comparable(gameCodec.serialize(game)));

describe('writes', () => {
    test('the dealt game is inserted once with its envelope: owner, ownerMode write, live, expireAt = createdAt + 24 h', async () => {
        const store = install();
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await h.flushStore(store);
        const doc = kit.savedGame(db(), game.gameId);
        expect(doc).toMatchObject({
            _id: game.gameId, v: gameCodec.CODEC_V, kind: 'live', owner: 'boot-A', ownerMode: 'write',
            released: false, releasedAt: null, adoptAttempts: 0, adoptedBy: null, adoptedAt: null, stage: Phase.BIDDING,
        });
        expect(doc.createdAt.getTime()).toBe(game.createdAt);
        expect(doc.expireAt.getTime()).toBe(game.createdAt + 24 * 60 * 60 * 1000);
        expect(liveOps('insertOne')).toHaveLength(1);
        expectDocMatches(game);
        expect(store.health().docsOwned).toBe(1);
    });

    test('pre-deal tables are never written (serialize is null before BIDDING)', async () => {
        const store = install();
        const { game } = await kit.startGame(io, log, { humans: ['Hal'], until: () => true });
        expect(game.stage).toBe(Phase.DRAWING);
        await h.flushStore(store);
        expect(liveOps('insertOne')).toHaveLength(0);
        expect(kit.savedGame(db(), game.gameId)).toBeNull();
    });

    test('coalescing: a synchronous run of changes is one write; changes during a write in flight make exactly one follow-up; rev counts writes', async () => {
        const store = install();
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await h.flushStore(store);
        const rev0 = kit.savedGame(db(), game.gameId).rev;
        const updates0 = liveOps('updateOne').length;

        for (let i = 0; i < 6; i++) game.addLogEntry(`line ${i}`, null, 'system');
        await h.flushStore(store);
        expect(liveOps('updateOne').length - updates0).toBe(1);
        expect(kit.savedGame(db(), game.gameId).rev).toBe(rev0 + 1);

        // One write stalls; meanwhile more changes, across several turns
        db().faults.stall({ collections: 'liveGames', ops: 'updateOne' });
        game.addLogEntry('during 1', null, 'system');
        await jest.advanceTimersByTimeAsync(0);
        expect(db().faults.stalledCount()).toBe(1);
        game.addLogEntry('during 2', null, 'system');
        await jest.advanceTimersByTimeAsync(0);
        game.addLogEntry('during 3', null, 'system');
        game.addLogEntry('during 4', null, 'system');
        await jest.advanceTimersByTimeAsync(0);
        expect(db().faults.stalledCount()).toBe(1);
        db().faults.release();
        await h.flushStore(store);
        expect(liveOps('updateOne').length - updates0).toBe(3);
        expect(kit.savedGame(db(), game.gameId).rev).toBe(rev0 + 3);
        expectDocMatches(game);
    });

    test('never an insert or an upsert after the first acknowledged insert', async () => {
        const store = install();
        const updateSpy = jest.spyOn(db().liveGames, 'updateOne');
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await h.flushStore(store);
        for (let i = 0; i < 5; i++) {
            game.addLogEntry(`x${i}`, null, 'system');
            await h.flushStore(store);
        }
        db().faults.fail({ collections: 'liveGames', ops: 'updateOne', times: 1 });
        game.addLogEntry('fails', null, 'system');
        await h.flushStore(store);
        game.addLogEntry('after', null, 'system');
        await h.flushStore(store);
        expect(liveOps('insertOne')).toHaveLength(1);
        expect(liveOps('replaceOne')).toHaveLength(0);
        for (const [filter, , options] of updateSpy.mock.calls) {
            expect(options?.upsert).toBeFalsy();
            expect(filter).toEqual({ _id: game.gameId, owner: 'boot-A', released: false });
        }
        expectDocMatches(game);
    });

    test('a tainted game keeps its last good doc until a clean run', async () => {
        const store = install();
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await h.flushStore(store);
        const before = kit.plain(kit.savedGame(db(), game.gameId));
        game.markTainted(true);
        game.addLogEntry('while tainted', null, 'system');
        await h.flushStore(store);
        expect(kit.plain(kit.savedGame(db(), game.gameId))).toEqual(before);
        game.markTainted(false);
        game.addLogEntry('clean again', null, 'system');
        await h.flushStore(store);
        expectDocMatches(game);
    });
});

describe('the log: $push of new lines, the whole log when needed', () => {
    test('new lines are pushed with $slice -500; a failed write or a rename makes the next one $set the whole log', async () => {
        const store = install();
        const updateSpy = jest.spyOn(db().liveGames, 'updateOne');
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await h.flushStore(store);
        updateSpy.mockClear();

        game.addLogEntry('a', null, 'system');
        game.addLogEntry('b', 1, 'chat', { from: 'Hal' });
        await h.flushStore(store);
        let [, update] = updateSpy.mock.calls.at(-1);
        expect(update.$push).toEqual({ log: { $each: game.gameLog.slice(-2).map(kit.plain), $slice: -500 } });
        expect(update.$set.log).toBeUndefined();

        db().faults.fail({ collections: 'liveGames', ops: 'updateOne', times: 1 });
        game.addLogEntry('c', null, 'system');
        await h.flushStore(store);
        game.addLogEntry('d', null, 'system');
        await h.flushStore(store);
        [, update] = updateSpy.mock.calls.at(-1);
        expect(update.$push).toBeUndefined();
        expect(update.$set.log).toEqual(game.gameLog.map(kit.plain));
        expectDocMatches(game);

        // An admin rename re-points `from` in place: the whole log again
        game.addLogEntry('e', null, 'system');
        await h.flushStore(store);
        expect(updateSpy.mock.calls.at(-1)[1].$push).toBeDefined();
        expect(gameManager.renameChatSender('Hal', 'Hank')).toBe(1);
        await h.flushStore(store);
        [, update] = updateSpy.mock.calls.at(-1);
        expect(update.$set.log.find((e) => e.message === 'b').from).toBe('Hank');
        expectDocMatches(game);
    });

    test('more than 500 lines: the stored log is the last 500, as in memory', async () => {
        const store = install();
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await h.flushStore(store);
        for (let i = 0; i < 620; i++) {
            game.addLogEntry(`n${i}`, null, 'system');
            if (i % 50 === 0) await h.flushStore(store);
        }
        await h.flushStore(store);
        const doc = kit.savedGame(db(), game.gameId);
        expect(doc.log).toHaveLength(500);
        expect(doc.log.at(-1).message).toBe('n619');
        expectDocMatches(game);
    });
});

describe('E11000 on the insert', () => {
    test('an insert that landed but lost its reply: the retry reads it back as ours and updates it', async () => {
        const store = install();
        db().faults.fail({ collections: 'liveGames', ops: 'insertOne', times: 1, lostReply: true });
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await h.flushStore(store);
        expect(liveOps('insertOne').map((c) => c.outcome)).toEqual(['lostReply']);
        game.addLogEntry('next', null, 'system');
        await h.flushStore(store);
        expect(liveOps('insertOne').map((c) => c.outcome)).toEqual(['lostReply', 'ok']);
        // (the second insert threw E11000 inside memoryDb: read back, then an update)
        expect(liveOps('findOne').length).toBeGreaterThanOrEqual(1);
        expect(liveOps('updateOne').length).toBeGreaterThanOrEqual(1);
        expect(game.frozen).toBeFalsy();
        expectDocMatches(game);
    });

    test("another owner's doc under the id: fenced, never overwritten", async () => {
        const store = install();
        const { game, sockets } = await kit.startGame(io, log, { humans: ['Hal'], until: () => true });
        db().liveGames._insert({ _id: game.gameId, owner: 'boot-B', released: false, kind: 'live', marker: 1 });
        await kit.advanceUntil(() => game.stage === Phase.BIDDING || game.frozen);
        await h.flushStore(store);
        expect(game.frozen).toBe(true);
        expect(gameManager.games.has(game.gameId)).toBe(false);
        expect(sockets[0].conn.close).toHaveBeenCalledTimes(1);
        expect(kit.savedGame(db(), game.gameId)).toMatchObject({ owner: 'boot-B', marker: 1 });
    });
});

describe('matchedCount 0: what is there decides', () => {
    async function playing(storeOpts) {
        const store = install(storeOpts);
        const ctx = await kit.startGame(io, log, { humans: ['Hal'] });
        await h.flushStore(store);
        expect(kit.savedGame(db(), ctx.game.gameId)).not.toBeNull();
        return { store, ...ctx };
    }

    async function expectFenced({ store, game, sockets }, why) {
        const inserts = liveOps('insertOne').length;
        const at = log.length;
        game.addLogEntry('change', null, 'system');
        await h.flushStore(store);
        expect(game.frozen).toBe(true);
        expect(gameManager.games.has(game.gameId)).toBe(false);
        expect(botController.gamesBots.has(game.gameId)).toBe(false);
        // Engine close (a transport close for the client), never socket.disconnect()
        expect(sockets[0].conn.close).toHaveBeenCalledTimes(1);
        expect(sockets[0].disconnect).not.toHaveBeenCalled();
        expect(store.logs.filter((l) => /fenced/.test(l.msg)).map((l) => l.meta)).toEqual([{ gameId: game.gameId, rev: expect.any(Number), why }]);
        // Nothing more from it: no emit, no write, never recreated
        await jest.advanceTimersByTimeAsync(120000);
        await h.flushStore(store);
        expect(log.slice(at).filter((l) => l.to === game.roomName || l.to === `self:${sockets[0].id}`)).toEqual([]);
        expect(liveOps('insertOne')).toHaveLength(inserts);
        expect(store.pending()).toBe(0);
    }

    test('gone early (adopted, ended or discarded elsewhere): fence', async () => {
        const ctx = await playing();
        await db().liveGames.deleteOne({ _id: ctx.game.gameId });
        await expectFenced(ctx, 'gone');
        expect(kit.savedGame(db(), ctx.game.gameId)).toBeNull();
    });

    test('another owner: fence', async () => {
        const ctx = await playing();
        await db().liveGames.updateOne({ _id: ctx.game.gameId }, { $set: { owner: 'boot-B' } });
        await expectFenced(ctx, 'owner');
    });

    test('mine but released (the crash path): fence', async () => {
        const ctx = await playing();
        await db().liveGames.updateOne({ _id: ctx.game.gameId }, { $set: { released: true, releasedAt: new Date() } });
        await expectFenced(ctx, 'released');
    });

    test('gone at expireAt - 10 min or later (the TTL): stop persisting, play on, no fence', async () => {
        let skew = 0;
        const ctx = await playing({ now: () => Date.now() + skew });
        const { store, game, sockets } = ctx;
        db().faults.stall({ collections: 'liveGames', ops: 'updateOne' });
        game.addLogEntry('change', null, 'system');
        await jest.advanceTimersByTimeAsync(0);
        // The TTL monitor deletes it while the update is on the wire, at 23 h 51 m
        skew = 23 * 3600000 + 51 * 60000;
        db().liveGames.docs.splice(0, db().liveGames.docs.length);
        db().faults.release();
        await h.flushStore(store);
        expect(game.frozen).toBeFalsy();
        expect(gameManager.games.get(game.gameId)).toBe(game);
        expect(sockets[0].conn.close).not.toHaveBeenCalled();
        expect(store.logs.find((l) => /no longer saved/.test(l.msg)).meta).toMatchObject({ gameId: game.gameId, why: 'expired' });
        const inserts = liveOps('insertOne').length;
        const seq = game.eventSeq;
        await jest.advanceTimersByTimeAsync(60000);
        await h.flushStore(store);
        expect(game.eventSeq).toBeGreaterThan(seq);
        expect(liveOps('insertOne')).toHaveLength(inserts);
        expect(kit.savedGame(db(), game.gameId)).toBeNull();
    });

    test('at createdAt + 23 h 50 m the store stops writing and deletes its doc before the TTL could', async () => {
        let skew = 0;
        const { store, game } = await playing({ now: () => Date.now() + skew });
        skew = 23 * 3600000 + 49 * 60000;
        game.addLogEntry('23:49', null, 'system');
        await h.flushStore(store);
        expect(kit.savedGame(db(), game.gameId).log.at(-1).message).toBe('23:49');
        skew = 23 * 3600000 + 50 * 60000;
        game.addLogEntry('23:50', null, 'system');
        await h.flushStore(store);
        expect(kit.savedGame(db(), game.gameId)).toBeNull();
        expect(game.frozen).toBeFalsy();
        const writes = liveOps().length;
        await jest.advanceTimersByTimeAsync(30000);
        await h.flushStore(store);
        expect(liveOps().length).toBe(writes);
        expect(store.health().docsOwned).toBe(0);
    });
});

describe('no silent change: after chaos steps the stored doc is serialize(game)', () => {
    test('30 chaos seeds, checked at random steps; ended and aborted games leave no live doc', async () => {
        process.env.BAB_FSM_CHECK = '1';
        let checks = 0;
        try {
            for (let seed = 1; seed <= 30; seed++) {
                mockDb.current = h.liveDb();
                const store = install();
                contractCheck.setContext(`liveStore no-silent-change seed ${seed}`);
                let theGame = null;
                const r = await runSeedInner(seed, () => {}, {
                    errorLogs,
                    extraActions: (ctx) => [[5, async function persistCheck() {
                        theGame = ctx.game;
                        await h.flushStore(store);
                        const g = ctx.game;
                        const doc = gameCodec.serialize(g);
                        if (!doc) return;
                        checks++;
                        const saved = kit.savedGame(db(), g.gameId);
                        if (JSON.stringify(kit.comparable(saved)) !== JSON.stringify(kit.comparable(doc))) {
                            throw new Error(`seed ${seed}: stored doc differs from serialize(game) at ${g.stage}`);
                        }
                    }]],
                });
                if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 3000));
                await h.flushStore(store);
                if (theGame) expect(kit.savedGame(db(), theGame.gameId)).toBeNull();
                expect(store.logs.filter((l) => l.level !== 'info')).toEqual([]);
                liveStore._resetForTests();
            }
        } finally {
            delete process.env.BAB_FSM_CHECK;
        }
        expect(checks).toBeGreaterThan(200);
    }, 300000);
});

describe('outages never hold a game up', () => {
    async function playOut(game) {
        await kit.advanceUntil(() => game.isTerminal(), { step: 1000, cap: 3 * 3600000 });
    }

    test('liveGames down for a whole bot game: it plays to its end, warnings are rate-limited and name ids only, no unhandled rejection', async () => {
        const unhandled = [];
        const onUnhandled = (r) => unhandled.push(r);
        process.on('unhandledRejection', onUnhandled);
        try {
            const store = install();
            db().faults.fail({ collections: 'liveGames' });
            const { game } = await kit.startGame(io, log, { humans: [] });
            await playOut(game);
            await h.flushStore(store);
            expect(game.stage).toBe(Phase.ENDED);
            const warns = store.logs.filter((l) => l.level === 'warn');
            expect(warns.length).toBeGreaterThan(0);
            // One line per kind per minute: far fewer than the writes tried
            expect(warns.length).toBeLessThan(liveOps().length / 4);
            for (const w of warns) {
                expect(Object.keys(w.meta).every((k) => ['gameId', 'rev', 'error', 'code', 'skipped'].includes(k))).toBe(true);
            }
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        await Promise.resolve();
        expect(unhandled).toEqual([]);
    }, 60000);

    test('liveGames stalled (never answers): a game still plays to its end, and its terminal claim holds gameEnd up 5 s at most', async () => {
        const store = install();
        const { game } = await kit.startGame(io, log, { humans: [] });
        await h.flushStore(store);
        db().faults.stall({ collections: 'liveGames' });
        await kit.advanceUntil(() => game.isTerminal(), { step: 1000, cap: 3 * 3600000 });
        expect(game.stage).toBe(Phase.ENDED);
        const endAt = log.find((l) => l.to === game.roomName && l.event === 'gameEnd').at;
        // gameEnd's tail (after the claim) refreshes the main room's lists
        await kit.advanceUntil(() => log.some((l) => l.event === 'lobbiesUpdated' && l.at >= endAt), { step: 250, cap: 10000 });
        const tailAt = log.find((l) => l.event === 'lobbiesUpdated' && l.at >= endAt).at;
        expect(tailAt - endAt).toBeLessThanOrEqual(liveStore.CLAIM_MAX_MS + 250);
        db().faults.release();
        await h.flushStore(store);
    }, 60000);

    test('a null collection (not connected yet, or a test db without it): nothing is scheduled, play is unchanged', async () => {
        const store = install({ getCollections: () => ({ liveGames: null, liveTournaments: null, serverInstances: null }) });
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        game.addLogEntry('x', null, 'system');
        expect(store.pending()).toBe(0);
        expect(jest.getTimerCount()).toBeGreaterThan(0);
        await h.flushStore(store);
        expect(liveOps()).toEqual([]);
        expect(store.logs).toEqual([]);
    });

    test('a database module without the live getters (a partial jest.mock) or before connectDB gives null collections', () => {
        expect(liveStore.defaultCollections({ getUsersCollection: () => ({}) })).toEqual({ liveGames: null, liveTournaments: null, serverInstances: null });
        expect(liveStore.defaultCollections({ getLiveGamesCollection: () => undefined, getLiveTournamentsCollection: () => { throw new Error('x'); } }))
            .toEqual({ liveGames: null, liveTournaments: null, serverInstances: null });
        const coll = {};
        expect(liveStore.defaultCollections({ getLiveGamesCollection: () => coll }).liveGames).toBe(coll);
    });
});

describe('modes', () => {
    test('off: nothing listens, track and claim are no-ops, no write', async () => {
        const store = install({ mode: 'off' });
        expect(store.active).toBe(false);
        expect(persistHooks.listening()).toBe(false);
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await h.flushStore(store);
        expect(store.claimable(game)).toBe(false);
        expect(store.claimEnded(game)).toBeNull();
        expect(db().faults.calls.filter((c) => h.LIVE_COLLECTIONS.includes(c.collection))).toEqual([]);
        expect(store.health()).toMatchObject({ mode: 'off', effectiveMode: 'off', docsOwned: 0 });
    });

    test("on: runs as write (handoff and adoption are PR 5), docs say ownerMode 'write', one log line says so", async () => {
        const store = install({ mode: 'on' });
        expect(store.effectiveMode).toBe('write');
        expect(store.logs.filter((l) => /LIVE_PERSIST=on runs as 'write'/.test(l.msg))).toHaveLength(1);
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await h.flushStore(store);
        expect(kit.savedGame(db(), game.gameId)).toMatchObject({ ownerMode: 'write' });
        expect(store.health()).toMatchObject({ mode: 'on', effectiveMode: 'write', docsOwned: 1, adopted: 0, lastSweepAt: null, bootSwept: false });
    });

    test('the process store (getLiveStore) takes LIVE_PERSIST as read at boot', () => {
        const lps = require('../../../utils/livePersistSwitch');
        lps._resetForTests();
        lps.bootLivePersistMode({ LIVE_PERSIST: 'write' });
        liveStore._resetForTests({ bootId: 'boot-env' });
        const store = liveStore.getLiveStore();
        expect(store).toMatchObject({ mode: 'write', effectiveMode: 'write', active: true, bootId: 'boot-env' });
        expect(liveStore.getLiveStore()).toBe(store);
        expect(persistHooks.listening()).toBe(true);
        liveStore._resetForTests();
        expect(persistHooks.listening()).toBe(false);
        lps._resetForTests();
    });
});

describe('the serverInstances doc', () => {
    test('start inserts it; a heartbeat every 3 s bumps beatSeq and lists the live ids; a game made after start is added at once; no sweep', async () => {
        const store = install({ deploymentId: 'dep-1' });
        await store.start({ io });
        const inst = () => db().serverInstances.docs.find((d) => d._id === 'boot-A');
        expect(inst()).toMatchObject({ _id: 'boot-A', deploymentId: 'dep-1', mode: 'write', beatSeq: 0, shuttingDown: false, gameIds: [], tournamentIds: [] });
        const { game } = await kit.startGame(io, log, { humans: [], until: () => true });
        await h.flushStore(store);
        expect(inst().gameIds).toEqual([game.gameId]);
        expect(db().faults.calls.filter((c) => c.collection === 'serverInstances').map((c) => c.op)).toEqual(['insertOne', 'updateOne']);
        await jest.advanceTimersByTimeAsync(3000);
        await h.flushStore(store);
        expect(inst().beatSeq).toBe(1);
        await jest.advanceTimersByTimeAsync(6000);
        await h.flushStore(store);
        expect(inst().beatSeq).toBe(3);
        expect(inst().beatAt).toBeInstanceOf(Date);
        // Write mode reads no other instance's docs: no sweep, no adoption
        expect(db().faults.calls.filter((c) => c.op === 'find' || (c.collection !== 'serverInstances' && c.op === 'findOne'))).toEqual([]);
        store.close();
        await jest.advanceTimersByTimeAsync(9000);
        expect(inst().beatSeq).toBe(3);
    });

    test('a failed instance insert: the heartbeat upserts it', async () => {
        const store = install();
        db().faults.fail({ collections: 'serverInstances', ops: 'insertOne', times: 1 });
        await store.start({ io });
        expect(db().serverInstances.docs).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(3000);
        await h.flushStore(store);
        expect(db().serverInstances.docs[0]).toMatchObject({ _id: 'boot-A', mode: 'write', beatSeq: 1 });
        store.close();
    });
});

describe('remove', () => {
    test("a game's retire keeps its doc for the terminal claim; a deleted tournament's doc goes", async () => {
        const store = install();
        const { game } = await kit.startGame(io, log, { humans: [] });
        await h.flushStore(store);
        gameManager.abortGame(game.gameId); // the bare retire, no claim
        await h.flushStore(store);
        expect(kit.savedGame(db(), game.gameId)).not.toBeNull();

        const { setupTournament } = require('../../../testUtils/tournamentDriver');
        const ctx = await setupTournament(2, { io, log });
        await h.flushStore(store);
        expect(kit.savedTournament(db(), ctx.t.tournamentId)).toMatchObject({ owner: 'boot-A', phase: 'lobby' });
        gameManager.deleteTournament(ctx.t.tournamentId);
        await h.flushStore(store);
        expect(kit.savedTournament(db(), ctx.t.tournamentId)).toBeNull();
    });
});
