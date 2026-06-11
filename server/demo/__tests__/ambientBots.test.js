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
        for (const [, player] of game.players) {
            expect(player.isBot).toBe(true);
        }

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
});
