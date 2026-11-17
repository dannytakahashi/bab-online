/**
 * Game codec round trip over chaos runs (deploy survival, PR 3). At every
 * safe point of a seeded chaos run (testUtils/restoreKit.watchSafePoints:
 * the end of each synchronous run that changed the game, where the persist
 * store will serialize) the live game is serialized and:
 *   - the doc is non-null exactly in the four restore stages;
 *   - it survives a JSON round trip unchanged;
 *   - hydrate passes validateGameState and validateSeats (BAB_FSM_CHECK=1);
 *   - serialize(hydrate(doc)) equals doc, except eventSeq (+1000) and each
 *     seat's presence as a restore maps it (expectedAfterRestore);
 *   - each human seat's hand sits under restored:<gameId>:<pos>;
 *   - once every owner who was connected is back on the restored copy,
 *     each one's snapshotV2 equals the live game's, ignoring seq,
 *     serverTime, resume, watching / spectatorCount (spectators are not
 *     restored), and per seat presence, graceDeadline, resignableAt,
 *     offered (offers are re-made) and avatarUrl; and the viewer's
 *     ownerView (a lazy owner back on a restored game watches, as after
 *     any rejoin today);
 *   - the doc stays under 64 KB (here, and with a full 500-line log of
 *     game lines below).
 * The chaos run's own oracles (invariants, liveness, leaks, violations)
 * keep running: a check that broke the game would fail them.
 *
 * PERSIST_SEEDS=<n> overrides the number of seeds (default 30); PERSIST_STATS=1
 * prints how many safe points, docs and snapshots were checked.
 */

const { createMemoryDb } = require('../../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../GameManager');
const GameState = require('../../GameState');
const { validateSeats } = require('../../SeatState');
const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');
const contractCheck = require('../../../testUtils/contractCheck');
const { runSeedInner } = require('../../../testUtils/chaosEngine');
const { watchSafePoints } = require('../../../testUtils/restoreKit');
const codec = require('../gameCodec');

const SEEDS = Number(process.env.PERSIST_SEEDS) || 30;
const MAX_DOC_BYTES = 64 * 1024;

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

const json = (v) => JSON.parse(JSON.stringify(v));

/** A snapshot with the fields a restore legitimately changes taken out. */
function comparable(snap) {
    const s = json(snap);
    delete s.seq;
    delete s.serverTime;
    delete s.resume;
    delete s.watching;
    delete s.spectatorCount;
    delete s.viewer.ownerView;
    for (const seat of s.seats) {
        delete seat.presence;
        delete seat.graceDeadline;
        delete seat.resignableAt;
        delete seat.offered;
        delete seat.avatarUrl;
    }
    return s;
}

/** Every check of one safe point; returns a failure description or null. */
function checkSafePoint(game, stats) {
    const doc = codec.serialize(game);
    const restorable = codec.SAVE_STAGES.has(game.stage);
    if (!restorable) {
        if (doc !== null) return `doc in ${game.stage}`;
        return null;
    }
    if (doc === null) return `no doc in ${game.stage}: ${codec.refusal(game)}`;
    stats.docs++;
    stats.stages.add(game.stage);
    const text = JSON.stringify(doc);
    stats.maxBytes = Math.max(stats.maxBytes, Buffer.byteLength(text));
    if (Buffer.byteLength(text) >= MAX_DOC_BYTES) return `doc of ${Buffer.byteLength(text)} bytes`;
    const stored = JSON.parse(text);
    try {
        expect(stored).toEqual(doc);
    } catch (err) {
        return `not JSON-safe: ${err.message.slice(0, 400)}`;
    }

    const now = Date.now();
    const { game: restored, bots } = codec.hydrate(stored, { now });
    try {
        const { errors } = restored.validateGameState();
        if (errors.length) return `restored invalid: ${errors.join('; ')}`;
        const seatErrors = validateSeats(restored);
        if (seatErrors.length) return `restored seats invalid: ${seatErrors.join('; ')}`;
        if (restored.eventSeq !== game.eventSeq + codec.EVENT_SEQ_OFFSET) return `eventSeq ${restored.eventSeq}`;

        const again = codec.serialize(restored, {
            tournamentId: stored.tournamentId,
            getBot: (sid) => bots.find((b) => b.socketId === sid) || null,
        });
        try {
            expect(again).toEqual(codec.expectedAfterRestore(stored));
        } catch (err) {
            return `serialize(hydrate(doc)) differs: ${err.message.slice(0, 600)}`;
        }

        for (let pos = 1; pos <= 4; pos++) {
            const seat = restored.seat(pos);
            if (seat.controller !== 'human') continue;
            const key = GameState.restoredSeatSocketId(game.gameId, pos);
            if (seat.seatSocketId !== key) return `seat ${pos} keyed ${seat.seatSocketId}`;
            try {
                expect(restored.hands[key] ?? null).toEqual(stored.state.hands[pos]);
            } catch (err) {
                return `seat ${pos} hand not under ${key}`;
            }
        }

        // Every connected owner comes back on the restored copy
        const owners = game.seatList().filter((s) => s.ownerSocketId);
        for (const s of owners) {
            if (s.controller === 'human') restored.seatReconnect(s.position, s.ownerSocketId);
            else restored.seatWatch(s.position, s.ownerSocketId);
        }
        for (const s of owners) {
            const live = comparable(game.getSnapshotV2(s.ownerSocketId, { now }));
            const back = comparable(restored.getSnapshotV2(s.ownerSocketId, { now }));
            try {
                expect(back).toEqual(live);
            } catch (err) {
                return `seat ${s.position} snapshot differs: ${err.message.slice(0, 800)}`;
            }
            stats.snapshots++;
        }
        return null;
    } finally {
        restored._cancelAllTimers();
    }
}

async function runSeed(seed, stats) {
    const failures = [];
    const watch = watchSafePoints((game) => {
        // Only the run's live table (not the dummy table, not a restored copy)
        if (gameManager.getGameById(game.gameId) !== game || game.isDemo) return;
        stats.points++;
        try {
            const why = checkSafePoint(game, stats);
            if (why) failures.push(`${game.stage}: ${why}`);
        } catch (err) {
            failures.push(`${game.stage}: threw ${err.stack}`);
        }
    });
    try {
        contractCheck.setContext(`codec round trip seed ${seed}`);
        const result = await runSeedInner(seed, () => {}, { errorLogs });
        if (!result.ok) return { seed, why: 'chaos', result };
        if (failures.length) return { seed, why: 'codec', failures: failures.slice(0, 3) };
        return { ok: true };
    } finally {
        watch.stop();
    }
}

describe('game codec round trip at every safe point of a chaos run', () => {
    test(`${SEEDS} seeds`, async () => {
        const stats = { points: 0, docs: 0, snapshots: 0, maxBytes: 0, stages: new Set() };
        const bad = [];
        for (let seed = 1; seed <= SEEDS; seed++) {
            const r = await runSeed(seed, stats);
            if (!r.ok) {
                bad.push(r);
                if (bad.length >= 3) break;
            }
        }
        if (process.env.PERSIST_STATS) process.stdout.write(JSON.stringify({ ...stats, stages: [...stats.stages] }) + '\n');
        if (bad.length) throw new Error(JSON.stringify(bad, null, 2).slice(0, 6000));
        expect(stats.docs).toBeGreaterThan(SEEDS * 5);
        expect(stats.snapshots).toBeGreaterThan(0);
        expect([...stats.stages].sort()).toEqual(['BIDDING', 'HAND_RESOLVING', 'PLAYING', 'TRICK_RESOLVING']);
        expect(stats.maxBytes).toBeLessThan(MAX_DOC_BYTES);
    }, 600000);
});

describe('doc size', () => {
    test('a played game with a full 500-line log of game lines stays under 64 KB', async () => {
        const { mulberry32, makeIo } = require('../../../testUtils/gameDriver');
        const ambient = require('../../../demo/ambientBots');
        Math.random = mulberry32(7);
        const io = makeIo([]);
        const game = ambient.startBotGame(io);
        // Deep into the game: the 13-card hand's bids and plays are the longest lines
        let doc = null;
        for (let t = 0; t < 400 && !game.isTerminal(); t++) {
            await jest.advanceTimersByTimeAsync(2000);
            if (game.currentHand === 13 && game.stage === 'PLAYING' && game.cardIndex >= 20) break;
        }
        expect(game.stage).toBe('PLAYING');
        game.isDemo = false; // the demo flag only keeps it out of the store
        // Fill the log to its 500-line cap with this game's own lines plus
        // ordinary chat (the cap drops the oldest)
        const own = game.gameLog.slice();
        for (let i = 0; game.gameLog.length < 500 || i < 500; i++) {
            const e = own[i % own.length];
            if (i % 4 === 3) game.addLogEntry(`🤖 Mary: nice play partner, that was a good one ${i}`, 1, 'chat');
            else game.addLogEntry(e.message, e.playerPosition, e.type);
            if (i > 1000) break;
        }
        expect(game.gameLog).toHaveLength(500);
        doc = codec.serialize(game, { tournamentId: null });
        expect(doc).not.toBeNull();
        const bytes = Buffer.byteLength(JSON.stringify(doc));
        expect(bytes).toBeLessThan(MAX_DOC_BYTES);
        ambient.stopAmbientActivity();
    }, 60000);
});
