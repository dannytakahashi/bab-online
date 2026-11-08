/**
 * Tests for ambient bot activity: enablement rules, chat seeding, and the
 * self-driving bot game.
 */

const fakeIo = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } };

let ambient;
let gameManager;

beforeEach(() => {
    jest.resetModules();
    ambient = require('../ambientBots');
    gameManager = require('../../game/GameManager');
});

afterEach(() => {
    ambient.stopAmbientActivity();
    jest.useRealTimers();
});

describe('shouldEnable', () => {
    test('defaults on in production', () => {
        expect(ambient.shouldEnable({ NODE_ENV: 'production' })).toBe(true);
    });

    test('can be disabled in production', () => {
        expect(ambient.shouldEnable({ NODE_ENV: 'production', AMBIENT_BOTS: 'false' })).toBe(false);
    });

    test('defaults off in development', () => {
        expect(ambient.shouldEnable({ NODE_ENV: 'development' })).toBe(false);
    });

    test('can be enabled in development', () => {
        expect(ambient.shouldEnable({ NODE_ENV: 'development', AMBIENT_BOTS: 'true' })).toBe(true);
    });
});

describe('seedMainRoomChat', () => {
    test('seeds an empty room with back-dated messages', () => {
        expect(ambient.seedMainRoomChat()).toBe(true);

        const messages = gameManager.mainRoomMessages;
        expect(messages.length).toBeGreaterThanOrEqual(3);
        for (const m of messages) {
            expect(typeof m.username).toBe('string');
            expect(typeof m.message).toBe('string');
            expect(m.timestamp).toBeLessThanOrEqual(Date.now());
        }
        // Timestamps ascend so the history reads naturally
        for (let i = 1; i < messages.length; i++) {
            expect(messages[i].timestamp).toBeGreaterThan(messages[i - 1].timestamp);
        }
    });

    test('does not overwrite existing chat history', () => {
        gameManager.mainRoomMessages.push({ username: 'real', message: 'hi', timestamp: Date.now() });
        expect(ambient.seedMainRoomChat()).toBe(false);
        expect(gameManager.mainRoomMessages).toHaveLength(1);
    });
});

describe('maybePostChat', () => {
    test('posts when the room has been quiet', () => {
        gameManager.mainRoomMessages.push({
            username: 'real', message: 'old', timestamp: Date.now() - 60 * 60 * 1000
        });
        expect(ambient.maybePostChat(fakeIo)).toBe(true);
        expect(gameManager.mainRoomMessages).toHaveLength(2);
    });

    test('stays silent while the room is active', () => {
        gameManager.mainRoomMessages.push({
            username: 'real', message: 'recent', timestamp: Date.now()
        });
        expect(ambient.maybePostChat(fakeIo)).toBe(false);
    });
});

describe('startBotGame', () => {
    test('creates a 4-bot game that reaches bidding on its own', async () => {
        jest.useFakeTimers();

        const game = ambient.startBotGame(fakeIo);
        expect(game.isDemo).toBe(true);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        expect(game.phase).toBe('drawing');

        // Bots draw on staggered timers, then handleDrawComplete assigns
        // positions and starts bidding (drawIndex is reset during hand setup)
        await jest.advanceTimersByTimeAsync(30 * 1000);

        expect(game.players.size).toBe(4);
        expect(['bidding', 'playing']).toContain(game.phase);
        for (const [sid] of game.players) {
            expect(game.isBot(sid)).toBe(true);
        }
        expect(game.seatList().map((s) => s.controller)).toEqual(['bot', 'bot', 'bot', 'bot']);

        const { botController } = require('../../game/bot');
        botController.cleanupGame(game.gameId);
    });

    test('demo games appear in the in-progress list once underway', async () => {
        jest.useFakeTimers();

        const game = ambient.startBotGame(fakeIo);
        await jest.advanceTimersByTimeAsync(30 * 1000);

        const inProgress = gameManager.getInProgressGames();
        expect(inProgress.some(g => g.gameId === game.gameId)).toBe(true);

        const { botController } = require('../../game/bot');
        botController.cleanupGame(game.gameId);
    });

    test('announces in chat exactly once, only after the game is visible', async () => {
        jest.useFakeTimers();
        // Pre-fill chat so maybePostChat stays quiet during the test
        gameManager.mainRoomMessages.push({ username: 'real', message: 'hi', timestamp: Date.now() });

        const game = ambient.startBotGame(fakeIo);

        // Still drawing — no announcement yet
        ambient.tick(fakeIo);
        expect(gameManager.mainRoomMessages).toHaveLength(1);

        await jest.advanceTimersByTimeAsync(30 * 1000);
        expect(game.phase).not.toBe('drawing');

        // Visible — announce once, then stay quiet
        ambient.tick(fakeIo);
        ambient.tick(fakeIo);
        expect(gameManager.mainRoomMessages).toHaveLength(2);
        expect(gameManager.mainRoomMessages[1].message).toMatch(/game/i);

        const { botController } = require('../../game/bot');
        botController.cleanupGame(game.gameId);
    });
});

describe('always-on lifecycle (pacing.js AMBIENT_CHECK_MS / AMBIENT_RESTART_MS / AMBIENT_PREGAME)', () => {
    let pacing;
    let io;
    let log;
    const demoGames = () => [...gameManager.games.values()].filter((g) => g.isDemo && !g.isTerminal());

    beforeEach(() => {
        jest.useFakeTimers();
        pacing = require('../../game/pacing');
        log = [];
        io = require('../../testUtils/gameDriver').makeIo(log);
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const { gameLogger, logger } = require('../../utils/logger');
        for (const l of [gameLogger, logger]) for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    });

    afterEach(() => {
        for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
        jest.clearAllTimers();
        jest.restoreAllMocks();
    });

    test('the poll and the gap between games are 5 s each', () => {
        expect(pacing().AMBIENT_CHECK_MS).toBe(5000);
        expect(pacing().AMBIENT_RESTART_MS).toBe(5000);
    });

    test('a new demo game is listed (lobbiesUpdated at DEALING) within 1 s of its start', async () => {
        const game = ambient.startBotGame(io);
        expect(pacing(game).TEAMS_MS).toBe(0);
        await jest.advanceTimersByTimeAsync(1000);
        expect(gameManager.getInProgressGames().some((g) => g.gameId === game.gameId)).toBe(true);
        const listed = log.filter((l) => l.event === 'lobbiesUpdated' && l.data.inProgressGames.some((g) => g.gameId === game.gameId));
        expect(listed.length).toBeGreaterThan(0);
        // From the deal on (it is listed), the standard timing applies
        expect(pacing(game).TEAMS_MS).toBe(pacing().TEAMS_MS);
        expect(pacing(game).TRICK_VIEW_MS).toBe(pacing().TRICK_VIEW_MS);
    });

    test('a spectated demo game keeps the standard pre-game timing', () => {
        const game = ambient.startBotGame(io);
        game.spectators.set('watcher', { username: 'w' });
        expect(pacing(game).TEAMS_MS).toBe(pacing().TEAMS_MS);
        game.spectators.clear();
    });

    test('a finished game is replaced within AMBIENT_CHECK_MS + AMBIENT_RESTART_MS; never two at once', async () => {
        ambient.startAmbientActivity(io);
        const [first] = demoGames();
        expect(first).toBeDefined();
        await jest.advanceTimersByTimeAsync(1000);
        gameManager.endGame(first.gameId, io);
        expect(demoGames()).toHaveLength(0);
        const P = pacing();
        let max = 0;
        for (let t = 0; t < P.AMBIENT_CHECK_MS + P.AMBIENT_RESTART_MS; t += 500) {
            await jest.advanceTimersByTimeAsync(500);
            max = Math.max(max, demoGames().length);
        }
        expect(demoGames()).toHaveLength(1);
        expect(demoGames()[0].gameId).not.toBe(first.gameId);
        // ...and over a while of play there is never a second one
        for (let t = 0; t < 120000; t += 1000) {
            await jest.advanceTimersByTimeAsync(1000);
            max = Math.max(max, demoGames().length);
        }
        expect(max).toBe(1);
    });

    test('a recycled (wedged) game is replaced', async () => {
        ambient.startAmbientActivity(io);
        const [first] = demoGames();
        await jest.advanceTimersByTimeAsync(1000);
        jest.setSystemTime(Date.now() + 91 * 60 * 1000);
        const P = pacing();
        await jest.advanceTimersByTimeAsync(P.AMBIENT_CHECK_MS);
        expect(first.isTerminal()).toBe(true);
        await jest.advanceTimersByTimeAsync(P.AMBIENT_CHECK_MS + P.AMBIENT_RESTART_MS);
        expect(demoGames()).toHaveLength(1);
        expect(demoGames()[0].gameId).not.toBe(first.gameId);
    });
});
