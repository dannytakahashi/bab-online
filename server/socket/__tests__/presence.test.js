/**
 * Seat presence regressions (seat records, roadmap item 6): per-seat grace,
 * resign offers, abandon/abort, watchers vs spectators, lazy bots, draw
 * watchdog. Real handlers, stub io/sockets from gameDriver, fake timers.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const Deck = require('../../game/Deck');
const gameManager = require('../../game/GameManager');
const chatHandlers = require('../chatHandlers');
const gameHandlers = require('../gameHandlers');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const profileHandlers = require('../profileHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const gameLifecycle = require('../gameLifecycle');
const { botController, personalities } = require('../../game/bot');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events, legalCards, resignedSeat } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;
let realRandom;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    realRandom = Math.random;
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

/**
 * Seated game in BIDDING (one card each, seat 3 on turn). `bots` maps a
 * position to a personality: that seat is a native bot.
 */
function table({ bots = {} } = {}) {
    seq++;
    const log = [];
    const io = makeIo(log);
    const sids = {};
    const sockets = {};
    const botBy = {};
    for (let pos = 1; pos <= 4; pos++) {
        if (bots[pos]) {
            const name = `🤖 ${bots[pos][0].toUpperCase()}${bots[pos].slice(1)}`;
            botBy[pos] = botController.createBot(name, bots[pos]);
            sids[pos] = botBy[pos].socketId;
        } else {
            sids[pos] = `pr${seq}-p${pos}`;
            gameManager.registerUser(sids[pos], `user${pos}`);
            mockDb.current.users._insert({ username: `user${pos}`, profilePic: pos });
        }
    }
    const game = gameManager.createGame([1, 2, 3, 4].map((p) => sids[p]));
    for (let pos = 1; pos <= 4; pos++) {
        if (botBy[pos]) {
            botBy[pos].position = pos;
            botController.registerBot(game.gameId, botBy[pos]);
            game.addPlayer(sids[pos], botBy[pos].username, pos, 1, true);
        } else {
            game.addPlayer(sids[pos], `user${pos}`, pos, 1, false);
            sockets[pos] = makeSocket(sids[pos], log, io);
            sockets[pos].join(game.roomName);
        }
    }
    for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts')]);
    game.currentHand = 1;
    game.trump = C('A', 'spades');
    game.forcePhase(Phase.BIDDING);
    game.bidder = 3;
    game.currentTurn = 3;
    return { log, io, game, sids, sockets };
}

const chat = (t, pos, message, socket = t.sockets[pos]) => chatHandlers.chatMessage(socket, t.io, { message });
const seatNames = (game) => [1, 2, 3, 4].map((p) => game.getPlayerByPosition(p).username);

/** A socket drops (gone from io first, as in production). */
async function drop(t, socket) {
    t.io.sockets.sockets.delete(socket.id);
    for (const members of t.io.rooms.values()) members.delete(socket.id);
    await queueHandlers.handleDisconnect(socket, t.io);
}

let fresh = 0;
/** A new socket signed in as `username` sends rejoinGame. */
async function rejoin(t, username) {
    fresh++;
    const s = makeSocket(`pr-r${fresh}`, t.log, t.io);
    gameManager.registerUser(s.id, username);
    await reconnectHandlers.rejoinGame(s, t.io, { gameId: t.game.gameId, username });
    return s;
}

/** A new socket signed in as `username`, not in any game. */
function newSocket(t, username) {
    fresh++;
    const s = makeSocket(`pr-s${fresh}`, t.log, t.io);
    gameManager.registerUser(s.id, username);
    return s;
}

const roomOffers = (t) => events(t.log, 'resignationAvailable').filter((l) => l.to === t.game.roomName).map((l) => l.data.position);
const selfEvents = (t, s, from = 0) => t.log.slice(from).filter((l) => l.to === `self:${s.id}`)
    .map((l) => `${l.event}${l.data && typeof l.data === 'object' && 'position' in l.data ? `@${l.data.position}` : ''}`);
const aborts = (t) => events(t.log, 'abortGame');
const inRoom = (t, sid) => !!t.io.rooms.get(t.game.roomName)?.has(sid);

/** PLAYING, seat 1 leads the (only) trick of a 1-card hand. */
function toPlaying(game) {
    game.forcePhase(Phase.PLAYING);
    game.bids = { team1: 1, team2: 0 };
    game.playerBids = ['1', '0', '0', '0'];
    game.currentTurn = 1;
    game.leadPosition = 1;
}

describe('R10 lazy bot names never duplicate a seated bot', () => {
    test('with mary, sharon and danny seated, /lazy picks mike or zach', () => {
        Math.random = () => 0; // the old code picked PERSONALITY_LIST[0] (mary)
        const t = table({ bots: { 2: 'mary', 3: 'sharon', 4: 'danny' } });
        chat(t, 1, '/lazy');
        const lazy = events(t.log, 'playerLazyMode')[0].data;
        expect(['🤖 Mike', '🤖 Zach']).toContain(lazy.botUsername);
        expect(new Set(seatNames(t.game)).size).toBe(4);
    });

    test('the last personality is reused only while it is free', () => {
        Math.random = () => 0;
        const t = table({ bots: { 3: 'mary', 4: 'sharon' } });
        chat(t, 1, '/lazy');
        const first = events(t.log, 'playerLazyMode')[0].data.botUsername;
        chat(t, 1, '/active');
        chat(t, 1, '/lazy');
        expect(events(t.log, 'playerLazyMode')[1].data.botUsername).toBe(first);
        chat(t, 1, '/active');
        chat(t, 2, '/lazy'); // takes the same (first free) personality
        expect(events(t.log, 'playerLazyMode')[2].data.botUsername).toBe(first);
        chat(t, 1, '/lazy'); // its last personality is taken now
        const again = events(t.log, 'playerLazyMode')[3].data.botUsername;
        expect(again).not.toBe(first);
        expect(new Set(seatNames(t.game)).size).toBe(4);
    });
});

describe('R1/R2 per-seat reconnect grace (srv-13, sp-16)', () => {
    test('two drops 30s apart are each offered at their own 60s', async () => {
        const t = table();
        await drop(t, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(30000);
        await drop(t, t.sockets[2]);
        expect(t.game.hasTimer('grace:1')).toBe(true);
        expect(t.game.hasTimer('grace:2')).toBe(true);
        await jest.advanceTimersByTimeAsync(29999);
        expect(roomOffers(t)).toEqual([]);
        await jest.advanceTimersByTimeAsync(1);
        expect(roomOffers(t)).toEqual([1]);
        expect(t.game.seatPresence(1)).toBe('resignable');
        expect(t.game.seatPresence(2)).toBe('grace');
        await jest.advanceTimersByTimeAsync(30000);
        expect(roomOffers(t)).toEqual([1, 2]);
        const s1 = t.game.seat(1);
        expect(s1.resignableAt - s1.absentSince).toBe(60000);
    });

    test('a rejoin clears only its own grace; the other seat is still offered on time', async () => {
        const t = table();
        await drop(t, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(30000);
        await drop(t, t.sockets[2]);
        await jest.advanceTimersByTimeAsync(15000);
        await rejoin(t, 'user1');
        expect(t.game.hasTimer('grace:1')).toBe(false);
        expect(t.game.hasTimer('grace:2')).toBe(true);
        await jest.advanceTimersByTimeAsync(45000); // t = 90s
        expect(roomOffers(t)).toEqual([2]);
    });
});

describe('R3 a returning socket gets the table presence replayed', () => {
    test('rejoin: rejoinSuccess, then playerDisconnected for absent seats, then the offer', async () => {
        const t = table();
        await drop(t, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(10000);
        await drop(t, t.sockets[2]);
        await jest.advanceTimersByTimeAsync(60000); // both resignable, 2 offered last
        const mark = t.log.length;
        const s = await rejoin(t, 'user1');
        expect(selfEvents(t, s, mark)).toEqual([
            'rejoinSuccess@1', 'voicePeerList', 'playerDisconnected@2', 'resignationAvailable@2',
        ]);
    });

    test('watcher /active: restorePlayerState, then the replay', async () => {
        const t = table();
        chat(t, 3, '/lazy');
        const w = await rejoin(t, 'user3');
        await drop(t, t.sockets[2]);
        await jest.advanceTimersByTimeAsync(60000);
        const mark = t.log.length;
        chat(t, 3, '/active', w);
        expect(selfEvents(t, w, mark)).toEqual(['restorePlayerState@3', 'playerDisconnected@2', 'resignationAvailable@2']);
        // The rejoin itself replayed nothing yet (nobody was absent)
        expect(selfEvents(t, w).slice(0, 1)).toEqual(['rejoinSuccess@3']);
    });
});

describe('R4/R5 resign offers', () => {
    async function twoResignable() {
        const t = table();
        await drop(t, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(10000);
        await drop(t, t.sockets[2]);
        await jest.advanceTimersByTimeAsync(60000);
        expect(roomOffers(t)).toEqual([1, 2]);
        expect(t.game.resignablePositions()).toEqual([1, 2]);
        return t;
    }

    test('after a resign the oldest other resignable seat is offered again', async () => {
        const t = await twoResignable();
        const mark = t.log.length;
        await gameHandlers.forceResign(t.sockets[3], t.io, { position: 2 });
        const after = t.log.slice(mark).filter((l) => l.to === t.game.roomName).map((l) => l.event);
        expect(after.indexOf('playerResigned')).toBeGreaterThan(-1);
        expect(after.indexOf('resignationAvailable')).toBeGreaterThan(after.indexOf('playerResigned'));
        expect(roomOffers(t)).toEqual([1, 2, 1]);
        expect(t.game.offerPos).toBe(1);
    });

    test('the offered seat coming back re-offers the other one; none left clears the offer', async () => {
        const t = await twoResignable();
        expect(t.game.offerPos).toBe(2);
        await rejoin(t, 'user2');
        expect(roomOffers(t)).toEqual([1, 2, 1]);
        await gameHandlers.forceResign(t.sockets[3], t.io, { position: 1 });
        expect(roomOffers(t)).toEqual([1, 2, 1]);
        expect(t.game.offerPos).toBeNull();
    });

    test('forceResign during grace is refused and changes nothing', async () => {
        const t = table();
        await drop(t, t.sockets[1]);
        await gameHandlers.forceResign(t.sockets[2], t.io, { position: 1 });
        expect(events(t.log, 'error').map((l) => l.data.message)).toEqual(['Player is not disconnected']);
        expect(t.game.seat(1)).toMatchObject({ controller: 'human', presence: 'grace' });
        expect(events(t.log, 'playerResigned')).toHaveLength(0);
    });

    test('a lazy owner may forceResign a resignable seat', async () => {
        const t = table();
        chat(t, 2, '/lazy');
        await drop(t, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(60000);
        await gameHandlers.forceResign(t.sockets[2], t.io, { position: 1 });
        expect(t.game.seatController(1)).toBe('resignBot');
        // A stale or unrelated socket may not
        await gameHandlers.forceResign(newSocket(t, 'nobody'), t.io, { position: 4 });
        expect(events(t.log, 'error').map((l) => l.data.message)).toEqual(['Not in a game']);
    });
});

describe('R6/R7 abandon and abort (srv-6)', () => {
    test('(a) two lazy humans, one disconnects: no abort', async () => {
        const t = table({ bots: { 3: 'mary', 4: 'sharon' } });
        chat(t, 1, '/lazy');
        chat(t, 2, '/lazy');
        await drop(t, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(120000);
        expect(aborts(t)).toHaveLength(0);
        expect(t.game.hasTimer('abandon')).toBe(false);
    });

    test('(b) a seat in grace plus a lazy owner dropping: abort only when abandon runs out', async () => {
        const t = table({ bots: { 3: 'mary', 4: 'sharon' } });
        chat(t, 2, '/lazy');
        await drop(t, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(20000);
        await drop(t, t.sockets[2]);
        expect(t.game.hasTimer('abandon')).toBe(true);
        await jest.advanceTimersByTimeAsync(59999);
        expect(aborts(t)).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(1);
        expect(aborts(t).map((l) => l.data.reason)).toEqual(['All players disconnected']);
    });

    test('(c) a lazy owner watching from a newer socket while the old one drops: still present', async () => {
        const t = table({ bots: { 3: 'mary', 4: 'sharon' } });
        chat(t, 1, '/lazy');
        await drop(t, t.sockets[2]);
        const w = await rejoin(t, 'user1');
        await drop(t, t.sockets[1]); // the old seat-view socket
        expect(t.game.seat(1)).toMatchObject({ presence: 'connected', ownerSocketId: w.id });
        await jest.advanceTimersByTimeAsync(120000);
        expect(aborts(t)).toHaveLength(0);
    });

    test('R7 a lone lazy owner dropping aborts 60s later, and a rejoin within it cancels that', async () => {
        const t = table({ bots: { 2: 'mary', 3: 'sharon', 4: 'danny' } });
        chat(t, 1, '/lazy');
        await drop(t, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(59000);
        expect(aborts(t)).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(1000);
        expect(aborts(t)).toHaveLength(1);

        const u = table({ bots: { 2: 'mary', 3: 'sharon', 4: 'danny' } });
        chat(u, 1, '/lazy');
        await drop(u, u.sockets[1]);
        await jest.advanceTimersByTimeAsync(30000);
        await rejoin(u, 'user1');
        expect(u.game.hasTimer('abandon')).toBe(false);
        await jest.advanceTimersByTimeAsync(120000);
        expect(aborts(u)).toHaveLength(0);
    });
});

describe('R8/R9 the newest socket owns the seat (#181 nit)', () => {
    test('a stale shadow cannot /active or /leave the seat; the newest can', async () => {
        const t = table();
        chat(t, 2, '/lazy');
        const s1 = await rejoin(t, 'user2');
        const s2 = await rejoin(t, 'user2');
        expect(t.game.seat(2).ownerSocketId).toBe(s2.id);
        // s1 and the original seat socket were demoted to spectators: watch only
        expect(t.game.isSpectator(s1.id)).toBe(true);
        expect(gameManager.playerGames.has(s1.id)).toBe(false);
        expect(gameManager.spectatorGames.get(s1.id)).toBe(t.game.gameId);

        chat(t, 2, '/active', s1);
        expect(t.game.seatController(2)).toBe('lazyBot');
        chat(t, 2, '/lazy', s1);
        chat(t, 2, '/leave', s1);
        expect(t.game.seat(2)).toMatchObject({ controller: 'lazyBot', presence: 'connected', ownerSocketId: s2.id });
        expect(selfEvents(t, s1).filter((e) => e === 'leftGame')).toHaveLength(1);
        expect(gameManager.spectatorGames.has(s1.id)).toBe(false);
        gameManager.registerUser(s1.id, 'user2'); // s2 took the user entry
        expect(gameManager.joinQueue(s1.id).success).toBe(true);
        gameManager.leaveLobby(s1.id);

        chat(t, 2, '/active', s2);
        expect(t.game.seat(2)).toMatchObject({ controller: 'human', presence: 'connected', seatSocketId: s2.id });
    });

    test('a tournament spectator with the owner\'s name cannot /active the seat', async () => {
        const t = table();
        chat(t, 2, '/lazy');
        const spy = newSocket(t, 'user2');
        tournamentHandlers.spectateTournamentGame(spy, t.io, { gameId: t.game.gameId });
        expect(t.game.isSpectator(spy.id)).toBe(true);
        chat(t, 2, '/active', spy);
        expect(t.game.seatController(2)).toBe('lazyBot');
        expect(events(t.log, 'playerActiveMode')).toHaveLength(0);
    });

    test('R9 a rejoin while the old seat socket is still connected moves the seat', async () => {
        const t = table();
        const old = t.sockets[1];
        const n = await rejoin(t, 'user1');
        expect(t.game.seat(1)).toMatchObject({ presence: 'connected', ownerSocketId: n.id, seatSocketId: n.id });
        expect(gameManager.playerGames.has(old.id)).toBe(false);
        expect(inRoom(t, old.id)).toBe(false);
        expect(inRoom(t, n.id)).toBe(true);
        // The old socket is free (no "Already in game")
        gameManager.registerUser(old.id, 'user1');
        expect(gameManager.createNamedLobby(old.id).success).toBe(true);
        gameManager.leaveLobby(old.id);
        // And it can no longer act for the seat
        await gameHandlers.playerBid(old, t.io, { bid: '1' });
        expect(t.game.getBidCount()).toBe(0);
    });
});

describe('R11/R12 lazy bots are ordinary BotController bots (srv-15)', () => {
    test('R11 /active silences the lazy bot\'s pending chat', async () => {
        const list = personalities.PERSONALITY_LIST;
        Math.random = () => (list.indexOf('sharon') + 0.5) / list.length;
        const t = table();
        chat(t, 1, '/lazy');
        expect(t.game.seat(1).bot.personality).toBe('sharon');
        Math.random = realRandom;
        t.game.trump = C('7', 'clubs');
        botController.handleTrumpRevealed(t.io, t.game); // "puppy's feet" in 5s
        chat(t, 1, '/active');
        await jest.advanceTimersByTimeAsync(10000);
        expect(events(t.log, 'chatMessage')).toHaveLength(0);
    });

    test('R12 /lazy on its own turn schedules a bot action; the human socket cannot act', async () => {
        const t = table();
        chat(t, 3, '/lazy');
        const botSid = t.game.seat(3).bot.socketId;
        expect(t.game.positions[3]).toBe(botSid);
        expect(botController.pendingActions.has(`${t.game.gameId}:${botSid}:bid`)).toBe(true);
        expect(t.game.timerKeys().some((k) => k.startsWith('lazy:'))).toBe(false);
        await gameHandlers.playerBid(t.sockets[3], t.io, { bid: '1' });
        expect(events(t.log, 'actionRejected').map((l) => l.data.reason)).toEqual(['not_your_turn']);
        await jest.advanceTimersByTimeAsync(5000);
        expect(events(t.log, 'bidReceived').map((l) => l.data.position)).toEqual([3]);

        const u = table();
        toPlaying(u.game);
        chat(u, 1, '/lazy');
        const uBot = u.game.seat(1).bot.socketId;
        await jest.advanceTimersByTimeAsync(5000);
        const played = events(u.log, 'cardPlayed');
        expect(played).toHaveLength(1);
        expect(played[0].data).toMatchObject({ playerId: uBot, position: 1 });
    });
});

describe('R15 a pure spectator watches one game at a time (sp-15)', () => {
    test('spectating B leaves A; joinMainRoom and disconnect stop spectating; chat goes to the right game', async () => {
        const a = table();
        const b = table();
        // One io for both tables' sockets is not needed: use b's io for the spectator
        const s = makeSocket('pr-spec', b.log, b.io);
        a.io.sockets.sockets.set(s.id, s);
        gameManager.registerUser(s.id, 'watcher');
        mainRoomHandlers.joinAsSpectator(s, a.io, { gameId: a.game.gameId });
        expect(a.game.isSpectator(s.id)).toBe(true);
        expect(b.io.rooms.get(a.game.roomName)?.has(s.id)).toBe(true);
        mainRoomHandlers.joinAsSpectator(s, b.io, { gameId: b.game.gameId });
        expect(a.game.isSpectator(s.id)).toBe(false);
        expect(b.io.rooms.get(a.game.roomName)?.has(s.id)).toBe(false);
        expect(b.game.isSpectator(s.id)).toBe(true);
        expect(gameManager.spectatorGames.get(s.id)).toBe(b.game.gameId);

        chatHandlers.chatMessage(s, b.io, { message: 'hello' });
        const said = events(b.log, 'chatMessage');
        expect(said.map((l) => l.to)).toEqual([b.game.roomName]);
        expect(said[0].data).toMatchObject({ position: null, username: 'watcher', isSpectator: true });

        mainRoomHandlers.joinMainRoom(s, b.io);
        expect(b.game.isSpectator(s.id)).toBe(false);
        expect(gameManager.spectatorGames.has(s.id)).toBe(false);

        mainRoomHandlers.joinAsSpectator(s, b.io, { gameId: b.game.gameId });
        await drop(b, s);
        expect(b.game.isSpectator(s.id)).toBe(false);
        expect(gameManager.spectatorGames.has(s.id)).toBe(false);
    });
});

describe('R16-R19 watchers', () => {
    test('R16 a lazy player who rejoins and watches to the end can then queue and create a lobby', async () => {
        const t = table();
        t.game.currentHand = 13;
        toPlaying(t.game);
        t.game.cardIndex = 48;
        t.game.tricks = { team1: 7, team2: 5 };
        t.game.bids = { team1: 7, team2: 5 };
        chat(t, 1, '/lazy');
        const w = await rejoin(t, 'user1');
        await jest.advanceTimersByTimeAsync(5000); // the bot plays seat 1
        const pending = [2, 3, 4].map((p) => gameHandlers.playCard(t.sockets[p], t.io, { card: t.game.getHand(t.sockets[p].id)[0] }));
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(pending);
        expect(events(t.log, 'gameEnd')).toHaveLength(1);
        expect(gameManager.playerGames.has(w.id)).toBe(false);
        expect(gameManager.joinQueue(w.id).success).toBe(true);
        gameManager.leaveLobby(w.id);
        expect(gameManager.createNamedLobby(w.id).success).toBe(true);
        gameManager.leaveLobby(w.id);
    });

    test('R17 /leave from a resigned owner watcher is final and never throws', async () => {
        const t = table({ bots: { 3: 'mary', 4: 'sharon' } });
        await drop(t, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(60000);
        await gameHandlers.forceResign(t.sockets[2], t.io, { position: 1 });
        const w = await rejoin(t, 'user1');
        expect(t.game.seat(1)).toMatchObject({ controller: 'resignBot', presence: 'connected', ownerView: 'watch' });
        expect(() => chat(t, 1, '/leave', w)).not.toThrow();
        expect(t.game.seat(1).presence).toBe('gone');
        expect(selfEvents(t, w).filter((e) => e === 'leftGame' || e === 'joinMainRoom')).toEqual(['leftGame', 'joinMainRoom']);
        expect(aborts(t)).toHaveLength(0); // seat 2 is still here
        // A gone seat cannot be rejoined
        const again = await rejoin(t, 'user1');
        expect(selfEvents(t, again)).toEqual(['rejoinFailed']);
        // The last owner leaving: nobody can ever come back, abort now
        chat(t, 2, '/leave');
        expect(aborts(t).map((l) => l.data.reason)).toEqual(['All players left']);
    });

    test('R17 a draw-phase leaver cannot rejoin the seat its bot took', async () => {
        const t = table();
        gameManager.abortGame(t.game.gameId);
        seq++;
        const log = [];
        const io = makeIo(log);
        const ids = [1, 2, 3, 4].map((n) => `dl${seq}-h${n}`);
        ids.forEach((id, i) => {
            gameManager.registerUser(id, `dl${seq}u${i}`);
            mockDb.current.users._insert({ username: `dl${seq}u${i}` });
        });
        const game = gameManager.createGame(ids);
        const sockets = ids.map((id) => makeSocket(id, log, io));
        game.deck = new Deck();
        game.transition(Phase.CREATED, Phase.DRAWING);
        chatHandlers.chatMessage(sockets[0], io, { message: '/leave' });
        const pending = sockets.slice(1).map((s) => gameHandlers.draw(s, io, { num: 0 }));
        await jest.advanceTimersByTimeAsync(7000);
        await Promise.all(pending);
        expect(game.seat(game.seatByUsername(`dl${seq}u0`))).toMatchObject({ controller: 'resignBot', presence: 'gone' });
        const s = makeSocket('dl-again', log, io);
        gameManager.registerUser(s.id, `dl${seq}u0`);
        await reconnectHandlers.rejoinGame(s, io, { gameId: game.gameId, username: `dl${seq}u0` });
        expect(log.filter((l) => l.to === `self:${s.id}`).map((l) => l.event)).toEqual(['rejoinFailed']);
    });

    test('R18 a lazy watcher gets its seat\'s gameStart with the hand; pure spectators get hand []', async () => {
        const t = table();
        toPlaying(t.game);
        chat(t, 1, '/lazy');
        const w = await rejoin(t, 'user1');
        const spec = newSocket(t, 'watcher');
        mainRoomHandlers.joinAsSpectator(spec, t.io, { gameId: t.game.gameId });
        await jest.advanceTimersByTimeAsync(5000); // the bot leads
        const pending = [];
        for (const p of [2, 3, 4]) {
            const sid = t.sockets[p].id;
            pending.push(gameHandlers.playCard(t.sockets[p], t.io, { card: legalCards(t.game, sid)[0] }));
        }
        await jest.advanceTimersByTimeAsync(6000);
        await Promise.all(pending);
        expect(t.game.currentHand).toBe(3);
        const toW = events(t.log, 'gameStart').filter((l) => l.to === w.id);
        expect(toW).toHaveLength(1);
        expect(toW[0].data.position).toBe(1);
        expect(toW[0].data.hand).toHaveLength(3);
        const toSpec = events(t.log, 'gameStart').filter((l) => l.to === spec.id);
        expect(toSpec).toHaveLength(1);
        expect(toSpec[0].data.hand).toEqual([]);
        // The /lazy'd seat socket was demoted by the rejoin: spectator payload
        expect(events(t.log, 'gameStart').filter((l) => l.to === t.sockets[1].id).map((l) => l.data.hand)).toEqual([[]]);
    });

    test('R19 a repeated rejoin from the watching socket is idempotent', async () => {
        const t = table();
        chat(t, 1, '/lazy');
        const w = await rejoin(t, 'user1');
        await reconnectHandlers.rejoinGame(w, t.io, { gameId: t.game.gameId, username: 'user1' });
        expect(selfEvents(t, w).filter((e) => /^rejoin/.test(e))).toEqual(['rejoinSuccess@1', 'rejoinSuccess@1']);
        expect(events(t.log, 'playerReconnected')).toHaveLength(1);
        expect(events(t.log, 'rejoinFailed')).toHaveLength(0);
    });
});

describe('R20 stats', () => {
    async function statsFor(setup) {
        const t = table();
        await setup(t);
        const spy = jest.spyOn(mockDb.current.users, 'updateOne');
        await profileHandlers.recordGameStats(t.game);
        return spy.mock.calls.filter(([, u]) => u.$inc && 'stats.gamesPlayed' in u.$inc).map(([f]) => f.username).sort();
    }

    test('a lazy seat is recorded for its human', async () => {
        expect(await statsFor(async (t) => chat(t, 1, '/lazy'))).toEqual(['user1', 'user2', 'user3', 'user4']);
    });

    test('a resign-bot seat skips the game', async () => {
        expect(await statsFor(async (t) => resignedSeat(t.game, 1, botController.createBot('🤖 Zed', 'zach')))).toEqual([]);
    });

    test('resigned then /active is recorded again', async () => {
        expect(await statsFor(async (t) => {
            await drop(t, t.sockets[1]);
            await jest.advanceTimersByTimeAsync(60000);
            await gameHandlers.forceResign(t.sockets[2], t.io, { position: 1 });
            const w = await rejoin(t, 'user1');
            chat(t, 1, '/active', w);
        })).toEqual(['user1', 'user2', 'user3', 'user4']);
    });
});

describe('R21 joinAsSpectator by an owner returns them to their seat', () => {
    test('a resigned owner becomes the watcher', async () => {
        const t = table();
        await drop(t, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(60000);
        await gameHandlers.forceResign(t.sockets[2], t.io, { position: 1 });
        const s = newSocket(t, 'user1');
        mainRoomHandlers.joinAsSpectator(s, t.io, { gameId: t.game.gameId });
        const ok = t.log.find((l) => l.to === `self:${s.id}` && l.event === 'rejoinSuccess');
        expect(ok.data).toMatchObject({ position: 1, isLazy: true });
        expect(t.game.seat(1)).toMatchObject({ presence: 'connected', ownerSocketId: s.id, ownerView: 'watch' });
        expect(t.game.isSpectator(s.id)).toBe(false);
    });

    test('a human seat in grace is reconnected', async () => {
        const t = table();
        await drop(t, t.sockets[1]);
        const s = newSocket(t, 'user1');
        mainRoomHandlers.joinAsSpectator(s, t.io, { gameId: t.game.gameId });
        expect(t.game.seat(1)).toMatchObject({ controller: 'human', presence: 'connected', seatSocketId: s.id });
        expect(events(t.log, 'playerReconnected')).toHaveLength(1);
        expect(t.game.hasTimer('grace:1')).toBe(false);
    });
});

describe('R13/R14 draw watchdog (srv-2)', () => {
    /** 4 humans (+ optional lobby bots) through createGame + beginDraw. */
    function drawTable(humans = 4) {
        seq++;
        const log = [];
        const io = makeIo(log);
        const ids = Array.from({ length: humans }, (_, i) => `dw${seq}-h${i + 1}`);
        ids.forEach((id, i) => {
            gameManager.registerUser(id, `dw${seq}u${i + 1}`);
            mockDb.current.users._insert({ username: `dw${seq}u${i + 1}` });
        });
        const bots = Array.from({ length: 4 - humans }, (_, i) => botController.createBot(`🤖 W${i}`, ['mary', 'sharon', 'danny'][i]));
        const game = gameManager.createGame([...ids, ...bots.map((b) => b.socketId)]);
        bots.forEach((b) => botController.registerBot(game.gameId, b));
        const sockets = ids.map((id) => makeSocket(id, log, io));
        sockets.forEach((s) => s.join(game.roomName));
        gameLifecycle.beginDraw(io, game);
        return { log, io, game, ids, sockets };
    }

    test('R13 an idle connected human is auto-drawn at 30s, not before', async () => {
        const d = drawTable();
        expect(d.game.hasTimer('draw:watchdog')).toBe(true);
        const pending = d.sockets.slice(1).map((s) => gameHandlers.draw(s, d.io, { num: 0 }));
        await jest.advanceTimersByTimeAsync(29900);
        expect(d.game.drawIDs).not.toContain(d.ids[0]);
        expect(d.game.stage).toBe(Phase.DRAWING);
        await jest.advanceTimersByTimeAsync(100);
        const mine = d.log.filter((l) => l.to === `self:${d.ids[0]}` || l.to === d.ids[0]).filter((l) => l.event === 'youDrew');
        expect(mine).toHaveLength(1);
        expect(mine[0].data).toEqual({ card: expect.any(Object), drawOrder: 4 });
        expect(events(d.log, 'playerDrew').filter((l) => l.data.socketId === d.ids[0])).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(7000);
        await Promise.all(pending);
        expect(d.game.stage).toBe(Phase.BIDDING);
        expect(d.game.seatPresence(d.game.seatBySocket(d.ids[0]))).toBe('connected');
        // A late click is refused by the duplicate guard
        expect(d.game.recordDraw(d.ids[0], 0)).toBeNull();
    });

    test('R13 a draw everyone finished in time clears the watchdog; a disconnect still auto-draws at once', async () => {
        const d = drawTable();
        await drop({ io: d.io }, d.sockets[3]);
        expect(d.game.drawIDs).toEqual([d.ids[3]]);
        const pending = d.sockets.slice(0, 3).map((s) => gameHandlers.draw(s, d.io, { num: 0 }));
        expect(d.game.hasTimer('draw:watchdog')).toBe(false);
        await jest.advanceTimersByTimeAsync(40000);
        await Promise.all(pending);
        expect(d.game.stage).toBe(Phase.BIDDING);
        expect(d.log.filter((l) => l.event === 'youDrew')).toHaveLength(3);
    });

    test('R14 the real lobby countdown: a CREATED disconnect ends in a grace seat announced after positionUpdate', async () => {
        seq++;
        const log = [];
        const io = makeIo(log);
        const ids = [1, 2, 3].map((n) => `lc${seq}-h${n}`);
        ids.forEach((id, i) => {
            gameManager.registerUser(id, `lc${seq}u${i}`);
            mockDb.current.users._insert({ username: `lc${seq}u${i}` });
        });
        const sockets = ids.map((id) => makeSocket(id, log, io));
        const lobby = gameManager.createLobby(ids);
        gameManager.addBotToLobby(lobby.id);
        const ready = sockets.map((s) => lobbyHandlers.playerReady(s, io));
        await jest.advanceTimersByTimeAsync(1500 + 500); // game created, inside the 2s pause
        const game = gameManager.getPlayerGame(ids[0]);
        expect(game.stage).toBe(Phase.CREATED);
        await drop({ io }, sockets[0]);
        // Nobody else draws: the bot draws by itself, the watchdog does the rest
        await jest.advanceTimersByTimeAsync(1600 + 30000 + 7000);
        await Promise.all(ready);
        expect(game.stage).toBe(Phase.BIDDING);
        const pos = game.seatByUsername(`lc${seq}u0`);
        expect(game.seatPresence(pos)).toBe('grace');
        const names = log.map((l) => l.event);
        expect(names.indexOf('playerDisconnected')).toBeGreaterThan(names.indexOf('positionUpdate'));
        expect(events(log, 'playerDisconnected').map((l) => l.data.position)).toEqual([pos]);
    });
});

describe('R22 currentUsers is pruned (sp-9)', () => {
    const online = () => gameManager.getOnlineUsernames();

    test('an in-game disconnect drops the user from the online list', async () => {
        const t = table();
        expect(online()).toContain('user1');
        await drop(t, t.sockets[1]);
        expect(online()).not.toContain('user1');
        expect(gameManager.getUserBySocketId(t.sockets[1].id)).toBeUndefined();
        // ...and a rejoin puts them back
        await rejoin(t, 'user1');
        expect(online()).toContain('user1');
    });

    test('a draw-phase dropper is still named from its entrant at seating', async () => {
        seq++;
        const log = [];
        const io = makeIo(log);
        const ids = [1, 2, 3, 4].map((n) => `nm${seq}-h${n}`);
        ids.forEach((id, i) => gameManager.registerUser(id, `nm${seq}u${i}`));
        const game = gameManager.createGame(ids);
        const sockets = ids.map((id) => makeSocket(id, log, io));
        gameLifecycle.beginDraw(io, game);
        await drop({ io }, sockets[0]);
        expect(gameManager.getUserBySocketId(ids[0])).toBeUndefined();
        const pending = sockets.slice(1).map((s) => gameHandlers.draw(s, io, { num: 0 }));
        await jest.advanceTimersByTimeAsync(7000);
        await Promise.all(pending);
        const pos = game.seatByUsername(`nm${seq}u0`);
        expect(game.seat(pos)).toMatchObject({ presence: 'grace', ownerUsername: `nm${seq}u0` });
        expect(events(log, 'playerDisconnected')[0].data).toEqual({ position: pos, username: `nm${seq}u0` });
    });

    test('retiring a game drops its dead sockets and keeps live ones', async () => {
        const t = table();
        chat(t, 2, '/lazy');
        const w = await rejoin(t, 'user2');
        // A socket that died without a disconnect event
        t.io.sockets.sockets.delete(t.sockets[3].id);
        await gameLifecycle.abortGame(t.io, t.game, 'test');
        expect(gameManager.getUserBySocketId(t.sockets[3].id)).toBeUndefined();
        expect(gameManager.getUserBySocketId(w.id)?.username).toBe('user2');
        expect(gameManager.getUserBySocketId(t.sockets[1].id)?.username).toBe('user1');
        expect(gameManager.spectatorGames.has(t.sockets[2].id)).toBe(false); // the demoted seat socket
    });
});
