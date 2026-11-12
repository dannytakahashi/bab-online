/**
 * A player is never listed twice during a half-open reconnect (item 15
 * notes: joinSpecificLobby listed a player twice for ~45 s). The server
 * keeps the old socket for up to pingInterval + pingTimeout while the same
 * device reconnects with the same saved session; every path that puts a
 * user somewhere must find the old socket's place by USERNAME:
 *
 *   lobby      joinLobby (same lobby: takeover; another: eviction),
 *              createLobby (#205), all with the reload grace
 *   tournament joinTournament of the same one (reattach by username),
 *              createTournament / joinTournament of ANOTHER one (fixed
 *              here: a lobby-phase membership is given up as a leave, a
 *              begun one refuses the new tournament)
 *   spectating GameState.spectatorList (one per username)
 *
 * Each case checks the user's place while the old socket is still alive and
 * again after it finally drops. Real handlers, in-memory DB, stub io.
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
const { Phase } = require('../../game/GamePhase');
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
        log, io,
        async connect(username) {
            if (!tokens.has(username)) {
                const token = crypto.randomUUID();
                tokens.set(username, token);
                const now = new Date();
                mockDb.current.users._insert({ username, profilePic: 3, sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }] });
            }
            n++;
            const s = makeSocket(`de${seq}-${username}-${n}`, log, io);
            s.disconnect = () => w.kill(s);
            await authHandlers.restoreSession(s, io, { username, sessionToken: tokens.get(username) });
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
    };
    return w;
}

/** How many times `username` appears across every lobby the main room lists. */
const inLobbies = (username) => gameManager.getAllLobbies()
    .reduce((n, l) => n + l.players.filter((p) => p.username === username).length, 0);
/** ...and across every tournament roster. */
const inTournaments = (username) => [...gameManager.tournaments.values()]
    .reduce((n, t) => n + t.getClientState().players.filter((p) => p.username === username).length, 0);

describe('lobbies: every join path finds the old seat by username', () => {
    test.each([
        ['joinLobby (the same lobby)', (w, s, lobbyId) => mainRoomHandlers.joinLobby(s, w.io, { lobbyId })],
        ['createLobby', (w, s) => mainRoomHandlers.createLobby(s, w.io, {})],
        ['joinLobby (another lobby)', (w, s, _id, other) => mainRoomHandlers.joinLobby(s, w.io, { lobbyId: other })],
    ])('%s: listed once with the old socket alive, and after it drops', async (_label, join) => {
        const w = world();
        const ann = `ann${seq}`;
        const ann1 = await w.connect(ann);
        mainRoomHandlers.createLobby(ann1, w.io, { name: 'First' });
        const lobbyId = gameManager.getPlayerLobby(ann1.id).id;
        const bob = await w.connect(`bob${seq}`);
        mainRoomHandlers.createLobby(bob, w.io, { name: 'Other' });
        const other = gameManager.getPlayerLobby(bob.id).id;

        const ann2 = await w.connect(ann); // half-open: ann1 still in io.sockets
        expect(inLobbies(ann)).toBe(1);
        await join(w, ann2, lobbyId, other);
        expect(inLobbies(ann)).toBe(1);
        expect(gameManager.getPlayerLobby(ann2.id)).toBeTruthy();
        expect(events(w.log, 'error').filter((l) => l.to === `self:${ann2.id}`)).toEqual([]);

        await w.kill(ann1);
        jest.advanceTimersByTime(gameManager.constructor.LOBBY_SEAT_GRACE_MS);
        expect(inLobbies(ann)).toBe(1);
        expect(gameManager.getPlayerLobby(ann2.id)).toBeTruthy();
    });
});

describe('tournaments', () => {
    async function tournamentOf(w, creator, members = []) {
        tournamentHandlers.createTournament(creator, w.io);
        const tournamentId = gameManager.playerTournaments.get(creator.id);
        for (const m of members) await tournamentHandlers.joinTournament(m, w.io, { tournamentId });
        return gameManager.getTournamentById(tournamentId);
    }

    test('joinTournament of the same tournament reattaches the one entry (already by username)', async () => {
        const w = world();
        const ann = `ann${seq}`;
        const ann1 = await w.connect(ann);
        const t = await tournamentOf(w, ann1, [await w.connect(`bob${seq}`)]);
        const ann2 = await w.connect(ann);
        await tournamentHandlers.joinTournament(ann2, w.io, { tournamentId: t.tournamentId });
        expect(inTournaments(ann)).toBe(1);
        await w.kill(ann1);
        expect(inTournaments(ann)).toBe(1);
    });

    test('createTournament from the new socket gives up the old lobby-phase membership (was: listed in two)', async () => {
        const w = world();
        const ann = `ann${seq}`;
        const ann1 = await w.connect(ann);
        const bob = await w.connect(`bob${seq}`);
        const first = await tournamentOf(w, ann1, [bob]);
        const ann2 = await w.connect(ann);
        const from = w.log.length;
        tournamentHandlers.createTournament(ann2, w.io);
        expect(inTournaments(ann)).toBe(1);
        expect(gameManager.getPlayerTournament(ann2.id)).not.toBe(first);
        expect(first.getClientState().players.map((p) => p.username)).toEqual([`bob${seq}`]);
        const left = events(w.log.slice(from), 'tournamentPlayerLeft').find((l) => l.to === first.roomName);
        expect(left.data.username).toBe(ann);
        expect(left.data.newCreator).toBe(`bob${seq}`);
        expect(events(w.log.slice(from), 'tournamentLeft').map((l) => l.to)).toEqual([ann1.id]);
        await w.kill(ann1);
        expect(inTournaments(ann)).toBe(1);
    });

    test('joinTournament of ANOTHER tournament: the same; a lone old membership takes its tournament with it', async () => {
        const w = world();
        const ann = `ann${seq}`;
        const ann1 = await w.connect(ann);
        const lonely = await tournamentOf(w, ann1);
        const cat = await w.connect(`cat${seq}`);
        const target = await tournamentOf(w, cat);
        const ann2 = await w.connect(ann);
        await tournamentHandlers.joinTournament(ann2, w.io, { tournamentId: target.tournamentId });
        expect(inTournaments(ann)).toBe(1);
        expect(gameManager.getTournamentById(lonely.tournamentId)).toBeFalsy();
        expect(target.players.has(ann2.id)).toBe(true);
    });

    test('a tournament that has begun keeps its member: another one is refused', async () => {
        const w = world();
        const ann = `ann${seq}`;
        const ann1 = await w.connect(ann);
        const t = await tournamentOf(w, ann1);
        t.phase = 'round';
        const ann2 = await w.connect(ann);
        const from = w.log.length;
        tournamentHandlers.createTournament(ann2, w.io);
        expect(events(w.log.slice(from), 'error').map((l) => l.data.message)).toEqual(['Already in a tournament']);
        expect(inTournaments(ann)).toBe(1);
        t.phase = 'lobby';
    });
});

describe('spectating', () => {
    test('two sockets of one user watching a game are one name in the list', async () => {
        const w = world();
        const ids = [1, 2, 3, 4].map((p) => `de-p${seq}-${p}`);
        ids.forEach((sid, i) => gameManager.registerUser(sid, `p${seq}-${i}`));
        const game = gameManager.createGame(ids);
        ids.forEach((sid, i) => game.addPlayer(sid, `p${seq}-${i}`, i + 1, i + 1, false));
        game.forcePhase(Phase.BIDDING);
        const fan = `fan${seq}`;
        const fan1 = await w.connect(fan);
        mainRoomHandlers.joinAsSpectator(fan1, w.io, { gameId: game.gameId });
        // a raw second socket of the same user (no restore: not parked)
        const fan2 = makeSocket(`de-fan2-${seq}`, w.log, w.io);
        gameManager.addSpectator(w.io, game, fan2.id, fan, null);
        expect(game.spectatorList().map((s) => s.username)).toEqual([fan]);
        // a restore on the new socket parks the old one, which stops watching
        const fan3 = await w.connect(fan);
        mainRoomHandlers.joinAsSpectator(fan3, w.io, { gameId: game.gameId });
        expect(game.spectatorList().map((s) => s.username)).toEqual([fan]);
        expect(game.spectators.has(fan1.id)).toBe(false);
    });
});
