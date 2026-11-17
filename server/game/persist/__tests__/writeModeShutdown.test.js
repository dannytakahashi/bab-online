/**
 * SIGTERM with LIVE_PERSIST write (deploy survival PR 4; the plan's 2.4
 * "Mode write"): today's notice (the game-log line, then serverShutdown)
 * unchanged, THEN this process deletes every doc it owns from liveGames
 * and liveTournaments (deleteMany {owner: me}), bounded at 2 s and waited
 * for like an in-flight write; no write follows the notice. Another
 * instance's docs are untouched. A doc it fails to delete keeps ownerMode
 * 'write' (only 'on' docs are ever adoptable, PR 5) and its TTL.
 * shutdown.js is the real one (process.exit stubbed), over real games.
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const { makeIo, mulberry32 } = require('../../../testUtils/gameDriver');
const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const liveStore = require('../liveStore');
const shutdown = require('../../../utils/shutdown');
const { setupTournament } = require('../../../testUtils/tournamentDriver');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];

let realRandom;
let io;
let log;
let exit;
let before;
let savedExitCode;
let order;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(9);
    jest.useFakeTimers();
    before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
    savedExitCode = process.exitCode;
    exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    log = [];
    order = [];
    io = makeIo(log);
    const push = log.push.bind(log);
    log.push = (...items) => {
        for (const e of items) if (e.event === 'gameLogEntry' || e.event === 'serverShutdown') order.push(`emit:${e.event}`);
        return push(...items);
    };
    io.close = jest.fn((cb) => { order.push('io.close'); cb?.(); });
});

afterEach(() => {
    for (const s of SIGNALS) {
        for (const fn of process.listeners(s)) if (!before[s].includes(fn)) process.removeListener(s, fn);
    }
    process.exitCode = savedExitCode;
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    shutdown._resetShutdownStateForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const server = () => ({ close: jest.fn((cb) => cb?.()) });

/** A started write-mode store with a saved game and tournament, plus another instance's docs. */
async function saved() {
    const store = kit.installStore(mockDb, { getIo: () => io });
    await store.start({ io });
    const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
    const ctx = await setupTournament(2, { io, log });
    await h.flushStore(store);
    db().liveGames._insert({ _id: 'g-other', owner: 'boot-B', ownerMode: 'write', kind: 'live', released: false });
    db().liveTournaments._insert({ _id: 't-other', owner: 'boot-B', ownerMode: 'write', kind: 'live', released: false });
    for (const name of ['liveGames', 'liveTournaments']) {
        const coll = db()[name];
        const deleteMany = coll.deleteMany;
        coll.deleteMany = (...args) => {
            order.push(`${name}.deleteMany`);
            return deleteMany(...args);
        };
    }
    expect(kit.savedGame(db(), game.gameId)).toMatchObject({ owner: 'boot-A' });
    expect(kit.savedTournament(db(), ctx.t.tournamentId)).toMatchObject({ owner: 'boot-A' });
    return { store, game, ctx };
}

const ownIds = () => [...db().liveGames.docs, ...db().liveTournaments.docs].filter((d) => d.owner === 'boot-A').map((d) => d._id);

test.each(['SIGTERM', 'SIGINT'])('write, %s: today\'s notice and serverShutdown first, then its own docs deleted (only its own), no write after the notice, exit 0', async (signal) => {
    const { store, game } = await saved();
    const updates = jest.spyOn(db().liveGames, 'updateOne');
    shutdown.setupGracefulShutdown(server(), io, { games: () => gameManager.games.values(), persist: store });
    process.listeners(signal).find((fn) => !before[signal].includes(fn))();
    await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS);
    expect(exit).toHaveBeenCalledWith(0);
    expect(order).toEqual(['emit:gameLogEntry', 'emit:serverShutdown', 'liveGames.deleteMany', 'liveTournaments.deleteMany', 'io.close']);
    // Today's text, unchanged
    expect(game.gameLog.at(-1).message).toBe(shutdown.GAME_NOTICE);
    expect(ownIds()).toEqual([]);
    expect(db().liveGames.docs.map((d) => d._id)).toEqual(['g-other']);
    expect(db().liveTournaments.docs.map((d) => d._id)).toEqual(['t-other']);
    expect(db().serverInstances.docs[0]).toMatchObject({ _id: 'boot-A', shuttingDown: true });
    // The notice line was never written (the store closed first)
    expect(updates).not.toHaveBeenCalled();
    expect(store.logs.find((l) => /deleted at shutdown/.test(l.msg)).meta).toEqual({ games: 1, tournaments: 1 });
});

test('write, a crash (uncaughtException): the crash notice, then the same self-delete, exit 1', async () => {
    const { store, game } = await saved();
    const h2 = shutdown.setupGracefulShutdown(server(), io, { games: () => gameManager.games.values(), persist: store });
    h2.onUncaughtException(new Error('kaboom'));
    await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS);
    expect(exit).toHaveBeenCalledWith(1);
    expect(game.gameLog.at(-1).message).toBe(shutdown.CRASH_NOTICE);
    expect(ownIds()).toEqual([]);
});

test('a delete that fails: logged, exit on time; the leftover docs say ownerMode write (never adoptable) and expire within a day', async () => {
    const { store, game } = await saved();
    db().faults.fail({ collections: 'liveGames', ops: 'deleteMany' });
    shutdown.setupGracefulShutdown(server(), io, { games: () => gameManager.games.values(), persist: store });
    process.listeners('SIGTERM').find((fn) => !before.SIGTERM.includes(fn))();
    await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS);
    expect(exit).toHaveBeenCalledWith(0);
    const left = kit.savedGame(db(), game.gameId);
    expect(left).toMatchObject({ owner: 'boot-A', ownerMode: 'write', released: false });
    expect(left.expireAt.getTime() - left.createdAt.getTime()).toBe(24 * 3600000);
    expect(store.logs.some((l) => l.level === 'warn' && /shutdown delete failed/.test(l.msg))).toBe(true);
    // The tournament's delete still went through
    expect(db().liveTournaments.docs.map((d) => d._id)).toEqual(['t-other']);
});

test('Mongo stalled: the self-delete gives up at 2 s and the process exits on time', async () => {
    const { store } = await saved();
    db().faults.stall({ collections: ['liveGames', 'liveTournaments', 'serverInstances'] });
    shutdown.setupGracefulShutdown(server(), io, { games: () => gameManager.games.values(), persist: store });
    process.listeners('SIGTERM').find((fn) => !before.SIGTERM.includes(fn))();
    await jest.advanceTimersByTimeAsync(liveStore.SHUTDOWN_DELETE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1 + shutdown.SETTLE_MS);
    expect(exit).toHaveBeenCalledWith(0);
    expect(store.logs.some((l) => /expire by TTL/.test(l.msg))).toBe(true);
});

test('off: the hook does nothing (index.js passes it only in write; even passed, no live op)', async () => {
    const store = kit.installStore(mockDb, { mode: 'off' });
    await kit.startGame(io, log, { humans: ['Hal'] });
    shutdown.setupGracefulShutdown(server(), io, { games: () => gameManager.games.values(), persist: store });
    process.listeners('SIGTERM').find((fn) => !before.SIGTERM.includes(fn))();
    await jest.advanceTimersByTimeAsync(shutdown.NOTICE_MS + shutdown.SETTLE_MS);
    expect(exit).toHaveBeenCalledWith(0);
    expect(order).toEqual(['emit:gameLogEntry', 'emit:serverShutdown', 'io.close']);
    expect(db().faults.calls.filter((c) => h.LIVE_COLLECTIONS.includes(c.collection))).toEqual([]);
});
