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
 *   liveDb(seed)           a memoryDb with liveGames, liveTournaments and
 *                          serverInstances, plus fault injection (stall,
 *                          fail, lost reply) on every collection
 *   databaseMock(holder)   getters for jest.mock('../database') over
 *                          holder.current (a liveDb)
 *   flushStore(store)      pump immediates and microtasks until a store has
 *                          nothing pending (store.pending())
 *   authoritative(game)    the game's authoritative state keyed by position
 *                          (no socket ids), for equality across a restart
 *   createMonoClock()      a per-instance monotonic clock (jump, freeze)
 *   createPersistHarness() one "process" at a time: restart({kind})
 *                          (handoff | kill | throw | mongo-stall) resets the
 *                          server singletons and starts a new instance
 *   twoInstances()         two live "processes" at once (the deploy
 *                          overlap) over one db: own ids and clocks; B's
 *                          server modules isolated, with a Jest limit on
 *                          lazy requires (see twoInstances)
 *
 * Every server module is required lazily (inside the functions), so a test
 * can call databaseMock from its jest.mock factory and twoInstances can
 * load a second set of singletons. The persist store, handoff and adoption
 * do not exist yet: restart and twoInstances take them as hooks.
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
        shutdown: require('../utils/shutdown'),
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

/**
 * Fault injection over a set of MemoryCollections. Rules match by
 * collection name and operation (null = all) and are checked newest first:
 *   stall({collections, ops})   the op waits until release() (then runs:
 *                               a stalled write still applies, late)
 *   fail({collections, ops, times, lostReply})
 *                               the op rejects with a MongoNetworkError;
 *                               lostReply: it applies first, then rejects
 *                               (the ambiguous outcome). `times` (default
 *                               every call) counts matching calls.
 * Every call is recorded in `calls` ({collection, op, outcome}).
 */
function createFaults() {
    const rules = [];
    const calls = [];
    let gate = null;
    let openGate = null;
    const stalled = new Set();

    const matching = (name, op) => rules.find((r) => (r.collections === null || r.collections.has(name))
        && (r.ops === null || r.ops.has(op)) && r.remaining > 0);
    const asSet = (list) => (list ? new Set([].concat(list)) : null);

    const faults = {
        calls,
        stall({ collections = null, ops = null } = {}) {
            if (!gate) gate = new Promise((resolve) => { openGate = resolve; });
            rules.unshift({ mode: 'stall', collections: asSet(collections), ops: asSet(ops), remaining: Infinity });
            return () => faults.release();
        },
        fail({ collections = null, ops = null, times = Infinity, lostReply = false } = {}) {
            rules.unshift({ mode: lostReply ? 'lostReply' : 'fail', collections: asSet(collections), ops: asSet(ops), remaining: times });
        },
        /** Lift every stall; stalled ops go on (in the order they arrived). */
        release() {
            for (let i = rules.length - 1; i >= 0; i--) if (rules[i].mode === 'stall') rules.splice(i, 1);
            if (openGate) openGate();
            gate = null;
            openGate = null;
        },
        /** Drop every rule (stalls released). */
        clear() {
            faults.release();
            rules.length = 0;
        },
        /** Ops waiting on a stall right now. */
        stalledCount: () => stalled.size,
        async _run(name, op, fn) {
            const rule = matching(name, op);
            if (!rule) {
                calls.push({ collection: name, op, outcome: 'ok' });
                return fn();
            }
            if (rule.mode === 'stall') {
                const token = {};
                stalled.add(token);
                calls.push({ collection: name, op, outcome: 'stalled' });
                try {
                    await gate;
                } finally {
                    stalled.delete(token);
                }
                return faults._run(name, op, fn);
            }
            rule.remaining--;
            if (rule.mode === 'fail') {
                calls.push({ collection: name, op, outcome: 'failed' });
                throw networkError(name, op);
            }
            await fn();
            calls.push({ collection: name, op, outcome: 'lostReply' });
            throw networkError(name, op);
        },
    };
    return faults;
}

/** Route a collection's async operations (and find().toArray) through `faults`. */
function withFaults(name, coll, faults) {
    for (const method of FAULT_METHODS) {
        const original = coll[method].bind(coll);
        coll[method] = (...args) => faults._run(name, method, () => original(...args));
    }
    const find = coll.find.bind(coll);
    coll.find = (...args) => {
        const cursor = find(...args);
        const toArray = cursor.toArray.bind(cursor);
        cursor.toArray = () => faults._run(name, 'find', toArray);
        return cursor;
    };
    return coll;
}

/**
 * A memoryDb (users, gameRecords, reports, passwordResets, adminAudit) plus
 * the three deploy-survival collections, each seeded from `seed[name]`, and
 * `faults` (createFaults) over all of them.
 */
function liveDb(seed = {}) {
    const db = createMemoryDb(seed);
    for (const name of LIVE_COLLECTIONS) db[name] = new MemoryCollection(seed[name] || []);
    const faults = createFaults();
    for (const [name, coll] of Object.entries(db)) withFaults(name, coll, faults);
    Object.defineProperty(db, 'faults', { value: faults, enumerable: false });
    return db;
}

/**
 * The database getters over `holder.current` (set it to a liveDb in
 * beforeEach). For a jest.mock factory, which may only reach variables
 * named mock*:
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
 * @returns {Promise<number>} turns used
 */
async function flushStore(store, { rounds = 50 } = {}) {
    if (!store || typeof store.pending !== 'function') {
        for (let i = 0; i < 3; i++) await pump();
        return 3;
    }
    let idle = 0;
    for (let i = 1; i <= rounds; i++) {
        await pump();
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
 * What must survive a restart, keyed by position (no socket id, timer,
 * epoch, seq or presence): stage, deal and bidding state, the table, the
 * score and stats, every hand, and per seat who controls it and who owns
 * it. Two games are the same game iff these are deep-equal.
 * @param {GameState} game
 * @param {{presence?: boolean, log?: boolean, gameManager?: Object}} [opts]
 *   presence: add each seat's presence; log: add the game log's texts;
 *   gameManager: add the game's tournamentId from its tournamentGames
 */
function authoritative(game, { presence = false, log = false, gameManager = null } = {}) {
    const hands = {};
    const seats = {};
    for (const pos of [1, 2, 3, 4]) {
        const sid = game.positions?.[pos];
        hands[pos] = sid && game.hands[sid] ? json(game.hands[sid]) : null;
        const s = game.seats?.[pos];
        seats[pos] = s ? {
            controller: s.controller,
            ownerUsername: s.ownerUsername ?? null,
            gone: s.presence === 'gone',
            bot: s.bot ? { username: s.bot.username ?? null, personality: s.bot.personality ?? null } : null,
            ...(presence && { presence: s.presence }),
        } : null;
    }
    const out = {
        gameId: game.gameId,
        stage: game.stage,
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
 * One server "process": its own ids, monotonic clock, recording io and the
 * server modules it runs on. Once `dead`, anything its io or sockets emit
 * goes to `afterDeath` instead of `log` (the "no emit from a dead io"
 * oracle: it must stay empty).
 */
function createInstance({ name = 'instance', mods, bootId = randomUUID(), deploymentId = randomUUID(),
    startedAt = Date.now(), clock = createMonoClock() } = {}) {
    const { makeIo, makeSocket } = require('./gameDriver');
    const log = [];
    const io = makeIo(log);
    const inst = {
        name, mods, bootId, deploymentId, startedAt, clock, log, io,
        dead: false,
        afterDeath: [],
        store: null,
        /** A stub socket on this instance (registered in its io). */
        socket: (id) => makeSocket(id, log, io),
    };
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
 * The process dies: its io goes dead, then every server singleton it ran
 * on is reset (GameManager / BotController _resetForTests: timers
 * cancelled, nothing emitted or written).
 */
function killInstance(inst) {
    inst.dead = true;
    inst.mods.gameManager._resetForTests();
    inst.mods.botController._resetForTests();
}

/**
 * One server process at a time over `db` (the live state's only path
 * between processes). `hooks` plug in what does not exist yet, each
 * async(instance, ctx):
 *   start(inst)        a new process is up (liveStore.start, adoption sweep)
 *   handoff(inst)      the SIGTERM path before the process exits
 *   crash(inst)        the uncaughtException path
 *   stop(inst, kind)   last thing before the singletons are reset (close
 *                      the store, stop the heartbeat)
 * restart({kind}):
 *   handoff      hooks.handoff, then the process dies
 *   kill         it dies at once (SIGKILL, OOM): no hook runs
 *   throw        hooks.crash, then it dies
 *   mongo-stall  every collection stalls; hooks.handoff starts; `stallMs`
 *                (default 13000, past the 12 s observed-death window) of
 *                fake time pass; the stall lifts; the handoff settles; it dies
 * Then a new instance (new bootId; the same deploymentId with
 * sameDeployment, as an ON_FAILURE restart) starts and hooks.start runs.
 * `mods` default to this test's own server modules.
 */
function createPersistHarness({ db, hooks = {}, mods = null } = {}) {
    if (!db) throw new Error('createPersistHarness needs a db (liveDb())');
    const serverMods = mods || loadServerModules();
    const instances = [];
    let n = 0;
    const spawn = (deploymentId) => {
        n++;
        const inst = createInstance({ name: `i${n}`, mods: serverMods, ...(deploymentId && { deploymentId }) });
        instances.push(inst);
        return inst;
    };
    const harness = {
        db,
        instances,
        current: null,
        /** Start the first instance (hooks.start). */
        async boot() {
            if (harness.current) throw new Error('already booted');
            harness.current = spawn();
            await hooks.start?.(harness.current);
            return harness.current;
        },
        async restart({ kind = 'handoff', sameDeployment = false, stallMs = 13000 } = {}) {
            if (!RESTART_KINDS.includes(kind)) throw new Error(`restart kind must be one of ${RESTART_KINDS.join(', ')}`);
            const old = harness.current;
            if (!old) throw new Error('boot() first');
            if (kind === 'handoff') await hooks.handoff?.(old);
            if (kind === 'throw') await hooks.crash?.(old);
            if (kind === 'mongo-stall') {
                if (!fakeTimersOn()) throw new Error("restart({kind: 'mongo-stall'}) needs Jest's fake timers");
                db.faults.stall();
                const handoff = Promise.resolve(hooks.handoff?.(old));
                try {
                    await jest.advanceTimersByTimeAsync(stallMs);
                } finally {
                    db.faults.release();
                }
                await handoff;
            }
            await hooks.stop?.(old, kind);
            killInstance(old);
            harness.current = spawn(sameDeployment ? old.deploymentId : null);
            await hooks.start?.(harness.current);
            return harness.current;
        },
        /** Emits any dead instance made after it died (must be empty). */
        deadEmits: () => instances.filter((i) => i.dead).flatMap((i) => i.afterDeath.map((e) => ({ instance: i.name, ...e }))),
    };
    return harness;
}

/**
 * The deploy overlap: two live processes at once over one db. Each has its
 * own bootId, deploymentId (unless sameDeployment), startedAt (B `gapMs`
 * later), monotonic clock and recording io. A runs on this test's server
 * modules; B.mods is a second copy of every server module loaded under
 * jest.isolateModules (its own GameManager, BotController, handlers,
 * logger); jest.mock factories apply to both, so both see the same db.
 * kill(inst) is killInstance.
 *
 * LIMIT (Jest, not this file): a require() that runs after
 * jest.isolateModules returns resolves in the MAIN registry. The server has
 * many lazy requires (GameState.addPlayer `require('./bot')`,
 * BotController.processBotDraw `require('../../socket/gameHandlers')`,
 * gameLifecycle, chatHandlers, ...), so B's game code reaches A's
 * singletons as soon as it takes one of those paths (a dealt B table finds
 * no bot: "Bot not found for scheduled action"). B.mods is therefore only
 * sound for code with no lazy require: the dependency-injected persist
 * pieces (createLiveStore({getCollections, bootId, now, ...}), heartbeat,
 * adoption sweep) built twice with A's and B's ids and clocks. Tables that
 * must run on B need another model (child processes, or instance-scoped
 * singletons); persistHarness.test.js pins this limit so it is not
 * forgotten.
 */
function twoInstances({ gapMs = 1000, sameDeployment = false } = {}) {
    const A = createInstance({ name: 'A', mods: loadServerModules() });
    let bMods;
    jest.isolateModules(() => { bMods = loadServerModules(); });
    const B = createInstance({
        name: 'B',
        mods: bMods,
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
    killInstance,
    createPersistHarness,
    twoInstances,
};
