/**
 * contract/V1_REMOVALS.md #13 (2026-11-11): the main-room handlers send
 * mainRoomJoined without the recentMessages copy of messages (web reads
 * messages; iOS 1.1.0 reads recentMessages ?? messages). Only the upgrade
 * gate's 1.0.0 payload keeps it (upgradeGate.test.js checks that one).
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
const tournamentHandlers = require('../tournamentHandlers');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const MAIN_ROOM_KEYS = ['inProgressGames', 'lobbies', 'messages', 'onlineCount', 'onlineUsers', 'tournaments'];

beforeEach(() => {
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.mainRoomMessages = [];
    gameManager.currentUsers = [];
    jest.restoreAllMocks();
});

test('joinMainRoom, leaveLobby and a tournament leave all send messages and no recentMessages', async () => {
    const log = [];
    const io = makeIo(log);
    const s = makeSocket('mrj-1', log, io);
    gameManager.registerUser(s.id, 'mrj_ann');
    const t = makeSocket('mrj-2', log, io);
    gameManager.registerUser(t.id, 'mrj_bob');

    mainRoomHandlers.joinMainRoom(s, io);
    mainRoomHandlers.mainRoomChat(s, io, { message: 'hi all' });
    mainRoomHandlers.joinMainRoom(t, io);
    mainRoomHandlers.createLobby(s, io, { name: 'x' });
    lobbyHandlers.leaveLobby(s, io);
    await tournamentHandlers.leaveTournament(s, io); // nothing to leave: back to the main room

    const joined = log.filter((l) => l.event === 'mainRoomJoined');
    expect(joined).toHaveLength(4);
    // the replay is under messages (the last one, sent after the chat line)
    expect(joined[3].data.messages.map((m) => m.message)).toContain('hi all');
    for (const l of joined) {
        expect(Object.keys(l.data).sort()).toEqual(MAIN_ROOM_KEYS);
        expect(Array.isArray(l.data.messages)).toBe(true);
    }
});
