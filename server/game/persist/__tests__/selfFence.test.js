/**
 * The holder side of liveness in LIVE_PERSIST=on (deploy survival PR 5;
 * persist/liveStore.js, the plan's 2.1 "Holder self-fence" and 2.3 fence):
 *   - 8 s on this process's monotonic clock without an acknowledged
 *     heartbeat suspends every casual table with a saved doc (game.suspend,
 *     STUBBED here: the GAME builder's reversible fence), and nothing of it
 *     is written meanwhile;
 *   - the next good beat re-takes each doc with a compare-and-set write
 *     (owner me, live, not released -> rev + 1): matched -> unsuspend and
 *     the held change is written; adopted elsewhere -> fenced (frozen,
 *     retired from GameManager with no emit, its sockets engine-closed, a
 *     later terminal claim answers 'fenced'); a re-take that fails keeps
 *     it suspended until the next beat; an adopter's claim landing right
 *     after the re-take fails (the rev moved), so only one owner acts;
 *   - a frozen holder that thaws runs the self-fence check before any
 *     overdue game timer, pause or bot action (persist/hooks.beforeRun);
 *   - a fenced copy that reaches gameEnd records no stats, clears no
 *     pointer and writes no tombstone (the adopter owns the end);
 *   - a late heartbeat never moves beatSeq back.
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const { makeIo, mulberry32 } = require('../../../testUtils/gameDriver');
const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const liveStore = require('../liveStore');
const chatHandlers = require('../../../socket/chatHandlers');
const profileHandlers = require('../../../socket/profileHandlers');
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
    log = [];
    io = makeIo(log);
});

afterEach(() => {
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const liveUpdates = () => db().faults.calls.filter((c) => c.collection === 'liveGames' && c.op === 'updateOne' && c.outcome !== 'stalled').length;

async function onTable({ humans = ['Hal'] } = {}) {
    const mono = h.createMonoClock();
    const store = kit.installOnStore(mockDb, { bootId: 'boot-A', getIo: () => io, monoNow: mono.now });
    const startedAt = Date.now();
    await store.start({ io });
    const { game, sockets } = await kit.startGame(io, log, { humans });
    await db().users.updateOne({ username: 'Hal' }, { $set: { activeGameId: game.gameId } });
    await h.flushStore(store);
    return { store, game, sockets, id: game.gameId, mono, startedAt };
}

test('no acknowledged beat for 8 s: the table is suspended and not written; the next beat finds it still ours: unsuspended, the held change written', async () => {
    const { store, game, id } = await onTable();
    db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
    await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS * 2);
    expect(store.suspendCalls).toEqual([]);
    await jest.advanceTimersByTimeAsync(liveStore.SELF_FENCE_MS);
    expect(store.suspendCalls).toEqual([['suspend', id]]);
    expect(store.selfFenced).toBe(true);
    const writes = liveUpdates();
    game.addLogEntry('a change while fenced', null, 'system');
    await jest.advanceTimersByTimeAsync(5);
    expect(liveUpdates()).toBe(writes);
    db().faults.release();
    await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS + 10);
    await h.flushStore(store);
    expect(store.suspendCalls).toEqual([['suspend', id], ['unsuspend', id]]);
    expect(store.selfFenced).toBe(false);
    expect(kit.savedGame(db(), id).log.at(-1).message).toBe('a change while fenced');
    expect(gameManager.games.get(id)).toBe(game);
});

test('adopted elsewhere meanwhile: fenced at recovery: frozen, retired with no emit, sockets engine-closed, a later claim fenced', async () => {
    const { store, game, sockets, id } = await onTable();
    db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
    await jest.advanceTimersByTimeAsync(liveStore.SELF_FENCE_MS + liveStore.HEARTBEAT_MS);
    expect(store.suspendCalls).toEqual([['suspend', id]]);
    // B adopted it (its compare-and-set); B is alive (beating) from now on
    db().liveGames.docs.find((d) => d._id === id).owner = 'boot-B';
    db().serverInstances._insert({ _id: 'boot-B', mode: 'on', startedAt: new Date(), beatAt: new Date(), beatSeq: 1, shuttingDown: false });
    db().faults.release();
    await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS + 10);
    await h.flushStore(store);
    const emitted = log.length;
    expect(game.frozen).toBe(true);
    expect(gameManager.games.has(id)).toBe(false);
    expect(sockets[0].conn.close).toHaveBeenCalledTimes(1);
    expect(sockets[0].disconnect).not.toHaveBeenCalled();
    expect(store.suspendCalls).toEqual([['suspend', id]]);
    expect(store.claimable(game)).toBe(true);
    await expect(store.claimEnded(game)).resolves.toBe('fenced');
    for (let i = 0; i < 20; i++) {
        await db().serverInstances.updateOne({ _id: 'boot-B' }, { $inc: { beatSeq: 1 }, $set: { beatAt: new Date() } });
        await jest.advanceTimersByTimeAsync(3000);
    }
    expect(log.length).toBe(emitted);
    expect(kit.savedGame(db(), id).owner).toBe('boot-B');
});

test('a re-take that fails keeps the table suspended; the next beat retries it', async () => {
    const { store, id } = await onTable();
    db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
    await jest.advanceTimersByTimeAsync(liveStore.SELF_FENCE_MS + liveStore.HEARTBEAT_MS);
    db().faults.fail({ collections: 'liveGames', ops: 'findOneAndUpdate' });
    db().faults.release();
    await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS + 10);
    expect(db().faults.calls.some((c) => c.collection === 'liveGames' && c.op === 'findOneAndUpdate' && c.outcome === 'failed')).toBe(true);
    expect(store.selfFenced).toBe(true);
    expect(store.suspendCalls).toEqual([['suspend', id]]);
    db().faults.clear();
    await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS + 10);
    await h.flushStore(store);
    expect(store.selfFenced).toBe(false);
    expect(store.suspendCalls).toEqual([['suspend', id], ['unsuspend', id]]);
});

test('write mode never self-fences', async () => {
    const store = kit.installStore(mockDb, { bootId: 'boot-A', getIo: () => io, suspendGame: jest.fn() });
    await store.start({ io });
    await kit.startGame(io, log, { humans: ['Hal'] });
    db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
    await jest.advanceTimersByTimeAsync(30000);
    expect(store.selfFenced).toBe(false);
    db().faults.release();
});

test('a fenced copy that reaches gameEnd: no stats, no record, no pointer clear, no tombstone', async () => {
    const { store, game, sockets, id } = await onTable();
    await chatHandlers.chatMessage(sockets[0], io, { message: '/lazy' });
    await h.flushStore(store);
    db().faults.stall({ collections: 'liveGames', ops: 'updateOne' });
    await kit.advanceUntil(() => game.isTerminal(), { step: 500, cap: 3 * 3600000 });
    expect(game.stage).toBe(Phase.ENDED);
    // Adopted elsewhere while this copy's writes were stuck
    db().liveGames.docs.find((d) => d._id === id).owner = 'boot-B';
    db().faults.release();
    await jest.advanceTimersByTimeAsync(10000);
    await h.flushStore(store);
    expect(db().gameRecords.docs).toHaveLength(0);
    expect(db().users.docs.find((u) => u.username === 'Hal').botStats?.gamesPlayed ?? 0).toBe(0);
    expect(db().users.docs.find((u) => u.username === 'Hal').activeGameId).toBe(id);
    expect(kit.savedGame(db(), id)).toMatchObject({ owner: 'boot-B', kind: 'live' });
}, 60000);

test('a late heartbeat never moves beatSeq back', async () => {
    const { store } = await onTable();
    const inst = () => db().serverInstances.docs.find((d) => d._id === 'boot-A');
    await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS * 3);
    const seq = inst().beatSeq;
    expect(seq).toBeGreaterThan(0);
    // An older beat applying late is refused by its filter
    await expect(db().serverInstances.updateOne({ _id: 'boot-A', beatSeq: { $lt: seq - 1 } }, { $set: { beatSeq: seq - 1 } }, { upsert: true })).rejects.toMatchObject({ code: 11000 });
    expect(inst().beatSeq).toBe(seq);
    store.close();
});

describe('a frozen holder thaws: timers that came due before the 1 s self-fence check never run first', () => {
    // A SIGSTOP of 20 s: no heartbeat acknowledged meanwhile (monotonic),
    // then every overdue timer fires in due order. One that was due before
    // the next self-fence check must find the table suspended, not act on it
    async function thawed() {
        const t = await onTable();
        db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
        // Just after a self-fence check (they run every second from start())
        const sinceTick = (Date.now() - t.startedAt) % 1000;
        await jest.advanceTimersByTimeAsync(1000 - sinceTick + 1);
        expect(t.store.selfFenced).toBe(false);
        return t;
    }

    test.each([
        ['a game timer (setTimer)', (game, fired) => game.setTimer('probe', 300, () => fired.push(game.isSuspended)), false],
        ['a lifecycle pause', (game, fired) => game.pause(300).then((ok) => fired.push([ok, game.isSuspended])), [true, false]],
        ['a bot action (BotController._arm)', (game, fired) => botController._arm(game, `${game.gameId}:probe`, 300, () => fired.push(game.isSuspended)), false]
    ])('%s due before the check is held by the suspension and runs after the thaw', async (_name, arm, after) => {
        const { store, game, id, mono } = await thawed();
        const fired = [];
        arm(game, fired);
        const emitted = log.length;
        mono.jump(20000);
        // The probe is due now; the next check is ~700 ms away
        await jest.advanceTimersByTimeAsync(400);
        expect(fired).toEqual([]);
        expect(store.selfFenced).toBe(true);
        expect(store.suspendCalls).toEqual([['suspend', id]]);
        expect(fired).toEqual([]);
        expect(log.length).toBe(emitted);
        db().faults.release();
        await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS + 10);
        await h.flushStore(store);
        expect(store.suspendCalls).toEqual([['suspend', id], ['unsuspend', id]]);
        expect(fired).toEqual([after]);
    });

    test('write mode: the same timer runs at once (no self-fence, no hook)', async () => {
        const store = kit.installStore(mockDb, { bootId: 'boot-A', getIo: () => io });
        await store.start({ io });
        const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
        const fired = [];
        game.setTimer('probe', 300, () => fired.push(game.isSuspended));
        await jest.advanceTimersByTimeAsync(301);
        expect(fired).toEqual([false]);
    });
});

describe("recovery re-takes ownership with a write, so an adopter's compare-and-set in flight cannot also win", () => {
    /**
     * B judged A dead and read A's doc at rev R; its claim (the adopt
     * compare-and-set {_id, owner: A, rev: R}) lands right after A's
     * recovery op for the doc is answered, before A acts on the answer.
     * Exactly one of them may run the table.
     */
    async function raceRecovery() {
        const t = await onTable();
        db().faults.stall({ collections: 'serverInstances', ops: 'updateOne' });
        await jest.advanceTimersByTimeAsync(liveStore.SELF_FENCE_MS + liveStore.HEARTBEAT_MS);
        expect(t.store.suspendCalls).toEqual([['suspend', t.id]]);
        const seen = kit.savedGame(db(), t.id);
        const r = seen.rev;
        const coll = db().liveGames;
        const bClaim = coll.findOneAndUpdate.bind(coll);
        let armed = true;
        let bWon = null;
        for (const op of ['findOne', 'updateOne', 'findOneAndUpdate']) {
            const orig = coll[op].bind(coll);
            coll[op] = async (filter, ...rest) => {
                const res = await orig(filter, ...rest);
                if (armed && filter && filter._id === t.id) {
                    armed = false;
                    // B's adopt claim (adopt.js adoptLive) lands now
                    const claimed = await bClaim({ _id: t.id, owner: 'boot-A', rev: r }, { $set: { owner: 'boot-B', adoptedBy: 'boot-B', rev: r + 1 } }, { returnDocument: 'after' });
                    bWon = !!claimed;
                }
                return res;
            };
        }
        db().serverInstances._insert({ _id: 'boot-B', mode: 'on', startedAt: new Date(), beatAt: new Date(), beatSeq: 1, shuttingDown: false });
        db().faults.release();
        await jest.advanceTimersByTimeAsync(liveStore.HEARTBEAT_MS + 10);
        await h.flushStore(t.store);
        expect(armed).toBe(false);
        return { ...t, bWon: () => bWon };
    }

    test('at most one owner: A unsuspends only if the doc is still its own afterwards', async () => {
        const { store, game, id, bWon } = await raceRecovery();
        const owner = kit.savedGame(db(), id).owner;
        const unsuspended = store.suspendCalls.some(([k]) => k === 'unsuspend');
        if (unsuspended) {
            expect(owner).toBe('boot-A');
            expect(bWon()).toBe(false);
            expect(gameManager.games.get(id)).toBe(game);
        } else {
            expect(owner).toBe('boot-B');
            expect(game.frozen).toBe(true);
        }
    });
});
