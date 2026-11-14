/**
 * Ready first, then Add Bot until the lobby is full (owner report
 * 2026-11-13, iOS: "if you ready before adding all bots, then add all bots,
 * the bots don't auto ready until you unready and then ready again"). Only a
 * human's playerReady used to ready the bots, so a lobby filled by addBot
 * after its humans readied sat there. Now the bot that fills a lobby whose
 * humans are all ready readies the bots (GameManager.readyBotsIfHumansReady)
 * and the game starts through the ready path's own tail
 * (lobbyHandlers startLobbyIfAllReady), with the event order the clients
 * already handle: playerReadyUpdate (all 4 ready) -> allPlayersReady ->
 * startDraw. A human who is not ready, or a seat held for its reconnect
 * grace, still keeps the lobby waiting.
 *
 * Real handlers on the in-memory DB fake, stub io/sockets, fake timers.
 */

const crypto = require('crypto');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const gameManager = require('../../game/GameManager');
const GRACE = gameManager.constructor.LOBBY_SEAT_GRACE_MS;
const authHandlers = require('../authHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const queueHandlers = require('../queueHandlers');
const pacing = require('../../game/pacing');
const { hashToken } = require('../../utils/sessionTokens');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
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
    for (const sid of Array.from(gameManager.lobbyGrace.keys())) gameManager._clearLobbyGrace(sid);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.currentUsers = [];
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

function world() {
    seq++;
    const log = [];
    const io = makeIo(log);
    const tokens = new Map();
    let n = 0;
    const w = {
        log, io,
        async connect(username) {
            if (!tokens.has(username)) {
                const token = crypto.randomBytes(12).toString('hex');
                tokens.set(username, token);
                const now = new Date();
                mockDb.current.users._insert({
                    username, profilePic: 3,
                    sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }],
                });
            }
            n++;
            const s = makeSocket(`rb${seq}-${username}-${n}`, log, io);
            s.disconnect = () => w.kill(s);
            await authHandlers.restoreSession(s, io, { username, sessionToken: tokens.get(username) });
            expect(events(log, 'restoreSessionResponse').filter((l) => l.to === `self:${s.id}`).pop().data.success).toBe(true);
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
        to(sid, from = 0) {
            return w.log.slice(from).filter((l) => l.to === sid || l.to === `self:${sid}`);
        },
    };
    return w;
}

/** A lobby with `humans` signed-in players (the first one hosts). */
async function lobbyOf(w, humans) {
    const socks = [];
    for (let i = 0; i < humans; i++) socks.push(await w.connect(`p${i}x${seq}`));
    mainRoomHandlers.createLobby(socks[0], w.io, { name: 'Table' });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    return { socks, lobbyId, lobby: gameManager.getLobbyById(lobbyId) };
}

const startDelays = () => pacing().LOBBY_START_MS;
const countdown = () => pacing().PREDRAW_COUNTDOWN_MS;

/** Settle the start tail: the lobby delay, then the pre-draw countdown. */
async function runStart() {
    await jest.advanceTimersByTimeAsync(startDelays());
    await jest.advanceTimersByTimeAsync(countdown());
}

describe('Ready, then Add Bot until the lobby is full: the game starts', () => {
    test.each([
        [1, 3],
        [2, 2],
        [3, 1],
    ])('%i human(s) ready, then %i bot(s) added', async (humans, bots) => {
        const w = world();
        const { socks, lobbyId, lobby } = await lobbyOf(w, humans);
        for (const s of socks) lobbyHandlers.playerReady(s, w.io);
        await jest.advanceTimersByTimeAsync(startDelays());
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);

        // Every bot but the last: the lobby is not full, nothing is readied
        for (let i = 0; i < bots - 1; i++) {
            await lobbyHandlers.addBot(socks[0], w.io);
            expect(lobby.players.filter((p) => p.isBot).every((p) => !p.ready)).toBe(true);
        }
        await jest.advanceTimersByTimeAsync(startDelays());
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);

        const from = w.log.length;
        const adding = lobbyHandlers.addBot(socks[0], w.io);
        // The bots are readied before the player list goes out
        expect(lobby.players.every((p) => p.ready)).toBe(true);
        expect(lobby.readyPlayers.size).toBe(4);
        await runStart();
        await adding;

        const game = gameManager.getPlayerGame(socks[0].id);
        expect(game).toBeTruthy();
        expect(gameManager.lobbies.has(lobbyId)).toBe(false);
        for (const s of socks) {
            expect(gameManager.getPlayerGame(s.id)).toBe(game);
            const got = w.to(s.id, from);
            const order = got.map((l) => l.event).filter((e) => ['playerReadyUpdate', 'allPlayersReady'].includes(e));
            expect(order).toEqual(['playerReadyUpdate', 'allPlayersReady']);
            const update = got.find((l) => l.event === 'playerReadyUpdate').data;
            expect(update.lobbyId).toBe(lobbyId);
            expect(update.players).toHaveLength(4);
            expect(update.players.every((p) => p.ready)).toBe(true);
            expect(got.find((l) => l.event === 'allPlayersReady').data).toEqual({ gameId: game.gameId });
            expect(got.map((l) => l.event)).not.toContain('serverError');
        }
        // The same start as the ready path: bots registered, the draw began
        expect(Array.from(game.entrants?.values?.() || []).filter((e) => e.isBot)).toHaveLength(bots);
        const draw = events(w.log.slice(from), 'startDraw');
        expect(draw.length).toBeGreaterThan(0);
        expect(draw[0].at).toBeGreaterThanOrEqual(w.log.slice(from).find((l) => l.event === 'allPlayersReady').at);
    });

    test('the start is the one the ready path makes: the same events, in the same order', async () => {
        // Ready path: add 3 bots, then Ready
        const w1 = world();
        const a = await lobbyOf(w1, 1);
        for (let i = 0; i < 3; i++) await lobbyHandlers.addBot(a.socks[0], w1.io);
        const from1 = w1.log.length;
        const p1 = lobbyHandlers.playerReady(a.socks[0], w1.io);
        await runStart();
        await p1;

        // Ready first, then the last bot
        const w2 = world();
        const b = await lobbyOf(w2, 1);
        for (let i = 0; i < 2; i++) await lobbyHandlers.addBot(b.socks[0], w2.io);
        lobbyHandlers.playerReady(b.socks[0], w2.io);
        const from2 = w2.log.length;
        const p2 = lobbyHandlers.addBot(b.socks[0], w2.io);
        await runStart();
        await p2;

        const seen = (w, s, from) => w.to(s.id, from).map((l) => l.event);
        const after1 = seen(w1, a.socks[0], from1);
        const after2 = seen(w2, b.socks[0], from2);
        expect(after2).toEqual(after1);
        expect(after2.slice(0, 2)).toEqual(['playerReadyUpdate', 'allPlayersReady']);
    });

    test('a human who is not ready keeps the lobby waiting; their Ready starts it', async () => {
        const w = world();
        const { socks, lobbyId, lobby } = await lobbyOf(w, 2);
        const [ann, bob] = socks;
        lobbyHandlers.playerReady(ann, w.io);
        await lobbyHandlers.addBot(ann, w.io);
        await lobbyHandlers.addBot(ann, w.io);
        await runStart();
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);
        expect(gameManager.getPlayerGame(ann.id)).toBeFalsy();
        expect(lobby.players.filter((p) => p.isBot).every((p) => !p.ready)).toBe(true);
        expect(events(w.log, 'allPlayersReady')).toHaveLength(0);

        const pending = lobbyHandlers.playerReady(bob, w.io);
        await runStart();
        await pending;
        expect(gameManager.getPlayerGame(ann.id)).toBeTruthy();
        expect(gameManager.getPlayerGame(bob.id)).toBe(gameManager.getPlayerGame(ann.id));
    });

    test('a human who unreadies inside the start delay stops the start (startGameFromLobby re-validates)', async () => {
        const w = world();
        const { socks, lobbyId } = await lobbyOf(w, 1);
        const [ann] = socks;
        lobbyHandlers.playerReady(ann, w.io);
        await lobbyHandlers.addBot(ann, w.io);
        await lobbyHandlers.addBot(ann, w.io);
        const pending = lobbyHandlers.addBot(ann, w.io);
        lobbyHandlers.playerUnready(ann, w.io);
        await runStart();
        await pending;
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);
        expect(gameManager.getPlayerGame(ann.id)).toBeFalsy();
        expect(events(w.log, 'allPlayersReady')).toHaveLength(0);
    });

    test('a seat held for its reconnect grace keeps the lobby waiting; the returner readies and it starts', async () => {
        const w = world();
        const { socks, lobbyId, lobby } = await lobbyOf(w, 2);
        const [ann, bob] = socks;
        lobbyHandlers.playerReady(ann, w.io);
        lobbyHandlers.playerReady(bob, w.io);
        await lobbyHandlers.addBot(ann, w.io);
        await w.kill(bob);
        expect(gameManager.reconnectingIn(lobbyId)).toEqual([`p1x${seq}`]);

        const from = w.log.length;
        await lobbyHandlers.addBot(ann, w.io);
        await runStart();
        expect(lobby.players).toHaveLength(4);
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);
        expect(gameManager.getPlayerGame(ann.id)).toBeFalsy();
        expect(lobby.players.filter((p) => p.isBot).every((p) => !p.ready)).toBe(true);
        expect(events(w.log, 'allPlayersReady')).toHaveLength(0);
        // The update still names the held seat
        expect(w.to(ann.id, from).find((l) => l.event === 'playerReadyUpdate').data.reconnecting).toEqual([`p1x${seq}`]);

        // bob comes back (not ready, as on every re-entry), readies: the game starts
        jest.advanceTimersByTime(GRACE / 2);
        const bob2 = await w.connect(`p1x${seq}`);
        mainRoomHandlers.joinLobby(bob2, w.io, { lobbyId });
        expect(gameManager.getPlayerGame(ann.id)).toBeFalsy();
        const pending = lobbyHandlers.playerReady(bob2, w.io);
        await runStart();
        await pending;
        expect(gameManager.getPlayerGame(ann.id)).toBeTruthy();
        expect(gameManager.getPlayerGame(bob2.id)).toBe(gameManager.getPlayerGame(ann.id));
    });

    test('a human who left and another who joined: the newcomer must ready first', async () => {
        const w = world();
        const { socks, lobbyId, lobby } = await lobbyOf(w, 2);
        const [ann, bob] = socks;
        lobbyHandlers.playerReady(ann, w.io);
        lobbyHandlers.playerReady(bob, w.io);
        lobbyHandlers.leaveLobby(bob, w.io);
        // As a leave: every ready flag resets
        expect(lobby.players.every((p) => !p.ready)).toBe(true);
        lobbyHandlers.playerReady(ann, w.io);
        const cat = await w.connect(`cat${seq}`);
        mainRoomHandlers.joinLobby(cat, w.io, { lobbyId });
        await lobbyHandlers.addBot(ann, w.io);
        await lobbyHandlers.addBot(ann, w.io);
        expect(lobby.players).toHaveLength(4);
        await runStart();
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);
        expect(events(w.log, 'allPlayersReady')).toHaveLength(0);

        const pending = lobbyHandlers.playerReady(cat, w.io);
        await runStart();
        await pending;
        expect(gameManager.getPlayerGame(cat.id)).toBeTruthy();
    });

    test('Ready, add bots, remove one, add one: the humans stay ready and the game starts', async () => {
        const w = world();
        const { socks, lobbyId, lobby } = await lobbyOf(w, 2);
        const [ann, bob] = socks;
        lobbyHandlers.playerReady(ann, w.io);
        await lobbyHandlers.addBot(ann, w.io);
        const botId = lobby.players.find((p) => p.isBot).socketId;
        // bob is not ready yet: full, no start; the ready path readied the bots on bob's Ready below
        await lobbyHandlers.addBot(ann, w.io);
        await runStart();
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);

        // A bot leaves: the humans keep their ready flags, the bots wait again
        lobbyHandlers.removeBot(bob, w.io, { botSocketId: botId });
        expect(lobby.players).toHaveLength(3);
        expect(lobby.players.find((p) => p.socketId === ann.id).ready).toBe(true);
        expect(lobby.readyPlayers.has(ann.id)).toBe(true);
        expect(lobby.players.filter((p) => p.isBot).every((p) => !p.ready && !lobby.readyPlayers.has(p.socketId))).toBe(true);
        lobbyHandlers.playerReady(bob, w.io); // 3 players: nothing starts
        await runStart();
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);
        expect(events(w.log, 'allPlayersReady')).toHaveLength(0);

        const pending = lobbyHandlers.addBot(bob, w.io);
        await runStart();
        await pending;
        expect(gameManager.getPlayerGame(ann.id)).toBeTruthy();
        expect(gameManager.getPlayerGame(bob.id)).toBe(gameManager.getPlayerGame(ann.id));
    });

    test('a removed bot unreadies the remaining bots: a human who was not ready still holds the start', async () => {
        const w = world();
        const { socks, lobbyId, lobby } = await lobbyOf(w, 2);
        const [ann, bob] = socks;
        await lobbyHandlers.addBot(ann, w.io);
        await lobbyHandlers.addBot(ann, w.io);
        lobbyHandlers.playerReady(ann, w.io); // full: the ready path readies both bots
        expect(lobby.players.filter((p) => p.isBot).every((p) => p.ready)).toBe(true);
        lobbyHandlers.removeBot(ann, w.io, { botSocketId: lobby.players.find((p) => p.isBot).socketId });
        expect(lobby.players.filter((p) => p.isBot).every((p) => !p.ready)).toBe(true);
        await lobbyHandlers.addBot(ann, w.io);
        await runStart();
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);
        expect(lobby.readyPlayers.has(bob.id)).toBe(false);
        expect(events(w.log, 'allPlayersReady')).toHaveLength(0);
    });

    test('a full lobby refuses another bot and starts nothing', async () => {
        const w = world();
        const { socks, lobbyId } = await lobbyOf(w, 1);
        const [ann] = socks;
        for (let i = 0; i < 3; i++) await lobbyHandlers.addBot(ann, w.io);
        const from = w.log.length;
        await lobbyHandlers.addBot(ann, w.io);
        await runStart();
        const got = w.to(ann.id, from).map((l) => l.event);
        expect(got).toContain('serverError');
        expect(got).not.toContain('error');
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);
        expect(events(w.log, 'allPlayersReady')).toHaveLength(0);
    });
});
