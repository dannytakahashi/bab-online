/**
 * The live persist store (deploy survival, the plan's 2.3;
 * docs/claude/server-infra.md "Live game persistence"): live games and
 * tournaments written to MongoDB (liveGames, liveTournaments) while they
 * run, the ENDED tombstone at a game's end, and this process's
 * serverInstances document with its heartbeat.
 *
 * LIVE_PERSIST (utils/livePersistSwitch.js), read once at boot:
 *   off    nothing here runs: no hook listens, track / claim / scrub are
 *          no-ops (today's code paths)
 *   write  docs are written, tombstoned and deleted; heartbeat only (no
 *          sweep, no adoption, no handoff); at SIGTERM, after today's
 *          notice, this process deletes its own docs (shutdown())
 *   on     (PR 5, casual games) everything write does, plus: the store
 *          writes nothing until start() (its serverInstances doc exists
 *          first), a casual game's doc says ownerMode 'on' (adoptable),
 *          a lost doc is a fence (fenceOnLoss), the sweep adopts other
 *          instances' released or dead-owner docs (adopt.js), resolve()
 *          answers where a game is, the heartbeat carries the holder
 *          self-fence, and SIGTERM / a crash hand off (handoff.js). Only
 *          with gameRecords' UNIQUE gameId index (database
 *          getGameIdIndexUnique, read at start()): without it 'on' runs
 *          as 'write' (effectiveMode 'write', one log line). Tournaments
 *          and their tables keep ownerMode 'write' until PR 6, so nothing
 *          adopts them and a handoff deletes them (today's notice)
 *
 * Writes (one writer per entity, never awaited by game code):
 *   - a change (persist/hooks.js: GameState.nextSeq, _afterSeat,
 *     _applyTransition, addLogEntry; TournamentState._changed) marks the
 *     entity dirty; ONE setImmediate per entity serializes it then
 *     (gameCodec / tournamentCodec), so a whole synchronous run is one
 *     write. Latest wins: changes during a write in flight make exactly one
 *     follow-up write. A null serialize (pre-deal, DEALING / REDEAL,
 *     tainted, invalid, terminal) keeps the last good doc
 *   - the first write is insertOne; once one is acknowledged the id is
 *     never inserted or upserted again: later writes are
 *     updateOne({_id, owner: me, released: false}) with $set of the state
 *     and $push {$each: new log lines, $slice: -500}; after a failed or
 *     ambiguous write, a chat scrub or a sender rename, the next one $sets
 *     the whole log (still an update). E11000 on the insert (an ambiguous
 *     insert that did land) is read back: ours, then updates; else lost
 *   - matchedCount 0 -> findOne: gone at or after expireAt - 10 min ->
 *     stop persisting and play on; ANYTHING else (gone early, another
 *     owner, mine but released) means the doc is lost. In write mode that
 *     also stops persisting and plays on, with a
 *     warning: no instance can adopt a 'write' doc, so a lost one is an
 *     outside delete (an operator, a restore, a rolled-back write), never
 *     a successor, and the game must not end over it. With `fenceOnLoss`
 *     (the default in effective 'on'; tests) a lost doc is a fence: the local copy is retired
 *     (game.freeze: nothing more is emitted or timed; GameManager._retire
 *     with no io; a tournament is deleted from GameManager), no side
 *     effect runs, and the sockets at it are engine-closed
 *     (socket.conn.close(), what io.close does per client: the clients
 *     reconnect as after a transport close; never socket.disconnect(),
 *     which web reads as terminal). PR 5 note: a sweep must never delete
 *     a doc whose owner instance is still alive, whatever its ownerMode
 *   - expireAt is the entity's createdAt + 24 h (Mongo's TTL index deletes
 *     it then); the store stops writing, and deletes its doc, at
 *     createdAt + 23 h 50 m, so a TTL delete is never taken for a fence
 *   - one op at a time per id, in order (writes, the claim, the tombstone
 *     delete, a tournament's delete); errors are logged rate-limited with
 *     the id and rev only (never a doc, a hand or chat); the next change
 *     retries. A missing getter or a null collection skips (tests mock
 *     ../database partially; before connectDB)
 *
 * Terminal claim (gameHandlers gameEnd, gameLifecycle.abortGame): the
 * one await in game code. A game that ENDED gets its doc turned into the
 * ENDED tombstone (kind 'ended', ended: gameCodec.serializeEnded with the
 * gameRecords document recordGameStats then inserts) BEFORE its stats
 * start; the tombstone is deleted only once insertGameRecord is
 * acknowledged (recordAcked) and, for a tournament table, once a
 * tournament write listing it in completedGames is acknowledged. So a
 * kill between the two leaves the record in Mongo for an adopter (PR 5) to
 * insert exactly once (the unique gameId index). An aborted casual game's
 * doc is deleted; an aborted tournament table becomes a tombstone with
 * `aborted: true` (no record). In write mode the claim never fences (no
 * adopter exists): its outcome never skips stats. In 'on' a claim that
 * finds the doc gone early, another instance's or released answers
 * 'fenced' (another instance owns the end: gameEnd and abortGame then
 * skip stats, pointer clears and tournament scoring), and so does any
 * later claim of a game this store fenced.
 *
 * resolve(gameId) (PR 5, 'on'): where a game is, for the pointer call
 * sites (signIn, restoreSession, rejoinGame, spectate): in memory, adopted
 * now, 'pending' (another live instance holds it, or may still: never
 * answer "gone" then) or gone. See resolve() below.
 *
 * Holder self-fence (PR 5, 'on'): when no heartbeat has been acknowledged
 * for SELF_FENCE_MS on this process's monotonic clock, every casual table
 * with a saved doc is suspended (game.suspend(): timers remembered, no
 * emit, never saved meanwhile); after the next good beat each doc is
 * re-read: still ours and live -> unsuspend; anything else -> fenced (as
 * above: frozen, retired with no emit, sockets engine-closed).
 *
 * remove(): a game's doc is left to the claim (GameManager._retire runs
 * before it); a tournament's is deleted (GameManager.deleteTournament:
 * cancel, cleanup, abandonment).
 */

'use strict';

const { randomUUID } = require('crypto');
const { safeImmediate, safeInterval, safeTimeout } = require('../../utils/safeTimer');
const persistHooks = require('./hooks');
const { Phase } = require('../GamePhase');

const HOUR_MS = 60 * 60 * 1000;
/** A doc's expireAt: its entity's createdAt + this (the TTL index deletes it then). */
const TTL_MS = 24 * HOUR_MS;
/** The store stops writing (and deletes the doc) this long before expireAt. */
const STOP_BEFORE_EXPIRE_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 3000;
/** GameState.maxLogEntries: the saved log keeps the same last lines. */
const LOG_CAP = 500;
/** SIGTERM in write mode: the self-delete gets this long. */
const SHUTDOWN_DELETE_MS = 2000;
/** A terminal claim never holds game code up longer than this. */
const CLAIM_MAX_MS = 5000;
/** One log line per kind of failure at most this often. */
const LOG_EVERY_MS = 60 * 1000;
/** 'on': this long without an acknowledged heartbeat (monotonic) suspends this process's tables. */
const SELF_FENCE_MS = 8000;
/** 'on': how often the self-fence is checked (between heartbeats). */
const FENCE_CHECK_MS = 1000;
/** 'on': a heartbeat that has not answered after this long no longer blocks the next one. */
const BEAT_WAIT_MS = 2 * HEARTBEAT_MS;
/** /ready answers 200 this long after start() even if the boot sweep has not finished. */
const BOOT_SWEEP_CAP_MS = 20000;
/** resolve(): the longest wait for connectDB and the boot sweep before an answer. */
const RESOLVE_WAIT_MS = 3000;

const COLLECTION = { game: 'liveGames', tournament: 'liveTournaments' };
const LIVE_GETTERS = Object.freeze({
    liveGames: 'getLiveGamesCollection',
    liveTournaments: 'getLiveTournamentsCollection',
    serverInstances: 'getServerInstancesCollection'
});
// Jest only (testUtils/liveTestCollections.js, LIVE_PERSIST=write runs):
// stand-in live collections for the many tests whose jest.mock('../database')
// has no live getters, so the whole suite exercises the store. On
// globalThis so a jest.resetModules() keeps it; never set outside NODE_ENV=test
const TEST_FALLBACK = Symbol.for('bab.liveStore.testCollections');

/**
 * The live collections from a database module; a missing getter (a partial
 * jest.mock) is null, or under Jest the registered stand-in.
 */
function defaultCollections(database = require('../../database')) {
    const fallback = process.env.NODE_ENV === 'test' && typeof globalThis[TEST_FALLBACK] === 'function'
        ? globalThis[TEST_FALLBACK]
        : null;
    const get = (name) => {
        const fn = database[name];
        if (typeof fn !== 'function') return fallback ? fallback(name) || null : null;
        try {
            return fn() || null;
        } catch {
            return null;
        }
    };
    return {
        liveGames: get(LIVE_GETTERS.liveGames),
        liveTournaments: get(LIVE_GETTERS.liveTournaments),
        serverInstances: get(LIVE_GETTERS.serverInstances)
    };
}

/** Jest only: `fn(getterName)` -> a collection, for database mocks without the live getters; null clears. */
function _setTestFallbackCollections(fn) {
    if (fn) globalThis[TEST_FALLBACK] = fn;
    else delete globalThis[TEST_FALLBACK];
}

function defaultLogger() {
    return require('../../utils/logger').createModuleLogger('persist');
}

function defaultGameIdIndexUnique() {
    const database = require('../../database');
    return typeof database.getGameIdIndexUnique === 'function' ? database.getGameIdIndexUnique() : null;
}

const gameManagerOf = () => require('../GameManager');

/** The sockets to engine-close when a game is fenced: owners, players, spectators. */
function gameSocketIds(game) {
    const ids = new Set();
    const isBot = (sid) => typeof sid === 'string' && sid.startsWith('bot:');
    for (const s of game.seatList?.() || []) if (s.ownerSocketId) ids.add(s.ownerSocketId);
    for (const sid of game.players?.keys?.() || []) ids.add(sid);
    for (const sid of game.spectators?.keys?.() || []) ids.add(sid);
    return [...ids].filter((sid) => !isBot(sid) && !String(sid).startsWith('restored:'));
}

function engineClose(io, socketIds) {
    let n = 0;
    for (const sid of socketIds) {
        const socket = io?.sockets?.sockets?.get?.(sid);
        if (socket?.conn && typeof socket.conn.close === 'function') {
            socket.conn.close();
            n++;
        }
    }
    return n;
}

/**
 * A fenced game: another instance owns it (or its doc is gone). Retire the
 * local copy without a sound: freeze (no emit, no timer, every in-flight
 * continuation stale), GameManager._retire with no io (bots, mappings,
 * spectators; no room or DB side effect), then engine-close its sockets.
 */
function defaultGameFence(game, { io }) {
    const ids = gameSocketIds(game);
    if (!game.isTerminal()) game.freeze();
    const gm = gameManagerOf();
    if (gm.games.get(game.gameId) === game) gm._retire(game, null);
    return engineClose(io, ids);
}

/** A fenced tournament: deleted here with no emit; its members' and spectators' sockets engine-closed. */
function defaultTournamentFence(t, { io }) {
    const ids = [...t.players.keys(), ...t.spectators.keys()].filter((sid) => !String(sid).startsWith('restored:'));
    const gm = gameManagerOf();
    if (gm.tournaments.get(t.tournamentId) === t) gm.deleteTournament(t.tournamentId);
    else t.retire?.();
    return engineClose(io, ids);
}

/** A rejection that only settles `p` (never rejects) within `ms`; resolves `onTimeout` after. */
function bounded(p, ms, onTimeout) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = safeTimeout(() => resolve(onTimeout), ms, 'liveStore:bound');
        timer.unref?.();
    });
    return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {Object} [opts]
 * @param {'off'|'write'|'on'} [opts.mode]
 * @param {Function} [opts.getCollections] - () => {liveGames, liveTournaments, serverInstances} (each may be null)
 * @param {string} [opts.bootId]
 * @param {string|null} [opts.deploymentId]
 * @param {Function} [opts.now] - wall clock in ms (expireAt, createdAt, beats)
 * @param {Object} [opts.logger]
 * @param {Function} [opts.getIo] - the io whose sockets a fence closes
 * @param {Function} [opts.serializeGame] / [opts.serializeTournament] / [opts.serializeEnded] - the codecs
 * @param {Function} [opts.onGameFenced] / [opts.onTournamentFenced] - (entity, {io, why}) the retire
 * @param {Function} [opts.listGames] / [opts.listTournaments] - () => iterable of live ids (heartbeat)
 * @param {Function} [opts.tournamentOfGame] - gameId -> the live TournamentState it belongs to, or null
 * @param {Function} [opts.gameIdIndexUnique] - () => true | false | null (/health)
 * @param {boolean|null} [opts.fenceOnLoss=null] - a lost doc (gone early, another
 *   owner, released) fences the entity instead of stopping its writes.
 *   null: on in effective 'on', off in write mode (nothing can adopt a
 *   'write' doc); the fence tests set it
 * @param {Function} [opts.monoNow] - this process's monotonic clock in ms
 *   (observer-side death, the self-fence, the /ready cap; never compared
 *   with another instance's)
 * @param {Object} [opts.adoption] - 'on': adopt.js's dependencies and
 *   timings (createAdopter), for tests; production uses the defaults
 * @param {Function} [opts.isShuttingDown] - () => boolean (utils/shutdown)
 * @param {Function} [opts.suspendGame] / [opts.unsuspendGame] - the
 *   reversible holder self-fence (game.suspend() / game.unsuspend(io))
 * @param {Function} [opts.whenDbReady] - (ms) => Promise<boolean> (database.whenReady)
 */
function createLiveStore({
    mode = 'off',
    getCollections = () => defaultCollections(),
    bootId = randomUUID(),
    deploymentId = null,
    now = () => Date.now(),
    logger = defaultLogger(),
    getIo = () => null,
    serializeGame = (game) => require('./gameCodec').serialize(game),
    serializeTournament = (t) => require('./tournamentCodec').serialize(t),
    serializeEnded = (game, record, opts) => require('./gameCodec').serializeEnded(game, record, opts),
    onGameFenced = defaultGameFence,
    onTournamentFenced = defaultTournamentFence,
    listGames = () => gameManagerOf().games.keys(),
    listTournaments = () => gameManagerOf().tournaments.keys(),
    tournamentOfGame = (gameId) => {
        const gm = gameManagerOf();
        const tid = gm.tournamentGames.get(gameId);
        return tid ? gm.tournaments.get(tid) || null : null;
    },
    gameIdIndexUnique = defaultGameIdIndexUnique,
    fenceOnLoss = null,
    monoNow = () => performance.now(),
    adoption = {},
    isShuttingDown = () => require('../../utils/shutdown').isShuttingDown(),
    suspendGame = (game) => game.suspend(),
    unsuspendGame = (game, io) => game.unsuspend(io),
    whenDbReady = (ms) => {
        const database = require('../../database');
        return typeof database.whenReady === 'function' ? database.whenReady(ms) : Promise.resolve(true);
    }
} = {}) {
    const active = mode === 'write' || mode === 'on';
    // 'on' needs gameRecords' unique gameId index (an adopted tombstone and
    // the old owner's drain could otherwise insert one game twice). Read at
    // start(), after connectDB's index probe, and kept for the process;
    // before that it follows the probe
    let latchedMode = null;
    const computeEffective = () => {
        if (mode !== 'on') return mode;
        return safeCall(gameIdIndexUnique) === true ? 'on' : 'write';
    };
    const effective = () => latchedMode ?? computeEffective();
    const isOn = () => effective() === 'on';
    const fences = () => (fenceOnLoss === null ? isOn() : fenceOnLoss);

    // entity -> state, and id -> state (tombstones, tournaments by id)
    const byEntity = new WeakMap();
    const byId = new Map();
    // gameId -> {st, tournamentId, recordAcked, tournamentAcked, deleting, retry}
    const tombstones = new Map();
    // How the record went for a game whose claim is still pending (past its
    // CLAIM_MAX_MS bound, so the stats started first): gameId -> 'acked'
    // (insert acknowledged) | 'failed' (recordGameStats settled without it)
    const recordedEarly = new Map();
    // Callers' waits on claims not settled yet: close() ends them at once
    const claimWaits = new Set();
    // Fire-and-forget ops outside an entity's queue (instance doc, deletes)
    const looseOps = new Set();
    const logState = new Map();
    let closed = false;
    let ioRef = null;
    let started = false;
    let startExpected = false;
    let heartbeat = null;
    let beating = false;
    let beatSeq = 0;
    let installed = false;
    // 'on' only
    let startedAt = null;          // wall clock (Date) of start(): the instance doc's startedAt
    let startedMono = null;        // monotonic, for the /ready cap
    let lastBeatOkMono = null;     // the last acknowledged heartbeat (monotonic)
    let beatStartedMono = null;    // the heartbeat in flight began then
    let fenceCheck = null;
    let selfFenced = false;
    let recovering = false;
    let keepBeating = false;       // a handoff closed the writes but beats on until it ends
    let writesOpen = false;        // 'on': start() has written the instance doc
    let readyCapLogged = false;
    let markStarted;
    const startedPromise = new Promise((r) => { markStarted = r; });
    // Games this store fenced: a later terminal claim answers 'fenced' (another instance ends them)
    const fencedGames = new WeakSet();
    let adopter = null;

    const listener = {
        game: (game) => markDirty(game),
        tournament: (t) => markDirty(t)
    };

    function collections() {
        try {
            return getCollections() || {};
        } catch {
            return {};
        }
    }
    const collectionFor = (st) => collections()[COLLECTION[st.kind]] || null;

    const idField = (st) => (st.kind === 'game' ? 'gameId' : 'tournamentId');

    /** Rate-limited: one line per `key` per LOG_EVERY_MS, with the count skipped. Ids and rev only. */
    function logFailure(key, st, err, extra = {}) {
        const t = now();
        const entry = logState.get(key) || { at: -Infinity, skipped: 0 };
        if (t - entry.at < LOG_EVERY_MS) {
            entry.skipped++;
            logState.set(key, entry);
            return;
        }
        const meta = {
            ...(st && { [idField(st)]: st.id, rev: st.rev }),
            error: err?.name || 'Error',
            ...(err?.code !== undefined && { code: err.code }),
            ...(entry.skipped > 0 && { skipped: entry.skipped }),
            ...extra
        };
        logState.set(key, { at: t, skipped: 0 });
        logger.warn(`Live persist ${key} failed`, meta);
    }

    function track(entity, kind) {
        if (!active || closed || !entity) return;
        if (byEntity.has(entity)) return;
        const id = kind === 'game' ? entity.gameId : entity.tournamentId;
        if (typeof id !== 'string' || !id) return;
        const createdAt = Number.isFinite(entity.createdAt) ? entity.createdAt : now();
        const st = {
            id, kind, entity, createdAt,
            inserted: false,       // an insert was acknowledged: update-only from now on
            insertTried: false,    // an insert was sent (it may have landed)
            dirty: false,
            immediate: null,
            ops: 0,
            tail: Promise.resolve(),
            rev: 0,
            lastLogTotal: null,
            fullLog: true,
            fullLogSeq: 0,
            lastJson: null,        // tournaments: the last acknowledged doc
            completed: new Set(),  // tournaments: completedGames of the last acknowledged doc
            rereads: 0,            // read-backs in a row that found the doc ours
            retired: false,        // left GameManager (no live writes)
            done: false,           // stopped, fenced, removed: no more writes at all
            suspended: false,      // 'on': the holder self-fence holds its writes
            resetAttempts: false   // 'on', adopted: the first write after the restore gate opens $sets adoptAttempts 0
        };
        byEntity.set(entity, st);
        byId.set(`${kind}:${id}`, st);
        addToInstance(kind, id);
        markDirty(entity);
    }

    /**
     * 'on', adoption (adopt.js): `game` was just built from `doc`, which
     * this process now owns (the adopt compare-and-set landed at doc.rev).
     * Its writes go on as updates of that doc (never an insert), the first
     * one with the whole log (the adoption scrubbed lines and added one).
     */
    function trackAdopted(game, doc) {
        if (!active || closed || !game) return null;
        const id = game.gameId;
        const prev = byId.get(`game:${id}`);
        if (prev && !prev.done) forget(prev);
        const createdAt = doc.createdAt instanceof Date ? doc.createdAt.getTime()
            : Number.isFinite(game.createdAt) ? game.createdAt : now();
        const st = {
            id, kind: 'game', entity: game, createdAt,
            inserted: true, insertTried: true, dirty: false, immediate: null, ops: 0,
            tail: Promise.resolve(), rev: Number.isInteger(doc.rev) ? doc.rev : 0,
            lastLogTotal: Number.isInteger(doc.logTotal) ? doc.logTotal : null,
            fullLog: true, fullLogSeq: 0, lastJson: null, completed: new Set(), rereads: 0,
            retired: false, done: false, suspended: false, resetAttempts: true,
            // The adoption fields a whole-doc write (the handoff's final write) keeps
            adoption: { adoptAttempts: Number(doc.adoptAttempts) || 0, adoptedBy: doc.adoptedBy ?? null, adoptedAt: doc.adoptedAt ?? null }
        };
        byEntity.set(game, st);
        byId.set(`game:${id}`, st);
        addToInstance('game', id);
        markDirty(game);
        return st;
    }

    function markDirty(entity) {
        if (!active || closed) return;
        const st = byEntity.get(entity);
        if (!st || st.done || st.retired) return;
        if (st.kind === 'game') {
            // A table's running score is in its tournament's doc (tableScores)
            const t = safeCall(() => tournamentOfGame(st.id));
            if (t) markDirty(t);
        }
        if (!collectionFor(st)) return;
        st.dirty = true;
        schedule(st);
    }

    function safeCall(fn) {
        try {
            return fn();
        } catch {
            return null;
        }
    }

    function schedule(st) {
        if (st.immediate || st.ops > 0 || closed || st.done) return;
        // 'on': nothing is written before this process's instance doc
        // exists (start()), so no doc ever names an owner no instance
        // doc speaks for; and nothing while the self-fence holds it
        if (mode === 'on' && (!writesOpen || st.suspended)) return;
        st.immediate = safeImmediate(() => {
            st.immediate = null;
            if (st.dirty && !st.done && !st.retired && !closed && !st.suspended) enqueue(st, () => writeOnce(st));
        }, 'liveStore:write');
    }

    /** Run `fn` after every earlier op of this id; never rejects. */
    function enqueue(st, fn) {
        st.ops++;
        const run = st.tail.then(() => fn()).catch((err) => logFailure('op', st, err)).finally(() => {
            st.ops--;
            if (st.ops > 0 || st.done) return;
            // A retired game nothing was ever sent for has no doc to end
            if (st.retired && st.kind === 'game' && !st.inserted && !st.insertTried && !tombstones.has(st.id)) {
                forget(st);
                return;
            }
            if (st.dirty && !st.retired && !closed) schedule(st);
        });
        st.tail = run;
        return run;
    }

    function loose(promise) {
        const p = Promise.resolve(promise).catch(() => {}).finally(() => looseOps.delete(p));
        looseOps.add(p);
        return p;
    }

    const stopAt = (st) => st.createdAt + TTL_MS - STOP_BEFORE_EXPIRE_MS;

    /**
     * The ownerMode a doc says: 'on' (adoptable) only for a casual game in
     * effective 'on'; a tournament and its tables stay 'write' until the
     * tournament handoff exists (PR 6), so nothing adopts them.
     */
    function ownerModeFor(st, doc) {
        const m = effective();
        if (m !== 'on') return m;
        return st.kind === 'game' && !(doc && doc.tournamentId) ? 'on' : 'write';
    }

    function envelope(st, doc, at) {
        const base = {
            _id: st.id,
            v: doc.v,
            kind: 'live',
            owner: bootId,
            ownerMode: ownerModeFor(st, doc),
            released: false,
            releasedAt: null,
            rev: st.rev,
            createdAt: new Date(st.createdAt),
            updatedAt: at,
            expireAt: new Date(st.createdAt + TTL_MS),
            adoptAttempts: st.adoption ? st.adoption.adoptAttempts : 0,
            adoptedBy: st.adoption ? st.adoption.adoptedBy : null,
            adoptedAt: st.adoption ? st.adoption.adoptedAt : null
        };
        if (st.kind === 'game') {
            return { ...base, stage: doc.stage, tournamentId: doc.tournamentId ?? null, state: doc.state, log: doc.log, logTotal: doc.logTotal, bots: doc.bots };
        }
        return { ...base, phase: doc.phase, state: doc.state, completedAt: doc.state?.completedAt ?? null };
    }

    function updateFor(st, doc, at, fullLog) {
        const set = { v: doc.v, rev: st.rev, updatedAt: at, state: doc.state };
        const update = { $set: set };
        if (mode === 'on') {
            // An early doc (before the index probe latched the mode) says what holds now
            set.ownerMode = ownerModeFor(st, doc);
            // Adopted: the first write once the restore gate is open (an
            // owner is back, the table plays) clears the crash-loop counter
            if (st.resetAttempts && st.kind === 'game' && adopter && !adopter.gated(st.entity)) set.adoptAttempts = 0;
        }
        if (st.kind === 'tournament') {
            set.phase = doc.phase;
            set.completedAt = doc.state?.completedAt ?? null;
            return update;
        }
        set.stage = doc.stage;
        set.tournamentId = doc.tournamentId ?? null;
        set.logTotal = doc.logTotal;
        set.bots = doc.bots;
        const fresh = st.lastLogTotal == null ? -1 : doc.logTotal - st.lastLogTotal;
        if (fullLog || fresh < 0 || fresh > doc.log.length) set.log = doc.log;
        else if (fresh > 0) update.$push = { log: { $each: doc.log.slice(-fresh), $slice: -LOG_CAP } };
        return update;
    }

    function acked(st, doc, json, fullLogSeq, update = null) {
        st.inserted = true;
        st.rereads = 0;
        if (update && update.$set && update.$set.adoptAttempts === 0) {
            st.resetAttempts = false;
            if (st.adoption) st.adoption.adoptAttempts = 0;
        }
        if (st.fullLogSeq === fullLogSeq) st.fullLog = false;
        if (st.kind === 'game') {
            st.lastLogTotal = doc.logTotal;
            return;
        }
        st.lastJson = json;
        st.completed = new Set((doc.state?.rounds || []).flatMap((r) => r.completedGames || []));
        for (const tb of tombstones.values()) {
            if (tb.tournamentId === st.id && !tb.tournamentAcked && st.completed.has(tb.gameId)) {
                tb.tournamentAcked = true;
                maybeDeleteTombstone(tb);
            }
        }
    }

    function failed(st, op, err) {
        st.fullLog = true;
        st.fullLogSeq++;
        logFailure(op, st, err);
    }

    async function writeOnce(st) {
        if (!st.dirty || st.done || st.retired || closed || st.suspended) return;
        st.dirty = false;
        let doc;
        try {
            doc = st.kind === 'game' ? serializeGame(st.entity) : serializeTournament(st.entity);
        } catch (err) {
            logFailure('serialize', st, err);
            return;
        }
        if (!doc) return;
        if (now() >= stopAt(st)) {
            await stopAtCap(st);
            return;
        }
        const json = st.kind === 'tournament' ? JSON.stringify(doc) : null;
        if (json !== null && json === st.lastJson && !st.fullLog) return;
        const coll = collectionFor(st);
        // Gone since markDirty checked (tests swap the db): the next change retries
        if (!coll) return;
        const fullLogSeq = st.fullLogSeq;
        const fullLog = st.fullLog;
        st.rev++;
        const at = new Date(now());
        if (!st.inserted) {
            st.insertTried = true;
            try {
                await coll.insertOne(envelope(st, doc, at));
            } catch (err) {
                if (err?.code === 11000) {
                    await readBack(st, coll, 'insert');
                    return;
                }
                failed(st, 'insert', err);
                return;
            }
            acked(st, doc, json, fullLogSeq);
            return;
        }
        let res;
        const update = updateFor(st, doc, at, fullLog);
        try {
            res = await coll.updateOne({ _id: st.id, owner: bootId, released: false }, update);
        } catch (err) {
            failed(st, 'update', err);
            return;
        }
        if (res && res.matchedCount === 0) {
            await readBack(st, coll, 'update');
            return;
        }
        acked(st, doc, json, fullLogSeq, update);
    }

    /**
     * An insert hit E11000 or an update matched nothing: what is there?
     * Ours (an ambiguous insert that landed): write it again as an update.
     * Gone near expireAt: stop. Anything else: lost (stop, or a fence with fenceOnLoss).
     */
    async function readBack(st, coll, op) {
        let doc;
        try {
            doc = await coll.findOne({ _id: st.id }, { projection: { owner: 1, released: 1, kind: 1 } });
        } catch (err) {
            failed(st, `${op} read-back`, err);
            return;
        }
        if (!doc) {
            if (now() >= stopAt(st)) {
                stop(st, 'expired');
                return;
            }
            lost(st, 'gone');
            return;
        }
        if (doc.owner !== bootId) {
            lost(st, 'owner');
            return;
        }
        if (doc.released) {
            lost(st, 'released');
            return;
        }
        // Ours and live: the earlier insert did land. Updates from now on,
        // starting with the whole state (once: a second read-back in a row
        // waits for the next change instead of looping)
        st.inserted = true;
        st.fullLog = true;
        st.fullLogSeq++;
        st.rereads = (st.rereads || 0) + 1;
        if (st.rereads === 1) st.dirty = true;
    }

    function cancelImmediate(st) {
        if (st.immediate) {
            clearImmediate(st.immediate);
            st.immediate = null;
        }
    }

    function forget(st) {
        cancelImmediate(st);
        st.done = true;
        if (byId.get(`${st.kind}:${st.id}`) === st) byId.delete(`${st.kind}:${st.id}`);
        if (st.kind === 'tournament') settleTournamentTombstones(st.id);
        // An early record ack only ever serves this game's pending claim
        else if (tombstones.get(st.id)?.st !== st) recordedEarly.delete(st.id);
    }

    function stop(st, why) {
        logger.info('Live doc no longer saved', { [idField(st)]: st.id, rev: st.rev, why });
        forget(st);
    }

    /** createdAt + 23 h 50 m: stop writing and delete the doc (it would expire in 10 min). */
    async function stopAtCap(st) {
        stop(st, 'cap');
        if (!st.inserted && !st.insertTried) return;
        const coll = collectionFor(st);
        if (!coll) return;
        try {
            await coll.deleteOne({ _id: st.id, owner: bootId, released: false });
        } catch (err) {
            logFailure('cap delete', st, err);
        }
    }

    /**
     * The doc is gone early, another owner's, or released. Write mode: stop
     * persisting and play on (nothing adopts a 'write' doc, so nobody else
     * runs this game). fenceOnLoss: a fence.
     */
    function lost(st, why) {
        if (st.done) return;
        if (fences()) {
            fence(st, why);
            return;
        }
        logger.warn('Live doc lost; no longer saved, play goes on', { [idField(st)]: st.id, rev: st.rev, why });
        forget(st);
    }

    function fence(st, why) {
        if (st.done) return;
        forget(st);
        if (st.kind === 'game' && st.entity) fencedGames.add(st.entity);
        logger.warn('Live doc fenced: this instance no longer owns it', { [idField(st)]: st.id, rev: st.rev, why });
        const io = ioRef || safeCall(getIo);
        try {
            if (st.kind === 'game') onGameFenced(st.entity, { io, why });
            else onTournamentFenced(st.entity, { io, why });
        } catch (err) {
            logFailure('fence', st, err);
        }
    }

    // ---------- tombstones ----------

    function tournamentLists(tournamentId, gameId) {
        const tst = byId.get(`tournament:${tournamentId}`);
        // Not saved (never tracked, or deleted, fenced, stopped): nothing to wait for
        if (!tst || tst.done) return true;
        return tst.completed.has(gameId);
    }

    function settleTournamentTombstones(tournamentId) {
        for (const tb of tombstones.values()) {
            if (tb.tournamentId === tournamentId && !tb.tournamentAcked) {
                tb.tournamentAcked = true;
                maybeDeleteTombstone(tb);
            }
        }
    }

    function registerTombstone(st, { tournamentId, recordAcked }) {
        const early = recordedEarly.get(st.id);
        recordedEarly.delete(st.id);
        if (early === 'failed' && !recordAcked) {
            // The record's insert already failed for good: nothing will
            // delete this tombstone, so it is left to the TTL from now
            giveUpTombstone(st);
            return;
        }
        const tb = {
            gameId: st.id,
            st,
            tournamentId: tournamentId || null,
            recordAcked: recordAcked || early === 'acked',
            tournamentAcked: !tournamentId || tournamentLists(tournamentId, st.id),
            deleting: false,
            retry: false
        };
        tombstones.set(st.id, tb);
        // The tombstone needs the id and the queue, never the game: let the GameState go
        st.entity = null;
        maybeDeleteTombstone(tb);
    }

    function maybeDeleteTombstone(tb) {
        if (!tb.recordAcked || !tb.tournamentAcked || tb.deleting || closed) return;
        if (tombstones.get(tb.gameId) !== tb) return;
        tb.deleting = true;
        tb.retry = false;
        enqueue(tb.st, async () => {
            const coll = collectionFor(tb.st);
            try {
                if (!coll) throw Object.assign(new Error('no collection'), { name: 'NoCollection' });
                await coll.deleteOne({ _id: tb.gameId, owner: bootId, kind: 'ended' });
                tombstones.delete(tb.gameId);
                forget(tb.st);
            } catch (err) {
                tb.retry = true;
                logFailure('tombstone delete', tb.st, err);
            } finally {
                tb.deleting = false;
            }
        });
    }

    /**
     * The terminal claim (gameEnd after GameManager.endGame; abortGame
     * after its retire). Null when there is nothing to claim (off, not
     * tracked, never written): the caller goes on without an await.
     * Otherwise a promise of 'claimed' | 'deleted' | 'stopped' | 'error'
     * ('fenced' only once a mode can be fenced at its end: never in
     * write), settled within CLAIM_MAX_MS.
     * @param {GameState} game
     * @param {{record?: Object|null, tournamentId?: string|null}} [opts] -
     *   record: the gameRecords doc (buildGameEndRecord) recordGameStats
     *   is about to insert (null: nothing to record)
     */
    /** True when claimEnded(game) has a doc to end (gameEnd builds the record only then). */
    function claimable(game) {
        if (!active || !game) return false;
        // A fenced game's end belongs to the instance that owns it now
        if (fencedGames.has(game)) return true;
        if (closed) return false;
        const st = byEntity.get(game);
        return !!st && !st.done && (st.inserted || st.insertTried) && !!collectionFor(st);
    }

    function claimEnded(game, { record = null, tournamentId = null } = {}) {
        if (!active || !game) return null;
        if (fencedGames.has(game)) return Promise.resolve('fenced');
        if (closed) return null;
        const st = byEntity.get(game);
        if (!st || st.done) return null;
        st.retired = true;
        cancelImmediate(st);
        if (!st.inserted && !st.insertTried) {
            // Never written (pre-deal): no doc to end
            forget(st);
            return null;
        }
        const aborted = game.isTerminal() && game.stage !== Phase.ENDED;
        const claim = enqueue(st, async () => {
            const outcome = await claimOnce();
            // Nothing registered (an error, a gone doc): the doc, if any, is
            // left to the TTL (or this process's shutdown delete), and the
            // game is let go here
            if (!tombstones.has(st.id) && !st.done) forget(st);
            return outcome;
        });
        async function claimOnce() {
            const coll = collectionFor(st);
            if (!coll) return 'error';
            if (aborted && !tournamentId) {
                // A casual game that aborted records nothing: its doc goes
                try {
                    await coll.deleteOne({ _id: st.id, owner: bootId, released: false });
                    forget(st);
                    return 'deleted';
                } catch (err) {
                    logFailure('abort delete', st, err);
                    return 'error';
                }
            }
            let ended;
            try {
                ended = serializeEnded(game, aborted ? null : record, { tournamentId });
                if (aborted) ended.aborted = true;
            } catch (err) {
                logFailure('serialize ended', st, err);
                return 'error';
            }
            st.rev++;
            const at = new Date(now());
            const set = { kind: 'ended', ended, rev: st.rev, updatedAt: at };
            let res;
            try {
                if (!st.inserted) {
                    // The live insert never came back: the tombstone may be the first doc
                    try {
                        await coll.insertOne({
                            ...envelope(st, { v: null, stage: game.stage, tournamentId, state: null, log: [], logTotal: 0, bots: [] }, at),
                            ...set
                        });
                        st.inserted = true;
                        registerTombstone(st, { tournamentId, recordAcked: aborted || record == null });
                        return 'claimed';
                    } catch (err) {
                        if (err?.code !== 11000) throw err;
                    }
                }
                res = await coll.updateOne({ _id: st.id, owner: bootId, released: false, kind: 'live' }, { $set: set });
            } catch (err) {
                logFailure('claim', st, err);
                return 'error';
            }
            if (!res || res.matchedCount !== 0) {
                registerTombstone(st, { tournamentId, recordAcked: aborted || record == null });
                return 'claimed';
            }
            let doc;
            try {
                doc = await coll.findOne({ _id: st.id }, { projection: { owner: 1, released: 1, kind: 1 } });
            } catch (err) {
                logFailure('claim read-back', st, err);
                return 'error';
            }
            if (doc && doc.owner === bootId && !doc.released && doc.kind === 'ended') {
                // An earlier claim landed (its reply was lost)
                registerTombstone(st, { tournamentId, recordAcked: aborted || record == null });
                return 'claimed';
            }
            if (!doc && now() >= stopAt(st)) {
                stop(st, 'expired');
                return 'stopped';
            }
            if (fences()) {
                // 'on': gone early, another instance's or released: that
                // instance (an adopter) owns the end. No stats, no pointer
                // clear, no tournament score from this copy
                logger.warn('Terminal claim fenced: another instance owns the game', { gameId: st.id, rev: st.rev, why: !doc ? 'gone' : doc.owner !== bootId ? 'owner' : 'released' });
                fencedGames.add(game);
                forget(st);
                return 'fenced';
            }
            // Someone else holds it, or it is gone. In write mode nobody
            // can have adopted it: the end goes on as today (stats, pointer
            // clears, tournament scoring), never fenced
            logger.warn('Terminal claim matched no doc; ending as usual', { gameId: st.id, rev: st.rev, why: doc ? 'owner' : 'gone' });
            forget(st);
            return 'error';
        }
        // The caller's wait: CLAIM_MAX_MS at most, and over at once when the
        // store closes (SIGTERM: the stats it holds up start now, inside the
        // shutdown drain; the claim itself goes on in the queue, which
        // shutdown() waits for). Write mode: nothing adopts the tombstone,
        // so the order matters only once PR 5 can
        return new Promise((resolve) => {
            const done = (outcome) => {
                if (!claimWaits.delete(done)) return;
                resolve(outcome);
            };
            claimWaits.add(done);
            bounded(claim, CLAIM_MAX_MS, 'error').then(done, () => done('error'));
        });
    }

    /** profileHandlers' insertGameRecord was acknowledged for `gameId` (recordGameStats onRecorded). */
    function recordAcked(gameId) {
        if (!active) return;
        const tb = tombstones.get(gameId);
        if (!tb) {
            // Kept only while the game's claim is still pending (it registers
            // the tombstone later); otherwise there is nothing to delete
            const st = byId.get(`game:${gameId}`);
            if (st && !st.done) recordedEarly.set(gameId, 'acked');
            return;
        }
        tb.recordAcked = true;
        maybeDeleteTombstone(tb);
    }

    /**
     * recordGameStats for `gameId` settled (gameEnd). A tombstone whose
     * record insert was never acknowledged (it failed for good) is let go
     * here: its doc is left to the TTL (or this process's shutdown delete),
     * so nothing stays in memory for the rest of the process.
     */
    function recordSettled(gameId) {
        if (!active) return;
        const tb = tombstones.get(gameId);
        if (!tb) {
            // The claim is still pending: it lets the game go when it lands
            const st = byId.get(`game:${gameId}`);
            if (st && !st.done && recordedEarly.get(gameId) !== 'acked') recordedEarly.set(gameId, 'failed');
            return;
        }
        if (tb.recordAcked) return;
        tombstones.delete(gameId);
        giveUpTombstone(tb.st);
    }

    function giveUpTombstone(st) {
        forget(st);
        logger.warn('Game record not acknowledged; its tombstone is left to expire', { gameId: st.id, rev: st.rev });
    }

    // ---------- removal, chat ----------

    /** GameManager._retire / deleteTournament: the entity left this process's maps. */
    function remove(entity) {
        if (!active || !entity) return;
        const st = byEntity.get(entity);
        if (!st || st.done) return;
        st.retired = true;
        cancelImmediate(st);
        if (st.kind === 'game') {
            // The claim (gameEnd, abortGame) ends the doc; never written: nothing to end
            if (!st.inserted && !st.insertTried && st.ops === 0) forget(st);
            return;
        }
        if (!st.inserted && !st.insertTried && st.ops === 0) {
            forget(st);
            return;
        }
        enqueue(st, async () => {
            const coll = collectionFor(st);
            forget(st);
            if (!coll || closed) return;
            try {
                await coll.deleteOne({ _id: st.id, owner: bootId, released: false });
            } catch (err) {
                logFailure('tournament delete', st, err);
            }
        });
    }

    /** The whole log goes in the next write (a sender renamed or scrubbed in place). */
    function markFullLog(game) {
        if (!active) return;
        const st = byEntity.get(game);
        if (!st || st.done) return;
        st.fullLog = true;
        st.fullLogSeq++;
        markDirty(game);
    }

    /**
     * accountDelete.forgetAccount: drop `username`'s chat from every live
     * game (lines whose internal `from` is the name) and tournament
     * (messages by username, players' and spectators'), so the saved docs
     * lose it in their next (whole-log) write. System lines stay.
     * @returns {{games: number, tournaments: number}} lines removed
     */
    function scrubChat(username, { games = () => gameManagerOf().games?.values?.() || [], tournaments = () => gameManagerOf().tournaments?.values?.() || [] } = {}) {
        const out = { games: 0, tournaments: 0 };
        if (!active || typeof username !== 'string' || !username) return out;
        // Never throws: an account deletion must not fail on a live table
        try {
            for (const game of games()) {
                const n = game.scrubChatFrom?.(username) || 0;
                if (n > 0) {
                    out.games += n;
                    markFullLog(game);
                }
            }
            for (const t of tournaments()) out.tournaments += t.scrubChatFrom?.(username) || 0;
        } catch (err) {
            logFailure('chat scrub', null, err);
        }
        return out;
    }

    // ---------- instance doc, heartbeat ----------

    function addToInstance(kind, id) {
        if (!started || closed) return;
        const coll = collections().serverInstances;
        if (!coll) return;
        const field = kind === 'game' ? 'gameIds' : 'tournamentIds';
        loose(coll.updateOne({ _id: bootId }, { $addToSet: { [field]: id } })
            .catch((err) => logFailure('instance add', null, err)));
    }

    const idsOf = (fn) => {
        try {
            return [...fn()];
        } catch {
            return [];
        }
    };

    async function beat() {
        if (closed && !keepBeating) return;
        if (beating) {
            // 'on': a heartbeat that never answers (a stalled Mongo) must not
            // stop the next ones, or the self-fence could never lift
            if (!isOn() || beatStartedMono === null || monoNow() - beatStartedMono < BEAT_WAIT_MS) return;
        }
        beating = true;
        const startedBeat = monoNow();
        beatStartedMono = startedBeat;
        let ok = false;
        try {
            const coll = collections().serverInstances;
            if (!coll) return;
            beatSeq++;
            const seq = beatSeq;
            // 'on': a late beat never moves beatSeq back (observers judge
            // death by (beatAt, beatSeq) changing, on their own clock)
            const filter = isOn() ? { _id: bootId, beatSeq: { $lt: seq } } : { _id: bootId };
            try {
                await coll.updateOne(
                    filter,
                    {
                        $set: { beatAt: new Date(now()), beatSeq: seq, gameIds: idsOf(listGames), tournamentIds: idsOf(listTournaments) },
                        $setOnInsert: { deploymentId, mode: effective(), startedAt: startedAt || new Date(now()), shuttingDown: false }
                    },
                    { upsert: true }
                );
                ok = true;
            } catch (err) {
                // E11000 in 'on': a newer beat already landed (this one is stale)
                if (!(isOn() && err?.code === 11000)) throw err;
            }
        } catch (err) {
            logFailure('heartbeat', null, err);
        } finally {
            if (beatStartedMono === startedBeat) {
                beating = false;
                beatStartedMono = null;
            }
        }
        if (ok && isOn()) {
            lastBeatOkMono = Math.max(lastBeatOkMono ?? startedBeat, startedBeat);
            if (selfFenced) recoverFromSelfFence();
        }
        // Tombstone deletes that failed get another go on each beat
        for (const tb of tombstones.values()) if (tb.retry) maybeDeleteTombstone(tb);
    }

    // ---------- 'on': the holder self-fence ----------

    /** The tables a self-fence suspends: casual games with a doc this process wrote. */
    function fenceableStates() {
        const out = [];
        for (const st of byId.values()) {
            if (st.kind !== 'game' || st.done || st.retired || !st.entity) continue;
            if (!st.inserted && !st.insertTried) continue;
            if (safeCall(() => tournamentOfGame(st.id))) continue;
            if (st.entity.isTerminal?.() || st.entity.frozen) continue;
            out.push(st);
        }
        return out;
    }

    /**
     * SELF_FENCE_MS without an acknowledged heartbeat: another instance may
     * judge this one dead and adopt its tables, so they stop here (no
     * emit, no timer, no save) until ownership is read back.
     */
    function checkSelfFence() {
        if (!isOn() || closed || selfFenced || lastBeatOkMono === null) return;
        if (monoNow() - lastBeatOkMono < SELF_FENCE_MS) return;
        selfFenced = true;
        let n = 0;
        for (const st of fenceableStates()) {
            try {
                suspendGame(st.entity);
                st.suspended = true;
                cancelImmediate(st);
                n++;
            } catch (err) {
                logFailure('suspend', st, err);
            }
        }
        logger.warn('Live persist self-fence: no heartbeat acknowledged; tables suspended', { tables: n, ms: SELF_FENCE_MS });
    }

    /**
     * A heartbeat landed again: each suspended table's doc is read back.
     * Still ours and live: it plays on (unsuspend re-arms its timers).
     * Anything else (adopted, released, gone): fenced, with no emit. A
     * read that fails keeps it suspended until the next beat.
     */
    async function recoverFromSelfFence() {
        if (recovering) return;
        recovering = true;
        try {
            const coll = collections().liveGames;
            const states = [...byId.values()].filter((st) => st.kind === 'game' && st.suspended && !st.done);
            let pendingReads = 0;
            await Promise.all(states.map(async (st) => {
                let doc;
                try {
                    if (!coll) throw Object.assign(new Error('no collection'), { name: 'NoCollection' });
                    doc = await bounded(coll.findOne({ _id: st.id }, { projection: { owner: 1, released: 1, kind: 1 } }), BEAT_WAIT_MS, undefined);
                    if (doc === undefined) throw Object.assign(new Error('timed out'), { name: 'Timeout' });
                } catch (err) {
                    pendingReads++;
                    logFailure('self-fence read-back', st, err);
                    return;
                }
                if (doc && doc.owner === bootId && !doc.released && doc.kind === 'live') {
                    st.suspended = false;
                    try {
                        unsuspendGame(st.entity, ioRef || safeCall(getIo));
                    } catch (err) {
                        logFailure('unsuspend', st, err);
                    }
                    if (st.dirty) schedule(st);
                    return;
                }
                st.suspended = false;
                fence(st, !doc ? 'gone' : doc.owner !== bootId ? 'owner' : doc.released ? 'released' : 'ended');
            }));
            if (pendingReads === 0) {
                selfFenced = false;
                logger.info('Live persist self-fence lifted');
            }
        } finally {
            recovering = false;
        }
    }

    // ---------- start, close, shutdown ----------

    /**
     * After connectDB (server/index.js, in parallel with
     * resumePendingGameStats): the serverInstances doc, then a heartbeat
     * every HEARTBEAT_MS. Write mode runs no sweep. 'on' (with the unique
     * gameId index, read here once) also starts the self-fence check and
     * the sweep (adopt.js: once now, then every second for 3 minutes, then
     * every 15 s); whenBootSwept() resolves after the first pass.
     */
    async function start({ io = null } = {}) {
        if (io) ioRef = io;
        if (!active || started || closed) return;
        started = true;
        latchedMode = computeEffective();
        startedAt = new Date(now());
        startedMono = monoNow();
        const coll = collections().serverInstances;
        if (coll) {
            try {
                await coll.insertOne({
                    _id: bootId, deploymentId, mode: latchedMode, startedAt, beatAt: startedAt,
                    beatSeq: 0, shuttingDown: false, gameIds: idsOf(listGames), tournamentIds: idsOf(listTournaments)
                });
                if (latchedMode === 'on') lastBeatOkMono = monoNow();
            } catch (err) {
                // The heartbeat upserts it
                logFailure('instance insert', null, err);
            }
        }
        if (closed) return;
        if (mode === 'on' && latchedMode !== 'on') {
            // The precondition for 'on' (the plan's 2.1): one line, once
            logger.warn("LIVE_PERSIST=on runs as 'write': gameRecords has no unique gameId index (remove the duplicate game records)", { uniqueGameIdIndex: safeCall(gameIdIndexUnique) ?? null });
        }
        writesOpen = true;
        heartbeat = safeInterval(beat, HEARTBEAT_MS, 'liveStore:heartbeat');
        heartbeat.unref?.();
        if (mode === 'on') {
            // Writes held until now ('on' writes nothing before its instance doc)
            for (const st of byId.values()) if (st.dirty && !st.done && !st.retired) schedule(st);
        }
        if (latchedMode === 'on') {
            if (lastBeatOkMono === null) lastBeatOkMono = monoNow();
            fenceCheck = safeInterval(checkSelfFence, FENCE_CHECK_MS, 'liveStore:selfFence');
            fenceCheck.unref?.();
            getAdopter().start();
        }
        logger.info('Live persist started', { mode: latchedMode });
        markStarted(true);
    }

    function stopTimers({ beat: stopBeat = true } = {}) {
        if (stopBeat && heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
        }
        if (fenceCheck) clearInterval(fenceCheck);
        fenceCheck = null;
        adopter?.stop();
    }

    /**
     * No more writes of any kind: pending immediates cancelled, the hooks
     * off, the sweep and the self-fence check stopped, and (unless
     * `keepHeartbeat`: a handoff beats on until it ends, so no observer
     * takes this process for dead while it flushes) the heartbeat stopped.
     */
    function close({ keepHeartbeat = false } = {}) {
        closed = true;
        keepBeating = keepHeartbeat && !!heartbeat;
        stopTimers({ beat: !keepBeating });
        for (const st of byId.values()) cancelImmediate(st);
        for (const done of [...claimWaits]) done('error');
        uninstall();
    }

    /** The handoff is over (or never needed the beat): the heartbeat stops. */
    function stopHeartbeat() {
        keepBeating = false;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
    }

    /**
     * SIGTERM / crash in write mode (shutdown.js, after today's notice):
     * close, let the ops in flight settle, then delete every doc this
     * process owns from both collections and mark its instance doc
     * shutting down, all within `timeoutMs`. Docs it fails to delete are
     * never adopted (ownerMode 'write') and expire by TTL.
     * @returns {Promise<{games: (number|null), tournaments: (number|null), timedOut: boolean}>}
     */
    async function shutdown({ timeoutMs = SHUTDOWN_DELETE_MS } = {}) {
        const out = { games: null, tournaments: null, timedOut: false };
        if (!active) return out;
        close();
        const work = (async () => {
            await Promise.allSettled([...[...byId.values()].map((st) => st.tail), ...looseOps]);
            const { liveGames, liveTournaments, serverInstances } = collections();
            const [g, t] = await Promise.allSettled([
                liveGames ? liveGames.deleteMany({ owner: bootId }) : null,
                liveTournaments ? liveTournaments.deleteMany({ owner: bootId }) : null,
                serverInstances ? serverInstances.updateOne({ _id: bootId }, { $set: { shuttingDown: true } }) : null
            ]);
            if (g.status === 'fulfilled' && g.value) out.games = g.value.deletedCount ?? 0;
            if (t.status === 'fulfilled' && t.value) out.tournaments = t.value.deletedCount ?? 0;
            for (const r of [g, t]) if (r.status === 'rejected') logFailure('shutdown delete', null, r.reason);
            return 'done';
        })();
        const result = await bounded(work, timeoutMs, 'timeout');
        out.timedOut = result === 'timeout';
        if (out.timedOut) logger.warn('Live docs not all deleted at shutdown; they expire by TTL', { timeoutMs });
        else logger.info('Live docs deleted at shutdown', { games: out.games, tournaments: out.tournaments });
        return out;
    }

    // ---------- 'on': what the handoff (handoff.js) needs ----------

    /** Settle: the ops in flight of every entity (an insert at SIGTERM) and the adoptions, within `ms`. */
    function settle(ms) {
        const work = Promise.allSettled([
            ...[...byId.values()].map((st) => st.tail),
            ...looseOps,
            ...(adopter ? adopter.inFlight() : [])
        ]);
        return bounded(work.then(() => true), ms, false);
    }

    /**
     * What this process wrote for `entity`: null when never tracked.
     * inserted: a doc is acknowledged; insertPending: an insert was sent
     * and never acknowledged (it may land late); rev: the last rev sent.
     */
    function docInfo(entity) {
        const st = entity ? byEntity.get(entity) : null;
        if (!st) return null;
        return { inserted: st.inserted, insertPending: st.insertTried && !st.inserted, rev: st.rev, done: st.done, fenced: fencedGames.has(entity) };
    }

    /**
     * The handoff's final write of a game: the whole doc as this process
     * would insert it, at the next rev, still released: false (the release
     * is a separate, later update, so a late-applying final write can
     * never release anything). Null when it cannot be built.
     */
    function finalDoc(game, doc) {
        const st = byEntity.get(game);
        if (!st || !doc) return null;
        st.rev++;
        return envelope(st, doc, new Date(now()));
    }

    /** Mark this process's instance doc shutting down (fire-and-forget; resolves with the outcome). */
    function markShuttingDown() {
        const coll = collections().serverInstances;
        if (!coll) return Promise.resolve(false);
        return loose(coll.updateOne({ _id: bootId }, { $set: { shuttingDown: true } }).then(() => true, (err) => {
            logFailure('instance shutting down', null, err);
            return false;
        }));
    }

    /**
     * server/index.js at boot, LIVE_PERSIST=on: start() will run once
     * connectDB is done. Until then (a cold start, a crash restart with no
     * healthcheck gate) the pointer call sites already resolve through this
     * store (resolve() waits for start and never answers "gone" before it),
     * unless the gameRecords index is known not unique ('write').
     */
    function expectStart() {
        startExpected = true;
    }

    /**
     * Whether the pointer call sites (socket/pointerResolve) resolve
     * through this store: 'on' that runs as 'on' (latched at start()), or
     * that is about to start (expectStart) with the index not known to be
     * missing. A store nobody starts (most tests) never resolves.
     */
    function resolving() {
        if (mode !== 'on' || closed) return false;
        if (started) return latchedMode === 'on';
        return startExpected && safeCall(gameIdIndexUnique) !== false;
    }

    /** True while a shutdown in 'on' holds every pointer (the clear sites skip). */
    function holdsPointers() {
        return isOn() && safeCall(isShuttingDown) === true;
    }

    // ---------- 'on': adoption (adopt.js) ----------

    function getAdopter() {
        if (!adopter) {
            adopter = require('./adopt').createAdopter({
                bootId,
                deploymentId,
                startedAt: () => startedAt,
                now,
                monoNow,
                logger,
                logFailure,
                collections,
                isShuttingDown: () => safeCall(isShuttingDown) === true,
                getIo: () => ioRef || safeCall(getIo),
                trackAdopted,
                isOn,
                isClosed: () => closed,
                ...adoption
            });
        }
        return adopter;
    }

    /**
     * Where game `gameId` is, for the pointer call sites (PR 5 part 2;
     * the plan's 2.6). Never throws. Resolves to one of:
     *   {state: 'memory',  game}  live in this process (GameManager)
     *   {state: 'adopted', game}  adopted just now from another instance's
     *                             released or dead-owner doc
     *   {state: 'pending'}        another live instance holds it (or may:
     *                             an older 'on' instance is still alive, or
     *                             this process is shutting down). Never
     *                             clear the pointer or answer "gone": park
     *                             the socket (whenAdopted) and engine-close
     *                             it after the wait so the client retries
     *   {state: 'gone'}           no doc, no live instance lists it: the
     *                             game is over (clear the pointer, today's
     *                             failure answer)
     * Off / write: 'memory' or 'gone' (no doc is ever adopted). Before
     * answering 'gone' it waits (at most `waitMs`, default 3 s) for
     * connectDB and the boot sweep.
     * @param {string} gameId
     * @param {{waitMs?: number}} [opts]
     * @returns {Promise<{state: 'memory'|'adopted'|'pending'|'gone', game?: GameState}>}
     */
    async function resolve(gameId, { waitMs = RESOLVE_WAIT_MS } = {}) {
        const inMemory = () => {
            const g = safeCall(() => gameManagerOf().games.get(gameId));
            return g && !g.isTerminal?.() && !g.frozen ? g : null;
        };
        const live = inMemory();
        if (live) return { state: 'memory', game: live };
        if (typeof gameId !== 'string' || !gameId) return { state: 'gone' };
        if (mode === 'on' && !started) {
            // A cold start (a crash restart has no healthcheck gate): wait
            // for start() before saying anything; never "gone" before it
            const ok = await bounded(startedPromise, waitMs, false);
            if (!ok) return { state: 'pending' };
            const now2 = inMemory();
            if (now2) return { state: 'memory', game: now2 };
        }
        if (!isOn() || !started) return { state: 'gone' };
        if (safeCall(isShuttingDown) === true) return { state: 'pending' };
        try {
            return await getAdopter().resolve(gameId, { waitMs, inMemory, whenDbReady });
        } catch (err) {
            logFailure('resolve', null, err, { gameId });
            return { state: 'pending' };
        }
    }

    /**
     * Wait (at most `ms`) for `gameId` to be live here: resolves with the
     * game once adopted or in memory, null at the timeout or if the doc
     * turned out not adoptable. For a call site parking a socket after
     * resolve() answered 'pending'.
     */
    function whenAdopted(gameId, ms) {
        const g = safeCall(() => gameManagerOf().games.get(gameId));
        if (g && !g.isTerminal?.() && !g.frozen) return Promise.resolve(g);
        if (!isOn() || !adopter) return Promise.resolve(null);
        return adopter.whenAdopted(gameId, ms);
    }

    /** /ready: true unless 'on' is still in its boot sweep (capped at BOOT_SWEEP_CAP_MS after start). */
    function ready() {
        if (mode !== 'on') return true;
        if (!started) return false;
        if (latchedMode !== 'on') return true;
        if (adopter?.bootSwept) return true;
        if (monoNow() - startedMono < BOOT_SWEEP_CAP_MS) return false;
        if (!readyCapLogged) {
            readyCapLogged = true;
            logger.warn('Ready without the boot sweep: it has not finished within the cap', { capMs: BOOT_SWEEP_CAP_MS });
        }
        return true;
    }

    function whenBootSwept() {
        if (!isOn() || !started) return Promise.resolve(false);
        return getAdopter().whenBootSwept();
    }

    // ---------- hooks, introspection ----------

    function install() {
        if (!active || closed) return;
        persistHooks.setListeners(listener);
        installed = true;
    }

    function uninstall() {
        if (!installed) return;
        installed = false;
        // Only if still ours (a test may have installed another store since)
        persistHooks.clearListeners(listener);
    }

    /** Coalesced writes waiting for their setImmediate (persistHarness.flushStore). */
    function pendingImmediates() {
        let n = 0;
        for (const st of byId.values()) if (st.immediate) n++;
        return n;
    }

    /** Immediates and ops not settled yet (persistHarness.flushStore). */
    function pending() {
        let n = looseOps.size;
        for (const st of byId.values()) n += (st.immediate ? 1 : 0) + st.ops;
        for (const tb of tombstones.values()) n += tb.st.ops;
        return n;
    }

    /** GET /health's persist block (counts and flags only: no id, no time beyond these). */
    function health() {
        let docsOwned = 0;
        for (const st of byId.values()) if (!st.done && (st.inserted || tombstones.has(st.id))) docsOwned++;
        let unique = null;
        try {
            unique = gameIdIndexUnique();
        } catch {
            unique = null;
        }
        return {
            mode,
            effectiveMode: effective(),
            uniqueGameIdIndex: unique === undefined ? null : unique,
            docsOwned,
            adopted: adopter ? adopter.adoptedCount : 0,
            lastSweepAt: adopter && adopter.lastSweepAt ? new Date(adopter.lastSweepAt).toISOString() : null,
            bootSwept: adopter ? adopter.bootSwept : false
        };
    }

    return {
        mode,
        get effectiveMode() { return effective(); },
        active,
        bootId,
        trackGame: (game) => track(game, 'game'),
        track: (game) => track(game, 'game'),
        trackTournament: (t) => track(t, 'tournament'),
        markDirty,
        markFullLog,
        remove,
        claimable,
        claimEnded,
        recordAcked,
        recordSettled,
        scrubChat,
        start,
        close,
        shutdown,
        // 'on'
        resolve,
        expectStart,
        get resolving() { return resolving(); },
        whenAdopted,
        whenBootSwept,
        ready,
        holdsPointers,
        sweep: () => (isOn() && started ? getAdopter().sweep() : Promise.resolve(null)),
        // handoff.js only
        settle,
        docInfo,
        finalDoc,
        markShuttingDown,
        stopHeartbeat,
        collections,
        get startedAt() { return startedAt; },
        get selfFenced() { return selfFenced; },
        get adopter() { return adopter; },
        install,
        uninstall,
        pending,
        pendingImmediates,
        health,
        // Tests
        _state: (entity) => byEntity.get(entity) || null,
        _tombstone: (gameId) => tombstones.get(gameId) || null,
        _recordedEarly: (gameId) => recordedEarly.get(gameId) || null,
        get closed() { return closed; },
        get started() { return started; }
    };
}

// ---------- the process's store ----------

let singleton = null;
let nextBootId = null;

/**
 * This process's store, made on first use from the boot LIVE_PERSIST
 * reading and the process bootId (utils/instanceId.js). In write mode it
 * listens to the hooks from then on.
 */
function getLiveStore() {
    if (!singleton) {
        const { bootLivePersistMode } = require('../../utils/livePersistSwitch');
        const instance = require('../../utils/instanceId');
        singleton = createLiveStore({
            mode: bootLivePersistMode(),
            bootId: nextBootId || instance.bootId,
            deploymentId: instance.deploymentId()
        });
        nextBootId = null;
        singleton.install();
    }
    return singleton;
}

/**
 * Tests only: forget the process's store (closed first). The next
 * getLiveStore() makes a new one from the LIVE_PERSIST reading then, with
 * `bootId` or a fresh uuid (a restarted "process" in persistHarness is
 * another instance).
 */
function _resetForTests({ bootId = randomUUID() } = {}) {
    if (singleton) singleton.close();
    singleton = null;
    nextBootId = bootId;
}

/** Tests only: make `store` the process's store (installed if active). */
function _setForTests(store) {
    if (singleton && singleton !== store) singleton.close();
    singleton = store;
    if (store) store.install();
}

module.exports = {
    createLiveStore,
    defaultCollections,
    LIVE_GETTERS,
    getLiveStore,
    _setTestFallbackCollections,
    _resetForTests,
    _setForTests,
    TTL_MS,
    STOP_BEFORE_EXPIRE_MS,
    HEARTBEAT_MS,
    LOG_CAP,
    SHUTDOWN_DELETE_MS,
    CLAIM_MAX_MS,
    SELF_FENCE_MS,
    BOOT_SWEEP_CAP_MS,
    RESOLVE_WAIT_MS
};
