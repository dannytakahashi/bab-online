/**
 * A bot that takes a seat mid-hand (/lazy, AFK, resign) starts with the
 * hand's public record replayed into its card memory (createSeatBot):
 * every won trick, then the open one. Its memory, and so its play, is the
 * same as a bot that watched from the deal, and the search runs (it stayed
 * off for the rest of the hand while the memory was empty).
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const seatLifecycle = require('../seatLifecycle');
const { botController } = require('../../game/bot');
const BotPlayer = require('../../game/bot/BotPlayer');
const { getOpponentVoidSuits, buildCardView } = require('../../game/bot/BotStrategy');
const { readPosition } = require('../../game/bot/playSearch');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, legalCards } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    process.env.AFK_TIMEOUT_MS = '0';
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.AFK_TIMEOUT_MS;
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/**
 * Four humans on a 5-card hand, spades trump, seat 1 to lead. Seat 2 shows
 * a heart void on trick 2 and a club void on trick 4. `watcher` hears every
 * card the bots hear from the deal on (the reference).
 */
function setup() {
    seq++;
    const log = [];
    const io = makeIo(log);
    const ids = [1, 2, 3, 4].map((n) => `sbm${seq}-h${n}`);
    const names = ids.map((id, i) => `sbm${seq}_${i + 1}`);
    ids.forEach((id, i) => {
        gameManager.registerUser(id, names[i]);
        mockDb.current.users._insert({ username: names[i], profilePic: i + 1 });
    });
    const sockets = ids.map((id) => makeSocket(id, log, io));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, names[i], i + 1, i + 1, false));
    sockets.forEach((s) => s.join(game.roomName));
    game.currentHand = 5;
    const hands = [
        [C('A', 'hearts'), C('K', 'hearts'), C('Q', 'hearts'), C('2', 'clubs'), C('3', 'spades')],
        [C('2', 'hearts'), C('5', 'diamonds'), C('6', 'diamonds'), C('7', 'diamonds'), C('8', 'diamonds')],
        [C('3', 'hearts'), C('4', 'hearts'), C('5', 'hearts'), C('9', 'clubs'), C('10', 'clubs')],
        [C('6', 'hearts'), C('7', 'hearts'), C('8', 'hearts'), C('J', 'clubs'), C('4', 'spades')],
    ];
    ids.forEach((id, i) => game.setHand(id, hands[i]));
    game.trump = C('9', 'spades');
    game.bidder = 1;
    game.dealSeq = 1;
    game.currentTurn = 1;
    game.forcePhase('PLAYING');
    game.bids = { team1: 3, team2: 1 };
    game.playerBids = ['2', '1', '1', '0'];
    game.leadPosition = 1;

    const watcher = new BotPlayer('🤖 Watcher', 'mary');
    watcher.resetCardMemory(game.currentHand, game.trump);
    const card = botController.notifyCardPlayed.bind(botController);
    const trick = botController.notifyTrickComplete.bind(botController);
    jest.spyOn(botController, 'notifyCardPlayed').mockImplementation((gid, c, pos, trump, lead) => {
        if (gid === game.gameId) watcher.recordCardPlayed(c, pos, trump, lead);
        return card(gid, c, pos, trump, lead);
    });
    jest.spyOn(botController, 'notifyTrickComplete').mockImplementation((gid) => {
        if (gid === game.gameId) watcher.advanceTrick();
        return trick(gid);
    });
    gameHandlers.triggerBotIfNeeded(io, game, 'play');
    return { log, io, game, ids, names, sockets, watcher };
}

/** Humans play their first legal card until `n` cards are down this hand. */
async function playUntil(t, n) {
    for (let guard = 0; guard < 100 && t.game.cardIndex < n; guard++) {
        if (t.game.acceptsTurnInput()) {
            const pos = t.game.currentTurn;
            const sid = t.game.positions[pos];
            await gameHandlers.playCard(t.sockets[pos - 1], t.io, { card: legalCards(t.game, sid)[0] });
        } else {
            await jest.advanceTimersByTimeAsync(100);
        }
    }
    expect(t.game.cardIndex).toBe(n);
}

/** Undo createSeatBot (the seat never took the bot). */
const discard = (game, bot) => {
    botController.unregisterBot(game.gameId, bot.socketId);
    gameManager.playerGames.delete(bot.socketId);
};

const decide = (game, pos, bot, memorySource) => {
    const ref = new BotPlayer(bot.username, bot.personality);
    ref.position = pos;
    ref.cardMemory = memorySource.cardMemory;
    return ref.decideCard(game.getHand(game.positions[pos]), game.playedCards, game.leadCard, game.leadPosition,
        game.trump, game.isTrumpBroken, game.currentHand, botController.buildPlayContext(game));
};

describe('a bot seated mid-hand', () => {
    test('/lazy mid-trick: the memory matches a bot that watched, the voids are known, and it plays the same card', async () => {
        const t = setup();
        await playUntil(t, 14); // three tricks and two cards of the fourth
        expect(t.game.trickHistory).toHaveLength(3);
        expect(t.game.currentTurn).toBe(3);

        chatHandlers.chatMessage(t.sockets[2], t.io, { message: '/lazy' });
        expect(t.game.seat(3).controller).toBe('lazyBot');
        const bot = botController.getGameBots(t.game.gameId).find((b) => b.socketId === t.game.seat(3).bot.socketId);

        expect(bot.getMemorySnapshot()).toEqual(t.watcher.getMemorySnapshot());
        expect(bot.getMemorySnapshot().totalCardsPlayed).toBe(14);
        expect(bot.getMemorySnapshot().trickIndex).toBe(3);
        // Seat 2 showed out of hearts (trick 2) and clubs (trick 4, open)
        const voids = getOpponentVoidSuits(bot.getMemorySnapshot(), 3, t.game.trump);
        expect([...voids].sort()).toEqual(['2:clubs', '2:hearts']);
        expect(bot.getMemorySnapshot().acesPlayed.hearts).toBe(true);
        expect(buildCardView(t.game.getHand(bot.socketId), bot.getMemorySnapshot(), t.game.trump)).toBeTruthy();

        // The search sees a full hand now (an empty memory kept it off)
        const hand = t.game.getHand(bot.socketId);
        const read = (memory) => readPosition(hand, t.game.playedCards, t.game.leadPosition, t.game.trump, 3, memory, t.game.currentHand);
        expect(read(bot.getMemorySnapshot())).not.toBeNull();
        const empty = new BotPlayer('🤖 Empty', 'mary');
        empty.resetCardMemory(t.game.currentHand, t.game.trump);
        expect(read(empty.getMemorySnapshot())).toBeNull();

        expect(decide(t.game, 3, bot, bot)).toEqual(decide(t.game, 3, bot, t.watcher));

        // It plays on and its memory keeps step with the watcher's
        await jest.advanceTimersByTimeAsync(5000);
        expect(t.game.cardIndex).toBeGreaterThanOrEqual(15);
        expect(bot.getMemorySnapshot()).toEqual(t.watcher.getMemorySnapshot());
    });

    test('seated during TRICK_RESOLVING (4th card down): the open trick is counted once, at resume', async () => {
        const t = setup();
        await playUntil(t, 8);
        expect(t.game.stage).toBe(Phase.TRICK_RESOLVING);
        expect(t.game.trickHistory).toHaveLength(1);

        const bot = seatLifecycle.createSeatBot(t.game, 4, null);
        expect(bot.getMemorySnapshot()).toEqual(t.watcher.getMemorySnapshot());
        expect(bot.getMemorySnapshot()).toMatchObject({ totalCardsPlayed: 8, trickIndex: 1 });

        await jest.advanceTimersByTimeAsync(5000);
        expect(t.game.trickHistory).toHaveLength(2);
        expect(bot.getMemorySnapshot()).toEqual(t.watcher.getMemorySnapshot());
        expect(bot.getMemorySnapshot().trickIndex).toBe(2);
        discard(t.game, bot);
    });

    test('between tricks and before the first card: what was played, nothing more', async () => {
        const t = setup();
        const first = seatLifecycle.createSeatBot(t.game, 2, null);
        expect(first.getMemorySnapshot()).toMatchObject({ totalCardsPlayed: 0, trickIndex: 0 });
        discard(t.game, first);

        await playUntil(t, 8);
        await jest.advanceTimersByTimeAsync(5000); // trick 2 resolves
        expect(t.game.stage).toBe(Phase.PLAYING);
        expect(t.game.playedCardsIndex).toBe(0);
        const bot = seatLifecycle.createSeatBot(t.game, 2, null);
        expect(bot.getMemorySnapshot()).toEqual(t.watcher.getMemorySnapshot());
        expect(bot.getMemorySnapshot()).toMatchObject({ totalCardsPlayed: 8, trickIndex: 2 });
        discard(t.game, bot);
    });
});
