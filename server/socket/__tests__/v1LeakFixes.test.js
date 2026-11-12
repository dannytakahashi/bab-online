/**
 * contract/V1_REMOVALS.md #15 and #16 (leak fixes, 2026-11-11):
 *
 * - #16: a lobby bot's personality never reaches the wire (the lobby shows
 *   "🤖 Bot"); it stays server-side and the game still reveals the bot it
 *   picked, without reusing one at the table.
 * - #15: rejoinFailed carries only `reason` (debug told whoever asked the
 *   table's usernames).
 *
 * Real handlers on stub io/sockets (gameDriver, contract guard on), the
 * in-memory DB fake, fake timers.
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
const lobbyHandlers = require('../lobbyHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const { botController, personalities } = require('../../game/bot');
const pacing = require('../../game/pacing');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.currentUsers = [];
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** Every key path in a payload, for "this name never appears" checks. */
function keysDeep(v, out = new Set()) {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
    return out;
}

function lobbyWithBots(nBots) {
    seq++;
    const log = [];
    const io = makeIo(log);
    const id = `leak${seq}-h`;
    gameManager.registerUser(id, `leakann${seq}`);
    const sock = makeSocket(id, log, io);
    const lobby = gameManager.createLobby([id]);
    for (let i = 0; i < nBots; i++) lobbyHandlers.addBot(sock, io);
    return { io, log, sock, lobby };
}

describe('#16 lobby bots keep their personality server-side', () => {
    test('no lobby payload carries personality; the lobby still shows the generic names', () => {
        const { log, lobby } = lobbyWithBots(3);
        const lobbyEvents = log.filter((l) => l.data && Array.isArray(l.data.players));
        expect(lobbyEvents.length).toBeGreaterThanOrEqual(3);
        for (const l of log) expect({ event: l.event, leaks: keysDeep(l.data).has('personality') }).toEqual({ event: l.event, leaks: false });
        expect(lobby.players.slice(1).map((p) => p.username)).toEqual(['🤖 Bot', '🤖 Bot 2', '🤖 Bot 3']);
        // the projection the lobby list uses has no personality either
        expect(keysDeep(gameManager.getAllLobbies()).has('personality')).toBe(false);
    });

    test('three bots get three different personalities, and the game reveals exactly those', async () => {
        const { io, sock, lobby } = lobbyWithBots(3);
        const picked = lobby.players.slice(1).map((p) => gameManager.lobbyBotPersonality(lobby, p.socketId));
        expect(new Set(picked).size).toBe(3);
        for (const p of picked) expect(personalities.PERSONALITY_LIST).toContain(p);

        lobbyHandlers.playerReady(sock, io); // runs on through the game: not awaited
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + 10);
        const game = gameManager.getPlayerGame(sock.id);
        expect(game).toBeTruthy();
        const bots = botController.getGameBots(game.gameId);
        expect(bots.map((b) => b.personality).sort()).toEqual([...picked].sort());
        for (const b of bots) expect(b.username).toBe(`🤖 ${personalities.getDisplayName(b.personality)}`);
    });

    test('a removed bot frees its personality', () => {
        const { io, sock, lobby } = lobbyWithBots(1);
        const botId = lobby.players[1].socketId;
        expect(lobby.botPersonalities.has(botId)).toBe(true);
        lobbyHandlers.removeBot(sock, io, { botSocketId: botId });
        expect(lobby.players).toHaveLength(1);
        expect(lobby.botPersonalities.has(botId)).toBe(false);
    });
});

describe('#15 rejoinFailed tells only the reason', () => {
    test('a non-player asking for a seated game learns no usernames', async () => {
        const { io, sock, lobby } = lobbyWithBots(3);
        lobbyHandlers.playerReady(sock, io); // runs on through the game: not awaited
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + 10);
        const game = gameManager.getPlayerGame(sock.id);
        // play on until the seats exist (the draw ends within ~30 s)
        for (let i = 0; i < 80 && game.entrants !== null; i++) await jest.advanceTimersByTimeAsync(500);
        expect(game.entrants).toBeNull();

        const log = [];
        const io2 = makeIo(log);
        const outsider = makeSocket(`leak${seq}-out`, log, io2);
        gameManager.registerUser(outsider.id, `leakbob${seq}`);
        await reconnectHandlers.rejoinGame(outsider, io2, { gameId: game.gameId, username: `leakbob${seq}` });
        const failed = log.filter((l) => l.event === 'rejoinFailed');
        expect(failed).toHaveLength(1);
        expect(failed[0].data).toEqual({ reason: 'Not a player in this game' });
    });
});
