/**
 * Pointer protection (deploy survival PR 5, the plan's 2.6;
 * socket/pointerResolve.js) at every call site, LIVE_PERSIST=on with the
 * unique gameId index, over persistHarness's liveDb, real games and the
 * real handlers (every emit checked by the contract guard):
 *   signIn, restoreSession, rejoinGame, joinAsSpectator,
 *   spectateTournamentGame  x  {memory, adoptable, no doc, pending (a live
 *   owner holds the doc), an unknown id while an older 'on' instance is
 *   alive}:
 *     - memory / adoptable: the game (adopted once), the normal answer
 *     - no doc: today's answer (the pointer cleared, the failure)
 *     - pending: the pointer stays; never success:false, rejoinFailed or
 *       "not found"; signIn / restoreSession answer the game as active (the
 *       client's rejoinGame then parks); rejoin / spectate park <= 8 s, then
 *       an engine close (socket.conn.close, never socket.disconnect)
 *   - an adoption during the park seats the socket once (two requests
 *     parked); a socket that drops mid-wait gets nothing; a doc that turns
 *     out not adoptable during the park gets today's failure; the engine
 *     close then a fresh rejoin lands once the doc is released
 *   - shutting down ('on'): no pointer clear at any site
 *   - restoreSession / signIn clear a non-member's tournament pointer (on)
 *   - joinTournament's failure clear is scoped in 'on'
 *   - write and off: today's paths, resolve never asked
 * restoreGame.adoptGame, isGated and suspend are the real ones (liveStoreKit.installOnStore).
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
const mockDb = { current: null };
jest.mock('../../database', () => require('../../testUtils/persistHarness').databaseMock(mockDb));

const { randomUUID } = require('crypto');
const h = require('../../testUtils/persistHarness');
const kit = require('../../testUtils/liveStoreKit');
const { makeIo, makeSocket, mulberry32 } = require('../../testUtils/gameDriver');
const gameManager = require('../../game/GameManager');
const { botController } = require('../../game/bot');
const liveStore = require('../../game/persist/liveStore');
const adopt = require('../../game/persist/adopt');
const auth = require('../authHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const profileHandlers = require('../profileHandlers');
const pointerResolve = require('../pointerResolve');
const passwordHash = require('../../utils/passwordHash');
const signInThrottle = require('../signInThrottle');
const shutdown = require('../../utils/shutdown');
const { issueSession } = require('../../utils/sessionTokens');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../utils/logger');

let realRandom;
let io;
let log;
let n = 0;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(41);
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // The password check itself is not under test (and runs in a worker pool)
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
    for (const t of Array.from(gameManager.tournaments.values())) gameManager.deleteTournament?.(t.tournamentId);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const users = () => db().users;
const userDoc = (u) => users().docs.find((d) => d.username === u) || null;
const pointer = (u) => userDoc(u)?.activeGameId ?? null;
const toSelf = (s, event) => log.filter((e) => e.to === `self:${s.id}` && e.event === event).map((e) => e.data);
const FAILURES = ['rejoinFailed', 'serverError'];
const failuresTo = (s) => log.filter((e) => e.to === `self:${s.id}` && FAILURES.includes(e.event));

function sock(prefix = 's') {
    const s = makeSocket(`${prefix}-${++n}`, log, io);
    s.conn = { close: jest.fn() };
    s.disconnect = jest.fn();
    return s;
}

/** A user doc that can sign in (any password: compare is stubbed) and restore. */
function ensureUser(username) {
    if (!userDoc(username)) users()._insert({ username, profilePic: 3 });
    const u = userDoc(username);
    u.password = randomUUID();
    return u;
}

/** Instance A ('on') with a dealt casual table for Hal, saved; Hal's pointer set. */
async function savedByA() {
    const A = kit.installOnStore(mockDb, { bootId: 'boot-A', deploymentId: 'dep-A', getIo: () => io });
    await A.start({ io });
    const { game, sockets } = await kit.startGame(io, log, { humans: ['Hal'] });
    await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: game.gameId } });
    await h.flushStore(A);
    return { A, game, sockets, id: game.gameId };
}

function dies(store) {
    store.close();
    profileHandlers._resetStatsWritesForTests();
    gameManager._resetForTests();
    botController._resetForTests();
}

async function release(id) {
    await db().liveGames.updateOne({ _id: id }, { $set: { released: true, releasedAt: new Date(), releaseKind: 'handoff' } });
}

/** Instance B ('on'), started after A, its boot sweep done; the process's store. */
async function startB(opts = {}) {
    await jest.advanceTimersByTimeAsync(1000);
    const clock = h.createMonoClock();
    const B = kit.installOnStore(mockDb, { bootId: 'boot-B', deploymentId: 'dep-B', monoNow: clock.now, getIo: () => io, ...opts });
    await B.start({ io });
    await B.whenBootSwept();
    await h.flushStore(B);
    return B;
}

/**
 * The five states, each leaving `id` (the game the call site asks about)
 * and Hal's pointer to it:
 *   memory      A plays it (A is the process)
 *   adoptable   A released its doc and died; B's boot sweep ran before the
 *               release (so the call site's resolve adopts it)
 *   none        B alone, a pointer to an id nobody has
 *   pending     A's unreleased doc, A alive (B has not seen it die)
 *   unknown     an id with no doc while A (an older 'on' instance) is alive
 */
async function state(kind) {
    if (kind === 'memory') {
        const { A, id } = await savedByA();
        return { store: A, id };
    }
    if (kind === 'none') {
        const B = kit.installOnStore(mockDb, { bootId: 'boot-B', getIo: () => io, monoNow: h.createMonoClock().now });
        await B.start({ io });
        await B.whenBootSwept();
        ensureUser('Hal');
        await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: 'g-none' } });
        return { store: B, id: 'g-none' };
    }
    const { A, id } = await savedByA();
    dies(A);
    const B = await startB();
    if (kind === 'adoptable') await release(id);
    if (kind === 'unknown') {
        await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: 'g-unknown' } });
        return { store: B, id: 'g-unknown' };
    }
    return { store: B, id };
}

/** Each call site, asked about `id` as Hal (pointer sites) or Spec (spectate). Returns the socket and the run. */
const SITES = {
    signIn: (id) => {
        ensureUser('Hal');
        const s = sock('si');
        return { s, run: auth.signIn(s, io, { username: 'Hal', password: 'x' }) };
    },
    restoreSession: (id) => {
        const u = ensureUser('Hal');
        const session = issueSession(u);
        Object.assign(u, session.update.$set);
        const s = sock('rs');
        return { s, run: auth.restoreSession(s, io, { username: 'Hal', sessionToken: session.token }) };
    },
    rejoinGame: (id) => {
        const s = sock('rj');
        gameManager.registerUser(s.id, 'Hal');
        return { s, run: reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal' }) };
    },
    joinAsSpectator: (id) => {
        ensureUser('Spec');
        const s = sock('sp');
        gameManager.registerUser(s.id, 'Spec');
        return { s, run: Promise.resolve(mainRoomHandlers.joinAsSpectator(s, io, { gameId: id })) };
    },
    spectateTournamentGame: (id) => {
        ensureUser('Spec');
        const s = sock('st');
        gameManager.registerUser(s.id, 'Spec');
        return { s, run: Promise.resolve(tournamentHandlers.spectateTournamentGame(s, io, { gameId: id })) };
    }
};

const AUTH = { signIn: 'signInResponse', restoreSession: 'restoreSessionResponse' };

/** The normal answer: the game is live and this socket got it. */
function expectServed(site, s, id) {
    if (AUTH[site]) {
        expect(toSelf(s, AUTH[site])).toEqual([expect.objectContaining({ success: true, activeGameId: id })]);
        expect(pointer('Hal')).toBe(id);
    } else if (site === 'rejoinGame') {
        expect(toSelf(s, 'rejoinSuccess')).toHaveLength(1);
        expect(gameManager.playerGames.get(s.id)).toBe(id);
    } else {
        expect(toSelf(s, 'spectatorJoined')).toEqual([expect.objectContaining({ snapshot: expect.any(Object) })]);
        expect(gameManager.spectatorGames.get(s.id)).toBe(id);
    }
    expect(failuresTo(s)).toEqual([]);
    expect(s.conn.close).not.toHaveBeenCalled();
}

describe.each(Object.keys(SITES))('%s', (site) => {
    test('memory: answered from this process, no adoption', async () => {
        const { store, id } = await state('memory');
        const { s, run } = SITES[site](id);
        await run;
        expectServed(site, s, id);
        expect(store.adoptCalls).toHaveLength(0);
    });

    test('adoptable: adopted once by the call site\'s resolve, then answered as live', async () => {
        const { store, id } = await state('adoptable');
        expect(gameManager.games.get(id)).toBeUndefined();
        const { s, run } = SITES[site](id);
        await run;
        expect(store.adoptCalls).toHaveLength(1);
        expect(gameManager.games.get(id)).toBeTruthy();
        expectServed(site, s, id);
        expect(kit.savedGame(db(), id)).toMatchObject({ owner: 'boot-B' });
    });

    test('no doc, no other instance: today\'s answer (pointer cleared, the failure)', async () => {
        const { id } = await state('none');
        const { s, run } = SITES[site](id);
        await run;
        if (AUTH[site]) {
            const [res] = toSelf(s, AUTH[site]);
            expect(res).toMatchObject({ success: true });
            expect(res.activeGameId).toBeUndefined();
            expect(pointer('Hal')).toBeNull();
        } else if (site === 'rejoinGame') {
            expect(toSelf(s, 'rejoinFailed')).toEqual([{ reason: 'Game no longer exists' }]);
            expect(pointer('Hal')).toBeNull();
        } else {
            expect(toSelf(s, 'serverError')).toEqual([expect.objectContaining({ message: 'Game not found' })]);
        }
        expect(s.conn.close).not.toHaveBeenCalled();
    });

    test.each(['pending', 'unknown'])('%s: the pointer stays, no failure; parked <= 8 s then an engine close (rejoin / spectate)', async (kind) => {
        const { store, id } = await state(kind);
        const { s, run } = SITES[site](id);
        let settled = false;
        run.then(() => { settled = true; });
        if (AUTH[site]) {
            await run;
            // Answered as active: the client rejoins, and that parks
            expect(toSelf(s, AUTH[site])).toEqual([expect.objectContaining({ success: true, activeGameId: id })]);
            expect(s.conn.close).not.toHaveBeenCalled();
        } else {
            await jest.advanceTimersByTimeAsync(pointerResolve.PARK_MS - 100);
            expect(settled).toBe(false);
            expect(s.conn.close).not.toHaveBeenCalled();
            expect(pointerResolve.restoring(s)).toBe(true);
            await jest.advanceTimersByTimeAsync(200);
            await run;
            expect(s.conn.close).toHaveBeenCalledTimes(1);
            expect(pointerResolve.restoring(s)).toBe(false);
        }
        expect(s.disconnect).not.toHaveBeenCalled();
        expect(failuresTo(s)).toEqual([]);
        expect(log.filter((e) => e.to === `self:${s.id}` && e.data && e.data.success === false)).toEqual([]);
        expect(pointer('Hal')).toBe(id);
        expect(store.adoptCalls).toHaveLength(0);
    });
});

describe('the park', () => {
    test('an adoption during the park seats the socket once (two rejoins parked on one socket)', async () => {
        const { store, id } = await state('pending');
        const s = sock('rj');
        gameManager.registerUser(s.id, 'Hal');
        const first = reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal' });
        await jest.advanceTimersByTimeAsync(500);
        const second = reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal' });
        await jest.advanceTimersByTimeAsync(1500);
        expect(toSelf(s, 'rejoinSuccess')).toEqual([]);
        await release(id);
        // The next sweep (every second) adopts it and the park answers
        await jest.advanceTimersByTimeAsync(1100);
        await Promise.all([first, second]);
        expect(store.adoptCalls).toHaveLength(1);
        expect(toSelf(s, 'rejoinSuccess')).toHaveLength(1);
        expect(failuresTo(s)).toEqual([]);
        const game = gameManager.games.get(id);
        expect(game.seat(game.seatByUsername('Hal')).seatSocketId).toBe(s.id);
        await jest.advanceTimersByTimeAsync(pointerResolve.PARK_MS);
        expect(s.conn.close).not.toHaveBeenCalled();
    });

    test('a spectator parked during the adoption gets the full state once', async () => {
        const { store, id } = await state('pending');
        ensureUser('Spec');
        const s = sock('sp');
        gameManager.registerUser(s.id, 'Spec');
        const run = mainRoomHandlers.joinAsSpectator(s, io, { gameId: id });
        await jest.advanceTimersByTimeAsync(1000);
        await release(id);
        await jest.advanceTimersByTimeAsync(1100);
        await run;
        expect(store.adoptCalls).toHaveLength(1);
        expect(toSelf(s, 'spectatorJoined')).toHaveLength(1);
        expect(failuresTo(s)).toEqual([]);
    });

    test('a socket that drops mid-wait gets no seat, no answer and no engine close', async () => {
        const { store, id } = await state('pending');
        const s = sock('rj');
        gameManager.registerUser(s.id, 'Hal');
        const run = reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal' });
        await jest.advanceTimersByTimeAsync(1000);
        io.sockets.sockets.delete(s.id);
        await release(id);
        await jest.advanceTimersByTimeAsync(1100);
        await run;
        expect(store.adoptCalls).toHaveLength(1);
        const game = gameManager.games.get(id);
        expect(game.seat(game.seatByUsername('Hal')).seatSocketId).not.toBe(s.id);
        expect(gameManager.playerGames.get(s.id)).toBeUndefined();
        expect(log.filter((e) => e.to === `self:${s.id}`)).toEqual([]);
        expect(s.conn.close).not.toHaveBeenCalled();
        expect(pointer('Hal')).toBe(id);
    });

    test('a doc that turns out not adoptable during the park, while its old owner still lives: still pending (any id may be its), no failure, engine close', async () => {
        const { id } = await state('pending');
        const s = sock('rj');
        gameManager.registerUser(s.id, 'Hal');
        const run = reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal' });
        await jest.advanceTimersByTimeAsync(1000);
        // Released, but in a codec version nobody here reads: discarded
        await db().liveGames.updateOne({ _id: id }, { $set: { v: 999, released: true, releasedAt: new Date() } });
        await jest.advanceTimersByTimeAsync(1100);
        expect(kit.savedGame(db(), id)).toBeNull();
        await jest.advanceTimersByTimeAsync(pointerResolve.PARK_MS);
        await run;
        expect(s.conn.close).toHaveBeenCalledTimes(1);
        expect(failuresTo(s)).toEqual([]);
        // The discard itself cleared the pointer (adopt.js): the retry's
        // restore then answers no game, the truth
        expect(pointer('Hal')).toBeNull();
    });

    test('a doc that turns out not adoptable during the park, no live instance may hold it: today\'s failure (true now), pointer cleared', async () => {
        const { id } = await state('pending');
        // A is no 'on' instance listing the game (so an unknown id is no longer "maybe A's")
        await db().serverInstances.updateOne({ _id: 'boot-A' }, { $set: { mode: 'write', gameIds: [] } });
        const s = sock('rj');
        gameManager.registerUser(s.id, 'Hal');
        const run = reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal' });
        await jest.advanceTimersByTimeAsync(1000);
        await db().liveGames.updateOne({ _id: id }, { $set: { v: 999, released: true, releasedAt: new Date() } });
        await jest.advanceTimersByTimeAsync(1100);
        await run;
        expect(kit.savedGame(db(), id)).toBeNull();
        expect(toSelf(s, 'rejoinFailed')).toEqual([{ reason: 'Game no longer exists' }]);
        expect(pointer('Hal')).toBeNull();
        expect(s.conn.close).not.toHaveBeenCalled();
    });

    test('engine close, then the client\'s fresh rejoin on a new socket lands once the doc is released', async () => {
        const { id } = await state('pending');
        const s1 = sock('rj');
        gameManager.registerUser(s1.id, 'Hal');
        const run1 = reconnectHandlers.rejoinGame(s1, io, { gameId: id, username: 'Hal' });
        await jest.advanceTimersByTimeAsync(pointerResolve.PARK_MS + 100);
        await run1;
        expect(s1.conn.close).toHaveBeenCalledTimes(1);
        // The transport closed: the client reconnects and rejoins
        io.sockets.sockets.delete(s1.id);
        gameManager.handleDisconnect(s1.id);
        const s2 = sock('rj');
        gameManager.registerUser(s2.id, 'Hal');
        const run2 = reconnectHandlers.rejoinGame(s2, io, { gameId: id, username: 'Hal' });
        await jest.advanceTimersByTimeAsync(500);
        await release(id);
        await jest.advanceTimersByTimeAsync(1100);
        await run2;
        expect(toSelf(s2, 'rejoinSuccess')).toHaveLength(1);
        expect(failuresTo(s1)).toEqual([]);
        expect(failuresTo(s2)).toEqual([]);
        expect(s2.conn.close).not.toHaveBeenCalled();
    });

    test('a revoke during the park (the claim is gone): no seat, the auth refusal', async () => {
        const { store, id } = await state('pending');
        const s = sock('rj');
        gameManager.registerUser(s.id, 'Hal');
        const run = reconnectHandlers.rejoinGame(s, io, { gameId: id, username: 'Hal' });
        await jest.advanceTimersByTimeAsync(1000);
        gameManager.lockForMerge(['Hal']);
        await release(id);
        await jest.advanceTimersByTimeAsync(1100);
        await run;
        gameManager.unlockMerge(['Hal']);
        expect(store.adoptCalls).toHaveLength(1);
        expect(toSelf(s, 'rejoinSuccess')).toEqual([]);
        expect(toSelf(s, 'rejoinFailed')).toEqual([{ reason: 'Not authenticated' }]);
        expect(pointer('Hal')).toBe(id);
    });
});

describe('a cold start (index.js expectStart, start() not run yet)', () => {
    test('a rejoin before start() never fails: it waits for start, then the released doc is adopted and the socket seated', async () => {
        const { A, id } = await savedByA();
        await release(id);
        dies(A);
        await jest.advanceTimersByTimeAsync(1000);
        const B = kit.installOnStore(mockDb, { bootId: 'boot-B', getIo: () => io, monoNow: h.createMonoClock().now });
        B.expectStart();
        expect(pointerResolve.active()).toBe(true);
        const { s, run } = SITES.rejoinGame(id);
        await jest.advanceTimersByTimeAsync(500);
        expect(failuresTo(s)).toEqual([]);
        await B.start({ io });
        await jest.advanceTimersByTimeAsync(10);
        await run;
        expect(toSelf(s, 'rejoinSuccess')).toHaveLength(1);
        expect(B.adoptCalls).toHaveLength(1);
        expect(pointer('Hal')).toBe(id);
    });

    test('expectStart with the index known missing, and a store nobody starts: today\'s paths', async () => {
        const B = kit.installOnStore(mockDb, { bootId: 'boot-B', gameIdIndexUnique: () => false });
        B.expectStart();
        expect(pointerResolve.active()).toBe(false);
        const C = kit.installOnStore(mockDb, { bootId: 'boot-C' });
        expect(C.started).toBe(false);
        expect(pointerResolve.active()).toBe(false);
        ensureUser('Hal');
        await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: 'g-x' } });
        const r = SITES.rejoinGame('g-x');
        await r.run;
        expect(toSelf(r.s, 'rejoinFailed')).toEqual([{ reason: 'Game no longer exists' }]);
    });
});

describe('shutting down (on): no pointer clear anywhere', () => {
    test('signIn, restoreSession, rejoinGame, joinTournament: pointers to nothing are kept and no failure is sent for the game', async () => {
        let down = false;
        const B = kit.installOnStore(mockDb, { bootId: 'boot-B', getIo: () => io, monoNow: h.createMonoClock().now, isShuttingDown: () => down });
        await B.start({ io });
        await B.whenBootSwept();
        ensureUser('Hal');
        await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: 'g-none', activeTournamentId: 't-none' } });
        down = true;
        expect(pointerResolve.holdsPointers()).toBe(true);
        const a = SITES.signIn('g-none');
        await a.run;
        expect(toSelf(a.s, 'signInResponse')).toEqual([expect.objectContaining({ success: true, activeGameId: 'g-none' })]);
        const r = SITES.rejoinGame('g-none');
        await jest.advanceTimersByTimeAsync(10);
        expect(failuresTo(r.s)).toEqual([]);
        // The game pointer answered as held; the tournament one is not cleared either
        await users().updateOne({ username: 'Hal' }, { $unset: { activeGameId: '' } });
        const b = SITES.restoreSession();
        await b.run;
        expect(toSelf(b.s, 'restoreSessionResponse')).toEqual([expect.objectContaining({ success: true })]);
        const j = sock('jt');
        gameManager.registerUser(j.id, 'Hal');
        // PR 6: an unknown tournament while shutting down is pending too:
        // the joinTournament parks (no "not found"), then engine-closes
        const jt = tournamentHandlers.joinTournament(j, io, { tournamentId: 't-none' });
        await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: 'g-none' } });
        expect(userDoc('Hal')).toMatchObject({ activeGameId: 'g-none', activeTournamentId: 't-none' });
        await jest.advanceTimersByTimeAsync(pointerResolve.PARK_MS + 100);
        await jt;
        expect(pointer('Hal')).toBe('g-none');
        expect(userDoc('Hal')).toMatchObject({ activeTournamentId: 't-none' });
        expect(toSelf(r.s, 'rejoinFailed')).toEqual([]);
        expect(toSelf(j, 'serverError')).toEqual([]);
    });
});

describe('tournament pointers (on)', () => {
    async function withTournament(mode) {
        const store = mode === 'on'
            ? kit.installOnStore(mockDb, { bootId: 'boot-B', getIo: () => io, monoNow: h.createMonoClock().now })
            : kit.installStore(mockDb, { bootId: 'boot-W', mode });
        await store.start({ io });
        if (mode === 'on') await store.whenBootSwept();
        ensureUser('Tia');
        const t = sock('ti');
        gameManager.registerUser(t.id, 'Tia');
        const created = gameManager.createTournament(t.id, 'Cup');
        expect(created.success).toBe(true);
        ensureUser('Hal');
        await users().updateOne({ username: 'Hal' }, { $set: { activeTournamentId: created.tournament.tournamentId } });
        return { store, tid: created.tournament.tournamentId };
    }

    test.each(['signIn', 'restoreSession'])('%s: a non-member\'s pointer is answered as none and cleared (scoped); a member keeps it', async (site) => {
        const { tid } = await withTournament('on');
        const a = SITES[site]();
        await a.run;
        const [res] = toSelf(a.s, AUTH[site]);
        expect(res).toMatchObject({ success: true });
        expect(res.activeTournamentId).toBeUndefined();
        expect(userDoc('Hal').activeTournamentId).toBeUndefined();
        // Tia is a member: hers stays and is answered
        await users().updateOne({ username: 'Tia' }, { $set: { activeTournamentId: tid } });
        const s = sock('rs');
        if (site === 'signIn') await auth.signIn(s, io, { username: 'Tia', password: 'x' });
        else {
            const u = userDoc('Tia');
            const session = issueSession(u);
            Object.assign(u, session.update.$set);
            await auth.restoreSession(s, io, { username: 'Tia', sessionToken: session.token });
        }
        expect(toSelf(s, AUTH[site])).toEqual([expect.objectContaining({ success: true, activeTournamentId: tid })]);
        expect(userDoc('Tia').activeTournamentId).toBe(tid);
    });

    test('write: today\'s answer (a non-member\'s pointer is answered and kept)', async () => {
        const { tid } = await withTournament('write');
        const a = SITES.restoreSession();
        await a.run;
        expect(toSelf(a.s, 'restoreSessionResponse')).toEqual([expect.objectContaining({ success: true, activeTournamentId: tid })]);
        expect(userDoc('Hal').activeTournamentId).toBe(tid);
    });

    test.each([['on', 't-other'], ['write', undefined]])('joinTournament failure (%s): the clear is scoped in on, unscoped (today) otherwise', async (mode, expected) => {
        const store = mode === 'on'
            ? kit.installOnStore(mockDb, { bootId: 'boot-B', getIo: () => io, monoNow: h.createMonoClock().now })
            : kit.installStore(mockDb, { bootId: 'boot-W', mode });
        await store.start({ io });
        ensureUser('Hal');
        await users().updateOne({ username: 'Hal' }, { $set: { activeTournamentId: 't-other' } });
        const s = sock('jt');
        gameManager.registerUser(s.id, 'Hal');
        await tournamentHandlers.joinTournament(s, io, { tournamentId: 't-missing' });
        expect(userDoc('Hal').activeTournamentId).toBe(expected);
    });
});

describe('write and off: today\'s paths, resolve never asked', () => {
    test.each(['write', 'off'])('%s', async (mode) => {
        const store = kit.installStore(mockDb, { bootId: 'boot-W', mode });
        await store.start({ io });
        const resolve = jest.spyOn(store, 'resolve');
        expect(pointerResolve.active()).toBe(false);
        // Another instance's doc and a live older instance: still "gone" here
        const { game } = await kit.startGame(io, log, { humans: ['Ann'] });
        db().liveGames._insert({ _id: 'g-elsewhere', v: 3, kind: 'live', owner: 'boot-X', ownerMode: 'on', released: true, rev: 1 });
        db().serverInstances._insert({ _id: 'boot-X', mode: 'on', startedAt: new Date(Date.now() - 60000), beatAt: new Date(), beatSeq: 1 });
        ensureUser('Hal');
        await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: 'g-elsewhere' } });
        const a = SITES.signIn();
        await a.run;
        expect(toSelf(a.s, 'signInResponse')[0].activeGameId).toBeUndefined();
        expect(pointer('Hal')).toBeNull();
        await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: 'g-elsewhere' } });
        const r = SITES.rejoinGame('g-elsewhere');
        // Synchronous to the failure: no wait of any kind
        await r.run;
        expect(toSelf(r.s, 'rejoinFailed')).toEqual([{ reason: 'Game no longer exists' }]);
        expect(pointer('Hal')).toBeNull();
        const sp = SITES.joinAsSpectator('g-elsewhere');
        expect(toSelf(sp.s, 'serverError')).toEqual([expect.objectContaining({ message: 'Game not found' })]);
        const st = SITES.spectateTournamentGame('g-elsewhere');
        expect(toSelf(st.s, 'serverError')).toEqual([expect.objectContaining({ message: 'Game not found' })]);
        // The handlers are today's functions: joinAsSpectator stays synchronous
        expect(mainRoomHandlers.joinAsSpectator(sock('sp'), io, { gameId: 'g-elsewhere' })).toBeUndefined();
        expect(resolve).not.toHaveBeenCalled();
        expect(pointerResolve.restoring(r.s)).toBe(false);
        expect(gameManager.games.get(game.gameId)).toBeTruthy();
    });

    test("'on' latched to write (no unique gameId index): today's paths", async () => {
        const store = kit.installOnStore(mockDb, { bootId: 'boot-B', gameIdIndexUnique: () => false });
        await store.start({ io });
        expect(store.effectiveMode).toBe('write');
        expect(pointerResolve.active()).toBe(false);
        ensureUser('Hal');
        await users().updateOne({ username: 'Hal' }, { $set: { activeGameId: 'g-x' } });
        const r = SITES.rejoinGame('g-x');
        await r.run;
        expect(toSelf(r.s, 'rejoinFailed')).toEqual([{ reason: 'Game no longer exists' }]);
    });
});

test('adopt.RESUMED_LINE is the adopted game\'s line (sanity: the stub ran)', async () => {
    const { id } = await state('adoptable');
    const { run } = SITES.rejoinGame(id);
    await run;
    expect(gameManager.games.get(id).gameLog.filter((e) => e.message === adopt.RESUMED_LINE)).toHaveLength(1);
});
