/**
 * Seats that lose their human (leave or disconnect during the draw, resign
 * then /active back) must end up played by someone, and the redeal / queue
 * broadcasts must not mislead clients. Drives the real handlers against a
 * real GameState with stub sockets and fake timers (the draw completion and
 * reconnect grace period run on setTimeout).
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const Deck = require('../../game/Deck');
const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const { botController } = require('../../game/bot');

const C = (rank, suit) => ({ rank, suit });

function makeIo(log) {
    return {
        to: (room) => ({ emit: (event, data) => log.push({ to: room, event, data }) }),
        emit: (event, data) => log.push({ to: '*', event, data }),
        sockets: { sockets: new Map() },
    };
}

function makeSocket(id, log) {
    return { id, data: {}, emit: (event, data) => log.push({ to: `self:${id}`, event, data }), join() {}, leave() {} };
}

const events = (log, event) => log.filter((l) => l.event === event);

let seq = 0;
let updateSpy;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    updateSpy = jest.spyOn(mockDb.current.users, 'updateOne');
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
});

/** A game in the draw phase; `humans` socket ids are registered users. */
function drawingGame(ids, humans = ids) {
    humans.forEach((id) => {
        gameManager.registerUser(id, `user_${id}`);
        mockDb.current.users._insert({ username: `user_${id}`, profilePic: 5 });
    });
    const game = gameManager.createGame(ids);
    game.deck = new Deck();
    game.phase = 'drawing';
    return game;
}

describe('draw-phase leave and disconnect', () => {
    test('a leaver becomes a resign bot and a disconnect gets the grace timer', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `d${seq}-h${n}`);
        const game = drawingGame(ids);
        const [leaver, , , dropper] = ids;
        const s = ids.map((id) => makeSocket(id, log));

        chatHandlers.chatMessage(s[0], io, { message: '/leave' });
        await gameHandlers.draw(s[1], io, { num: 0 });
        await gameHandlers.draw(s[2], io, { num: 0 });
        await queueHandlers.handleDisconnect(s[3], io); // auto-draws the 4th card
        await jest.advanceTimersByTimeAsync(7000); // positions, teams, deal

        const leaverPos = game.resignedPlayers && Object.keys(game.resignedPlayers).map(Number)[0];
        expect(leaverPos).toBeDefined();
        expect(game.resignedPlayers[leaverPos].username).toBe(`user_${leaver}`);
        const seat = game.getPlayerByPosition(leaverPos);
        expect(seat.isBot).toBe(true);
        expect(botController.getBot(game.gameId, seat.socketId)).toBeDefined();
        // The leaver is in the main room: no seat assignment, no activeGameId
        expect(log.some((l) => l.to === leaver && l.event === 'playerAssigned')).toBe(false);
        const sets = updateSpy.mock.calls.filter(([, u]) => u.$set && 'activeGameId' in u.$set);
        expect(sets.some(([f]) => f.username === `user_${leaver}`)).toBe(false);
        expect(sets).toHaveLength(3);
        // Bots have no user documents: no writes for them
        expect(updateSpy.mock.calls.every(([f]) => f.username.startsWith('user_'))).toBe(true);

        const dropperPos = game.getPositionBySocketId(dropper);
        expect(game.isPlayerDisconnected(dropperPos)).toBe(true);
        expect(events(log, 'playerDisconnected').some((l) => l.data.position === dropperPos)).toBe(true);
        expect(events(log, 'resignationAvailable')).toHaveLength(0);

        await jest.advanceTimersByTimeAsync(60000);
        const offers = events(log, 'resignationAvailable');
        expect(offers.map((l) => l.data.position)).toEqual([dropperPos]);

        // The offer is actionable: a remaining player replaces the seat
        const requester = s[ids.indexOf(ids.find((id) => id !== leaver && id !== dropper))];
        await gameHandlers.forceResign(requester, io, { position: dropperPos });
        expect(game.getPlayerByPosition(dropperPos).isBot).toBe(true);
    });

    test('the game aborts when every human left during the draw', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const bots = [1, 2, 3].map((n) => botController.createBot(`🤖 B${n}`, 'mary'));
        const human = `a${seq}-h1`;
        const game = drawingGame([human, ...bots.map((b) => b.socketId)], [human]);
        bots.forEach((b) => botController.registerBot(game.gameId, b));

        chatHandlers.chatMessage(makeSocket(human, log), io, { message: '/leave' });
        for (const b of bots) await gameHandlers.draw(makeSocket(b.socketId, log), io, { num: 0 });
        await jest.advanceTimersByTimeAsync(1000);

        expect(events(log, 'abortGame')).toHaveLength(1);
        expect(gameManager.getGameById(game.gameId)).toBeFalsy();
    });
});

describe('/active over a resigned seat', () => {
    function biddingGame() {
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `r${seq}-h${n}`);
        ids.forEach((id) => gameManager.registerUser(id, `user_${id}`));
        const game = gameManager.createGame(ids);
        ids.forEach((id, i) => game.addPlayer(id, `user_${id}`, i + 1, 1, false));
        ids.forEach((id, i) => game.setHand(id, [C(String(i + 2), 'hearts')]));
        game.currentHand = 1;
        game.trump = C('A', 'spades');
        game.phase = 'bidding';
        game.bidding = true;
        game.currentTurn = 1;
        game.playerBids = [];
        return { game, ids };
    }

    test('the human gets the seat back for real and the resign bot never acts for them', async () => {
        const log = [];
        const io = makeIo(log);
        const { game, ids } = biddingGame();
        const s = ids.map((id) => makeSocket(id, log));

        await queueHandlers.handleDisconnect(s[0], io);
        await gameHandlers.forceResign(s[1], io, { position: 1 }); // schedules the bot's bid
        const botSocketId = game.positions[1];

        // Rejoin on a fresh socket: resignation turns into lazy, as a spectator
        const fresh = makeSocket(`${ids[0]}-again`, log);
        gameManager.registerUser(fresh.id, `user_${ids[0]}`);
        await reconnectHandlers.rejoinGame(fresh, io, { gameId: game.gameId, username: `user_${ids[0]}` });
        expect(game.isSpectator(fresh.id)).toBe(true);

        chatHandlers.chatMessage(fresh, io, { message: '/active' });

        const seat = game.getPlayerByPosition(1);
        expect(seat.socketId).toBe(fresh.id);
        expect(seat.isBot).toBe(false);
        expect(game.isResigned(1)).toBe(false);
        expect(game.isLazy(1)).toBe(false);
        expect(botController.getBot(game.gameId, botSocketId)).toBeFalsy();
        expect(gameManager.playerGames.has(botSocketId)).toBe(false);
        const restored = events(log, 'restorePlayerState').find((l) => l.to === `self:${fresh.id}`);
        expect(restored.data.position).toBe(1);
        expect(restored.data.hand).toEqual([C('2', 'hearts')]);

        // The resign bot's pending bid must not fire for the human
        await jest.advanceTimersByTimeAsync(10000);
        expect(game.playerBids[0]).toBeUndefined();

        // Private events (e.g. next hand's cards) reach the seat again
        const before = log.length;
        game.sendToPlayer(io, fresh.id, 'gameStart', {});
        expect(log.length).toBe(before + 1);

        // And the human can act on their turn
        await gameHandlers.playerBid(fresh, io, { bid: '1' });
        expect(game.playerBids[0]).toBe('1');
    });

    test('/active re-sends updateTurn so the returning player can act on their turn', () => {
        const log = [];
        const io = makeIo(log);
        const { game, ids } = biddingGame();
        const s0 = makeSocket(ids[0], log);

        chatHandlers.chatMessage(s0, io, { message: '/lazy' });
        log.length = 0;
        chatHandlers.chatMessage(s0, io, { message: '/active' });

        const turn = log.find((l) => l.to === ids[0] && l.event === 'updateTurn');
        expect(turn.data).toEqual({ currentTurn: 1 });
        expect(game.isLazy(1)).toBe(false);
    });
});

describe('zero-bid redeal', () => {
    test('all-zero bids redeal without a doneBidding first', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `z${seq}-h${n}`);
        ids.forEach((id) => gameManager.registerUser(id, `user_${id}`));
        const game = gameManager.createGame(ids);
        ids.forEach((id, i) => game.addPlayer(id, `user_${id}`, i + 1, 1, false));
        ids.forEach((id, i) => game.setHand(id, [C(String(i + 2), 'hearts')]));
        game.currentHand = 1;
        game.trump = C('A', 'spades');
        game.phase = 'bidding';
        game.bidding = true;
        game.currentTurn = 1;
        game.playerBids = [];

        for (const id of ids) await gameHandlers.playerBid(makeSocket(id, log), io, { bid: '0' });

        const names = log.map((l) => l.event);
        expect(names).not.toContain('doneBidding');
        expect(names.indexOf('destroyHands')).toBeGreaterThan(-1);
        expect(names.indexOf('gameStart')).toBeGreaterThan(names.indexOf('destroyHands'));
        expect(events(log, 'gameLogEntry').some((l) => /zero/i.test(l.data.message))).toBe(true);
        expect(game.bidding).toBe(true);
        expect(game.playerBids).toEqual([]);
    });
});

describe('disconnect broadcasts', () => {
    test('a disconnect sends no global queueUpdate', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        await queueHandlers.handleDisconnect(makeSocket(`q${seq}`, log), io);
        expect(log.some((l) => l.event === 'queueUpdate')).toBe(false);
    });
});

describe('active-game DB writes skip bots', () => {
    test('clearActiveGameForAll clears the humans behind lazy/resigned seats and skips bots', async () => {
        seq++;
        const ids = [1, 2, 3].map((n) => `c${seq}-h${n}`);
        const bot = botController.createBot('🤖 Pat', 'mary');
        const game = gameManager.createGame([...ids, bot.socketId]);
        game.addPlayer(ids[0], 'alice', 1, 1, false);
        game.addPlayer(ids[1], '🤖 Lazy', 2, 1, false);
        game.lazyPlayers[2] = { botSocketId: 'bot:x', originalUsername: 'bob', originalSocketId: ids[1] };
        game.addPlayer('bot:resign', '🤖 Res', 3, 1, true);
        game.resignedPlayers[3] = { username: 'carol', pic: 1, originalSocketId: ids[2] };
        game.addPlayer(bot.socketId, bot.username, 4, 1, true);

        await gameManager.clearActiveGameForAll(game.gameId);

        expect(updateSpy.mock.calls.map(([f]) => f.username).sort()).toEqual(['alice', 'bob', 'carol']);
    });
});
