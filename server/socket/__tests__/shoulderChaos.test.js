/**
 * The over-the-shoulder view under chaos (server/testUtils/chaosEngine.js,
 * the chaos.test.js run with extra actions): seeded random humans,
 * spectators, an owner's other tabs, rejoins, /lazy /active /leave,
 * disconnects and aborts, plus random clientHello caps (with and without
 * shoulderView, assist and tutorial), random watchHand from ANY live socket
 * (owners, stale tabs, spectators, the dummy table's), /help and
 * /tutorial on from the seats. The live emit scan
 * (testUtils/shoulderCheck.js) checks every emit to every receiver:
 * no socket without the cap ever gets shoulder data; a watcher gets only
 * its watched seat's hand, HSI and hints; no seat owner gets another seat's
 * hand (and, with OWNER_HSI 'own', HSI); never at a tournament table nor
 * against the own-seat rule. After every emit no game.shoulders entry is
 * stale (a socket that is no longer a pure spectator of that game, or that
 * dropped the cap). Every chaos oracle still holds.
 *
 * SHOULDER_SEEDS=<n> overrides the number of seeds (default 60).
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const GamePhase = require('../../game/GamePhase');
const chatHandlers = require('../chatHandlers');
const clientInfo = require('../clientInfo');
const shoulderView = require('../shoulderView');
const rateLimiter = require('../rateLimiter');
const contractCheck = require('../../testUtils/contractCheck');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { runSeedInner } = require('../../testUtils/chaosEngine');
const { watchShoulders, shouldersInvariant } = require('../../testUtils/shoulderCheck');

const SEEDS = Number(process.env.SHOULDER_SEEDS) || 60;
// Seat owners' own HSI only: the HSI fix's rule (gameStart.hsiValues /
// snapshot hsi), on main since #362; SHOULDER_OWNER_HSI=any relaxes it
const OWNER_HSI = process.env.SHOULDER_OWNER_HSI || 'own';

let errorLogs;
let realRandom;

beforeAll(() => {
    process.env.BAB_FSM_CHECK = '1';
    realRandom = Math.random;
});
afterAll(() => {
    delete process.env.BAB_FSM_CHECK;
    Math.random = realRandom;
    rateLimiter.shutdown();
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

const CAP_SETS = [
    ['avatarUrl', 'shoulderView'],
    ['avatarUrl', 'shoulderView', 'assist', 'tutorial'],
    ['avatarUrl', 'assist', 'tutorial'],
    ['avatarUrl'],
];

/** The extra chaos actions: caps, watchHand from anyone, /help and /tutorial. */
function shoulderActions(ctx) {
    const live = () => [...ctx.sockets.values()].filter((s) => ctx.io.sockets.sockets.has(s.id));
    return [
        [1.5, function hello() {
            const s = ctx.pick(live()); if (!s) return;
            const caps = ctx.pick(CAP_SETS);
            ctx.setNote(`hello ${caps.join('+')} ${s.id}`);
            clientInfo.handle(s, ctx.io, { client: 'web', version: '1', caps });
        }],
        [3, function watchHand() {
            // Spectators most of the time, anyone else sometimes
            const specs = ctx.spectators.map((id) => ctx.sockets.get(id)).filter((s) => s && ctx.io.sockets.sockets.has(s.id));
            const s = ctx.rand() < 0.7 && specs.length ? ctx.pick(specs) : ctx.pick(live());
            if (!s) return;
            // the seat on turn half the time (its hints are the ones that come)
            const position = ctx.rand() < 0.5 && ctx.game.currentTurn ? ctx.game.currentTurn : ctx.pick([1, 2, 3, 4, 1, 2, 3, 4, null]);
            const gameId = ctx.rand() < 0.9 ? ctx.gameId : ctx.dummy.gameId;
            ctx.setNote(`watchHand ${position} ${s.id}`);
            rateLimiter.clearSocket(s.id);
            // most watchers run a client with the cap (the rest: refusals)
            if (ctx.rand() < 0.6) clientInfo.handle(s, ctx.io, { client: 'web', version: '1', caps: ctx.pick(CAP_SETS.slice(0, 2)) });
            shoulderView.watchHand(s, ctx.io, { gameId, position });
        }],
        [2, function ask() {
            // the owner of the seat on turn most of the time
            const onTurn = ctx.game.currentTurn ? ctx.game.seat(ctx.game.currentTurn)?.ownerSocketId : null;
            const h = ctx.pick(ctx.humans.filter((x) => x.connected));
            const sid = onTurn && ctx.rand() < 0.7 ? onTurn : h && h.current;
            const s = sid && ctx.sockets.get(sid); if (!s) return;
            const message = ctx.pick(['/help', '/help', '?help', '/tutorial on', '/tutorial off']);
            ctx.setNote(`${message} ${s.id}`);
            rateLimiter.clearSocket(s.id);
            chatHandlers.chatMessage(s, ctx.io, { message });
        }],
    ];
}

describe('over-the-shoulder chaos', () => {
    test(`${SEEDS} seeded chaos runs: shoulder data only to capable watchers of that seat, never stale`, async () => {
        let currentIo = null;
        let gameOfRun = () => null; // the running seed's game (ctx.game: a restart may swap it)
        const scan = watchShoulders(() => currentIo, { ownerHsi: OWNER_HSI });
        const stale = [];
        const stopStale = contractCheck.onEmit(() => {
            const game = gameOfRun();
            if (!currentIo || !game || stale.length > 20) return;
            for (const f of shouldersInvariant(currentIo, game)) {
                // a socket killed a moment before its disconnect handler runs is not a leak
                if (!currentIo.sockets.sockets.has(f.sid)) continue;
                stale.push(f);
            }
        });
        const failures = [];
        try {
            for (let seed = 1; seed <= SEEDS; seed++) {
                contractCheck.setContext(`shoulder chaos seed ${seed}`);
                const result = await runSeedInner(seed, (io) => { currentIo = io; }, {
                    errorLogs,
                    extraActions: (ctx) => {
                        gameOfRun = () => ctx.game;
                        return shoulderActions(ctx);
                    },
                });
                if (!result.ok) failures.push(result);
                if (scan.failures.length || stale.length || failures.length >= 3) break;
                for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
                GamePhase.resetViolations();
                jest.clearAllTimers();
            }
        } finally {
            scan.stop();
            stopStale();
        }
        expect(failures).toEqual([]);
        expect(scan.failures).toEqual([]);
        expect(stale).toEqual([]);
        expect(errorLogs).toEqual([]);
        if (process.env.SHOULDER_COUNTS) console.info(JSON.stringify(scan.counts));
        // Coverage: the runs reach every path
        if (SEEDS >= 20) {
            expect(scan.counts.gameStartShoulders).toBeGreaterThan(0);
            expect(scan.counts.snapshotShoulders).toBeGreaterThan(0);
            expect(scan.counts.mirrored).toBeGreaterThan(0);
            expect(scan.counts.wideEntries).toBeGreaterThan(0);
            for (const reason of ['not_spectating', 'not_dealt', 'own_seat']) {
                expect({ reason, n: scan.counts.refusals[reason] > 0 }).toEqual({ reason, n: true });
            }
        }
    }, 600000);
});
