/**
 * Pointer protection (deploy survival PR 5, the plan's 2.6;
 * LIVE_PERSIST=on with the unique gameId index only): the socket call
 * sites that read a user's activeGameId, or a game id a client sends,
 * ask the live persist store where that game is (liveStore.resolve)
 * instead of only this process's memory, so a table another instance still
 * holds (the deploy overlap) or saved (a released or dead owner's doc) is
 * never answered "it ended".
 *
 *   active()           the store resolves (liveStore.resolving): 'on' run
 *                      as 'on' (the unique gameId index), or about to start
 *                      (index.js expectStart). Everything here is a no-op
 *                      otherwise: the call sites keep today's code path,
 *                      unchanged (off, write, 'on' latched to 'write')
 *   resolveGame(id)    liveStore.resolve: {state: memory | adopted |
 *                      pending | gone, game?}
 *   holdsPointers()    this process is shutting down in 'on': every pointer
 *                      clear is skipped (its tables are being handed off)
 *   resolveThen(...)   the shared shape of a call site whose game is not in
 *                      memory: resolve; a game (in memory, adopted now) ->
 *                      onGame; gone -> onGone (today's failure); pending ->
 *                      park the socket (below), then the same
 *   park(socket, id)   wait at most PARK_MS for the game to be adopted here
 *                      (liveStore.whenAdopted). A pending answer NEVER
 *                      clears the pointer and never sends success:false,
 *                      rejoinFailed or "not found" (every client reads those
 *                      as "your game ended"). Still pending at PARK_MS: the
 *                      socket is engine-closed (socket.conn.close(), the
 *                      per-client close io.close does; never
 *                      socket.disconnect(), which web reads as terminal), so
 *                      the client reconnects as after a transport close and
 *                      tries a fresh restore. PARK_MS (8 s) is under web's
 *                      10 s rejoin hold (ClientSession REJOIN_HOLD_MS) and
 *                      iOS's 8 s disconnectWait. One park per socket and
 *                      game: a second request while one is parked joins it
 *                      (no answer of its own), so an adoption seats the
 *                      socket once. A socket that drops meanwhile gets
 *                      nothing
 *   resolveTournament(id) / resolveTournamentThen(...) / parkTournament(...)
 *                      the same for a tournament (PR 6: liveStore
 *                      resolveTournament / whenTournamentAdopted): signIn,
 *                      restoreSession, joinTournament, spectateTournament,
 *                      returnToTournament
 *   tracked(handler)   counts a socket's restore requests in flight
 *                      (signIn, restoreSession, rejoinGame, joinAsSpectator,
 *                      spectateTournamentGame; a park included) for
 *                      deferSnapshot
 *   deferSnapshot(...) requestSnapshot on a socket in no game: in 'on' its
 *                      not_in_game reply waits (at most SNAPSHOT_DEFER_MS)
 *                      while the socket's restore is in flight (or it has
 *                      not signed in yet) or its user's pointer resolves to
 *                      a game in memory, pending or adoptable; then the
 *                      truth (a snapshot if the rejoin seated it). Every
 *                      iOS build reads not_in_game as "your game ended"
 *                      (GameSocketHandler lost()), and a requestSnapshot
 *                      reaching the successor before the rejoin (the 5 s
 *                      ack resync, the foreground probe) would raise it
 *
 * Never logs a hand or chat: ids and states only.
 */

'use strict';

const { socketLogger } = require('../utils/logger');
const { safeTimeout } = require('../utils/safeTimer');

/** The longest a pending answer parks a socket before the engine close. */
const PARK_MS = 8000;
/** The longest requestSnapshot's not_in_game reply waits in 'on'. */
const SNAPSHOT_DEFER_MS = 8000;
/** deferSnapshot re-checks the socket's seat at least this often. */
const DEFER_POLL_MS = 250;
/** A park re-asks resolve() at most this many times (the doc turned out not adoptable). */
const PARK_ROUNDS = 3;

function store() {
    try {
        return require('../game/persist/liveStore').getLiveStore();
    } catch {
        return null;
    }
}

/**
 * True when the call sites resolve through the store (liveStore.resolving):
 * the boot mode is 'on' and the store runs as 'on' (latched at start(): the
 * unique gameId index), or server/index.js said it is about to start
 * (expectStart: a cold start resolves too, and resolve() waits for start,
 * never answering "gone" before it). Off, write, 'on' latched to 'write',
 * and a store nobody starts: false (today's code paths).
 */
function active() {
    const s = store();
    if (!s || s.mode !== 'on') return false;
    try {
        return s.resolving === true;
    } catch {
        return false;
    }
}

/** Where `gameId` is (liveStore.resolve; never throws). */
async function resolveGame(gameId, opts) {
    const s = store();
    if (!s || typeof s.resolve !== 'function') return { state: 'gone' };
    try {
        return await s.resolve(gameId, opts);
    } catch (err) {
        socketLogger.warn('Pointer resolve failed', { gameId, error: err.message });
        return { state: 'pending' };
    }
}

/** Where tournament `tournamentId` is (liveStore.resolveTournament; never throws). */
async function resolveTournament(tournamentId, opts) {
    const s = store();
    if (!s || typeof s.resolveTournament !== 'function') return { state: 'gone' };
    try {
        return await s.resolveTournament(tournamentId, opts);
    } catch (err) {
        socketLogger.warn('Pointer resolve failed', { tournamentId, error: err.message });
        return { state: 'pending' };
    }
}

/**
 * Whether another instance's saved doc of tournament `tournamentId` lists
 * `username` as a member: true | false | null (no doc, or unreadable).
 */
async function savedTournamentMember(tournamentId, username) {
    const s = store();
    if (!s || typeof s.collections !== 'function') return null;
    try {
        const coll = s.collections().liveTournaments;
        if (!coll) return null;
        const doc = await coll.findOne({ _id: tournamentId }, { projection: { 'state.players.username': 1 } });
        if (!doc) return null;
        return (doc.state?.players || []).some((p) => p && p.username === username);
    } catch {
        return null;
    }
}

/** True while this process, in 'on', is shutting down: pointer clears are skipped. */
function holdsPointers() {
    const s = store();
    try {
        return Boolean(s && typeof s.holdsPointers === 'function' && s.holdsPointers());
    } catch {
        return false;
    }
}

/** Whether the socket is still connected (socket.io sets connected=false on disconnect). */
function isLive(socket) {
    return socket.connected !== false;
}

/** Close the socket's transport (the client reconnects and restores again); never socket.disconnect(). */
function engineClose(socket, gameId, label) {
    socketLogger.info('Restore pending: engine close for a retry', { gameId, socketId: socket.id, via: label });
    try {
        socket.conn?.close?.();
    } catch (err) {
        socketLogger.warn('Engine close failed', { socketId: socket.id, error: err.message });
    }
}

// ---------- the park ----------

const parks = new WeakMap(); // socket -> Map(gameId -> promise)

const sleep = (ms) => new Promise((r) => {
    const t = safeTimeout(r, Math.max(0, ms), 'pointerResolve:sleep');
    t.unref?.();
});

/**
 * Park `socket` for `gameId` (resolve answered 'pending'). Resolves:
 *   {game}        the game is live here now (adopted) and the socket is
 *                 still connected: the caller seats it
 *   {gone: true}  the doc turned out not adoptable: the caller sends
 *                 today's failure (the pointer can go)
 *   null          the socket dropped, another park of this socket and game
 *                 answers instead, or the wait ran out (the socket is
 *                 engine-closed here)
 */
function park(socket, gameId, label = 'restore', kind = 'game') {
    let mine = parks.get(socket);
    if (!mine) parks.set(socket, (mine = new Map()));
    const key = `${kind}:${gameId}`;
    if (mine.has(key)) {
        socketLogger.debug('Restore pending: joined a park', { gameId, socketId: socket.id, via: label });
        return mine.get(key).then(() => null);
    }
    const p = parkOnce(socket, gameId, label, kind).finally(() => {
        if (mine.get(key) === p) mine.delete(key);
    });
    mine.set(key, p);
    return p;
}

/** park() for a tournament: resolves {tournament} | {gone: true} | null. */
function parkTournament(socket, tournamentId, label = 'restore') {
    return park(socket, tournamentId, label, 'tournament')
        .then((r) => (r && r.game ? { tournament: r.game } : r));
}

async function parkOnce(socket, gameId, label, kind = 'game') {
    const s0 = store();
    // The same loop for a game and a tournament (PR 6)
    const s = kind === 'game' ? s0 : {
        adopter: s0?.adopter,
        whenAdopted: (id, ms) => s0.whenTournamentAdopted(id, ms)
    };
    const ask = kind === 'game' ? resolveGame : (id, opts) => resolveTournament(id, opts).then((r) => ({ ...r, game: r.tournament }));
    const deadline = Date.now() + PARK_MS;
    socketLogger.info('Restore pending: socket parked', { gameId, socketId: socket.id, via: label });
    for (let round = 0; ; round++) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        let game = null;
        try {
            game = await s.whenAdopted(gameId, left);
        } catch {
            game = null;
        }
        if (!isLive(socket)) return null;
        if (game) return { game };
        if (Date.now() >= deadline || round + 1 >= PARK_ROUNDS) break;
        // Answered early with no game: the doc went (not adoptable), or the
        // store had nothing to wait on. Ask again
        const r = await ask(gameId, { waitMs: Math.max(0, deadline - Date.now()) });
        if (!isLive(socket)) return null;
        if (r.game) return { game: r.game };
        if (r.state === 'gone') return { gone: true };
        // Still pending with nothing to wait on: no tight loop
        if (!s.adopter) await sleep(Math.min(1000, deadline - Date.now()));
    }
    if (!isLive(socket)) return null;
    engineClose(socket, gameId, label);
    return null;
}

/**
 * A call site whose game `gameId` is not in memory, in 'on': resolve, then
 * onGame() (the game is live here now: re-run the call site, which finds it
 * in memory), onGone() (today's failure answer), or park then the same.
 * Nothing runs for a socket that dropped meanwhile.
 */
async function resolveThen(socket, gameId, label, { onGame, onGone }) {
    const r = await resolveGame(gameId);
    if (!isLive(socket)) return;
    if (r.game) return onGame(r.game);
    if (r.state === 'gone') return onGone();
    const parked = await park(socket, gameId, label);
    if (!parked || !isLive(socket)) return;
    if (parked.game) return onGame(parked.game);
    if (parked.gone) return onGone();
}

/**
 * resolveThen for a tournament not in memory, in 'on': onTournament(t)
 * (live here now: re-run the call site), onGone() (today's failure), or
 * park then the same. Nothing runs for a socket that dropped meanwhile.
 */
async function resolveTournamentThen(socket, tournamentId, label, { onTournament, onGone }) {
    const r = await resolveTournament(tournamentId);
    if (!isLive(socket)) return;
    if (r.tournament) return onTournament(r.tournament);
    if (r.state === 'gone') return onGone();
    const parked = await parkTournament(socket, tournamentId, label);
    if (!parked || !isLive(socket)) return;
    if (parked.tournament) return onTournament(parked.tournament);
    if (parked.gone) return onGone();
}

// ---------- restores in flight (requestSnapshot's deferral) ----------

const inFlight = new WeakMap(); // socket -> count
const settleWaiters = new WeakMap(); // socket -> Set of () => void

function begin(socket) {
    inFlight.set(socket, (inFlight.get(socket) || 0) + 1);
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        const n = (inFlight.get(socket) || 1) - 1;
        if (n > 0) inFlight.set(socket, n);
        else inFlight.delete(socket);
        const set = settleWaiters.get(socket);
        if (set) {
            settleWaiters.delete(socket);
            for (const fn of set) fn();
        }
    };
}

/** True while one of the socket's restore requests is in flight (parks included). */
function restoring(socket) {
    return (inFlight.get(socket) || 0) > 0;
}

/**
 * `handler` (socket, io, data, ...) with its run counted as a restore in
 * flight for that socket, in 'on' only. Off / write: the handler itself,
 * called as is (the same return value, sync or not).
 */
function tracked(handler) {
    const wrapped = function trackedRestore(socket, io, data, ...rest) {
        if (!socket || !active()) return handler(socket, io, data, ...rest);
        const end = begin(socket);
        let result;
        try {
            result = handler(socket, io, data, ...rest);
        } catch (err) {
            end();
            throw err;
        }
        if (result && typeof result.then === 'function') return result.finally(end);
        end();
        return result;
    };
    Object.defineProperty(wrapped, 'name', { value: handler.name });
    return wrapped;
}

/** Resolves on the socket's next restore end, or after `ms`. */
function nextSettle(socket, ms) {
    return new Promise((resolve) => {
        let set = settleWaiters.get(socket);
        if (!set) settleWaiters.set(socket, (set = new Set()));
        let t = null;
        const done = () => {
            if (t) clearTimeout(t);
            set.delete(done);
            resolve();
        };
        set.add(done);
        t = safeTimeout(done, Math.max(0, ms), 'pointerResolve:settle');
        t.unref?.();
    });
}

/** Does `username`'s saved activeGameId name a game in memory, pending or adoptable? */
async function pointerHolds(username, waitMs) {
    if (!username) return false;
    let gameId = null;
    try {
        const users = require('../database').getUsersCollection();
        const user = users ? await users.findOne({ username }, { projection: { activeGameId: 1 } }) : null;
        gameId = user?.activeGameId || null;
    } catch (err) {
        socketLogger.warn('Snapshot deferral: pointer read failed', { error: err.message });
        return false;
    }
    if (!gameId) return false;
    const r = await resolveGame(gameId, { waitMs });
    return r.state === 'memory' || r.state === 'adopted' || r.state === 'pending';
}

/**
 * requestSnapshot's not_in_game, in 'on' (see the header). `seated()` is
 * whether the socket is in a game now; `answer()` sends the truth then.
 * Never answers a socket that dropped.
 */
async function deferSnapshot(socket, { seated, answer, userOf }) {
    const deadline = Date.now() + SNAPSHOT_DEFER_MS;
    let pointerChecked = false;
    while (isLive(socket) && !seated()) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        const user = userOf();
        if (restoring(socket) || !user) {
            await nextSettle(socket, Math.min(DEFER_POLL_MS, left));
            continue;
        }
        if (!pointerChecked) {
            pointerChecked = true;
            if (!(await pointerHolds(user.username, Math.max(0, Math.min(3000, deadline - Date.now()))))) break;
            continue;
        }
        await nextSettle(socket, Math.min(DEFER_POLL_MS, left));
    }
    if (!isLive(socket)) return;
    answer();
}

module.exports = {
    active,
    resolveGame,
    holdsPointers,
    resolveThen,
    park,
    resolveTournament,
    resolveTournamentThen,
    savedTournamentMember,
    parkTournament,
    tracked,
    restoring,
    deferSnapshot,
    isLive,
    PARK_MS,
    SNAPSHOT_DEFER_MS
};
