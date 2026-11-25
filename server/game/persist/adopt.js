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
 *                'on' (PR 6): adopted WITH its tournament (below); if its
 *                tournament is live here already (it was pending then), it
 *                joins it (a live table adopted, a tombstone scored); if no
 *                doc of its tournament exists, it is discarded (a tombstone's
 *                record still inserted)
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
 *                fails to hydrate is deleted and its pointers cleared (a
 *                delete that fails is retried by every sweep, and resolve()
 *                removes such an orphan and answers 'gone': an own live doc
 *                nothing here holds is never 'pending' for good)
 * Tournaments (PR 6; liveTournaments, swept BEFORE the games): the same
 * rule (pending / discard / adopt; a crash loop counted the same way). A
 * tournament is adopted only once none of its tables' docs is pending (a
 * live owner still holds one). Adopt: one users.find over its members and
 * chat senders (a deleted or merged member is removed, a deleted sender's
 * lines dropped), the compare-and-set on liveTournaments, then
 * restoreTournament.adoptTournament (hydrate, ghosts, timers); then each of
 * its tables' docs by its own verdict (a live one adopted with the 5-minute
 * tournament abandon, an ENDED tombstone claimed), then
 * restoreTournament.normalizeRound (scores what did not survive, or rolls
 * the round back), then the claimed tombstones are recorded and deleted. A
 * table this adoption did not finish (the loop cut by a shutdown, a Mongo
 * error, adoptLive 'pending' or 'lost', a tombstone claim missed) still has
 * an adoptable doc: normalizeRound neither scores it nor rolls back for it
 * (a later sweep, or the successor, adopts it). normalizeRound is skipped
 * altogether once this process stops (or the tournament was frozen,
 * retired or replaced meanwhile), and so is the tombstones' recording (the
 * handoff releases them with the tournament). A
 * discarded tournament's members' activeTournamentId pointers are cleared
 * (scoped). resolveTournament(tid) answers like resolve() for a game.
 *
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
// The restored abandon (10 min casual; 5 min for a tournament table, which
// PR 6 adopts: owner, 2026-11-16 answer b) and the game-log line an adopted
// game gets are restoreGame's (it arms the one and writes the other)
const {
    RESTORE_ABANDON_MS,
    RESTORE_ABANDON_TOURNAMENT_MS: TOURNAMENT_RESTORE_ABANDON_MS,
    RESUMED_LINE
} = require('./restoreGame');

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

/** What the sweep reads of a tournament doc: the envelope and its members (pointer clears). */
const TOURNAMENT_ENVELOPE_PROJECTION = Object.freeze({
    _id: 1, v: 1, kind: 1, owner: 1, ownerMode: 1, released: 1, releasedAt: 1, releaseKind: 1,
    rev: 1, createdAt: 1, updatedAt: 1, adoptAttempts: 1, adoptedBy: 1, adoptedAt: 1,
    phase: 1, 'state.players.username': 1
});

/** The members a tournament doc names. */
function tournamentMembers(doc) {
    return (doc?.state?.players || []).map((p) => p && p.username).filter((u) => typeof u === 'string' && u);
}

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
function classify(doc, { ownerState, ownerInst, me, myStartedAt, myDeploymentId, now, readVersions, maxAgeMs = ADOPT_MAX_AGE_MS, quickDeathMs = QUICK_DEATH_MS, inTournament = false }) {
    if (!doc || doc.owner === me) return { act: 'pending', why: 'mine' };
    const released = doc.released === true;
    if (!released && ownerState !== 'dead') return { act: 'pending', why: 'owner alive' };
    // A tournament table (PR 6) is adopted with its tournament: `inner` is
    // what its own rule says (inTournament: that verdict alone)
    if (!inTournament && doc.tournamentId && doc.ownerMode === 'on') {
        return { act: 'tournament', inner: classify(doc, { ownerState, ownerInst, me, myStartedAt, myDeploymentId, now, readVersions, maxAgeMs, quickDeathMs, inTournament: true }) };
    }
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
 *   adoptGame(io, doc, {now, abandonMs, ownerPics}) -> GameState (restoreGame.adoptGame),
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
        trackAdoptedTournament = () => null,
        findTournament = (tid) => require('../GameManager').getTournamentById(tid),
        holdsTournamentLocally = () => true,
        adoptTournament = (io, doc, opts) => require('./restoreTournament').adoptTournament(io, doc, opts),
        normalizeRound = (io, t, opts) => require('./restoreTournament').normalizeRound(io, t, opts),
        scoreLateTable = (io, t, gameId, ended) => require('./restoreTournament').scoreLateTable(io, t, gameId, ended),
        clearTournamentPointer = (username, tid) => require('../GameManager').clearActiveTournament(username, tid),
        tournamentReadVersions = require('./tournamentCodec').READ_VERSIONS,
        tournamentAbandonMs = TOURNAMENT_RESTORE_ABANDON_MS,
        isOn = () => true,
        isClosed = () => false,
        // gameId -> true while this process's store still holds the game
        // (tracked and not done, or a tombstone): its own doc is not an orphan
        holdsLocally = () => true,
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
    const adoptingT = new Map();      // tournamentId -> promise of its adopt / discard op (PR 6)
    const waiters = new Map();        // gameId -> Set of (game|null) => void
    const heldTombstones = new Map(); // gameId -> doc: adopted tombstones whose record has not landed yet
    const orphans = new Map();        // gameId -> seat owners: own live docs nothing here holds (a failed cleanup), retried each sweep
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
        const list = await coll.find({}, { projection: { _id: 1, deploymentId: 1, mode: 1, startedAt: 1, beatAt: 1, beatSeq: 1, shuttingDown: 1, gameIds: 1, tournamentIds: 1 } }).toArray();
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

    function verdict(doc, instances, extra = {}) {
        return classify(doc, {
            ownerState: ownerState(doc.owner, instances),
            ownerInst: instances.get(doc.owner) || null,
            me,
            myStartedAt: startedAt(),
            myDeploymentId: deploymentId,
            now: now(),
            readVersions,
            maxAgeMs,
            quickDeathMs,
            ...extra
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
        const ownerPics = {};
        if (names.length === 0) return { goneOwners, scrubbed, ownerPics };
        const coll = users();
        if (!coll) throw Object.assign(new Error('no users collection'), { name: 'NoCollection' });
        const found = await coll.find({ username: { $in: names } }, { projection: { username: 1, mergedInto: 1, deletedAt: 1, customProfilePic: 1 } }).toArray();
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
            // A doc saves stock pictures only (gameCodec): an owner's custom
            // one comes from here, and adoptGame warms it
            if (owners.includes(name) && !deleted && !merged && u && typeof u.customProfilePic === 'string' && u.customProfilePic) {
                ownerPics[name] = u.customProfilePic;
            }
        }
        return { goneOwners, scrubbed, ownerPics };
    }

    /** Adopt a live doc (verdict 'adopt'); a tournament table with the tournament abandon. */
    async function adoptLive(env, attempts, { tableAbandonMs = abandonMs } = {}) {
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
        const { goneOwners, scrubbed, ownerPics } = await screenAccounts(full);
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
        // not get a new one: the doc goes straight back, released as its
        // previous owner left it (the next instance adopts it). Until this
        // op settles its id is in inFlight(), which the handoff's deletes
        // leave alone; a give-back that fails leaves it ours, unreleased,
        // for adoption once this process is seen dead
        if (isClosed()) {
            try {
                await coll.updateOne(
                    { _id: env._id, owner: me, rev: claimed.rev },
                    { $set: { released: true, releasedAt: new Date(now()), releaseKind: 'handoff' } }
                );
            } catch (err) {
                logFailure('adopt give-back', null, err, { gameId: env._id });
            }
            return { state: 'pending' };
        }
        const doc = screenDoc({ ...full, ...claimed, gameId: env._id }, { goneOwners, scrubbed, now: now() });
        let game;
        try {
            game = adoptGame(getIo(), doc, { now: now(), abandonMs: tableAbandonMs, ownerPics });
        } catch (err) {
            logFailure('adopt', null, err, { gameId: env._id, why: err?.reason || err?.name || 'error' });
            // Not restorable: the doc goes, and so do its pointers (a
            // delete that fails is retried by every sweep: removeOrphan)
            await removeOrphan(env._id, seatOwners(full));
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

    /**
     * Delete an own live doc nothing here runs (a claimed doc that failed
     * to hydrate, a doc a failed terminal claim left), then clear its
     * players' pointers. A delete that fails keeps it in `orphans` for the
     * next sweep. True when it is gone (or no longer ours).
     */
    async function removeOrphan(gameId, owners) {
        const coll = collections().liveGames;
        orphans.set(gameId, owners);
        if (!coll) return false;
        try {
            const res = await coll.deleteOne({ _id: gameId, owner: me, kind: 'live' });
            orphans.delete(gameId);
            if (res?.deletedCount) await clearPointers(owners, gameId);
            return true;
        } catch (err) {
            logFailure('adopt discard', null, err, { gameId });
            return false;
        }
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

    /** Claim an ENDED tombstone (compare-and-set); the claimed doc, or null. */
    async function claimTombstone(env, attempts) {
        const coll = collections().liveGames;
        if (!coll) return null;
        const at = new Date(now());
        const claimed = await coll.findOneAndUpdate(
            { _id: env._id, owner: env.owner, rev: env.rev },
            { $set: { owner: me, released: false, releasedAt: null, releaseKind: null, adoptedBy: me, adoptedAt: at, adoptAttempts: attempts, rev: env.rev + 1, updatedAt: at } },
            { returnDocument: 'after' }
        );
        if (claimed) heldTombstones.set(env._id, claimed);
        return claimed || null;
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
        if (v.act === 'pending' || (v.act === 'tournament' && v.inner.act === 'pending')) return Promise.resolve({ state: 'pending', act: v.act });
        if (stopping()) return Promise.resolve({ state: 'pending' });
        const op = (async () => {
            if (v.act === 'tournament') return tournamentTable(env, v.inner, instances);
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

    // ---------- tournaments (PR 6) ----------

    const gameHere = (gameId) => {
        try {
            const g = require('../GameManager').games.get(gameId);
            return g && !g.isTerminal?.() && !g.frozen ? g : null;
        } catch {
            return null;
        }
    };

    /**
     * A tournament table's doc, by its own verdict `inner`, when the game
     * sweep or resolve() meets it: with its tournament live here it joins
     * it; else the tournament is adopted first (which handles its tables);
     * with no doc of its tournament anywhere it goes (a tombstone's record
     * still inserted).
     */
    async function tournamentTable(env, inner, instances) {
        const tid = env.tournamentId;
        // Its tournament's adoption in flight handles it
        if (adoptingT.has(tid)) {
            await adoptingT.get(tid);
            const g = gameHere(env._id);
            if (g) return { state: 'adopted', game: g };
        }
        const t = findTournament(tid);
        if (!t) {
            const tcoll = collections().liveTournaments;
            if (!tcoll) return { state: 'pending' };
            const tenv = await tcoll.findOne({ _id: tid }, { projection: TOURNAMENT_ENVELOPE_PROJECTION });
            if (!tenv) {
                if (inner.act === 'tombstone') return adoptTombstone(env, inner.attempts);
                if (inner.act === 'discard') return (await discard(env, inner.why)) ? { state: 'gone' } : { state: 'lost' };
                return (await discard(env, 'no tournament')) ? { state: 'gone' } : { state: 'lost' };
            }
            if (tenv.owner === me) return { state: 'pending' };
            await handleTournament(tenv, instances);
            const g = gameHere(env._id);
            if (g) return { state: 'adopted', game: g };
            return findTournament(tid) ? { state: 'gone' } : { state: 'pending' };
        }
        // Its tournament is live here: the table joins it (it was pending then)
        const round = t.roundOfGame(env._id);
        const open = !!round && !round.completedGames.has(env._id);
        if (inner.act === 'discard') return (await discard(env, inner.why)) ? { state: 'gone' } : { state: 'lost' };
        if (inner.act === 'tombstone') {
            const claimed = await claimTombstone(env, inner.attempts);
            if (!claimed) return { state: 'lost' };
            notify(env._id, null);
            // A handoff began: held (released with the tournament), never scored here
            if (stopping()) return { state: 'pending' };
            if (open) {
                try {
                    await scoreLateTable(getIo(), t, env._id, claimed.ended || {});
                } catch (err) {
                    logFailure('tournament table score', null, err, { gameId: env._id });
                }
            }
            await finishTombstone(claimed);
            return { state: 'gone' };
        }
        if (!open) return (await discard(env, 'scored')) ? { state: 'gone' } : { state: 'lost' };
        return adoptLive(env, inner.attempts, { tableAbandonMs: tournamentAbandonMs });
    }

    /** Delete another owner's tournament doc (CAS on owner and rev), then clear its members' pointers. */
    async function discardTournament(tenv, why) {
        const coll = collections().liveTournaments;
        if (!coll) return false;
        const res = await coll.deleteOne({ _id: tenv._id, owner: tenv.owner, rev: tenv.rev });
        if (!res || !res.deletedCount) return false;
        logger.info('Live tournament doc discarded', { tournamentId: tenv._id, rev: tenv.rev, why });
        await Promise.all(tournamentMembers(tenv).map(async (u) => {
            try {
                await clearTournamentPointer(u, tenv._id);
            } catch (err) {
                logFailure('pointer clear', null, err, { tournamentId: tenv._id });
            }
        }));
        notify(tenv._id, null);
        return true;
    }

    /** One users.find over a tournament's members and chat senders. */
    async function screenTournament(doc) {
        const members = tournamentMembers(doc);
        const senders = new Set();
        for (const m of doc?.state?.messages || []) if (m && typeof m.username === 'string' && m.username && !isBotName(m.username)) senders.add(m.username);
        const names = [...new Set([...members, ...senders])];
        const removed = new Set();
        const scrubbed = new Set();
        if (names.length === 0) return { removed, scrubbed };
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
            if (members.includes(name) && (deleted || merged)) removed.add(name);
            if (senders.has(name) && deleted) scrubbed.add(name);
        }
        return { removed, scrubbed };
    }

    /** Adopt a tournament doc and its tables (verdict 'adopt'). */
    async function adoptTournamentDoc(tenv, attempts, instances) {
        const tcoll = collections().liveTournaments;
        const gcoll = collections().liveGames;
        if (!tcoll || !gcoll) return { state: 'pending' };
        // Its tables first: one a live owner still holds keeps it waiting
        const tables = await gcoll.find({ tournamentId: tenv._id }, { projection: ENVELOPE_PROJECTION }).toArray();
        const verdicts = new Map();
        for (const env of tables) {
            if (env.owner === me) continue;
            const v = verdict(env, instances, { inTournament: true });
            if (v.act === 'pending') return { state: 'pending' };
            verdicts.set(env._id, { env, v });
        }
        const full = await tcoll.findOne({ _id: tenv._id, owner: tenv.owner, rev: tenv.rev });
        if (!full) return { state: 'lost' };
        const { removed, scrubbed } = await screenTournament(full);
        if (stopping()) return { state: 'pending' };
        const at = new Date(now());
        const claimed = await tcoll.findOneAndUpdate(
            { _id: tenv._id, owner: tenv.owner, rev: tenv.rev },
            {
                $set: {
                    owner: me, ownerMode: 'on', released: false, releasedAt: null, releaseKind: null,
                    adoptedBy: me, adoptedAt: at, adoptAttempts: attempts, rev: tenv.rev + 1, updatedAt: at
                }
            },
            { returnDocument: 'after' }
        );
        if (!claimed) return { state: 'lost' };
        if (isClosed()) {
            // A handoff froze this process meanwhile: straight back, released
            try {
                await tcoll.updateOne({ _id: tenv._id, owner: me, rev: claimed.rev }, { $set: { released: true, releasedAt: new Date(now()), releaseKind: 'handoff' } });
            } catch (err) {
                logFailure('adopt give-back', null, err, { tournamentId: tenv._id });
            }
            return { state: 'pending' };
        }
        const io = getIo();
        let adopted;
        try {
            adopted = adoptTournament(io, { ...full, ...claimed, tournamentId: tenv._id }, { now: now(), removed: [...removed], scrubFrom: [...scrubbed] });
        } catch (err) {
            logFailure('adopt', null, err, { tournamentId: tenv._id, why: err?.reason || err?.name || 'error' });
            try {
                const res = await tcoll.deleteOne({ _id: tenv._id, owner: me });
                if (res?.deletedCount) {
                    await Promise.all(tournamentMembers(full).map((u) => Promise.resolve(clearTournamentPointer(u, tenv._id)).catch(() => {})));
                }
            } catch (e) {
                logFailure('adopt discard', null, e, { tournamentId: tenv._id });
            }
            notify(tenv._id, null);
            return { state: 'gone' };
        }
        const t = adopted.tournament;
        trackAdoptedTournament(t, claimed);
        adoptedCount++;
        logger.info('Live tournament adopted', { tournamentId: tenv._id, rev: claimed.rev, from: String(tenv.owner).slice(0, 8), attempts, tables: verdicts.size });
        // Its tables, each by its own verdict. `unsettled`: a table whose doc
        // this adoption did not finish (still adoptable: never scored here)
        const kept = new Set();
        const unsettled = new Set();
        const ended = new Map();
        const claimedTombstones = [];
        for (const { env, v } of verdicts.values()) {
            if (stopping()) break;
            try {
                if (v.act === 'discard') {
                    await discard(env, v.why);
                } else if (v.act === 'tombstone') {
                    const tb = await claimTombstone(env, v.attempts);
                    if (tb) {
                        ended.set(env._id, tb.ended || {});
                        claimedTombstones.push(tb);
                        notify(env._id, null);
                    } else {
                        unsettled.add(env._id);
                    }
                } else {
                    const round = t.roundOfGame(env._id);
                    if (!round || round.completedGames.has(env._id)) {
                        await discard(env, 'scored');
                        continue;
                    }
                    const r = await adoptLive(env, v.attempts, { tableAbandonMs: tournamentAbandonMs });
                    if (r.state === 'adopted' && r.game) kept.add(env._id);
                    else if (r.state === 'pending' || r.state === 'lost') unsettled.add(env._id);
                }
            } catch (err) {
                unsettled.add(env._id);
                logFailure('adopt', null, err, { gameId: env._id });
            }
        }
        // Stopping (a handoff serializes it as it is), or no longer this
        // process's live tournament: nothing is scored or rolled back here
        const ours = !stopping() && !t.frozen && !t.retired && findTournament(tenv._id) === t;
        if (ours) {
            try {
                await normalizeRound(io, t, { tableScores: adopted.tableScores || {}, kept, pending: unsettled, ended });
            } catch (err) {
                logFailure('tournament normalize', null, err, { tournamentId: tenv._id });
            }
        }
        // Held when stopping: the handoff releases this process's tombstones
        for (const tb of stopping() ? [] : claimedTombstones) {
            try {
                await finishTombstone(tb);
            } catch (err) {
                logFailure('tombstone record', null, err, { gameId: tb._id });
            }
        }
        notify(tenv._id, t);
        return { state: 'adopted', tournament: t };
    }

    /** The one op for a tournament doc (single flight per id), by its verdict. */
    function handleTournament(tenv, instances) {
        const id = tenv._id;
        if (adoptingT.has(id)) return adoptingT.get(id);
        const v = verdict(tenv, instances, { readVersions: tournamentReadVersions });
        if (v.act === 'pending') return Promise.resolve({ state: 'pending' });
        if (stopping()) return Promise.resolve({ state: 'pending' });
        const op = (async () => {
            if (v.act === 'discard') return (await discardTournament(tenv, v.why)) ? { state: 'gone' } : { state: 'lost' };
            return adoptTournamentDoc(tenv, v.attempts, instances);
        })().catch((err) => {
            logFailure('adopt', null, err, { tournamentId: id });
            return { state: 'pending' };
        }).finally(() => {
            if (adoptingT.get(id) === op) adoptingT.delete(id);
        });
        adoptingT.set(id, op);
        return op;
    }

    /** resolve() for a tournament (liveStore.resolveTournament's 'on' path). */
    async function resolveTournament(tid, { waitMs, inMemory, whenDbReady }) {
        const bound = (p) => Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => {
            const t = safeTimeout(() => r(null), waitMs, 'adopt:resolveWait');
            t.unref?.();
        })]);
        await bound(whenDbReady(waitMs));
        await bound(bootSweptPromise);
        const here = inMemory();
        if (here) return { state: 'memory', tournament: here };
        if (isShuttingDown()) return { state: 'pending' };
        if (adoptingT.has(tid)) {
            const r = await adoptingT.get(tid);
            const t = inMemory();
            if (t) return { state: r?.state === 'adopted' ? 'adopted' : 'memory', tournament: t };
        }
        const tcoll = collections().liveTournaments;
        if (!tcoll) return { state: 'pending' };
        const tenv = await tcoll.findOne({ _id: tid }, { projection: TOURNAMENT_ENVELOPE_PROJECTION });
        const instances = await readInstances();
        if (tenv) {
            if (tenv.owner === me) {
                if (holdsTournamentLocally(tid)) return { state: 'pending' };
                // An own doc nothing here holds (a failed adoption's): it goes
                try {
                    await tcoll.deleteOne({ _id: tid, owner: me });
                } catch (err) {
                    logFailure('adopt discard', null, err, { tournamentId: tid });
                    return { state: 'pending' };
                }
                return { state: 'gone' };
            }
            const r = await handleTournament(tenv, instances);
            const t = inMemory();
            if (t) return { state: 'adopted', tournament: t };
            if (r.state === 'gone') return { state: 'gone' };
            return { state: 'pending' };
        }
        const myStart = ms(startedAt());
        for (const [id, inst] of instances) {
            if (id === me) continue;
            if (ownerState(id, instances) === 'dead') continue;
            if (Array.isArray(inst.tournamentIds) && inst.tournamentIds.includes(tid)) return { state: 'pending' };
            if (inst.mode === 'on' && myStart !== null && ms(inst.startedAt) !== null && ms(inst.startedAt) < myStart) return { state: 'pending' };
        }
        return { state: 'gone' };
    }

    // ---------- the sweep ----------

    async function sweepOnce() {
        if (stopping()) return null;
        const coll = collections().liveGames;
        if (!coll) return null;
        const instances = await readInstances();
        let adopted = 0;
        // Tournaments first (PR 6): each adopts its tables with it
        const tcoll = collections().liveTournaments;
        const tdocs = tcoll ? await tcoll.find({ owner: { $ne: me } }, { projection: TOURNAMENT_ENVELOPE_PROJECTION }).toArray() : [];
        for (const tenv of tdocs) {
            if (stopping()) break;
            const r = await handleTournament(tenv, instances);
            if (r && r.state === 'adopted') adopted++;
        }
        const docs = await coll.find({ owner: { $ne: me } }, { projection: ENVELOPE_PROJECTION }).toArray();
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
        for (const [gameId, owners] of [...orphans]) {
            if (stopping()) break;
            await removeOrphan(gameId, owners);
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
                // Ours but not live here: a tombstone being finished
                if (env.kind === 'ended') return { state: 'gone' };
                // ... or a game the store still holds (a terminal claim
                // pending: it ends the doc itself), or one being adopted
                // right now (its claim landed, the hydrate not run yet)
                if (adopting.has(gameId)) return { state: 'pending' };
                if (!orphans.has(gameId) && holdsLocally(gameId)) return { state: 'pending' };
                // ... or nothing here holds it (a claimed doc that failed to
                // hydrate, a doc a failed claim left): an orphan nobody will
                // ever run. It goes; never 'pending' for good
                await removeOrphan(gameId, seatOwners(env));
                return { state: 'gone' };
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
        inFlight: () => [...adopting.values(), ...adoptingT.values()],
        /** Ids with an adopt / discard / tombstone op not settled yet (the handoff's deletes skip them). */
        inFlightIds: () => [...adopting.keys()],
        /** Tournament ids with an adopt / discard op not settled yet (PR 6). */
        inFlightTournamentIds: () => [...adoptingT.keys()],
        resolveTournament,
        liveness,
        readInstances,
        get bootSwept() { return bootSwept; },
        get lastSweepAt() { return lastSweepAt; },
        get adoptedCount() { return adoptedCount; },
        _heldTombstones: heldTombstones,
        _orphans: orphans
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
    ENVELOPE_PROJECTION,
    TOURNAMENT_ENVELOPE_PROJECTION
};
