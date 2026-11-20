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
 *      wall-clock comparison here). A read that fails or times out (a
 *      Mongo blip at SIGTERM) is NOT "no successor": an 'on' successor may
 *      well be up, so it goes to 4b with nothing restorable deleted
 *   4a. a read that finds no successor (or an 'off' / 'write' one):
 *      deleteMany {owner: me}
 *      on both collections (<= 2 s), never a release. ENDED for every
 *      table once acknowledged; a table whose doc may still be there
 *      (delete not acknowledged, or an insert still unanswered) is
 *      UNKNOWN
 *   4b. successor (<= 4 s in all): each table with a doc gets its final
 *      write, the whole doc at the next rev, still released: false
 *      (replaceOne {_id, owner: me, released: false, rev: {$lt: its rev}}:
 *      a routine update still in flight after the settle bound, rev-
 *      monotonic too, can then never land over it; insertOne for a
 *      table never written yet), all in parallel, cut at FLUSH_WRITE_MS;
 *      then, in parallel, ONE release updateMany for exactly the ids whose
 *      final write was acknowledged plus this process's ENDED tombstones
 *      (released: true, releasedAt, releaseKind 'handoff'), and the
 *      delete of every other live doc this process owns (and its
 *      tournaments' docs), cut at FLUSH_MS. A tainted or serialize-null
 *      table is deleted, never released, except one the holder self-fence
 *      suspended (game.isSuspended: it took no input or timer since, so its
 *      saved doc is a restore point): that doc is released as it is, with
 *      outcome 'unknown' (it may be a move behind, or another instance's).
 *      After a failed successor read every table with a saved doc is
 *      released the same way (its final state where that write lands,
 *      else as saved; only a table serialize refuses, tainted or
 *      invalid, is deleted), and every one is
 *      'unknown' whatever was acknowledged: an 'on' successor may adopt
 *      it, or nobody until a later boot (a release that never lands leaves
 *      it to the stale-owner wait). releaseKind stays 'handoff' (a SIGTERM, not a crash: it
 *      must not count toward the adopter's crash-loop discard)
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
 * Tournaments (PR 6): tables of a tournament are handed off like casual
 * ones (2.-5. above); each live tournament is serialized in step 2 BEFORE
 * its tables are detached (its doc carries their running scores), then
 * frozen (t.frozen = t.handedOff: an in-flight round start stops without
 * aborting its tables), its results-window cleanup cancelled and deleted
 * from GameManager (so io.close's disconnects find no member: no
 * tournamentPlayerLeft, no delete of its doc: the store is closed). In 4b
 * its final write and release go to liveTournaments like a table's
 * (acknowledged ids released; a saved doc whose final write did not land
 * is released as it is, successor seen or not, since its tables' docs need
 * it; one with no saved doc, or whose serialize refused, is deleted). A
 * tournament's table goes with its tournament: when the tournament is not
 * released its tables are deleted too (never released, never 'continue':
 * 'ended', or 'unknown' while a delete or an insert is unsettled), and a
 * table is 'continue' only when its tournament's final write and release
 * were acknowledged (else 'unknown'); then, for each
 * released lobby-phase tournament, its members' activeTournamentId is
 * written where it is unset or already this tournament (never over a
 * pointer a user set on the successor meanwhile), so shipped clients route
 * lobby members back. out.tournaments lists [{tournament, outcome}]
 * ('continue' only when its release was acknowledged and a successor was
 * seen): shutdown.js sends the tournament room TOURNAMENT_CONTINUE_LINE then.
 * The crash release releases liveTournaments too.
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
    serializeTournament = (t) => require('./tournamentCodec').serialize(t),
    users = () => {
        try {
            return require('../../database').getUsersCollection() || null;
        } catch {
            return null;
        }
    },
    cancelCleanup = (tid) => require('../../socket/tournamentHandlers').cancelTournamentCleanup(tid),
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

    /**
     * Live tables: [casual (handed off: casual and, since PR 6, tournament
     * tables), others (the demo: today's path)].
     */
    function tables() {
        const casual = [];
        const others = [];
        for (const game of gm().games.values()) {
            if (!game || game.isTerminal?.() || game.frozen) continue;
            if (game.isDemo) others.push(game);
            else casual.push(game);
        }
        return { casual, others };
    }

    /** Live tournaments (PR 6). */
    function liveTournamentsHere() {
        const out = [];
        for (const t of gm().tournaments?.values?.() || []) {
            if (t && !t.retired && !t.frozen) out.push(t);
        }
        return out;
    }

    /** Freeze and drop a tournament (no emit, no doc delete: the store is closed). */
    function detachTournament(t) {
        try {
            t.frozen = t.handedOff = true;
            cancelCleanup(t.tournamentId);
        } catch (err) {
            logger.warn('Handoff tournament freeze failed', { tournamentId: t.tournamentId, error: err?.name });
        }
        try {
            if (gm().tournaments.get(t.tournamentId) === t) gm().deleteTournament(t.tournamentId);
        } catch (err) {
            logger.warn('Handoff tournament detach failed', { tournamentId: t.tournamentId, error: err?.name });
        }
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
        const out = { tables: [], tournaments: [], successor: false };
        s.adopter?.stop();
        const first = tables();
        // Nothing to hand off: no timer, no I/O wait (the no-games shutdown
        // stays microtask-only)
        if (first.casual.length === 0 && first.others.length === 0 && liveTournamentsHere().length === 0 &&
            s.pending() === 0 && (s.adopter?.inFlight().length || 0) === 0) {
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
            // Suspended by the holder self-fence (a Mongo blip): serialize
            // refuses it, but it took no input or timer since, so its last
            // saved doc is a valid restore point (released as it is in 4b)
            // Its tournament (PR 6), read before the detach drops the mapping
            let tid = doc?.tournamentId ?? null;
            if (tid == null) {
                try {
                    tid = gm().tournamentGames?.get?.(game.gameId) ?? null;
                } catch {
                    tid = null;
                }
            }
            return { game, doc, tid, suspended: game.isSuspended === true, info: s.docInfo(game) || { inserted: false, insertPending: false } };
        });
        // Tournaments before their tables are detached (tableScores reads them)
        const tEntries = liveTournamentsHere().map((t) => {
            let doc = null;
            try {
                doc = serializeTournament(t);
            } catch (err) {
                logger.warn('Handoff serialize failed', { tournamentId: t.tournamentId, error: err?.name });
            }
            return { t, doc, info: s.docInfo(t) || { inserted: false, insertPending: false } };
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
        for (const e of tEntries) detachTournament(e.t);
        const coll = s.collections();
        const liveGames = coll.liveGames;
        const liveTournaments = coll.liveTournaments;
        const me = s.bootId;
        const mayHaveDoc = (e) => e.info.inserted || e.info.insertPending;

        // 3. successor, before anything is released. A read that failed or
        // timed out says nothing: an 'on' successor may be up (4b, UNKNOWN)
        let successor = null;
        const found = await bounded(findSuccessor(s), SUCCESSOR_MS);
        const successorUnknown = failedOrTimedOut(found);
        if (!successorUnknown) successor = found;
        out.successor = !!successor;

        if (!successor && !successorUnknown) {
            // 4a. delete, never release
            // An adoption claim still settling is not this process's table:
            // adopt.js hands that doc straight back (never deleted here)
            const claiming = s.adopter?.inFlightIds?.() || [];
            const del = await bounded(Promise.all([
                liveGames ? liveGames.deleteMany(claiming.length ? { owner: me, _id: { $nin: claiming } } : { owner: me }) : null,
                liveTournaments ? liveTournaments.deleteMany({ owner: me }) : null
            ]), NO_SUCCESSOR_DELETE_MS);
            const deleted = !failedOrTimedOut(del);
            for (const e of entries) {
                out.tables.push({ game: e.game, outcome: !mayHaveDoc(e) ? 'ended' : (deleted && !e.info.insertPending ? 'ended' : 'unknown') });
            }
            for (const game of others) out.tables.push({ game, outcome: 'ended' });
            for (const e of tEntries) out.tournaments.push({ tournament: e.t, outcome: 'ended' });
            s.stopHeartbeat();
            logger.info('Handoff: no successor; live docs deleted', { tables: entries.length, ...(tEntries.length > 0 && { tournaments: tEntries.length }), deleted });
            return out;
        }

        // 4b. final writes, then release + delete (a successor, or the read failed)
        const flushStart = monoNow();
        const writes = entries.map((e) => {
            if (!e.doc || e.info.insertPending || !liveGames) return Promise.resolve(false);
            const replacement = s.finalDoc(e.game, e.doc);
            if (!replacement) return Promise.resolve(false);
            const op = e.info.inserted
                // rev $lt: a routine update still in flight (past the settle
                // bound) matches nothing once this lands (its filter is
                // rev-monotonic too), so the released doc is this state
                ? liveGames.replaceOne({ _id: e.game.gameId, owner: me, released: false, rev: { $lt: replacement.rev } }, replacement).then((r) => !!r && r.matchedCount === 1)
                : liveGames.insertOne(replacement).then(() => true);
            e.writeSent = true;
            e.insertSent = !e.info.inserted;
            return bounded(op, FLUSH_WRITE_MS).then((r) => {
                if (r === TIMEOUT) e.writeTimedOut = true;
                return r === true;
            });
        });
        // Tournaments' final writes, the same way (PR 6)
        const tWrites = tEntries.map((e) => {
            if (!e.doc || e.info.insertPending || !liveTournaments) return Promise.resolve(false);
            const replacement = s.finalDoc(e.t, e.doc);
            if (!replacement) return Promise.resolve(false);
            const op = e.info.inserted
                ? liveTournaments.replaceOne({ _id: e.t.tournamentId, owner: me, released: false, rev: { $lt: replacement.rev } }, replacement).then((r) => !!r && r.matchedCount === 1)
                : liveTournaments.insertOne(replacement).then(() => true);
            e.insertSent = !e.info.inserted;
            return bounded(op, FLUSH_WRITE_MS).then((r) => r === true);
        });
        const [acks, tAcks] = await Promise.all([Promise.all(writes), Promise.all(tWrites)]);
        const tAcked = tEntries.filter((e, i) => tAcks[i]);
        // A saved tournament doc whose final write did not land is released
        // as it is (successor seen or not): its tables' docs need it. One
        // with no saved doc, or whose serialize refused, is deleted
        const tAsIs = tEntries.filter((e) => e.info.inserted && !!e.doc && !tAcked.includes(e));
        const tReleaseIds = [...tAcked, ...tAsIs].map((e) => e.t.tournamentId);
        // A table of a tournament handed off here goes with it: never released
        // when its tournament is not (deleted with it, never told 'continue')
        const tByTid = new Map(tEntries.map((e) => [e.t.tournamentId, e]));
        const tournamentOf = (e) => (e.tid != null ? tByTid.get(e.tid) || null : null);
        const dropped = entries.filter((e) => {
            const te = tournamentOf(e);
            return !!te && !tReleaseIds.includes(te.t.tournamentId);
        });
        const acked = entries.filter((e, i) => acks[i] && !dropped.includes(e));
        const tKeepIds = [...tReleaseIds, ...(s.adopter?.inFlightTournamentIds?.() || [])];
        const ackedIds = acked.map((e) => e.game.gameId);
        // A suspended table's saved doc is released as it is (never
        // deleted). Its outcome is UNKNOWN: the doc may be a move behind,
        // or another instance may own it already (then the release, on
        // owner: me, leaves it alone)
        // After a failed successor read, likewise every saved doc whose final
        // write did not land (a table serialize refuses, tainted or invalid,
        // is still deleted)
        const asIs = entries.filter((e) => e.info.inserted && !acked.includes(e) && !dropped.includes(e) && (e.suspended || (successorUnknown && !!e.doc)));
        const releaseIds = [...ackedIds, ...asIs.map((e) => e.game.gameId)];
        // An adoption claim still settling (past the settle bound): adopt.js
        // hands that doc straight back, so the delete leaves it alone
        const keepIds = [...releaseIds, ...(s.adopter?.inFlightIds?.() || [])];
        const releasedAt = new Date(now());
        const left = Math.max(0, FLUSH_MS - (monoNow() - flushStart));
        const relStart = monoNow();
        const [rel, del, tRel] = await Promise.all([
            bounded(liveGames
                ? liveGames.updateMany(
                    { owner: me, $or: [{ _id: { $in: releaseIds } }, { kind: 'ended' }] },
                    { $set: { released: true, releasedAt, releaseKind: 'handoff' } })
                : null, left),
            bounded(Promise.all([
                liveGames ? liveGames.deleteMany({ owner: me, kind: 'live', released: false, _id: { $nin: keepIds } }) : null,
                liveTournaments ? liveTournaments.deleteMany({ owner: me, released: false, _id: { $nin: tKeepIds } }) : null
            ]), left),
            bounded(liveTournaments && tReleaseIds.length
                ? liveTournaments.updateMany({ owner: me, _id: { $in: tReleaseIds } }, { $set: { released: true, releasedAt, releaseKind: 'handoff' } })
                : null, left)
        ]);
        const releasedOk = !failedOrTimedOut(rel) && !!liveGames;
        const deletedOk = !failedOrTimedOut(del);
        const tReleasedOk = !failedOrTimedOut(tRel) && !!liveTournaments && tReleaseIds.length > 0;
        // Lobby members' pointers for each released lobby-phase tournament
        // (shipped iOS routes a member back by activeTournamentId), never
        // over a pointer set elsewhere meanwhile; within what is left of FLUSH_MS
        const lobbies = tReleasedOk ? tEntries.filter((e) => tReleaseIds.includes(e.t.tournamentId) && e.doc?.phase === 'lobby') : [];
        const usersColl = lobbies.length ? users() : null;
        if (usersColl) {
            const rest = Math.max(0, left - (monoNow() - relStart));
            await bounded(Promise.all(lobbies.map((e) => {
                const tid = e.t.tournamentId;
                const members = (e.doc.state?.players || []).map((p) => p.username).filter(Boolean);
                if (!members.length) return null;
                return usersColl.updateMany(
                    { username: { $in: members }, $or: [{ activeTournamentId: { $exists: false } }, { activeTournamentId: null }, { activeTournamentId: tid }] },
                    { $set: { activeTournamentId: tid } }
                );
            })), rest);
        }
        for (const e of tEntries) {
            const released = tReleasedOk && tReleaseIds.includes(e.t.tournamentId);
            out.tournaments.push({ tournament: e.t, outcome: released && !successorUnknown && tAcked.includes(e) ? 'continue' : (released || !deletedOk ? 'unknown' : 'ended') });
        }
        // 'continue' for a tournament's table only with its tournament's final
        // state released (acknowledged): one released as saved may be behind
        const tournamentSure = (e) => {
            const te = tournamentOf(e);
            return !te || (tAcked.includes(te) && tReleasedOk);
        };
        for (const e of entries) {
            let outcome;
            if (acked.includes(e)) outcome = releasedOk && !successorUnknown && tournamentSure(e) ? 'continue' : 'unknown';
            else if (asIs.includes(e)) outcome = 'unknown';
            else if (!mayHaveDoc(e) && !e.insertSent) outcome = 'ended';
            // An insert that may still land after the delete, or a delete not acknowledged
            else if (e.info.insertPending || (e.insertSent && e.writeTimedOut) || !deletedOk) outcome = 'unknown';
            else outcome = 'ended';
            out.tables.push({ game: e.game, outcome });
        }
        for (const game of others) out.tables.push({ game, outcome: 'ended' });
        s.stopHeartbeat();
        // released counts every id sent for release (final write acknowledged,
        // or as saved); asIs those released as saved. The message follows
        // whether the release was acknowledged
        const head = successorUnknown ? 'Handoff: successor read failed; ' : 'Handoff: ';
        logger.info(head + (releasedOk ? 'live docs released' : 'release not acknowledged'), {
            tables: entries.length,
            ...(tEntries.length > 0 && { tournaments: tEntries.length, tournamentsReleased: tReleasedOk ? tReleaseIds.length : 0 }),
            released: releasedOk ? releaseIds.length : 0,
            asIs: releasedOk ? asIs.length : 0,
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
        const out = { tables: [], tournaments: [] };
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
        // Tournaments (PR 6): frozen and dropped, each in try/catch
        let tList = [];
        try {
            tList = liveTournamentsHere();
        } catch {
            tList = [];
        }
        const tHadDoc = tList.map((t) => {
            let info = null;
            try {
                info = s?.docInfo(t) || null;
            } catch {
                info = null;
            }
            detachTournament(t);
            return !!info && (info.inserted || info.insertPending);
        });
        let released = false;
        if (s && (entries.some((e) => e.mayHaveDoc) || tHadDoc.some(Boolean))) {
            try {
                const { liveGames, liveTournaments } = s.collections();
                const set = { $set: { released: true, releasedAt: new Date(now()), releaseKind: 'crash' } };
                const [r] = await Promise.all([
                    liveGames ? bounded(liveGames.updateMany({ owner: s.bootId }, set), CRASH_RELEASE_MS) : TIMEOUT,
                    liveTournaments ? bounded(liveTournaments.updateMany({ owner: s.bootId }, set), CRASH_RELEASE_MS) : null
                ]);
                released = !!liveGames && !failedOrTimedOut(r);
            } catch {
                released = false;
            }
        }
        tList.forEach((t) => out.tournaments.push({ tournament: t, outcome: 'crash' }));
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
