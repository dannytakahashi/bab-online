/**
 * One membership per socket (GameManager.activityOf): a lobby seat, a game
 * (entrant or seat owner) or a live tournament. createLobby, joinLobby,
 * createTournament, joinTournament, rejoinGame and joinAsSpectator's owner
 * paths refuse a socket that already belongs elsewhere (a hand-written
 * client or a double click used to make one socket a member of two); a
 * refused joinTournament leaves the socket where it is. Across one user's
 * sockets a lobby seat and a tournament seat never coexist. Leaving a
 * tournament once its table is seated (late in DRAW_RESOLVING or in play)
 * leaves the table too. Real handlers, in-memory DB, stub io, fake timers.
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
const authHandlers = require('../authHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const queueHandlers = require('../queueHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const { Phase } = require('../../game/GamePhase');
const { hashToken } = require('../../utils/sessionTokens');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { setupTournament, liveTables, advanceUntil } = require('../../testUtils/tournamentDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    for (const sid of Array.from(gameManager.lobbyGrace.keys())) gameManager._clearLobbyGrace(sid);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.spectatorGames.clear();
    gameManager.playerTournaments.clear();
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
        log, io, tokens,
        async connect(name) {
            const username = `${name}${seq}`;
            if (!tokens.has(username)) {
                const token = crypto.randomUUID();
                tokens.set(username, token);
                const now = new Date();
                mockDb.current.users._insert({ username, profilePic: 3, sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }] });
            }
            n++;
            const s = makeSocket(`mx${seq}-${username}-${n}`, log, io);
            s.username = username;
            await authHandlers.restoreSession(s, io, { username, sessionToken: tokens.get(username) });
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
        errors(s, from) {
            return w.log.slice(from).filter((l) => l.to === `self:${s.id}` && l.event === 'serverError').map((l) => l.data.message);
        },
        sent(s, from, event) {
            return w.log.slice(from).filter((l) => l.to === `self:${s.id}` && l.event === event);
        },
        // io.to(socketId).emit: sent by another socket's handler
        told(s, from, event) {
            return w.log.slice(from).filter((l) => l.to === s.id && l.event === event);
        },
    };
    return w;
}

/** A seated casual game (PLAYING) of four world sockets. */
function seatedGame(sockets) {
    const game = gameManager.createGame(sockets.map((s) => s.id));
    sockets.forEach((s, i) => game.addPlayer(s.id, s.username, i + 1, i + 1, false));
    game.entrants = null;
    game.forcePhase('PLAYING');
    game.currentHand = 1;
    return game;
}

describe('from a lobby seat', () => {
    test('createTournament, joinTournament, createLobby and joinLobby are refused; the seat stays', async () => {
        const w = world();
        const ann = await w.connect('ann');
        const bob = await w.connect('bob');
        mainRoomHandlers.createLobby(ann, w.io, { name: 'Ann' });
        const lobbyId = gameManager.getPlayerLobby(ann.id).id;
        tournamentHandlers.createTournament(bob, w.io);
        const tid = gameManager.getPlayerTournament(bob.id).tournamentId;
        mainRoomHandlers.createLobby(await w.connect('cat'), w.io, { name: 'Cat' });
        const otherLobby = [...gameManager.lobbies.keys()].find((id) => id !== lobbyId);

        const from = w.log.length;
        tournamentHandlers.createTournament(ann, w.io);
        await tournamentHandlers.joinTournament(ann, w.io, { tournamentId: tid });
        mainRoomHandlers.createLobby(ann, w.io, { name: 'Again' });
        mainRoomHandlers.joinLobby(ann, w.io, { lobbyId: otherLobby });
        expect(w.errors(ann, from)).toEqual(['Already in a lobby', 'Already in a lobby', 'Already in lobby', 'Already in a lobby']);

        expect(gameManager.activityOf(ann.id)).toEqual({ kind: 'lobby', id: lobbyId });
        expect(gameManager.playerTournaments.has(ann.id)).toBe(false);
        expect(gameManager.getTournamentById(tid).players.size).toBe(1);
        // A refused joinTournament does not throw the socket into the main room
        expect(w.sent(ann, from, 'mainRoomJoined')).toHaveLength(0);
        expect(gameManager.isInMainRoom(ann.id)).toBe(false);
    });

    test('rejoinGame and joinAsSpectator to the seat an older socket left in grace are refused', async () => {
        const w = world();
        const ann1 = await w.connect('ann');
        const others = [await w.connect('bob'), await w.connect('cat'), await w.connect('dan')];
        const game = seatedGame([ann1, ...others]);
        await w.kill(ann1);
        expect(game.seat(1).presence).toBe('grace');

        const ann2 = await w.connect('ann');
        mainRoomHandlers.createLobby(ann2, w.io, { name: 'Ann' });
        const from = w.log.length;
        await reconnectHandlers.rejoinGame(ann2, w.io, { gameId: game.gameId, username: ann2.username, sessionToken: w.tokens.get(ann2.username) });
        expect(w.sent(ann2, from, 'rejoinFailed').map((l) => l.data.reason)).toEqual(['In a lobby']);
        mainRoomHandlers.joinAsSpectator(ann2, w.io, { gameId: game.gameId });
        expect(w.errors(ann2, from)).toEqual(['Already in a lobby']);
        expect(game.seat(1).presence).toBe('grace');
        expect(gameManager.playerGames.has(ann2.id)).toBe(false);

        // Out of the lobby, the same rejoin works
        lobbyHandlers.leaveLobby(ann2, w.io);
        await reconnectHandlers.rejoinGame(ann2, w.io, { gameId: game.gameId, username: ann2.username, sessionToken: w.tokens.get(ann2.username) });
        expect(game.seat(1)).toMatchObject({ presence: 'connected', ownerSocketId: ann2.id });
    });
});

describe('from a tournament', () => {
    test('createLobby and joinLobby are refused (lobby phase); a completed tournament does not count', async () => {
        const w = world();
        const ann = await w.connect('ann');
        const bob = await w.connect('bob');
        mainRoomHandlers.createLobby(bob, w.io, { name: 'Bob' });
        const lobbyId = gameManager.getPlayerLobby(bob.id).id;
        tournamentHandlers.createTournament(ann, w.io);
        const t = gameManager.getPlayerTournament(ann.id);

        const from = w.log.length;
        mainRoomHandlers.createLobby(ann, w.io, { name: 'Ann' });
        mainRoomHandlers.joinLobby(ann, w.io, { lobbyId });
        expect(w.errors(ann, from)).toEqual(['Already in a tournament', 'Already in a tournament']);
        expect(gameManager.getLobbyById(lobbyId).players).toHaveLength(1);
        expect(gameManager.activityOf(ann.id)).toEqual({ kind: 'tournament', id: t.tournamentId });

        // Its results window: no longer a membership
        t.phase = 'complete';
        expect(gameManager.activityOf(ann.id)).toBeNull();
        mainRoomHandlers.joinLobby(ann, w.io, { lobbyId });
        expect(gameManager.getPlayerLobby(ann.id).id).toBe(lobbyId);
    });

    test('rejoinGame into a casual seat is refused for a member of a live tournament', async () => {
        const w = world();
        const ann1 = await w.connect('ann');
        const others = [await w.connect('bob'), await w.connect('cat'), await w.connect('dan')];
        const game = seatedGame([ann1, ...others]);
        await w.kill(ann1);
        const ann2 = await w.connect('ann');
        tournamentHandlers.createTournament(ann2, w.io);
        const from = w.log.length;
        await reconnectHandlers.rejoinGame(ann2, w.io, { gameId: game.gameId, username: ann2.username, sessionToken: w.tokens.get(ann2.username) });
        expect(w.sent(ann2, from, 'rejoinFailed').map((l) => l.data.reason)).toEqual(['In a tournament']);
        expect(game.seat(1).presence).toBe('grace');
    });
});

describe('from a game', () => {
    test('createTournament and joinTournament are refused for a seat owner (as createLobby / joinLobby were)', async () => {
        const w = world();
        const ann = await w.connect('ann');
        const others = [await w.connect('bob'), await w.connect('cat'), await w.connect('dan')];
        const game = seatedGame([ann, ...others]);
        const eve = await w.connect('eve');
        tournamentHandlers.createTournament(eve, w.io);
        const tid = gameManager.getPlayerTournament(eve.id).tournamentId;
        mainRoomHandlers.createLobby(await w.connect('fay'), w.io, {});
        const lobbyId = [...gameManager.lobbies.keys()][0];

        const from = w.log.length;
        tournamentHandlers.createTournament(ann, w.io);
        await tournamentHandlers.joinTournament(ann, w.io, { tournamentId: tid });
        mainRoomHandlers.createLobby(ann, w.io, {});
        mainRoomHandlers.joinLobby(ann, w.io, { lobbyId });
        expect(w.errors(ann, from)).toEqual(['Already in game', 'Already in game', 'Already in game', 'Already in game']);
        expect(w.sent(ann, from, 'mainRoomJoined')).toHaveLength(0);
        expect(gameManager.activityOf(ann.id)).toEqual({ kind: 'game', id: game.gameId });
        expect(gameManager.getTournamentById(tid).players.size).toBe(1);
    });

    test('a tournament member at its own table reads as the tournament, and may rejoin it', async () => {
        const ctx = await setupTournament(4);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length === 1);
        const table = liveTables(ctx.t)[0];
        const s = ctx.sockets[1];
        expect(gameManager.activityOf(s.id)).toEqual({ kind: 'tournament', id: ctx.t.tournamentId, gameId: table.gameId });
        expect(gameManager.activityBesides(s.id, table.gameId)).toBeNull();
        await advanceUntil(() => table.stage === Phase.DRAWING);
        await ctx.starting;
    });
});

describe('leaving a tournament late in DRAW_RESOLVING', () => {
    test('the seat (already made) is left as with /leave: a bot plays it, no leftGame, the table goes on', async () => {
        const ctx = await setupTournament(4);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length === 1 && liveTables(ctx.t)[0].stage === Phase.DRAWING);
        await ctx.starting;
        const table = liveTables(ctx.t)[0];

        // Hold the table between seating and teamsAnnounced: its
        // setActiveGame batch waits on the DB
        const users = mockDb.current.users;
        const real = users.updateOne.bind(users);
        let open;
        const gate = new Promise((r) => { open = r; });
        users.updateOne = async (filter, update) => {
            if (update.$set && 'activeGameId' in update.$set) await gate;
            return real(filter, update);
        };
        await advanceUntil(() => table.stage === Phase.DRAW_RESOLVING && table.entrants === null, 100, 120000);

        const leaver = ctx.sockets[2];
        const name = ctx.usernames[2];
        const pos = table.seatByUsername(name);
        expect(table.seat(pos)).toMatchObject({ controller: 'human', ownerSocketId: leaver.id });
        const mark = ctx.log.length;
        await tournamentHandlers.leaveTournament(leaver, ctx.io);

        expect(table.seat(pos)).toMatchObject({ controller: 'lazyBot', presence: 'gone' });
        expect(gameManager.playerGames.has(leaver.id)).toBe(false);
        expect(gameManager.activityOf(leaver.id)).toBeNull();
        const toLeaver = ctx.log.slice(mark).filter((l) => l.to === `self:${leaver.id}`).map((l) => l.event);
        expect(toLeaver).toContain('tournamentLeft');
        expect(toLeaver).not.toContain('leftGame');

        open();
        users.updateOne = real;
        await advanceUntil(() => table.stage === Phase.BIDDING || table.stage === Phase.PLAYING, 100, 120000);
        expect(table.isTerminal()).toBe(false);
        expect(table.seat(pos).controller).toBe('lazyBot');
        expect(events(ctx.log.slice(mark), 'gameLogEntry').some((l) => l.data.message.startsWith(`${name} left the game.`))).toBe(true);
    }, 30000);
});

describe('one user, two sockets (an older socket still holds a membership)', () => {
    test('createTournament / joinTournament give up the lobby seat an older socket holds', async () => {
        const w = world();
        const ann1 = await w.connect('ann');
        const bob = await w.connect('bob');
        mainRoomHandlers.createLobby(bob, w.io, { name: 'Bob' });
        const lobbyId = gameManager.getPlayerLobby(bob.id).id;
        mainRoomHandlers.joinLobby(ann1, w.io, { lobbyId });
        expect(gameManager.getLobbyById(lobbyId).players).toHaveLength(2);

        // A new socket of Ann's (half-open reconnect) creates a tournament
        const ann2 = await w.connect('ann');
        const from = w.log.length;
        tournamentHandlers.createTournament(ann2, w.io);
        expect(w.errors(ann2, from)).toEqual([]);
        expect(gameManager.getPlayerTournament(ann2.id)).toBeTruthy();
        expect(gameManager.getLobbyById(lobbyId).players.map((p) => p.username)).toEqual([bob.username]);
        expect(gameManager.playerLobbies.has(ann1.id)).toBe(false);
        expect(w.told(ann1, from, 'leftLobby')).toHaveLength(1);
        expect(w.told(bob, from, 'lobbyPlayerLeft').map((l) => l.data.leftUsername)).toEqual([ann1.username]);

        // The same for joinTournament
        const cat1 = await w.connect('cat');
        mainRoomHandlers.joinLobby(cat1, w.io, { lobbyId });
        const cat2 = await w.connect('cat');
        const tid = gameManager.getPlayerTournament(ann2.id).tournamentId;
        const mark = w.log.length;
        await tournamentHandlers.joinTournament(cat2, w.io, { tournamentId: tid });
        expect(w.errors(cat2, mark)).toEqual([]);
        expect(gameManager.getTournamentById(tid).players.size).toBe(2);
        expect(gameManager.getLobbyById(lobbyId).players.map((p) => p.username)).toEqual([bob.username]);
        expect(w.told(cat1, mark, 'leftLobby')).toHaveLength(1);
    });

    test('createLobby / joinLobby: refused while an older socket is in a begun tournament; a lobby-phase one is given up', async () => {
        const w = world();
        const ann1 = await w.connect('ann');
        const bob = await w.connect('bob');
        mainRoomHandlers.createLobby(bob, w.io, { name: 'Bob' });
        const lobbyId = gameManager.getPlayerLobby(bob.id).id;
        const eve = await w.connect('eve');
        tournamentHandlers.createTournament(eve, w.io);
        const t = gameManager.getPlayerTournament(eve.id);
        await tournamentHandlers.joinTournament(ann1, w.io, { tournamentId: t.tournamentId });

        const ann2 = await w.connect('ann');
        t.phase = 'round_active';
        const from = w.log.length;
        mainRoomHandlers.createLobby(ann2, w.io, { name: 'Ann' });
        mainRoomHandlers.joinLobby(ann2, w.io, { lobbyId });
        expect(w.errors(ann2, from)).toEqual(['Already in a tournament', 'Already in a tournament']);
        expect(gameManager.getLobbyById(lobbyId).players).toHaveLength(1);
        expect(t.players.has(ann1.id)).toBe(true);

        // Still in its lobby: the older socket's membership is given up as a leave
        t.phase = 'lobby';
        const mark = w.log.length;
        mainRoomHandlers.joinLobby(ann2, w.io, { lobbyId });
        expect(w.errors(ann2, mark)).toEqual([]);
        expect(gameManager.getPlayerLobby(ann2.id).id).toBe(lobbyId);
        expect(t.players.has(ann1.id)).toBe(false);
        expect(gameManager.playerTournaments.has(ann1.id)).toBe(false);
        expect(w.told(ann1, mark, 'tournamentLeft')).toHaveLength(1);
        expect(w.log.slice(mark).some((l) => l.event === 'tournamentPlayerLeft' && l.data.username === ann1.username)).toBe(true);
    });
});

describe('leaving a tournament from its table in play', () => {
    test('the seat is left as with /leave: a bot plays it, no leftGame, the table goes on', async () => {
        const ctx = await setupTournament(4);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length === 1 && liveTables(ctx.t)[0].entrants === null, 100, 120000);
        await ctx.starting;
        const table = liveTables(ctx.t)[0];
        await advanceUntil(() => table.stage === Phase.BIDDING || table.stage === Phase.PLAYING, 100, 120000);

        const leaver = ctx.sockets[1];
        const name = ctx.usernames[1];
        const pos = table.seatByUsername(name);
        expect(table.seat(pos)).toMatchObject({ controller: 'human', ownerSocketId: leaver.id });
        const mark = ctx.log.length;
        await tournamentHandlers.leaveTournament(leaver, ctx.io);

        expect(table.seat(pos)).toMatchObject({ controller: 'lazyBot', presence: 'gone' });
        expect(gameManager.playerGames.has(leaver.id)).toBe(false);
        expect(gameManager.activityOf(leaver.id)).toBeNull();
        const toLeaver = ctx.log.slice(mark).filter((l) => l.to === `self:${leaver.id}`).map((l) => l.event);
        expect(toLeaver).toContain('tournamentLeft');
        expect(toLeaver).not.toContain('leftGame');
        expect(table.isTerminal()).toBe(false);
        expect(events(ctx.log.slice(mark), 'gameLogEntry').some((l) => l.data.message.startsWith(`${name} left the game.`))).toBe(true);
    }, 30000);
});
