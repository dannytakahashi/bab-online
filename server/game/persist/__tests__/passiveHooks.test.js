/**
 * The persist hooks are passive (deploy survival PR 4, the plan's 2.3): the
 * same run with LIVE_PERSIST off and with write (the store writing every
 * change to a liveDb) emits exactly the same events, in the same order and
 * at the same (fake) times, and draws Math.random exactly as often. Runs:
 * contractScenarios.playF1 (a whole human lobby game with lazy, rejoin,
 * resign, spectators and chat), a chaos seed, and the ambient demo game.
 * The whole Jest suite also runs once with LIVE_PERSIST=write in CI
 * (.github/workflows/ci.yml).
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const { makeIo, mulberry32 } = require('../../../testUtils/gameDriver');
const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const liveStore = require('../liveStore');
const profileHandlers = require('../../../socket/profileHandlers');
const contractCheck = require('../../../testUtils/contractCheck');
const { playF1 } = require('../../../testUtils/contractScenarios');
const { runSeedInner } = require('../../../testUtils/chaosEngine');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

let realRandom;
let errorLogs;

beforeEach(() => {
    realRandom = Math.random;
    jest.useFakeTimers();
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The bots' table quips roll on a hash of the game id (a fresh uuid per
    // run): the same roll without the id, so two runs quip alike
    jest.spyOn(botController, 'chatRoll').mockImplementation((game, salt) => {
        const key = `${game.currentHand}|${game.cardIndex}|${salt}`;
        let x = 0x811c9dc5;
        for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 0x01000193) >>> 0;
        return x / 0x100000000;
    });
});

afterEach(() => {
    liveStore._resetForTests();
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * The emit log as JSON lines: every uuid (game, lobby, tournament ids) named
 * by first appearance, and each emit's time relative to the run's start
 * (fake time; each run starts where the last one left the clock), the
 * times inside payloads too.
 */
function normalized(log, start) {
    const names = new Map();
    return log.map((e) => JSON.stringify({ ...e, at: e.at - start })
        .replace(UUID, (id) => {
            if (!names.has(id)) names.set(id, `id${names.size}`);
            return names.get(id);
        })
        // Times inside payloads (chat timestamps, serverTime, deadlines)
        .replace(/(?<![.\d])1\d{12}(?![.\d])/g, (t) => `t${Number(t) - start}`));
}

/** The first line where two normalized logs differ (readable failures). */
function firstDiff(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return { index: i, off: a[i], write: b[i] };
    return null;
}

/** Count every Math.random draw from now on (wraps whatever is installed). */
function countRandom() {
    const counter = { n: 0 };
    const inner = Math.random;
    Math.random = () => {
        counter.n++;
        return inner();
    };
    return counter;
}

/** A fresh "process" in `mode`: db, store, singletons. */
function fresh(mode) {
    liveStore._resetForTests();
    gameManager._resetForTests();
    botController._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    mockDb.current = h.liveDb();
    return kit.installStore(mockDb, { mode });
}

const liveWrites = () => mockDb.current.faults.calls.filter((c) => h.LIVE_COLLECTIONS.includes(c.collection) && c.collection !== 'serverInstances');

async function both(run) {
    const out = {};
    for (const mode of ['off', 'write']) {
        const store = fresh(mode);
        const r = await run();
        await h.flushStore(store);
        out[mode] = { ...r, writes: liveWrites().length };
    }
    return out;
}

test('playF1 (a whole lobby game: lazy, watch-view rejoin, resign, spectator chat, bot chat): identical emits and Math.random draws', async () => {
    const { off, write } = await both(async () => {
        let w;
        let counter;
        const start = Date.now();
        await playF1({
            errorLogs,
            hooks: {
                onWorld(world) {
                    w = world;
                    counter = countRandom();
                },
            },
        });
        return { log: normalized(w.log, start), draws: counter.n, events: w.log.length };
    });
    expect(off.writes).toBe(0);
    expect(write.writes).toBeGreaterThan(20);
    expect(firstDiff(off.log, write.log)).toBeNull();
    expect(write.events).toBe(off.events);
    expect(write.draws).toBe(off.draws);
}, 120000);

test('a chaos seed: identical emits and Math.random draws', async () => {
    const seed = 7;
    const { off, write } = await both(async () => {
        let counter;
        let io;
        contractCheck.setContext(`passiveHooks chaos seed ${seed}`);
        const r = await runSeedInner(seed, (x) => { io = x; }, {
            errorLogs,
            // No actions added (every pick is the original one): only the counter
            extraActions: () => {
                counter = countRandom();
                return [];
            },
        });
        if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 2000));
        void io;
        return { result: JSON.stringify(r), draws: counter.n };
    });
    expect(write.writes).toBeGreaterThan(5);
    expect(write.draws).toBe(off.draws);
    expect(write.result).toBe(off.result);
}, 120000);

test('a chaos seed: the emit logs themselves are identical', async () => {
    const seed = 12;
    const { off, write } = await both(async () => {
        const log = [];
        const start = Date.now();
        const instance = { io: makeIo(log), log };
        contractCheck.setContext(`passiveHooks chaos log seed ${seed}`);
        const r = await runSeedInner(seed, () => {}, { errorLogs, instance });
        if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 2000));
        return { log: normalized(log, start) };
    });
    expect(write.writes).toBeGreaterThan(5);
    expect(firstDiff(off.log, write.log)).toBeNull();
}, 120000);

test('the ambient demo game (never saved): identical emits and Math.random draws for 20 minutes of play', async () => {
    const { off, write } = await both(async () => {
        const ambient = require('../../../demo/ambientBots');
        const log = [];
        const start = Date.now();
        const io = makeIo(log);
        Math.random = mulberry32(31);
        const counter = countRandom();
        ambient.startBotGame(io);
        await jest.advanceTimersByTimeAsync(20 * 60 * 1000);
        ambient.stopAmbientActivity?.();
        for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
        return { log: normalized(log, start), draws: counter.n, events: log.length };
    });
    expect(off.events).toBeGreaterThan(50);
    // The demo game is never saved (serialize refuses it)
    expect(write.writes).toBe(0);
    expect(write.draws).toBe(off.draws);
    expect(firstDiff(off.log, write.log)).toBeNull();
}, 120000);
