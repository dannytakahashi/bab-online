/**
 * Seat presence regressions (seat records, roadmap item 6): per-seat grace,
 * resign offers, abandon/abort, watchers vs spectators, lazy bots, draw
 * watchdog. Real handlers, stub io/sockets from gameDriver, fake timers.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const chatHandlers = require('../chatHandlers');
const { botController } = require('../../game/bot');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;
let realRandom;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    realRandom = Math.random;
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

/**
 * Seated game in BIDDING (one card each, seat 3 on turn). `bots` maps a
 * position to a personality: that seat is a native bot.
 */
function table({ bots = {} } = {}) {
    seq++;
    const log = [];
    const io = makeIo(log);
    const sids = {};
    const sockets = {};
    const botBy = {};
    for (let pos = 1; pos <= 4; pos++) {
        if (bots[pos]) {
            const name = `🤖 ${bots[pos][0].toUpperCase()}${bots[pos].slice(1)}`;
            botBy[pos] = botController.createBot(name, bots[pos]);
            sids[pos] = botBy[pos].socketId;
        } else {
            sids[pos] = `pr${seq}-p${pos}`;
            gameManager.registerUser(sids[pos], `user${pos}`);
            mockDb.current.users._insert({ username: `user${pos}`, profilePic: pos });
        }
    }
    const game = gameManager.createGame([1, 2, 3, 4].map((p) => sids[p]));
    for (let pos = 1; pos <= 4; pos++) {
        if (botBy[pos]) {
            botBy[pos].position = pos;
            botController.registerBot(game.gameId, botBy[pos]);
            game.addPlayer(sids[pos], botBy[pos].username, pos, 1, true);
        } else {
            game.addPlayer(sids[pos], `user${pos}`, pos, 1, false);
            sockets[pos] = makeSocket(sids[pos], log, io);
            sockets[pos].join(game.roomName);
        }
    }
    for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts')]);
    game.currentHand = 1;
    game.trump = C('A', 'spades');
    game.forcePhase(Phase.BIDDING);
    game.bidder = 3;
    game.currentTurn = 3;
    return { log, io, game, sids, sockets };
}

const chat = (t, pos, message, socket = t.sockets[pos]) => chatHandlers.chatMessage(socket, t.io, { message });
const seatNames = (game) => [1, 2, 3, 4].map((p) => game.getPlayerByPosition(p).username);

describe('R10 lazy bot names never duplicate a seated bot', () => {
    test('with mary, sharon and danny seated, /lazy picks mike or zach', () => {
        Math.random = () => 0; // the old code picked PERSONALITY_LIST[0] (mary)
        const t = table({ bots: { 2: 'mary', 3: 'sharon', 4: 'danny' } });
        chat(t, 1, '/lazy');
        const lazy = events(t.log, 'playerLazyMode')[0].data;
        expect(['🤖 Mike', '🤖 Zach']).toContain(lazy.botUsername);
        expect(new Set(seatNames(t.game)).size).toBe(4);
    });

    test('the last personality is reused only while it is free', () => {
        Math.random = () => 0;
        const t = table({ bots: { 3: 'mary', 4: 'sharon' } });
        chat(t, 1, '/lazy');
        const first = events(t.log, 'playerLazyMode')[0].data.botUsername;
        chat(t, 1, '/active');
        chat(t, 1, '/lazy');
        expect(events(t.log, 'playerLazyMode')[1].data.botUsername).toBe(first);
        chat(t, 1, '/active');
        chat(t, 2, '/lazy'); // takes the same (first free) personality
        expect(events(t.log, 'playerLazyMode')[2].data.botUsername).toBe(first);
        chat(t, 1, '/lazy'); // its last personality is taken now
        const again = events(t.log, 'playerLazyMode')[3].data.botUsername;
        expect(again).not.toBe(first);
        expect(new Set(seatNames(t.game)).size).toBe(4);
    });
});
