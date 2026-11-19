/**
 * GameState.suspend / unsuspend (deploy survival PR 5): the REVERSIBLE
 * holder self-fence (freeze() stays one-way). While suspended the game is
 * stopped in place with its epoch kept: no emit (broadcast, sendToPlayer,
 * unsequenced: no seq used), no timer, pause or bot action fires (each is
 * remembered with what was left of it; one started meanwhile waits for the
 * thaw), no turn input is taken, an abort waits for the thaw, and the codec
 * refuses to save it. unsuspend(io) puts everything back in due order, the
 * bid clock through bidClock.afterSuspend -> onTurn (its same-turn resume:
 * what is left, topped up once to BID_CLOCK_RESUME_MIN_MS; a running clock
 * is stopped and announced anew, since the clients' countdown ran on),
 * never dropped. A seat's grace is 60 s of unsuspended time.
 *
 * The continuation oracle: the same seeded game played twice, once as is
 * and once suspended at EVERY safe point (for the rest of a 500 ms step),
 * makes the same bot decisions and ends with the same score, stats and
 * gameRecords document. The humans play by a fixed rule and let the bid
 * clock bid for them on some deals (its deadline survives each suspension).
 * A deterministic driver, not chaosEngine: chaos actions are drawn from the
 * run's RNG against wall time, so any pause changes what the run does; the
 * chaos block below only checks that random suspensions keep every chaos
 * oracle (seq, FSM, leaks) green.
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const GamePhase = require('../../GamePhase');
const SeatState = require('../../SeatState');
const gameHandlers = require('../../../socket/gameHandlers');
const gameLifecycle = require('../../../socket/gameLifecycle');
const profileHandlers = require('../../../socket/profileHandlers');
const { decisionLog } = require('../../../testUtils/persistHarness');
const { watchSafePoints } = require('../../../testUtils/restoreKit');
const { startTable, driveHumans, STEP_MS } = require('../../../testUtils/restoredTables');
const { runSeedInner } = require('../../../testUtils/chaosEngine');
const { watchSeq } = require('../../../testUtils/seqCheck');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');
const codec = require('../gameCodec');

const SEEDS = Number(process.env.PERSIST_SUSPEND_SEEDS) || 10;
const CHAOS_SEEDS = Number(process.env.PERSIST_SUSPEND_CHAOS_SEEDS) || 40;

let errorLogs;
let realRandom;
let asyncErrors;

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
    errorLogs = [];
    asyncErrors = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        for (const m of ['warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const json = (v) => JSON.parse(JSON.stringify(v));
const track = (p) => {
    if (p && typeof p.then === 'function') p.catch((err) => asyncErrors.push(err));
    return p;
};

function outcome(game) {
    const record = mockDb.current.gameRecords.docs.find((d) => d.gameId === game.gameId) || null;
    const stored = record ? json(record) : null;
    if (stored) {
        for (const k of ['_id', 'completedAt', 'gameId', 'createdAt', 'durationMs', 'startedAt', 'endedAt']) delete stored[k];
    }
    return {
        stage: game.stage,
        score: json(game.score),
        rainbows: json(game.rainbows),
        handStats: json(game.handStats),
        playerStats: json(game.playerStats),
        trickHistory: json(game.trickHistory),
        record: stored,
    };
}

/** On these deals the humans let the bid clock bid for them. */
const waitOut = (game) => game.dealSeq % 4 === 2;

/**
 * One whole game. suspendAll: suspend at every safe point; the next step
 * checks nothing was emitted meanwhile and thaws it.
 */
async function playGame(seed, { suspendAll }) {
    const humans = seed % 3 === 0 ? 2 : 1;
    const decisions = decisionLog();
    const t = startTable({ mockDb, seed, humans, prefix: 'sus' });
    const { io, log, socks, game } = t;
    let suspendedAt = null;
    const stats = { suspensions: 0, clockResumes: 0, emitsWhileSuspended: 0, decisionsWhileSuspended: 0 };
    let decisionsAt = 0;
    const watch = watchSafePoints((g) => {
        if (!suspendAll || g !== game || g.isTerminal() || g.isSuspended) return;
        if (g.suspend()) {
            suspendedAt = log.length;
            decisionsAt = decisions.entries.length;
            stats.suspensions++;
        }
    });
    try {
        for (let i = 0; i < 40000 && !game.isTerminal(); i++) {
            await jest.advanceTimersByTimeAsync(STEP_MS);
            if (game.isSuspended) {
                stats.emitsWhileSuspended += log.length - suspendedAt;
                stats.decisionsWhileSuspended += decisions.entries.length - decisionsAt;
                expect(codec.serialize(game)).toBeNull();
                const runningBefore = game.bidClock?.running && game.hasTimer('bidClock') ? game.bidClock.endAt - Date.now() : null;
                const mark = log.length;
                game.unsuspend(io);
                if (runningBefore != null) {
                    // The same-turn resume re-announces the running clock
                    // with what was left of it (topped up once to the floor)
                    const floor = Math.min(SeatState.BID_CLOCK_RESUME_MIN_MS, game.bidClock.durationMs);
                    const ann = log.slice(mark).filter((e) => e.event === 'bidClock');
                    const want = Math.round(runningBefore < floor && game.bidClock.toppedUp ? floor : runningBefore);
                    expect(ann.map((e) => [e.data.running, e.data.running ? e.data.inMs : e.data.reason])).toEqual([[false, 'turn'], [true, want]]);
                    stats.clockResumes++;
                }
            }
            if (game.isTerminal()) break;
            track(driveHumans(io, game, socks, { skipBid: waitOut }));
        }
        await jest.advanceTimersByTimeAsync(5000); // the stats writes
    } finally {
        watch.stop();
        decisions.stop();
        t.done();
    }
    expect(game.stage).toBe(Phase.ENDED);
    const clock = log.filter((e) => e.event === 'bidClock' && e.data.reason === 'timeout').length;
    return {
        outcome: outcome(game),
        decisions: decisions.entries.map(({ gameId, ...rest }) => rest),
        timeouts: clock,
        stats,
    };
}

describe('suspend at every safe point: the same continuation', () => {
    test(`${SEEDS} seeds: identical bot decisions, score, stats and gameRecords doc; nothing emitted while suspended`, async () => {
        profileHandlers._setStatsRetryDelaysForTests([1, 1]);
        const failures = [];
        let totalSuspensions = 0;
        let totalTimeouts = 0;
        try {
            for (let seed = 1; seed <= SEEDS; seed++) {
                const ref = await playGame(seed, { suspendAll: false });
                const sus = await playGame(seed, { suspendAll: true });
                totalSuspensions += sus.stats.suspensions;
                totalTimeouts += sus.timeouts;
                expect(sus.stats.emitsWhileSuspended).toBe(0);
                expect(sus.stats.decisionsWhileSuspended).toBe(0);
                // The bid clock still bid for the waiting humans, as often
                expect(sus.timeouts).toBe(ref.timeouts);
                try {
                    expect({ decisions: sus.decisions, ...sus.outcome }).toEqual({ decisions: ref.decisions, ...ref.outcome });
                } catch (err) {
                    let at = 0;
                    while (at < ref.decisions.length && JSON.stringify(ref.decisions[at]) === JSON.stringify(sus.decisions[at])) at++;
                    failures.push({ seed, at, want: ref.decisions[at], got: sus.decisions[at], msg: err.message.slice(0, 800) });
                }
                expect(ref.outcome.record).not.toBeNull();
            }
        } finally {
            profileHandlers._setStatsRetryDelaysForTests();
        }
        expect(failures).toEqual([]);
        expect(totalSuspensions).toBeGreaterThan(SEEDS * 500);
        expect(totalTimeouts).toBeGreaterThan(0);
        expect(asyncErrors).toEqual([]);
        expect(errorLogs).toEqual([]);
    }, 600000);
});

/** A 1-human table at the human's open bid turn. */
async function atHumanBid(seed = 31) {
    const t = startTable({ mockDb, seed, humans: 1, prefix: 'sb' });
    const { game, io, socks } = t;
    const target = () => game.stage === Phase.BIDDING && !game.resume && game.seat(game.currentTurn).controller === 'human' &&
        game.playerBids[game.currentTurn - 1] == null && game.dealSeq >= 2;
    for (let i = 0; i < 4000 && !target(); i++) {
        await jest.advanceTimersByTimeAsync(100);
        if (!target()) track(driveHumans(io, game, socks));
    }
    expect(target()).toBe(true);
    return t;
}

describe('the bid clock across a suspension', () => {
    const DELAY = () => SeatState.bidClockDelayMs();
    const CLOCK = () => SeatState.bidClockMs();

    test('running with 25 s left: the same 25 s after the thaw, re-announced; bids 0 when they run out', async () => {
        const t = await atHumanBid();
        const { game, io, log } = t;
        const pos = game.currentTurn;
        await jest.advanceTimersByTimeAsync(DELAY() + 5000);
        expect(game.bidClock).toMatchObject({ pos, running: true });
        const left = game.bidClock.endAt - Date.now();
        expect(game.suspend()).toBe(true);
        expect(game.suspend()).toBe(false);
        const mark = log.length;
        await jest.advanceTimersByTimeAsync(60000);
        expect(log.length).toBe(mark);
        expect(game.playerBids[pos - 1]).toBeUndefined();
        expect(game.unsuspend(io)).toBe(true);
        expect(game.unsuspend(io)).toBe(false);
        const ann = log.slice(mark).filter((e) => e.event === 'bidClock');
        // stopped, then running again with what was left (the clients'
        // countdown ran on while nothing was emitted)
        expect(ann.map((e) => [e.data.running, e.data.running ? e.data.inMs : e.data.reason])).toEqual([[false, 'turn'], [true, left]]);
        await jest.advanceTimersByTimeAsync(left - 10);
        expect(game.playerBids[pos - 1]).toBeUndefined();
        await jest.advanceTimersByTimeAsync(20);
        expect(game.playerBids[pos - 1]).toBe('0');
        t.done();
    });

    test('running with 4 s left: topped up once to the resume floor (the same-turn resume rule)', async () => {
        const t = await atHumanBid(32);
        const { game, io, log } = t;
        const pos = game.currentTurn;
        await jest.advanceTimersByTimeAsync(DELAY() + CLOCK() - 4000);
        game.suspend();
        const mark = log.length;
        await jest.advanceTimersByTimeAsync(30000);
        game.unsuspend(io);
        const floor = Math.min(SeatState.BID_CLOCK_RESUME_MIN_MS, CLOCK());
        expect(log.slice(mark).filter((e) => e.event === 'bidClock' && e.data.running).map((e) => e.data.inMs)).toEqual([floor]);
        expect(game.bidClock.toppedUp).toBe(true);
        await jest.advanceTimersByTimeAsync(floor + 10);
        expect(game.playerBids[pos - 1]).toBe('0');
        t.done();
    });

    test('in its pre-wait: the rest of the pre-wait after the thaw, then the full clock', async () => {
        const t = await atHumanBid(33);
        const { game, io, log } = t;
        const pos = game.currentTurn;
        await jest.advanceTimersByTimeAsync(4000);
        expect(game.bidClock).toMatchObject({ pos, running: false });
        game.suspend();
        await jest.advanceTimersByTimeAsync(20000);
        const mark = log.length;
        game.unsuspend(io);
        expect(log.slice(mark).filter((e) => e.event === 'bidClock')).toEqual([]);
        await jest.advanceTimersByTimeAsync(DELAY() - 4000 - 10);
        expect(log.slice(mark).filter((e) => e.event === 'bidClock')).toEqual([]);
        await jest.advanceTimersByTimeAsync(20);
        expect(log.slice(mark).filter((e) => e.event === 'bidClock').map((e) => [e.data.running, e.data.inMs])).toEqual([[true, CLOCK()]]);
        t.done();
    });
});

describe('while suspended', () => {
    test('turn input is refused, timers started meanwhile wait for the thaw, an abort runs at the thaw', async () => {
        const t = await atHumanBid(34);
        const { game, io, log, socks } = t;
        const pos = game.currentTurn;
        game.suspend();
        const mark = log.length;
        await gameHandlers.playerBid(socks[0], io, { bid: '1' });
        expect(game.playerBids[pos - 1]).toBeUndefined();
        expect(log.slice(mark).map((e) => [e.event, e.data?.reason])).toEqual([['actionRejected', 'not_your_turn']]);
        // A timer set meanwhile is remembered with its full time
        let fired = 0;
        expect(game.setTimer('probe', 1000, () => { fired++; })).toBe(true);
        expect(game.hasTimer('probe')).toBe(true);
        await jest.advanceTimersByTimeAsync(5000);
        expect(fired).toBe(0);
        // An abort waits for the thaw (never while ownership is in doubt)
        expect(await gameLifecycle.abortGame(io, game, 'probe abort')).toBe(false);
        expect(game.stage).toBe(Phase.BIDDING);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        expect(log.slice(mark).filter((e) => e.event === 'abortGame')).toEqual([]);
        game.unsuspend(io);
        await jest.advanceTimersByTimeAsync(0);
        expect(game.stage).toBe(Phase.ABORTED);
        expect(log.filter((e) => e.event === 'abortGame').map((e) => e.data.reason)).toEqual(['probe abort']);
        expect(fired).toBe(0); // terminal: the remembered timer never runs
        t.done();
    });

    test('suspended then fenced (freeze): nothing remembered ever runs, abortGame is a no-op', async () => {
        const t = await atHumanBid(35);
        const { game, io, log } = t;
        const epoch = game.epoch;
        game.suspend();
        expect(game.epoch).toBe(epoch);
        expect(game.freeze()).toBe(true);
        expect(game.isSuspended).toBe(false);
        const mark = log.length;
        expect(await gameLifecycle.abortGame(io, game, 'fenced')).toBe(false);
        await jest.advanceTimersByTimeAsync(120000);
        expect(log.length).toBe(mark);
        expect(game.stage).toBe(Phase.BIDDING);
        expect([...botController.pendingActions.keys()].filter((k) => k.startsWith(`${game.gameId}:`))).toEqual([]);
        expect(game.unsuspend(io)).toBe(false);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        gameManager.games.delete(game.gameId);
        t.done();
    });

    // Chaos seeds 43, 76, 82, ... ("seat N resignable after 59740ms"): a
    // grace started while suspended was shortened by how long the table had
    // already been suspended when the owner dropped
    test('an owner who drops while suspended gets the full 60 s of grace from the thaw', async () => {
        const t = await atHumanBid(37);
        const { game, io, socks } = t;
        const pos = game.seatList().find((s) => s.controller === 'human').position;
        expect(game.suspend()).toBe(true);
        await jest.advanceTimersByTimeAsync(10000);
        const queueHandlers = require('../../../socket/queueHandlers');
        await queueHandlers.handleDisconnect(socks[0], io);
        const seat = game.seat(pos);
        expect(seat.presence).toBe('grace');
        await jest.advanceTimersByTimeAsync(5000);
        const thawAt = Date.now();
        game.unsuspend(io);
        expect(seat.absentSince).toBe(thawAt);
        expect(seat.graceDeadline).toBe(thawAt + 60000);
        await jest.advanceTimersByTimeAsync(60000 - 10);
        expect(seat.presence).toBe('grace');
        await jest.advanceTimersByTimeAsync(20);
        expect(seat.presence).toBe('resignable');
        expect(seat.resignableAt - seat.absentSince).toBe(60000);
        t.done();
    });

    test('a frozen game: abortGame emits, retires and clears nothing', async () => {
        const t = await atHumanBid(36);
        const { game, io, log } = t;
        game.freeze();
        const mark = log.length;
        expect(await gameLifecycle.abortGame(io, game, 'frozen')).toBe(false);
        expect(log.length).toBe(mark);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        gameManager.games.delete(game.gameId);
        t.done();
    });
});

describe('chaos runs with random suspensions keep every chaos oracle', () => {
    test(`${CHAOS_SEEDS} seeds`, async () => {
        const failures = [];
        for (let seed = 1; seed <= CHAOS_SEEDS && failures.length < 3; seed++) {
            let seqWatch = null;
            mockDb.current = require('../../../testUtils/memoryDb').createMemoryDb({ users: [] });
            // Suspend the table now and thaw it 0.1-3 s later (a plain
            // timer: the thaw always comes, as the store's re-read would)
            const extraActions = (ctx) => [[2, () => {
                const g = ctx.game;
                if (!g || g.isTerminal() || g.isSuspended || !g.suspend()) return;
                const io = ctx.io;
                setTimeout(() => g.unsuspend(io), ctx.randInt(100, 3000));
            }]];
            const result = await runSeedInner(seed, (io) => { seqWatch = watchSeq(io); }, { errorLogs, extraActions });
            const seq = seqWatch ? seqWatch.stop() : { failures: [] };
            if (!result.ok) failures.push(result);
            else if (seq.failures.length) failures.push({ seed, why: 'seq', failures: seq.failures.slice(0, 3) });
            for (const g of gameManager.games.values()) if (g.isSuspended) g.unsuspend(null);
            for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
            GamePhase.resetViolations();
            jest.clearAllTimers();
        }
        expect(failures).toEqual([]);
    }, 600000);

    // CI run 44594999016 (seed 6 on Node 24; seeds 142 and 246 on Node 26):
    // the step budget ran out while the table was suspended, so the run's
    // own 'chaos-end' abort was deferred to the thaw (as the plan says: an
    // abort never runs while ownership is in doubt). The table's one
    // abortGame came a moment later; the oracle must find it there
    test('the step budget runs out on a suspended table: the chaos-end abort waits for the thaw and is the terminal event', async () => {
        for (const seed of [7, 8]) {
            let seqWatch = null;
            mockDb.current = require('../../../testUtils/memoryDb').createMemoryDb({ users: [] });
            // Every draw picks the suspension (its weight dwarfs the built-in actions); the thaw comes 1.5 s later
            const extraActions = (ctx) => [[1e9, () => {
                const g = ctx.game;
                if (!g || g.isTerminal() || g.isSuspended || !g.suspend()) return;
                const io = ctx.io;
                setTimeout(() => g.unsuspend(io), 1500);
            }]];
            const abort = jest.spyOn(gameLifecycle, 'abortGame');
            const result = await runSeedInner(seed, (io) => { seqWatch = watchSeq(io); }, { errorLogs, extraActions, maxSteps: 1 });
            const seq = seqWatch.stop();
            // The pinned interleaving: the budget's abort met a suspended table and was deferred
            const end = abort.mock.calls.findIndex((c) => c[2] === 'chaos-end');
            expect(end).toBeGreaterThanOrEqual(0);
            await expect(abort.mock.results[end].value).resolves.toBe(false);
            abort.mockRestore();
            expect(result).toMatchObject({ ok: true, steps: 1 });
            expect(seq.failures).toEqual([]);
            for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
            GamePhase.resetViolations();
            jest.clearAllTimers();
        }
    });
});
