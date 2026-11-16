/**
 * Fork test (deploy survival, PR 3): a game restored from its doc plays on
 * exactly as the original would have. For each seed, game A is played to
 * its end; at 8 fork points the codec doc and the RNG state are taken (at
 * a safe point, where the store serializes). Then, for each fork point, a
 * fresh "process" (GameManager and BotController reset, a new database)
 * adopts the doc (testUtils/restoreKit: hydrate, bots under their saved ids
 * with their partner history and card memory), the human rejoins through
 * the real rejoinGame, the RNG state is put back and the restore kick runs.
 * Game B must then make the same bot decisions (draw / bid / card, in
 * order), reach the same score, rainbows, hand stats, player stats and
 * last trickHistory, and insert the same gameRecords document.
 *
 * Fork points: the first hand's firstTurn hold, mid-bid, the opening lead,
 * 2 cards down, the 4th card down (TRICK_RESOLVING), HAND_RESOLVING before
 * the last hand, HAND_RESOLVING after the 13th, and the first BIDDING after
 * an all-zero redeal (every seat bids 0 on the first deal, so each seed
 * has one).
 *
 * Determinism: bot think times are fixed (persistHarness.fixedBotDelays:
 * no Math.random), bot chat is off, and the one human plays by a fixed
 * rule (smallest legal bid by deal, first legal card). What is left on the
 * RNG stream is the deal (Deck.shuffle on a seeded Math.random), the bots'
 * own decisions (BotStrategy, BotPlayer.decideDraw) and seat bot picks.
 * Seeds alternate one human with a second human who leaves during the draw
 * (a resignBot/gone seat); Zach (who reads partnerHistory) sits at most
 * tables.
 *
 * PERSIST_FORK_SEEDS=<n> overrides the number of seeds (default 10).
 */

const { createMemoryDb } = require('../../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../GameManager');
const BotPlayer = require('../../bot/BotPlayer');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const gameHandlers = require('../../../socket/gameHandlers');
const gameLifecycle = require('../../../socket/gameLifecycle');
const chatHandlers = require('../../../socket/chatHandlers');
const reconnectHandlers = require('../../../socket/reconnectHandlers');
const profileHandlers = require('../../../socket/profileHandlers');
const { makeIo, makeSocket, legalCards, legalBids } = require('../../../testUtils/gameDriver');
const { makeRng, fixedBotDelays, silenceBotChat, decisionLog } = require('../../../testUtils/persistHarness');
const { watchSafePoints, adoptForTest, kickRestored } = require('../../../testUtils/restoreKit');
const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');
const codec = require('../gameCodec');

const SEEDS = Number(process.env.PERSIST_FORK_SEEDS) || 10;
const STEP_MS = 500;
const MAX_STEPS = 4000;

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
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        for (const m of ['warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const json = (v) => JSON.parse(JSON.stringify(v));

/** [name, predicate(game), nth occurrence] */
function forkPoints(seed) {
    const k = 1 + (seed % 3);
    const bidsIn = (g) => g.playerBids.filter((b) => b != null).length;
    return [
        ['firstTurn hold', (g) => g.stage === Phase.BIDDING && g.resume?.kind === 'firstTurn', 1],
        ['mid-bid', (g) => g.stage === Phase.BIDDING && g.dealSeq >= 3 && bidsIn(g) >= 1 && bidsIn(g) <= 3, k],
        ['opening lead', (g) => g.stage === Phase.PLAYING && g.dealSeq >= 3 && g.cardIndex === 0, k],
        ['2 cards down', (g) => g.stage === Phase.PLAYING && g.dealSeq >= 3 && g.playedCardsIndex === 2, k],
        ['4th card down', (g) => g.stage === Phase.TRICK_RESOLVING && g.dealSeq >= 3, k],
        ['HAND_RESOLVING, not the last hand', (g) => g.stage === Phase.HAND_RESOLVING && g.dealSeq >= 3 && g.currentHand !== 13, k],
        ['HAND_RESOLVING, the 13th', (g) => g.stage === Phase.HAND_RESOLVING && g.currentHand === 13, 1],
        ['first BIDDING after an all-zero redeal', (g) => g.stage === Phase.BIDDING && g.dealSeq === 2 && bidsIn(g) === 0, 1],
    ];
}

/** Every seat bids 0 on the first deal (the redeal fork point); otherwise the real bid. */
function zeroFirstDeal() {
    const real = BotPlayer.prototype.decideBid;
    BotPlayer.prototype.decideBid = function (...args) {
        if (gameManager.getGameById(this.gameId)?.dealSeq === 1) return '0';
        return real.apply(this, args);
    };
    return () => { BotPlayer.prototype.decideBid = real; };
}

/** The one human's fixed rule, when it is on turn and seated. */
function driveHuman(io, game, socket) {
    const pos = game.seatByOwnerSocket(socket.id);
    if (!pos || game.currentTurn !== pos || game.seat(pos).controller !== 'human') return null;
    if (game.stage === Phase.BIDDING) {
        let bid = '0';
        if (game.dealSeq !== 1) {
            const numeric = legalBids(game).filter((b) => /^\d+$/.test(b)).map(Number).sort((a, b) => a - b);
            bid = String(numeric[game.dealSeq % Math.min(3, numeric.length)]);
        }
        return gameHandlers.playerBid(socket, io, { bid });
    }
    if (game.stage === Phase.PLAYING) {
        const cards = legalCards(game, socket.id);
        if (cards.length) return gameHandlers.playCard(socket, io, { card: cards[0] });
    }
    return null;
}

async function playToEnd(io, gameId, socket) {
    for (let i = 0; i < MAX_STEPS; i++) {
        await jest.advanceTimersByTimeAsync(STEP_MS);
        const game = gameManager.getGameById(gameId);
        if (!game) return;
        track(driveHuman(io, game, socket));
    }
    throw new Error(`game ${gameId} did not end`);
}

function freshProcess(users) {
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const u of users) mockDb.current.users._insert({ ...u });
}

function outcome(game) {
    const record = mockDb.current.gameRecords.docs.find((d) => d.gameId === game.gameId) || null;
    const stored = record ? json(record) : null;
    if (stored) {
        delete stored._id;
        delete stored.completedAt;
    }
    return {
        stage: game.stage,
        score: json(game.score),
        rainbows: json(game.rainbows),
        handStats: json(game.handStats),
        playerStats: json(game.playerStats),
        trickHistory: json(game.trickHistory),
        record: stored,
    };
}

/** Game A: the whole game, with every fork point captured. */
async function runOriginal(seed) {
    const twoHumans = seed % 2 === 0;
    const users = [{ username: `f${seed}_h`, profilePic: 5 }];
    if (twoHumans) users.push({ username: `f${seed}_q`, profilePic: 6 });
    freshProcess(users);
    const log = [];
    const io = makeIo(log);
    const hSock = makeSocket(`f${seed}-h`, log, io);
    gameManager.registerUser(hSock.id, users[0].username);
    const qSock = twoHumans ? makeSocket(`f${seed}-q`, log, io) : null;
    if (qSock) gameManager.registerUser(qSock.id, users[1].username);

    const personalities = ['zach', 'mary', 'danny', 'sharon', 'mike'];
    const nBots = 4 - users.length;
    const bots = Array.from({ length: nBots }, (_, i) => {
        const p = personalities[(seed + i) % personalities.length];
        return botController.createBot(`🤖 ${p[0].toUpperCase()}${p.slice(1)}`, p);
    });
    const sids = [hSock.id, ...(qSock ? [qSock.id] : []), ...bots.map((b) => b.socketId)];
    const game = gameManager.createGame(sids);
    bots.forEach((b) => botController.registerBot(game.gameId, b));
    hSock.join(game.roomName);
    if (qSock) qSock.join(game.roomName);
    gameLifecycle.beginDraw(io, game);
    if (qSock) chatHandlers.chatMessage(qSock, io, { message: '/leave' });
    // The human draws last, so its seat is the last in the players index
    // (a deal hands out cards in that order), where its rejoin on game B
    // puts it again
    for (let i = 0; i < 100 && game.drawIDs.length < 3; i++) await jest.advanceTimersByTimeAsync(100);
    // (not awaited: the 4th draw runs the seating, which waits on timers)
    track(gameHandlers.draw(hSock, io, { num: 3 }));

    const points = forkPoints(seed);
    const counts = new Array(points.length).fill(0);
    const forks = new Array(points.length).fill(null);
    const watch = watchSafePoints((g) => {
        if (g !== game || gameManager.getGameById(g.gameId) !== g) return;
        points.forEach(([name, pred, nth], i) => {
            if (forks[i] || !pred(g)) return;
            counts[i]++;
            if (counts[i] < nth) return;
            const doc = codec.serialize(g);
            if (!doc) throw new Error(`fork ${name}: no doc (${codec.refusal(g)})`);
            forks[i] = { name, doc: json(doc), rng: rng.getState(), decision: decisions.entries.length };
        });
    });
    try {
        await playToEnd(io, game.gameId, hSock);
        await jest.advanceTimersByTimeAsync(5000); // the stats writes
    } finally {
        watch.stop();
    }
    expect(game.stage).toBe(Phase.ENDED);
    return { users, forks, result: outcome(game), username: users[0].username };
}

/** Game B: a new process adopts the doc at fork `f` and plays it out. */
async function runFork(users, username, f) {
    freshProcess(users);
    const log = [];
    const io = makeIo(log);
    const game = adoptForTest(f.doc, { io });
    expect(game.stage).toBe(f.doc.stage);
    const sock = makeSocket(`${username}-back`, log, io);
    gameManager.registerUser(sock.id, username);
    await reconnectHandlers.rejoinGame(sock, io, { gameId: game.gameId, username });
    expect(game.seat(game.seatByUsername(username)).ownerSocketId).toBe(sock.id);
    const first = decisions.entries.length;
    rng.setState(f.rng);
    kickRestored(io, game);
    await playToEnd(io, game.gameId, sock);
    await jest.advanceTimersByTimeAsync(5000);
    return { result: outcome(game), decisions: decisions.entries.slice(first) };
}

let rng;
let decisions;
let asyncErrors = [];
/** A handler's promise, not awaited (it may wait on timers): its rejection is a failure. */
const track = (p) => {
    if (p && typeof p.then === 'function') p.catch((err) => asyncErrors.push(err));
    return p;
};

describe('a restored game plays on exactly as the original', () => {
    test(`${SEEDS} seeds x 8 fork points`, async () => {
        profileHandlers._setStatsRetryDelaysForTests([1, 1]);
        const failures = [];
        for (let seed = 1; seed <= SEEDS && failures.length < 30; seed++) {
            fixedBotDelays(1000);
            silenceBotChat();
            const unstub = zeroFirstDeal();
            decisions = decisionLog();
            rng = makeRng(seed * 7919);
            const uninstall = rng.install();
            try {
                const original = await runOriginal(seed);
                const missing = original.forks.map((f, i) => (f ? null : forkPoints(seed)[i][0])).filter(Boolean);
                if (missing.length) {
                    failures.push({ seed, why: 'fork point never reached', missing });
                    continue;
                }
                const decisionsA = decisions.entries.slice();
                for (const f of original.forks) {
                    const fork = await runFork(original.users, original.username, f);
                    const want = { decisions: decisionsA.slice(f.decision), ...original.result };
                    const got = { decisions: fork.decisions, ...fork.result };
                    try {
                        expect(got).toEqual(want);
                    } catch (err) {
                        const a = want.decisions;
                        const b = got.decisions;
                        let at = 0;
                        while (at < Math.max(a.length, b.length) && JSON.stringify(a[at]) === JSON.stringify(b[at])) at++;
                        failures.push({
                            seed, fork: f.name, stage: f.doc.stage,
                            firstDecisionDiff: at < Math.max(a.length, b.length) ? { at, of: [a.length, b.length], want: a[at], got: b[at] } : null,
                            diff: at < Math.max(a.length, b.length) ? undefined : err.message.slice(0, 1500),
                        });
                    }
                }
                expect(original.result.record).not.toBeNull();
            } finally {
                uninstall();
                decisions.stop();
                unstub();
                jest.restoreAllMocks();
                for (const l of [gameLogger, socketLogger, authLogger, logger]) {
                    jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
                    for (const m of ['warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
                }
                jest.spyOn(console, 'log').mockImplementation(() => {});
            }
        }
        profileHandlers._setStatsRetryDelaysForTests();
        expect(asyncErrors).toEqual([]);
        expect(failures).toEqual([]);
        expect(errorLogs).toEqual([]);
    }, 600000);
});
