/**
 * "alls we gotta do is not be stupid" (BotController.handleHandDealtChat,
 * owner request 2026-11-16): the final hand of the game (the end of
 * HAND_PROGRESSION, the 13) is dealt with one team ahead by 50 or more, and
 * one bot of the LEADING team sometimes says so: 60%, decided once per game
 * (an all-zero redeal of the final hand does not roll again). The roll is
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
const { HAND_PROGRESSION, nextHandSize } = require('../../rules');
const { botController } = require('..');
const { makeIo, makeSocket, events, lazySeat } = require('../../../testUtils/gameDriver');
const { gameLogger, socketLogger, logger } = require('../../../utils/logger');

const LINE = 'alls we gotta do is not be stupid';
const FINAL = HAND_PROGRESSION[HAND_PROGRESSION.length - 1];
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
 * A game just dealt `hand` with `score`, humans everywhere except `botSeats`
 * (lazy seats played by bots). `roll` is what every chatRoll returns.
 */
function table({ botSeats = [1, 3], roll = 0, hand = FINAL, score = { team1: 400, team2: 250 } } = {}) {
    seq++;
    const log = [];
    const io = makeIo(log);
    const ids = [1, 2, 3, 4].map((n) => `nbs${seq}-h${n}`);
    ids.forEach((id) => gameManager.registerUser(id, `u_${id}`));
    const sockets = ids.map((id) => makeSocket(id, log, io));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, `u_${id}`, i + 1, 1, false));
    game.currentHand = hand;
    game.score = { ...score };
    game.trump = { rank: '5', suit: 'spades' };
    game.forcePhase('BIDDING');
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

const lines = (log) => events(log, 'chatMessage').filter((l) => l.data.message === LINE)
    .map((l) => ({ position: l.data.position, username: l.data.username }));

/** Run the deal hook and wait out the chat delay; returns the lines said. */
async function dealt(t) {
    const mark = t.log.length;
    botController.handleHandDealtChat(t.io, t.game);
    await jest.advanceTimersByTimeAsync(pacing.fromRange(pacing(t.game).BOT_CHAT, 1) + 1);
    return lines(t.log.slice(mark));
}

test('the final hand is the end of HAND_PROGRESSION (the 13)', () => {
    expect(FINAL).toBe(13);
    expect(nextHandSize(FINAL)).toBe(0);
});

describe('the trigger', () => {
    test('final hand, team 1 ahead by 150: a team-1 bot says it, once, in the log too', async () => {
        const t = table();
        expect(await dealt(t)).toEqual([{ position: 1, username: '🤖 Mary' }]);
        expect(t.game.gameLog.some((e) => e.message === `🤖 Mary: ${LINE}` && e.type === 'chat')).toBe(true);
    });

    test('a lead of exactly 50 is enough; 49 is not', async () => {
        const at = table({ score: { team1: 250, team2: 200 } });
        expect((await dealt(at)).length).toBe(1);
        const under = table({ score: { team1: 249, team2: 200 } });
        expect(await dealt(under)).toEqual([]);
        expect(under.rolls).toEqual([]);
    });

    test('negative scores count by the difference too', async () => {
        const t = table({ score: { team1: 20, team2: -80 } });
        expect((await dealt(t)).length).toBe(1);
    });

    test('team 2 leading: a team-2 bot says it, never a team-1 bot', async () => {
        const t = table({ botSeats: [1, 2, 3, 4], score: { team1: 100, team2: 260 } });
        const said = await dealt(t);
        expect(said).toHaveLength(1);
        expect([2, 4]).toContain(said[0].position);
    });

    test('the speaker is one of the leading team\'s bots, picked by the roll', async () => {
        const t1 = table({ roll: (salt) => (salt === 'notBeStupid:who' ? 0.9 : 0) });
        expect((await dealt(t1)).map((l) => l.position)).toEqual([3]);
        const t2 = table({ roll: (salt) => (salt === 'notBeStupid:who' ? 0.1 : 0) });
        expect((await dealt(t2)).map((l) => l.position)).toEqual([1]);
    });

    test.each(HAND_PROGRESSION.slice(0, -1))('silent on an earlier hand (%i cards)', async (hand) => {
        const t = table({ hand });
        expect(await dealt(t)).toEqual([]);
        expect(t.rolls).toEqual([]);
    });

    test('silent: only the trailing team has bots', async () => {
        const t = table({ botSeats: [2, 4] });
        expect(await dealt(t)).toEqual([]);
        expect(t.rolls).toEqual([]);
    });

    test('silent: no bots at the table', async () => {
        const t = table({ botSeats: [] });
        expect(await dealt(t)).toEqual([]);
    });

    test('the chance: below 0.6 it fires, at 0.6 and above it does not', async () => {
        const below = table({ roll: 0.599 });
        expect((await dealt(below)).length).toBe(1);
        const at = table({ roll: 0.6 });
        expect(await dealt(at)).toEqual([]);
        expect(at.rolls).toEqual(['notBeStupid']);
    });

    test('a bot that no longer holds its seat is never picked', async () => {
        const t = table({ botSeats: [1, 3], roll: (salt) => (salt === 'notBeStupid:who' ? 0.9 : 0) });
        t.game.positions[3] = 'someone-else';
        expect((await dealt(t)).map((l) => l.position)).toEqual([1]);
    });

    test('a bot released (/active) before the line lands says nothing', async () => {
        const t = table({ botSeats: [1] });
        const mark = t.log.length;
        botController.handleHandDealtChat(t.io, t.game);
        botController.unregisterBot(t.game.gameId, t.bots[1].socketId);
        await jest.advanceTimersByTimeAsync(5000);
        expect(lines(t.log.slice(mark))).toEqual([]);
    });
});

describe('once per game', () => {
    test('a second deal of the final hand (the redeal) says nothing more', async () => {
        const t = table();
        expect((await dealt(t)).length).toBe(1);
        expect(await dealt(t)).toEqual([]);
    });

    test('a missed roll is not rolled again on the redeal', async () => {
        let r = 0.9;
        const t = table({ roll: () => r });
        expect(await dealt(t)).toEqual([]);
        r = 0;
        expect(await dealt(t)).toEqual([]);
        expect(t.rolls).toEqual(['notBeStupid']);
    });

    test('per game, and cleanupGame forgets it', async () => {
        const a = table();
        const b = table();
        expect((await dealt(a)).length).toBe(1);
        expect((await dealt(b)).length).toBe(1);
        expect(botController.notBeStupidGames.has(a.game.gameId)).toBe(true);
        botController.cleanupGame(a.game.gameId);
        expect(botController.notBeStupidGames.has(a.game.gameId)).toBe(false);
    });
});

test('a throw inside the hook is logged, never thrown into the deal', () => {
    const t = table();
    botController.chatRoll = () => { throw new Error('boom'); };
    const err = jest.spyOn(gameLogger, 'error').mockImplementation(() => {});
    expect(() => botController.handleHandDealtChat(t.io, t.game)).not.toThrow();
    expect(err).toHaveBeenCalledWith('Bot table chat failed', expect.objectContaining({ error: 'boom' }));
});

describe('wired into dealHand', () => {
    /** All four bid 0 on the final hand (seat 1 is the bot): the redeal deals it again. */
    async function redeal(t) {
        jest.spyOn(t.bots[1], 'decideBid').mockReturnValue('0');
        t.game.currentTurn = 2;
        for (const pos of [2, 3, 4]) await gameHandlers.playerBid(t.sockets[pos - 1], t.io, { bid: '0' });
        // seat 1's bot bids 0 on its timer: the redeal runs dealHand
        await jest.advanceTimersByTimeAsync(10000);
        expect(events(t.log, 'destroyHands')).toHaveLength(1);
        expect(t.game.currentHand).toBe(FINAL);
    }

    test('the deal (here the all-zero redeal) fires it', async () => {
        const t = table({ botSeats: [1] });
        const mark = t.log.length;
        await redeal(t);
        await jest.advanceTimersByTimeAsync(pacing.fromRange(pacing(t.game).BOT_CHAT, 1) + 1);
        expect(lines(t.log.slice(mark))).toEqual([{ position: 1, username: '🤖 Mary' }]);
    });

    test('said at the first deal of the final hand: the redeal does not say it again', async () => {
        const t = table({ botSeats: [1] });
        expect((await dealt(t)).length).toBe(1);
        const mark = t.log.length;
        await redeal(t);
        await jest.advanceTimersByTimeAsync(pacing.fromRange(pacing(t.game).BOT_CHAT, 1) + 1);
        expect(lines(t.log.slice(mark))).toEqual([]);
    });
});

describe('the default roll', () => {
    test('fires about 60% of the time across games (no Math.random)', () => {
        const spy = jest.spyOn(Math, 'random');
        let hits = 0;
        const n = 4000;
        for (let i = 0; i < n; i++) {
            const g = { gameId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, currentHand: FINAL, cardIndex: 0 };
            if (realRoll(g, 'notBeStupid') < 0.6) hits++;
        }
        expect(hits / n).toBeGreaterThan(0.56);
        expect(hits / n).toBeLessThan(0.64);
        expect(spy).not.toHaveBeenCalled();
    });
});
