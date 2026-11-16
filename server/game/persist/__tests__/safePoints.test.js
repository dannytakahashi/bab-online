/**
 * Where the game codec saves (deploy survival, PR 3), over 200 chaos seeds
 * (PERSIST_SAFE_SEEDS overrides). serialize is called at every change of
 * the live game, synchronously (so the stages a single run passes through,
 * DEALING and REDEAL, are seen too) and at every safe point (the end of
 * the run, where the persist store serializes):
 *   - outside the four restore stages (pre-deal, DEALING, REDEAL, terminal)
 *     it is always null;
 *   - at a safe point in BIDDING, PLAYING, TRICK_RESOLVING or
 *     HAND_RESOLVING it is never null (a chaos run never throws, so no
 *     game is tainted);
 *   - all four restore stages and DEALING / REDEAL are reached.
 * Plus the refusals: the demo game, a tainted game (a game timer, a bot
 * action or a bot-path turn continuation that threw; a clean run clears
 * it), a frozen game, a game failing validateGameState.
 */

const { createMemoryDb } = require('../../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../GameManager');
const { Phase } = require('../../GamePhase');
const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');
const contractCheck = require('../../../testUtils/contractCheck');
const { runSeedInner } = require('../../../testUtils/chaosEngine');
const { watchSafePoints } = require('../../../testUtils/restoreKit');
const { mulberry32, makeIo } = require('../../../testUtils/gameDriver');
const codec = require('../gameCodec');

const SEEDS = Number(process.env.PERSIST_SAFE_SEEDS) || 200;

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

describe('the codec saves only at restorable points', () => {
    test(`${SEEDS} chaos seeds`, async () => {
        const seen = { sync: new Set(), saved: new Set() };
        const failures = [];
        const ours = (game) => gameManager.getGameById(game.gameId) === game;
        const watch = watchSafePoints((game) => {
            if (!ours(game)) return;
            const doc = codec.serialize(game);
            if (codec.SAVE_STAGES.has(game.stage)) {
                if (doc === null) failures.push(`safe point in ${game.stage}: ${codec.refusal(game)}`);
                else seen.saved.add(game.stage);
            } else if (doc !== null) {
                failures.push(`safe point in ${game.stage} saved`);
            }
        }, {
            onChange: (game) => {
                if (!ours(game)) return;
                seen.sync.add(game.stage);
                if (!codec.SAVE_STAGES.has(game.stage) && codec.serialize(game) !== null) {
                    failures.push(`${game.stage} saved mid-run`);
                }
            },
        });
        try {
            for (let seed = 1; seed <= SEEDS && failures.length === 0; seed++) {
                contractCheck.setContext(`safe points seed ${seed}`);
                const result = await runSeedInner(seed, () => {}, { errorLogs });
                if (!result.ok) throw new Error(`chaos seed ${seed}: ${JSON.stringify(result).slice(0, 2000)}`);
            }
        } finally {
            watch.stop();
        }
        expect(failures.slice(0, 5)).toEqual([]);
        expect([...seen.saved].sort()).toEqual(['BIDDING', 'HAND_RESOLVING', 'PLAYING', 'TRICK_RESOLVING']);
        expect(seen.sync.has(Phase.DEALING)).toBe(true);
        expect(seen.sync.has(Phase.REDEAL)).toBe(true);
    }, 600000);
});

describe('refusals', () => {
    /** A bot game in PLAYING (the ambient demo game, its flag cleared). */
    async function playingGame() {
        const ambient = require('../../../demo/ambientBots');
        Math.random = mulberry32(5);
        const game = ambient.startBotGame(makeIo([]));
        for (let t = 0; t < 200 && game.stage !== Phase.PLAYING; t++) await jest.advanceTimersByTimeAsync(500);
        ambient.stopAmbientActivity();
        expect(game.stage).toBe(Phase.PLAYING);
        return game;
    }

    test('the demo game is never saved', async () => {
        const game = await playingGame();
        expect(game.isDemo).toBe(true);
        expect(codec.serialize(game, { tournamentId: null })).toBeNull();
        expect(codec.refusal(game)).toBe('demo');
        game.isDemo = false;
        expect(codec.serialize(game, { tournamentId: null })).not.toBeNull();
    });

    test('a tainted game is not saved until a run completes cleanly', async () => {
        const game = await playingGame();
        game.isDemo = false;
        // A game timer whose run throws taints it
        game.setTimer('probe', 10, () => { throw new Error('boom'); });
        await jest.advanceTimersByTimeAsync(10);
        expect(game._tainted).toBe(true);
        expect(codec.refusal(game)).toBe('tainted');
        expect(codec.serialize(game, { tournamentId: null })).toBeNull();
        // ...and the next clean run clears it
        game.setTimer('probe', 10, () => {});
        await jest.advanceTimersByTimeAsync(10);
        expect(game._tainted).toBe(false);
        expect(codec.serialize(game, { tournamentId: null })).not.toBeNull();
        errorLogs.length = 0;
    });

    test('a bot action that throws taints the game, and a clean one clears it', async () => {
        const { botController } = require('../../bot');
        const game = await playingGame();
        game.isDemo = false;
        const seat = game.seat(game.currentTurn);
        expect(seat.controller).toBe('bot');
        expect(codec.refusal(game)).toBeNull();
        botController.scheduleBotAction(makeIo([]), game, 'play', () => { throw new Error('bot boom'); });
        await jest.advanceTimersByTimeAsync(60000);
        expect(game._tainted).toBe(true);
        expect(codec.refusal(game)).toBe('tainted');
        expect(codec.serialize(game, { tournamentId: null })).toBeNull();
        // A later bot action that completes clears it (no game timer runs
        // in between: only BotController's own success path can)
        game._cancelAllTimers();
        botController.scheduleBotAction(makeIo([]), game, 'play', () => {});
        await jest.advanceTimersByTimeAsync(60000);
        expect(game._tainted).toBe(false);
        expect(codec.refusal(game)).toBeNull();
        errorLogs.length = 0;
    });

    /** An io whose room emits throw on `event` (a continuation that throws midway). */
    function throwingIo(event) {
        const base = makeIo([]);
        return {
            ...base,
            to: (room) => ({
                emit: (ev, data) => {
                    if (ev === event) throw new Error(`${ev} boom`);
                    base.to(room).emit(ev, data);
                },
            }),
        };
    }

    /**
     * The ambient bot game in `stage` with a bot's turn scheduled and no
     * hold open (in BIDDING: after the first bid, so the first hand's
     * firstTurn hold cannot re-schedule the turn), its flag cleared.
     */
    async function gameAt(stage) {
        const ambient = require('../../../demo/ambientBots');
        Math.random = mulberry32(5);
        const game = ambient.startBotGame(makeIo([]));
        const ready = () => game.stage === stage && !game.resume && (stage !== Phase.BIDDING || game.getBidCount() >= 1);
        for (let t = 0; t < 2000 && !ready(); t++) await jest.advanceTimersByTimeAsync(10);
        ambient.stopAmbientActivity();
        expect(game.stage).toBe(stage);
        game.isDemo = false;
        return game;
    }

    test.each([
        ['handlePostBid', Phase.BIDDING, 'bid'],
        ['handlePostPlay', Phase.PLAYING, 'play'],
    ])('a bot-path %s continuation that rejects taints the game', async (_what, stage, actionType) => {
        const { triggerBotIfNeeded } = require('../../../socket/gameHandlers');
        const game = await gameAt(stage);
        expect(game.seat(game.currentTurn).controller).toBe('bot');
        // Not the trick's 4th card / the last bid: the continuation broadcasts updateTurn
        if (stage === Phase.BIDDING) expect(game.getBidCount()).toBeLessThan(3);
        else expect(game.playedCardsIndex).toBeLessThan(3);
        expect(codec.refusal(game)).toBeNull();
        const turn = game.currentTurn;
        // The bot's own action completes (BotController clears the taint);
        // its continuation then rejects asynchronously and taints the game
        triggerBotIfNeeded(throwingIo('updateTurn'), game, actionType);
        for (let t = 0; t < 100 && game.currentTurn === turn; t++) await jest.advanceTimersByTimeAsync(100);
        expect(game.currentTurn).not.toBe(turn);
        await jest.advanceTimersByTimeAsync(0);
        expect(game._tainted).toBe(true);
        expect(codec.refusal(game)).toBe('tainted');
        expect(codec.serialize(game, { tournamentId: null })).toBeNull();
        expect(errorLogs.some((e) => e.msg === `${_what} failed`)).toBe(true);
        errorLogs.length = 0;
    });

    test('a frozen game is not saved, emits nothing and starts no timer', async () => {
        const game = await playingGame();
        game.isDemo = false;
        const log = [];
        const io = makeIo(log);
        const seq = game.eventSeq;
        const epoch = game.epoch;
        const alive = game.aliveCheck();
        expect(game.freeze()).toBe(true);
        expect(game.freeze()).toBe(false);
        expect(game.epoch).toBe(epoch + 1);
        expect(alive()).toBe(false);
        expect(game.pendingTimerCount).toBe(0);
        expect(game.resume).toBeNull();
        game.broadcast(io, 'updateTurn', { currentTurn: 1 });
        game.sendToPlayer(io, 'x', 'gameStart', {});
        game.emitUnsequenced(io, 'spectatorsUpdated', {});
        expect(log).toEqual([]);
        expect(game.eventSeq).toBe(seq);
        expect(game.setTimer('k', 10, () => {})).toBe(false);
        expect(game.scheduleResume('trick', 10, () => {})).toBe(false);
        await expect(game.pause(10)).resolves.toBe(false);
        await expect(game.hold('trick', 10)).resolves.toBe(false);
        expect(game.pendingTimerCount).toBe(0);
        expect(game.isTerminal()).toBe(false);
        expect(codec.refusal(game)).toBe('frozen');
    });

    test('a game failing validateGameState is not saved', async () => {
        const game = await playingGame();
        game.isDemo = false;
        game.cardIndex += 1;
        expect(codec.refusal(game)).toBe('invalid');
        expect(codec.serialize(game, { tournamentId: null })).toBeNull();
        game.cardIndex -= 1;
    });
});
