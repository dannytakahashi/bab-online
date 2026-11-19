/**
 * Test harness for deploy survival (persist + resume; the plan's PRs 3-6).
 * Nothing in production reads or writes live state yet: these are the
 * pieces the codec, store, handoff and adoption tests build on.
 *
 *   makeRng(seed)          mulberry32 (gameDriver's stream) whose state can
 *                          be read and set, so a fork resumes the same stream
 *   fixedBotDelays(d)      BotPlayer.getActionDelay returns fixed values and
 *                          draws no Math.random
 *   silenceBotChat()       BotController.sendBotChat does nothing (no RNG,
 *                          no timer)
 *   decisionLog()          every bot draw / bid / card decision, in order
 *   liveDb(seed)           a memoryDb (with the server's unique indexes)
 *                          plus liveGames, liveTournaments and
 *                          serverInstances, fault injection (stall, fail,
 *                          lost reply, abandon; all or per instance) on
 *                          every collection, and per-instance connections
 *                          (db.connect(inst)) that go dead with the instance
 *   databaseMock(holder)   getters for jest.mock('../database') over
 *                          holder.current (a liveDb or a connection)
 *   flushStore(store)      pump immediates and microtasks until a store has
 *                          nothing pending (store.pending())
 *   authoritative(game)    the game's authoritative state keyed by position
 *                          (no human socket ids), for equality across a restart
 *   createMonoClock()      a per-instance monotonic clock (jump, freeze)
 *   killInstance(inst)     the process dies: its io, db connection, timers,
 *                          retries and every process-scoped module reset
 *   createPersistHarness() one "process" at a time: restart({kind})
 *                          (handoff | kill | throw | mongo-stall); a deploy's
 *                          successor is announced before the old one hands off
 *   twoInstances()         two live "processes" at once (the deploy
 *                          overlap) over one db: own ids, clocks and
 *                          connections; B's server modules isolated, with a
 *                          Jest limit on lazy requires (see twoInstances)
 *
 * Every server module is required lazily (inside the functions), so a test
 * can call databaseMock from its jest.mock factory and twoInstances can
 * load a second set of singletons. The persist store
 * (game/persist/liveStore.js) is the process's own: becomeCurrent gives
 * each instance a fresh one with its bootId, and a kill closes it. Handoff
 * and adoption do not exist yet: restart and twoInstances take them as
 * hooks.
 *
 * ONE Jest process plays every "process" here, so a kill is not a SIGKILL:
 * killInstance cuts what it can reach (see there), and what it cannot
 * (an awaited continuation already scheduled that checks no epoch and
 * fetches a collection afresh) is listed in its doc.
 *
 * Fake timers: flushStore and restart work with Jest's modern fake timers
 * or real ones; 'mongo-stall' needs fake timers (it advances the clock).
 */

'use strict';

const { randomUUID } = require('crypto');
const { MemoryCollection, createMemoryDb } = require('./memoryDb');

// ---------- RNG ----------

/**
 * mulberry32 with visible state: next() gives exactly the stream of
 * gameDriver.mulberry32(seed). getState/setState let a fork continue the
 * stream where the original was; install() puts it in Math.random and
 * returns the function that puts the previous one back.
 */
function makeRng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        getState: () => a,
        setState: (s) => { a = s >>> 0; },
        install() {
            const previous = Math.random;
            Math.random = next;
            return () => { Math.random = previous; };
        },
    };
}

// ---------- server modules ----------

/**
 * The server singletons and handlers an instance runs on. Called inside
 * jest.isolateModules for a second instance, so it requires lazily.
 */
function loadServerModules() {
    const bot = require('../game/bot');
    return {
        gameManager: require('../game/GameManager'),
        botController: bot.botController,
        BotPlayer: require('../game/bot/BotPlayer'),
        GamePhase: require('../game/GamePhase'),
        gameHandlers: require('../socket/gameHandlers'),
        gameLifecycle: require('../socket/gameLifecycle'),
        reconnectHandlers: require('../socket/reconnectHandlers'),
        queueHandlers: require('../socket/queueHandlers'),
        chatHandlers: require('../socket/chatHandlers'),
        mainRoomHandlers: require('../socket/mainRoomHandlers'),
        lobbyHandlers: require('../socket/lobbyHandlers'),
        tournamentHandlers: require('../socket/tournamentHandlers'),
        profileHandlers: require('../socket/profileHandlers'),
        sessionIdentity: require('../socket/sessionIdentity'),
        shutdown: require('../utils/shutdown'),
        connectionStats: require('../utils/connectionStats'),
        livePersistSwitch: require('../utils/livePersistSwitch'),
        liveStore: require('../game/persist/liveStore'),
        gameVoice: require('../voice/gameVoice'),
        logger: require('../utils/logger'),
    };
}

// ---------- bot determinism ----------

/**
 * BotPlayer.getActionDelay returns a fixed delay and draws no Math.random
 * (the real one draws exactly one per call), so a run's RNG stream no
 * longer depends on when bots act. `delays`: a number for every action, or
 * {draw, bid, play, chat} (missing kinds: 1000 ms), or fn(actionType, opts).
 * Returns the Jest spy (mockRestore() undoes it; restoreAllMocks too).
 */
function fixedBotDelays(delays = 1000, { BotPlayer = require('../game/bot/BotPlayer') } = {}) {
    const pickDelay = typeof delays === 'function' ? delays
        : typeof delays === 'number' ? () => delays
            : (type) => (delays[type] ?? 1000);
    return jest.spyOn(BotPlayer.prototype, 'getActionDelay').mockImplementation(function (type, opts) {
        return pickDelay(type, opts);
    });
}

/**
 * Bot chat off: sendBotChat (the one place a quip draws Math.random and
 * sets a timer) does nothing. Trump and hand-end reactions still run their
 * checks, which draw nothing. Returns the Jest spy.
 */
function silenceBotChat({ botController = require('../game/bot').botController } = {}) {
    return jest.spyOn(botController, 'sendBotChat').mockImplementation(() => {});
}

/**
 * Record every bot decision (decideDraw, decideBid, decideCard) in call
 * order: {kind: 'draw'|'bid'|'play', gameId, position, username, value}.
 * The decisions themselves are the real ones. stop() puts the methods back.
 */
function decisionLog({ BotPlayer = require('../game/bot/BotPlayer') } = {}) {
    const entries = [];
    const proto = BotPlayer.prototype;
    const originals = { decideDraw: proto.decideDraw, decideBid: proto.decideBid, decideCard: proto.decideCard };
    const kinds = { decideDraw: 'draw', decideBid: 'bid', decideCard: 'play' };
    for (const [method, original] of Object.entries(originals)) {
        proto[method] = function (...args) {
            const value = original.apply(this, args);
            entries.push({
                kind: kinds[method],
                gameId: this.gameId ?? null,
                position: this.position ?? null,
                username: this.username,
                value: value && typeof value === 'object' ? { ...value } : value,
            });
            return value;
        };
    }
    return {
        entries,
        stop() {
            for (const [method, original] of Object.entries(originals)) proto[method] = original;
        },
    };
}

// ---------- database ----------

const LIVE_COLLECTIONS = ['liveGames', 'liveTournaments', 'serverInstances'];
const FAULT_METHODS = ['insertOne', 'findOne', 'countDocuments', 'updateOne', 'updateMany',
    'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany'];

function networkError(name, op) {
    const err = new Error(`memoryDb fault: connection lost (${name}.${op})`);
    err.name = 'MongoNetworkError';
    return err;
}

/** A promise that never settles: the reply of a process that is gone. */
const never = () => new Promise(() => {});

/**
 * Fault injection over a set of MemoryCollections. Rules match by
 * collection name, operation and instance (the connection's owner name;
 * null = all, and an op on the shared db, outside any connection, has no
 * instance) and are checked newest first:
 *   stall({collections, ops, instances})
 *                               the op waits until release() (then runs:
 *                               a stalled write still applies, late) or
 *                               abandon() (it never runs, never settles)
 *   fail({collections, ops, instances, times, lostReply})
 *                               the op rejects with a MongoNetworkError;
 *                               lostReply: it applies first, then rejects
 *                               (the ambiguous outcome). `times` (default
 *                               every call) counts matching calls.
 * Every call is recorded in `calls` ({collection, op, outcome}, plus
 * `instance` for an op through a connection).
 */
function createFaults() {
    const rules = [];
    const calls = [];
    let gate = null;
    let openGate = null;
    const stalled = new Set();

    const matching = (name, op, who) => rules.find((r) => (r.collections === null || r.collections.has(name))
        && (r.ops === null || r.ops.has(op))
        && (r.instances === null || (who != null && r.instances.has(who)))
        && r.remaining > 0);
    const asSet = (list) => (list ? new Set([].concat(list)) : null);
    const record = (name, op, who, outcome) => calls.push({ collection: name, op, ...(who != null && { instance: who }), outcome });

    const faults = {
        calls,
        stall({ collections = null, ops = null, instances = null } = {}) {
            if (!gate) gate = new Promise((resolve) => { openGate = resolve; });
            rules.unshift({ mode: 'stall', collections: asSet(collections), ops: asSet(ops), instances: asSet(instances), remaining: Infinity });
            return () => faults.release();
        },
        fail({ collections = null, ops = null, instances = null, times = Infinity, lostReply = false } = {}) {
            rules.unshift({
                mode: lostReply ? 'lostReply' : 'fail',
                collections: asSet(collections), ops: asSet(ops), instances: asSet(instances), remaining: times,
            });
        },
        /** Lift every stall; stalled ops go on (in the order they arrived). */
        release() {
            for (let i = rules.length - 1; i >= 0; i--) if (rules[i].mode === 'stall') rules.splice(i, 1);
            if (openGate) openGate();
            gate = null;
            openGate = null;
        },
        /**
         * The ops stalled right now (all, or those of `instances`) are
         * dropped: they never apply and their promises never settle, as an
         * op a SIGKILLed process never sent. Their continuations never run.
         * The stall rules stay (release() lifts them for later ops).
         * @returns {number} ops abandoned
         */
        abandon({ instances = null } = {}) {
            const only = asSet(instances);
            let n = 0;
            for (const token of [...stalled]) {
                if (only && !(token.who != null && only.has(token.who))) continue;
                token.abandoned = true;
                stalled.delete(token);
                record(token.name, token.op, token.who, 'abandoned');
                n++;
            }
            return n;
        },
        /** Drop every rule (stalls released). */
        clear() {
            faults.release();
            rules.length = 0;
        },
        /** Ops waiting on a stall right now. */
        stalledCount: () => stalled.size,
        async _run(name, op, fn, who = null) {
            const rule = matching(name, op, who);
            if (!rule) {
                record(name, op, who, 'ok');
                return fn();
            }
            if (rule.mode === 'stall') {
                const token = { name, op, who, abandoned: false };
                stalled.add(token);
                record(name, op, who, 'stalled');
                await gate;
                stalled.delete(token);
                if (token.abandoned) return never();
                return faults._run(name, op, fn, who);
            }
            rule.remaining--;
            if (rule.mode === 'fail') {
                record(name, op, who, 'failed');
                throw networkError(name, op);
            }
            await fn();
            record(name, op, who, 'lostReply');
            throw networkError(name, op);
        },
    };
    return faults;
}

/**
 * Route a collection's async operations (and find().toArray) through
 * `faults`. Returns the unwrapped operations (for connections).
 */
function withFaults(name, coll, faults) {
    const raw = {};
    for (const method of FAULT_METHODS) {
        const original = coll[method].bind(coll);
        raw[method] = original;
        coll[method] = (...args) => faults._run(name, method, () => original(...args));
    }
    const find = coll.find.bind(coll);
    raw.find = find;
    coll.find = (...args) => {
        const cursor = find(...args);
        const toArray = cursor.toArray.bind(cursor);
        cursor.toArray = () => faults._run(name, 'find', toArray);
        return cursor;
    };
    return raw;
}

/**
 * One collection as `owner` (an instance) sees it: the same documents,
 * every async op through `faults` tagged with owner.name. Once owner.dead,
 * an op is not run: it is recorded in owner.deadDbOps and never settles
 * (the process is gone; nothing it sends arrives).
 */
function connectionView(name, coll, raw, faults, owner) {
    const view = Object.create(coll);
    const run = (op, fn) => {
        if (owner.dead) {
            if (Array.isArray(owner.deadDbOps)) owner.deadDbOps.push({ collection: name, op });
            return never();
        }
        return faults._run(name, op, fn, owner.name);
    };
    for (const method of FAULT_METHODS) view[method] = (...args) => run(method, () => raw[method](...args));
    view.find = (...args) => {
        const cursor = raw.find(...args);
        const toArray = cursor.toArray.bind(cursor);
        cursor.toArray = () => run('find', toArray);
        return cursor;
    };
    // Index state lives on the shared collection (never shadowed on the view)
    view.createIndex = (...args) => coll.createIndex(...args);
    return view;
}

/**
 * A memoryDb (users, gameRecords, reports, passwordResets, adminAudit; the
 * unique users.username and gameRecords.gameId indexes included) plus the
 * three deploy-survival collections, each seeded from `seed[name]`, with
 * (non-enumerable):
 *   faults         createFaults over all of them
 *   connect(owner) a connection: every collection as `owner` ({name, dead,
 *                  deadDbOps}: an instance) sees it (connectionView), with
 *                  the same faults, connect and `base` (this db). Hand it
 *                  to databaseMock's holder (createPersistHarness does, with
 *                  `holder`) and to a DI'd store, so a dead instance's
 *                  writes stop while its successor's go on.
 */
function liveDb(seed = {}) {
    const db = createMemoryDb(seed);
    for (const name of LIVE_COLLECTIONS) db[name] = new MemoryCollection(seed[name] || []);
    const faults = createFaults();
    const raw = new Map();
    for (const [name, coll] of Object.entries(db)) raw.set(name, withFaults(name, coll, faults));
    const connect = (owner) => {
        if (!owner || typeof owner.name !== 'string') throw new Error('connect(owner): an instance ({name, dead})');
        const conn = {};
        for (const [name, coll] of Object.entries(db)) conn[name] = connectionView(name, coll, raw.get(name), faults, owner);
        Object.defineProperties(conn, {
            faults: { value: faults, enumerable: false },
            connect: { value: connect, enumerable: false },
            base: { value: db, enumerable: false },
            owner: { value: owner, enumerable: false },
        });
        return conn;
    };
    Object.defineProperties(db, {
        faults: { value: faults, enumerable: false },
        connect: { value: connect, enumerable: false },
    });
    return db;
}

/**
 * The database getters over `holder.current` (set it to a liveDb in
 * beforeEach; createPersistHarness({holder}) then points it at the current
 * instance's connection). For a jest.mock factory, which may only reach
 * variables named mock*:
 *   const mockDb = { current: null };
 *   jest.mock('../../database', () => require('../../testUtils/persistHarness').databaseMock(mockDb));
 * The live-state getters use the names server/database.js will export
 * (deploy survival PR 4).
 */
function databaseMock(holder) {
    const coll = (name) => () => holder.current?.[name];
    return {
        getUsersCollection: coll('users'),
        getGameRecordsCollection: coll('gameRecords'),
        getReportsCollection: coll('reports'),
        getPasswordResetsCollection: coll('passwordResets'),
        getAdminAuditCollection: coll('adminAudit'),
        getLiveGamesCollection: coll('liveGames'),
        getLiveTournamentsCollection: coll('liveTournaments'),
        getServerInstancesCollection: coll('serverInstances'),
        getDB: () => null,
        getDbState: () => (holder.current ? 'connected' : 'disconnected'),
        whenReady: () => Promise.resolve(),
    };
}

// ---------- timing ----------

/** True while Jest's modern fake timers are installed. */
function fakeTimersOn() {
    return typeof setTimeout.clock === 'object' && setTimeout.clock !== null;
}

/** One turn of the event loop: due immediates and zero-delay timers, then microtasks. */
async function pump() {
    if (fakeTimersOn()) await jest.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Let a store's coalesced writes run: pump until store.pending() is 0 (two
 * turns in a row: a write that lands may mark the next one), at most
 * `rounds` turns. A store without pending() gets three turns. Throws if it
 * is still busy (a stalled db: release it first).
 *
 * Fake timers: a zero-delay timer (a setImmediate) made while the fake
 * clock is ticking is due 1 ms later (@sinonjs/fake-timers adds 1 ms
 * "duringTick"), so a store whose write was marked from a timer callback
 * or a write's continuation is not reached by advancing 0. While the
 * store reports a pending immediate (store.pendingImmediates()), a turn
 * advances the clock 1 ms instead.
 * @returns {Promise<number>} turns used
 */
async function flushStore(store, { rounds = 50 } = {}) {
    if (!store || typeof store.pending !== 'function') {
        for (let i = 0; i < 3; i++) await pump();
        return 3;
    }
    const immediates = () => (typeof store.pendingImmediates === 'function' ? store.pendingImmediates() : 0);
    let idle = 0;
    for (let i = 1; i <= rounds; i++) {
        if (fakeTimersOn() && immediates() > 0) await jest.advanceTimersByTimeAsync(1);
        else await pump();
        idle = store.pending() === 0 ? idle + 1 : 0;
        if (idle >= 2) return i;
    }
    throw new Error(`flushStore: still ${store.pending()} pending after ${rounds} turns`);
}

/**
 * A monotonic clock for one instance: milliseconds since it was made, from
 * `source` (Date.now, which Jest's fake timers drive), plus any jump().
 * freeze() stops it where it is until thaw() (a stopped clock, e.g. a
 * suspended VM; a frozen PROCESS still sees time pass, so use jump or the
 * shared timers for that). Each instance gets its own, so liveness is
 * judged on the observer's clock, never by comparing two.
 */
function createMonoClock({ source = () => Date.now(), offset = 0 } = {}) {
    const origin = source();
    let jumped = offset;
    let frozenAt = null;
    let stoppedFor = 0;
    let stoppedSince = null;
    const raw = () => source() - origin + jumped - stoppedFor;
    return {
        now: () => (frozenAt !== null ? frozenAt : raw()),
        jump(ms) {
            if (ms < 0) throw new Error('a monotonic clock never goes back');
            jumped += ms;
            if (frozenAt !== null) frozenAt += ms;
        },
        freeze() {
            if (frozenAt !== null) return;
            frozenAt = raw();
            stoppedSince = source();
        },
        thaw() {
            if (frozenAt === null) return;
            stoppedFor += source() - stoppedSince;
            frozenAt = null;
            stoppedSince = null;
        },
        get frozen() { return frozenAt !== null; },
    };
}

// ---------- authoritative state ----------

const json = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/**
 * What must survive a restart, keyed by position: every field the plan's
 * game codec saves that changes behaviour (2.2 "Saved"): stage, dealSeq
 * (stale-deal guard, the snapshot's `deal`), deal and bidding state, the
 * table, the score and stats, every hand, the /help counters per position
 * (game.assist: uses, the user they belong to, lastHelpKey); per seat its controller, owner
 * (username, ownerPic as stored), gone, lastPersonality (the bot a /lazy
 * seat gets), resignedAt and leftAt, and its bot (socketId: persisted and
 * restored as is; username, pic, personality, and the registered
 * BotPlayer's partnerHistory, which feeds the adaptive bid style).
 *
 * Not compared (derived, reset or re-made by design): human socket ids
 * (a restored seat's are synthetic), timers, epoch, eventSeq / seq, resume,
 * presence (opt in), grace deadlines and absentSince, the draw, entrants,
 * deck, offers, AFK clock, spectators, avatar versions, a bot's card
 * memory (rebuilt from trickHistory: compare it with the bots' own
 * getMemorySnapshot if a test needs it) and the log (opt in). Two games
 * are the same game for the restore oracles iff these are deep-equal.
 * @param {GameState} game
 * @param {{presence?: boolean, log?: boolean, gameManager?: Object, botController?: Object}} [opts]
 *   presence: add each seat's presence; log: add the game log's texts;
 *   gameManager: add the game's tournamentId from its tournamentGames;
 *   botController: where the seat bots are registered (default: this
 *   test's; a bot not registered there has partnerHistory null)
 */
function authoritative(game, { presence = false, log = false, gameManager = null, botController = null } = {}) {
    const bots = botController || require('../game/bot').botController;
    const hands = {};
    const seats = {};
    for (const pos of [1, 2, 3, 4]) {
        const sid = game.positions?.[pos];
        hands[pos] = sid && game.hands[sid] ? json(game.hands[sid]) : null;
        const s = game.seats?.[pos];
        const botPlayer = s?.bot ? bots.getBot(game.gameId, s.bot.socketId) : null;
        seats[pos] = s ? {
            controller: s.controller,
            ownerUsername: s.ownerUsername ?? null,
            ownerPic: json(s.ownerPic ?? null),
            gone: s.presence === 'gone',
            lastPersonality: s.lastPersonality ?? null,
            resignedAt: s.resignedAt ?? null,
            leftAt: s.leftAt ?? null,
            bot: s.bot ? {
                socketId: s.bot.socketId ?? null,
                username: s.bot.username ?? null,
                pic: json(s.bot.pic ?? null),
                personality: s.bot.personality ?? null,
                partnerHistory: botPlayer ? json(botPlayer.partnerHistory) : null,
            } : null,
            ...(presence && { presence: s.presence }),
        } : null;
    }
    const out = {
        gameId: game.gameId,
        stage: game.stage,
        dealSeq: game.dealSeq ?? null,
        currentHand: game.currentHand,
        dealer: game.dealer,
        bidder: game.bidder,
        bids: json(game.bids),
        playerBids: json(game.playerBids),
        team1Mult: game.team1Mult,
        team2Mult: game.team2Mult,
        currentTurn: game.currentTurn,
        leadPosition: game.leadPosition,
        leadCard: json(game.leadCard),
        playedCards: [0, 1, 2, 3].map((i) => json(game.playedCards[i] ?? null)),
        playedCardsIndex: game.playedCardsIndex,
        trump: json(game.trump),
        isTrumpBroken: game.isTrumpBroken,
        cardIndex: game.cardIndex,
        tricks: json(game.tricks),
        trickHistory: json(game.trickHistory),
        score: json(game.score),
        rainbows: json(game.rainbows),
        handStats: json(game.handStats),
        playerStats: json(game.playerStats),
        handTricks: json(game.handTricks),
        hsiValues: json(game.hsiValues),
        assist: json(game.assist),
        hands,
        seats,
    };
    if (gameManager) out.tournamentId = gameManager.tournamentGames.get(game.gameId) ?? null;
    if (log) out.log = (game.gameLog || []).map((e) => e.message ?? e.text ?? e);
    return out;
}

// ---------- instances ----------

const RESTART_KINDS = ['handoff', 'kill', 'throw', 'mongo-stall'];

/**
 * One server "process": its own ids, monotonic clock, recording io, the
 * server modules it runs on and, with `db` (a liveDb), its own connection
 * `inst.db` (db.connect(inst)). Once `dead`, anything its io or sockets
 * emit goes to `afterDeath` instead of `log` (the "no emit from a dead io"
 * oracle: it must stay empty), and any op through its connection is
 * dropped into `deadDbOps` (never applied, never settled). `mode` is the
 * LIVE_PERSIST mode it boots with (null: whatever the environment says).
 */
function createInstance({ name = 'instance', mods, db = null, mode = null, bootId = randomUUID(),
    deploymentId = randomUUID(), startedAt = Date.now(), clock = createMonoClock() } = {}) {
    const { makeIo, makeSocket } = require('./gameDriver');
    const log = [];
    const io = makeIo(log);
    const inst = {
        name, mods, mode, bootId, deploymentId, startedAt, clock, log, io,
        dead: false,
        afterDeath: [],
        deadDbOps: [],
        db: null,
        store: null,
        /** A stub socket on this instance (registered in its io). */
        socket: (id) => makeSocket(id, log, io),
    };
    if (db) inst.db = db.connect(inst);
    // After makeIo's contract instrumentation, so live emits are still checked
    const push = log.push;
    Object.defineProperty(log, 'push', {
        enumerable: false,
        configurable: true,
        writable: true,
        value(...items) {
            if (inst.dead) return inst.afterDeath.push(...items);
            return push.apply(this, items);
        },
    });
    return inst;
}

/**
 * Everything a process keeps in module memory, reset as a fresh process
 * would have it. Each entry runs on the dead instance's mods; a module a
 * test mocked without the reset function is skipped.
 */
const PROCESS_RESETS = [
    // Games and tournaments go stale (epoch bump: aliveCheck / isLive fail),
    // their timers and pauses cancelled, every map emptied
    ['gameManager', (m) => m._resetForTests()],
    // Every bot timer (bid / play / draw / chat), registrations, counters,
    // the "he sends a boy" cooldowns and quip roll
    ['botController', (m) => m._resetForTests()],
    // (The per-game voice state dies with the games above; play-again holds
    // and reservations are GameManager's lobbyGrace / lobby timers,
    // cancelled there. gameVoice keeps no module state since its SDP gate
    // went, 2026-11-18.)
    // shuttingDown, the drain deadline and in-flight set; pending retry
    // waits (profileHandlers' end-of-game backoff) never end, so a dead
    // process's write is never retried
    ['shutdown', (m) => m._resetShutdownStateForTests({ abandonRetries: true })],
    // The per-game end-of-game chains (a successor's recordGameStats must
    // not join a dead one) and the leaderboard / records caches
    ['profileHandlers', (m) => { m._resetStatsWritesForTests(); m._resetCachesForTests(); }],
    // The completed-tournament cleanup timers (they delete by id on the
    // shared GameManager)
    ['tournamentHandlers', (m) => m._resetCleanupTimersForTests()],
    // The "other device closed" notices
    ['sessionIdentity', (m) => m._resetOtherClosedTimers()],
    // The deploy timing counters and the cached LIVE_PERSIST reading
    ['connectionStats', (m) => m._resetForTests()],
    ['livePersistSwitch', (m) => m._resetForTests()],
    // The live persist store (closed: no write, heartbeat or hook of the
    // dead process runs again); the next one is made on first use
    ['liveStore', (m) => m._resetForTests()],
];

/**
 * The process dies (SIGKILL, OOM, or the end of a handoff / crash exit):
 *   - `dead`: its io and sockets emit into afterDeath; its db connection
 *     drops every later op (deadDbOps), including those of a continuation
 *     that captured a collection before the death;
 *   - with `abandonStalled`, its ops stalled right now never apply
 *     (faults.abandon); otherwise they apply if the test releases them, as
 *     a write already on the wire may;
 *   - every process-scoped module is reset (PROCESS_RESETS): game and
 *     tournament epochs bumped, every game / tournament / lobby-grace
 *     (play-again holds too) / play-again reservation / bot / retry /
 *     cleanup / notice timer cancelled, end-of-game chains, caches, bot
 *     quip cooldowns and voice counters forgotten, shuttingDown false,
 *     LIVE_PERSIST unread.
 *
 * Not reachable in one Jest process (a real SIGKILL would stop them): a
 * continuation already queued (a released stalled op's caller, a
 * microtask) still runs; if it checks no epoch and fetches a collection
 * afresh through the database getters, it reaches the CURRENT instance's
 * connection. Keep a dead instance's in-flight work stalled and abandon
 * it, or assert on deadDbOps, when that matters.
 */
function killInstance(inst, { abandonStalled = false } = {}) {
    inst.dead = true;
    if (abandonStalled && inst.db) inst.db.faults.abandon({ instances: inst.name });
    for (const [key, reset] of PROCESS_RESETS) {
        const mod = inst.mods?.[key];
        if (mod) reset(mod);
    }
}

/**
 * Point the process-scoped modules at `inst`: its connection, its
 * LIVE_PERSIST mode, and a fresh live persist store with its bootId (made
 * from that mode on first use).
 */
function becomeCurrent(inst, holder) {
    if (holder && inst.db) holder.current = inst.db;
    const lps = inst.mods?.livePersistSwitch;
    if (lps) {
        lps._resetForTests();
        if (inst.mode != null) lps.bootLivePersistMode({ LIVE_PERSIST: inst.mode }, { warn: () => {} });
    }
    inst.mods?.liveStore?._resetForTests({ bootId: inst.bootId });
}

/**
 * One server process at a time over `db` (the live state's only path
 * between processes). Every instance gets its own connection (inst.db);
 * with `holder` (the object handed to databaseMock), holder.current is the
 * current instance's connection, so the server singletons write through
 * it and stop writing when it dies. `mode` is every instance's
 * LIVE_PERSIST mode (restart({mode}) overrides it for the next one).
 *
 * `hooks` plug in what does not exist yet; each is async(instance, ctx)
 * with ctx = {kind, old, successor, harness} (what applies):
 *   announce(inst)     the new process is up before it owns anything: its
 *                      serverInstances doc, heartbeat, a DI'd store over
 *                      inst.db (the server singletons are still the old
 *                      process's: nothing that touches them)
 *   handoff(old)       the SIGTERM path; ctx.successor is announced
 *   crash(old)         the uncaughtException path (no successor yet)
 *   stop(old)          the graceful close before the old process exits
 *                      (handoff, throw, mongo-stall; never for kill)
 *   reap(old)          after the death, for every kind: cancel the dead
 *                      process's own timers (store, heartbeat). No I/O:
 *                      its connection is dead (deadDbOps)
 *   start(inst)        the new process owns the singletons now (adoption,
 *                      liveStore.start's sweep)
 * restart({kind}):
 *   handoff      a deploy: successor spawned + announce, handoff(old),
 *                stop, death, reap, start(successor)
 *   mongo-stall  a deploy whose old process's Mongo stalls: successor
 *                spawned + announce; the OLD connection stalls; handoff
 *                starts; `stallMs` (default 13000, past the 12 s
 *                observed-death window) of fake time pass with both
 *                processes up (the successor's announced heartbeat and
 *                store run on their own connection); the stall lifts; the
 *                handoff settles; stop, death, reap, start(successor)
 *   throw        crash(old), stop, death, reap; then the successor (ON_FAILURE
 *                restart): spawned, announce, start
 *   kill         death at once (no crash, no stop), reap; then the
 *                successor: spawned, announce, start
 * Options: sameDeployment (the successor keeps the deploymentId),
 * abandonStalled (killInstance's; for mongo-stall also: the ops stalled
 * when the stall lifts are dropped, never applied), mode (the successor's
 * LIVE_PERSIST).
 * `mods` default to this test's own server modules.
 */
function createPersistHarness({ db, hooks = {}, mods = null, holder = null, mode = null } = {}) {
    if (!db || typeof db.connect !== 'function') throw new Error('createPersistHarness needs a db (liveDb())');
    const serverMods = mods || loadServerModules();
    const instances = [];
    let n = 0;
    const spawn = ({ deploymentId = null, instMode = mode } = {}) => {
        n++;
        const inst = createInstance({
            name: `i${n}`, mods: serverMods, db, mode: instMode,
            ...(deploymentId && { deploymentId }),
        });
        instances.push(inst);
        return inst;
    };
    const harness = {
        db,
        instances,
        current: null,
        /** Start the first instance (announce, then start). */
        async boot() {
            if (harness.current) throw new Error('already booted');
            const inst = spawn();
            const ctx = { kind: 'boot', old: null, successor: inst, harness };
            await hooks.announce?.(inst, ctx);
            harness.current = inst;
            becomeCurrent(inst, holder);
            await hooks.start?.(inst, ctx);
            return inst;
        },
        async restart({ kind = 'handoff', sameDeployment = false, stallMs = 13000, abandonStalled = false,
            mode: nextMode = mode } = {}) {
            if (!RESTART_KINDS.includes(kind)) throw new Error(`restart kind must be one of ${RESTART_KINDS.join(', ')}`);
            const old = harness.current;
            if (!old) throw new Error('boot() first');
            if (kind === 'mongo-stall' && !fakeTimersOn()) throw new Error("restart({kind: 'mongo-stall'}) needs Jest's fake timers");
            const ctx = { kind, old, successor: null, harness };
            const makeSuccessor = async () => {
                ctx.successor = spawn({ deploymentId: sameDeployment ? old.deploymentId : null, instMode: nextMode });
                await hooks.announce?.(ctx.successor, ctx);
            };
            const die = async () => {
                killInstance(old, { abandonStalled });
                await hooks.reap?.(old, ctx);
            };

            if (kind === 'handoff' || kind === 'mongo-stall') {
                await makeSuccessor();
                if (kind === 'handoff') {
                    await hooks.handoff?.(old, ctx);
                } else {
                    db.faults.stall({ instances: old.name });
                    const handoff = Promise.resolve(hooks.handoff?.(old, ctx));
                    try {
                        await jest.advanceTimersByTimeAsync(stallMs);
                    } finally {
                        // abandonStalled: the old process's stalled ops never
                        // reach Mongo (its connection is gone for good); else
                        // they apply late, as a write already sent may
                        if (abandonStalled) db.faults.abandon({ instances: old.name });
                        db.faults.release();
                    }
                    await handoff;
                }
                await hooks.stop?.(old, ctx);
                await die();
            } else {
                if (kind === 'throw') {
                    await hooks.crash?.(old, ctx);
                    await hooks.stop?.(old, ctx);
                }
                await die();
                await makeSuccessor();
            }
            harness.current = ctx.successor;
            becomeCurrent(ctx.successor, holder);
            await hooks.start?.(ctx.successor, ctx);
            return ctx.successor;
        },
        /** Emits any dead instance made after it died (must be empty). */
        deadEmits: () => instances.filter((i) => i.dead).flatMap((i) => i.afterDeath.map((e) => ({ instance: i.name, ...e }))),
        /** DB ops any dead instance tried after it died (dropped). */
        deadDbOps: () => instances.filter((i) => i.dead).flatMap((i) => i.deadDbOps.map((e) => ({ instance: i.name, ...e }))),
    };
    return harness;
}

/**
 * The deploy overlap: two live processes at once over one db. Each has its
 * own bootId, deploymentId (unless sameDeployment), startedAt (B `gapMs`
 * later), monotonic clock, recording io and, with `db` (a liveDb), its own
 * connection (A.db, B.db). A runs on this test's server modules; B.mods is
 * a second copy of every server module loaded under jest.isolateModules
 * (its own GameManager, BotController, handlers, logger); jest.mock
 * factories apply to both, so both see the same db. kill(inst) is
 * killInstance.
 *
 * LIMIT (Jest, not this file): a require() that runs after
 * jest.isolateModules returns resolves in the MAIN registry. The server has
 * many lazy requires (GameState.addPlayer `require('./bot')`,
 * BotController.processBotDraw `require('../../socket/gameHandlers')`,
 * gameLifecycle, chatHandlers, ...), so B's game code reaches A's
 * singletons as soon as it takes one of those paths (a dealt B table finds
 * no bot: "Bot not found for scheduled action"). B.mods is therefore only
 * sound for code with no lazy require: the dependency-injected persist
 * pieces (createLiveStore({getCollections: () => B.db, bootId, now, ...}),
 * heartbeat, adoption claim) built twice with A's and B's ids, clocks and
 * connections. A game PLAYED on B (seating a client, bots acting, B's
 * gameEnd) needs another model, which deploy-survival PR 5 must build
 * before its overlapHandoff tests that need one (child-process instances
 * over a shared mongod, or instance-scoped singletons); see the plan's
 * PR 5 note. persistHarness.test.js pins this limit so it is not forgotten.
 */
function twoInstances({ gapMs = 1000, sameDeployment = false, db = null } = {}) {
    const A = createInstance({ name: 'A', mods: loadServerModules(), db });
    let bMods;
    jest.isolateModules(() => { bMods = loadServerModules(); });
    const B = createInstance({
        name: 'B',
        mods: bMods,
        db,
        startedAt: A.startedAt + gapMs,
        ...(sameDeployment && { deploymentId: A.deploymentId }),
    });
    return { A, B, kill: killInstance };
}

module.exports = {
    makeRng,
    loadServerModules,
    fixedBotDelays,
    silenceBotChat,
    decisionLog,
    LIVE_COLLECTIONS,
    createFaults,
    liveDb,
    databaseMock,
    fakeTimersOn,
    flushStore,
    createMonoClock,
    authoritative,
    RESTART_KINDS,
    createInstance,
    PROCESS_RESETS,
    killInstance,
    createPersistHarness,
    twoInstances,
};
