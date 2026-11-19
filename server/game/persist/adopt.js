/**
 * Adoption (deploy survival PR 5, the plan's 2.1 "Adoption rule", 2.5 and
 * 2.6; LIVE_PERSIST=on with the unique gameId index only): this process
 * takes over casual games other instances saved, when their owner released
 * them (a deploy's handoff, a crash) or is seen dead. Built by
 * liveStore.start() (getAdopter), never on its own.
 *
 * Liveness is judged here, on THIS process's monotonic clock, never by
 * comparing clocks: an owner is dead once its instance doc's (beatAt,
 * beatSeq) has been seen unchanged (or missing) for STALE_MS since this
 * process first read that value. The one wall-clock reading is coarse: a
 * beat older than ADOPT_MAX_AGE_MS (15 min) is dead at once (a doc that
 * old is discarded anyway).
 *
 * A liveGames doc of another owner is, in this order:
 *   pending      not released and its owner not seen dead: left alone
 *                (a live owner's doc is never deleted, whatever its mode)
 *   tournament   a released / dead owner's tournament table with ownerMode
 *                'on' (PR 6): left alone. PR 5 writes tournament tables
 *                as 'write', so theirs are discarded as below
 *   discard      ownerMode 'write' (never adoptable), a live doc whose
 *                codec version this process cannot read, too old (released
 *                more than 15 min ago, or its owner's last beat more than
 *                15 min ago; a same-deployment owner with an older
 *                startedAt (a crash restart of this deployment) has no age
 *                limit), or a crash loop (adoptAttempts, below): deleted
 *                (compare-and-set on owner and rev), then its players'
 *                activeGameId pointers cleared (scoped to the game)
 *   tombstone    kind 'ended' (the game ended there but its record may not
 *                be in): adopted, its gameRecords doc inserted (once: the
 *                unique gameId index and insertGameRecord's read-first) and
 *                its stats applied (once per player: the statsGames guard),
 *                then the pointers cleared and the doc deleted. No hydrate,
 *                no gate
 *   adopt        a live doc: dropped (deleted + pointers) if gameRecords
 *                already has the game; else its seat owners and chat
 *                senders are looked up in users (one find; bot personas
 *                never): a missing, deleted (name hold) or merged owner's
 *                seat becomes resignBot/gone with a fresh bot, a missing
 *                or deleted sender's chat lines are dropped (a merged
 *                sender's stay), a name hold's deletedAt is noted
 *                (accountDelete.noteDeletedAccount); then the compare-and-set
 *                {owner, rev} -> {owner: me, released: false, adoptedBy,
 *                adoptedAt, adoptAttempts}; then restoreGame.adoptGame
 *                (hydrate, register, bots, the resumed line, the restore
 *                gate and the restored-abandon timer: the GAME side) and
 *                the store tracks it as an update-only doc. A doc that
 *                fails to hydrate is deleted and its pointers cleared.
 * adoptAttempts: an adopter that dies (killed, or a crash release) within
 * QUICK_DEATH_MS of its adoptedAt counts once; a doc whose adopters died
 * quickly MAX_QUICK_DEATHS times in a row is discarded (a crash loop under
 * ON_FAILURE restarts). Anything else starts the count again at 1, and the
 * adopter's first write once the restore gate opens sets it to 0, so a game
 * that survived a deploy still resumes after a later crash.
 *
 * Single flight per id (sweep and resolve share it); the sweep is single
 * flight too and stops at shutdown (stop(), and isShuttingDown at every
 * step: a process never adopts during its own shutdown). It never reads
 * this process's own docs (owner $ne me).
 *
 * Never logs a doc, a hand or chat: ids, rev and reasons only.
 */

'use strict';

const { randomUUID } = require('crypto');
const { safeTimeout } = require('../../utils/safeTimer');

/** An owner whose beat has not changed for this long, on the observer's clock, is dead. */
const STALE_MS = 12000;
/** A released doc (by releasedAt) or a dead owner's (by its last beat) older than this is discarded. */
const ADOPT_MAX_AGE_MS = 15 * 60 * 1000;
/** An adopter that died within this long of adopting counts as a quick death. */
const QUICK_DEATH_MS = 60 * 1000;
/** A doc whose adopters died quickly this many times in a row is discarded. */
const MAX_QUICK_DEATHS = 2;
/** Sweep cadence: every second for the first 3 minutes after start, then every 15 s. */
const SWEEP_FAST_MS = 1000;
const SWEEP_FAST_FOR_MS = 3 * 60 * 1000;
const SWEEP_SLOW_MS = 15000;
/** A restored casual table nobody returns to is aborted after this (owner, 2026-11-16 answer b). */
const RESTORE_ABANDON_MS = 10 * 60 * 1000;
/** The same for a tournament table (5 min; PR 6 adopts those). */
const TOURNAMENT_RESTORE_ABANDON_MS = 5 * 60 * 1000;
/** The game-log line an adopted game gets (restoreGame.adoptGame writes it). */
const RESUMED_LINE = 'This game resumed after a server update.';

/** What the sweep reads of a doc: the envelope and the usernames a discard clears pointers for. */
const ENVELOPE_PROJECTION = Object.freeze({
    _id: 1, v: 1, kind: 1, owner: 1, ownerMode: 1, released: 1, releasedAt: 1, releaseKind: 1,
    rev: 1, createdAt: 1, updatedAt: 1, adoptAttempts: 1, adoptedBy: 1, adoptedAt: 1,
    stage: 1, tournamentId: 1, 'state.seats': 1, 'ended.seats': 1
});

const ms = (v) => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v) {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : null;
    }
    return null;
};

const isBotName = (name) => typeof name === 'string' && name.startsWith('🤖 ');

/** Every human username a doc names as a seat owner (live or tombstone). */
function seatOwners(doc) {
    const out = new Set();
    for (const s of Object.values(doc?.state?.seats || {})) {
        if (s && s.controller !== 'bot' && typeof s.ownerUsername === 'string' && s.ownerUsername) out.add(s.ownerUsername);
    }
    for (const s of doc?.ended?.seats || []) {
        if (s && typeof s.username === 'string' && s.username && !isBotName(s.username)) out.add(s.username);
    }
    return [...out];
}

/**
 * Observer-side liveness of instances (bootId -> what was last read and
 * since when, on `monoNow`).
 */
function createLiveness({ monoNow, staleMs = STALE_MS }) {
    const seen = new Map();
    const keyOf = (inst) => (inst ? `${ms(inst.beatAt)}:${inst.beatSeq}` : 'missing');
    return {
        /** Record `inst` (the instance doc, or null if none) for `bootId`; 'alive' | 'dead'. */
        observe(bootId, inst) {
            const key = keyOf(inst);
            const prev = seen.get(bootId);
            if (!prev || prev.key !== key) {
                seen.set(bootId, { key, since: monoNow() });
                return 'alive';
            }
            return monoNow() - prev.since >= staleMs ? 'dead' : 'alive';
        },
        /** 'alive' | 'dead' | 'unknown' (never observed) without a new reading. */
        status(bootId) {
            const prev = seen.get(bootId);
            if (!prev) return 'unknown';
            return monoNow() - prev.since >= staleMs ? 'dead' : 'alive';
        },
        /** True when `bootId`'s beat was seen changing within `withinMs` (fresh). */
        changedWithin(bootId, withinMs) {
            const prev = seen.get(bootId);
            return !!prev && prev.key !== 'missing' && monoNow() - prev.since <= withinMs;
        },
        _seen: seen
    };
}

/**
 * The adoption rule for one doc of another owner (pure).
 * @returns {{act: 'tournament'|'pending'|'discard'|'tombstone'|'adopt', why?: string, attempts?: number}}
 */
function classify(doc, { ownerState, ownerInst, me, myStartedAt, myDeploymentId, now, readVersions, maxAgeMs = ADOPT_MAX_AGE_MS, quickDeathMs = QUICK_DEATH_MS }) {
    if (!doc || doc.owner === me) return { act: 'pending', why: 'mine' };
    const released = doc.released === true;
    if (!released && ownerState !== 'dead') return { act: 'pending', why: 'owner alive' };
    // A tournament table PR 6 may adopt (its tournament first). In PR 5
    // they all say ownerMode 'write' and are discarded below like any
    // 'write' doc of a released or dead owner
    if (doc.tournamentId && doc.ownerMode === 'on') return { act: 'tournament' };
    if (doc.ownerMode !== 'on') return { act: 'discard', why: 'mode' };
    if (doc.kind !== 'live' && doc.kind !== 'ended') return { act: 'discard', why: 'kind' };
    if (doc.kind === 'live' && !readVersions.includes(doc.v)) return { act: 'discard', why: 'version' };
    if (released) {
        const at = ms(doc.releasedAt);
        if (at === null || now - at > maxAgeMs) return { act: 'discard', why: 'age' };
    } else {
        const sameDeployment = !!(ownerInst && myDeploymentId && ownerInst.deploymentId === myDeploymentId
            && ms(ownerInst.startedAt) !== null && ms(myStartedAt) !== null && ms(ownerInst.startedAt) < ms(myStartedAt));
        if (!sameDeployment) {
            const lastBeat = ownerInst ? ms(ownerInst.beatAt) : ms(doc.updatedAt);
            if (lastBeat === null || now - lastBeat > maxAgeMs) return { act: 'discard', why: 'age' };
        }
    }
    // The previous adopter (the current owner) died this soon after adopting?
    const deathAt = released
        ? (doc.releaseKind === 'crash' ? ms(doc.releasedAt) : null)
        : (ownerInst ? ms(ownerInst.beatAt) : ms(doc.updatedAt));
    const adoptedAt = ms(doc.adoptedAt);
    const quick = !!doc.adoptedBy && doc.adoptedBy === doc.owner && deathAt !== null && adoptedAt !== null
        && deathAt - adoptedAt < quickDeathMs;
    const attempts = quick ? (Number(doc.adoptAttempts) || 0) + 1 : 1;
    if (attempts > MAX_QUICK_DEATHS) return { act: 'discard', why: 'crash loop' };
    return { act: doc.kind === 'ended' ? 'tombstone' : 'adopt', attempts };
}

/**
 * A copy of a live doc with seats of `goneOwners` turned into resignBot/gone
 * (a fresh bot each, also in doc.bots) and chat lines of `scrubbed` senders
 * dropped. Pure apart from the bot ids and pictures it makes.
 */
function screenDoc(doc, { goneOwners, scrubbed, now }) {
    const out = JSON.parse(JSON.stringify({ ...doc, _id: undefined }));
    out._id = doc._id;
    // Dates survive the copy as ISO strings only where the codec does not read them
    out.createdAt = doc.createdAt;
    if (goneOwners.size > 0) {
        const { personalities } = require('../bot');
        const { PERSONALITY_LIST, getDisplayName } = personalities;
        const { randomStockPic } = require('../../avatar/stockAvatars');
        const used = new Set();
        for (const b of out.bots || []) if (b?.personality) used.add(b.personality);
        for (const s of Object.values(out.state.seats)) if (s?.bot?.personality) used.add(s.bot.personality);
        out.bots = Array.isArray(out.bots) ? out.bots : [];
        for (const [posKey, s] of Object.entries(out.state.seats)) {
            if (!s || s.controller === 'bot' || !goneOwners.has(s.ownerUsername)) continue;
            if (s.controller !== 'human' && s.gone) continue;
            const pos = Number(posKey);
            let personality = s.bot?.personality || null;
            if (!personality) {
                personality = (s.lastPersonality && !used.has(s.lastPersonality) && PERSONALITY_LIST.includes(s.lastPersonality))
                    ? s.lastPersonality
                    : (PERSONALITY_LIST.find((p) => !used.has(p)) || PERSONALITY_LIST[0]);
            }
            used.add(personality);
            let bot = s.bot;
            if (!bot) {
                const username = `🤖 ${getDisplayName(personality)}`;
                bot = { socketId: `bot:${username.toLowerCase()}:${randomUUID()}`, username, pic: randomStockPic(), personality };
                out.bots.push({ socketId: bot.socketId, username, personality, position: pos, pic: bot.pic, partnerHistory: [] });
            }
            out.state.seats[posKey] = {
                ...s,
                controller: 'resignBot',
                presence: 'gone',
                gone: true,
                bot,
                resignedAt: s.resignedAt ?? now,
                leftAt: s.leftAt ?? now
            };
        }
    }
    if (scrubbed.size > 0 && Array.isArray(out.log)) {
        out.log = out.log.filter((e) => !(e && typeof e.from === 'string' && scrubbed.has(e.from)));
    }
    return out;
}

/**
 * @param {Object} ctx - from liveStore (bootId, deploymentId, startedAt(),
 *   now, monoNow, logger, logFailure, collections, isShuttingDown, getIo,
 *   trackAdopted, isOn, isClosed) plus overrides for tests:
 *   adoptGame(io, doc, {now, abandonMs}) -> GameState (restoreGame.adoptGame),
 *   isGated(game), users(), gameRecords(), recordEnded(record) -> boolean,
 *   clearPointer(username, gameId), noteDeleted(username, atMs),
 *   readVersions, staleMs, maxAgeMs, quickDeathMs, sweepFastMs,
 *   sweepFastForMs, sweepSlowMs, abandonMs
 */
function createAdopter(ctx) {
    const {
        bootId: me,
        deploymentId = null,
        startedAt = () => null,
        now = () => Date.now(),
        monoNow,
        logger,
        logFailure = () => {},
        collections,
        isShuttingDown = () => false,
        getIo = () => null,
        trackAdopted,
        isOn = () => true,
        isClosed = () => false,
        adoptGame = (io, doc, opts) => require('./restoreGame').adoptGame(io, doc, opts),
        isGated = (game) => {
            try {
                return require('./restoreGame').isGated(game) === true;
            } catch {
                return false;
            }
        },
        users = () => safeDb('getUsersCollection'),
        gameRecords = () => safeDb('getGameRecordsCollection'),
        recordEnded = (record) => require('../../socket/profileHandlers').recordEndedGame(record),
        clearPointer = (username, gameId) => require('../GameManager').clearActiveGame(username, gameId),
        noteDeleted = (username, atMs) => require('../../admin/accountDelete').noteDeletedAccount(username, atMs),
        readVersions = require('./gameCodec').READ_VERSIONS,
        staleMs = STALE_MS,
        maxAgeMs = ADOPT_MAX_AGE_MS,
        quickDeathMs = QUICK_DEATH_MS,
        sweepFastMs = SWEEP_FAST_MS,
        sweepFastForMs = SWEEP_FAST_FOR_MS,
        sweepSlowMs = SWEEP_SLOW_MS,
        abandonMs = RESTORE_ABANDON_MS
    } = ctx;

    function safeDb(getter) {
        try {
            const database = require('../../database');
            return typeof database[getter] === 'function' ? database[getter]() || null : null;
        } catch {
            return null;
        }
    }

    const liveness = createLiveness({ monoNow, staleMs });
    const adopting = new Map();       // gameId -> promise of the adopt / discard / tombstone op
    const waiters = new Map();        // gameId -> Set of (game|null) => void
    const heldTombstones = new Map(); // gameId -> doc: adopted tombstones whose record has not landed yet
    let sweeping = null;
    let timer = null;
    let stopped = true;
    let startMono = null;
    let bootSwept = false;
    let resolveBootSwept;
    const bootSweptPromise = new Promise((r) => { resolveBootSwept = r; });
    let lastSweepAt = null;
    let adoptedCount = 0;

    const stopping = () => stopped || isShuttingDown() || isClosed() || !isOn();

    // ---------- instances ----------

    /** Every instance doc, observed; Map bootId -> doc. */
    async function readInstances() {
        const coll = collections().serverInstances;
        if (!coll) throw Object.assign(new Error('no serverInstances'), { name: 'NoCollection' });
        const list = await coll.find({}, { projection: { _id: 1, deploymentId: 1, mode: 1, startedAt: 1, beatAt: 1, beatSeq: 1, shuttingDown: 1, gameIds: 1 } }).toArray();
        const out = new Map();
        for (const inst of list) {
            out.set(inst._id, inst);
            if (inst._id !== me) liveness.observe(inst._id, inst);
        }
        return out;
    }

    /** 'alive' | 'dead' for `bootId`, given this pass's instance docs. */
    function ownerState(bootId, instances) {
        const inst = instances.get(bootId) || null;
        const state = liveness.observe(bootId, inst);
        if (state === 'dead') return 'dead';
        // Coarse wall-clock backstop: a beat this old is no live owner
        if (inst && ms(inst.beatAt) !== null && now() - ms(inst.beatAt) > maxAgeMs) return 'dead';
        return 'alive';
    }

    function verdict(doc, instances) {
        return classify(doc, {
            ownerState: ownerState(doc.owner, instances),
            ownerInst: instances.get(doc.owner) || null,
            me,
            myStartedAt: startedAt(),
            myDeploymentId: deploymentId,
            now: now(),
            readVersions,
            maxAgeMs,
            quickDeathMs
        });
    }

    // ---------- waiters ----------

    function notify(gameId, game) {
        const set = waiters.get(gameId);
        if (!set) return;
        waiters.delete(gameId);
        for (const fn of set) fn(game);
    }

    function whenAdopted(gameId, waitMs) {
        return new Promise((resolve) => {
            let set = waiters.get(gameId);
            if (!set) waiters.set(gameId, (set = new Set()));
            let t = null;
            const done = (game) => {
                if (t) clearTimeout(t);
                set.delete(done);
                if (set.size === 0 && waiters.get(gameId) === set) waiters.delete(gameId);
                resolve(game || null);
            };
            set.add(done);
            t = safeTimeout(() => done(null), Math.max(0, waitMs), 'adopt:wait');
            t.unref?.();
        });
    }

    // ---------- operations on one doc ----------

    async function clearPointers(usernames, gameId) {
        await Promise.all(usernames.map(async (u) => {
            try {
                await clearPointer(u, gameId);
            } catch (err) {
                logFailure('pointer clear', null, err, { gameId });
            }
        }));
    }

    /** Delete another owner's doc (compare-and-set on owner and rev), then clear its players' pointers. */
    async function discard(env, why) {
        const coll = collections().liveGames;
        if (!coll) return false;
        const res = await coll.deleteOne({ _id: env._id, owner: env.owner, rev: env.rev });
        if (!res || !res.deletedCount) return false;
        logger.info('Live doc discarded', { gameId: env._id, rev: env.rev, why });
        await clearPointers(seatOwners(env), env._id);
        notify(env._id, null);
        return true;
    }

    /** One users.find over a doc's seat owners and chat senders: who is gone, who is merged, name holds. */
    async function screenAccounts(doc) {
        const owners = seatOwners(doc);
        const senders = new Set();
        for (const e of doc.log || []) if (e && typeof e.from === 'string' && e.from && !isBotName(e.from)) senders.add(e.from);
        const names = [...new Set([...owners, ...senders])];
        const goneOwners = new Set();
        const scrubbed = new Set();
        if (names.length === 0) return { goneOwners, scrubbed };
        const coll = users();
        if (!coll) throw Object.assign(new Error('no users collection'), { name: 'NoCollection' });
        const found = await coll.find({ username: { $in: names } }, { projection: { username: 1, mergedInto: 1, deletedAt: 1 } }).toArray();
        const byName = new Map(found.map((u) => [u.username, u]));
        const DELETED = '[deleted]';
        for (const name of names) {
            const u = byName.get(name);
            const deleted = !u || u.mergedInto === DELETED;
            const merged = !!u && typeof u.mergedInto === 'string' && u.mergedInto !== DELETED;
            if (u && u.mergedInto === DELETED && ms(u.deletedAt) !== null) {
                try {
                    noteDeleted(name, ms(u.deletedAt));
                } catch (err) {
                    logFailure('note deleted', null, err);
                }
            }
            if (owners.includes(name) && (deleted || merged)) goneOwners.add(name);
            if (senders.has(name) && deleted) scrubbed.add(name);
        }
        return { goneOwners, scrubbed };
    }

    /** Adopt a live doc (verdict 'adopt'). */
    async function adoptLive(env, attempts) {
        const coll = collections().liveGames;
        if (!coll) return { state: 'pending' };
        const records = gameRecords();
        if (records) {
            const rec = await records.findOne({ gameId: env._id }, { projection: { _id: 1 } });
            if (rec) {
                await discard(env, 'recorded');
                return { state: 'gone' };
            }
        }
        const full = await coll.findOne({ _id: env._id, owner: env.owner, rev: env.rev });
        if (!full) return { state: 'lost' };
        const { goneOwners, scrubbed } = await screenAccounts(full);
        if (stopping()) return { state: 'pending' };
        const at = new Date(now());
        const claimed = await coll.findOneAndUpdate(
            { _id: env._id, owner: env.owner, rev: env.rev },
            {
                $set: {
                    owner: me, ownerMode: 'on', released: false, releasedAt: null, releaseKind: null,
                    adoptedBy: me, adoptedAt: at, adoptAttempts: attempts, rev: env.rev + 1, updatedAt: at
                }
            },
            { returnDocument: 'after' }
        );
        if (!claimed) return { state: 'lost' };
        // Ours now. A handoff that already froze this process's tables must
        // not get a new one: the doc stays ours, unreleased (the handoff's
        // cleanup deletes it, or the next instance adopts it once this one
        // is seen dead)
        if (isClosed()) return { state: 'pending' };
        const doc = screenDoc({ ...full, ...claimed, gameId: env._id }, { goneOwners, scrubbed, now: now() });
        let game;
        try {
            game = adoptGame(getIo(), doc, { now: now(), abandonMs });
        } catch (err) {
            logFailure('adopt', null, err, { gameId: env._id, why: err?.reason || err?.name || 'error' });
            // Not restorable: the doc goes, and so do its pointers
            try {
                const res = await coll.deleteOne({ _id: env._id, owner: me });
                if (res?.deletedCount) await clearPointers(seatOwners(full), env._id);
            } catch (delErr) {
                logFailure('adopt discard', null, delErr, { gameId: env._id });
            }
            notify(env._id, null);
            return { state: 'gone' };
        }
        if (!game) {
            notify(env._id, null);
            return { state: 'gone' };
        }
        trackAdopted(game, claimed);
        adoptedCount++;
        logger.info('Live game adopted', { gameId: env._id, rev: claimed.rev, from: String(env.owner).slice(0, 8), attempts, released: env.released === true });
        notify(env._id, game);
        return { state: 'adopted', game };
    }

    /** Record an adopted tombstone's game (once), clear its pointers, delete it. True when finished. */
    async function finishTombstone(doc) {
        const ended = doc.ended || {};
        if (ended.record) {
            let ok = false;
            try {
                ok = await recordEnded(ended.record);
            } catch (err) {
                logFailure('tombstone record', null, err, { gameId: doc._id });
            }
            if (!ok) return false;
        }
        await clearPointers(seatOwners(doc), doc._id);
        const coll = collections().liveGames;
        if (!coll) return false;
        await coll.deleteOne({ _id: doc._id, owner: me, kind: 'ended' });
        heldTombstones.delete(doc._id);
        logger.info('Ended game recorded from its tombstone', { gameId: doc._id, rev: doc.rev });
        return true;
    }

    async function adoptTombstone(env, attempts) {
        const coll = collections().liveGames;
        if (!coll) return { state: 'pending' };
        const at = new Date(now());
        const claimed = await coll.findOneAndUpdate(
            { _id: env._id, owner: env.owner, rev: env.rev },
            { $set: { owner: me, released: false, releasedAt: null, releaseKind: null, adoptedBy: me, adoptedAt: at, adoptAttempts: attempts, rev: env.rev + 1, updatedAt: at } },
            { returnDocument: 'after' }
        );
        if (!claimed) return { state: 'lost' };
        heldTombstones.set(env._id, claimed);
        notify(env._id, null);
        await finishTombstone(claimed);
        return { state: 'gone' };
    }

    /** The one op for `env` (single flight per id), by its verdict. */
    function handle(env, instances) {
        const id = env._id;
        if (adopting.has(id)) return adopting.get(id);
        const v = verdict(env, instances);
        if (v.act === 'pending' || v.act === 'tournament') return Promise.resolve({ state: 'pending', act: v.act });
        if (stopping()) return Promise.resolve({ state: 'pending' });
        const op = (async () => {
            if (v.act === 'discard') return (await discard(env, v.why)) ? { state: 'gone' } : { state: 'lost' };
            if (v.act === 'tombstone') return adoptTombstone(env, v.attempts);
            return adoptLive(env, v.attempts);
        })().catch((err) => {
            logFailure('adopt', null, err, { gameId: id });
            return { state: 'pending' };
        }).finally(() => {
            if (adopting.get(id) === op) adopting.delete(id);
        });
        adopting.set(id, op);
        return op;
    }

    // ---------- the sweep ----------

    async function sweepOnce() {
        if (stopping()) return null;
        const coll = collections().liveGames;
        if (!coll) return null;
        const instances = await readInstances();
        const docs = await coll.find({ owner: { $ne: me } }, { projection: ENVELOPE_PROJECTION }).toArray();
        let adopted = 0;
        for (const env of docs) {
            if (stopping()) break;
            const r = await handle(env, instances);
            if (r && r.state === 'adopted') adopted++;
        }
        for (const doc of [...heldTombstones.values()]) {
            if (stopping()) break;
            try {
                await finishTombstone(doc);
            } catch (err) {
                logFailure('tombstone retry', null, err, { gameId: doc._id });
            }
        }
        lastSweepAt = now();
        if (!bootSwept && !stopping()) {
            bootSwept = true;
            resolveBootSwept(true);
            logger.info('Boot sweep done', { docs: docs.length, adopted });
        }
        return { docs: docs.length, adopted };
    }

    /** One pass (single flight: a call during a pass joins it). Never rejects. */
    function sweep() {
        if (sweeping) return sweeping;
        sweeping = sweepOnce().catch((err) => {
            logFailure('sweep', null, err);
            return null;
        }).finally(() => { sweeping = null; });
        return sweeping;
    }

    function scheduleNext() {
        if (stopped) return;
        const delay = monoNow() - startMono < sweepFastForMs ? sweepFastMs : sweepSlowMs;
        timer = safeTimeout(async () => {
            timer = null;
            if (stopping()) return;
            await sweep();
            scheduleNext();
        }, delay, 'adopt:sweep');
        timer.unref?.();
    }

    function start() {
        if (!stopped) return;
        stopped = false;
        startMono = monoNow();
        sweep().then(() => scheduleNext());
    }

    /** No more sweeps (shutdown): the timer cleared; a pass in flight stops at its next doc. */
    function stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
    }

    // ---------- resolve ----------

    /**
     * liveStore.resolve's 'on' path (see there): this process has no live
     * copy of `gameId`; read its doc and the instances, and adopt it, wait
     * on its owner, or say it is gone.
     */
    async function resolve(gameId, { waitMs, inMemory, whenDbReady }) {
        const bound = (p) => Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => {
            const t = safeTimeout(() => r(null), waitMs, 'adopt:resolveWait');
            t.unref?.();
        })]);
        await bound(whenDbReady(waitMs));
        await bound(bootSweptPromise);
        const here = inMemory();
        if (here) return { state: 'memory', game: here };
        if (isShuttingDown()) return { state: 'pending' };
        if (adopting.has(gameId)) {
            const r = await adopting.get(gameId);
            const g = inMemory();
            if (g) return { state: r?.state === 'adopted' ? 'adopted' : 'memory', game: g };
        }
        const coll = collections().liveGames;
        if (!coll) return { state: 'pending' };
        const env = await coll.findOne({ _id: gameId }, { projection: ENVELOPE_PROJECTION });
        const instances = await readInstances();
        if (env) {
            if (env.owner === me) {
                // Ours but not live here: a tombstone being finished, or a
                // table this process just fenced or froze
                return env.kind === 'ended' ? { state: 'gone' } : { state: 'pending' };
            }
            const r = await handle(env, instances);
            if (r.state === 'adopted' && r.game) return { state: 'adopted', game: r.game };
            if (r.state === 'gone') return { state: 'gone' };
            const g = inMemory();
            if (g) return { state: 'memory', game: g };
            return { state: 'pending' };
        }
        // No doc. A live instance that lists the id (a table it started
        // during the overlap, not written yet) holds it; and while an
        // older 'on' instance is alive, any id may still be one of its
        const myStart = ms(startedAt());
        for (const [id, inst] of instances) {
            if (id === me) continue;
            if (ownerState(id, instances) === 'dead') continue;
            if (Array.isArray(inst.gameIds) && inst.gameIds.includes(gameId)) return { state: 'pending' };
            if (inst.mode === 'on' && myStart !== null && ms(inst.startedAt) !== null && ms(inst.startedAt) < myStart) return { state: 'pending' };
        }
        return { state: 'gone' };
    }

    return {
        start,
        stop,
        sweep,
        resolve,
        whenAdopted,
        whenBootSwept: () => bootSweptPromise,
        gated: (game) => {
            try {
                return isGated(game) === true;
            } catch {
                return false;
            }
        },
        inFlight: () => [...adopting.values()],
        liveness,
        readInstances,
        get bootSwept() { return bootSwept; },
        get lastSweepAt() { return lastSweepAt; },
        get adoptedCount() { return adoptedCount; },
        _heldTombstones: heldTombstones
    };
}

module.exports = {
    createAdopter,
    createLiveness,
    classify,
    screenDoc,
    seatOwners,
    STALE_MS,
    ADOPT_MAX_AGE_MS,
    QUICK_DEATH_MS,
    MAX_QUICK_DEATHS,
    SWEEP_FAST_MS,
    SWEEP_FAST_FOR_MS,
    SWEEP_SLOW_MS,
    RESTORE_ABANDON_MS,
    TOURNAMENT_RESTORE_ABANDON_MS,
    RESUMED_LINE,
    ENVELOPE_PROJECTION
};
