/**
 * Self account delete and the saved game pointer (deploy survival PR 5, the
 * plan's 2.6 "Self account delete"; authHandlers.deleteAccount), over
 * persistHarness's liveDb and the real handler. In LIVE_PERSIST=on the
 * account's saved activeGameId is resolved (pointerResolve) once the name
 * is locked:
 *   - a stale pointer (no doc, no live instance) never blocks: it is
 *     cleared (scoped) and the deletion goes on
 *   - a game pending on another live instance, adoptable here (adopted by
 *     the check), or in memory without a seat of the account: refused
 *     (the account's seat may come back), nothing deleted, the name not
 *     left locked
 *   - while this process hands off: refused
 *   - write: today's in-memory check only (a pointer to another instance's
 *     doc does not block)
 * restoreGame.adoptGame is STUBBED (liveStoreKit.stubAdoptGame).
 */

const mockDb = { current: null };
jest.mock('../../database', () => require('../../testUtils/persistHarness').databaseMock(mockDb));

const { randomUUID } = require('crypto');
const h = require('../../testUtils/persistHarness');
const kit = require('../../testUtils/liveStoreKit');
const { makeIo, makeSocket, mulberry32 } = require('../../testUtils/gameDriver');
const gameManager = require('../../game/GameManager');
const { botController } = require('../../game/bot');
const liveStore = require('../../game/persist/liveStore');
const auth = require('../authHandlers');
const profileHandlers = require('../profileHandlers');
const passwordHash = require('../../utils/passwordHash');
const signInThrottle = require('../signInThrottle');
const shutdown = require('../../utils/shutdown');
const { isNameHold } = require('../../admin/accountDelete');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../utils/logger');

const IN_GAME = "You're in a game right now. Delete your account after it ends.";

let realRandom;
let io;
let log;
let n = 0;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(47);
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(passwordHash, 'compare').mockResolvedValue(true);
    signInThrottle._reset();
    log = [];
    io = makeIo(log);
});

afterEach(() => {
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    shutdown._resetShutdownStateForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    gameManager.deletedUsernames?.clear?.();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const users = () => db().users;
const userDoc = (u) => users().docs.find((d) => d.username === u) || null;

/** Dee signed in on a socket, her saved pointer `gameId`. */
function dee(gameId) {
    if (!userDoc('Dee')) users()._insert({ username: 'Dee', password: randomUUID(), profilePic: 2 });
    if (gameId) userDoc('Dee').activeGameId = gameId;
    const s = makeSocket(`del-${++n}`, log, io);
    s.disconnect = jest.fn();
    s.conn = { close: jest.fn() };
    gameManager.registerUser(s.id, 'Dee');
    return s;
}

async function deleteOwn(s) {
    await auth.deleteAccount(s, io, { password: 'x' });
    return log.filter((e) => e.to === `self:${s.id}` && e.event === 'deleteAccountResponse').pop()?.data;
}

async function onAlone(opts = {}) {
    const B = kit.installOnStore(mockDb, { bootId: 'boot-B', getIo: () => io, monoNow: h.createMonoClock().now, ...opts });
    await B.start({ io });
    await B.whenBootSwept();
    return B;
}

/** A saved table for Hal on instance A, A "dead" unreleased (pending while its beat is fresh); B is the process. */
async function pendingOnB() {
    const A = kit.installOnStore(mockDb, { bootId: 'boot-A', getIo: () => io });
    await A.start({ io });
    const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
    await h.flushStore(A);
    A.close();
    profileHandlers._resetStatsWritesForTests();
    gameManager._resetForTests();
    botController._resetForTests();
    await jest.advanceTimersByTimeAsync(1000);
    const B = kit.installOnStore(mockDb, { bootId: 'boot-B', monoNow: h.createMonoClock().now, getIo: () => io });
    await B.start({ io });
    await B.whenBootSwept();
    return { B, id: game.gameId };
}

function expectRefused(res) {
    expect(res).toEqual({ success: false, message: IN_GAME });
    expect(userDoc('Dee')).toMatchObject({ username: 'Dee' });
    expect(isNameHold(userDoc('Dee'))).toBe(false);
    expect(gameManager.isMergeLocked('Dee')).toBe(false);
}

test('on: a stale pointer (no doc, no live instance) is cleared, scoped, and the deletion goes on', async () => {
    await onAlone();
    const clear = jest.spyOn(gameManager, 'clearActiveGame');
    const s = dee('g-stale');
    const res = await deleteOwn(s);
    expect(res).toEqual({ success: true });
    expect(clear).toHaveBeenCalledWith('Dee', 'g-stale');
    const held = userDoc('Dee');
    expect(held === null || isNameHold(held)).toBe(true);
    expect(held?.activeGameId).toBeUndefined();
    expect(gameManager.isMergeLocked('Dee')).toBe(false);
});

test('on: no pointer at all: deleted as today', async () => {
    await onAlone();
    expect(await deleteOwn(dee(null))).toEqual({ success: true });
});

test('on: a game pending on another live instance refuses; the pointer stays', async () => {
    const { id } = await pendingOnB();
    const s = dee(id);
    expectRefused(await deleteOwn(s));
    expect(userDoc('Dee').activeGameId).toBe(id);
});

test('on: an adoptable game is adopted by the check and refuses', async () => {
    const { B, id } = await pendingOnB();
    await db().liveGames.updateOne({ _id: id }, { $set: { released: true, releasedAt: new Date() } });
    const s = dee(id);
    expectRefused(await deleteOwn(s));
    expect(B.adoptCalls).toHaveLength(1);
    expect(gameManager.games.get(id)).toBeTruthy();
});

test('on: a game in memory the account has no seat at (a pointer only) refuses', async () => {
    const A = kit.installOnStore(mockDb, { bootId: 'boot-A', getIo: () => io });
    await A.start({ io });
    const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
    expect(gameManager.findLiveActivity('Dee')).toBeFalsy();
    expectRefused(await deleteOwn(dee(game.gameId)));
});

test('on, shutting down: any saved pointer refuses (its table is being handed off)', async () => {
    let down = false;
    await onAlone({ isShuttingDown: () => down });
    down = true;
    expectRefused(await deleteOwn(dee('g-stale')));
    expect(userDoc('Dee').activeGameId).toBe('g-stale');
});

test('write: today\'s check only (a pointer to another instance\'s doc does not block, and is not resolved)', async () => {
    const W = kit.installStore(mockDb, { bootId: 'boot-W', mode: 'write' });
    await W.start({ io });
    const resolve = jest.spyOn(W, 'resolve');
    db().liveGames._insert({ _id: 'g-elsewhere', v: 3, kind: 'live', owner: 'boot-X', ownerMode: 'on', released: false, rev: 1 });
    db().serverInstances._insert({ _id: 'boot-X', mode: 'on', startedAt: new Date(Date.now() - 60000), beatAt: new Date(), beatSeq: 1 });
    expect(await deleteOwn(dee('g-elsewhere'))).toEqual({ success: true });
    expect(resolve).not.toHaveBeenCalled();
});
