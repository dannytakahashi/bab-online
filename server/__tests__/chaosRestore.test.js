/**
 * Chaos with restarts (deploy survival PR 5, LIVE_PERSIST=on; the plan's
 * PR 5 "chaosRestore.test.js"): the chaos engine's run
 * (testUtils/chaosEngine.js runSeedInner, every one of its oracles) with
 * 1-3 restarts mixed in as an extra action, through deployKit (the real
 * store, SIGTERM handoff, crash release and adoption over
 * persistHarness.createPersistHarness). A restart is one of:
 *   handoff      a deploy: successor announced, A's SIGTERM handoff, A exits 0
 *   kill         SIGKILL / OOM: no release; adopted after 12 s of A's
 *                beat seen unchanged
 *   throw        uncaughtException: the crash release, exit 1
 *   mongo-stall  a deploy during which A's Mongo stalls 13 s (> 12 s), its
 *                stalled ops never landing: UNKNOWN, adopted after the
 *                stale-owner wait
 * After it the seated humans come back in random order over 0-70 s, and
 * some never (their seats get the usual grace and Replace-with-Bot offer).
 *
 * Oracles, on top of the chaos engine's (FSM invariants with
 * BAB_FSM_CHECK, consistency, liveness, leaks, offers, bid clock):
 *   - seqCheck (one watch over every instance's emits) and watchPacing
 *     (requireResumeInMs; a watcher per instance, a restored table starting
 *     from what is on it)
 *   - authoritative equality: after a handoff the restored table equals A's
 *     at its freeze; after a kill / throw / stall it equals the last doc A
 *     wrote, which is never ahead of A's table
 *   - exact hands: each returning owner's rejoin snapshot holds its hand
 *   - no rejoinFailed and no pointer clear while the game is adoptable or
 *     live; every adoptable game is adopted
 *   - no emit from a dead (or fenced) instance's io
 *   - at the end: liveGames empty, every pointer cleared, exactly one
 *     gameRecords doc if the game reached gameEnd (on any instance), none
 *     otherwise, and each human's gamesPlayed +1 exactly once (0 if none)
 *
 * CHAOS_RESTORE_SEEDS=<n> sets the number of seeds (default 100;
 * test:contract runs 500, test:race 200).
 */

const mockDb = { current: null };
jest.mock('../database', () => require('../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../testUtils/persistHarness');
const kit = require('../testUtils/liveStoreKit');
const { createDeploy } = require('../testUtils/deployKit');
const gameManager = require('../game/GameManager');
const { botController } = require('../game/bot');
const GamePhase = require('../game/GamePhase');
const gameCodec = require('../game/persist/gameCodec');
const liveStore = require('../game/persist/liveStore');
const shutdown = require('../utils/shutdown');
const profileHandlers = require('../socket/profileHandlers');
const contractCheck = require('../testUtils/contractCheck');
const { watchSeq } = require('../testUtils/seqCheck');
const { watchPacing } = require('../testUtils/pacingInvariants');
const { runSeedInner } = require('../testUtils/chaosEngine');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../utils/logger');

const { Phase } = GamePhase;
const SEEDS = Number(process.env.CHAOS_RESTORE_SEEDS) || 100;
const KINDS = ['handoff', 'kill', 'throw', 'mongo-stall'];
const RESTORE_STAGES = new Set([Phase.BIDDING, Phase.PLAYING, Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING]);
const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];
// What a restart itself logs as an error (the crash it simulates)
const RESTART_ERRORS = ['Uncaught exception'];

let errorLogs;
let realRandom;
let listenersBefore;

beforeAll(() => {
    process.env.BAB_FSM_CHECK = '1';
    realRandom = Math.random;
});

afterAll(() => {
    delete process.env.BAB_FSM_CHECK;
    Math.random = realRandom;
});

beforeEach(() => {
    jest.useFakeTimers();
    listenersBefore = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => {
            if (!RESTART_ERRORS.some((w) => String(msg).includes(w))) errorLogs.push({ msg, meta });
        });
        jest.spyOn(l, 'warn').mockImplementation(() => {});
        jest.spyOn(l, 'info').mockImplementation(() => {});
        jest.spyOn(l, 'debug').mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    for (const s of SIGNALS) {
        for (const fn of process.listeners(s)) if (!listenersBefore[s].includes(fn)) process.removeListener(s, fn);
    }
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

/** Everything process-scoped back to a fresh process between seeds. */
function resetProcess() {
    liveStore._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    shutdown._resetShutdownStateForTests({ abandonRetries: true });
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
}

const plain = (v) => JSON.parse(JSON.stringify(v));
/** authoritative() without the bots' partnerHistory (a hydrated, unregistered copy has none). */
function auth(game, botCtl) {
    const a = h.authoritative(game, botCtl ? { botController: botCtl } : {});
    for (const s of Object.values(a.seats)) if (s?.bot) delete s.bot.partnerHistory;
    return plain(a);
}
const hydrated = (doc) => gameCodec.hydrate({ ...plain(doc), gameId: doc._id, createdAt: doc.createdAt }, { now: Date.now(), onGraceExpire: () => {} }).game;

/**
 * One seed: a chaos run with up to 1-3 restarts. Returns a failure
 * description or {ok, restarts, kinds, behind, ended}.
 */
async function runSeed(seed) {
    resetProcess();
    const db = h.liveDb();
    mockDb.current = db;
    let onServe = null;
    const deploy = createDeploy({ holder: mockDb, db, hooks: { beforeSweep: (inst) => onServe?.(inst) } });
    const first = await deploy.boot();
    const maxRestarts = 1 + (seed % 3);
    const failures = [];
    const fail = (why, extra = {}) => { if (failures.length < 5) failures.push({ why, ...extra }); };
    const stats = { restarts: 0, kinds: [], behind: 0 };
    const paceFailures = [];
    let paceWatch = null;
    let seqWatch = null;
    let gameIdOf = null;
    let ended = false;
    let pointerWatch = null;

    const extraActions = (ctx) => {
        gameIdOf = ctx.gameId;
        const id = ctx.gameId;
        const pointerOf = (u) => db.users.docs.find((d) => d.username === u)?.activeGameId ?? null;
        // While the game is live: no pointer of a seated human cleared (checked after every step)
        pointerWatch = () => {
            const g = gameManager.getGameById(id);
            if (!g || g.isTerminal() || !RESTORE_STAGES.has(g.stage)) return;
            for (const s of g.seatList()) {
                if (s.ownerUsername && s.controller === 'human' && pointerOf(s.ownerUsername) !== id) {
                    fail('pointer cleared while the game is live', { username: s.ownerUsername, pointer: pointerOf(s.ownerUsername) });
                }
            }
        };
        return [[1.5, function everyoneLazy() {
            // Every connected owner hands the seat to its bot: games reach
            // gameEnd within the step budget (the record and stats oracles)
            for (const hm of ctx.humans.filter((x) => x.connected)) {
                require('../socket/chatHandlers').chatMessage(ctx.sockets.get(hm.current), ctx.io, { message: '/lazy' });
            }
        }], [1.2, async function restart() {
            if (stats.restarts >= maxRestarts) return;
            const game = ctx.game;
            if (!game || game.isTerminal() || game.frozen || !RESTORE_STAGES.has(game.stage)) return;
            if (gameCodec.serialize(game) === null) return;
            const old = deploy.current();
            pointerWatch();
            const saved = kit.savedGame(db, id);
            if (!saved || saved.owner !== old.bootId || saved.kind !== 'live') return;
            // Another quick death of an adopter that has not reset adoptAttempts
            // yet (its gate still closed) would be a crash loop, which the
            // adopter discards by design (adopt.test.js): only a handoff then
            const quick = Number(saved.adoptAttempts) >= 1;
            const kind = quick ? 'handoff' : ctx.pick(KINDS);
            ctx.setNote(kind);
            stats.restarts++;
            stats.kinds.push(kind);
            const atFreeze = auth(game);
            const docBefore = plain(saved);
            const eventSeqBefore = game.eventSeq;
            const seatedHumans = game.seatList().filter((s) => s.ownerUsername).map((s) => s.ownerUsername);
            paceFailures.push(...paceWatch.stop().failures);
            // The run moves to the successor's io once it serves (before its
            // sweep adopts: the "resumed" line goes to the new room)
            onServe = (inst) => {
                ctx.swapIo({ io: inst.io, log: inst.log });
                paceWatch = watchPacing({ requireResumeInMs: true });
            };
            await deploy.restart({ kind, abandonStalled: kind === 'mongo-stall' });
            onServe = null;
            // Every socket went with the old process
            for (const hm of ctx.humans) { hm.connected = false; hm.stale = []; }
            const restored = await deploy.waitAdopted(id, { cap: 30000 });
            if (!restored) {
                const d = kit.savedGame(db, id);
                fail('adoptable game not adopted', {
                    kind,
                    doc: d && { owner: d.owner, released: d.released, kind: d.kind, rev: d.rev, ownerMode: d.ownerMode },
                    instances: db.serverInstances.docs.map((x) => ({ id: x._id, beatSeq: x.beatSeq, shuttingDown: x.shuttingDown, mode: x.mode })),
                    old: old.bootId,
                    outcomes: deploy.outcomes.slice(-1)
                });
                return;
            }
            ctx.game = restored;
            pointerWatch();
            // A new dummy table for the spectators to move to
            const dummyBots = [0, 1, 2, 3].map((i) => botController.createBot(`🤖 E${stats.restarts}${i}`, 'mary'));
            const dummy = gameManager.createGame(dummyBots.map((b) => b.socketId));
            dummyBots.forEach((b, i) => dummy.addPlayer(b.socketId, b.username, i + 1, 1, true));
            ctx.dummy = dummy;
            // The restored table as A left it
            if (kind === 'handoff') {
                if (JSON.stringify(auth(restored)) !== JSON.stringify(atFreeze)) fail('handoff: restored state differs from the frozen one', { kind });
            } else {
                if (JSON.stringify(auth(restored)) !== JSON.stringify(auth(hydrated(docBefore)))) fail('restored state differs from the last write', { kind });
                if (docBefore.state.eventSeq > eventSeqBefore) fail('the last write is ahead of the table', { kind });
                if (docBefore.state.eventSeq < eventSeqBefore) stats.behind++;
            }
            const graced = restored.seatList().filter((s) => s.controller === 'human' && s.presence === 'grace').map((s) => s.position);
            ctx.noteRestore(graced);
            // The humans come back in random order over 0-70 s; some never
            const order = ctx.humans.filter((hm) => seatedHumans.includes(hm.username)).sort(() => ctx.rand() - 0.5);
            const returning = order.filter(() => ctx.rand() < 0.8);
            const times = returning.map(() => ctx.randInt(0, 70000)).sort((a, b) => a - b);
            let t = 0;
            for (let i = 0; i < returning.length; i++) {
                await jest.advanceTimersByTimeAsync(times[i] - t);
                t = times[i];
                const g = gameManager.getGameById(id);
                if (!g || g !== restored || g.isTerminal()) break;
                pointerWatch();
                const hm = returning[i];
                const sid = `${hm.username}-x${stats.restarts}-${i}`;
                const before = ctx.log.length;
                await ctx.rejoinAs(hm, sid);
                const mine = ctx.log.slice(before).filter((e) => e.to === `self:${sid}`);
                // (a seat its owner left for good answers rejoinFailed, truly)
                const seatNow = restored.seatList().find((s) => s.ownerUsername === hm.username);
                if (seatNow && seatNow.presence !== 'gone' && mine.some((e) => e.event === 'rejoinFailed')) {
                    fail('rejoinFailed for a restored game', { username: hm.username, kind, reason: mine.find((e) => e.event === 'rejoinFailed').data });
                }
                const carrier = mine.find((e) => e.event === 'rejoinSuccess');
                if (!carrier) continue;
                const seat = restored.seatList().find((s) => s.ownerUsername === hm.username);
                const hand = seat ? restored.hands[seat.seatSocketId] : null;
                const shown = carrier.data?.snapshot?.hand;
                if (hand && shown && JSON.stringify(shown.map((c) => [c.suit, c.rank])) !== JSON.stringify(hand.map((c) => [c.suit, c.rank]))) {
                    fail('rejoin hand differs from the table', { username: hm.username, kind });
                }
            }
        }]];
    };

    contractCheck.setContext(`chaosRestore seed ${seed}`);
    let result;
    try {
        result = await runSeedInner(seed, (io) => {
            seqWatch = watchSeq(io);
            paceWatch = watchPacing({ requireResumeInMs: true });
        }, {
            errorLogs,
            instance: first,
            extraActions
        });
    } finally {
        paceFailures.push(...(paceWatch ? paceWatch.stop().failures : []));
    }
    const seqResult = seqWatch ? seqWatch.stop() : { failures: [] };
    if (!result.ok && process.env.CHAOS_DEBUG) {
        const lg = deploy.current().log;
        process.stdout.write(lg.filter((e) => /resign|Reconnect|Disconnect|rejoin/.test(e.event || e.marker || '')).map((e) => `${e.at} ${e.to} ${e.event || e.marker} ${JSON.stringify(e.members || e.positions || '')} ${JSON.stringify(e.data?.position ?? e.data?.reason ?? '')}`).join('\n') + '\n');
    }
    if (failures.length) return { seed, why: 'restore oracle', failures, restarts: stats };
    if (!result.ok) return { ...result, restarts: stats };
    if (seqResult.failures.length) return { seed, why: 'seq', failures: seqResult.failures.slice(0, 5), restarts: stats };
    if (paceFailures.length) return { seed, why: 'pacing', failures: paceFailures.slice(0, 5), restarts: stats };
    if (failures.length) return { seed, why: 'restore oracle', failures, restarts: stats };

    // Let every end-of-game write land (the record, the tombstone delete)
    const store = deploy.store();
    await jest.advanceTimersByTimeAsync(30000);
    if (store) await h.flushStore(store);
    const dead = deploy.harness.deadEmits();
    if (dead.length) return { seed, why: 'emit from a dead io', dead: dead.slice(0, 5).map((e) => `${e.instance}:${e.to}:${e.event}`), restarts: stats };
    const id = gameIdOf;
    const finalLog = deploy.current().log;
    ended = finalLog.some((e) => e.to === `game:${id}` && e.event === 'gameEnd')
        || deploy.harness.instances.some((i) => i.afterDeath.concat(i.log).some((e) => e.to === `game:${id}` && e.event === 'gameEnd'));
    if (db.liveGames.docs.length) return { seed, why: 'liveGames not empty', docs: db.liveGames.docs.map((d) => ({ id: d._id, kind: d.kind, owner: d.owner })), restarts: stats };
    const humans = db.users.docs.filter((u) => u.username.startsWith(`s${seed}_u`));
    const pointers = humans.filter((u) => u.activeGameId);
    if (pointers.length) return { seed, why: 'pointer left', users: pointers.map((u) => u.username), restarts: stats };
    const records = db.gameRecords.docs.filter((r) => r.gameId === id);
    if (records.length !== (ended ? 1 : 0)) return { seed, why: 'gameRecords count', records: records.length, ended, restarts: stats };
    const credited = new Set(records.flatMap((r) => [...(r.team1Players || []), ...(r.team2Players || [])]));
    for (const u of humans) {
        const played = (u.stats?.gamesPlayed || 0) + (u.botStats?.gamesPlayed || 0);
        if (played !== (credited.has(u.username) ? 1 : 0)) return { seed, why: 'gamesPlayed', username: u.username, played, credited: credited.has(u.username), restarts: stats };
    }
    deploy.close();
    return { ok: true, ...stats, ended };
}

describe('chaos with restarts', () => {
    test(`${SEEDS} seeded chaos runs with 1-3 restarts (handoff, kill, throw, mongo-stall) keep every oracle`, async () => {
        const bad = [];
        const tally = { seeds: 0, restarts: 0, ended: 0, behind: 0, kinds: {} };
        for (let seed = Number(process.env.CHAOS_RESTORE_FROM) || 1; seed <= SEEDS; seed++) {
            const r = await runSeed(seed);
            if (!r.ok) {
                bad.push(r);
                if (bad.length >= 3) break;
                continue;
            }
            tally.seeds++;
            tally.restarts += r.restarts;
            tally.behind += r.behind;
            if (r.ended) tally.ended++;
            for (const k of r.kinds) tally.kinds[k] = (tally.kinds[k] || 0) + 1;
        }
        resetProcess();
        expect(bad).toEqual([]);
        if (process.env.CHAOS_STATS) process.stdout.write(`chaosRestore ${JSON.stringify(tally)}\n`);
        // The restarts really happened, of every kind
        expect(tally.restarts).toBeGreaterThanOrEqual(Math.floor(SEEDS / 2));
        if (SEEDS >= 20) {
            for (const k of KINDS) expect(tally.kinds[k] || 0).toBeGreaterThan(0);
            // Some games reach gameEnd (the record and stats oracles ran)
            expect(tally.ended).toBeGreaterThan(0);
        }
    }, 3600000);
});
