/**
 * The SIGTERM handoff and the crash release (deploy survival PR 5;
 * server/utils/shutdown.js with opts.handoff = persist/handoff.js, the
 * plan's 2.4), LIVE_PERSIST=on with the unique gameId index, casual games,
 * the real shutdown.js (process.exit stubbed) over real games and
 * persistHarness's liveDb:
 *   over a real Socket.IO server: serverShutdown at t=0, then one
 *   outcome-matched line per table, then the transport close by 6.5 s,
 *   exit 0 (exit 1 on a crash, with the crash text); a client event sent
 *   during the handoff is dropped (the socket.use gate);
 *   over a recording io (fake timers), every bullet of the plan's list:
 *   released at the last rev and only for acknowledged ids, no write as A
 *   after the release, no seatDisconnect for a frozen table, the successor
 *   check before any release, one table's final write failing, a tainted
 *   table, an insert in flight at SIGTERM (awaited; or never released
 *   unacknowledged), a stalled replaceOne cut at the flush bound, no
 *   successor / an 'off' or 'write' one (today's line, docs deleted), no
 *   adoption by A during its own shutdown, an adoption in flight frozen
 *   and released, a rejoin whose auth spans SIGTERM clearing no pointer,
 *   the crash path (no serialize, writers closed, release <= 2 s, the
 *   crash text by outcome, exit 1), SIGINT like SIGTERM.
 * restoreGame.adoptGame, isGated and suspend are the real ones (liveStoreKit.installOnStore).
 */

const mockDb = { current: null };
jest.mock('../database', () => require('../testUtils/persistHarness').databaseMock(mockDb));

const http = require('http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const h = require('../testUtils/persistHarness');
const kit = require('../testUtils/liveStoreKit');
const { makeIo, makeSocket, mulberry32 } = require('../testUtils/gameDriver');
const gameManager = require('../game/GameManager');
const { botController } = require('../game/bot');
const { Phase } = require('../game/GamePhase');
const liveStore = require('../game/persist/liveStore');
const gameCodec = require('../game/persist/gameCodec');
const handoffMod = require('../game/persist/handoff');
const shutdown = require('../utils/shutdown');
const profileHandlers = require('../socket/profileHandlers');
const queueHandlers = require('../socket/queueHandlers');
const reconnectHandlers = require('../socket/reconnectHandlers');
const gameLifecycle = require('../socket/gameLifecycle');
const gameHandlers = require('../socket/gameHandlers');
const pacing = require('../game/pacing');
const { issueSession } = require('../utils/sessionTokens');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../utils/logger');

const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];

let realRandom;
let exit;
let before;
let savedExitCode;

function quiet() {
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
}

function commonBefore() {
    realRandom = Math.random;
    Math.random = mulberry32(31);
    before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
    savedExitCode = process.exitCode;
    exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    mockDb.current = h.liveDb();
    quiet();
}

function commonAfter() {
    for (const s of SIGNALS) {
        for (const fn of process.listeners(s)) if (!before[s].includes(fn)) process.removeListener(s, fn);
    }
    process.exitCode = savedExitCode;
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    shutdown._resetShutdownStateForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    Math.random = realRandom;
}

const db = () => mockDb.current;
const doc = (id) => kit.savedGame(db(), id);
const signal = (name) => process.listeners(name).find((fn) => !before[name].includes(fn))();

/** A fresh 'on' successor's instance doc (B, started after A). */
function successor({ mode = 'on', beatAgoMs = 0, shuttingDown = false } = {}) {
    db().serverInstances._insert({
        _id: 'boot-B', deploymentId: 'dep-B', mode, startedAt: new Date(Date.now() + 1000),
        beatAt: new Date(Date.now() - beatAgoMs), beatSeq: 1, shuttingDown, gameIds: []
    });
}

describe('over a recording io (fake timers)', () => {
    let io;
    let log;
    let order;

    beforeEach(() => {
        commonBefore();
        jest.useFakeTimers();
        log = [];
        order = [];
        io = makeIo(log);
        const push = log.push.bind(log);
        log.push = (...items) => {
            for (const e of items) if (['gameLogEntry', 'serverShutdown', 'playerDisconnected'].includes(e.event)) order.push(e.event === 'gameLogEntry' ? `line:${e.to}:${e.data.message}` : `emit:${e.event}`);
            return push(...items);
        };
        io.close = jest.fn((cb) => { order.push('io.close'); cb?.(); });
    });

    afterEach(() => {
        commonAfter();
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    async function bootA({ handoffDeps = {}, ...opts } = {}) {
        const store = kit.installOnStore(mockDb, { bootId: 'boot-A', getIo: () => io, monoNow: h.createMonoClock().now, ...opts });
        await store.start({ io });
        await h.flushStore(store);
        const handoff = handoffMod.createHandoff({ store, ...handoffDeps });
        shutdown.setupGracefulShutdown({ close: jest.fn((cb) => cb?.()) }, io, { games: () => gameManager.games.values(), persist: store, handoff });
        return { store, handoff };
    }

    async function table(store, humans = ['Hal']) {
        const { game, sockets } = await kit.startGame(io, log, { humans });
        for (const u of humans) await db().users.updateOne({ username: u }, { $set: { activeGameId: game.gameId } });
        await h.flushStore(store);
        expect(doc(game.gameId)).toMatchObject({ owner: store.bootId, ownerMode: 'on' });
        return { game, sockets, id: game.gameId };
    }

    const lineOf = (id) => order.filter((o) => o.startsWith(`line:game:${id}:`)).map((o) => o.slice(`line:game:${id}:`.length));
    const opsAfter = (pred) => {
        const calls = db().faults.calls;
        const at = calls.findIndex(pred);
        return at < 0 ? [] : calls.slice(at + 1);
    };
    const isRelease = (c) => c.collection === 'liveGames' && c.op === 'updateMany' && c.outcome === 'ok';

    test('successor: serverShutdown first, the final state released at the last rev, CONTINUE (next seq, not stored), no write as A after it, no seatDisconnect, io.close, exit 0', async () => {
        const { store } = await bootA();
        const { game, sockets, id } = await table(store);
        successor();
        const finalState = gameCodec.serialize(game);
        const revBefore = doc(id).rev;
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + 10);
        expect(order[0]).toBe('emit:serverShutdown');
        expect(lineOf(id)).toEqual([shutdown.CONTINUE_NOTICE]);
        const line = log.find((e) => e.event === 'gameLogEntry' && e.data.message === shutdown.CONTINUE_NOTICE);
        // The next seq after the last one the table sent (no gap), never stored
        expect(line.data).toEqual({ message: shutdown.CONTINUE_NOTICE, type: 'system', seq: finalState.state.eventSeq + 1 });
        expect(game.gameLog.some((e) => e.message === shutdown.CONTINUE_NOTICE)).toBe(false);
        expect(order.indexOf('io.close')).toBeGreaterThan(order.indexOf(`line:game:${id}:${shutdown.CONTINUE_NOTICE}`));
        const saved = doc(id);
        expect(saved).toMatchObject({ owner: 'boot-A', ownerMode: 'on', released: true, releasedAt: expect.any(Date), releaseKind: 'handoff', rev: revBefore + 1 });
        expect(kit.comparable(saved)).toEqual(kit.comparable(finalState));
        // Nothing written as A after the release
        expect(opsAfter(isRelease).filter((c) => ['liveGames', 'liveTournaments'].includes(c.collection) && ['updateOne', 'replaceOne', 'insertOne', 'updateMany'].includes(c.op))).toEqual([]);
        expect(game.frozen).toBe(true);
        expect(gameManager.games.has(id)).toBe(false);
        // io.close's disconnect finds no seat: no seatDisconnect, no broadcast
        const seat = game.seatList().find((s) => s.ownerUsername === 'Hal');
        await queueHandlers.handleDisconnect(sockets[0], io);
        expect(game.seat(seat.position).presence).toBe(seat.presence);
        expect(order.filter((o) => o === 'emit:playerDisconnected')).toEqual([]);
        // The pointer stays for the successor
        expect(db().users.docs.find((u) => u.username === 'Hal').activeGameId).toBe(id);
        await jest.advanceTimersByTimeAsync(shutdown.SETTLE_MS + 100);
        expect(exit).toHaveBeenCalledWith(0);
        expect(store.closed).toBe(true);
        expect(db().serverInstances.docs.find((d) => d._id === 'boot-A').shuttingDown).toBe(true);
    });

    test('SIGINT behaves like SIGTERM', async () => {
        const { store } = await bootA();
        const { id } = await table(store);
        successor();
        signal('SIGINT');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(exit).toHaveBeenCalledWith(0);
        expect(lineOf(id)).toEqual([shutdown.CONTINUE_NOTICE]);
        expect(doc(id).released).toBe(true);
    });

    test('the successor check comes before any release: its read fails -> nothing released, docs deleted, today\'s line', async () => {
        const { store } = await bootA();
        const { id } = await table(store);
        successor();
        db().faults.fail({ collections: 'serverInstances', ops: 'find' });
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(db().faults.calls.filter((c) => c.collection === 'liveGames' && ['updateMany', 'replaceOne'].includes(c.op))).toEqual([]);
        expect(doc(id)).toBeNull();
        expect(lineOf(id)).toEqual([shutdown.GAME_NOTICE]);
        expect(exit).toHaveBeenCalledWith(0);
    });

    test.each([
        ['no successor', () => {}],
        ["an 'off' successor (no instance doc)", () => {}],
        ["a 'write' successor", () => successor({ mode: 'write' })],
        ['a stale successor', () => successor({ beatAgoMs: 60000 })],
        ['a successor already shutting down', () => successor({ shuttingDown: true })],
    ])('%s: today\'s line, docs deleted, never released', async (_why, setupSuccessor) => {
        const { store } = await bootA();
        const { id } = await table(store);
        setupSuccessor();
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(doc(id)).toBeNull();
        expect(lineOf(id)).toEqual([shutdown.GAME_NOTICE]);
        expect(db().faults.calls.some((c) => c.collection === 'liveGames' && c.op === 'updateMany')).toBe(false);
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('no successor and the delete not acknowledged: UNKNOWN', async () => {
        const { store } = await bootA();
        const { id } = await table(store);
        db().faults.fail({ collections: 'liveGames', ops: 'deleteMany' });
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(lineOf(id)).toEqual([shutdown.UNKNOWN_NOTICE]);
        expect(doc(id)).toMatchObject({ released: false });
    });

    test('one table\'s final write fails while the other\'s lands: that one is deleted with today\'s line, the other continues; if the delete fails too, UNKNOWN', async () => {
        for (const deleteFails of [false, true]) {
            const { store } = await bootA();
            const t1 = await table(store, ['Hal']);
            const t2 = await table(store, ['Ann']);
            successor();
            db().faults.fail({ collections: 'liveGames', ops: 'replaceOne', times: 1 });
            if (deleteFails) db().faults.fail({ collections: 'liveGames', ops: 'deleteMany' });
            signal('SIGTERM');
            await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
            const failedId = db().faults.calls.filter((c) => c.op === 'replaceOne').length && [t1.id, t2.id].find((id) => !doc(id)?.released);
            const okId = failedId === t1.id ? t2.id : t1.id;
            expect(doc(okId)).toMatchObject({ released: true });
            expect(lineOf(okId)).toEqual([shutdown.CONTINUE_NOTICE]);
            if (deleteFails) {
                expect(doc(failedId)).toMatchObject({ released: false });
                expect(lineOf(failedId)).toEqual([shutdown.UNKNOWN_NOTICE]);
            } else {
                expect(doc(failedId)).toBeNull();
                expect(lineOf(failedId)).toEqual([shutdown.GAME_NOTICE]);
            }
            commonAfter();
            jest.clearAllTimers();
            jest.restoreAllMocks();
            commonBefore();
            log.length = 0;
            order.length = 0;
        }
    });

    test('a tainted table (serialize null) is deleted, never released; a pre-deal table gets today\'s line', async () => {
        const { store } = await bootA();
        const { game, id } = await table(store);
        const { game: preDeal } = await kit.startGame(io, log, { humans: ['Ann'], until: () => true });
        expect(preDeal.stage).toBe(Phase.DRAWING);
        successor();
        game.markTainted(true);
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(doc(id)).toBeNull();
        expect(lineOf(id)).toEqual([shutdown.GAME_NOTICE]);
        expect(lineOf(preDeal.gameId)).toEqual([shutdown.GAME_NOTICE]);
        expect(db().faults.calls.filter((c) => c.op === 'replaceOne')).toEqual([]);
    });

    test('a table the holder self-fence suspended (a Mongo blip at SIGTERM) keeps its saved doc: released as it is, never deleted, UNKNOWN', async () => {
        const { store } = await bootA();
        const { game, id } = await table(store);
        // No heartbeat acknowledged for 8 s: the table is suspended (not saveable)
        db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
        await jest.advanceTimersByTimeAsync(liveStore.SELF_FENCE_MS + liveStore.HEARTBEAT_MS);
        expect(game.isSuspended).toBe(true);
        await h.flushStore(store);
        const saved = kit.comparable(doc(id));
        const revBefore = doc(id).rev;
        expect(gameCodec.serialize(game)).toBeNull();
        successor();
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(doc(id)).toMatchObject({ owner: 'boot-A', released: true, releaseKind: 'handoff', rev: revBefore });
        expect(kit.comparable(doc(id))).toEqual(saved);
        expect(lineOf(id)).toEqual([shutdown.UNKNOWN_NOTICE]);
        expect(db().faults.calls.filter((c) => c.op === 'replaceOne')).toEqual([]);
        // The settle step waited out its bound (the stalled shutting-down mark)
        await jest.advanceTimersByTimeAsync(handoffMod.HANDOFF_SETTLE_MS);
        expect(exit).toHaveBeenCalledWith(0);
        db().faults.release();
    });

    test('a suspended table whose doc another instance adopted meanwhile: the release leaves that doc alone', async () => {
        const { store } = await bootA();
        const { game, id } = await table(store);
        db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
        await jest.advanceTimersByTimeAsync(liveStore.SELF_FENCE_MS + liveStore.HEARTBEAT_MS);
        expect(game.isSuspended).toBe(true);
        db().liveGames.docs.find((d) => d._id === id).owner = 'boot-C';
        successor();
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(doc(id)).toMatchObject({ owner: 'boot-C', released: false });
        expect(lineOf(id)).toEqual([shutdown.UNKNOWN_NOTICE]);
        db().faults.release();
    });

    test('a routine update still in flight past the settle bound cannot land over the final write: the released doc is the final state, no line twice', async () => {
        const { store } = await bootA();
        const { game, id } = await table(store);
        successor();
        // A routine update goes out and stalls (a slow primary)
        db().faults.stall({ collections: 'liveGames', ops: 'updateOne' });
        game.addLogEntry('a line in flight at SIGTERM', null, 'system');
        await jest.advanceTimersByTimeAsync(5);
        expect(db().faults.stalledCount()).toBe(1);
        const finalState = gameCodec.serialize(game);
        // It applies late: right after the handoff's final write, before the release
        const coll = db().liveGames;
        const replaceOne = coll.replaceOne.bind(coll);
        coll.replaceOne = async (...args) => {
            const r = await replaceOne(...args);
            db().faults.release();
            for (let i = 0; i < 50; i++) await Promise.resolve();
            return r;
        };
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(db().faults.calls.some((c) => c.collection === 'liveGames' && c.op === 'updateOne' && c.outcome === 'ok')).toBe(true);
        const saved = doc(id);
        expect(saved).toMatchObject({ released: true, releaseKind: 'handoff' });
        expect(kit.comparable(saved)).toEqual(kit.comparable(finalState));
        const lines = saved.log.map((e) => JSON.stringify(e));
        expect(new Set(lines).size).toBe(lines.length);
        expect(lineOf(id)).toEqual([shutdown.CONTINUE_NOTICE]);
        expect(store).toBeTruthy();
    });

    test('a routine update that applies only after the release changes nothing and fences nothing (no early engine-close)', async () => {
        const { store } = await bootA();
        const { game, sockets, id } = await table(store);
        successor();
        db().faults.stall({ collections: 'liveGames', ops: 'updateOne' });
        game.addLogEntry('a line in flight at SIGTERM', null, 'system');
        await jest.advanceTimersByTimeAsync(5);
        const finalState = gameCodec.serialize(game);
        const coll = db().liveGames;
        const updateMany = coll.updateMany.bind(coll);
        coll.updateMany = async (...args) => {
            const r = await updateMany(...args);
            db().faults.release();
            for (let i = 0; i < 50; i++) await Promise.resolve();
            return r;
        };
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(kit.comparable(doc(id))).toEqual(kit.comparable(finalState));
        expect(doc(id)).toMatchObject({ released: true });
        expect(lineOf(id)).toEqual([shutdown.CONTINUE_NOTICE]);
        expect(sockets[0].conn.close).not.toHaveBeenCalled();
        expect(store.logs.some((l) => /fenced/.test(l.msg))).toBe(false);
    });

    test('an insert in flight at SIGTERM is awaited in the settle step, then handed off', async () => {
        const { store } = await bootA();
        db().faults.stall({ collections: 'liveGames', ops: 'insertOne' });
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await jest.advanceTimersByTimeAsync(5);
        expect(doc(game.gameId)).toBeNull();
        successor();
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(100);
        db().faults.release();
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 1000);
        expect(doc(game.gameId)).toMatchObject({ released: true });
        expect(lineOf(game.gameId)).toEqual([shutdown.CONTINUE_NOTICE]);
        expect(store).toBeTruthy();
    });

    test('an insert never acknowledged is never released: UNKNOWN (it may still land)', async () => {
        await bootA();
        db().faults.stall({ collections: 'liveGames', ops: 'insertOne' });
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        await jest.advanceTimersByTimeAsync(5);
        successor();
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + handoffMod.FLUSH_MS + 1000);
        expect(lineOf(game.gameId)).toEqual([shutdown.UNKNOWN_NOTICE]);
        expect(db().faults.calls.filter((c) => c.op === 'replaceOne')).toEqual([]);
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('a stalled replaceOne is cut at the flush bound: the table is deleted (today\'s line), io.close by 6.5 s, exit 0', async () => {
        await bootA();
        const t = Date.now();
        const { id } = await table(liveStore.getLiveStore());
        successor();
        db().faults.stall({ collections: 'liveGames', ops: 'replaceOne' });
        const t0 = Date.now();
        signal('SIGTERM');
        let closedAt = null;
        io.close.mockImplementation((cb) => { closedAt = Date.now(); order.push('io.close'); cb?.(); });
        await jest.advanceTimersByTimeAsync(shutdown.HANDOFF_SPAN_MS + shutdown.SETTLE_MS + 7000);
        expect(closedAt).not.toBeNull();
        expect(closedAt - t0).toBeLessThanOrEqual(shutdown.HANDOFF_SPAN_MS);
        expect(doc(id)).toBeNull();
        expect(lineOf(id)).toEqual([shutdown.GAME_NOTICE]);
        expect(exit).toHaveBeenCalledWith(0);
        expect(t).toBeLessThanOrEqual(t0);
        db().faults.release();
    });

    test('A never adopts during its own shutdown (booted < 3 min ago, 1 s sweep running)', async () => {
        const { store } = await bootA();
        const { id } = await table(store);
        const copy = kit.plain(doc(id));
        successor();
        signal('SIGTERM');
        // Another instance's released doc appears while A shuts down
        db().liveGames._insert({ ...copy, _id: 'g-foreign', owner: 'boot-X', released: true, releasedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
        await jest.advanceTimersByTimeAsync(5000);
        expect(store.adoptCalls).toHaveLength(0);
        expect(doc('g-foreign')).toMatchObject({ owner: 'boot-X', released: true });
        await expect(store.resolve('g-foreign')).resolves.toEqual({ state: 'pending' });
    });

    test('an adoption in flight at SIGTERM finishes in the settle step and is frozen and released with the rest', async () => {
        // B's released table, which A (started after it) adopts
        const { store: first } = await bootA({ bootId: 'boot-Old' });
        const { id } = await table(first);
        await db().liveGames.updateOne({ _id: id }, { $set: { released: true, releasedAt: new Date(), releaseKind: 'handoff' } });
        first.close();
        for (const s of SIGNALS) for (const fn of process.listeners(s)) if (!before[s].includes(fn)) process.removeListener(s, fn);
        gameManager._resetForTests();
        botController._resetForTests();
        await jest.advanceTimersByTimeAsync(1000);
        db().faults.stall({ collections: 'liveGames', ops: 'findOneAndUpdate' });
        const { store } = await bootA();
        await jest.advanceTimersByTimeAsync(5);
        expect(db().faults.stalledCount()).toBe(1);
        successor();
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(100);
        db().faults.release();
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 1000);
        expect(store.adoptCalls).toHaveLength(1);
        // The final write keeps the adoption's fields (the crash-loop count lives on)
        expect(doc(id)).toMatchObject({ owner: 'boot-A', released: true, releaseKind: 'handoff', adoptedBy: 'boot-A', adoptAttempts: 1 });
        // The adoption's own line (restoreGame.adoptGame), then the handoff's
        expect(lineOf(id)).toEqual([require('../game/persist/adopt').RESUMED_LINE, shutdown.CONTINUE_NOTICE]);
    });

    describe('an adoption claim that lands only after the settle bound (the store closed)', () => {
        async function lateClaim({ withSuccessor = true, stallGiveBack = false } = {}) {
            const { store: first } = await bootA({ bootId: 'boot-Old' });
            const { id } = await table(first);
            await db().liveGames.updateOne({ _id: id }, { $set: { released: true, releasedAt: new Date(), releaseKind: 'handoff' } });
            first.close();
            for (const s of SIGNALS) for (const fn of process.listeners(s)) if (!before[s].includes(fn)) process.removeListener(s, fn);
            gameManager._resetForTests();
            botController._resetForTests();
            await jest.advanceTimersByTimeAsync(1000);
            db().faults.stall({ collections: 'liveGames', ops: 'findOneAndUpdate' });
            const { store } = await bootA();
            await jest.advanceTimersByTimeAsync(5);
            expect(db().faults.stalledCount()).toBe(1);
            if (withSuccessor) successor();
            // The claim lands (and is answered) just before the handoff's delete
            const coll = db().liveGames;
            const deleteMany = coll.deleteMany.bind(coll);
            let landed = false;
            coll.deleteMany = async (...args) => {
                if (!landed) {
                    landed = true;
                    if (stallGiveBack) db().faults.stall({ collections: 'liveGames', ops: 'updateOne' });
                    db().faults.release();
                    if (stallGiveBack) db().faults.stall({ collections: 'liveGames', ops: 'updateOne' });
                    for (let i = 0; i < 50; i++) await Promise.resolve();
                }
                return deleteMany(...args);
            };
            signal('SIGTERM');
            await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 1000);
            expect(landed).toBe(true);
            expect(store.adoptCalls).toHaveLength(0);
            return { id };
        }

        test.each([[true], [false]])('successor %s: the claimed doc is handed straight back (released), never deleted', async (withSuccessor) => {
            const { id } = await lateClaim({ withSuccessor });
            expect(doc(id)).toMatchObject({ owner: 'boot-A', kind: 'live', released: true, releaseKind: 'handoff' });
            db().faults.release();
        });

        test('the give-back still in flight at the delete: the doc is not deleted either', async () => {
            const { id } = await lateClaim({ stallGiveBack: true });
            expect(doc(id)).toMatchObject({ owner: 'boot-A', kind: 'live' });
            db().faults.release();
            await jest.advanceTimersByTimeAsync(10);
            expect(doc(id)).toMatchObject({ owner: 'boot-A', released: true, releaseKind: 'handoff' });
        });
    });

    test('a rejoinGame whose auth await spans SIGTERM clears no pointer and sends no failure', async () => {
        const { store } = await bootA();
        const { id } = await table(store);
        successor();
        const user = db().users.docs.find((u) => u.username === 'Hal');
        const session = issueSession(user);
        await db().users.updateOne({ username: 'Hal' }, session.update);
        const s = makeSocket('h-reload', log, io);
        db().faults.stall({ collections: 'users', ops: 'findOne' });
        const rejoin = reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal', sessionToken: session.token });
        await jest.advanceTimersByTimeAsync(1);
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(10);
        db().faults.release();
        await rejoin;
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(db().users.docs.find((u) => u.username === 'Hal').activeGameId).toBe(id);
        expect(log.filter((e) => e.to === 'self:h-reload' && e.event === 'rejoinFailed')).toEqual([]);
    });

    describe('the crash path (uncaughtException)', () => {
        test('never serializes; writers closed; one release of every doc; the crash-released text; pre-deal tables CRASH_NOTICE; exit 1', async () => {
            const serialize = jest.fn(gameCodec.serialize);
            const { store } = await bootA({ handoffDeps: { serialize } });
            const { game, id } = await table(store);
            const { game: preDeal } = await kit.startGame(io, log, { humans: ['Ann'], until: () => true });
            const h1 = process.listeners('uncaughtException').find((fn) => !before.uncaughtException.includes(fn));
            const writesBefore = db().faults.calls.filter((c) => c.collection === 'liveGames' && ['insertOne', 'updateOne', 'replaceOne'].includes(c.op)).length;
            h1(new Error('kaboom'));
            await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
            expect(serialize).not.toHaveBeenCalled();
            expect(order[0]).toBe('emit:serverShutdown');
            expect(lineOf(id)).toEqual([shutdown.CRASH_RELEASED_NOTICE]);
            expect(lineOf(preDeal.gameId)).toEqual([shutdown.CRASH_NOTICE]);
            expect(doc(id)).toMatchObject({ released: true, releaseKind: 'crash', owner: 'boot-A' });
            expect(db().faults.calls.filter((c) => c.collection === 'liveGames' && ['insertOne', 'updateOne', 'replaceOne'].includes(c.op)).length).toBe(writesBefore);
            expect(game.frozen).toBe(true);
            // The crash notice was never saved (writers closed first)
            expect(doc(id).log.some((e) => e.message === shutdown.CRASH_RELEASED_NOTICE)).toBe(false);
            expect(exit).toHaveBeenCalledWith(1);
        });

        test('a release that stalls is cut at 2 s: the UNKNOWN crash text, exit 1', async () => {
            const { store } = await bootA();
            const { id } = await table(store);
            db().faults.stall({ collections: 'liveGames', ops: 'updateMany' });
            const h1 = process.listeners('uncaughtException').find((fn) => !before.uncaughtException.includes(fn));
            h1(new Error('kaboom'));
            await jest.advanceTimersByTimeAsync(handoffMod.CRASH_RELEASE_MS - 1);
            expect(lineOf(id)).toEqual([]);
            await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
            expect(lineOf(id)).toEqual([shutdown.CRASH_UNKNOWN_NOTICE]);
            expect(exit).toHaveBeenCalledWith(1);
            db().faults.release();
        });
    });

    test('effective write (the unique index missing): handoff.enabled() is false and today\'s path runs (notice first, then self-delete)', async () => {
        const { store } = await bootA({ gameIdIndexUnique: () => false });
        expect(store.effectiveMode).toBe('write');
        const { id } = await table2();
        async function table2() {
            const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
            await h.flushStore(store);
            return { id: game.gameId };
        }
        successor();
        signal('SIGTERM');
        await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS + 100);
        expect(order.slice(0, 2)).toEqual([`line:game:${id}:${shutdown.GAME_NOTICE}`, 'emit:serverShutdown']);
        expect(doc(id)).toBeNull();
        expect(exit).toHaveBeenCalledWith(0);
    });
});

describe('over a real Socket.IO server', () => {
    let server;
    let io;
    let clients;

    beforeEach(() => {
        commonBefore();
        pacing.setPacingForTests('zero');
        clients = [];
    });

    afterEach(async () => {
        for (const c of clients) c.close();
        io?.close();
        await new Promise((resolve) => server.close(() => resolve()));
        commonAfter();
        jest.restoreAllMocks();
    });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function until(pred, ms = 8000) {
        const end = Date.now() + ms;
        while (!pred()) {
            if (Date.now() > end) throw new Error('until: timed out');
            await sleep(10);
        }
    }

    test.each([
        ['SIGTERM', 0, shutdown.CONTINUE_NOTICE, () => signal('SIGTERM')],
        ['a crash', 1, shutdown.CRASH_RELEASED_NOTICE, (hs) => hs.onUncaughtException(new Error('boom'))]
    ])('%s: the seated client gets serverShutdown, then the outcome line, then the transport close by 6.5 s; a chat sent meanwhile is dropped', async (_why, code, line, trigger) => {
        server = http.createServer();
        io = new Server(server);
        const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
        const serverSockets = [];
        const chat = jest.fn();
        io.on('connection', (socket) => {
            serverSockets.push(socket);
            socket.on('chatMessage', chat);
        });
        const store = kit.installOnStore(mockDb, { bootId: 'boot-A', getIo: () => io });
        await store.start({ io });
        const handlers = shutdown.setupGracefulShutdown(server, io, {
            games: () => gameManager.games.values(), persist: store, handoff: handoffMod.createHandoff({ store })
        });

        const seen = [];
        const c = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
        clients.push(c);
        const t = { start: null };
        const at = () => (t.start === null ? null : Date.now() - t.start);
        c.on('gameLogEntry', (d) => seen.push(['gameLogEntry', d.message, at()]));
        c.on('serverShutdown', () => seen.push(['serverShutdown', null, at()]));
        c.on('disconnect', (reason) => seen.push(['disconnect', reason, at()]));
        await new Promise((resolve) => c.on('connect', resolve));
        await until(() => serverSockets.length === 1);
        const sock = serverSockets[0];

        db().users._insert({ username: 'Hal', profilePic: 3 });
        gameManager.registerUser(sock.id, 'Hal');
        const bots = [1, 2, 3].map((i) => botController.createBot(`🤖 P${i}`, ['mary', 'sharon', 'mike'][i - 1]));
        const game = gameManager.createGame([sock.id, ...bots.map((b) => b.socketId)]);
        bots.forEach((b) => botController.registerBot(game.gameId, b));
        gameLifecycle.beginDraw(io, game);
        gameHandlers.draw(sock, io, { num: 0 });
        await until(() => game.stage === Phase.BIDDING || game.stage === Phase.PLAYING);
        await until(() => kit.savedGame(db(), game.gameId) !== null);
        // As the lobby / queue start does: the seated socket is in the table's room
        sock.join(game.roomName);
        successor();
        const logBefore = game.gameLog.length;

        t.start = Date.now();
        trigger(handlers);
        await until(() => seen.some((s) => s[0] === 'serverShutdown'));
        // A chat sent during the handoff: dropped by the gate
        c.emit('chatMessage', { message: 'sent during the flush' });
        await until(() => exit.mock.calls.length > 0, 20000);
        expect(exit).toHaveBeenCalledWith(code);
        const after = seen.filter((s) => s[2] !== null);
        const kinds = after.map((s) => s[0]);
        expect(kinds).toEqual(['serverShutdown', 'gameLogEntry', 'disconnect']);
        seen.splice(0, seen.length, ...after);
        expect(seen[1][1]).toBe(line);
        expect(seen[2][1]).toBe('transport close');
        expect(seen[2][2]).toBeLessThanOrEqual(shutdown.HANDOFF_SPAN_MS);
        // The gate: the event never reached a handler
        expect(chat).not.toHaveBeenCalled();
        expect(game.gameLog.length).toBe(logBefore);
        expect(kit.savedGame(db(), game.gameId)).toMatchObject({ released: true, releaseKind: code === 0 ? 'handoff' : 'crash' });
    }, 30000);
});
