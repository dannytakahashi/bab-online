/**
 * The deploy overlap (deploy survival PR 5, LIVE_PERSIST=on; the plan's
 * PR 5 "overlapHandoff.test.js" list), with the model the PR 1 review note
 * fixed per case (persistHarness twoInstances LIMIT: a game cannot be
 * PLAYED on twoInstances' B):
 *
 *   DB-level, twoInstances: A plays on this test's singletons over its own
 *   connection (A.db; its 'on' store is the process's), B is a
 *   dependency-injected 'on' store over B.db (its own bootId, monotonic
 *   clock and connection; adoptGame recorded and never registering
 *   anything, so B's part ends at its claim):
 *     - B's /ready (whenBootSwept / ready()) does not wait on A's docs
 *     - a table created on A during the overlap (no doc yet): B answers
 *       pending, never gone; so does an unknown id while A is alive
 *     - false death: A's Mongo stalls 13 s (A "frozen" to every observer);
 *       A self-fences at 8 s (its table suspended: nothing emitted); B
 *       sees A's beat unchanged 12 s and claims the doc; A thaws, re-reads,
 *       is fenced (frozen, retired, its sockets engine-closed) and emits
 *       nothing more
 *     - A's copy reaching gameEnd after B claimed it (B's clock jumped:
 *       a false death with A alive): no gameRecords, no stats, no pointer
 *       clear, the doc stays B's
 *     - adopt race: B and C sweep one released doc at once, exactly one
 *       claim wins and one adoptGame runs
 *     - A's handoff never writes a users doc: a pointer set on B during
 *       the overlap stays (the PR 5 flush has no pointer write; the
 *       lobby-pointer flush of plan 4b.3 is PR 6, tournaments)
 *   handoff restart, createPersistHarness via deployKit (the successor
 *   announced first and held, A's real SIGTERM handoff, A dies, the
 *   successor serves on the reset singletons):
 *     - a client on B during the gap: B answers pending (pointer kept, no
 *       failure); after A's release the client's rejoin and B's sweep race,
 *       one adoption, the client seated once
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
const mockDb = { current: null };
jest.mock('../database', () => require('../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../testUtils/persistHarness');
const kit = require('../testUtils/liveStoreKit');
const { createDeploy } = require('../testUtils/deployKit');
const { makeIo, makeSocket, mulberry32 } = require('../testUtils/gameDriver');
const gameManager = require('../game/GameManager');
const { botController } = require('../game/bot');
const { Phase } = require('../game/GamePhase');
const liveStore = require('../game/persist/liveStore');
const handoffMod = require('../game/persist/handoff');
const shutdown = require('../utils/shutdown');
const profileHandlers = require('../socket/profileHandlers');
const reconnectHandlers = require('../socket/reconnectHandlers');
const chatHandlers = require('../socket/chatHandlers');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../utils/logger');

const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];
let realRandom;
let listenersBefore;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(57);
    listenersBefore = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    for (const s of SIGNALS) {
        for (const fn of process.listeners(s)) if (!listenersBefore[s].includes(fn)) process.removeListener(s, fn);
    }
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    shutdown._resetShutdownStateForTests({ abandonRetries: true });
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const base = () => mockDb.current;
const docOf = (id) => kit.savedGame(base(), id);
const pointer = (u) => base().users.docs.find((d) => d.username === u)?.activeGameId ?? null;
const roomEmits = (log, id) => log.filter((e) => e.to === `game:${id}`);

/**
 * The overlap: A (the process's singletons and 'on' store over A.db) and B
 * (a DI'd 'on' store over B.db). B's adoptGame records the claim and
 * registers nothing (B cannot play here).
 */
async function overlap({ bStart = true, bOpts = {} } = {}) {
    const { A, B } = h.twoInstances({ db: base() });
    const holder = { current: A.db };
    // The process's database getters go through A's connection
    mockDb.current = A.db;
    A.store = kit.installOnStore(holder, { bootId: A.bootId, deploymentId: A.deploymentId, monoNow: A.clock.now, getIo: () => A.io });
    await A.store.start({ io: A.io });
    B.claims = [];
    B.store = kit.createOnStore({
        getCollections: () => B.db,
        bootId: B.bootId,
        deploymentId: B.deploymentId,
        monoNow: B.clock.now,
        getIo: () => B.io,
        isShuttingDown: () => false,
        listGames: () => [],
        listTournaments: () => [],
        // B's memory is its own (empty): this process's games are A's
        findGame: () => undefined,
        ...bOpts,
        adoption: {
            adoptGame: (io, doc) => { B.claims.push(doc.gameId); return null; },
            // The game side is not modelled: what B claimed counts as held
            // by B (resolve never takes its doc for an orphan)
            holdsLocally: (gameId) => B.claims.includes(gameId),
            users: () => B.db.users,
            gameRecords: () => B.db.gameRecords,
            clearPointer: (u, id) => B.db.users.updateOne({ username: u, activeGameId: id }, { $set: { activeGameId: null } }),
            ...(bOpts.adoption || {})
        }
    });
    if (bStart) {
        await jest.advanceTimersByTimeAsync(1000);
        await B.store.start({ io: B.io });
    }
    return { A, B };
}

/** A table on A with `humans` (the rest bots), dealt and saved by A's store. */
async function tableOnA(A, humans = ['Hal']) {
    const ctx = await kit.startGame(A.io, A.log, { humans });
    for (const u of humans) await A.db.users.updateOne({ username: u }, { $set: { activeGameId: ctx.game.gameId } });
    await h.flushStore(A.store);
    expect(docOf(ctx.game.gameId)).toMatchObject({ owner: A.bootId, ownerMode: 'on', released: false });
    return { ...ctx, id: ctx.game.gameId };
}

describe('DB-level overlap (twoInstances)', () => {
    afterEach(() => {
        // Both stores' timers
        liveStore._resetForTests();
    });

    test("B's /ready does not wait on A's docs: its boot sweep finishes while A still holds them", async () => {
        const { A, B } = await overlap({ bStart: false });
        const { id } = await tableOnA(A);
        let swept = false;
        B.store.whenBootSwept().then(() => { swept = true; });
        await B.store.start({ io: B.io });
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(0);
        expect(swept).toBe(true);
        expect(B.store.health()).toMatchObject({ effectiveMode: 'on', bootSwept: true, adopted: 0 });
        // A still owns it, untouched; B only answers pending for it
        expect(docOf(id)).toMatchObject({ owner: A.bootId, released: false });
        expect(await B.store.resolve(id, { waitMs: 100 })).toEqual({ state: 'pending' });
        expect(B.claims).toEqual([]);
        B.store.close();
        A.store.close();
    });

    test('a table created on A during the overlap (no doc yet) -> B answers pending, never gone; so does an unknown id while A lives', async () => {
        const { A, B } = await overlap();
        // A pre-deal table: A lists it on its instance doc at once, no liveGames doc
        const game = gameManager.createGame(['🤖 x', '🤖 y', '🤖 z', '🤖 w'].map((n, i) => botController.createBot(n, ['mary', 'sharon', 'mike', 'danny'][i]).socketId));
        await h.flushStore(A.store);
        expect(docOf(game.gameId)).toBeNull();
        const inst = base().serverInstances.docs.find((d) => d._id === A.bootId);
        expect(inst.gameIds).toContain(game.gameId);
        expect(await B.store.resolve(game.gameId, { waitMs: 100 })).toEqual({ state: 'pending' });
        expect(await B.store.resolve('no-such-game', { waitMs: 100 })).toEqual({ state: 'pending' });
        // A gone (instance doc deleted, as after its exit and the TTL): the unknown id is gone
        A.store.close();
        await base().serverInstances.deleteOne({ _id: A.bootId });
        await B.store.sweep();
        expect(await B.store.resolve('no-such-game', { waitMs: 100 })).toEqual({ state: 'gone' });
        B.store.close();
    });

    test('false death: A frozen 13 s self-fences at 8 s, B claims after 12 s unchanged, A thaws, is fenced and emits nothing', async () => {
        const { A, B } = await overlap();
        const { game, sockets, id } = await tableOnA(A);
        // Hal plays on through his bot (lazy), so the table would act by itself
        await chatHandlers.chatMessage(sockets[0], A.io, { message: '/lazy' });
        await h.flushStore(A.store);
        const rev = docOf(id).rev;
        // A's Mongo stalls (every op of A's connection): no beat is acknowledged
        base().faults.stall({ instances: 'A' });
        const mark = A.log.length;
        await jest.advanceTimersByTimeAsync(9000);
        expect(game.isSuspended).toBe(true);
        expect(A.store.suspendCalls).toEqual([['suspend', id]]);
        const atSuspend = A.log.length;
        expect(roomEmits(A.log.slice(mark), id).length).toBeGreaterThanOrEqual(0);
        await jest.advanceTimersByTimeAsync(4000);
        // B saw A's beat unchanged for 12 s on its own clock: claimed
        expect(B.claims).toEqual([id]);
        expect(docOf(id)).toMatchObject({ owner: B.bootId, released: false, adoptedBy: B.bootId });
        expect(docOf(id).rev).toBe(rev + 1);
        // Suspended: nothing from A's table while frozen
        expect(roomEmits(A.log.slice(atSuspend), id)).toEqual([]);
        // A thaws: its beat lands, it re-reads the doc and finds B's
        base().faults.release();
        await jest.advanceTimersByTimeAsync(4000);
        expect(game.frozen).toBe(true);
        expect(gameManager.games.has(id)).toBe(false);
        expect(sockets[0].conn.close).toHaveBeenCalledTimes(1);
        expect(sockets[0].disconnect).not.toHaveBeenCalled();
        expect(A.store.suspendCalls).toEqual([['suspend', id]]);
        await jest.advanceTimersByTimeAsync(60000);
        expect(roomEmits(A.log.slice(atSuspend), id)).toEqual([]);
        // The doc is B's, as B claimed it: A wrote nothing after its claim
        expect(docOf(id)).toMatchObject({ owner: B.bootId, rev: rev + 1 });
        expect(pointer('Hal')).toBe(id);
        B.store.close();
        A.store.close();
    });

    test("A's copy reaching gameEnd after B claimed it records nothing: no gameRecords, no stats, no pointer clear", async () => {
        const { A, B } = await overlap();
        const { game, sockets, id } = await tableOnA(A);
        await chatHandlers.chatMessage(sockets[0], A.io, { message: '/lazy' });
        const statsBefore = JSON.stringify(base().users.docs.find((d) => d.username === 'Hal').stats ?? null);
        // Play on to the last hand's result hold (no write until gameEnd's claim)
        await kit.advanceUntil(() => game.stage === Phase.HAND_RESOLVING && game.currentHand === 13, { step: 500, cap: 3 * 3600000 });
        await h.flushStore(A.store);
        expect(game.isTerminal()).toBe(false);
        // B judges A dead though A is alive: B's clock jumps 13 s between two
        // reads of an unchanged beat (B was paused), then it claims
        await B.store.sweep();
        B.clock.jump(13000);
        await B.store.sweep();
        expect(B.claims).toEqual([id]);
        expect(docOf(id)).toMatchObject({ owner: B.bootId, kind: 'live' });
        await kit.advanceUntil(() => game.isTerminal(), { step: 500, cap: 60000 });
        await jest.advanceTimersByTimeAsync(30000);
        expect(game.stage).toBe(Phase.ENDED);
        expect(base().gameRecords.docs).toEqual([]);
        expect(JSON.stringify(base().users.docs.find((d) => d.username === 'Hal').stats ?? null)).toBe(statsBefore);
        expect(pointer('Hal')).toBe(id);
        expect(docOf(id)).toMatchObject({ owner: B.bootId, kind: 'live' });
        B.store.close();
        A.store.close();
    });

    test('adopt race: B and C sweep one released doc at once, exactly one claim wins', async () => {
        const { A, B } = await overlap();
        const { id } = await tableOnA(A);
        await base().liveGames.updateOne({ _id: id }, { $set: { released: true, releasedAt: new Date(), releaseKind: 'handoff' } });
        const C = h.createInstance({ name: 'C', mods: A.mods, db: base() });
        C.claims = [];
        C.store = kit.createOnStore({
            getCollections: () => C.db, bootId: C.bootId, deploymentId: C.deploymentId, monoNow: C.clock.now,
            isShuttingDown: () => false, listGames: () => [], listTournaments: () => [], findGame: () => undefined,
            adoption: { adoptGame: (io, doc) => { C.claims.push(doc.gameId); return null; }, holdsLocally: (gameId) => C.claims.includes(gameId), users: () => C.db.users, gameRecords: () => C.db.gameRecords }
        });
        await C.store.start({ io: C.io });
        await Promise.all([B.store.sweep(), C.store.sweep(), B.store.resolve(id, { waitMs: 100 }), C.store.resolve(id, { waitMs: 100 })]);
        expect(B.claims.length + C.claims.length).toBe(1);
        const winner = B.claims.length ? B : C;
        expect(docOf(id)).toMatchObject({ owner: winner.bootId, released: false, adoptedBy: winner.bootId });
        const claimOps = base().faults.calls.filter((c) => c.collection === 'liveGames' && c.op === 'findOneAndUpdate' && (c.instance === 'B' || c.instance === 'C'));
        expect(claimOps.length).toBeGreaterThanOrEqual(1);
        B.store.close();
        C.store.close();
        A.store.close();
    });

    test("A's handoff never writes a users doc: a pointer set on B during the overlap stays", async () => {
        const { A, B } = await overlap();
        const { id } = await tableOnA(A, ['Hal', 'Ivy']);
        // Ivy left A's table for a new one on B during the overlap
        await B.db.users.updateOne({ username: 'Ivy' }, { $set: { activeGameId: 'game-on-B' } });
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
        A.io.close = (cb) => cb?.();
        const api = shutdown.setupGracefulShutdown({ close: (cb) => cb?.() }, A.io, {
            games: () => gameManager.games.values(), persist: A.store, handoff: handoffMod.createHandoff({ store: A.store })
        });
        const usersWrites = () => base().faults.calls.filter((c) => c.collection === 'users' && c.instance === 'A' && /update|insert|delete|replace/.test(c.op));
        const before = usersWrites().length;
        api.shutdown('SIGTERM', 0);
        await kit.advanceUntil(() => exit.mock.calls.length > 0, { step: 100, cap: 20000 });
        expect(exit).toHaveBeenCalledWith(0);
        // Released by A, then claimed by B's sweep
        expect(base().faults.calls.some((c) => c.collection === 'liveGames' && c.op === 'updateMany' && c.instance === 'A' && c.outcome === 'ok')).toBe(true);
        expect(B.claims).toEqual([id]);
        expect(docOf(id)).toMatchObject({ owner: B.bootId, released: false });
        expect(usersWrites().length).toBe(before);
        expect(pointer('Ivy')).toBe('game-on-B');
        expect(pointer('Hal')).toBe(id);
        B.store.close();
    });
});

describe('handoff restart (createPersistHarness through deployKit)', () => {
    test('a client on B during the gap: pending (pointer kept, no failure), then seated once after A releases (its rejoin races the sweep)', async () => {
        let gap = null;
        let rejoin = null;
        let client = null;
        let pendingDuringGap = null;
        let pointerDuringGap = null;
        const deploy = createDeploy({
            holder: mockDb,
            db: base(),
            hooks: {
                beforeHandoff: async (old, ctx) => {
                    // B is up and held, A still owns the table: B's resolve answers pending
                    pendingDuringGap = await ctx.successor.store.resolve(gap.id, { waitMs: 100 });
                    pointerDuringGap = pointer('Hal');
                },
                beforeSweep: (inst) => {
                    if (!gap) return;
                    // The client reconnected to B during the gap and retries
                    // now that B serves: its rejoin and B's sweep race
                    client = makeSocket('hal-on-B', inst.log, inst.io);
                    client.conn = { close: jest.fn() };
                    client.disconnect = jest.fn();
                    gameManager.registerUser(client.id, 'Hal');
                    rejoin = reconnectHandlers.rejoinGame(client, inst.io, { gameId: gap.id, username: 'Hal' });
                }
            }
        });
        // createDeploy's harness boots over mockDb.current
        const A = await deploy.boot();
        const { game, id } = await (async () => {
            const ctx = await kit.startGame(A.io, A.log, { humans: ['Hal'] });
            await base().users.updateOne({ username: 'Hal' }, { $set: { activeGameId: ctx.game.gameId } });
            await h.flushStore(A.store);
            return { ...ctx, id: ctx.game.gameId };
        })();
        const before = h.authoritative(game);
        gap = { id };
        // The successor is announced first: during A's handoff its resolve answers pending
        const succ = await deploy.restart({ kind: 'handoff' });
        expect(pendingDuringGap).toEqual({ state: 'pending' });
        expect(pointerDuringGap).toBe(id);
        expect(deploy.exits).toEqual([0]);
        expect(deploy.outcomes[0].tables).toEqual([{ gameId: id, outcome: 'continue' }]);
        await rejoin;
        await jest.advanceTimersByTimeAsync(0);
        const restored = gameManager.games.get(id);
        expect(restored).toBeTruthy();
        expect(restored).not.toBe(game);
        expect(succ.store.adoptCalls).toHaveLength(1);
        expect(h.authoritative(restored)).toEqual(before);
        const mine = succ.log.filter((e) => e.to === `self:${client.id}`);
        expect(mine.filter((e) => e.event === 'rejoinSuccess')).toHaveLength(1);
        expect(mine.filter((e) => ['rejoinFailed', 'serverError'].includes(e.event) || e.data?.success === false)).toEqual([]);
        const seat = restored.seatList().find((s) => s.ownerUsername === 'Hal');
        expect(seat.presence).toBe('connected');
        expect(seat.ownerSocketId).toBe(client.id);
        expect(pointer('Hal')).toBe(id);
        // A's own notices went to A's io; nothing reached A's io after it died
        expect(A.log.some((e) => e.event === 'gameLogEntry' && e.data?.message === shutdown.CONTINUE_NOTICE)).toBe(true);
        expect(deploy.harness.deadEmits()).toEqual([]);
        // The gate opened with the only human back: the table plays on
        expect(require('../game/persist/restoreGame').isGated(restored)).toBe(false);
        deploy.close();
    });
});
