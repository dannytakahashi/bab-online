/**
 * The SIGTERM handoff and the crash release (deploy survival PR 5, the
 * plan's 2.4; LIVE_PERSIST=on with the unique gameId index, casual games
 * only). server/index.js passes it to setupGracefulShutdown as
 * opts.handoff; utils/shutdown.js sends serverShutdown at t=0 (as today),
 * runs run() (SIGTERM / SIGINT) or crash() (uncaughtException), then tells
 * every table what really happened (shutdown.js noticeGames, one line per
 * table matching the acknowledged outcome) and closes the sockets.
 *
 * run(io), in this order (budgets: settle 500 + successor 1000 + flush
 * 4000, then shutdown.js's 1000 notice wait: the sockets close by 6.5 s,
 * under iOS's 8 s disconnect wait):
 *   1. settle (<= 500 ms): the sweep stops (resolve() answers 'pending'
 *      from now on), the instance doc says shuttingDown, and every
 *      writer's op in flight (an insert at SIGTERM) and every adoption in
 *      flight are awaited, so an adopted table is handed off too
 *   2. freeze, synchronously: each casual table is serialized (null:
 *      pre-deal, tainted, invalid), the store's writers are closed (no
 *      write but the handoff's own after this; the heartbeat beats on
 *      until the end), the table is frozen (game.freeze: epoch++, every
 *      timer cancelled, nothing emitted) and detached (bots, GameManager
 *      maps: io.close's disconnects then find no seat, so no
 *      seatDisconnect). Tournament tables and the ambient demo game are
 *      not handed off in PR 5: they play on as today and get today's line
 *   3. successor check (<= 1 s), BEFORE anything is released: a fresh
 *      serverInstances doc with mode 'on' (an 'on' successor has the
 *      unique index too: same database), a later startedAt, another
 *      bootId, not shutting down. Fresh: its beatAt within
 *      SUCCESSOR_FRESH_MS of this process's clock (coarse, the one
 *      wall-clock comparison here). A failed read is no successor
 *   4a. no successor (or an 'off' / 'write' one): deleteMany {owner: me}
 *      on both collections (<= 2 s), never a release. ENDED for every
 *      table once acknowledged; a table whose doc may still be there
 *      (delete not acknowledged, or an insert still unanswered) is
 *      UNKNOWN
 *   4b. successor (<= 4 s in all): each table with a doc gets its final
 *      write, the whole doc at the next rev, still released: false
 *      (replaceOne {_id, owner: me, released: false}; insertOne for a
 *      table never written yet), all in parallel, cut at FLUSH_WRITE_MS;
 *      then, in parallel, ONE release updateMany for exactly the ids whose
 *      final write was acknowledged plus this process's ENDED tombstones
 *      (released: true, releasedAt, releaseKind 'handoff'), and the
 *      delete of every other live doc this process owns (and its
 *      tournaments' docs), cut at FLUSH_MS. A tainted or serialize-null
 *      table is deleted, never released
 *   outcomes: 'continue' (its release acknowledged), 'ended' (its doc is
 *   gone, or it never had one), 'unknown' (anything else: a release or a
 *   delete not acknowledged, an insert that may still land; the doc may
 *   be adopted once this process is seen dead)
 *
 * crash(io): never serializes (the state may be half-written). The
 * writers close first (so no notice is ever saved), each casual table is
 * frozen and detached (each in try/catch: a table whose freeze throws
 * plays on locally, and its next write would find its doc released and
 * fence), then ONE updateMany {owner: me} releases every live game doc
 * (releaseKind 'crash'; <= 2 s). Outcomes: 'crashContinue' (released),
 * 'crashUnknown' (a doc that may be adopted after the stale-owner wait),
 * 'crashEnded' (no doc: pre-deal tables, tournament tables, the demo).
 *
 * Never logs a doc, a hand or chat.
 */

'use strict';

const { safeTimeout } = require('../../utils/safeTimer');

/** Step 1: in-flight writes and adoptions. */
const HANDOFF_SETTLE_MS = 500;
/** Step 3: the successor read. */
const SUCCESSOR_MS = 1000;
/** Step 4b in all (final writes, then release and delete). */
const FLUSH_MS = 4000;
/** Step 4b: the final writes are cut here, leaving the release and the delete the rest of FLUSH_MS. */
const FLUSH_WRITE_MS = 3000;
/** Step 4a: the self-delete without a successor. */
const NO_SUCCESSOR_DELETE_MS = 2000;
/** The crash release. */
const CRASH_RELEASE_MS = 2000;
/** A successor's beatAt at most this old (this process's clock) counts as fresh. */
const SUCCESSOR_FRESH_MS = 15000;

const TIMEOUT = Symbol('timeout');

/** `p` (never rejects: a rejection is {error}) or TIMEOUT after `ms`. */
function bounded(p, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = safeTimeout(() => resolve(TIMEOUT), Math.max(0, ms), 'handoff:bound');
        timer.unref?.();
    });
    return Promise.race([Promise.resolve(p).then((v) => v, (error) => ({ error })), timeout]).finally(() => clearTimeout(timer));
}

const failedOrTimedOut = (r) => r === TIMEOUT || (r && typeof r === 'object' && 'error' in r && r.error);

const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : (typeof v === 'string' ? Date.parse(v) : NaN));

/**
 * @param {Object} [deps]
 * @param {Object} [deps.store] - the live store (liveStore.getLiveStore())
 * @param {Object} [deps.gameManager]
 * @param {Object} [deps.botController]
 * @param {Function} [deps.serialize] - gameCodec.serialize
 * @param {Function} [deps.now] - wall clock
 * @param {Function} [deps.monoNow]
 * @param {Object} [deps.logger]
 */
function createHandoff({
    store = null,
    gameManager = null,
    botController = null,
    serialize = (game) => require('./gameCodec').serialize(game),
    now = () => Date.now(),
    monoNow = () => performance.now(),
    logger = require('../../utils/logger').createModuleLogger('persist')
} = {}) {
    const getStore = () => store || require('./liveStore').getLiveStore();
    const gm = () => gameManager || require('../GameManager');
    const bots = () => botController || require('../bot').botController;

    /** The handoff runs only in effective 'on' once the store has started. */
    function enabled() {
        try {
            const s = getStore();
            return s.effectiveMode === 'on' && s.started === true;
        } catch {
            return false;
        }
    }

    /** Live tables: [casual (handed off), others (tournament tables, the demo: today's path)]. */
    function tables() {
        const casual = [];
        const others = [];
        for (const game of gm().games.values()) {
            if (!game || game.isTerminal?.() || game.frozen) continue;
            if (game.isDemo || gm().tournamentGames.has(game.gameId)) others.push(game);
            else casual.push(game);
        }
        return { casual, others };
    }

    function detach(game) {
        try {
            bots().cleanupGame(game.gameId);
        } catch (err) {
            logger.warn('Handoff detach (bots) failed', { gameId: game.gameId, error: err?.name });
        }
        try {
            if (gm().games.get(game.gameId) === game) gm()._retire(game, null);
        } catch (err) {
            logger.warn('Handoff detach failed', { gameId: game.gameId, error: err?.name });
        }
    }

    async function findSuccessor(s) {
        const coll = s.collections().serverInstances;
        if (!coll) return null;
        const myStart = ms(s.startedAt);
        const list = await coll.find(
            { _id: { $ne: s.bootId }, mode: 'on', shuttingDown: { $ne: true } },
            { projection: { _id: 1, mode: 1, startedAt: 1, beatAt: 1, shuttingDown: 1 } }
        ).toArray();
        const t = now();
        return list.find((inst) => Number.isFinite(ms(inst.startedAt)) && Number.isFinite(myStart)
            && ms(inst.startedAt) > myStart
            && Number.isFinite(ms(inst.beatAt)) && t - ms(inst.beatAt) <= SUCCESSOR_FRESH_MS) || null;
    }

    /**
     * SIGTERM / SIGINT in 'on'. Never rejects.
     * @returns {Promise<{tables: Array<{game, outcome: 'continue'|'ended'|'unknown'}>, successor: boolean}>}
     */
    async function run() {
        const s = getStore();
        const out = { tables: [], successor: false };
        s.adopter?.stop();
        const first = tables();
        // Nothing to hand off: no timer, no I/O wait (the no-games shutdown
        // stays microtask-only)
        if (first.casual.length === 0 && first.others.length === 0 && s.pending() === 0 && (s.adopter?.inFlight().length || 0) === 0) {
            s.markShuttingDown();
            s.close();
            return out;
        }
        s.markShuttingDown();

        // 1. settle
        await s.settle(HANDOFF_SETTLE_MS);

        // 2. freeze, synchronously
        const { casual, others } = tables();
        const entries = casual.map((game) => {
            let doc = null;
            try {
                doc = serialize(game);
            } catch (err) {
                logger.warn('Handoff serialize failed', { gameId: game.gameId, error: err?.name });
            }
            return { game, doc, info: s.docInfo(game) || { inserted: false, insertPending: false } };
        });
        s.close({ keepHeartbeat: true });
        for (const e of entries) {
            try {
                e.game.freeze();
            } catch (err) {
                logger.warn('Handoff freeze failed', { gameId: e.game.gameId, error: err?.name });
            }
            detach(e.game);
        }
        const coll = s.collections();
        const liveGames = coll.liveGames;
        const liveTournaments = coll.liveTournaments;
        const me = s.bootId;
        const mayHaveDoc = (e) => e.info.inserted || e.info.insertPending;

        // 3. successor, before anything is released
        let successor = null;
        const found = await bounded(findSuccessor(s), SUCCESSOR_MS);
        if (!failedOrTimedOut(found)) successor = found;
        out.successor = !!successor;

        if (!successor) {
            // 4a. delete, never release
            const del = await bounded(Promise.all([
                liveGames ? liveGames.deleteMany({ owner: me }) : null,
                liveTournaments ? liveTournaments.deleteMany({ owner: me }) : null
            ]), NO_SUCCESSOR_DELETE_MS);
            const deleted = !failedOrTimedOut(del);
            for (const e of entries) {
                out.tables.push({ game: e.game, outcome: !mayHaveDoc(e) ? 'ended' : (deleted && !e.info.insertPending ? 'ended' : 'unknown') });
            }
            for (const game of others) out.tables.push({ game, outcome: 'ended' });
            s.stopHeartbeat();
            logger.info('Handoff: no successor; live docs deleted', { tables: entries.length, deleted });
            return out;
        }

        // 4b. final writes, then release + delete
        const flushStart = monoNow();
        const writes = entries.map((e) => {
            if (!e.doc || e.info.insertPending || !liveGames) return Promise.resolve(false);
            const replacement = s.finalDoc(e.game, e.doc);
            if (!replacement) return Promise.resolve(false);
            const op = e.info.inserted
                ? liveGames.replaceOne({ _id: e.game.gameId, owner: me, released: false }, replacement).then((r) => !!r && r.matchedCount === 1)
                : liveGames.insertOne(replacement).then(() => true);
            e.writeSent = true;
            e.insertSent = !e.info.inserted;
            return bounded(op, FLUSH_WRITE_MS).then((r) => {
                if (r === TIMEOUT) e.writeTimedOut = true;
                return r === true;
            });
        });
        const acks = await Promise.all(writes);
        const acked = entries.filter((e, i) => acks[i]);
        const ackedIds = acked.map((e) => e.game.gameId);
        const releasedAt = new Date(now());
        const left = Math.max(0, FLUSH_MS - (monoNow() - flushStart));
        const [rel, del] = await Promise.all([
            bounded(liveGames
                ? liveGames.updateMany(
                    { owner: me, $or: [{ _id: { $in: ackedIds } }, { kind: 'ended' }] },
                    { $set: { released: true, releasedAt, releaseKind: 'handoff' } })
                : null, left),
            bounded(Promise.all([
                liveGames ? liveGames.deleteMany({ owner: me, kind: 'live', released: false, _id: { $nin: ackedIds } }) : null,
                liveTournaments ? liveTournaments.deleteMany({ owner: me }) : null
            ]), left)
        ]);
        const releasedOk = !failedOrTimedOut(rel) && !!liveGames;
        const deletedOk = !failedOrTimedOut(del);
        for (const e of entries) {
            let outcome;
            if (acked.includes(e)) outcome = releasedOk ? 'continue' : 'unknown';
            else if (!mayHaveDoc(e) && !e.insertSent) outcome = 'ended';
            // An insert that may still land after the delete, or a delete not acknowledged
            else if (e.info.insertPending || (e.insertSent && e.writeTimedOut) || !deletedOk) outcome = 'unknown';
            else outcome = 'ended';
            out.tables.push({ game: e.game, outcome });
        }
        for (const game of others) out.tables.push({ game, outcome: 'ended' });
        s.stopHeartbeat();
        logger.info('Handoff: live docs released', {
            tables: entries.length,
            released: releasedOk ? acked.length : 0,
            continued: out.tables.filter((t) => t.outcome === 'continue').length,
            unknown: out.tables.filter((t) => t.outcome === 'unknown').length
        });
        return out;
    }

    /**
     * uncaughtException in 'on'. Never serializes. Never rejects.
     * @returns {Promise<{tables: Array<{game, outcome: 'crashContinue'|'crashUnknown'|'crashEnded'}>}>}
     */
    async function crash() {
        const out = { tables: [] };
        let s;
        try {
            s = getStore();
            s.adopter?.stop();
            s.close();
        } catch (err) {
            logger.warn('Crash release: store close failed', { error: err?.name });
        }
        let list = { casual: [], others: [] };
        try {
            list = tables();
        } catch {
            // A half-broken GameManager: nothing to tell
        }
        const entries = list.casual.map((game) => {
            let info = null;
            try {
                info = s?.docInfo(game) || null;
            } catch {
                info = null;
            }
            try {
                game.freeze();
            } catch (err) {
                logger.warn('Crash release: freeze failed', { gameId: game?.gameId, error: err?.name });
            }
            detach(game);
            return { game, mayHaveDoc: !!info && (info.inserted || info.insertPending) };
        });
        let released = false;
        if (s && entries.some((e) => e.mayHaveDoc)) {
            try {
                const liveGames = s.collections().liveGames;
                if (liveGames) {
                    const r = await bounded(liveGames.updateMany({ owner: s.bootId }, { $set: { released: true, releasedAt: new Date(now()), releaseKind: 'crash' } }), CRASH_RELEASE_MS);
                    released = !failedOrTimedOut(r);
                }
            } catch {
                released = false;
            }
        }
        for (const e of entries) {
            out.tables.push({ game: e.game, outcome: !e.mayHaveDoc ? 'crashEnded' : (released ? 'crashContinue' : 'crashUnknown') });
        }
        for (const game of list.others) out.tables.push({ game, outcome: 'crashEnded' });
        try {
            s?.stopHeartbeat();
        } catch {
            // closed already
        }
        logger.info('Crash release', { tables: entries.length, released });
        return out;
    }

    return { enabled, run, crash };
}

module.exports = {
    createHandoff,
    HANDOFF_SETTLE_MS,
    SUCCESSOR_MS,
    FLUSH_MS,
    FLUSH_WRITE_MS,
    NO_SUCCESSOR_DELETE_MS,
    CRASH_RELEASE_MS,
    SUCCESSOR_FRESH_MS
};
