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

        // Bot lines go to their own ring; the human history stays empty
        expect(gameManager.mainRoomMessages).toHaveLength(0);
        const messages = gameManager.ambientMainRoomMessages;
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
        expect(gameManager.ambientMainRoomMessages).toHaveLength(0);
    });
});

describe('maybePostChat', () => {
    test('posts when the room has been quiet', () => {
        gameManager.mainRoomMessages.push({
            username: 'real', message: 'old', timestamp: Date.now() - 60 * 60 * 1000
        });
        expect(ambient.maybePostChat(fakeIo)).toBe(true);
        expect(gameManager.mainRoomMessages).toHaveLength(1);
        expect(gameManager.ambientMainRoomMessages).toHaveLength(1);
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
        expect(gameManager.ambientMainRoomMessages).toHaveLength(0);

        await jest.advanceTimersByTimeAsync(30 * 1000);
        expect(game.phase).not.toBe('drawing');

        // Visible — announce once, then stay quiet
        ambient.tick(fakeIo);
        ambient.tick(fakeIo);
        expect(gameManager.ambientMainRoomMessages).toHaveLength(1);
        expect(gameManager.ambientMainRoomMessages[0].message).toMatch(/game/i);
        expect(gameManager.mainRoomMessages).toHaveLength(1);

        const { botController } = require('../../game/bot');
        botController.cleanupGame(game.gameId);
    });
});

describe('on-demand lifecycle (pacing.js AMBIENT_CHECK_MS / AMBIENT_RESTART_MS / AMBIENT_IDLE_MS / AMBIENT_PREGAME)', () => {
    let pacing;
    let io;
    let log;
    let n = 0;
    const demoGames = () => [...gameManager.games.values()].filter((g) => g.isDemo && !g.isTerminal());
    const listed = (game) => log.some((l) => l.event === 'lobbiesUpdated' && l.to === 'mainRoom' &&
        l.data.inProgressGames.some((g) => g.gameId === game.gameId));

    /** A signed-in player enters the main room (GameManager.joinMainRoom, as all three join points do). */
    function enterMainRoom() {
        n++;
        const sid = `human-${n}`;
        gameManager.registerUser(sid, `Human${n}`);
        expect(gameManager.joinMainRoom(sid).success).toBe(true);
        return sid;
    }

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

    test('the poll and the gap between games are 5 s each; the idle grace is 10 min', () => {
        expect(pacing().AMBIENT_CHECK_MS).toBe(5000);
        expect(pacing().AMBIENT_RESTART_MS).toBe(5000);
        expect(pacing().AMBIENT_IDLE_MS).toBe(10 * 60 * 1000);
        expect(pacing.PROFILES.zero.AMBIENT_IDLE_MS).toBe(10 * 60 * 1000);
    });

    test('a new demo game is listed (lobbiesUpdated at DEALING) within 1 s of its start', async () => {
        const game = ambient.startBotGame(io);
        expect(pacing(game).TEAMS_MS).toBe(0);
        await jest.advanceTimersByTimeAsync(1000);
        expect(gameManager.getInProgressGames().some((g) => g.gameId === game.gameId)).toBe(true);
        expect(listed(game)).toBe(true);
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

    test('an empty server runs no game; the chat is still seeded', async () => {
        ambient.startAmbientActivity(io);
        expect(gameManager.ambientMainRoomMessages.length).toBeGreaterThan(0);
        await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(demoGames()).toHaveLength(0);
        expect(gameManager.games.size).toBe(0);
    });

    test('a player entering a quiet main room sees a live game listed within 1 s (measured)', async () => {
        ambient.startAmbientActivity(io);
        await jest.advanceTimersByTimeAsync(30 * 60 * 1000); // a quiet hour
        expect(demoGames()).toHaveLength(0);

        const t0 = Date.now();
        enterMainRoom();
        let game = null;
        let listedAt = null;
        for (let t = 0; t <= 5000 && listedAt === null; t += 10) {
            [game] = demoGames();
            if (game && listed(game)) listedAt = Date.now();
            else await jest.advanceTimersByTimeAsync(10);
        }
        expect(game).toBeDefined();
        expect(listedAt - t0).toBeLessThanOrEqual(1000);
        // Recorded for the report: start -> listed under the standard pacing
        // eslint-disable-next-line no-console
        process.stdout.write(`ambient: main-room join -> game listed in ${listedAt - t0} ms (fake clock)\n`);
    });

    test('a finished game is replaced within AMBIENT_CHECK_MS + AMBIENT_RESTART_MS while someone is in the main room; never two at once', async () => {
        ambient.startAmbientActivity(io);
        enterMainRoom();
        await jest.advanceTimersByTimeAsync(1000);
        const [first] = demoGames();
        expect(first).toBeDefined();
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
        for (let t = 0; t < 120000; t += 1000) {
            await jest.advanceTimersByTimeAsync(1000);
            max = Math.max(max, demoGames().length);
        }
        expect(max).toBe(1);
    });

    test('a second join while a game runs starts nothing more', async () => {
        ambient.startAmbientActivity(io);
        enterMainRoom();
        await jest.advanceTimersByTimeAsync(100);
        enterMainRoom();
        enterMainRoom();
        await jest.advanceTimersByTimeAsync(10000);
        expect(demoGames()).toHaveLength(1);
    });

    test('nobody around for AMBIENT_IDLE_MS: the running game is never aborted, it finishes and none follows', async () => {
        ambient.startAmbientActivity(io);
        const sid = enterMainRoom();
        await jest.advanceTimersByTimeAsync(1000);
        const [first] = demoGames();
        gameManager.leaveMainRoom(sid);

        // Inside the grace a finished game is still replaced
        gameManager.endGame(first.gameId, io);
        const P = pacing();
        await jest.advanceTimersByTimeAsync(P.AMBIENT_CHECK_MS + P.AMBIENT_RESTART_MS + 1000);
        const [second] = demoGames();
        expect(second).toBeDefined();
        expect(second.gameId).not.toBe(first.gameId);

        // Past the grace the game keeps playing: idleness never aborts
        jest.setSystemTime(Date.now() + P.AMBIENT_IDLE_MS + 60000);
        await jest.advanceTimersByTimeAsync(P.AMBIENT_CHECK_MS * 3);
        expect(ambient.inDemand()).toBe(false);
        expect(second.isTerminal()).toBe(false);
        expect(gameManager.getGameById(second.gameId)).toBe(second);
        expect(log.filter((l) => l.event === 'abortGame')).toHaveLength(0);

        // ...and when it ends, nothing replaces it
        gameManager.endGame(second.gameId, io);
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(demoGames()).toHaveLength(0);

        // The next player to come in wakes it up at once
        enterMainRoom();
        await jest.advanceTimersByTimeAsync(1000);
        expect(demoGames()).toHaveLength(1);
        expect(listed(demoGames()[0])).toBe(true);
    });

    test('a spectator of the ambient game keeps it in demand (not in the main room)', async () => {
        ambient.startAmbientActivity(io);
        const sid = enterMainRoom();
        await jest.advanceTimersByTimeAsync(1000);
        const [first] = demoGames();
        gameManager.leaveMainRoom(sid);
        gameManager.addSpectator(io, first, sid, 'Human');
        const P = pacing();
        jest.setSystemTime(Date.now() + P.AMBIENT_IDLE_MS + 60000);
        await jest.advanceTimersByTimeAsync(P.AMBIENT_CHECK_MS);
        expect(ambient.inDemand()).toBe(true);
        gameManager.endGame(first.gameId, io);
        await jest.advanceTimersByTimeAsync(P.AMBIENT_CHECK_MS + P.AMBIENT_RESTART_MS + 1000);
        expect(demoGames()).toHaveLength(1);
    });

    test('a recycled (wedged) game is replaced while in demand', async () => {
        ambient.startAmbientActivity(io);
        enterMainRoom();
        await jest.advanceTimersByTimeAsync(1000);
        const [first] = demoGames();
        jest.setSystemTime(Date.now() + 91 * 60 * 1000);
        const P = pacing();
        await jest.advanceTimersByTimeAsync(P.AMBIENT_CHECK_MS);
        expect(first.isTerminal()).toBe(true);
        await jest.advanceTimersByTimeAsync(P.AMBIENT_CHECK_MS + P.AMBIENT_RESTART_MS);
        expect(demoGames()).toHaveLength(1);
        expect(demoGames()[0].gameId).not.toBe(first.gameId);
    });

    test('not started (AMBIENT_BOTS=false): a main-room join starts nothing', async () => {
        enterMainRoom();
        await jest.advanceTimersByTimeAsync(60000);
        expect(demoGames()).toHaveLength(0);
        expect(gameManager.mainRoomJoinListeners.size).toBe(0);
    });

    test('stop leaves no timer or hook behind', async () => {
        const before = jest.getTimerCount();
        ambient.startAmbientActivity(io);
        // A join schedules the 0 ms start; stop before it runs
        enterMainRoom();
        expect(jest.getTimerCount()).toBe(before + 2); // poll + wake
        ambient.stopAmbientActivity();
        expect(jest.getTimerCount()).toBe(before);
        expect(gameManager.mainRoomJoinListeners.size).toBe(0);
        await jest.advanceTimersByTimeAsync(60000);
        expect(demoGames()).toHaveLength(0);
        enterMainRoom();
        await jest.advanceTimersByTimeAsync(60000);
        expect(demoGames()).toHaveLength(0);
    });
});
