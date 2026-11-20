/**
 * The main room's online list hears every name that comes online or goes
 * offline (server/socket/onlinePresence.js). Seen in production
 * 2026-11-20: a player whose socket dropped mid-game reconnected straight
 * into the game (restoreSession with activeGameId, then rejoinGame; no
 * joinMainRoom), and the main room's list never showed them again until
 * some other main-room join refreshed it.
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
        /** Signed in (restored) and in the main room, as a lobby browser is. */
        async inMainRoom(who) {
            const s = w.socket();
            expect((await w.restore(s, who)).success).toBe(true);
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
        name: (who) => creds[who].username,
        /** The main-room broadcasts of `event` since `from`. */
        toMainRoom(event, from) {
            return events(log.slice(from), event).filter((l) => l.to === 'mainRoom');
        },
    };
    return w;
}

/** A game in bidding with `s` (signed in as `who`) at seat 1 and three other humans. */
async function seatIn(w, s, who) {
    const others = [2, 3, 4].map((p) => `seat${seq}-${p}`);
    others.forEach((sid, i) => gameManager.registerUser(sid, `other${seq}-${i}`));
    const game = gameManager.createGame([s.id, ...others]);
    game.addPlayer(s.id, w.name(who), 1, 1, false);
    others.forEach((sid, i) => game.addPlayer(sid, `other${seq}-${i}`, i + 2, i + 2, false));
    for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts')]);
    game.currentHand = 1;
    game.trump = C('A', 'spades');
    game.forcePhase(Phase.BIDDING);
    game.bidder = 2;
    game.currentTurn = 2;
    s.join(game.roomName);
    await mockDb.current.users.updateOne({ username: w.name(who) }, { $set: { activeGameId: game.gameId } });
    return game;
}

/** ann in a game (her socket dropped mid-game) while bob browses the main room. */
async function droppedMidGame() {
    const w = await world(['ann', 'bob']);
    const bob = await w.inMainRoom('bob');
    const a1 = w.socket();
    await w.restore(a1, 'ann');
    const game = await seatIn(w, a1, 'ann');
    const fromDrop = w.log.length;
    await w.kill(a1);
    expect(game.seat(1).presence).toBe(Presence.GRACE);
    expect(gameManager.getOnlineUsernames()).not.toContain(w.name('ann'));
    expect(w.toMainRoom('mainRoomPlayerLeft', fromDrop).map((l) => l.data.username)).toEqual([w.name('ann')]);
    return { w, bob, game };
}

describe('a player back straight into a game reappears in the main room list', () => {
    test('restoreSession with an active game: mainRoomPlayerJoined to the main room with the fresh list; the rejoin adds none', async () => {
        const { w, bob, game } = await droppedMidGame();
        const a2 = w.socket();
        const from = w.log.length;
        const reply = await w.restore(a2, 'ann');
        expect(reply).toMatchObject({ success: true, activeGameId: game.gameId });

        const joined = w.toMainRoom('mainRoomPlayerJoined', from);
        expect(joined).toHaveLength(1);
        expect(joined[0].except).toBeUndefined(); // io.to: every main-room member
        expect(joined[0].data).toEqual({
            username: w.name('ann'),
            onlineCount: gameManager.getOnlineUsernames().length,
            onlineUsers: gameManager.getOnlineUsernames(),
        });
        expect(joined[0].data.onlineUsers).toEqual(expect.arrayContaining([w.name('ann'), w.name('bob')]));
        expect(w.io.rooms.get('mainRoom').has(bob.id)).toBe(true);

        // The client goes on into the game: already online, nothing more
        const fromRejoin = w.log.length;
        await reconnectHandlers.rejoinGame(a2, w.io, { gameId: game.gameId, username: w.name('ann'), sessionToken: w.creds.ann.token });
        expect(events(w.log.slice(fromRejoin), 'rejoinSuccess')).toHaveLength(1);
        expect(game.seat(1).ownerSocketId).toBe(a2.id);
        expect(w.toMainRoom('mainRoomPlayerJoined', fromRejoin)).toEqual([]);
    });

    test('signIn with an active game announces the same way', async () => {
        const { w, game } = await droppedMidGame();
        const a2 = w.socket();
        const from = w.log.length;
        expect(await w.signIn(a2, 'ann')).toMatchObject({ success: true, activeGameId: game.gameId });
        expect(w.toMainRoom('mainRoomPlayerJoined', from).map((l) => l.data.username)).toEqual([w.name('ann')]);
        expect(w.toMainRoom('mainRoomPlayerJoined', from)[0].data.onlineUsers).toContain(w.name('ann'));
    });

    test('a token rejoin with no restoreSession first (seatLifecycle registers the seat owner) announces it', async () => {
        const { w, game } = await droppedMidGame();
        const a2 = w.socket();
        const from = w.log.length;
        await reconnectHandlers.rejoinGame(a2, w.io, { gameId: game.gameId, username: w.name('ann'), sessionToken: w.creds.ann.token });
        expect(events(w.log.slice(from), 'rejoinSuccess')).toHaveLength(1);
        const joined = w.toMainRoom('mainRoomPlayerJoined', from);
        expect(joined.map((l) => l.data.username)).toEqual([w.name('ann')]);
        expect(joined[0].data.onlineUsers).toContain(w.name('ann'));
        expect(joined[0].data.onlineCount).toBe(joined[0].data.onlineUsers.length);
    });

    test('a refused restore announces nothing', async () => {
        const { w } = await droppedMidGame();
        const a2 = w.socket();
        const from = w.log.length;
        expect((await w.restore(a2, 'ann', secret())).success).toBe(false);
        expect(w.toMainRoom('mainRoomPlayerJoined', from)).toEqual([]);
        expect(gameManager.getOnlineUsernames()).not.toContain(w.name('ann'));
    });
});

describe('a new account', () => {
    test('signUp (auto-signed-in) refreshes the main room list', async () => {
        const w = await world(['bob']);
        await w.inMainRoom('bob');
        const s = w.socket();
        const name = `newbie${seq}`;
        const from = w.log.length;
        await authHandlers.signUp(s, w.io, { username: name, password: secret() });
        expect(events(w.log.slice(from), 'signUpResponse').pop().data).toMatchObject({ success: true, username: name });
        const joined = w.toMainRoom('mainRoomPlayerJoined', from);
        expect(joined.map((l) => l.data.username)).toEqual([name]);
        expect(joined[0].data.onlineUsers).toEqual(expect.arrayContaining([name, w.name('bob')]));
    });
});

describe('a name already online is not announced again', () => {
    test('a second socket of the same saved session (another tab) sends no refresh', async () => {
        const w = await world(['ann', 'bob']);
        await w.inMainRoom('bob');
        const a1 = w.socket();
        await w.restore(a1, 'ann');

        const from = w.log.length;
        const a2 = w.socket();
        expect((await w.restore(a2, 'ann')).success).toBe(true);
        expect(gameManager.getUserBySocketId(a2.id)?.username).toBe(w.name('ann'));
        expect(w.toMainRoom('mainRoomPlayerJoined', from)).toEqual([]);
        expect(w.toMainRoom('mainRoomPlayerLeft', from)).toEqual([]);
        expect(gameManager.getOnlineUsernames().filter((u) => u === w.name('ann'))).toHaveLength(1);
    });

    test('a password sign-in on another device signs the old one out first: left, then joined, ending online once', async () => {
        const w = await world(['ann', 'bob']);
        await w.inMainRoom('bob');
        const a1 = w.socket();
        await w.restore(a1, 'ann');

        const from = w.log.length;
        const a2 = w.socket();
        expect((await w.signIn(a2, 'ann')).success).toBe(true);
        expect(events(w.log.slice(from), 'forceLogout').map((l) => l.to)).toEqual([`self:${a1.id}`]);
        const presence = w.log.slice(from)
            .filter((l) => l.to === 'mainRoom' && /^mainRoomPlayer(Joined|Left)$/.test(l.event))
            .map((l) => [l.event, l.data.username, l.data.onlineUsers.includes(w.name('ann'))]);
        expect(presence).toEqual([
            ['mainRoomPlayerLeft', w.name('ann'), false],
            ['mainRoomPlayerJoined', w.name('ann'), true],
        ]);
        expect(gameManager.getOnlineUsernames().filter((u) => u === w.name('ann'))).toHaveLength(1);
    });

    test('restoring again on the same socket sends nothing', async () => {
        const w = await world(['ann', 'bob']);
        await w.inMainRoom('bob');
        const a1 = w.socket();
        await w.restore(a1, 'ann');
        const from = w.log.length;
        await w.restore(a1, 'ann');
        expect(w.toMainRoom('mainRoomPlayerJoined', from)).toEqual([]);
    });
});

describe('main-room joins are unchanged', () => {
    test('joinMainRoom still sends mainRoomJoined to the joiner and mainRoomPlayerJoined to everyone else, after the sign-in refresh', async () => {
        const w = await world(['ann', 'bob']);
        const bob = await w.inMainRoom('bob');
        const a = w.socket();
        const from = w.log.length;
        await w.restore(a, 'ann');
        const fromJoin = w.log.length;
        mainRoomHandlers.joinMainRoom(a, w.io);

        const signInRefresh = w.toMainRoom('mainRoomPlayerJoined', from).filter((l) => w.log.indexOf(l) < fromJoin);
        expect(signInRefresh).toHaveLength(1);
        const joinEvents = events(w.log.slice(fromJoin), 'mainRoomPlayerJoined');
        expect(joinEvents).toHaveLength(1);
        expect(joinEvents[0]).toMatchObject({ to: 'mainRoom', except: a.id });
        expect(joinEvents[0].data).toEqual(signInRefresh[0].data); // the same list twice: harmless
        const own = events(w.log.slice(fromJoin), 'mainRoomJoined');
        expect(own.map((l) => l.to)).toEqual([`self:${a.id}`]);
        expect(own[0].data.onlineUsers).toEqual(expect.arrayContaining([w.name('ann'), w.name('bob')]));
        expect(w.io.rooms.get('mainRoom').has(bob.id)).toBe(true);
    });

    test('a joinMainRoom from a socket already signed in (back from a game) sends one refresh, as before', async () => {
        const w = await world(['ann', 'bob']);
        await w.inMainRoom('bob');
        const a = w.socket();
        await w.restore(a, 'ann');
        const from = w.log.length;
        mainRoomHandlers.joinMainRoom(a, w.io);
        mainRoomHandlers.joinMainRoom(a, w.io);
        expect(events(w.log.slice(from), 'mainRoomPlayerJoined').map((l) => [l.to, l.except])).toEqual([
            ['mainRoom', a.id], ['mainRoom', a.id],
        ]);
    });
});

describe('sign-outs leave the list', () => {
    test('signed out everywhere from the main room: one mainRoomPlayerLeft with the fresh list', async () => {
        const w = await world(['ann', 'bob']);
        await w.inMainRoom('bob');
        const a = await w.inMainRoom('ann');
        const from = w.log.length;
        expect(authHandlers.signOutUser(w.io, w.name('ann'))).toBe(1);
        expect(events(w.log.slice(from), 'forceLogout').map((l) => l.to)).toEqual([`self:${a.id}`]);
        const left = w.toMainRoom('mainRoomPlayerLeft', from);
        expect(left).toHaveLength(1);
        expect(left[0].data.username).toBe(w.name('ann'));
        expect(left[0].data.onlineUsers).not.toContain(w.name('ann'));
        expect(left[0].data.onlineUsers).toContain(w.name('bob'));
        expect(left[0].data.onlineCount).toBe(left[0].data.onlineUsers.length);
    });

    test('signed out everywhere from a game seat: one mainRoomPlayerLeft (the disconnect announces it)', async () => {
        const w = await world(['ann', 'bob']);
        await w.inMainRoom('bob');
        const a = w.socket();
        await w.restore(a, 'ann');
        await seatIn(w, a, 'ann');
        const from = w.log.length;
        expect(authHandlers.signOutUser(w.io, w.name('ann'))).toBe(1);
        await Promise.resolve();
        const left = w.toMainRoom('mainRoomPlayerLeft', from);
        expect(left.map((l) => l.data.username)).toEqual([w.name('ann')]);
        expect(left[0].data.onlineUsers).not.toContain(w.name('ann'));
    });
});
