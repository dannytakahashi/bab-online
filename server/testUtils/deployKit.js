/**
 * Deploys and restarts with the REAL deploy-survival pieces (PR 5:
 * LIVE_PERSIST=on, the unique gameId index present), one "process" at a
 * time over persistHarness.createPersistHarness and a liveDb. The harness
 * hooks are filled in here:
 *
 *   announce(inst)  the successor is up before it owns anything: in
 *                   'on' its own store (liveStoreKit.createOnStore over its
 *                   connection: the real instance doc, heartbeat and sweep)
 *                   is started but NOT the process's store, and it holds
 *                   itself "not yet serving" (its isShuttingDown is true
 *                   until start): its sweep adopts nothing and its
 *                   resolve() answers 'pending', because the server
 *                   singletons are still the old process's (the PR 1
 *                   review note, persistHarness twoInstances LIMIT). A
 *                   'write' successor gets its instance doc and a 3 s
 *                   heartbeat; an 'off' one nothing
 *   handoff(old)    the real SIGTERM path: utils/shutdown.js
 *                   setupGracefulShutdown over the old io with opts.persist
 *                   (its store) and opts.handoff (persist/handoff.js), then
 *                   shutdown('SIGTERM', 0), fake time until process.exit
 *   crash(old)      the same, through onUncaughtException (exit 1)
 *   start(inst)     the new process owns the singletons now: its store
 *                   becomes the process's store and serves (the real
 *                   restoreGame, isGated and suspend), and sweeps once at
 *                   once (then its 1 s sweeps go on). hooks.beforeSweep(inst)
 *                   runs first (a client's request racing the sweep);
 *                   hooks.beforeHandoff(old, ctx) runs in the gap, before
 *                   the old process's SIGTERM (ctx.successor is up, held)
 *
 * createDeploy({holder, db}) -> {
 *   harness, boot(), restart(opts) (persistHarness restart kinds: handoff,
 *   kill, throw, mongo-stall), current() (the live instance), store()
 *   (its store), exits (every process.exit code, in order),
 *   outcomes (every handoff / crash result's [{gameId, outcome}]),
 *   waitAdopted(gameId, {cap}) (fake time until the current process holds
 *   it, or null), close()
 * }
 *
 * The calling test mocks ../database with persistHarness.databaseMock over
 * `holder`, uses Jest's modern fake timers and restores mocks after each
 * test (process.exit is spied here). Server modules are required lazily.
 */

'use strict';

const BEAT_MS = 3000;
const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];

function createDeploy({ holder, db, mode = 'on', hooks: extraHooks = {} } = {}) {
    const h = require('./persistHarness');
    const kit = require('./liveStoreKit');
    const exits = [];
    const outcomes = [];
    const beats = new Map();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => { exits.push(code); });

    /** An 'on' store for `inst` over its own connection, serving once inst.serving. */
    function onStore(inst) {
        inst.serving = false;
        return kit.createOnStore({
            getCollections: () => inst.db,
            bootId: inst.bootId,
            deploymentId: inst.deploymentId,
            monoNow: inst.clock.now,
            getIo: () => inst.io,
            isShuttingDown: () => !inst.serving || require('../utils/shutdown').isShuttingDown(),
            // Until it serves, the singletons' games are the old process's
            listGames: () => (inst.serving ? require('../game/GameManager').games.keys() : []),
            listTournaments: () => (inst.serving ? require('../game/GameManager').tournaments.keys() : []),
            findGame: (id) => (inst.serving ? require('../game/GameManager').games.get(id) : undefined)
        });
    }

    async function announce(inst, ctx) {
        if (ctx.kind === 'boot') return;
        const instMode = inst.mode || mode;
        if (instMode === 'off') return;
        if (instMode === 'on') {
            inst.store = onStore(inst);
            await inst.store.start({ io: inst.io });
            return;
        }
        const coll = inst.db.serverInstances;
        const at = new Date();
        await coll.insertOne({
            _id: inst.bootId, deploymentId: inst.deploymentId, mode: instMode, startedAt: at, beatAt: at,
            beatSeq: 0, shuttingDown: false, gameIds: [], tournamentIds: []
        });
        let seq = 0;
        const timer = setInterval(() => {
            seq++;
            coll.updateOne({ _id: inst.bootId }, { $set: { beatAt: new Date(), beatSeq: seq } }).catch(() => {});
        }, BEAT_MS);
        beats.set(inst.bootId, timer);
    }

    /** The real shutdown over `old` (its io, store and a handoff), run to process.exit. */
    async function stopProcess(old, signal) {
        const shutdown = require('../utils/shutdown');
        const handoffMod = require('../game/persist/handoff');
        const gameManager = require('../game/GameManager');
        const before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
        if (typeof old.io.close !== 'function') old.io.close = (cb) => { cb?.(); };
        const handoff = handoffMod.createHandoff({ store: old.store });
        // Record the handoff's outcomes (what each table was told)
        const run = handoff.run;
        const crash = handoff.crash;
        const recordOutcome = (kind) => (res) => {
            outcomes.push({ instance: old.name, kind, tables: (res?.tables || []).map((t) => ({ gameId: t.game?.gameId, outcome: t.outcome })) });
            return res;
        };
        handoff.run = (...a) => run(...a).then(recordOutcome('run'));
        handoff.crash = (...a) => crash(...a).then(recordOutcome('crash'));
        const api = shutdown.setupGracefulShutdown({ close: (cb) => { cb?.(); } }, old.io, {
            games: () => gameManager.games.values(),
            persist: old.store,
            handoff
        });
        const n = exits.length;
        try {
            if (signal === 'uncaughtException') api.onUncaughtException(new Error('chaos: thrown'));
            else api.shutdown(signal, 0);
            for (let t = 0; t < 20000 && exits.length === n; t += 100) await jest.advanceTimersByTimeAsync(100);
        } finally {
            for (const s of SIGNALS) {
                for (const fn of process.listeners(s)) if (!before[s].includes(fn)) process.removeListener(s, fn);
            }
        }
        if (exits.length === n) throw new Error(`deployKit: ${signal} did not exit within 20 s`);
    }

    async function start(inst, ctx) {
        clearInterval(beats.get(inst.bootId));
        beats.delete(inst.bootId);
        const instMode = inst.mode || mode;
        const liveStore = require('../game/persist/liveStore');
        if (instMode === 'on') {
            if (!inst.store) {
                inst.store = onStore(inst);
                inst.serving = true;
                liveStore._setForTests(inst.store);
                await inst.store.start({ io: inst.io });
            } else {
                inst.serving = true;
                liveStore._setForTests(inst.store);
            }
            await extraHooks.beforeSweep?.(inst, ctx);
            await inst.store.sweep();
            return;
        }
        // 'write' / 'off': the process's own store, as server/index.js makes it
        await inst.db.serverInstances.deleteOne({ _id: inst.bootId });
        inst.store = kit.installStore(holder, { bootId: inst.bootId, deploymentId: inst.deploymentId, monoNow: inst.clock.now, getIo: () => inst.io, mode: instMode });
        if (instMode === 'write') await inst.store.start({ io: inst.io });
    }

    const harness = h.createPersistHarness({
        db,
        holder,
        mode,
        hooks: {
            announce,
            handoff: async (old, ctx) => {
                // The gap: the successor is up (held), the old process still owns its tables
                await extraHooks.beforeHandoff?.(old, ctx);
                await stopProcess(old, 'SIGTERM');
            },
            crash: (old) => stopProcess(old, 'uncaughtException'),
            start
        }
    });

    return {
        harness,
        exits,
        outcomes,
        exitSpy,
        boot: () => harness.boot(),
        restart: (opts) => harness.restart(opts),
        current: () => harness.current,
        store: () => harness.current?.store || null,
        /** Fake time (1 s steps) until this process holds `gameId`, at most `cap` ms. */
        async waitAdopted(gameId, { cap = 30000 } = {}) {
            const gameManager = require('../game/GameManager');
            for (let t = 0; t <= cap; t += 1000) {
                const g = gameManager.games.get(gameId);
                if (g) return g;
                await jest.advanceTimersByTimeAsync(1000);
            }
            return gameManager.games.get(gameId) || null;
        },
        close() {
            for (const t of beats.values()) clearInterval(t);
            beats.clear();
            harness.current?.store?.close?.();
        }
    };
}

module.exports = { createDeploy, BEAT_MS };
