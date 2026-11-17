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
 *   on     handoff and adoption are not built yet (PR 5): 'on' runs
 *          exactly as 'write' (effectiveMode 'write', one log line), and
 *          every doc says ownerMode 'write', so nothing ever adopts one
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
 *     insert that did land) is read back: ours, then updates; else a fence
 *   - matchedCount 0 -> findOne: gone at or after expireAt - 10 min ->
 *     stop persisting and play on; ANYTHING else (gone early, another
 *     owner, mine but released) is a fence: the local copy is retired
 *     (game.freeze: nothing more is emitted or timed; GameManager._retire
 *     with no io; a tournament is deleted from GameManager), no side
 *     effect runs, and the sockets at it are engine-closed
 *     (socket.conn.close(), what io.close does per client: the clients
 *     reconnect as after a transport close; never socket.disconnect(),
 *     which web reads as terminal)
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
 * adopter exists): its outcome never skips stats.
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

const COLLECTION = { game: 'liveGames', tournament: 'liveTournaments' };

/** The live collections from a database module; a missing getter (a partial jest.mock) is null. */
function defaultCollections(database = require('../../database')) {
    const get = (name) => {
        const fn = database[name];
        if (typeof fn !== 'function') return null;
        try {
            return fn() || null;
        } catch {
            return null;
        }
    };
    return {
        liveGames: get('getLiveGamesCollection'),
        liveTournaments: get('getLiveTournamentsCollection'),
        serverInstances: get('getServerInstancesCollection')
    };
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
    gameIdIndexUnique = defaultGameIdIndexUnique
} = {}) {
    const effectiveMode = mode === 'on' ? 'write' : mode;
    const active = effectiveMode === 'write';
    if (mode === 'on') {
        logger.info("LIVE_PERSIST=on runs as 'write' (handoff and adoption are not built yet: deploy survival PR 5)");
    }

    // entity -> state, and id -> state (tombstones, tournaments by id)
    const byEntity = new WeakMap();
    const byId = new Map();
    // gameId -> {st, tournamentId, recordAcked, tournamentAcked, deleting, retry}
    const tombstones = new Map();
    // Record acks that came in before their tombstone was registered
    const recordedEarly = new Set();
    // Fire-and-forget ops outside an entity's queue (instance doc, deletes)
    const looseOps = new Set();
    const logState = new Map();
    let closed = false;
    let ioRef = null;
    let started = false;
    let heartbeat = null;
    let beating = false;
    let beatSeq = 0;
    let installed = false;

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
            done: false            // stopped, fenced, removed: no more writes at all
        };
        byEntity.set(entity, st);
        byId.set(`${kind}:${id}`, st);
        addToInstance(kind, id);
        markDirty(entity);
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
        st.immediate = safeImmediate(() => {
            st.immediate = null;
            if (st.dirty && !st.done && !st.retired && !closed) enqueue(st, () => writeOnce(st));
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

    function envelope(st, doc, at) {
        const base = {
            _id: st.id,
            v: doc.v,
            kind: 'live',
            owner: bootId,
            ownerMode: effectiveMode,
            released: false,
            releasedAt: null,
            rev: st.rev,
            createdAt: new Date(st.createdAt),
            updatedAt: at,
            expireAt: new Date(st.createdAt + TTL_MS),
            adoptAttempts: 0,
            adoptedBy: null,
            adoptedAt: null
        };
        if (st.kind === 'game') {
            return { ...base, stage: doc.stage, tournamentId: doc.tournamentId ?? null, state: doc.state, log: doc.log, logTotal: doc.logTotal, bots: doc.bots };
        }
        return { ...base, phase: doc.phase, state: doc.state, completedAt: doc.state?.completedAt ?? null };
    }

    function updateFor(st, doc, at, fullLog) {
        const set = { v: doc.v, rev: st.rev, updatedAt: at, state: doc.state };
        const update = { $set: set };
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

    function acked(st, doc, json, fullLogSeq) {
        st.inserted = true;
        st.rereads = 0;
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
        if (!st.dirty || st.done || st.retired || closed) return;
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
        try {
            res = await coll.updateOne({ _id: st.id, owner: bootId, released: false }, updateFor(st, doc, at, fullLog));
        } catch (err) {
            failed(st, 'update', err);
            return;
        }
        if (res && res.matchedCount === 0) {
            await readBack(st, coll, 'update');
            return;
        }
        acked(st, doc, json, fullLogSeq);
    }

    /**
     * An insert hit E11000 or an update matched nothing: what is there?
     * Ours (an ambiguous insert that landed): write it again as an update.
     * Gone near expireAt: stop. Anything else: fenced.
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
            fence(st, 'gone');
            return;
        }
        if (doc.owner !== bootId) {
            fence(st, 'owner');
            return;
        }
        if (doc.released) {
            fence(st, 'released');
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

    function fence(st, why) {
        if (st.done) return;
        forget(st);
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
        const tb = {
            gameId: st.id,
            st,
            tournamentId: tournamentId || null,
            recordAcked: recordAcked || recordedEarly.delete(st.id),
            tournamentAcked: !tournamentId || tournamentLists(tournamentId, st.id),
            deleting: false,
            retry: false
        };
        tombstones.set(st.id, tb);
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
        if (!active || closed || !game) return false;
        const st = byEntity.get(game);
        return !!st && !st.done && (st.inserted || st.insertTried) && !!collectionFor(st);
    }

    function claimEnded(game, { record = null, tournamentId = null } = {}) {
        if (!active || closed || !game) return null;
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
            // Someone else holds it, or it is gone. In write mode nobody
            // can have adopted it: the end goes on as today (stats, pointer
            // clears, tournament scoring), never fenced
            logger.warn('Terminal claim matched no doc; ending as usual', { gameId: st.id, rev: st.rev, why: doc ? 'owner' : 'gone' });
            forget(st);
            return 'error';
        });
        return bounded(claim, CLAIM_MAX_MS, 'error');
    }

    /** profileHandlers' insertGameRecord was acknowledged for `gameId` (recordGameStats onRecorded). */
    function recordAcked(gameId) {
        if (!active) return;
        const tb = tombstones.get(gameId);
        if (!tb) {
            recordedEarly.add(gameId);
            return;
        }
        tb.recordAcked = true;
        maybeDeleteTombstone(tb);
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
        if (beating || closed) return;
        beating = true;
        try {
            const coll = collections().serverInstances;
            if (!coll) return;
            beatSeq++;
            await coll.updateOne(
                { _id: bootId },
                {
                    $set: { beatAt: new Date(now()), beatSeq, gameIds: idsOf(listGames), tournamentIds: idsOf(listTournaments) },
                    $setOnInsert: { deploymentId, mode: effectiveMode, startedAt: new Date(now()), shuttingDown: false }
                },
                { upsert: true }
            );
        } catch (err) {
            logFailure('heartbeat', null, err);
        } finally {
            beating = false;
        }
        // Tombstone deletes that failed get another go on each beat
        for (const tb of tombstones.values()) if (tb.retry) maybeDeleteTombstone(tb);
    }

    /**
     * After connectDB (server/index.js, in parallel with
     * resumePendingGameStats): the serverInstances doc, then a heartbeat
     * every HEARTBEAT_MS. Write mode runs no sweep.
     */
    async function start({ io = null } = {}) {
        if (io) ioRef = io;
        if (!active || started || closed) return;
        started = true;
        const coll = collections().serverInstances;
        if (coll) {
            const at = new Date(now());
            try {
                await coll.insertOne({
                    _id: bootId, deploymentId, mode: effectiveMode, startedAt: at, beatAt: at,
                    beatSeq: 0, shuttingDown: false, gameIds: idsOf(listGames), tournamentIds: idsOf(listTournaments)
                });
            } catch (err) {
                // The heartbeat upserts it
                logFailure('instance insert', null, err);
            }
        }
        if (closed) return;
        if (mode === 'on' && safeCall(gameIdIndexUnique) === false) {
            // The precondition for 'on' (the plan's 2.1): one line, once
            logger.warn('gameRecords has no unique gameId index: LIVE_PERSIST=on would run as write even once handoff exists (remove the duplicate game records)');
        }
        heartbeat = safeInterval(beat, HEARTBEAT_MS, 'liveStore:heartbeat');
        heartbeat.unref?.();
        logger.info('Live persist started', { mode: effectiveMode });
    }

    /** No more writes of any kind: pending immediates cancelled, the heartbeat stopped, the hooks off. */
    function close() {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        for (const st of byId.values()) cancelImmediate(st);
        uninstall();
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
            effectiveMode,
            uniqueGameIdIndex: unique === undefined ? null : unique,
            docsOwned,
            adopted: 0,
            lastSweepAt: null,
            bootSwept: false
        };
    }

    return {
        mode,
        effectiveMode,
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
        scrubChat,
        start,
        close,
        shutdown,
        install,
        uninstall,
        pending,
        pendingImmediates,
        health,
        // Tests
        _state: (entity) => byEntity.get(entity) || null,
        _tombstone: (gameId) => tombstones.get(gameId) || null,
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
    getLiveStore,
    _resetForTests,
    _setForTests,
    TTL_MS,
    STOP_BEFORE_EXPIRE_MS,
    HEARTBEAT_MS,
    LOG_CAP,
    SHUTDOWN_DELETE_MS,
    CLAIM_MAX_MS
};
