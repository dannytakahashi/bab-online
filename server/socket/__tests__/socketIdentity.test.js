/**
 * Identity is per socket (live check, admin batch 2 verifier): a socket
 * that restored as A and then signed in as B must be cleanly B. Before,
 * GameManager.registerUser dropped entries by username only, so the socket
 * stayed A to the game manager (its new lobby was "A's Game") and an admin
 * sign-out of B reached A's game seat; the reverse (users.socketId of A
 * still naming the socket that is B now) signed B out with A.
 *
 * Real handlers on the in-memory DB fake (never the local Mongo), stub
 * io/sockets from gameDriver, fake timers.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
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
const reconnectHandlers = require('../reconnectHandlers');
const queueHandlers = require('../queueHandlers');
const { Phase } = require('../../game/GamePhase');
const { Presence } = require('../../game/SeatState');
const { hashToken } = require('../../utils/sessionTokens');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
const secret = () => crypto.randomBytes(12).toString('hex');
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
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.spectatorGames.clear();
    gameManager.currentUsers = [];
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** Accounts with a password and one saved device token each; sockets on one io. */
async function world(names) {
    seq++;
    const log = [];
    const io = makeIo(log);
    const creds = {};
    for (const base of names) {
        const username = `${base}${seq}`;
        const password = secret();
        const token = secret();
        const now = new Date();
        mockDb.current.users._insert({
            username, profilePic: 4, password: await bcrypt.hash(password, 4),
            sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }],
        });
        creds[base] = { username, password, token };
    }
    let n = 0;
    const w = {
        log, io, creds,
        socket() {
            n++;
            const s = makeSocket(`id${seq}-${n}`, log, io);
            s.disconnect = () => w.kill(s);
            return s;
        },
        async restore(s, who, token = creds[who].token) {
            await authHandlers.restoreSession(s, io, { username: creds[who].username, sessionToken: token });
            return events(log, 'restoreSessionResponse').filter((l) => l.to === `self:${s.id}`).pop().data;
        },
        async signIn(s, who) {
            await authHandlers.signIn(s, io, { username: creds[who].username, password: creds[who].password });
            return events(log, 'signInResponse').filter((l) => l.to === `self:${s.id}`).pop().data;
        },
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
        to(sid, from = 0) {
            return log.slice(from).filter((l) => l.to === sid || l.to === `self:${sid}`).map((l) => l.event);
        },
        name: (who) => creds[who].username,
    };
    return w;
}

const entriesOf = (sid) => gameManager.currentUsers.filter((u) => u.socketId === sid);

describe('GameManager.registerUser: one entry per username and per socket', () => {
    test('registering a socket as B drops its A entry; registering A elsewhere reports the socket it replaced', () => {
        expect(gameManager.registerUser('s1', 'A')).toBeNull();
        expect(gameManager.registerUser('s1', 'B')).toBeNull();
        expect(entriesOf('s1')).toEqual([{ username: 'B', socketId: 's1' }]);
        expect(gameManager.getOnlineUsernames()).toEqual(['B']);
        expect(gameManager.registerUser('s2', 'B')).toBe('s1');
        expect(gameManager.currentUsers).toEqual([{ username: 'B', socketId: 's2' }]);
        expect(gameManager.registerUser('s2', 'B')).toBeNull();
    });
});

describe('signing in as another account on the same socket', () => {
    test('restored as A, then signIn as B: the socket is cleanly B (registration, claim, session, main room, lobby)', async () => {
        const w = await world(['ann', 'bob']);
        const s = w.socket();
        expect((await w.restore(s, 'ann')).success).toBe(true);
        mainRoomHandlers.joinMainRoom(s, w.io);
        mainRoomHandlers.createLobby(s, w.io, {});
        const annLobby = gameManager.getPlayerLobby(s.id);
        expect(annLobby.name).toBe(`${w.name('ann')}'s Game`);
        const annHash = s.data.sessionHash;

        const from = w.log.length;
        expect((await w.signIn(s, 'bob')).success).toBe(true);

        expect(entriesOf(s.id)).toEqual([{ username: w.name('bob'), socketId: s.id }]);
        expect(gameManager.getOnlineUsernames()).not.toContain(w.name('ann'));
        expect(s.data.username).toBe(w.name('bob'));
        expect(s.data.sessionHash).toBeTruthy();
        expect(s.data.sessionHash).not.toBe(annHash);
        // A's lobby (A was its only human) is gone, the main room no longer has the socket
        expect(gameManager.lobbies.has(annLobby.id)).toBe(false);
        expect(gameManager.playerLobbies.has(s.id)).toBe(false);
        expect(gameManager.isInMainRoom(s.id)).toBe(false);
        expect(w.io.rooms.get('mainRoom')?.has(s.id)).toBeFalsy();
        // A went offline (its only socket); nothing was force-logged-out
        expect(events(w.log.slice(from), 'mainRoomPlayerLeft').map((l) => l.data.username)).toEqual([w.name('ann')]);
        expect(w.to(s.id, from)).not.toContain('forceLogout');

        // Its next lobby is B's
        mainRoomHandlers.joinMainRoom(s, w.io);
        mainRoomHandlers.createLobby(s, w.io, {});
        expect(gameManager.getPlayerLobby(s.id).name).toBe(`${w.name('bob')}'s Game`);
        expect(gameManager.getPlayerLobby(s.id).players.map((p) => p.username)).toEqual([w.name('bob')]);
    });

    test('restoreSession as B on a socket restored as A releases A the same way', async () => {
        const w = await world(['ann', 'bob']);
        const s = w.socket();
        await w.restore(s, 'ann');
        mainRoomHandlers.joinMainRoom(s, w.io);
        expect((await w.restore(s, 'bob')).success).toBe(true);
        expect(entriesOf(s.id)).toEqual([{ username: w.name('bob'), socketId: s.id }]);
        expect(gameManager.isInMainRoom(s.id)).toBe(false);
        expect(s.data.username).toBe(w.name('bob'));
    });

    test('signing in as the SAME account again releases nothing', async () => {
        const w = await world(['ann']);
        const s = w.socket();
        await w.restore(s, 'ann');
        mainRoomHandlers.joinMainRoom(s, w.io);
        mainRoomHandlers.createLobby(s, w.io, {});
        const lobbyId = gameManager.getPlayerLobby(s.id).id;
        await w.restore(s, 'ann');
        expect(gameManager.playerLobbies.get(s.id)).toBe(lobbyId);
    });

    test("A's game seat on that socket gets its reconnect grace; the socket leaves the game and its room", async () => {
        const w = await world(['ann', 'bob']);
        const s = w.socket();
        await w.restore(s, 'ann');
        const others = [2, 3, 4].map((p) => `seat${seq}-${p}`);
        others.forEach((sid, i) => gameManager.registerUser(sid, `other${seq}-${i}`));
        const game = gameManager.createGame([s.id, ...others]);
        game.addPlayer(s.id, w.name('ann'), 1, 1, false);
        others.forEach((sid, i) => game.addPlayer(sid, `other${seq}-${i}`, i + 2, i + 2, false));
        for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts')]);
        game.currentHand = 1;
        game.trump = C('A', 'spades');
        game.forcePhase(Phase.BIDDING);
        game.bidder = 2;
        game.currentTurn = 2;
        s.join(game.roomName);

        const from = w.log.length;
        await w.signIn(s, 'bob');

        expect(game.seat(1).presence).toBe(Presence.GRACE);
        expect(game.seat(1).ownerSocketId).toBeNull();
        expect(gameManager.playerGames.has(s.id)).toBe(false);
        expect(w.io.rooms.get(game.roomName).has(s.id)).toBe(false);
        expect(events(w.log.slice(from), 'playerDisconnected').map((l) => [l.data.position, l.data.username])).toEqual([[1, w.name('ann')]]);
    });
});

describe('sign-outs reach only the account a socket is now', () => {
    async function twoSockets() {
        const w = await world(['ann', 'bob']);
        // s: restored as ann on device 1, then signed in as bob
        const s = w.socket();
        await w.restore(s, 'ann');
        await w.signIn(s, 'bob');
        // ann on another device (her own token): her other connection
        const annTok = secret();
        await mockDb.current.users.updateOne({ username: w.name('ann') }, {
            $push: { sessionTokens: { hash: hashToken(annTok), createdAt: new Date(), lastUsedAt: new Date() } },
        });
        const a2 = w.socket();
        // users(ann).socketId still names s (now bob): the restore must not kick it
        expect((await mockDb.current.users.findOne({ username: w.name('ann') })).socketId).toBe(s.id);
        const fromRestore = w.log.length;
        expect((await w.restore(a2, 'ann', annTok)).success).toBe(true);
        expect(w.to(s.id, fromRestore)).not.toContain('forceLogout');
        mainRoomHandlers.joinMainRoom(a2, w.io);
        mainRoomHandlers.createLobby(a2, w.io, {});
        return { w, s, a2 };
    }

    test("signing out B everywhere never touches A's other connection", async () => {
        const { w, s, a2 } = await twoSockets();
        const from = w.log.length;
        expect(authHandlers.signOutUser(w.io, w.name('bob'))).toBe(1);
        expect(w.to(s.id, from)).toContain('forceLogout');
        expect(w.to(a2.id, from)).not.toContain('forceLogout');
        expect(gameManager.getUserBySocketId(a2.id)?.username).toBe(w.name('ann'));
        expect(gameManager.getPlayerLobby(a2.id)?.players.map((p) => p.username)).toEqual([w.name('ann')]);
    });

    test('signing out A everywhere never touches the socket that is B now, even when named as the revoked socketId', async () => {
        const { w, s, a2 } = await twoSockets();
        const from = w.log.length;
        // The revoke read users(ann).socketId before a2 restored: it names s
        expect(authHandlers.signOutUser(w.io, w.name('ann'), { socketId: s.id })).toBe(1);
        expect(w.to(a2.id, from)).toContain('forceLogout');
        expect(w.to(s.id, from)).not.toContain('forceLogout');
        expect(gameManager.getUserBySocketId(s.id)?.username).toBe(w.name('bob'));
        expect(w.io.sockets.sockets.has(s.id)).toBe(true);
    });

    test('a token rejoin as B on a socket that is A releases A first', async () => {
        const w = await world(['ann', 'bob']);
        const s = w.socket();
        await w.restore(s, 'ann');
        mainRoomHandlers.joinMainRoom(s, w.io);
        await reconnectHandlers.rejoinGame(s, w.io, { gameId: 'gone', username: w.name('bob'), sessionToken: w.creds.bob.token });
        expect(events(w.log, 'rejoinFailed').pop().data.reason).toBe('Game no longer exists');
        expect(gameManager.getUserBySocketId(s.id)).toBeUndefined();
        expect(s.data.username).toBe(w.name('bob'));
        expect(gameManager.isInMainRoom(s.id)).toBe(false);
    });
});
