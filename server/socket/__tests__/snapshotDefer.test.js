/**
 * requestSnapshot's not_in_game deferral (deploy survival PR 5, the plan's
 * 2.6 "requestSnapshot"; socket/pointerResolve.deferSnapshot),
 * LIVE_PERSIST=on, over persistHarness's liveDb, real games and the real
 * handlers (every emit checked by the contract guard). Every iOS build
 * reads {snapshot: null, reason: 'not_in_game'} as "your game ended", so a
 * requestSnapshot reaching the successor during a restore must not get it:
 *   - a socket whose rejoin is in flight (parked) gets no not_in_game; it
 *     gets a real snapshot once the rejoin seats it (after rejoinSuccess)
 *   - a signed-in socket whose user's game is pending or adoptable, with
 *     no rejoin yet: the same once its rejoin lands
 *   - a socket that has not signed in yet: waits for its restore
 *   - a truly gameless socket still gets not_in_game, at once (no pointer)
 *     or within 8 s (a pointer to a game it never rejoins; never signs in)
 *   - a socket that drops meanwhile gets nothing
 *   - write and off: today's synchronous reply
 * restoreGame.adoptGame, isGated and suspend are the real ones (liveStoreKit.installOnStore).
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
const mockDb = { current: null };
jest.mock('../../database', () => require('../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../testUtils/persistHarness');
const kit = require('../../testUtils/liveStoreKit');
const { makeIo, makeSocket, mulberry32 } = require('../../testUtils/gameDriver');
const gameManager = require('../../game/GameManager');
const { botController } = require('../../game/bot');
const liveStore = require('../../game/persist/liveStore');
const reconnectHandlers = require('../reconnectHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const auth = require('../authHandlers');
const profileHandlers = require('../profileHandlers');
const pointerResolve = require('../pointerResolve');
const shutdown = require('../../utils/shutdown');
const { issueSession } = require('../../utils/sessionTokens');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../utils/logger');

let realRandom;
let io;
let log;
let n = 0;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(43);
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
    profileHandlers._resetStatsWritesForTests();
    shutdown._resetShutdownStateForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const users = () => db().users;
const replies = (s) => log.filter((e) => e.to === `self:${s.id}` && e.event === 'stateSnapshot').map((e) => e.data);
const eventsTo = (s) => log.filter((e) => e.to === `self:${s.id}`).map((e) => e.event);

function sock(prefix = 's') {
    const s = makeSocket(`${prefix}-${++n}`, log, io);
    s.conn = { close: jest.fn() };
    s.disconnect = jest.fn();
    return s;
}

/** A saved table for Hal on instance A ('on'), then A "dies" unreleased (its doc pending while A's beat is fresh). B is the process. */
async function pendingOnB() {
    const A = kit.installOnStore(mockDb, { bootId: 'boot-A', deploymentId: 'dep-A', getIo: () => io });
    await A.start({ io });
    const { game } = await kit.startGame(io, log, { humans: ['Hal'] });
    const id = game.gameId;
    await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: id } });
    await h.flushStore(A);
    A.close();
    profileHandlers._resetStatsWritesForTests();
    gameManager._resetForTests();
    botController._resetForTests();
    await jest.advanceTimersByTimeAsync(1000);
    const B = kit.installOnStore(mockDb, { bootId: 'boot-B', deploymentId: 'dep-B', monoNow: h.createMonoClock().now, getIo: () => io });
    await B.start({ io });
    await B.whenBootSwept();
    await h.flushStore(B);
    return { B, id };
}

async function release(id) {
    await db().liveGames.updateOne({ _id: id }, { $set: { released: true, releasedAt: new Date(), releaseKind: 'handoff' } });
}

async function onAlone() {
    const B = kit.installOnStore(mockDb, { bootId: 'boot-B', getIo: () => io, monoNow: h.createMonoClock().now });
    await B.start({ io });
    await B.whenBootSwept();
    return B;
}

test('a rejoin in flight (parked): no not_in_game; the real snapshot after the rejoin seats it', async () => {
    const { id } = await pendingOnB();
    const s = sock('rj');
    gameManager.registerUser(s.id, 'Hal');
    const rejoin = reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal' });
    await jest.advanceTimersByTimeAsync(100);
    snapshotHandlers.requestSnapshot(s, io, { requestId: 7 });
    await jest.advanceTimersByTimeAsync(3000);
    expect(replies(s)).toEqual([]);
    await release(id);
    await jest.advanceTimersByTimeAsync(1100);
    await rejoin;
    await jest.advanceTimersByTimeAsync(300);
    const got = replies(s);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ requestId: 7, snapshot: expect.objectContaining({ gameId: id }) });
    expect(got[0].reason).toBeUndefined();
    const ev = eventsTo(s);
    expect(ev.indexOf('rejoinSuccess')).toBeGreaterThan(-1);
    expect(ev.indexOf('stateSnapshot')).toBeGreaterThan(ev.indexOf('rejoinSuccess'));
});

test.each(['pending', 'adoptable'])('a signed-in socket whose game is %s and no rejoin yet: deferred, then the snapshot once its rejoin lands', async (kind) => {
    const { B, id } = await pendingOnB();
    if (kind === 'adoptable') await release(id);
    const s = sock('sn');
    gameManager.registerUser(s.id, 'Hal');
    snapshotHandlers.requestSnapshot(s, io, {});
    await jest.advanceTimersByTimeAsync(2000);
    expect(replies(s)).toEqual([]);
    // adoptable: the deferral's own pointer check adopted it
    if (kind === 'adoptable') expect(B.adoptCalls).toHaveLength(1);
    else await release(id);
    const rejoin = reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal' });
    await jest.advanceTimersByTimeAsync(1100);
    await rejoin;
    await jest.advanceTimersByTimeAsync(300);
    expect(replies(s)).toEqual([expect.objectContaining({ snapshot: expect.objectContaining({ gameId: id }) })]);
    expect(B.adoptCalls).toHaveLength(1);
});

test('a socket that has not signed in yet waits for its restore, then the truth', async () => {
    const { id } = await pendingOnB();
    await release(id);
    const u = users().docs.find((d) => d.username === 'Hal');
    const session = issueSession(u);
    Object.assign(u, session.update.$set);
    const s = sock('rs');
    snapshotHandlers.requestSnapshot(s, io, {});
    await jest.advanceTimersByTimeAsync(500);
    expect(replies(s)).toEqual([]);
    await auth.restoreSession(s, io, { username: 'Hal', sessionToken: session.token });
    expect(log.find((e) => e.to === `self:${s.id}` && e.event === 'restoreSessionResponse').data).toMatchObject({ success: true, activeGameId: id });
    await jest.advanceTimersByTimeAsync(300);
    expect(replies(s)).toEqual([]);
    await reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal' });
    await jest.advanceTimersByTimeAsync(300);
    expect(replies(s)).toEqual([expect.objectContaining({ snapshot: expect.objectContaining({ gameId: id }) })]);
});

test('truly gameless: a signed-in socket with no pointer gets not_in_game at once', async () => {
    await onAlone();
    users()._insert({ username: 'Ann' });
    const s = sock('g');
    gameManager.registerUser(s.id, 'Ann');
    snapshotHandlers.requestSnapshot(s, io, { requestId: 'r1' });
    await jest.advanceTimersByTimeAsync(1);
    expect(replies(s)).toEqual([{ snapshot: null, requestId: 'r1', reason: 'not_in_game' }]);
});

test('truly gameless: a stale pointer (no doc, no other instance) gets not_in_game at once', async () => {
    await onAlone();
    users()._insert({ username: 'Ann', activeGameId: 'g-gone' });
    const s = sock('g');
    gameManager.registerUser(s.id, 'Ann');
    snapshotHandlers.requestSnapshot(s, io, {});
    await jest.advanceTimersByTimeAsync(1);
    expect(replies(s)).toEqual([{ snapshot: null, reason: 'not_in_game' }]);
});

test('a pending game the socket never rejoins, and a socket that never signs in: not_in_game within 8 s', async () => {
    await pendingOnB();
    const a = sock('p');
    gameManager.registerUser(a.id, 'Hal');
    const b = sock('anon');
    snapshotHandlers.requestSnapshot(a, io, {});
    snapshotHandlers.requestSnapshot(b, io, {});
    await jest.advanceTimersByTimeAsync(pointerResolve.SNAPSHOT_DEFER_MS - 300);
    expect(replies(a)).toEqual([]);
    expect(replies(b)).toEqual([]);
    await jest.advanceTimersByTimeAsync(400);
    expect(replies(a)).toEqual([{ snapshot: null, reason: 'not_in_game' }]);
    expect(replies(b)).toEqual([{ snapshot: null, reason: 'not_in_game' }]);
});

test('a socket that drops while deferred gets nothing', async () => {
    await pendingOnB();
    const s = sock('d');
    gameManager.registerUser(s.id, 'Hal');
    snapshotHandlers.requestSnapshot(s, io, {});
    await jest.advanceTimersByTimeAsync(1000);
    io.sockets.sockets.delete(s.id);
    await jest.advanceTimersByTimeAsync(pointerResolve.SNAPSHOT_DEFER_MS + 1000);
    expect(eventsTo(s)).toEqual([]);
});

test('a seated socket is answered at once (no deferral)', async () => {
    const A = kit.installOnStore(mockDb, { bootId: 'boot-A', getIo: () => io });
    await A.start({ io });
    const { game, sockets } = await kit.startGame(io, log, { humans: ['Hal'] });
    snapshotHandlers.requestSnapshot(sockets[0], io, {});
    expect(replies(sockets[0])).toEqual([expect.objectContaining({ snapshot: expect.objectContaining({ gameId: game.gameId }) })]);
});

test.each(['write', 'off'])('%s: today\'s synchronous not_in_game', async (mode) => {
    const store = kit.installStore(mockDb, { bootId: 'boot-W', mode });
    await store.start({ io });
    users()._insert({ username: 'Ann', activeGameId: 'g-elsewhere' });
    db().liveGames._insert({ _id: 'g-elsewhere', v: 3, kind: 'live', owner: 'boot-X', ownerMode: 'on', released: false, rev: 1 });
    const s = sock('w');
    gameManager.registerUser(s.id, 'Ann');
    snapshotHandlers.requestSnapshot(s, io, {});
    expect(replies(s)).toEqual([{ snapshot: null, reason: 'not_in_game' }]);
    const anon = sock('w');
    snapshotHandlers.requestSnapshot(anon, io, {});
    expect(replies(anon)).toEqual([{ snapshot: null, reason: 'not_in_game' }]);
});
