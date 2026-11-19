/**
 * The restored abandon (deploy survival PR 5, persist/restoreGame.js;
 * decision 4, owner answer b): a restored table nobody comes back to is
 * aborted RESTORE_ABANDON_MS (10 min, casual) after the adoption, through
 * gameLifecycle.abortGame: the room gets abortGame 'All players
 * disconnected', the game is retired, every owner's activeGameId pointer
 * is cleared, and no gameRecords document or stats are written. While it
 * waits the gate is closed (no bot acts, nothing is decided in the owners'
 * names) and the normal abandon windows (seatLifecycle.maybeAbort:
 * SOLO_ABANDON_MS, ABANDON_MS) do not start, so a grace that runs out with
 * nobody connected neither aborts sooner nor throws. An owner back before
 * then cancels it (from then on the normal presence rules apply).
 * opts.abandonMs is the tournament table's 5 min (PR 6).
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const SeatState = require('../../SeatState');
const reconnectHandlers = require('../../../socket/reconnectHandlers');
const { makeIo, makeSocket } = require('../../../testUtils/gameDriver');
const { fixedBotDelays, silenceBotChat, decisionLog } = require('../../../testUtils/persistHarness');
const { playUntil, freshProcess } = require('../../../testUtils/restoredTables');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');
const restoreGame = require('../restoreGame');

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
    process.on('unhandledRejection', onRejection);
});

afterEach(() => {
    process.off('unhandledRejection', onRejection);
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
    expect(asyncErrors).toEqual([]);
    expect(errorLogs).toEqual([]);
});

function onRejection(err) {
    asyncErrors.push(err);
}

const fixtures = {
    '1 human + 3 bots': { humans: 1, seed: 21 },
    '4 humans': { humans: 4, seed: 22 },
};

async function adopted(humans, seed, opts = {}) {
    const fixture = await playUntil({
        mockDb, seed, humans,
        until: (g) => g.stage === Phase.PLAYING && g.dealSeq >= 2 && g.playedCardsIndex === 1,
    });
    freshProcess(mockDb, fixture.users, { gameId: fixture.gameId });
    fixedBotDelays(1000);
    silenceBotChat();
    const decisions = decisionLog();
    const log = [];
    const io = makeIo(log);
    const game = restoreGame.adoptGame(io, fixture.doc, opts);
    return { fixture, io, log, game, decisions };
}

const pointer = (username) => mockDb.current.users.docs.find((u) => u.username === username)?.activeGameId ?? null;
const statsOf = (username) => {
    const u = { ...mockDb.current.users.docs.find((d) => d.username === username) };
    delete u.activeGameId;
    return u;
};
const userStats = (fixture) => fixture.users.map((u) => statsOf(u.username));

describe.each(Object.entries(fixtures))('%s, nobody back', (_name, { humans, seed }) => {
    test('live at 599 s, aborted at 600 s: pointers cleared, no gameRecords, no stats, no bot action', async () => {
        const { fixture, log, game, decisions } = await adopted(humans, seed);
        const statsBefore = userStats(fixture);
        for (const u of fixture.users) expect(pointer(u.username)).toBe(game.gameId);
        const mark = log.length;
        // Through every seat's grace (60 s) and well past the solo / normal
        // abandon windows' own timing
        await jest.advanceTimersByTimeAsync(restoreGame.RESTORE_ABANDON_MS - 1000);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        expect(game.stage).toBe(Phase.PLAYING);
        expect(game.hasTimer('abandon')).toBe(false);
        for (const s of game.seatList().filter((x) => x.controller === 'human')) expect(s.presence).toBe(SeatState.Presence.RESIGNABLE);
        expect(decisions.entries).toEqual([]);
        expect(log.slice(mark).map((e) => e.event).filter((e) => ['cardPlayed', 'bidReceived', 'updateTurn', 'abortGame', 'resignationAvailable'].includes(e))).toEqual([]);

        await jest.advanceTimersByTimeAsync(1000);
        await jest.advanceTimersByTimeAsync(100);
        expect(game.stage).toBe(Phase.ABORTED);
        expect(gameManager.getGameById(game.gameId)).toBeFalsy();
        const aborts = log.filter((e) => e.event === 'abortGame');
        expect(aborts).toHaveLength(1);
        expect(aborts[0].data.reason).toBe('All players disconnected');
        for (const u of fixture.users) expect(pointer(u.username)).toBeNull();
        expect(mockDb.current.gameRecords.docs).toEqual([]);
        expect(userStats(fixture)).toEqual(statsBefore);
        expect(decisions.entries).toEqual([]);
        // Bots unregistered, nothing pending
        expect([...botController.pendingActions.keys()].filter((k) => k.startsWith(`${game.gameId}:`))).toEqual([]);
        expect(game.pendingTimerCount).toBe(0);
        decisions.stop();
    });
});

describe('an owner back', () => {
    test('at 9 min: the restored abandon is cancelled and the table plays on', async () => {
        const { fixture, io, log, game, decisions } = await adopted(1, 23);
        await jest.advanceTimersByTimeAsync(9 * 60000);
        const sock = makeSocket('back-9', log, io);
        gameManager.registerUser(sock.id, fixture.users[0].username);
        await reconnectHandlers.rejoinGame(sock, io, { gameId: game.gameId, username: fixture.users[0].username });
        expect(game.seat(game.seatByOwnerSocket(sock.id)).presence).toBe(SeatState.Presence.CONNECTED);
        expect(game.hasTimer(restoreGame.ABANDON_KEY)).toBe(false);
        expect(game.restored.ownerBack).toBe(true);
        await jest.advanceTimersByTimeAsync(2 * 60000);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        expect(log.map((e) => e.event)).not.toContain('abortGame');
        // The gate opened: the bots acted
        expect(decisions.entries.length).toBeGreaterThan(0);
        expect(pointer(fixture.users[0].username)).toBe(game.gameId);
        decisions.stop();
    });

    test('back then gone again: the normal presence rules (the solo window), not the restored abandon', async () => {
        const { fixture, io, log, game, decisions } = await adopted(1, 24);
        await jest.advanceTimersByTimeAsync(30000);
        const sock = makeSocket('back-and-gone', log, io);
        gameManager.registerUser(sock.id, fixture.users[0].username);
        await reconnectHandlers.rejoinGame(sock, io, { gameId: game.gameId, username: fixture.users[0].username });
        const pos = game.seatByOwnerSocket(sock.id);
        require('../../../socket/seatLifecycle').disconnectOwner(io, game, pos, sock.id);
        expect(game.hasTimer('abandon')).toBe(true);
        expect(game.hasTimer(restoreGame.ABANDON_KEY)).toBe(false);
        decisions.stop();
    });
});

describe('the tournament window is a parameter (PR 6)', () => {
    test('abandonMs RESTORE_ABANDON_TOURNAMENT_MS: aborted at 5 min', async () => {
        const { log, game, decisions } = await adopted(1, 25, { abandonMs: restoreGame.RESTORE_ABANDON_TOURNAMENT_MS });
        await jest.advanceTimersByTimeAsync(restoreGame.RESTORE_ABANDON_TOURNAMENT_MS - 1000);
        expect(game.stage).toBe(Phase.PLAYING);
        await jest.advanceTimersByTimeAsync(1100);
        expect(game.stage).toBe(Phase.ABORTED);
        expect(log.filter((e) => e.event === 'abortGame')).toHaveLength(1);
        decisions.stop();
    });
});
