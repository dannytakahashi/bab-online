/**
 * Bot think time (BotPlayer.getActionDelay, BotController.actionKind):
 * one Math.random() per action whatever the kind (seeded games keep their
 * RNG stream), the kind is derived at schedule time, leads never use the
 * forced range; and the srv-15 regression: /active on a lazy seat cancels
 * every pending timer of its bot, chat included.
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
const BotPlayer = require('../../game/bot/BotPlayer');
const pacing = require('../../game/pacing');
const { botController } = require('../../game/bot');
const { makeIo, makeSocket, events, lazySeat } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const RANGES = {
    'draw/': 'BOT_DRAW',
    'bid/firstBid': 'BOT_FIRST_BID',
    'bid/bid': 'BOT_BID',
    'play/afterBidding': 'BOT_LEAD_AFTER_BIDDING',
    'play/afterTrick': 'BOT_LEAD_AFTER_TRICK',
    'play/forced': 'BOT_FORCED_PLAY',
    'play/follow': 'BOT_PLAY',
    'other/': 'BOT_CHAT',
};

describe('getActionDelay', () => {
    test.each(Object.entries(RANGES))('%s draws Math.random exactly once and uses %s', (key, range) => {
        const [type, kind] = key.split('/');
        const bot = new BotPlayer('🤖 Mary', 'mary');
        const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
        const ms = bot.getActionDelay(type, { kind: kind || undefined });
        expect(spy).toHaveBeenCalledTimes(1);
        const [min, span] = pacing()[range];
        expect(ms).toBe(min + 0.5 * span);
    });
});

describe('actionKind (schedule time, no RNG)', () => {
    const bot = { socketId: 'bot:k', position: 2 };
    const base = (over) => ({
        getBidCount: () => 0, playedCardsIndex: 0, cardIndex: 0, trump: C('A', 'spades'), isTrumpBroken: false,
        leadCard: null, leadPosition: 1, getHand: () => [C('2', 'hearts'), C('3', 'clubs')], ...over,
    });

    test('bids: the deal\'s first bid, then the others', () => {
        expect(botController.actionKind(base(), 'bid', bot)).toBe('firstBid');
        expect(botController.actionKind(base({ getBidCount: () => 2 }), 'bid', bot)).toBe('bid');
    });

    test('leads: after bidding, after a trick, never forced (even the last card)', () => {
        expect(botController.actionKind(base(), 'play', bot)).toBe('afterBidding');
        expect(botController.actionKind(base({ cardIndex: 8 }), 'play', bot)).toBe('afterTrick');
        expect(botController.actionKind(base({ cardIndex: 44, getHand: () => [C('2', 'hearts')] }), 'play', bot)).toBe('afterTrick');
    });

    test('follows: one legal card is forced, a choice is a follow', () => {
        const following = { playedCardsIndex: 1, cardIndex: 1, leadCard: C('9', 'hearts') };
        expect(botController.actionKind(base(following), 'play', bot)).toBe('forced'); // must follow hearts
        const twoHearts = () => [C('2', 'hearts'), C('4', 'hearts'), C('3', 'clubs')];
        expect(botController.actionKind(base({ ...following, getHand: twoHearts }), 'play', bot)).toBe('follow');
        const voidHand = () => [C('2', 'diamonds'), C('3', 'clubs')];
        expect(botController.actionKind(base({ ...following, getHand: voidHand }), 'play', bot)).toBe('follow');
    });
});

describe('srv-15: /active releases every pending timer of the lazy bot', () => {
    test('Sharon\'s trump quip and her bid are cancelled; nothing fires on the seat', async () => {
        seq++;
        const log = [];
        const io = makeIo(log);
        const ids = [1, 2, 3, 4].map((n) => `bt${seq}-h${n}`);
        ids.forEach((id) => gameManager.registerUser(id, `u_${id}`));
        const sockets = ids.map((id) => makeSocket(id, log, io));
        const game = gameManager.createGame(ids);
        ids.forEach((id, i) => game.addPlayer(id, `u_${id}`, i + 1, 1, false));
        game.currentHand = 1;
        ids.forEach((id, i) => game.setHand(id, [C(String(i + 2), 'hearts')]));
        game.trump = C('5', 'clubs');
        game.forcePhase('BIDDING');
        game.currentTurn = 2;

        const sharon = botController.createBot('🤖 Sharon', 'sharon');
        lazySeat(game, 2, sharon);
        game.setHand(sharon.socketId, [C('3', 'hearts')]);
        botController.handleTrumpRevealed(io, game);
        gameHandlers.triggerBotIfNeeded(io, game, 'bid');
        const keys = () => [...botController.pendingActions.keys()].filter((k) => k.startsWith(`${game.gameId}:${sharon.socketId}:`));
        expect(keys().some((k) => k.includes(':chat:'))).toBe(true);
        expect(keys().some((k) => k.endsWith(':bid'))).toBe(true);

        const mark = log.length;
        chatHandlers.chatMessage(sockets[1], io, { message: '/active' });
        expect(game.seat(2).controller).toBe('human');
        expect(keys()).toEqual([]);
        await jest.advanceTimersByTimeAsync(pacing().BOT_TRUMP_QUIP_MS + 5000);
        const after = log.slice(mark);
        expect(after.filter((l) => l.event === 'chatMessage' && l.data.username === sharon.username)).toEqual([]);
        expect(after.filter((l) => l.event === 'bidReceived')).toEqual([]);
        expect(events(log, 'chatMessage').filter((l) => l.data.position === 2 && l.data.username !== 'u_' + ids[1])).toEqual([]);
    });
});
