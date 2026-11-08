/**
 * Lifecycle epoch: once a game ends or aborts, no continuation (pause,
 * bot timer, lazy timer, grace timer, in-flight DB write) may emit into it,
 * re-arm state for it, or leave a mapping/room/timer behind. Drives the real
 * handlers with stub sockets, fake timers and the in-memory DB.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const mockProfile = {};
jest.mock('../profileHandlers', () => {
    const actual = jest.requireActual('../profileHandlers');
    return {
        ...actual,
        recordGameStats: jest.fn((...args) => (mockProfile.recordGameStats ? mockProfile.recordGameStats(...args) : Promise.resolve())),
        getUserProfilePic: jest.fn((...args) => (mockProfile.getUserProfilePic ? mockProfile.getUserProfilePic(...args) : actual.getUserProfilePic(...args))),
    };
});

const Deck = require('../../game/Deck');
const TournamentState = require('../../game/TournamentState');
const gameManager = require('../../game/GameManager');
const profileHandlers = require('../profileHandlers');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const queueHandlers = require('../queueHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const gameLifecycle = require('../gameLifecycle');
const ambient = require('../../demo/ambientBots');
const { botController } = require('../../game/bot');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events, legalCards } = require('../../testUtils/gameDriver');

const C = (rank, suit) => ({ rank, suit });

// Events a live game sends to its room or seats
const GAME_EVENTS = new Set([
    'startDraw', 'playerDrew', 'youDrew', 'playerAssigned', 'positionUpdate', 'teamsAnnounced', 'createUI',
    'gameStart', 'updateTurn', 'bidReceived', 'doneBidding', 'rainbow', 'destroyHands', 'cardPlayed',
    'trickComplete', 'handComplete', 'gameEnd', 'abortGame', 'chatMessage', 'gameLogEntry',
    'playerDisconnected', 'playerReconnected', 'resignationAvailable', 'playerLazyMode', 'playerActiveMode',
    'playerResigned', 'spectatorJoined', 'voicePeerLeft',
]);

/** Game-event emits to the game room or any of `socketIds` after log index `from`. */
function deadEmits(log, from, game, socketIds) {
    const targets = new Set([game.roomName]);
    for (const id of socketIds) { targets.add(id); targets.add(`self:${id}`); }
    return log.slice(from).filter((l) => GAME_EVENTS.has(l.event) && targets.has(l.to));
}

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const k of Object.keys(mockProfile)) delete mockProfile[k];
    profileHandlers.recordGameStats.mockClear();
});

afterEach(async () => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
});

function registerHumans(ids) {
    ids.forEach((id) => {
        gameManager.registerUser(id, `user_${id}`);
        mockDb.current.users._insert({ username: `user_${id}`, profilePic: 5 });
    });
}

/** 4 humans (or humans + bots) in DRAWING, joined to the room. */
function drawingGame(prefix, { humans = 4, io } = {}) {
    seq++;
    const ids = Array.from({ length: humans }, (_, i) => `${prefix}${seq}-h${i + 1}`);
    registerHumans(ids);
    const bots = Array.from({ length: 4 - humans }, (_, i) => botController.createBot(`🤖 B${i}`, 'mary'));
    const game = gameManager.createGame([...ids, ...bots.map((b) => b.socketId)]);
    bots.forEach((b) => botController.registerBot(game.gameId, b));
    const log = io ? null : [];
    const sockets = ids.map((id) => makeSocket(id, io ? io._log : log, io));
    if (io) sockets.forEach((s) => s.join(game.roomName));
    game.deck = new Deck();
    game.transition(Phase.CREATED, Phase.DRAWING);
    return { game, ids, bots, sockets };
}

function newIo() {
    const log = [];
    const io = makeIo(log);
    io._log = log;
    return { io, log };
}

/** Draw for every seat (humans through draw(), bots through their socket id). */
function drawAll(io, game, sockets, bots, log) {
    const pending = [];
    for (const s of sockets) pending.push(gameHandlers.draw(s, io, { num: 0 }));
    for (const b of bots) pending.push(gameHandlers.draw(makeSocket(b.socketId, log), io, { num: 0 }));
    return pending;
}

async function advanceUntil(pred, step = 100, cap = 30000) {
    let t = 0;
    while (!pred() && t < cap) {
        await jest.advanceTimersByTimeAsync(step);
        t += step;
    }
    if (!pred()) throw new Error('advanceUntil: condition never met');
}

/** Seated 4-human game in `stage` with explicit hands (hardening-style fixture). */
function seatedGame(prefix, io, { handSize = 1, hands } = {}) {
    seq++;
    const ids = [1, 2, 3, 4].map((n) => `${prefix}${seq}-h${n}`);
    registerHumans(ids);
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, `user_${id}`, i + 1, 1, false));
    const sockets = ids.map((id) => makeSocket(id, io._log, io));
    sockets.forEach((s) => s.join(game.roomName));
    game.currentHand = handSize;
    const h = hands || [[C('2', 'hearts')], [C('4', 'hearts')], [C('6', 'hearts')], [C('8', 'hearts')]];
    ids.forEach((id, i) => game.setHand(id, h[i]));
    game.trump = C('A', 'spades');
    return { game, ids, sockets };
}

function toPlaying(game) {
    game.forcePhase(Phase.PLAYING);
    game.bids = { team1: 1, team2: 0 };
    game.playerBids = ['1', '0', '0', '0'];
    game.currentTurn = 1;
    game.leadPosition = 1;
}

describe('1. abort during trick resolution', () => {
    test('nothing is emitted after the abort and the hand never completes', async () => {
        const { io, log } = newIo();
        const { game, ids, sockets } = seatedGame('t', io);
        toPlaying(game);

        const plays = [];
        for (let i = 0; i < 4; i++) plays.push(gameHandlers.playCard(sockets[i], io, { card: game.getHand(ids[i])[0] }));
        expect(game.stage).toBe(Phase.TRICK_RESOLVING);
        await jest.advanceTimersByTimeAsync(500);

        const mark = log.length;
        await gameLifecycle.abortGame(io, game, 'test');
        await jest.advanceTimersByTimeAsync(10000);
        await Promise.all(plays);

        expect(events(log, 'abortGame')).toHaveLength(1);
        expect(deadEmits(log, mark + 1, game, ids)).toEqual([]);
        expect(events(log, 'gameStart')).toHaveLength(0);
        expect(events(log, 'trickComplete')).toHaveLength(0);
        expect(profileHandlers.recordGameStats).not.toHaveBeenCalled();
        expect(game.pendingTimerCount).toBe(0);
        expect(gameManager.getGameById(game.gameId)).toBeNull();
    });
});

describe('2. abort in each handleDrawComplete window', () => {
    const AFTER = ['positionUpdate', 'teamsAnnounced', 'createUI', 'gameStart'];

    async function runWindow(setupWindow) {
        const { io, log } = newIo();
        const { game, ids, sockets, bots } = drawingGame('w', { io });
        const ctl = setupWindow ? setupWindow(game) : {};
        const pending = drawAll(io, game, sockets, bots, log);
        await ctl.reach();
        const mark = log.length;
        await gameLifecycle.abortGame(io, game, 'test');
        if (ctl.release) ctl.release();
        await jest.advanceTimersByTimeAsync(10000);
        await Promise.all(pending);

        const after = log.slice(mark).map((l) => l.event);
        for (const e of AFTER) expect(after).not.toContain(e);
        expect(deadEmits(log, mark + 1, game, ids)).toEqual([]);
        const armed = mockDb.current.users.docs.filter((d) => d.activeGameId === game.gameId);
        expect(armed).toEqual([]);
        expect(game.pendingTimerCount).toBe(0);
        return { log, game };
    }

    test('during the profile-pic lookups', async () => {
        const gate = deferred();
        await runWindow(() => {
            mockProfile.getUserProfilePic = async () => { await gate.promise; return 7; };
            return {
                reach: async () => { await jest.advanceTimersByTimeAsync(50); },
                release: () => gate.resolve(),
            };
        });
    });

    test.each([
        ['the first 1s pause', 300, 'positionUpdate', 0],
        ['the second 1s pause', 1300, 'positionUpdate', 1],
        ['the 3s team announcement', 2500, 'teamsAnnounced', 1],
    ])('during %s', async (_name, at, event, count) => {
        const { log } = await runWindow(() => ({
            reach: async () => { await jest.advanceTimersByTimeAsync(at); },
        }));
        expect(events(log, event)).toHaveLength(count);
    });

    test('mid setActiveGame loop (an in-flight write is cleared again)', async () => {
        const gate = deferred();
        let reached = false;
        await runWindow(() => {
            const real = mockDb.current.users.updateOne.bind(mockDb.current.users);
            let first = true;
            jest.spyOn(mockDb.current.users, 'updateOne').mockImplementation(async (filter, update) => {
                if (first && update.$set && 'activeGameId' in update.$set) {
                    first = false;
                    reached = true;
                    await gate.promise;
                }
                return real(filter, update);
            });
            return {
                reach: async () => { await advanceUntil(() => reached, 50); },
                release: () => gate.resolve(),
            };
        });
    });
});

describe('3. abort during the lobby countdown', () => {
    test('no startDraw, no mapping left, and the players can queue again', async () => {
        const { io, log } = newIo();
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `l${seq}-h${n}`);
        registerHumans(ids);
        const sockets = ids.map((id) => makeSocket(id, log, io));
        gameManager.createLobby(ids);
        const ready = sockets.map((s) => lobbyHandlers.playerReady(s, io));

        await jest.advanceTimersByTimeAsync(1500 + 500); // game created, inside the 2s pause
        const game = gameManager.getPlayerGame(ids[0]);
        expect(game.stage).toBe(Phase.CREATED);

        await gameLifecycle.abortGame(io, game, 'test');
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(ready);

        expect(events(log, 'startDraw')).toHaveLength(0);
        expect(Array.from(gameManager.playerGames.values())).not.toContain(game.gameId);
        for (const id of ids) {
            const result = gameManager.joinQueue(id);
            expect(result.success).toBe(true);
            gameManager.leaveLobby(id);
        }
    });
});

describe('4. first-hand pause', () => {
    test('an abort during it sends no updateTurn and no bot bid', async () => {
        const { io, log } = newIo();
        const { game, ids, sockets, bots } = drawingGame('f', { humans: 1, io });
        drawAll(io, game, sockets, bots, log);
        await advanceUntil(() => game.stage === Phase.BIDDING, 50);

        const mark = log.length;
        await gameLifecycle.abortGame(io, game, 'test');
        await jest.advanceTimersByTimeAsync(10000);

        expect(log.slice(mark).filter((l) => l.event === 'updateTurn' || l.event === 'bidReceived')).toEqual([]);
        expect(deadEmits(log, mark + 1, game, ids)).toEqual([]);
        expect(game.playerBids.filter((b) => b != null)).toEqual([]);
    });

    test('a bid during it yields exactly one updateTurn, for the next bidder', async () => {
        const { io, log } = newIo();
        const { game, ids, sockets } = drawingGame('f', { io });
        drawAll(io, game, sockets, [], log);
        await advanceUntil(() => game.stage === Phase.BIDDING, 50);

        const mark = log.length;
        const bidder = sockets[ids.indexOf(game.positions[game.currentTurn])];
        await gameHandlers.playerBid(bidder, io, { bid: '1' });
        await jest.advanceTimersByTimeAsync(2000);

        const turns = events(log.slice(mark), 'updateTurn');
        expect(turns).toHaveLength(1);
        expect(turns[0].data.currentTurn).toBe(game.currentTurn);
    });
});

describe('5. abort with bot and lazy timers pending', () => {
    test('timers are cancelled and nothing acts afterwards', async () => {
        const { io, log } = newIo();
        const { game, ids, sockets } = seatedGame('b', io);
        game.forcePhase(Phase.BIDDING);
        game.currentTurn = 1;
        // A bot seat with a pending chat timer, a lazy seat with a pending bid
        const bot = botController.createBot('🤖 Pat', 'mary');
        bot.position = 3;
        game.resignPlayer(3, bot.socketId, bot.username, 1);
        botController.registerBot(game.gameId, bot);
        gameManager.playerGames.set(bot.socketId, game.gameId);
        botController.sendBotChat(io, game, bot, 'hello', 5000);
        chatHandlers.chatMessage(sockets[0], io, { message: '/lazy' });
        expect(game.hasTimer('lazy:1')).toBe(true);

        const mark = log.length;
        await gameLifecycle.abortGame(io, game, 'test');
        await jest.advanceTimersByTimeAsync(20000);

        expect(log.slice(mark).filter((l) => ['bidReceived', 'cardPlayed', 'chatMessage'].includes(l.event))).toEqual([]);
        expect(deadEmits(log, mark + 1, game, ids)).toEqual([]);
        expect(game.pendingTimerCount).toBe(0);
        expect(Array.from(botController.pendingActions.keys()).filter((k) => k.startsWith(`${game.gameId}:`))).toEqual([]);
        expect(botController.gamesBots.has(game.gameId)).toBe(false);
    });
});

describe('6. final hand', () => {
    /** Last trick of the 13-card hand, one card each. */
    function finalTrick(io) {
        const g = seatedGame('e', io, { handSize: 13 });
        toPlaying(g.game);
        g.game.cardIndex = 48;
        g.game.tricks = { team1: 7, team2: 5 };
        g.game.bids = { team1: 7, team2: 5 };
        return g;
    }
    function playTrick(io, game, ids, sockets) {
        return [0, 1, 2, 3].map((i) => gameHandlers.playCard(sockets[i], io, { card: game.getHand(ids[i])[0] }));
    }

    test('gameEnd goes out before the stats write', async () => {
        const { io, log } = newIo();
        mockProfile.recordGameStats = async () => { log.push({ to: 'db', event: '__recordGameStats' }); };
        const { game, ids, sockets } = finalTrick(io);
        const plays = playTrick(io, game, ids, sockets);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(plays);

        const names = log.map((l) => l.event);
        expect(names.filter((e) => e === 'gameEnd')).toHaveLength(1);
        expect(names.indexOf('gameEnd')).toBeLessThan(names.indexOf('__recordGameStats'));
        expect(names.indexOf('gameEnd')).toBeLessThan(names.lastIndexOf('lobbiesUpdated'));
        expect(game.stage).toBe(Phase.ENDED);
        expect(game.epoch).toBe(1);
    });

    test('a stats write that never resolves still lets gameEnd out and removes the game', async () => {
        const { io, log } = newIo();
        mockProfile.recordGameStats = () => new Promise(() => {});
        const { game, ids, sockets } = finalTrick(io);
        playTrick(io, game, ids, sockets);
        await jest.advanceTimersByTimeAsync(5000);

        expect(events(log, 'gameEnd')).toHaveLength(1);
        expect(gameManager.getGameById(game.gameId)).toBeNull();
        expect(Array.from(gameManager.playerGames.values())).not.toContain(game.gameId);
        expect(events(log, 'lobbiesUpdated').length).toBeGreaterThan(0);
    });

    test('a /leave by the last human during the DB clears emits no abortGame', async () => {
        const { io, log } = newIo();
        const { game, ids, sockets } = finalTrick(io);
        const gate = deferred();
        const real = mockDb.current.users.updateOne.bind(mockDb.current.users);
        let clearing = false;
        jest.spyOn(mockDb.current.users, 'updateOne').mockImplementation(async (f, u) => {
            if (u.$unset && 'activeGameId' in u.$unset && !clearing) { clearing = true; await gate.promise; }
            return real(f, u);
        });
        const plays = playTrick(io, game, ids, sockets);
        await advanceUntil(() => clearing, 50);
        expect(events(log, 'gameEnd')).toHaveLength(1);

        for (const s of sockets) chatHandlers.chatMessage(s, io, { message: '/leave' });
        expect(await gameLifecycle.abortGame(io, game, 'late')).toBe(false);
        gate.resolve();
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(plays);

        expect(events(log, 'abortGame')).toHaveLength(0);
    });

    test('a tournament game resolves exactly once (a late abort is a no-op)', async () => {
        const { io, log } = newIo();
        const { game, ids, sockets } = finalTrick(io);
        const t = new TournamentState(`t-${seq}`, 'T', ids[0], `user_${ids[0]}`);
        ids.forEach((id) => t.addPlayer(id, `user_${id}`, 1));
        t.startRound(1);
        t.addGameToRound(game.gameId, ids.map((id) => `user_${id}`), 0);
        gameManager.tournaments.set(t.tournamentId, t);
        gameManager.tournamentGames.set(game.gameId, t.tournamentId);
        const endSpy = jest.spyOn(gameManager, 'handleTournamentGameEnd');

        const plays = playTrick(io, game, ids, sockets);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(plays);
        await gameLifecycle.abortGame(io, game, 'late');
        await jest.advanceTimersByTimeAsync(1000);

        expect(events(log, 'gameEnd')).toHaveLength(1);
        expect(events(log, 'gameEnd')[0].data.tournamentId).toBe(t.tournamentId);
        expect(events(log, 'tournamentGameComplete')).toHaveLength(1);
        expect(endSpy).toHaveBeenCalledTimes(1);
        expect(events(log, 'abortGame')).toHaveLength(0);
        endSpy.mockRestore();
        gameManager.deleteTournament(t.tournamentId);
    });
});

describe('7. ambient recycle mid-trick', () => {
    test('spectators get abortGame, leave the room and nothing follows', async () => {
        const { io, log } = newIo();
        const game = ambient.startBotGame(io);
        await advanceUntil(() => game.stage === Phase.PLAYING && game.playedCardsIndex > 0, 100, 120000);

        seq++;
        const spec = makeSocket(`spec${seq}`, log, io);
        gameManager.registerUser(spec.id, `watcher_${seq}`);
        mainRoomHandlers.joinAsSpectator(spec, io, { gameId: game.gameId });
        expect(io.rooms.get(game.roomName).has(spec.id)).toBe(true);

        jest.setSystemTime(Date.now() + 91 * 60 * 1000);
        const mark = log.length;
        ambient.tick(io);
        await jest.advanceTimersByTimeAsync(0);

        const aborts = events(log.slice(mark), 'abortGame');
        expect(aborts).toHaveLength(1);
        expect(aborts[0]).toMatchObject({ to: game.roomName, data: { reason: 'Game recycled' } });
        expect(io.rooms.get(game.roomName).has(spec.id)).toBe(false);
        expect(game.spectators.size).toBe(0);
        expect(gameManager.getGameById(game.gameId)).toBeNull();

        await jest.advanceTimersByTimeAsync(60000);
        const abortIdx = log.findIndex((l, i) => i >= mark && l.event === 'abortGame');
        expect(deadEmits(log, abortIdx + 1, game, [spec.id])).toEqual([]);
        expect(game.pendingTimerCount).toBe(0);
        ambient.stopAmbientActivity();
    });
});

describe('8. teardown sweeps every playerGames entry', () => {
    const mappedTo = (gameId) => Array.from(gameManager.playerGames.entries()).filter(([, g]) => g === gameId);

    test('after an abort in DRAWING (pending sockets, no seats)', async () => {
        const { io } = newIo();
        const { game } = drawingGame('s', { io });
        expect(mappedTo(game.gameId)).toHaveLength(4);
        await gameLifecycle.abortGame(io, game, 'test');
        expect(mappedTo(game.gameId)).toEqual([]);
    });

    test('after a lazy rejoin (shadow socket)', async () => {
        const { io, log } = newIo();
        const { game, ids, sockets } = seatedGame('s', io);
        game.forcePhase(Phase.BIDDING);
        game.currentTurn = 2;
        chatHandlers.chatMessage(sockets[0], io, { message: '/lazy' });
        const shadow = makeSocket(`${ids[0]}-again`, log, io);
        gameManager.registerUser(shadow.id, `user_${ids[0]}`);
        await reconnectHandlers.rejoinGame(shadow, io, { gameId: game.gameId, username: `user_${ids[0]}` });
        expect(gameManager.playerGames.get(shadow.id)).toBe(game.gameId);

        await gameLifecycle.abortGame(io, game, 'test');
        expect(mappedTo(game.gameId)).toEqual([]);
        expect(io.rooms.get(game.roomName).size).toBe(0);
    });
});

describe('9. reconnect grace timer', () => {
    test('a pending grace timer never fires after an abort', async () => {
        const { io, log } = newIo();
        const { game, sockets } = seatedGame('g', io);
        game.forcePhase(Phase.BIDDING);
        await queueHandlers.handleDisconnect(sockets[0], io);
        expect(game.hasTimer('reconnectGrace')).toBe(true);

        await gameLifecycle.abortGame(io, game, 'test');
        await jest.advanceTimersByTimeAsync(60000);

        expect(events(log, 'resignationAvailable')).toHaveLength(0);
        expect(events(log, 'abortGame')).toHaveLength(1);
        expect(game.pendingTimerCount).toBe(0);
    });
});

describe('10. idempotence', () => {
    test('a double abort emits one abortGame and does not throw', async () => {
        const { io, log } = newIo();
        const { game } = seatedGame('i', io);
        game.forcePhase(Phase.PLAYING);
        expect(await gameLifecycle.abortGame(io, game, 'a')).toBe(true);
        expect(await gameLifecycle.abortGame(io, game, 'b')).toBe(false);
        gameManager.abortGame(game.gameId, io);
        gameManager.endGame(game.gameId, io);
        expect(events(log, 'abortGame')).toHaveLength(1);
        expect(game.epoch).toBe(1);
    });

    test('GameManager.endGame on a live game terminates it', () => {
        const { io } = newIo();
        const { game } = seatedGame('i', io);
        game.forcePhase(Phase.HAND_RESOLVING);
        gameManager.endGame(game.gameId, io);
        expect(game.stage).toBe(Phase.ENDED);
        const other = seatedGame('i', io).game;
        other.forcePhase(Phase.BIDDING);
        gameManager.endGame(other.gameId, io);
        expect(other.stage).toBe(Phase.ABORTED);
    });
});

describe('11. draw re-entry', () => {
    /**
     * Runs `scenario` against a fresh 4-human draw and checks the draw
     * resolved exactly once.
     */
    async function expectSingleResolution(scenario) {
        const { io, log } = newIo();
        const g = drawingGame('r', { io });
        const pending = (await scenario({ io, log, ...g })) || [];
        await jest.advanceTimersByTimeAsync(2500); // TEAMS_ANNOUNCED
        expect(g.game.drawIDs).toHaveLength(4);
        expect(new Set(g.game.drawIDs).size).toBe(4);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(pending);

        expect(events(log, 'positionUpdate')).toHaveLength(1);
        expect(events(log, 'teamsAnnounced')).toHaveLength(1);
        expect(g.game.players.size).toBe(4);
        expect(g.game.stage).toBe(Phase.BIDDING);
        // One gameStart per seated human socket
        const seatedHumans = Object.values(g.game.positions).filter((sid) => !g.game.isBot(sid));
        for (const sid of seatedHumans) {
            expect(events(log, 'gameStart').filter((l) => l.to === sid)).toHaveLength(1);
        }
        return { log, ...g };
    }

    test('/leave twice', async () => {
        await expectSingleResolution(({ io, sockets }) => {
            chatHandlers.chatMessage(sockets[0], io, { message: '/leave' });
            chatHandlers.chatMessage(sockets[0], io, { message: '/leave' });
            return [1, 2, 3].map((i) => gameHandlers.draw(sockets[i], io, { num: 0 }));
        });
    });

    test('/leave then disconnect', async () => {
        await expectSingleResolution(async ({ io, sockets }) => {
            chatHandlers.chatMessage(sockets[0], io, { message: '/leave' });
            await queueHandlers.handleDisconnect(sockets[0], io);
            return [1, 2, 3].map((i) => gameHandlers.draw(sockets[i], io, { num: 0 }));
        });
    });

    test('/leave after drawing, during DRAW_RESOLVING', async () => {
        const { game, ids } = await expectSingleResolution(({ io, sockets, game }) => {
            const pending = sockets.map((s) => gameHandlers.draw(s, io, { num: 0 }));
            expect(game.stage).toBe(Phase.DRAW_RESOLVING);
            chatHandlers.chatMessage(sockets[0], io, { message: '/leave' });
            return pending;
        });
        expect(Object.values(game.resignedPlayers).map((r) => r.username)).toEqual([`user_${ids[0]}`]);
    });

    test('handleDrawComplete called twice', async () => {
        await expectSingleResolution(({ io, sockets, game }) => {
            const pending = sockets.map((s) => gameHandlers.draw(s, io, { num: 0 }));
            pending.push(gameHandlers.handleDrawComplete(io, game));
            pending.push(gameHandlers.handleDrawComplete(io, game));
            return pending;
        });
    });

    test('a 4th-card /leave racing a bot draw', async () => {
        const { io, log } = newIo();
        const { game, sockets, bots } = drawingGame('r', { humans: 3, io });
        const pending = [0, 1].map((i) => gameHandlers.draw(sockets[i], io, { num: 0 }));
        botController.scheduleBotDraw(io, game, bots[0].socketId, 1);
        await advanceUntil(() => game.drawIndex === 3, 50);
        chatHandlers.chatMessage(sockets[2], io, { message: '/leave' }); // supplies the 4th card
        await gameHandlers.draw(makeSocket(bots[0].socketId, log), io, { num: 0 }); // duplicate bot draw
        await jest.advanceTimersByTimeAsync(8000);
        await Promise.all(pending);

        expect(events(log, 'positionUpdate')).toHaveLength(1);
        expect(events(log, 'teamsAnnounced')).toHaveLength(1);
        expect(game.players.size).toBe(4);
        expect(game.stage).toBe(Phase.BIDDING);
    });

    test('a human double draw', async () => {
        await expectSingleResolution(({ io, sockets, log }) => {
            const pending = [gameHandlers.draw(sockets[0], io, { num: 0 }), gameHandlers.draw(sockets[0], io, { num: 1 })];
            expect(events(log, 'youDrew')).toHaveLength(1);
            return pending.concat([1, 2, 3].map((i) => gameHandlers.draw(sockets[i], io, { num: 0 })));
        });
    });

    test('a draw during the profile-pic lookups', async () => {
        const gate = deferred();
        mockProfile.getUserProfilePic = async () => { await gate.promise; return 9; };
        await expectSingleResolution(({ io, sockets, game, log }) => {
            const pending = sockets.map((s) => gameHandlers.draw(s, io, { num: 0 }));
            pending.push(gameHandlers.draw(sockets[1], io, { num: 0 }));
            pending.push(gameHandlers.draw(makeSocket('stranger', log), io, { num: 0 }));
            expect(game.drawIDs).toHaveLength(4);
            gate.resolve();
            return pending;
        });
    });
});

describe('12. departures during the lobby countdown (CREATED)', () => {
    /** A lobby of `humans` humans + bots, readied; resolves inside the 2s pre-draw pause. */
    async function countdown(humans) {
        const { io, log } = newIo();
        seq++;
        const ids = Array.from({ length: humans }, (_, i) => `c${seq}-h${i + 1}`);
        registerHumans(ids);
        const sockets = ids.map((id) => makeSocket(id, log, io));
        const lobby = gameManager.createLobby(ids);
        for (let i = humans; i < 4; i++) gameManager.addBotToLobby(lobby.id);
        const ready = sockets.map((s) => lobbyHandlers.playerReady(s, io));
        await jest.advanceTimersByTimeAsync(1500 + 500);
        const game = gameManager.getPlayerGame(ids[0]);
        expect(game.stage).toBe(Phase.CREATED);
        return { io, log, ids, sockets, game, ready };
    }
    const nullPositionEvents = (log) => log.filter((l) => l.data && 'position' in l.data && l.data.position == null &&
        ['playerDisconnected', 'playerReconnected', 'resignationAvailable'].includes(l.event));

    test('a disconnect auto-draws when the draw opens and the seat waits for a reconnect', async () => {
        const { io, log, ids, sockets, game } = await countdown(4);
        await queueHandlers.handleDisconnect(sockets[0], io);
        expect(nullPositionEvents(log)).toEqual([]);
        expect(events(log, 'playerDisconnected')).toHaveLength(0);

        await jest.advanceTimersByTimeAsync(1600); // beginDraw
        expect(events(log, 'startDraw')).toHaveLength(1);
        expect(events(log, 'playerDrew').map((l) => l.data.socketId)).toEqual([ids[0]]);
        const pending = [1, 2, 3].map((i) => gameHandlers.draw(sockets[i], io, { num: 0 }));
        await advanceUntil(() => game.stage === Phase.BIDDING, 50);
        await jest.advanceTimersByTimeAsync(1000);
        await Promise.all(pending);

        const pos = game.getPositionBySocketId(ids[0]);
        expect(pos).toBeTruthy();
        expect(game.isPlayerDisconnected(pos)).toBe(true);
        expect(events(log, 'playerDisconnected').map((l) => l.data.position)).toEqual([pos]);
        expect(game.hasTimer('reconnectGrace')).toBe(true);
        expect(nullPositionEvents(log)).toEqual([]);
    });

    test('a /leave is acknowledged, auto-draws at the draw and the seat goes to a bot', async () => {
        const { io, log, ids, sockets, game } = await countdown(4);
        chatHandlers.chatMessage(sockets[0], io, { message: '/leave' });
        expect(log.some((l) => l.to === `self:${ids[0]}` && l.event === 'leftGame')).toBe(true);
        expect(gameManager.playerGames.has(ids[0])).toBe(false);

        await jest.advanceTimersByTimeAsync(1600);
        const pending = [1, 2, 3].map((i) => gameHandlers.draw(sockets[i], io, { num: 0 }));
        await advanceUntil(() => game.stage === Phase.BIDDING, 50);
        await jest.advanceTimersByTimeAsync(1000);
        await Promise.all(pending);

        expect(Object.values(game.resignedPlayers).map((r) => r.username)).toEqual([`user_${ids[0]}`]);
        const seat = Object.keys(game.resignedPlayers).map(Number)[0];
        expect(game.getPlayerByPosition(seat).isBot).toBe(true);
        expect(log.some((l) => l.to === ids[0] && l.event === 'playerAssigned')).toBe(false);
        expect(nullPositionEvents(log)).toEqual([]);
    });

    test('if every human left during the countdown the game aborts exactly once', async () => {
        const { io, log, sockets, game, ready } = await countdown(1);
        chatHandlers.chatMessage(sockets[0], io, { message: '/leave' });
        await jest.advanceTimersByTimeAsync(20000);
        await Promise.all(ready);

        expect(events(log, 'abortGame')).toHaveLength(1);
        expect(game.stage).toBe(Phase.ABORTED);
        expect(gameManager.getGameById(game.gameId)).toBeNull();
        expect(Array.from(gameManager.playerGames.values())).not.toContain(game.gameId);
    });

    test('a second /leave or a disconnect after /leave changes nothing', async () => {
        const { io, log, ids, sockets, game } = await countdown(4);
        chatHandlers.chatMessage(sockets[0], io, { message: '/leave' });
        chatHandlers.chatMessage(sockets[0], io, { message: '/leave' });
        await queueHandlers.handleDisconnect(sockets[0], io);
        expect(events(log, 'leftGame')).toHaveLength(1);
        expect(game._drawPhaseDisconnects[ids[0]].left).toBe(true);
    });
});

describe('13. leavers and watchers', () => {
    test("a /leave'd lazy player gets no gameStart for the next hand", async () => {
        const { io, log } = newIo();
        const { game, ids, sockets } = seatedGame('q', io);
        toPlaying(game);
        chatHandlers.chatMessage(sockets[0], io, { message: '/leave' }); // lazy bot plays seat 1
        const pending = [];
        await advanceUntil(() => game.currentTurn === 2, 100);
        for (let i = 1; i < 4; i++) {
            pending.push(gameHandlers.playCard(sockets[i], io, { card: game.getHand(ids[i])[0] }));
        }
        await advanceUntil(() => game.stage === Phase.BIDDING && game.currentHand === 3, 100);
        await Promise.all(pending);

        const starts = events(log, 'gameStart');
        expect(starts.some((l) => l.to === ids[0])).toBe(false);
        for (const id of ids.slice(1)) expect(starts.filter((l) => l.to === id)).toHaveLength(1);
    });

    function lazyShadow(io, log) {
        const g = seatedGame('o', io);
        g.game.forcePhase(Phase.BIDDING);
        g.game.currentTurn = 2;
        chatHandlers.chatMessage(g.sockets[0], io, { message: '/lazy' });
        const shadow = makeSocket(`${g.ids[0]}-again`, log, io);
        gameManager.registerUser(shadow.id, `user_${g.ids[0]}`);
        return { ...g, shadow };
    }

    test('a rejoin shadow that disconnects is dropped without a position:null event', async () => {
        const { io, log } = newIo();
        const { game, shadow } = lazyShadow(io, log);
        await reconnectHandlers.rejoinGame(shadow, io, { gameId: game.gameId, username: `user_${shadow.id.replace('-again', '')}` });
        expect(game.isSpectator(shadow.id)).toBe(true);

        await queueHandlers.handleDisconnect(shadow, io);

        expect(events(log, 'playerDisconnected')).toHaveLength(0);
        expect(game.isSpectator(shadow.id)).toBe(false);
        expect(gameManager.playerGames.has(shadow.id)).toBe(false);
        expect(game.hasTimer('reconnectGrace')).toBe(false);
    });

    test('a rejoin shadow that /leaves is unmapped and can queue again', async () => {
        const { io, log } = newIo();
        const { game, shadow } = lazyShadow(io, log);
        await reconnectHandlers.rejoinGame(shadow, io, { gameId: game.gameId, username: `user_${shadow.id.replace('-again', '')}` });

        chatHandlers.chatMessage(shadow, io, { message: '/leave' });

        expect(log.some((l) => l.to === `self:${shadow.id}` && l.event === 'leftGame')).toBe(true);
        expect(gameManager.playerGames.has(shadow.id)).toBe(false);
        expect(io.rooms.get(game.roomName).has(shadow.id)).toBe(false);
        expect(gameManager.joinQueue(shadow.id).success).toBe(true);
        gameManager.leaveLobby(shadow.id);
    });
});

describe('14. redeal', () => {
    test('all-zero bids redeal in place: no doneBidding, destroyHands before gameStart, back in BIDDING', async () => {
        const { io, log } = newIo();
        const { game, ids, sockets } = seatedGame('z', io);
        game.forcePhase(Phase.BIDDING);
        game.currentTurn = 1;
        for (const s of sockets) await gameHandlers.playerBid(s, io, { bid: '0' });

        const names = log.map((l) => l.event);
        expect(names).not.toContain('doneBidding');
        expect(names.indexOf('destroyHands')).toBeGreaterThan(-1);
        expect(names.indexOf('gameStart')).toBeGreaterThan(names.indexOf('destroyHands'));
        expect(game.stage).toBe(Phase.BIDDING);
        expect(game.bidding).toBe(true);
        expect(game.playerBids).toEqual([]);
        expect(events(log, 'gameStart').filter((l) => ids.includes(l.to))).toHaveLength(4);
    });
});

describe('15. abandoned tables abort instead of waiting forever (found by the chaos run)', () => {
    /** Seat 1 disconnects and its grace period runs out while seat 2 is still here. */
    async function expiredGrace() {
        const { io, log } = newIo();
        const g = seatedGame('a', io);
        g.game.forcePhase(Phase.BIDDING);
        g.game.currentTurn = 1;
        for (const i of [2, 3]) {
            const bot = botController.createBot(`🤖 R${i}`, 'mary');
            g.game.resignPlayer(i + 1, bot.socketId, bot.username, 1);
            botController.registerBot(g.game.gameId, bot);
        }
        io.sockets.sockets.delete(g.ids[0]);
        await queueHandlers.handleDisconnect(g.sockets[0], io);
        await jest.advanceTimersByTimeAsync(60000);
        expect(events(log, 'resignationAvailable')).toHaveLength(1);
        expect(gameManager.getGameById(g.game.gameId)).toBe(g.game);
        return { io, log, ...g };
    }

    test('the last present human /leaving re-arms the grace period, which then aborts', async () => {
        const { io, log, game, sockets } = await expiredGrace();
        chatHandlers.chatMessage(sockets[1], io, { message: '/leave' });
        expect(game.hasTimer('reconnectGrace')).toBe(true);
        await jest.advanceTimersByTimeAsync(60000);
        expect(events(log, 'abortGame')).toHaveLength(1);
        expect(game.stage).toBe(Phase.ABORTED);
    });

    test('a lazy human whose socket is gone does not count as present at grace expiry', async () => {
        const { io, log } = newIo();
        const { game, ids, sockets } = seatedGame('a', io);
        game.forcePhase(Phase.BIDDING);
        game.currentTurn = 1;
        chatHandlers.chatMessage(sockets[1], io, { message: '/lazy' });
        for (const i of [2, 3]) {
            const bot = botController.createBot(`🤖 R${i}`, 'mary');
            game.resignPlayer(i + 1, bot.socketId, bot.username, 1);
            botController.registerBot(game.gameId, bot);
        }
        io.sockets.sockets.delete(ids[1]);
        await queueHandlers.handleDisconnect(sockets[1], io); // lazy: bot keeps playing, no grace
        io.sockets.sockets.delete(ids[0]);
        await queueHandlers.handleDisconnect(sockets[0], io);
        await jest.advanceTimersByTimeAsync(60000);

        expect(events(log, 'resignationAvailable')).toHaveLength(0);
        expect(events(log, 'abortGame')).toHaveLength(1);
    });

    test("a rejoin shadow's /leave is a permanent leave for its seat", async () => {
        const { io, log, game, ids, sockets } = await expiredGrace();
        chatHandlers.chatMessage(sockets[1], io, { message: '/lazy' });
        const shadow = makeSocket(`${ids[1]}-again`, log, io);
        gameManager.registerUser(shadow.id, `user_${ids[1]}`);
        await reconnectHandlers.rejoinGame(shadow, io, { gameId: game.gameId, username: `user_${ids[1]}` });
        expect(game.isSpectator(shadow.id)).toBe(true);

        chatHandlers.chatMessage(shadow, io, { message: '/leave' });

        expect(game.lazyPlayers[2].permanentLeave).toBe(true);
        expect(game.hasTimer('reconnectGrace')).toBe(true);
        await jest.advanceTimersByTimeAsync(60000);
        expect(events(log, 'abortGame')).toHaveLength(1);
    });

    test('a rejoin shadow disconnecting as the last present human re-arms the grace period', async () => {
        const { io, log, game, ids, sockets } = await expiredGrace();
        chatHandlers.chatMessage(sockets[1], io, { message: '/lazy' });
        const shadow = makeSocket(`${ids[1]}-again`, log, io);
        gameManager.registerUser(shadow.id, `user_${ids[1]}`);
        await reconnectHandlers.rejoinGame(shadow, io, { gameId: game.gameId, username: `user_${ids[1]}` });
        io.sockets.sockets.delete(ids[1]); // the lazy seat's original socket is gone too
        io.sockets.sockets.delete(shadow.id);

        await queueHandlers.handleDisconnect(shadow, io);

        expect(game.hasTimer('reconnectGrace')).toBe(true);
        await jest.advanceTimersByTimeAsync(60000);
        expect(events(log, 'abortGame')).toHaveLength(1);
    });
});

describe('a real hand runs to the next deal under the FSM', () => {
    test('stages and invariants hold through a full hand', async () => {
        const { io, log } = newIo();
        const { game, ids, sockets } = drawingGame('h', { io });
        const pending = drawAll(io, game, sockets, [], log);
        await advanceUntil(() => game.stage === Phase.BIDDING, 50);
        const sock = (pos) => sockets[ids.indexOf(game.positions[pos])];
        for (let i = 0; i < 4; i++) await gameHandlers.playerBid(sock(game.currentTurn), io, { bid: '1' });
        while (game.currentHand === 12) {
            if (game.stage === Phase.PLAYING) {
                const s = sock(game.currentTurn);
                pending.push(gameHandlers.playCard(s, io, { card: legalCards(game, s.id)[0] }));
                await Promise.resolve();
            } else {
                await jest.advanceTimersByTimeAsync(250);
            }
        }
        await Promise.all(pending);
        expect(game.stage).toBe(Phase.BIDDING);
        expect(events(log, 'handComplete')).toHaveLength(1);
        expect(game.validateGameState()).toEqual({ valid: true, errors: [] });
    });
});
