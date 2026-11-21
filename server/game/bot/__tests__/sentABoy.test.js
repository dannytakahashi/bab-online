/**
 * "he sends a boy" (BotController.handleCardPlayedChat, owner request
 * 2026-11-16): a 2 or 3 of trump (not a joker), the first trump of a trick
 * whose lead is not trump, makes one bot on the OTHER team sometimes say
 * so: 35% per ruff, at most once every 3 tricks per game. The roll is
 * replaced here (botController.chatRoll) so every case is deterministic.
 */

const { createMemoryDb } = require('../../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../GameManager');
const gameHandlers = require('../../../socket/gameHandlers');
const pacing = require('../../pacing');
const { botController } = require('..');
const { makeIo, makeSocket, events, lazySeat } = require('../../../testUtils/gameDriver');
const { gameLogger, socketLogger, logger } = require('../../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
const LINE = 'he sends a boy';
const TRUMP = C('5', 'spades');
let seq = 0;
let realRoll;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    realRoll = botController.chatRoll;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    botController.chatRoll = realRoll;
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/**
 * A game in PLAYING with humans everywhere except `botSeats` (lazy seats
 * played by bots). `roll` is what every chatRoll returns.
 */
function table({ botSeats = [1, 3], roll = 0 } = {}) {
    seq++;
    const log = [];
    const io = makeIo(log);
    const ids = [1, 2, 3, 4].map((n) => `sb${seq}-h${n}`);
    ids.forEach((id) => gameManager.registerUser(id, `u_${id}`));
    const sockets = ids.map((id) => makeSocket(id, log, io));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, `u_${id}`, i + 1, 1, false));
    game.currentHand = 4;
    game.trump = TRUMP;
    game.forcePhase('PLAYING');
    const names = ['Mary', 'Sharon', 'Danny', 'Mike'];
    const bots = {};
    for (const pos of botSeats) {
        const bot = botController.createBot(`🤖 ${names[pos - 1]}`, names[pos - 1].toLowerCase());
        lazySeat(game, pos, bot);
        bots[pos] = bot;
    }
    const rolls = [];
    botController.chatRoll = (g, salt) => { rolls.push(salt); return typeof roll === 'function' ? roll(salt) : roll; };
    return { io, log, game, ids, sockets, bots, rolls };
}

/** Put `cards` ([position, card] in play order) on the table, as applyPlay leaves it. */
function trick(game, cards) {
    game.playedCards = [null, null, null, null];
    game.playedCardsIndex = 0;
    for (const [pos, card] of cards) {
        if (game.playedCardsIndex === 0) {
            game.leadCard = card;
            game.leadPosition = pos;
        }
        game.playedCards[pos - 1] = card;
        game.playedCardsIndex++;
        game.cardIndex++;
    }
}

/** Play `cards` and run the hook for the last one; returns the bot lines said. */
async function said(t, cards) {
    trick(t.game, cards);
    const [pos, card] = cards[cards.length - 1];
    const mark = t.log.length;
    botController.handleCardPlayedChat(t.io, t.game, card, pos);
    await jest.advanceTimersByTimeAsync(pacing.fromRange(pacing(t.game).BOT_CHAT, 1) + 1);
    return events(t.log.slice(mark), 'chatMessage').map((l) => ({ position: l.data.position, username: l.data.username, message: l.data.message }));
}

describe('the trigger', () => {
    test.each(['2', '3'])('a %s of trump ruffing a plain lead: an opposing bot says it, once, in the log too', async (rank) => {
        const t = table();
        const lines = await said(t, [[1, C('9', 'hearts')], [2, C(rank, 'spades')]]);
        expect(lines).toEqual([{ position: 1, username: '🤖 Mary', message: LINE }]);
        expect(t.game.gameLog.some((e) => e.message === `🤖 Mary: ${LINE}` && e.type === 'chat')).toBe(true);
    });

    test('the speaker is one of the two opposing bots, picked by the roll', async () => {
        const t1 = table({ roll: (salt) => (salt === 'sentABoy:who' ? 0.9 : 0) });
        expect((await said(t1, [[1, C('9', 'hearts')], [2, C('2', 'spades')]])).map((l) => l.position)).toEqual([3]);
        const t2 = table({ roll: (salt) => (salt === 'sentABoy:who' ? 0.1 : 0) });
        expect((await said(t2, [[1, C('9', 'hearts')], [2, C('2', 'spades')]])).map((l) => l.position)).toEqual([1]);
    });

    test('later in the trick: the second or third seat ruffing first', async () => {
        const t = table();
        expect(await said(t, [[4, C('J', 'hearts')], [1, C('Q', 'hearts')], [2, C('3', 'spades')]]))
            .toEqual([{ position: 1, username: '🤖 Mary', message: LINE }]);
        const t2 = table({ botSeats: [2, 4] });
        expect((await said(t2, [[2, C('9', 'hearts')], [3, C('2', 'spades')]])).length).toBe(1);
    });

    test('a bot ruffing counts too (the human team has no bots: nobody speaks; the bots\' opponents do)', async () => {
        const t = table({ botSeats: [1, 2] });
        // bot 2 ruffs: bot 1 is its opponent
        expect(await said(t, [[1, C('9', 'hearts')], [2, C('2', 'spades')]]))
            .toEqual([{ position: 1, username: '🤖 Mary', message: LINE }]);
    });

    test.each([
        ['a 4 of trump', [[1, C('9', 'hearts')], [2, C('4', 'spades')]]],
        ['a higher trump', [[1, C('9', 'hearts')], [2, C('K', 'spades')]]],
        ['the LO joker', [[1, C('9', 'hearts')], [2, C('LO', 'joker')]]],
        ['the HI joker', [[1, C('9', 'hearts')], [2, C('HI', 'joker')]]],
        ['a 2 of a plain suit (not trump)', [[1, C('9', 'hearts')], [2, C('2', 'clubs')]]],
        ['a 2 following the led suit', [[1, C('9', 'hearts')], [2, C('2', 'hearts')]]],
        ['a trump lead (a 2 of trump on a trump lead)', [[1, C('9', 'spades')], [2, C('2', 'spades')]]],
        ['a joker lead', [[1, C('LO', 'joker')], [2, C('2', 'spades')]]],
        ['leading the 2 of trump', [[2, C('2', 'spades')]]],
        ['a second trump (someone ruffed before)', [[1, C('9', 'hearts')], [2, C('A', 'spades')], [3, C('J', 'hearts')], [4, C('2', 'spades')]]],
        ['a 2 of trump under a joker played on a plain lead', [[1, C('9', 'hearts')], [2, C('HI', 'joker')], [3, C('J', 'hearts')], [4, C('3', 'spades')]]],
    ])('silent: %s', async (_name, cards) => {
        const t = table({ botSeats: [1, 3] });
        expect(await said(t, cards)).toEqual([]);
        expect(t.rolls).toEqual([]);
    });

    test('silent: only the ruffer\'s partner is a bot (partners never say it)', async () => {
        const t = table({ botSeats: [4] });
        expect(await said(t, [[1, C('9', 'hearts')], [2, C('2', 'spades')]])).toEqual([]);
        expect(t.rolls).toEqual([]);
    });

    test('silent: no bots at the table', async () => {
        const t = table({ botSeats: [] });
        expect(await said(t, [[1, C('9', 'hearts')], [2, C('2', 'spades')]])).toEqual([]);
    });

    test('the chance: below 0.35 it fires, at 0.35 and above it does not', async () => {
        const below = table({ roll: 0.349 });
        expect((await said(below, [[1, C('9', 'hearts')], [2, C('2', 'spades')]])).length).toBe(1);
        const at = table({ roll: 0.35 });
        expect(await said(at, [[1, C('9', 'hearts')], [2, C('2', 'spades')]])).toEqual([]);
        expect(at.rolls).toEqual(['sentABoy']);
    });

    test('the cooldown: not again within 3 tricks of the last one; a miss starts no cooldown', async () => {
        let r = 0.9;
        const t = table({ roll: () => r });
        const ruff = [[1, C('9', 'hearts')], [2, C('2', 'spades')]];
        expect(await said(t, ruff)).toEqual([]); // the roll missed
        r = 0;
        expect((await said(t, ruff)).length).toBe(1); // the same trick even: no cooldown yet
        for (let k = 0; k < 2; k++) {
            botController.notifyTrickComplete(t.game.gameId);
            expect(await said(t, ruff)).toEqual([]);
        }
        botController.notifyTrickComplete(t.game.gameId);
        expect((await said(t, ruff)).length).toBe(1);
        expect(await said(t, ruff)).toEqual([]);
    });

    test('the cooldown is per game and cleanupGame forgets it', async () => {
        const a = table();
        const b = table();
        const ruff = [[1, C('9', 'hearts')], [2, C('2', 'spades')]];
        expect((await said(a, ruff)).length).toBe(1);
        expect((await said(b, ruff)).length).toBe(1);
        expect(await said(a, ruff)).toEqual([]);
        expect(botController.sentABoyTricks.has(a.game.gameId)).toBe(true);
        botController.cleanupGame(a.game.gameId);
        expect(botController.sentABoyTricks.has(a.game.gameId)).toBe(false);
    });

    test('a bot released (/active) before the line lands says nothing', async () => {
        const t = table({ botSeats: [1] });
        trick(t.game, [[1, C('9', 'hearts')], [2, C('2', 'spades')]]);
        const mark = t.log.length;
        botController.handleCardPlayedChat(t.io, t.game, C('2', 'spades'), 2);
        botController.unregisterBot(t.game.gameId, t.bots[1].socketId);
        await jest.advanceTimersByTimeAsync(5000);
        expect(events(t.log.slice(mark), 'chatMessage')).toEqual([]);
    });

    test('a bot that no longer holds its seat is never picked', async () => {
        const t = table({ botSeats: [1, 3] });
        t.bots[3].position = 3;
        t.game.positions[3] = 'someone-else';
        const lines = await said(t, [[1, C('9', 'hearts')], [2, C('2', 'spades')]]);
        expect(lines.map((l) => l.position)).toEqual([1]);
    });
});

describe('only while it could still be over-trumped (2026-11-20)', () => {
    /** A finished trick for GameState.trickHistory: [position, card] in play order. */
    const done = (cards) => ({ winner: cards[0][0], lead: cards[0][0], cards: cards.map(([, c]) => c) });

    test('silent on the last card of a trick: nobody is left to over-trump it', async () => {
        const t = table();
        expect(await said(t, [[3, C('9', 'hearts')], [4, C('J', 'hearts')], [1, C('Q', 'hearts')], [2, C('3', 'spades')]])).toEqual([]);
        expect(t.rolls).toEqual([]);
    });

    test('silent when the opponent still to play has shown out of trump this hand', async () => {
        const t = table();
        // an earlier trick: spades (trump) led, seat 3 played a club
        t.game.trickHistory = [done([[1, C('A', 'spades')], [2, C('4', 'spades')], [3, C('7', 'clubs')], [4, C('6', 'spades')]])];
        expect(await said(t, [[1, C('9', 'hearts')], [2, C('2', 'spades')]])).toEqual([]);
        // a joker lead counts as a trump lead too
        const t2 = table();
        t2.game.trickHistory = [done([[4, C('HI', 'joker')], [1, C('4', 'spades')], [2, C('8', 'spades')], [3, C('K', 'diamonds')]])];
        expect(await said(t2, [[1, C('9', 'hearts')], [2, C('2', 'spades')]])).toEqual([]);
    });

    test('still said when the opponent to play followed trump earlier, or showed out only of another suit', async () => {
        const t = table();
        t.game.trickHistory = [
            done([[1, C('A', 'spades')], [2, C('4', 'spades')], [3, C('7', 'spades')], [4, C('6', 'spades')]]),
            done([[2, C('A', 'clubs')], [3, C('2', 'diamonds')], [4, C('3', 'clubs')], [1, C('5', 'clubs')]])
        ];
        expect((await said(t, [[1, C('9', 'hearts')], [2, C('2', 'spades')]])).length).toBe(1);
    });

    test('silent when every higher trump is accounted for (played this hand or the turned-up trump)', async () => {
        const t = table();
        // trump is the 5 of spades (turned up); every spade above the 3 but the 5, and both jokers, were played
        const higher = ['4', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].map((r) => C(r, 'spades'))
            .concat([C('LO', 'joker'), C('HI', 'joker')]);
        const tricks = [];
        for (let i = 0; i < higher.length; i += 4) {
            const four = higher.slice(i, i + 4);
            while (four.length < 4) four.push(C('2', 'clubs'));
            tricks.push(done(four.map((c, k) => [k + 1, c])));
        }
        t.game.trickHistory = tricks;
        expect(await said(t, [[1, C('9', 'hearts')], [2, C('3', 'spades')]])).toEqual([]);
        // with one of them (the ace) still out, it can be over-trumped again
        const t2 = table();
        t2.game.trickHistory = tricks.map((tr) => ({ ...tr, cards: tr.cards.map((c) => (c.rank === 'A' && c.suit === 'spades' ? C('2', 'clubs') : c)) }));
        expect((await said(t2, [[1, C('9', 'hearts')], [2, C('3', 'spades')]])).length).toBe(1);
    });
});

test('a throw inside the hook is logged, never thrown into the play path', () => {
    const t = table();
    trick(t.game, [[1, C('9', 'hearts')], [2, C('2', 'spades')]]);
    botController.chatRoll = () => { throw new Error('boom'); };
    const err = jest.spyOn(gameLogger, 'error').mockImplementation(() => {});
    expect(() => botController.handleCardPlayedChat(t.io, t.game, C('2', 'spades'), 2)).not.toThrow();
    expect(err).toHaveBeenCalledWith('Bot table chat failed', expect.objectContaining({ error: 'boom' }));
});

describe('wired into both play paths', () => {
    test('a human playCard ruffing with the 2 of trump', async () => {
        const t = table({ botSeats: [1, 3] });
        trick(t.game, [[1, C('9', 'hearts')]]);
        t.game.currentTurn = 2;
        t.game.setHand(t.ids[1], [C('2', 'spades'), C('7', 'clubs')]);
        const mark = t.log.length;
        await gameHandlers.playCard(t.sockets[1], t.io, { card: C('2', 'spades') });
        expect(events(t.log.slice(mark), 'cardPlayed').length).toBe(1);
        await jest.advanceTimersByTimeAsync(pacing.fromRange(pacing(t.game).BOT_CHAT, 1) + 1);
        const lines = events(t.log.slice(mark), 'chatMessage').filter((l) => l.data.message === LINE);
        expect(lines.map((l) => l.data.username)).toEqual(['🤖 Mary']);
    });

    test('a bot (processBotPlay) ruffing with the 3 of trump', async () => {
        const t = table({ botSeats: [1, 2] });
        trick(t.game, [[1, C('9', 'hearts')]]);
        t.game.currentTurn = 2;
        t.game.setHand(t.bots[2].socketId, [C('3', 'spades'), C('7', 'clubs')]);
        jest.spyOn(t.bots[2], 'decideCard').mockReturnValue(C('3', 'spades'));
        const mark = t.log.length;
        expect(botController.processBotPlay(t.io, t.game, t.bots[2])).toBe(true);
        await jest.advanceTimersByTimeAsync(pacing.fromRange(pacing(t.game).BOT_CHAT, 1) + 1);
        const lines = events(t.log.slice(mark), 'chatMessage').filter((l) => l.data.message === LINE);
        expect(lines.map((l) => l.data.username)).toEqual(['🤖 Mary']);
    });
});

describe('the default roll', () => {
    test('is a pure function of the play: no Math.random (seeded runs keep their stream)', () => {
        const spy = jest.spyOn(Math, 'random');
        const g = { gameId: 'g-1', currentHand: 5, cardIndex: 6 };
        const r = realRoll(g, 'sentABoy');
        expect(realRoll({ ...g }, 'sentABoy')).toBe(r);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(1);
        expect(realRoll({ ...g, cardIndex: 7 }, 'sentABoy')).not.toBe(r);
        expect(spy).not.toHaveBeenCalled();
    });

    test('fires about 35% of the time across games', () => {
        let hits = 0;
        const n = 4000;
        for (let i = 0; i < n; i++) {
            const g = { gameId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, currentHand: 1 + (i % 13), cardIndex: 2 + (i % 50) };
            if (realRoll(g, 'sentABoy') < 0.35) hits++;
        }
        expect(hits / n).toBeGreaterThan(0.31);
        expect(hits / n).toBeLessThan(0.39);
    });
});
