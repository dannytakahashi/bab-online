/**
 * A lobby seat outlives its socket by GameManager.LOBBY_SEAT_GRACE_MS (30 s;
 * live check 2026-11-11: a reload by the lobby's only human deleted the
 * lobby, so the player came back to the main room without their bots and
 * settings). The web client re-sends joinLobby after every restore (a
 * reload too: the lobby id is in sessionStorage), and the re-entry takes the
 * held seat back through the existing machinery (findStaleLobbySeat ->
 * takeOverLobbySeat). With nobody back in time the seat leaves as a leave.
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
            const s = makeSocket(`lg${seq}-${username}-${n}`, log, io);
            s.disconnect = () => w.kill(s);
            await authHandlers.restoreSession(s, io, { username, sessionToken: tokens.get(username) });
            expect(events(log, 'restoreSessionResponse').filter((l) => l.to === `self:${s.id}`).pop().data.success).toBe(true);
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
        /** The transport closed (a reload, a tab closed, a network drop the server noticed). */
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

const seats = (lobby) => lobby.players.map((p) => p.username);

async function lobbyWithBots(w, host, bots = 3) {
    const s = await w.connect(host);
    mainRoomHandlers.createLobby(s, w.io, { name: 'My table' });
    const lobby = gameManager.getPlayerLobby(s.id);
    for (let i = 0; i < bots; i++) lobbyHandlers.addBot(s, w.io);
    return { s, lobby, lobbyId: lobby.id };
}

const listed = (w, lobbyId, from = 0) => {
    const last = events(w.log.slice(from), 'lobbiesUpdated').filter((l) => l.to === 'mainRoom').pop();
    return last ? last.data.lobbies.some((l) => l.id === lobbyId) : null;
};

describe('the only human with 3 bots reloads', () => {
    test('the lobby, its name and its bots are held; the reload re-enters the same seat within the grace', async () => {
        const w = world();
        const ann = `ann${seq}`;
        const { s, lobby, lobbyId } = await lobbyWithBots(w, ann);
        const before = lobby.players.map((p) => ({ ...p }));

        await w.kill(s);
        expect(gameManager.lobbies.get(lobbyId)).toBe(lobby);
        expect(seats(lobby)).toEqual(before.map((p) => p.username));
        expect(gameManager.reconnectingIn(lobbyId)).toEqual([ann]);
        expect(gameManager.playerLobbies.has(s.id)).toBe(false);
        expect(listed(w, lobbyId)).toBe(true);

        jest.advanceTimersByTime(GRACE - 1000);
        const s2 = await w.connect(ann);
        const from = w.log.length;
        mainRoomHandlers.joinLobby(s2, w.io, { lobbyId });

        expect(seats(lobby)).toEqual(before.map((p) => p.username));
        expect(lobby.players[0].socketId).toBe(s2.id);
        expect(lobby.players.slice(1).map((p) => p.socketId)).toEqual(before.slice(1).map((p) => p.socketId));
        expect(lobby.name).toBe('My table');
        expect(gameManager.reconnectingIn(lobbyId)).toEqual([]);
        expect(gameManager.lobbyGrace.size).toBe(0);
        const created = w.to(s2.id, from).find((l) => l.event === 'lobbyCreated').data;
        expect(created.lobbyId).toBe(lobbyId);
        expect(created).not.toHaveProperty('reconnecting');
        expect(created.players.map((p) => p.username)).toEqual(before.map((p) => p.username));
        expect(w.to(s2.id, from).map((l) => l.event)).not.toContain('error');

        // The grace timer is gone: nothing happens when it would have fired
        const after = w.log.length;
        jest.advanceTimersByTime(GRACE);
        expect(gameManager.lobbies.get(lobbyId)).toBe(lobby);
        expect(w.log.slice(after).map((l) => l.event)).not.toContain('lobbyPlayerLeft');

        // And it still starts: ready-up with the bots
        lobbyHandlers.playerReady(s2, w.io);
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
        expect(gameManager.getPlayerGame(s2.id)).toBeTruthy();
    });

    test('closing the tab: the lobby is removed when the grace runs out (as before, just later)', async () => {
        const w = world();
        const { s, lobbyId } = await lobbyWithBots(w, `ann${seq}`);
        await w.kill(s);
        jest.advanceTimersByTime(GRACE - 1);
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);
        const from = w.log.length;
        jest.advanceTimersByTime(1);
        expect(gameManager.lobbies.has(lobbyId)).toBe(false);
        expect([...gameManager.playerLobbies.values()]).not.toContain(lobbyId);
        expect(gameManager.lobbyGrace.size).toBe(0);
        expect(listed(w, lobbyId, from)).toBe(false);

        // Coming back after that: the lobby is gone (the client's toast)
        const s2 = await w.connect(`ann${seq}`);
        const at = w.log.length;
        mainRoomHandlers.joinLobby(s2, w.io, { lobbyId });
        expect(w.to(s2.id, at).map((l) => [l.event, l.data?.message])).toEqual([['error', 'Lobby not found']]);
    });

    test('a stranger cannot take the held seat of a full lobby', async () => {
        const w = world();
        const { s, lobby, lobbyId } = await lobbyWithBots(w, `ann${seq}`);
        await w.kill(s);
        const eve = await w.connect(`eve${seq}`);
        const from = w.log.length;
        mainRoomHandlers.joinLobby(eve, w.io, { lobbyId });
        expect(w.to(eve.id, from).map((l) => [l.event, l.data?.message])).toEqual([['error', 'Lobby is full']]);
        expect(seats(lobby)[0]).toBe(`ann${seq}`);
    });

    test('creating another lobby during the grace gives the held seat up at once', async () => {
        const w = world();
        const { s, lobbyId } = await lobbyWithBots(w, `ann${seq}`);
        await w.kill(s);
        const s2 = await w.connect(`ann${seq}`);
        mainRoomHandlers.createLobby(s2, w.io, {});
        expect(gameManager.lobbies.has(lobbyId)).toBe(false);
        expect(gameManager.lobbyGrace.size).toBe(0);
        jest.advanceTimersByTime(GRACE);
        expect(gameManager.getPlayerLobby(s2.id)).toBeTruthy();
    });
});

describe('a non-host member reloads', () => {
    async function twoHumans(w) {
        const ann = await w.connect(`ann${seq}`);
        mainRoomHandlers.createLobby(ann, w.io, { name: 'Pair' });
        const lobbyId = gameManager.getPlayerLobby(ann.id).id;
        const bob = await w.connect(`bob${seq}`);
        mainRoomHandlers.joinLobby(bob, w.io, { lobbyId });
        lobbyHandlers.addBot(ann, w.io);
        lobbyHandlers.addBot(ann, w.io);
        return { ann, bob, lobbyId, lobby: gameManager.getLobbyById(lobbyId) };
    }

    test('the others see the seat as reconnecting; the member returns to the same seat', async () => {
        const w = world();
        const { ann, bob, lobbyId, lobby } = await twoHumans(w);
        lobbyHandlers.playerReady(ann, w.io);
        lobbyHandlers.playerReady(bob, w.io);
        const names = seats(lobby);

        const from = w.log.length;
        await w.kill(bob);
        const annGot = w.to(ann.id, from);
        const update = annGot.find((l) => l.event === 'playerReadyUpdate').data;
        expect(update.reconnecting).toEqual([`bob${seq}`]);
        expect(update.players.map((p) => p.username)).toEqual(names);
        expect(annGot.find((l) => l.event === 'voicePeerLeft').data).toEqual({ socketId: bob.id });
        expect(annGot.map((l) => l.event)).not.toContain('lobbyPlayerLeft');
        // ann keeps her ready flag; bob's resets
        expect(lobby.players.find((p) => p.username === `ann${seq}`).ready).toBe(true);
        expect(lobby.players.find((p) => p.username === `bob${seq}`).ready).toBe(false);

        // While held, every playerReadyUpdate names the seat (a new render keeps it)
        lobbyHandlers.playerUnready(ann, w.io);
        expect(events(w.log, 'playerReadyUpdate').filter((l) => l.to === ann.id).pop().data.reconnecting).toEqual([`bob${seq}`]);

        const bob2 = await w.connect(`bob${seq}`);
        const back = w.log.length;
        mainRoomHandlers.joinLobby(bob2, w.io, { lobbyId });
        expect(seats(lobby)).toEqual(names);
        expect(lobby.players[1].socketId).toBe(bob2.id);
        const joined = w.to(ann.id, back).find((l) => l.event === 'lobbyPlayerJoined').data;
        expect(joined.newPlayer.username).toBe(`bob${seq}`);
        expect(gameManager.reconnectingIn(lobbyId)).toEqual([]);
        lobbyHandlers.playerReady(ann, w.io);
        expect(events(w.log, 'playerReadyUpdate').filter((l) => l.to === ann.id).pop().data).not.toHaveProperty('reconnecting');
    });

    test('someone joining during the grace sees the held seat (lobbyCreated)', async () => {
        const w = world();
        const ann = await w.connect(`ann${seq}`);
        mainRoomHandlers.createLobby(ann, w.io, {});
        const lobbyId = gameManager.getPlayerLobby(ann.id).id;
        const bob = await w.connect(`bob${seq}`);
        mainRoomHandlers.joinLobby(bob, w.io, { lobbyId });
        await w.kill(bob);
        const cat = await w.connect(`cat${seq}`);
        const from = w.log.length;
        mainRoomHandlers.joinLobby(cat, w.io, { lobbyId });
        const created = w.to(cat.id, from).find((l) => l.event === 'lobbyCreated').data;
        expect(created.reconnecting).toEqual([`bob${seq}`]);
        expect(created.players.map((p) => p.username)).toEqual([`ann${seq}`, `bob${seq}`, `cat${seq}`]);
    });

    test('the game cannot start while a seat is held, even with everyone else ready', async () => {
        const w = world();
        const { ann, bob, lobbyId } = await twoHumans(w);
        lobbyHandlers.playerReady(bob, w.io);
        await w.kill(bob);
        lobbyHandlers.playerReady(ann, w.io);
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
        expect(gameManager.getPlayerGame(ann.id)).toBeFalsy();
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);
    });

    test('the member does not come back: it leaves when the grace runs out; the lobby stays for the host', async () => {
        const w = world();
        const { ann, bob, lobbyId, lobby } = await twoHumans(w);
        lobbyHandlers.playerReady(ann, w.io);
        await w.kill(bob);
        const from = w.log.length;
        jest.advanceTimersByTime(GRACE);
        expect(gameManager.lobbies.has(lobbyId)).toBe(true);
        expect(seats(lobby)).not.toContain(`bob${seq}`);
        const left = w.to(ann.id, from).find((l) => l.event === 'lobbyPlayerLeft').data;
        expect(left.leftUsername).toBe(`bob${seq}`);
        expect(left.players.map((p) => p.username)).toEqual(seats(lobby));
        // as a leave: every ready flag resets
        expect(lobby.players.every((p) => !p.ready)).toBe(true);
        expect(listed(w, lobbyId, from)).toBe(true);
    });

    test('the host reloads while the member stays: the host comes back to the same (first) seat', async () => {
        const w = world();
        const { ann, bob, lobbyId, lobby } = await twoHumans(w);
        await w.kill(ann);
        expect(events(w.log, 'playerReadyUpdate').filter((l) => l.to === bob.id).pop().data.reconnecting).toEqual([`ann${seq}`]);
        const ann2 = await w.connect(`ann${seq}`);
        mainRoomHandlers.joinLobby(ann2, w.io, { lobbyId });
        expect(lobby.players[0]).toMatchObject({ username: `ann${seq}`, socketId: ann2.id });
        expect(gameManager.getAllLobbies().find((l) => l.id === lobbyId).name).toBe('Pair');
    });

    test('a sign-out (forceLogout path) leaves at once: no grace', async () => {
        const w = world();
        const { bob, lobby } = await twoHumans(w);
        authHandlers.signOutUser(w.io, `bob${seq}`);
        expect(seats(lobby)).not.toContain(`bob${seq}`);
        expect(gameManager.lobbyGrace.size).toBe(0);
        expect(bob).toBeTruthy();
    });
});
