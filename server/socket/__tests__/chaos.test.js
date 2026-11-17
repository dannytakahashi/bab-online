/**
 * Chaos run over the real handlers: seeded random humans (draws, valid and
 * garbage bids/plays, /lazy /active /leave, disconnects, realistic and
 * multi-socket rejoins, commands from stale sockets and spectators,
 * spectators moving between tables, forceResign, aborts) against a table of
 * humans and bots, started through the real lobby countdown on even seeds,
 * with BAB_FSM_CHECK=1 so every stage and seat transition validates its
 * invariants. After every step the game must be consistent (stage + seat
 * invariants, owner sockets, the playerGames contract, registered seat bots,
 * no stale/spectator command changing a seat, no zombie table) and live;
 * once it ends or aborts nothing may be emitted into it and nothing may be
 * left behind; every resign offer comes a full grace period after its
 * seat's disconnect. Failures print the seed, the stage history, the seat
 * summary and the timer keys.
 *
 * The run itself (actions and oracles) is server/testUtils/chaosEngine.js
 * runSeedInner, shared with the deploy-survival restore tests.
 *
 * CHAOS_SEEDS=<n> overrides the number of seeds (default 200).
 *
 * Also runs complete ambient bot games under CHECK mode and matches their
 * full stage history.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const ambient = require('../../demo/ambientBots');
const GamePhase = require('../../game/GamePhase');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { makeIo, events, mulberry32 } = require('../../testUtils/gameDriver');
const contractCheck = require('../../testUtils/contractCheck');
const { watchSeq } = require('../../testUtils/seqCheck');
const { watchPacing } = require('../../testUtils/pacingInvariants');
const { runSeedInner } = require('../../testUtils/chaosEngine');

const SEEDS = Number(process.env.CHAOS_SEEDS) || 200;

let errorLogs;
let realRandom;

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
    mockDb.current = createMemoryDb({ users: [] });
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        jest.spyOn(l, 'warn').mockImplementation(() => {});
        jest.spyOn(l, 'info').mockImplementation(() => {});
        jest.spyOn(l, 'debug').mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

/**
 * One chaos run, with the seq invariants (testUtils/seqCheck.js) watched
 * over all its emits. Returns a failure description, or {ok}.
 */
async function runSeed(seed) {
    let seqWatch = null;
    let paceWatch = null;
    contractCheck.setContext(`chaos seed ${seed}`);
    const result = await runSeedInner(seed, (io) => { seqWatch = watchSeq(io); paceWatch = watchPacing({ requireResumeInMs: true }); }, { errorLogs });
    const seqResult = seqWatch ? seqWatch.stop() : { failures: [] };
    const paceResult = paceWatch ? paceWatch.stop() : { failures: [] };
    if (result.ok && seqResult.failures.length) return { seed, why: 'seq', failures: seqResult.failures.slice(0, 5) };
    if (result.ok && paceResult.failures.length) return { seed, why: 'pacing', failures: paceResult.failures.slice(0, 5) };
    return result;
}

describe('chaos', () => {
    test(`${SEEDS} seeded chaos runs keep the FSM consistent, live and leak-free`, async () => {
        const processErrors = [];
        const onError = (err) => processErrors.push(err);
        process.on('unhandledRejection', onError);
        process.on('uncaughtException', onError);
        try {
            const failures = [];
            let deep = 0;
            for (let seed = 1; seed <= SEEDS; seed++) {
                const result = await runSeed(seed);
                if (!result.ok) {
                    failures.push(result);
                    if (failures.length >= 3) break;
                } else if (result.hands >= 1) {
                    deep++;
                }
                for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
                GamePhase.resetViolations();
                jest.clearAllTimers();
            }
            if (failures.length) {
                throw new Error(`chaos failures:\n${failures.map((f) => JSON.stringify(f, null, 2)).join('\n')}`);
            }
            expect(processErrors).toEqual([]);
            // Coverage: a good share of runs get past the first hand
            if (SEEDS >= 20) expect(deep).toBeGreaterThanOrEqual(Math.floor(SEEDS / 4));
        } finally {
            process.off('unhandledRejection', onError);
            process.off('uncaughtException', onError);
        }
    }, 600000);
});

describe('full ambient bot games under CHECK mode', () => {
    const HISTORY = /^CREATED DRAWING DRAW_RESOLVING TEAMS_ANNOUNCED( DEALING BIDDING( REDEAL DEALING BIDDING)* PLAYING( TRICK_RESOLVING PLAYING)* TRICK_RESOLVING HAND_RESOLVING){13} ENDED$/;

    test.each([11, 22, 33])('seed %i plays 13 hands to one gameEnd', async (seed) => {
        Math.random = mulberry32(seed);
        const log = [];
        const io = makeIo(log);
        const game = ambient.startBotGame(io);
        for (let t = 0; t < 30 && gameManager.getGameById(game.gameId); t++) {
            await jest.advanceTimersByTimeAsync(60000);
        }
        ambient.stopAmbientActivity();

        expect(events(log, 'gameEnd')).toHaveLength(1);
        expect(events(log, 'abortGame')).toHaveLength(0);
        expect(game._history.join(' ')).toMatch(HISTORY);
        expect(game.handStats.totalHands).toBe(13);
        expect(game.pendingTimerCount).toBe(0);
        expect(gameManager.getGameById(game.gameId)).toBeNull();
        expect(GamePhase.getViolations()).toEqual([]);
        expect(errorLogs).toEqual([]);
    }, 60000);
});
