/**
 * contract/V1_REMOVALS.md #18 (2026-11-11): joinLobby, removeBot,
 * searchPlayers and getPlayerProfile are Joi-checked by their socket
 * wrapper (index.js registers them exactly so: contract.test.js pins the
 * wrapper names). What web on main and iOS 1.1.0 send still passes; a bad
 * payload gets the wrapper's validation error and never reaches the
 * handler. removeBot removes only a bot. (Voice relays: voiceSignaling.test.js.)
 *
 * Real handlers on stub io/sockets (contract guard on), the in-memory DB.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const gameManager = require('../../game/GameManager');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const profileHandlers = require('../profileHandlers');
const { asyncHandler, syncHandler, rateLimiter } = require('../errorHandler');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

// As index.js registers them
const joinLobby = syncHandler('joinLobby', mainRoomHandlers.joinLobby);
const removeBot = syncHandler('removeBot', lobbyHandlers.removeBot);
const searchPlayers = asyncHandler('searchPlayers', profileHandlers.searchPlayers);
const getPlayerProfile = asyncHandler('getPlayerProfile', profileHandlers.getPlayerProfile);

let seq = 0;
let log;
let io;

beforeEach(() => {
    seq++;
    log = [];
    io = makeIo(log);
    mockDb.current = createMemoryDb({ users: [{ username: 'hard_alan', profilePic: 3, stats: { gamesPlayed: 1, wins: 1 } }] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn', 'error']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.currentUsers = [];
    jest.restoreAllMocks();
});
afterAll(() => rateLimiter.shutdown());

function user(tag) {
    const s = makeSocket(`hard${seq}-${tag}`, log, io);
    gameManager.registerUser(s.id, `hard_${tag}${seq}`);
    rateLimiter.clearSocket(s.id);
    return s;
}
const to = (s, event) => log.filter((l) => l.to === `self:${s.id}` && l.event === event).map((l) => l.data);
const validationErrors = (s) => to(s, 'error').filter((d) => d.type === 'validation');

describe('joinLobby', () => {
    test('a lobby id (uuid) as both clients send it joins; anything else is a validation error', () => {
        const a = user('a');
        const b = user('b');
        mainRoomHandlers.createLobby(a, io, { name: 'x' });
        const lobbyId = gameManager.getPlayerLobby(a.id).id;
        for (const bad of [undefined, {}, { lobbyId: 'lobby-1' }, { lobbyId: 7 }]) joinLobby(b, io, bad);
        expect(validationErrors(b)).toHaveLength(4);
        expect(gameManager.playerLobbies.has(b.id)).toBe(false);
        joinLobby(b, io, { lobbyId });
        expect(gameManager.playerLobbies.get(b.id)).toBe(lobbyId);
        expect(to(b, 'lobbyCreated')).toHaveLength(1);
    });
});

describe('removeBot', () => {
    test('{botSocketId} of a bot removes it; no payload, a non-bot id or a human member is refused', () => {
        const a = user('a');
        const b = user('b');
        mainRoomHandlers.createLobby(a, io, { name: 'x' });
        const lobby = gameManager.getPlayerLobby(a.id);
        mainRoomHandlers.joinLobby(b, io, { lobbyId: lobby.id });
        lobbyHandlers.addBot(a, io);
        const botId = lobby.players.find((p) => p.isBot).socketId;

        removeBot(a, io, undefined); // the gated 1.0.0's payload-less form
        removeBot(a, io, {});
        removeBot(a, io, { botSocketId: b.id }); // a human's socket id from the lobby list
        expect(validationErrors(a)).toHaveLength(3);
        expect(lobby.players.map((p) => p.socketId)).toEqual([a.id, b.id, botId]);

        // Past Joi, the lobby code itself never removes a human either
        expect(gameManager.removeBotFromLobby(lobby.id, b.id)).toMatchObject({ success: false });
        expect(lobby.players).toHaveLength(3);

        removeBot(a, io, { botSocketId: botId });
        expect(lobby.players.map((p) => p.socketId)).toEqual([a.id, b.id]);
        expect(to(a, 'error').filter((d) => d.type !== 'validation')).toEqual([]);
    });
});

describe('profile lookups (web)', () => {
    test('searchPlayers: a query string passes (a blank one gets the handler answer); a missing, non-string or huge one is a validation error', async () => {
        const a = user('a');
        await searchPlayers(a, io, { query: 'alan' });
        await searchPlayers(a, io, { query: '' });
        expect(to(a, 'searchPlayersResponse').map((r) => r.success)).toEqual([true, false]);
        expect(to(a, 'searchPlayersResponse')[0].players.map((p) => p.username)).toEqual(['hard_alan']);
        for (const bad of [undefined, {}, { query: 5 }, { query: 'x'.repeat(501) }]) await searchPlayers(a, io, bad);
        expect(validationErrors(a)).toHaveLength(4);
        expect(to(a, 'searchPlayersResponse')).toHaveLength(2);
    });

    test('getPlayerProfile: a username (a bot name included) passes; a missing, empty or huge one is a validation error', async () => {
        const a = user('a');
        await getPlayerProfile(a, io, { username: 'hard_alan' });
        await getPlayerProfile(a, io, { username: '🤖 Mary' });
        expect(to(a, 'playerProfileResponse').map((r) => r.success)).toEqual([true, false]);
        for (const bad of [undefined, {}, { username: '' }, { username: 'x'.repeat(101) }]) await getPlayerProfile(a, io, bad);
        expect(validationErrors(a)).toHaveLength(4);
        expect(to(a, 'playerProfileResponse')).toHaveLength(2);
    });
});
