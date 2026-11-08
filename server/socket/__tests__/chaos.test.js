/**
 * Chaos run over the real handlers: seeded random humans (draws, valid and
 * garbage bids/plays, /lazy /active /leave, disconnects, fresh-socket
 * rejoins, forceResign, spectators, aborts) against a table of humans and
 * bots, with BAB_FSM_CHECK=1 so every transition validates the stage
 * invariants. After every step the game must be consistent and live; once
 * it ends or aborts nothing may be emitted into it and nothing may be left
 * behind. Failures print the seed and the stage history.
 *
 * CHAOS_SEEDS=<n> overrides the number of seeds (default 200).
 *
 * Also runs complete ambient bot games under CHECK mode and matches their
 * full stage history.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const gameLifecycle = require('../gameLifecycle');
const ambient = require('../../demo/ambientBots');
const GamePhase = require('../../game/GamePhase');
const { botController } = require('../../game/bot');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { makeIo, makeSocket, events, legalCards, legalBids, mulberry32 } = require('../../testUtils/gameDriver');

const { Phase } = GamePhase;
const SEEDS = Number(process.env.CHAOS_SEEDS) || 200;
const MAX_STEPS = 400;

const GAME_EVENTS = new Set([
    'startDraw', 'playerDrew', 'youDrew', 'playerAssigned', 'positionUpdate', 'teamsAnnounced', 'createUI',
    'gameStart', 'updateTurn', 'bidReceived', 'doneBidding', 'rainbow', 'destroyHands', 'cardPlayed',
    'trickComplete', 'handComplete', 'gameEnd', 'abortGame', 'chatMessage', 'gameLogEntry',
    'playerDisconnected', 'playerReconnected', 'resignationAvailable', 'playerLazyMode', 'playerActiveMode',
    'playerResigned', 'spectatorJoined', 'restorePlayerState', 'rejoinSuccess',
]);

// gameLogger/socketLogger errors a chaos run may legitimately produce
const ERROR_WHITELIST = [];

let errorLogs;
let realRandom;

beforeAll(() => {
    process.env.BAB_FSM_CHECK = '1';
    realRandom = Math.random;
});

afterAll(() => {
    delete process.env.BAB_FSM_CHECK;
    Math.random = realRandom;
});

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        jest.spyOn(l, 'warn').mockImplementation(() => {});
        jest.spyOn(l, 'info').mockImplementation(() => {});
        jest.spyOn(l, 'debug').mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

function botPending(gameId) {
    for (const key of botController.pendingActions.keys()) {
        if (key.startsWith(`${gameId}:`) && !key.includes(':chat:')) return true;
    }
    return false;
}

/** One chaos run. Returns a failure description, or null. */
async function runSeed(seed) {
    errorLogs.length = 0;
    GamePhase.resetViolations();
    const rand = mulberry32(seed);
    Math.random = rand;
    const pick = (arr) => (arr.length ? arr[Math.floor(rand() * arr.length)] : undefined);
    const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

    const log = [];
    const io = makeIo(log);
    const asyncErrors = [];
    const track = (p) => {
        if (p && typeof p.then === 'function') p.catch((err) => asyncErrors.push(err));
    };

    // Humans: { username, sid, connected }
    const nHumans = randInt(2, 4);
    const humans = [];
    const allSockets = new Set();
    const sockets = new Map();
    const newSocket = (id) => {
        const s = makeSocket(id, log, io);
        sockets.set(id, s);
        allSockets.add(id);
        return s;
    };
    for (let i = 0; i < nHumans; i++) {
        const username = `s${seed}_u${i}`;
        const sid = `s${seed}-h${i}`;
        gameManager.registerUser(sid, username);
        mockDb.current.users._insert({ username, profilePic: (i % 80) + 1 });
        newSocket(sid);
        humans.push({ username, sid, connected: true });
    }
    const bots = Array.from({ length: 4 - nHumans }, (_, i) => botController.createBot(`🤖 C${i}`, 'mary'));
    const game = gameManager.createGame([...humans.map((h) => h.sid), ...bots.map((b) => b.socketId)]);
    const gameId = game.gameId;
    bots.forEach((b) => botController.registerBot(gameId, b));
    humans.forEach((h) => sockets.get(h.sid).join(game.roomName));
    gameLifecycle.beginDraw(io, game);

    let rejoinSeq = 0;
    let specSeq = 0;
    const connectedHumans = () => humans.filter((h) => h.connected);
    const isConnectedSid = (sid) => humans.some((h) => h.connected && h.sid === sid);

    const actions = [
        [6, function draw() {
            const h = pick(connectedHumans()); if (!h) return;
            track(gameHandlers.draw(sockets.get(h.sid), io, { num: randInt(-3, 60) }));
        }],
        [12, function validBid() {
            if (game.stage !== Phase.BIDDING) return;
            const sid = game.positions[game.currentTurn];
            if (!isConnectedSid(sid)) return;
            track(gameHandlers.playerBid(sockets.get(sid), io, { bid: pick(legalBids(game)) }));
        }],
        [2, function randomBid() {
            const h = pick(connectedHumans()); if (!h) return;
            track(gameHandlers.playerBid(sockets.get(h.sid), io, { bid: pick(['0', '1', '3', '7', '13', 'B', '2B', 'X', 99]) }));
        }],
        [20, function legalPlay() {
            if (game.stage !== Phase.PLAYING) return;
            const sid = game.positions[game.currentTurn];
            if (!isConnectedSid(sid)) return;
            const cards = legalCards(game, sid);
            if (!cards.length) return;
            track(gameHandlers.playCard(sockets.get(sid), io, { card: pick(cards) }));
        }],
        [2, function randomPlay() {
            const h = pick(connectedHumans()); if (!h) return;
            const hand = game.getHand(h.sid);
            const card = hand.length && rand() < 0.7 ? pick(hand) : { suit: pick(['hearts', 'spades']), rank: pick(['2', 'K', 'HI']) };
            track(gameHandlers.playCard(sockets.get(h.sid), io, { card }));
        }],
        [1.5, function slash() {
            const h = pick(connectedHumans()); if (!h) return;
            const m = pick(['/lazy', '/active', '/active', '/leave', 'hi']); note = m + ' ' + h.sid;
            chatHandlers.chatMessage(sockets.get(h.sid), io, { message: m });
        }],
        [0.6, function disconnect() {
            const live = connectedHumans();
            if (!live.length) return;
            const h = pick(live);
            h.connected = false; note = 'dc ' + h.sid;
            io.sockets.sockets.delete(h.sid);
            for (const members of io.rooms.values()) members.delete(h.sid);
            track(queueHandlers.handleDisconnect(sockets.get(h.sid), io));
        }],
        [3, function rejoin() {
            const h = pick(humans);
            rejoinSeq++;
            const sid = `${h.sid}-r${rejoinSeq}`; note = 'rejoin ' + sid;
            const s = newSocket(sid);
            gameManager.registerUser(sid, h.username);
            const before = log.length;
            const p = reconnectHandlers.rejoinGame(s, io, { gameId, username: h.username }).then(() => {
                if (log.slice(before).some((l) => l.to === `self:${sid}` && l.event === 'rejoinSuccess')) {
                    h.sid = sid;
                    h.connected = true;
                }
            });
            track(p);
        }],
        [2, function forceResign() {
            const h = pick(connectedHumans()); if (!h) return;
            const fp = randInt(1, 4); note = 'fr ' + h.sid + ' ' + fp; track(gameHandlers.forceResign(sockets.get(h.sid), io, { position: fp }));
        }],
        [1, function spectate() {
            specSeq++;
            const sid = `s${seed}-spec${specSeq}`;
            const s = newSocket(sid);
            gameManager.registerUser(sid, `s${seed}_spec${specSeq}`);
            mainRoomHandlers.joinAsSpectator(s, io, { gameId });
        }],
        [0.05, function abort() {
            track(gameLifecycle.abortGame(io, game, 'chaos'));
        }],
    ];
    let note = '';
    const totalWeight = actions.reduce((n, [w]) => n + w, 0);
    const act = async () => {
        let r = rand() * totalWeight;
        for (const [w, fn] of actions) {
            r -= w;
            if (r <= 0) {
                try { await fn(); } catch (err) { asyncErrors.push(err); }
                const n = note; note = ''; return fn.name + (n ? '(' + n + ')' : '') + '@' + game.stage;
            }
        }
        return null;
    };

    const fail = (why, extra = {}) => ({
        seed, why, stage: game.stage, history: (game._history || []).join(' '), ...extra,
    });

    const liveness = () => {
        if (game.pendingTimerCount > 0 || botPending(gameId)) return true;
        if (game.stage === Phase.BIDDING || game.stage === Phase.PLAYING) {
            const pos = game.currentTurn;
            const sid = game.positions[pos];
            if (sid && !game.isBot(sid) && !game.isLazy(pos)) {
                if (isConnectedSid(sid) && !game.isPlayerDisconnected(pos)) return true;
                // Seat on turn is disconnected and its grace period ran out:
                // the table waits for a connected human mapped to the game
                // (a seat can forceResign; a lazy rejoin shadow can /active
                // and then forceResign)
                if (game.isPlayerDisconnected(pos) &&
                    connectedHumans().some((h) => gameManager.playerGames.get(h.sid) === gameId &&
                        !game.isPlayerDisconnected(game.getPositionBySocketId(h.sid)))) {
                    return true;
                }
            }
        }
        if (game.stage === Phase.DRAWING) {
            if (connectedHumans().some((h) => gameManager.playerGames.get(h.sid) === gameId && !game.drawIDs.includes(h.sid))) return true;
        }
        return false;
    };

    let steps = 0;
    const trail = [];
    while (gameManager.getGameById(gameId) && steps < MAX_STEPS) {
        steps++;
        await jest.advanceTimersByTimeAsync(randInt(0, 2500));
        if (!gameManager.getGameById(gameId)) break;
        trail.push(await act());
        await jest.advanceTimersByTimeAsync(0);
        if (!gameManager.getGameById(gameId)) break;

        const { errors } = game.validateGameState();
        if (errors.length) return fail('invariant', { errors, trail: trail.slice(-15) });
        if (!liveness()) return fail('hang', { trail: trail.filter(t => !/^(draw|validBid|legalPlay|randomBid|randomPlay|spectate)/.test(t)), turn: game.currentTurn, positions: game.positions, humans, disconnected: game.disconnectedPlayers, lazy: game.lazyPlayers, resigned: game.resignedPlayers, spectators: [...game.spectators.keys()], timers: [...game._timers.keys()] });
        if (asyncErrors.length) return fail('async error', { error: asyncErrors[0].stack });
    }
    // Still running after the step budget: tear it down to check teardown
    if (gameManager.getGameById(gameId)) await gameLifecycle.abortGame(io, game, 'chaos-end');

    const terminalIdx = log.findIndex((l) => l.to === game.roomName && (l.event === 'gameEnd' || l.event === 'abortGame'));
    for (let i = 0; i < 30; i++) {
        await jest.advanceTimersByTimeAsync(randInt(0, 2500));
        await act();
    }
    await jest.advanceTimersByTimeAsync(120000);

    const roomEnds = log.filter((l) => l.to === game.roomName && (l.event === 'gameEnd' || l.event === 'abortGame'));
    if (roomEnds.length !== 1) return fail('terminal events', { events: roomEnds.map((l) => l.event) });
    if (terminalIdx < 0) return fail('no terminal event');
    const targets = new Set([game.roomName]);
    for (const id of allSockets) { targets.add(id); targets.add(`self:${id}`); }
    const dead = log.slice(terminalIdx + 1).filter((l) => GAME_EVENTS.has(l.event) && targets.has(l.to));
    if (dead.length) return fail('emit after terminal', { dead: dead.slice(0, 5).map((l) => `${l.to}:${l.event}`) });
    if (!game.isTerminal()) return fail('not terminal');
    if (Array.from(gameManager.playerGames.values()).includes(gameId)) return fail('playerGames leak');
    if (botController.gamesBots.has(gameId)) return fail('gamesBots leak');
    if (Array.from(botController.pendingActions.keys()).some((k) => k.startsWith(`${gameId}:`))) return fail('pendingActions leak');
    if (game.pendingTimerCount !== 0) return fail('timer leak', { pending: game.pendingTimerCount });
    const nullDc = events(log, 'playerDisconnected').filter((l) => l.data.position == null);
    if (nullDc.length) return fail('playerDisconnected position:null');
    if (asyncErrors.length) return fail('async error', { error: asyncErrors[0].stack });
    const errs = errorLogs.filter((e) => !ERROR_WHITELIST.some((w) => String(e.msg).includes(w)));
    if (errs.length) return fail('error logged', { errors: errs.slice(0, 3) });
    const violations = GamePhase.getViolations();
    if (violations.length) return fail('violation', { violations: violations.slice(0, 3).map(({ stack, ...v }) => v) });
    const reason = (log.find((l) => l.to === game.roomName && l.event === 'abortGame') || {}).data?.reason;
    if (process.env.CHAOS_STATS) process.stdout.write(`seed ${seed} steps ${steps} hands ${game.handStats.totalHands} ${game.stage} ${reason || ''}\n`);
    return { ok: true, hands: game.handStats.totalHands, steps };
}

describe('chaos', () => {
    test(`${SEEDS} seeded chaos runs keep the FSM consistent, live and leak-free`, async () => {
        const processErrors = [];
        const onError = (err) => processErrors.push(err);
        process.on('unhandledRejection', onError);
        process.on('uncaughtException', onError);
        try {
            const failures = [];
            let deep = 0;
            for (let seed = 1; seed <= SEEDS; seed++) {
                const result = await runSeed(seed);
                if (!result.ok) {
                    failures.push(result);
                    if (failures.length >= 3) break;
                } else if (result.hands >= 1) {
                    deep++;
                }
                for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
                GamePhase.resetViolations();
                jest.clearAllTimers();
            }
            if (failures.length) {
                throw new Error(`chaos failures:\n${failures.map((f) => JSON.stringify(f, null, 2)).join('\n')}`);
            }
            expect(processErrors).toEqual([]);
            // Coverage: a good share of runs get past the first hand
            if (SEEDS >= 20) expect(deep).toBeGreaterThanOrEqual(Math.floor(SEEDS / 4));
        } finally {
            process.off('unhandledRejection', onError);
            process.off('uncaughtException', onError);
        }
    }, 600000);
});

describe('full ambient bot games under CHECK mode', () => {
    const HISTORY = /^CREATED DRAWING DRAW_RESOLVING TEAMS_ANNOUNCED( DEALING BIDDING( REDEAL DEALING BIDDING)* PLAYING( TRICK_RESOLVING PLAYING)* TRICK_RESOLVING HAND_RESOLVING){13} ENDED$/;

    test.each([11, 22, 33])('seed %i plays 13 hands to one gameEnd', async (seed) => {
        Math.random = mulberry32(seed);
        const log = [];
        const io = makeIo(log);
        const game = ambient.startBotGame(io);
        for (let t = 0; t < 30 && gameManager.getGameById(game.gameId); t++) {
            await jest.advanceTimersByTimeAsync(60000);
        }
        ambient.stopAmbientActivity();

        expect(events(log, 'gameEnd')).toHaveLength(1);
        expect(events(log, 'abortGame')).toHaveLength(0);
        expect(game._history.join(' ')).toMatch(HISTORY);
        expect(game.handStats.totalHands).toBe(13);
        expect(game.pendingTimerCount).toBe(0);
        expect(gameManager.getGameById(game.gameId)).toBeNull();
        expect(GamePhase.getViolations()).toEqual([]);
        expect(errorLogs).toEqual([]);
    }, 60000);
});
