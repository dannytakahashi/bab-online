/**
 * One live connection per user (live check 2026-11-11: a second web tab
 * adopting the saved session left the first tab connected but unregistered,
 * every action answered "User not registered yet"). The older socket of
 * the SAME session is now superseded: told `sessionSuperseded`, parked
 * (every event but the auth ones refused with sessionSuperseded, never
 * `error`), out of the main room and spectating, its lobby seat held for
 * the newest socket; a game seat moves with the newest socket's rejoin as
 * before. Restoring again on the parked socket takes the session back.
 *
 * Stub io/sockets on the in-memory DB fake, plus one real Socket.IO server
 * for the packet gate (and a current iOS User-Agent, 1.2.0 build 6: no error,
 * no loop; 1.1.0's build 2 is upgrade-gated since MIN_IOS_BUILD 3).
 */

const http = require('http');
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
const lobbyHandlers = require('../lobbyHandlers');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const identity = require('../sessionIdentity');
const rateLimiter = require('../rateLimiter');
const { Phase } = require('../../game/GamePhase');
const { Presence } = require('../../game/SeatState');
const { hashToken } = require('../../utils/sessionTokens');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
// session tokens are UUIDs (validators.js restoreSession)
const secret = () => crypto.randomUUID();
let seq = 0;

function quiet() {
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
}

function resetManager() {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const sid of Array.from(gameManager.lobbyGrace.keys())) gameManager._clearLobbyGrace(sid);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.spectatorGames.clear();
    gameManager.currentUsers = [];
}

function addUser(username) {
    const token = secret();
    const now = new Date();
    mockDb.current.users._insert({
        username, profilePic: 5,
        sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }],
    });
    return token;
}

async function addToken(username) {
    const token = secret();
    await mockDb.current.users.updateOne({ username }, {
        $push: { sessionTokens: { hash: hashToken(token), createdAt: new Date(), lastUsedAt: new Date() } },
    });
    return token;
}

describe('a second tab of the same saved session (stub sockets)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockDb.current = createMemoryDb({ users: [] });
        quiet();
    });
    afterEach(() => {
        resetManager();
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    function world() {
        seq++;
        const log = [];
        const io = makeIo(log);
        const name = `ann${seq}`;
        const token = addUser(name);
        let n = 0;
        const w = {
            log, io, name, token,
            async tab(tok = token) {
                n++;
                const s = makeSocket(`ss${seq}-${n}`, log, io);
                s.disconnect = () => w.kill(s);
                await authHandlers.restoreSession(s, io, { username: name, sessionToken: tok });
                expect(events(log, 'restoreSessionResponse').filter((l) => l.to === `self:${s.id}`).pop().data.success).toBe(true);
                return s;
            },
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

    test('the first tab is told, parked and out of the main room; the second is the user now', async () => {
        const w = world();
        const tab1 = await w.tab();
        mainRoomHandlers.joinMainRoom(tab1, w.io);
        const from = w.log.length;
        const tab2 = await w.tab();
        mainRoomHandlers.joinMainRoom(tab2, w.io);

        expect(w.to(tab1.id, from).map((l) => [l.event, l.data])).toEqual([['sessionSuperseded', { reason: 'newerConnection' }]]);
        expect(tab1.data.superseded).toMatchObject({ by: tab2.id });
        expect(tab1.data.username).toBe(w.name); // still reachable by a sign-out
        expect(gameManager.getUserBySocketId(tab1.id)).toBeUndefined();
        expect(gameManager.getUserBySocketId(tab2.id)?.username).toBe(w.name);
        expect(gameManager.isInMainRoom(tab1.id)).toBe(false);
        expect(w.io.rooms.get('mainRoom').has(tab1.id)).toBe(false);
        expect(gameManager.mainRoomSocketIds.size).toBe(1);
        expect(w.to(tab1.id, from).map((l) => l.event)).not.toContain('error');
        expect(w.to(tab2.id, from).map((l) => l.event)).not.toContain('sessionSuperseded');
    });

    test('the parked tab takes it back by restoring again; the other tab is parked in turn', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        const from = w.log.length;
        await authHandlers.restoreSession(tab1, w.io, { username: w.name, sessionToken: w.token });
        expect(tab1.data.superseded).toBeUndefined();
        expect(gameManager.getUserBySocketId(tab1.id)?.username).toBe(w.name);
        expect(tab2.data.superseded).toMatchObject({ by: tab1.id });
        expect(w.to(tab2.id, from).map((l) => l.event)).toEqual(['sessionSuperseded']);
    });

    test('another device (a different saved session) still gets forceLogout, as before', async () => {
        const w = world();
        const phone = await w.tab();
        // users.socketId no longer names the phone (e.g. a rejoin elsewhere): the registered entry does
        await mockDb.current.users.updateOne({ username: w.name }, { $set: { socketId: 'elsewhere' } });
        const laptopToken = await addToken(w.name);
        const from = w.log.length;
        await w.tab(laptopToken);
        expect(w.to(phone.id, from).map((l) => l.event)).toEqual(['forceLogout']);
        expect(w.io.sockets.sockets.has(phone.id)).toBe(false);
    });

    test("the parked tab's lobby seat is held; the newest tab (or Use here) takes it in place", async () => {
        const w = world();
        const tab1 = await w.tab();
        mainRoomHandlers.joinMainRoom(tab1, w.io);
        mainRoomHandlers.createLobby(tab1, w.io, { name: 'Solo' });
        const lobby = gameManager.getPlayerLobby(tab1.id);
        for (let i = 0; i < 3; i++) lobbyHandlers.addBot(tab1, w.io);
        lobbyHandlers.playerReady(tab1, w.io);

        const tab2 = await w.tab();
        expect(gameManager.lobbies.get(lobby.id)).toBe(lobby);
        expect(gameManager.reconnectingIn(lobby.id)).toEqual([w.name]);
        expect(lobby.players[0].ready).toBe(false);
        expect(gameManager.playerLobbies.has(tab1.id)).toBe(false);

        // "Use here" on the first tab: a new socket restores and re-enters the lobby
        const tab1b = await w.tab();
        mainRoomHandlers.joinLobby(tab1b, w.io, { lobbyId: lobby.id });
        expect(lobby.players[0].socketId).toBe(tab1b.id);
        expect(lobby.players).toHaveLength(4);
        expect(gameManager.reconnectingIn(lobby.id)).toEqual([]);
        expect(tab2.data.superseded).toMatchObject({ by: tab1b.id });
        expect(w.log.filter((l) => l.event === 'error')).toEqual([]);
    });

    // A host of another account, in the main room, with a lobby of their own
    function hostLobby(w) {
        const host = makeSocket(`host${seq}`, w.log, w.io);
        gameManager.registerUser(host.id, `hank${seq}`);
        mainRoomHandlers.joinMainRoom(host, w.io);
        mainRoomHandlers.createLobby(host, w.io, { name: 'Hank' });
        return { host, lobby: gameManager.getPlayerLobby(host.id) };
    }
    const humanSeats = (lobby, name) => lobby.players.filter((p) => !p.isBot && p.username === name);

    test('the parked socket takes the session back on ITSELF: its held seat is its own again, in place, and outlives the grace', async () => {
        const w = world();
        const { host, lobby } = hostLobby(w);
        const tab1 = await w.tab();
        mainRoomHandlers.joinMainRoom(tab1, w.io);
        mainRoomHandlers.joinLobby(tab1, w.io, { lobbyId: lobby.id });
        const tab2 = await w.tab(); // parks tab1; its seat is held
        expect(gameManager.reconnectingIn(lobby.id)).toEqual([w.name]);

        const from = w.log.length;
        await authHandlers.restoreSession(tab1, w.io, { username: w.name, sessionToken: w.token });
        expect(tab2.data.superseded).toMatchObject({ by: tab1.id });
        expect(gameManager.playerLobbies.get(tab1.id)).toBe(lobby.id);
        expect(gameManager.lobbyGrace.has(tab1.id)).toBe(false);
        expect(gameManager.reconnectingIn(lobby.id)).toEqual([]);
        const toHost = w.to(host.id, from);
        expect(toHost.find((l) => l.event === 'playerReadyUpdate').data.reconnecting).toBeUndefined();
        expect(toHost.map((l) => l.event)).toContain('voicePeerJoined');

        // the join clients re-send after a restore: the lobby again, no second seat
        mainRoomHandlers.joinLobby(tab1, w.io, { lobbyId: lobby.id });
        expect(humanSeats(lobby, w.name).map((p) => p.socketId)).toEqual([tab1.id]);
        expect(w.to(tab1.id, from).map((l) => l.event)).toContain('lobbyCreated');

        jest.advanceTimersByTime(gameManager.constructor.LOBBY_SEAT_GRACE_MS + 1000);
        expect(gameManager.lobbies.get(lobby.id)).toBe(lobby);
        expect(humanSeats(lobby, w.name).map((p) => p.socketId)).toEqual([tab1.id]);
        expect(w.to(tab1.id, from).map((l) => l.event)).not.toContain('leftLobby');
        expect(w.log.filter((l) => l.event === 'error')).toEqual([]);
    });

    test('the parked socket signs in as ANOTHER account: the seat held for it goes at once, and nothing of that lobby reaches it after', async () => {
        const w = world();
        const { host, lobby } = hostLobby(w);
        const tab1 = await w.tab();
        mainRoomHandlers.joinMainRoom(tab1, w.io);
        mainRoomHandlers.joinLobby(tab1, w.io, { lobbyId: lobby.id });
        await w.tab(); // parks tab1; its seat is held

        const bob = `bob${seq}`;
        const bobToken = addUser(bob);
        const from = w.log.length;
        await authHandlers.restoreSession(tab1, w.io, { username: bob, sessionToken: bobToken });
        expect(gameManager.getUserBySocketId(tab1.id)?.username).toBe(bob);
        expect(lobby.players.some((p) => p.socketId === tab1.id)).toBe(false);
        expect(gameManager.lobbyGrace.has(tab1.id)).toBe(false);
        expect(w.to(host.id, from).find((l) => l.event === 'lobbyPlayerLeft')?.data.leftUsername).toBe(w.name);

        // later lobby traffic and the old grace never reach the socket that is bob now
        const after = w.log.length;
        lobbyHandlers.lobbyChat(host, w.io, { message: 'still here?' });
        jest.advanceTimersByTime(gameManager.constructor.LOBBY_SEAT_GRACE_MS + 1000);
        expect(w.to(tab1.id, after)).toEqual([]);
        expect(w.to(tab1.id, from).map((l) => l.event)).not.toContain('leftLobby');
    });

    test('a lazy seat rejoined from the newest tab: the parked tab is not put back to spectating', async () => {
        const w = world();
        const tab1 = await w.tab();
        const others = [2, 3, 4].map((p) => `lz${seq}-${p}`);
        others.forEach((sid, i) => gameManager.registerUser(sid, `lzo${seq}-${i}`));
        const game = gameManager.createGame([tab1.id, ...others]);
        game.addPlayer(tab1.id, w.name, 1, 1, false);
        others.forEach((sid, i) => game.addPlayer(sid, `lzo${seq}-${i}`, i + 2, i + 2, false));
        for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts')]);
        game.currentHand = 1;
        game.trump = C('A', 'spades');
        game.forcePhase(Phase.BIDDING);
        game.bidder = 1;
        game.currentTurn = 2;
        tab1.join(game.roomName);
        game.seatGoLazy(1, { socketId: `bot:lz${seq}`, username: 'Mike', personality: 'mike' });
        expect(game.seat(1).ownerSocketId).toBe(tab1.id);
        await mockDb.current.users.updateOne({ username: w.name }, { $set: { activeGameId: game.gameId } });

        const tab2 = await w.tab(); // parks tab1
        expect(tab1.data.superseded).toMatchObject({ by: tab2.id });
        await reconnectHandlers.rejoinGame(tab2, w.io, { gameId: game.gameId, username: w.name, sessionToken: w.token });
        expect(game.seat(1).ownerSocketId).toBe(tab2.id);
        expect(gameManager.spectatorGames.has(tab1.id)).toBe(false);
        expect(game.spectators.has(tab1.id)).toBe(false);
        expect(w.io.rooms.get(game.roomName).has(tab1.id)).toBe(false);
        expect(gameManager.playerGames.has(tab1.id)).toBe(false);
    });

    test('in a game: the seat follows the newest socket with no disconnect shown; the old tab never errors', async () => {
        const w = world();
        const tab1 = await w.tab();
        const others = [2, 3, 4].map((p) => `seat${seq}-${p}`);
        others.forEach((sid, i) => gameManager.registerUser(sid, `other${seq}-${i}`));
        const game = gameManager.createGame([tab1.id, ...others]);
        game.addPlayer(tab1.id, w.name, 1, 1, false);
        others.forEach((sid, i) => game.addPlayer(sid, `other${seq}-${i}`, i + 2, i + 2, false));
        for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts')]);
        game.currentHand = 1;
        game.trump = C('A', 'spades');
        game.forcePhase(Phase.BIDDING);
        game.bidder = 1;
        game.currentTurn = 1;
        tab1.join(game.roomName);
        await mockDb.current.users.updateOne({ username: w.name }, { $set: { activeGameId: game.gameId } });

        const from = w.log.length;
        const tab2 = await w.tab();
        expect(events(w.log, 'restoreSessionResponse').pop().data.activeGameId).toBe(game.gameId);
        // until tab2 rejoins, the seat stays on tab1 (connected; nothing broadcast)
        expect(game.seat(1).ownerSocketId).toBe(tab1.id);
        await reconnectHandlers.rejoinGame(tab2, w.io, { gameId: game.gameId, username: w.name, sessionToken: w.token });
        expect(game.seat(1).ownerSocketId).toBe(tab2.id);
        expect(game.seat(1).presence).toBe(Presence.CONNECTED);
        expect(gameManager.playerGames.has(tab1.id)).toBe(false);
        expect(w.io.rooms.get(game.roomName).has(tab1.id)).toBe(false);
        expect(events(w.log.slice(from), 'playerDisconnected')).toEqual([]);
        expect(w.to(tab1.id, from).map((l) => l.event)).toEqual(['sessionSuperseded']);
        // the parked tab's later disconnect (closed) changes nothing at the table
        await w.kill(tab1);
        expect(game.seat(1)).toMatchObject({ ownerSocketId: tab2.id, presence: Presence.CONNECTED });
        expect(w.log.filter((l) => l.event === 'error')).toEqual([]);
    });

    test('a pure spectator tab stops watching when parked', async () => {
        const w = world();
        const tab1 = await w.tab();
        const ids = [1, 2, 3, 4].map((p) => `sp${seq}-${p}`);
        ids.forEach((sid, i) => gameManager.registerUser(sid, `p${seq}-${i}`));
        const game = gameManager.createGame(ids);
        ids.forEach((sid, i) => game.addPlayer(sid, `p${seq}-${i}`, i + 1, i + 1, false));
        game.forcePhase(Phase.BIDDING);
        mainRoomHandlers.joinAsSpectator(tab1, w.io, { gameId: game.gameId });
        expect(gameManager.spectatorGames.get(tab1.id)).toBe(game.gameId);
        await w.tab();
        expect(gameManager.spectatorGames.has(tab1.id)).toBe(false);
        expect(game.spectators.has(tab1.id)).toBe(false);
    });

    test('a sign-out everywhere still reaches the parked tab', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        const from = w.log.length;
        expect(authHandlers.signOutUser(w.io, w.name)).toBe(2);
        for (const s of [tab1, tab2]) expect(w.to(s.id, from).map((l) => l.event)).toContain('forceLogout');
    });

    test('a revoke during the restore: the first tab is not parked (nothing was sent), it stays the user', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = makeSocket(`ss${seq}-late`, w.log, w.io);
        const users = mockDb.current.users;
        const realFindOne = users.findOne.bind(users);
        let reads = 0;
        jest.spyOn(users, 'findOne').mockImplementation(async (q, o) => {
            const doc = await realFindOne(q, o);
            // the re-check after registerUser: sign out everywhere landed meanwhile
            if (++reads === 2) return { ...doc, sessionEpoch: 99 };
            return doc;
        });
        const from = w.log.length;
        await authHandlers.restoreSession(tab2, w.io, { username: w.name, sessionToken: w.token });
        expect(events(w.log, 'restoreSessionResponse').pop().data.success).toBe(false);
        expect(tab1.data.superseded).toBeUndefined();
        expect(gameManager.getUserBySocketId(tab1.id)?.username).toBe(w.name);
        expect(w.to(tab1.id, from)).toEqual([]);
    });
});

describe('the packet gate (supersededGate)', () => {
    beforeEach(() => quiet());
    afterEach(() => jest.restoreAllMocks());

    test('a parked socket: every event but the auth ones is dropped and answered at most once a second', () => {
        jest.useFakeTimers();
        const log = [];
        const s = makeSocket('gate-1', log);
        s.data.superseded = { by: 'other', at: Date.now() };
        const gate = identity.supersededGate(s);
        const next = jest.fn();
        for (const ev of ['joinMainRoom', 'playCard', 'requestSnapshot', 'adminRequest']) gate([ev, {}], next);
        expect(next).not.toHaveBeenCalled();
        expect(log.map((l) => [l.event, l.data])).toEqual([['sessionSuperseded', { reason: 'newerConnection', refused: 'joinMainRoom' }]]);
        jest.advanceTimersByTime(1000);
        gate(['playCard', {}], next);
        expect(log).toHaveLength(2);
        for (const ev of identity.ALLOWED_WHILE_SUPERSEDED) gate([ev, {}], next);
        expect(next).toHaveBeenCalledTimes(identity.ALLOWED_WHILE_SUPERSEDED.size);
        jest.useRealTimers();
    });

    test('while the newer sign-in is being re-checked: dropped silently; a live socket passes', () => {
        const log = [];
        const s = makeSocket('gate-2', log);
        const next = jest.fn();
        identity.supersededGate(s)(['joinMainRoom'], next);
        expect(next).toHaveBeenCalledTimes(1);
        s.data.superseded = { by: 'other', pending: true };
        identity.supersededGate(s)(['joinMainRoom'], next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(log).toEqual([]);
    });
});

describe('over a real Socket.IO server (web tabs and the iOS User-Agent)', () => {
    const { Server } = require('socket.io');
    const ioClient = require('socket.io-client');
    const { setupSocketHandlers } = require('../index');
    // 1.2.0 build 6, the App Store build (an older build would meet the upgrade gate instead)
    const UA_IOS = 'BAB%20Online/6 CFNetwork/3896.200.61 Darwin/27.2.0';
    let httpServer;
    let io;
    let url;
    const clients = [];

    beforeAll(async () => {
        mockDb.current = createMemoryDb({ users: [] });
        httpServer = http.createServer();
        io = new Server(httpServer);
        setupSocketHandlers(io);
        await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
        url = `http://127.0.0.1:${httpServer.address().port}`;
    });
    beforeEach(() => quiet());
    afterEach(() => {
        while (clients.length) clients.pop().close();
        resetManager();
        jest.restoreAllMocks();
    });
    afterAll(async () => {
        io.close();
        await new Promise((r) => httpServer.close(r));
        rateLimiter.shutdown();
    });

    const connect = (ua) => {
        const c = ioClient(url, {
            transports: ['polling', 'websocket'], forceNew: true, reconnection: false,
            ...(ua ? { extraHeaders: { 'User-Agent': ua } } : {}),
        });
        c.seen = [];
        c.onAny((ev, data) => c.seen.push([ev, data]));
        clients.push(c);
        return c;
    };
    const once = (c, ev, ms = 3000) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
        c.once(ev, (d) => { clearTimeout(t); resolve(d); });
    });
    const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
    async function restored(c, username, token) {
        if (!c.connected) await once(c, 'connect');
        const reply = once(c, 'restoreSessionResponse');
        c.emit('restoreSession', { username, sessionToken: token });
        expect((await reply).success).toBe(true);
    }

    test.each([['a web tab', null], ['the iOS app', UA_IOS]])('%s superseded by a web tab: one notice, refusals instead of errors, no loop', async (_l, ua) => {
        const name = `real${++seq}`;
        const token = addUser(name);
        const first = connect(ua);
        await restored(first, name, token);
        first.emit('joinMainRoom');
        await once(first, 'mainRoomJoined');

        const second = connect(null);
        const notice = once(first, 'sessionSuperseded');
        await restored(second, name, token);
        expect(await notice).toEqual({ reason: 'newerConnection' });

        // what a dead tab (or an iOS build, which has no handler) keeps sending
        for (let i = 0; i < 5; i++) {
            first.emit('joinMainRoom');
            first.emit('requestSnapshot', { requestId: `ping-${i}` });
            first.emit('mainRoomChat', { message: 'hello' });
        }
        await settle(300);
        const names = first.seen.map(([ev]) => ev);
        expect(names).not.toContain('error');
        expect(names).not.toContain('stateSnapshot');
        expect(names.filter((e) => e === 'mainRoomJoined')).toHaveLength(1); // only the one before
        const refusals = first.seen.filter(([ev, d]) => ev === 'sessionSuperseded' && d.refused);
        expect(refusals.length).toBeGreaterThanOrEqual(1);
        expect(refusals.length).toBeLessThanOrEqual(2);
        expect(first.connected).toBe(true);
        // the server sends nothing on its own after that: no loop
        const count = first.seen.length;
        await settle(1200);
        expect(first.seen.length).toBe(count);
        expect(second.seen.map(([ev]) => ev)).not.toContain('sessionSuperseded');

        // Use here / a restore on the parked socket takes it back
        const backNotice = once(second, 'sessionSuperseded');
        await restored(first, name, token);
        expect(await backNotice).toEqual({ reason: 'newerConnection' });
        const joined = once(first, 'mainRoomJoined');
        first.emit('joinMainRoom');
        expect((await joined).onlineUsers).toContain(name);
    });
});
