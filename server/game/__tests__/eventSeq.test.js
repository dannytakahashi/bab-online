/**
 * GameState.eventSeq: +1 per room broadcast and +1 per deal; private sends
 * and broadcasts dropped from a terminal game never bump it.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const GameState = require('../GameState');
const gameManager = require('../GameManager');
const gameHandlers = require('../../socket/gameHandlers');
const Deck = require('../Deck');
const { Phase } = require('../GamePhase');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

test('one bump per room broadcast; private sends never bump; terminal drops never bump', () => {
    const log = [];
    const io = makeIo(log);
    const game = new GameState('seq-unit');
    expect(game.eventSeq).toBe(0);
    game.broadcast(io, 'gameLogEntry', { message: 'a', type: 'system' });
    game.broadcast(io, 'gameLogEntry', { message: 'b', type: 'system' });
    expect(game.eventSeq).toBe(2);
    game.sendToPlayer(io, 's1', 'updateTurn', { currentTurn: 1 });
    expect(game.eventSeq).toBe(2);
    game.terminate(io, Phase.ABORTED, 'abortGame', { reason: 'x' });
    expect(game.eventSeq).toBe(3); // the final event goes through broadcast
    game.broadcast(io, 'gameLogEntry', { message: 'late', type: 'system' });
    expect(game.eventSeq).toBe(3);
    expect(log.filter((l) => l.to === game.roomName)).toHaveLength(3);
    expect(game.toJSON().eventSeq).toBe(3);
});

test('a real draw + deal: every room broadcast and each deal bump exactly once', async () => {
    const log = [];
    const io = makeIo(log);
    const ids = [1, 2, 3, 4].map((n) => `seq-h${n}`);
    ids.forEach((id) => {
        gameManager.registerUser(id, `seq_${id}`);
        mockDb.current.users._insert({ username: `seq_${id}`, profilePic: 5 });
    });
    const sockets = ids.map((id) => makeSocket(id, log, io));
    const game = gameManager.createGame(ids);
    sockets.forEach((s) => s.join(game.roomName));
    game.deck = new Deck();
    game.transition(Phase.CREATED, Phase.DRAWING);
    sockets.forEach((s) => gameHandlers.draw(s, io, { num: 0 }));
    await jest.advanceTimersByTimeAsync(6000);
    expect(game.stage).toBe(Phase.BIDDING);
    const room = log.filter((l) => l.to === game.roomName).length;
    const deals = 1;
    expect(game.eventSeq).toBe(room + deals);
    // An all-zero redeal deals again: one more bump for the deal
    const sock = (pos) => sockets[ids.indexOf(game.positions[pos])];
    for (let i = 0; i < 4; i++) await gameHandlers.playerBid(sock(game.currentTurn), io, { bid: '0' });
    const room2 = log.filter((l) => l.to === game.roomName).length;
    expect(game.eventSeq).toBe(room2 + 2);
});
