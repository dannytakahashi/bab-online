/**
 * Lobby re-entry from a new socket (half-open reconnect). The server keeps a
 * socket whose transport died without a close for up to pingInterval +
 * pingTimeout (~45 s). Meanwhile the same device reconnects (same session
 * token, so restoreSession never kicks the old socket) and the web client's
 * ClientSession re-sends joinLobby {lobbyId}. The user's seat must move to
 * the new socket in place: one seat, a full lobby lets its own player back
 * in, and the old socket's eventual disconnect changes nothing.
 *
 * Real handlers on the in-memory DB fake (never the local Mongo), stub
 * io/sockets from gameDriver, fake timers.
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
const authHandlers = require('../authHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const queueHandlers = require('../queueHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const { Phase } = require('../../game/GamePhase');
const pacing = require('../../game/pacing');
const { hashToken } = require('../../utils/sessionTokens');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    require('../signInThrottle')._reset();
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.currentUsers = [];
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/**
 * A world of devices. `device(name)` signs a user in on a fresh socket
 * through the real restoreSession (one saved token per device), so a second
 * `reconnect` of the same device carries the same session hash, as on a real
 * network blip.
 */
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
                const token = `tok-${seq}-${username}`;
                tokens.set(username, token);
                const now = new Date();
                mockDb.current.users._insert({
                    username, profilePic: 3,
                    sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }],
                });
            }
            n++;
            const s = makeSocket(`lr${seq}-${username}-${n}`, log, io);
            s.disconnect = () => w.kill(s);
            await authHandlers.restoreSession(s, io, { username, sessionToken: tokens.get(username) });
            const reply = events(log, 'restoreSessionResponse').filter((l) => l.to === `self:${s.id}`).pop();
            expect(reply.data.success).toBe(true);
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
        /** The server finally notices the old socket is gone. */
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
        to(sid, from = 0) {
            return log.slice(from).filter((l) => l.to === sid || l.to === `self:${sid}`);
        },
    };
    return w;
}

const seats = (lobby) => lobby.players.map((p) => p.username);

/** Lobby created by names[0], joined by the rest in order. */
async function lobbyOf(w, names) {
    const socks = [];
    for (const name of names) socks.push(await w.connect(name));
    mainRoomHandlers.createLobby(socks[0], w.io, { name: 'Re-entry table' });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    return { socks, lobbyId, lobby: gameManager.getLobbyById(lobbyId) };
}

describe('re-entering a pre-game lobby from a new socket', () => {
    test('the seat moves to the new socket in place: one seat, same position, existing events only', async () => {
        const w = world();
        const names = [`ann${seq}`, `bob${seq}`, `cat${seq}`];
        const { socks, lobbyId, lobby } = await lobbyOf(w, names);
        const [ann1, bob] = socks;

        // Half-open: ann1 is still in io.sockets (the server has not noticed)
        const ann2 = await w.connect(names[0]);
        const from = w.log.length;
        mainRoomHandlers.joinLobby(ann2, w.io, { lobbyId });

        expect(seats(lobby)).toEqual(names);
        expect(lobby.players[0].socketId).toBe(ann2.id);
        expect(gameManager.playerLobbies.get(ann2.id)).toBe(lobbyId);
        expect(gameManager.playerLobbies.has(ann1.id)).toBe(false);
        expect(gameManager.isInMainRoom(ann2.id)).toBe(false);

        // The re-entering socket gets the lobby (no error)
        const mine = w.to(ann2.id, from).map((l) => l.event);
        expect(mine).toContain('lobbyCreated');
        expect(mine).not.toContain('error');
        const created = w.to(ann2.id, from).find((l) => l.event === 'lobbyCreated').data;
        expect(created.players.map((p) => p.username)).toEqual(names);

        // Others see the same three seats and swap the voice peer
        const bobGot = w.to(bob.id, from);
        const joined = bobGot.find((l) => l.event === 'lobbyPlayerJoined').data;
        expect(joined.players.map((p) => p.username)).toEqual(names);
        expect(joined.newPlayer.socketId).toBe(ann2.id);
        expect(bobGot.find((l) => l.event === 'voicePeerLeft').data).toEqual({ socketId: ann1.id });
        expect(bobGot.find((l) => l.event === 'voicePeerJoined').data.socketId).toBe(ann2.id);
        expect(bobGot.map((l) => l.event)).not.toContain('lobbyPlayerLeft');

        // The old socket is told it left (a second live tab returns to the main room)
        expect(w.to(ann1.id, from).map((l) => l.event)).toEqual(['leftLobby']);

        // The main-room list shows three players, ann once
        const list = events(w.log.slice(from), 'lobbiesUpdated').pop().data.lobbies.find((l) => l.id === lobbyId);
        expect(list.players.map((p) => p.username)).toEqual(names);
    });

    test('a full lobby lets its own player back in (no "Lobby is full"); a stranger is still refused', async () => {
        const w = world();
        const names = [`ann${seq}`, `bob${seq}`, `cat${seq}`, `dan${seq}`];
        const { lobbyId, lobby } = await lobbyOf(w, names);

        const dan2 = await w.connect(names[3]);
        const from = w.log.length;
        mainRoomHandlers.joinLobby(dan2, w.io, { lobbyId });
        expect(w.to(dan2.id, from).map((l) => l.event)).not.toContain('error');
        expect(seats(lobby)).toEqual(names);
        expect(lobby.players[3].socketId).toBe(dan2.id);

        const eve = await w.connect(`eve${seq}`);
        const from2 = w.log.length;
        mainRoomHandlers.joinLobby(eve, w.io, { lobbyId });
        expect(w.to(eve.id, from2).map((l) => [l.event, l.data?.message])).toEqual([['error', 'Lobby is full']]);
        expect(seats(lobby)).toEqual(names);
    });

    test("only the returning player's ready flag resets; the others keep theirs", async () => {
        const w = world();
        const names = [`ann${seq}`, `bob${seq}`, `cat${seq}`, `dan${seq}`];
        const { socks, lobbyId, lobby } = await lobbyOf(w, names);
        const [ann1, bob, cat] = socks;
        lobbyHandlers.playerReady(ann1, w.io);
        lobbyHandlers.playerReady(bob, w.io);
        lobbyHandlers.playerReady(cat, w.io);

        const ann2 = await w.connect(names[0]);
        mainRoomHandlers.joinLobby(ann2, w.io, { lobbyId });

        expect(lobby.players.map((p) => p.ready)).toEqual([false, true, true, false]);
        expect([...lobby.readyPlayers].sort()).toEqual([bob.id, cat.id].sort());
        // The old socket can no longer ready on the seat's behalf
        const from = w.log.length;
        lobbyHandlers.playerReady(ann1, w.io);
        expect(w.to(ann1.id, from).map((l) => [l.event, l.data?.message])).toEqual([['error', 'Not in a lobby']]);
        expect(lobby.readyPlayers.has(ann1.id)).toBe(false);
    });

    test("the old socket's later disconnect neither removes the player nor resets anyone's ready flag", async () => {
        const w = world();
        const names = [`ann${seq}`, `bob${seq}`, `cat${seq}`, `dan${seq}`];
        const { socks, lobbyId, lobby } = await lobbyOf(w, names);
        const [ann1, bob, cat] = socks;
        lobbyHandlers.playerReady(bob, w.io);
        lobbyHandlers.playerReady(cat, w.io);

        const ann2 = await w.connect(names[0]);
        mainRoomHandlers.joinLobby(ann2, w.io, { lobbyId });

        // ~45 s later the server notices ann1 is gone
        jest.advanceTimersByTime(45000);
        const from = w.log.length;
        await w.kill(ann1);

        expect(seats(lobby)).toEqual(names);
        expect(lobby.players[0].socketId).toBe(ann2.id);
        expect(lobby.players.map((p) => p.ready)).toEqual([false, true, true, false]);
        expect(lobby.readyPlayers.size).toBe(2);
        expect(gameManager.playerLobbies.get(ann2.id)).toBe(lobbyId);
        expect(gameManager.getUserBySocketId(ann2.id)?.username).toBe(names[0]);
        const after = w.log.slice(from).map((l) => l.event);
        expect(after).not.toContain('lobbyPlayerLeft');
        // ann is still online on ann2: no main-room departure either
        expect(after).not.toContain('mainRoomPlayerLeft');
    });

    test('ready-up then starts the game with the new socket in the seat', async () => {
        const w = world();
        const names = [`ann${seq}`, `bob${seq}`, `cat${seq}`, `dan${seq}`];
        const { socks, lobbyId } = await lobbyOf(w, names);
        const [ann1, bob, cat, dan] = socks;
        lobbyHandlers.playerReady(ann1, w.io);

        const ann2 = await w.connect(names[0]);
        mainRoomHandlers.joinLobby(ann2, w.io, { lobbyId });
        await w.kill(ann1);

        const starting = [ann2, bob, cat, dan].map((s) => lobbyHandlers.playerReady(s, w.io));
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
        const game = gameManager.getPlayerGame(ann2.id);
        expect(game).toBeTruthy();
        expect(game.stage).toBe(Phase.CREATED);
        expect(gameManager.getPlayerGame(ann1.id)).toBeFalsy();
        expect(game.entrant(ann2.id)?.username).toBe(names[0]);
        expect(gameManager.lobbies.has(lobbyId)).toBe(false);
        expect(events(w.log, 'allPlayersReady').map((l) => l.to).sort()).toEqual([ann2.id, bob.id, cat.id, dan.id].sort());

        await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
        expect(game.stage).toBe(Phase.DRAWING);
        await Promise.all(starting);
    });

    test('joinQueue from the new socket takes the seat back, even in a full lobby', async () => {
        const w = world();
        const names = [`ann${seq}`, `bob${seq}`, `cat${seq}`, `dan${seq}`];
        const { socks, lobbyId, lobby } = await lobbyOf(w, names);

        const bob2 = await w.connect(names[1]);
        const from = w.log.length;
        await queueHandlers.joinQueue(bob2, w.io);

        expect(seats(lobby)).toEqual(names);
        expect(lobby.players[1].socketId).toBe(bob2.id);
        expect(gameManager.playerLobbies.get(bob2.id)).toBe(lobbyId);
        expect(gameManager.playerLobbies.has(socks[1].id)).toBe(false);
        expect(w.to(bob2.id, from).map((l) => l.event)).toContain('lobbyCreated');
        expect(w.to(socks[1].id, from).map((l) => l.event)).toEqual(['leftLobby']);
        expect(gameManager.lobbies.size).toBe(1);
    });

    test('creating or joining another lobby gives up the seat held from the old socket', async () => {
        const w = world();
        const names = [`ann${seq}`, `bob${seq}`, `cat${seq}`];
        const { socks, lobbyId, lobby } = await lobbyOf(w, names);
        const [ann1, bob, cat1] = socks;
        lobbyHandlers.playerReady(bob, w.io);

        // cat comes back on a new socket and creates a lobby of her own
        const cat2 = await w.connect(names[2]);
        let from = w.log.length;
        mainRoomHandlers.createLobby(cat2, w.io, { name: 'Elsewhere' });
        const other = gameManager.getPlayerLobby(cat2.id);
        expect(other.id).not.toBe(lobbyId);
        expect(seats(lobby)).toEqual(names.slice(0, 2));
        expect(gameManager.playerLobbies.has(cat1.id)).toBe(false);
        const bobGot = w.to(bob.id, from);
        expect(bobGot.find((l) => l.event === 'lobbyPlayerLeft').data.leftUsername).toBe(names[2]);
        expect(bobGot.find((l) => l.event === 'voicePeerLeft').data).toEqual({ socketId: cat1.id });
        expect(w.to(cat1.id, from).map((l) => l.event)).toEqual(['leftLobby']);

        // ann comes back and joins cat's lobby: her seat in the first one
        // goes, which empties it of humans but bob
        const ann2 = await w.connect(names[0]);
        from = w.log.length;
        mainRoomHandlers.joinLobby(ann2, w.io, { lobbyId: other.id });
        expect(seats(other)).toEqual([names[2], names[0]]);
        expect(seats(lobby)).toEqual([names[1]]);
        expect(w.to(ann1.id, from).map((l) => l.event)).toEqual(['leftLobby']);

        // The old sockets' disconnects touch neither lobby
        await w.kill(ann1);
        await w.kill(cat1);
        expect(seats(other)).toEqual([names[2], names[0]]);
        expect(seats(lobby)).toEqual([names[1]]);
    });

    test('lobby bots never match a username (their names are labels)', async () => {
        const w = world();
        const { socks, lobbyId, lobby } = await lobbyOf(w, [`ann${seq}`]);
        gameManager.addBotToLobby(lobbyId);
        gameManager.registerUser(`lr-fake-${seq}`, lobby.players[1].username);
        expect(gameManager.findStaleLobbySeat(lobby.players[1].username, `lr-fake-${seq}`)).toBeNull();
        expect(socks).toHaveLength(1);
    });
});

describe('tournament lobby re-entry (already deduplicated by username)', () => {
    test('joinTournament from a new socket reattaches the one entry; the old socket dropping changes nothing', async () => {
        const w = world();
        const ann1 = await w.connect(`ann${seq}`);
        const bob = await w.connect(`bob${seq}`);
        tournamentHandlers.createTournament(ann1, w.io);
        const tournamentId = gameManager.playerTournaments.get(ann1.id);
        await tournamentHandlers.joinTournament(bob, w.io, { tournamentId });
        await tournamentHandlers.tournamentReady(bob, w.io);

        const ann2 = await w.connect(`ann${seq}`);
        await tournamentHandlers.joinTournament(ann2, w.io, { tournamentId });
        const t = gameManager.getTournamentById(tournamentId);
        expect([...t.players.values()].map((p) => p.username).sort()).toEqual([`ann${seq}`, `bob${seq}`]);
        expect(t.players.has(ann2.id)).toBe(true);
        expect(t.players.has(ann1.id)).toBe(false);
        expect(gameManager.playerTournaments.has(ann1.id)).toBe(false);
        const bobReady = t.players.get(bob.id).ready;
        expect(bobReady).toBe(true);

        await w.kill(ann1);
        expect(t.players.size).toBe(2);
        expect(t.players.get(ann2.id).connected).toBe(true);
        expect(t.players.get(bob.id).ready).toBe(bobReady);
    });
});
