/**
 * iOS event-log fixtures (iOSClient/BABOnlineTests/Fixtures/events/*.json):
 * what each watched socket received in real handler-driven games, plus the
 * server's snapshot v2 at checkpoints, for the iOS reducer/replay XCTests
 * (item 23). Deterministic like contractFixtures.test.js: counter uuids, a
 * fixed clock, seeded Math.random, real pacing.
 *
 *   npm run ios:fixtures   (simulate.js --record-ios; UPDATE_IOS_FIXTURES=1)
 *                          rewrites them
 *   otherwise              the regenerated logs must equal the committed
 *                          files (the drift guard: a server change to these
 *                          event shapes, the game-log text, bot decisions
 *                          (BotStrategy) or RNG use needs a re-record, and
 *                          then `xcodebuild test`: only the iOS replay tests
 *                          say whether the client still matches the new logs)
 *
 * The games are scripted real-handler scenarios (server/testUtils/iosScenarios.js),
 * not the bot sim: simulate.js never touches handlers or io, so it has no
 * wire to record. `simulate.js --record-ios <dir>` only runs this file.
 */

const fs = require('fs');
const path = require('path');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    // The restart recording's live collections (persistHarness.liveDb; the
    // other recordings' memoryDb has none, so nothing is persisted there)
    getLiveGamesCollection: () => mockDb.current.liveGames,
    getLiveTournamentsCollection: () => mockDb.current.liveTournaments,
    getServerInstancesCollection: () => mockDb.current.serverInstances,
    getLiveDbForTests: () => mockDb.current,
    whenReady: () => Promise.resolve(true),
}));
jest.mock('uuid', () => {
    let n = 0;
    return {
        v4: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
        __reset: () => { n = 0; },
    };
});

const gameManager = require('../../game/GameManager');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { mulberry32 } = require('../../testUtils/gameDriver');
const { world } = require('../../testUtils/contractScenarios');
const { createEventRecorder, serialize } = require('../../testUtils/eventRecorder');
const { scenarioBots, scenarioHumans, scenarioPresence, scenarioTournament, scenarioBidClock, scenarioRestart, scenarioGyb } = require('../../testUtils/iosScenarios');

const ROOT = path.join(__dirname, '..', '..', '..');
const DIR = path.resolve(ROOT, process.env.IOS_FIXTURE_DIR || 'iOSClient/BABOnlineTests/Fixtures/events');
const UPDATE = process.env.UPDATE_IOS_FIXTURES === '1';
const realRandom = Math.random;

function setup(seed, { bidClock = false, live = false } = {}) {
    // Only the bidclock recording runs with the bid clock: the others idle
    // human bid turns to test other mechanisms (a 61 s grace) and predate it
    if (bidClock) delete process.env.BID_CLOCK;
    else process.env.BID_CLOCK = 'off';
    require('uuid').__reset();
    jest.useFakeTimers();
    jest.setSystemTime(Date.UTC(2026, 0, 1, 12));
    mockDb.current = live ? require('../../testUtils/persistHarness').liveDb({ users: [] }) : createMemoryDb({ users: [] });
    Math.random = mulberry32(seed);
}

function teardown() {
    require('../../game/persist/liveStore')._resetForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    Math.random = realRandom;
    delete process.env.BID_CLOCK;
}

beforeEach(() => {
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    teardown();
    jest.restoreAllMocks();
});

afterAll(() => require('../errorHandler').rateLimiter.shutdown());

async function record(name, scenario, seed) {
    setup(seed, { bidClock: scenario === scenarioBidClock, live: scenario === scenarioRestart });
    const w = world(`ios-${name}`);
    let game = null;
    const rec = createEventRecorder(w, { getGame: () => game || [...gameManager.games.values()][0] });
    try {
        const out = await scenario(w, rec, seed);
        game = out.game;
        return { rec: rec.toJSON({ name, seed, usernames: out.usernames }, out.game), w };
    } finally {
        rec.stop();
    }
}

const hasEvent = (r, event) => Object.values(r.logs).some((log) => log.some((e) => e.event === event));

/** Humans: the first seed from `from` whose game has a rainbow (deterministic search). */
async function recordHumans(name, from) {
    for (let seed = from; seed < from + 40; seed++) {
        const { rec } = await record(name, scenarioHumans, seed);
        if (hasEvent(rec, 'rainbow')) return { ...rec, seed, seedSearch: { from, chosen: seed } };
        teardown();
    }
    throw new Error('no rainbow in 40 seeds');
}

const SCENARIOS = { bots: scenarioBots, presence: scenarioPresence, tournament: scenarioTournament, bidclock: scenarioBidClock, restart: scenarioRestart, gyb: scenarioGyb };

test.each([
    ['events-bots-s12', 'bots', 12],
    ['events-bots-s14', 'bots', 14],
    ['events-humans-s13', 'humans', 13],
    ['events-presence-s21', 'presence', 21],
    ['events-tournament-s15', 'tournament', 15],
    ['events-bidclock-s16', 'bidclock', 16],
    ['events-restart-s18', 'restart', 18],
    ['events-gyb-s19', 'gyb', 19],
])('%s matches the committed iOS fixture (run npm run ios:fixtures)', async (name, kind, seed) => {
    const rec = kind === 'humans' ? await recordHumans(name, seed) : (await record(name, SCENARIOS[kind], seed)).rec;
    // Sanity: every open viewer reached gameEnd with a final snapshot, and there are checkpoints
    expect(Object.keys(rec.final).length).toBeGreaterThan(0);
    expect(rec.checkpoints.length).toBeGreaterThan(20);
    for (const f of Object.values(rec.final)) expect(f.snapshot.stage).toBe('HAND_RESOLVING');
    if (kind === 'humans') {
        for (const e of ['destroyHands', 'actionRejected', 'restorePlayerState', 'serverError', 'rejoinSuccess', 'playerLazyMode', 'playerActiveMode', 'playerResigned', 'rainbow']) {
            expect({ e, present: hasEvent(rec, e) }).toEqual({ e, present: true });
        }
    } else if (kind === 'bidclock') {
        expect(Object.keys(rec.logs).sort()).toEqual(['seat1', 'seat1-rejoin', 'spectator']);
        const clock = (label) => rec.logs[label].filter((e) => e.event === 'bidClock').map((e) => (e.data.running ? 'running' : e.data.reason));
        // seat1: the timeout, the mid-tune bid, the clock it dropped in; the
        // rejoin's own bid stops the clock its snapshot carried
        expect(clock('seat1').slice(0, 5)).toEqual(['running', 'timeout', 'running', 'bid', 'running']);
        expect(clock('seat1-rejoin')[0]).toBe('bid');
        expect(clock('spectator').slice(0, 5)).toEqual(['running', 'timeout', 'running', 'bid', 'running']);
        expect(rec.logs.seat1.some((e) => e.event === 'gameLogEntry' && / ran out of time\.$/.test(e.data.message))).toBe(true);
        const rejoin = rec.logs['seat1-rejoin'].find((e) => e.event === 'rejoinSuccess');
        expect(rejoin.data.snapshot.bidClock).toMatchObject({ inMs: expect.any(Number), durationMs: 30000 });
        expect(rejoin.data.snapshot.bidClock.inMs).toBeGreaterThan(11000);
        expect(rejoin.data.snapshot.bidClock.inMs).toBeLessThanOrEqual(12000);
    } else if (kind === 'restart') {
        expect(Object.keys(rec.logs).sort()).toEqual(['seat1', 'seat1-rejoin']);
        const lines = (label) => rec.logs[label].filter((e) => e.event === 'gameLogEntry').map((e) => e.data.message);
        // The play sent during the flush (dropped by the gate), then the old process's line
        expect(lines('seat1').at(-1)).toBe('The server is updating. This game will continue in a few seconds.');
        expect(rec.logs.seat1.at(-1)).toMatchObject({ dir: 's2c', event: 'gameLogEntry' });
        expect(rec.logs.seat1.at(-2)).toMatchObject({ dir: 'c2s', event: 'playCard' });
        const rejoin = rec.logs['seat1-rejoin'].find((e) => e.event === 'rejoinSuccess');
        const last = rec.logs.seat1.filter((e) => e.dir === 's2c' && Number.isInteger(e.data?.seq)).at(-1).data.seq;
        expect(rejoin.data.snapshot.seq).toBeGreaterThanOrEqual(last + 999);
        expect(JSON.stringify(rejoin.data.snapshot.log)).toContain('This game resumed after a server update.');
        expect(hasEvent(rec, 'rejoinFailed')).toBe(false);
    } else if (kind === 'gyb') {
        // Get Your Bid: three seats, every carrier's snapshot beside its gyb, a hand score per seat
        expect(Object.keys(rec.logs).sort()).toEqual(['seat1', 'seat1-rejoin', 'spectator']);
        expect(rec.checkpoints.every((c) => c.gyb && c.gyb.scores.length === 3)).toBe(true);
        const hands = rec.logs.spectator.filter((e) => e.event === 'handComplete').map((e) => e.data.gyb);
        expect(hands.length).toBeGreaterThan(5);
        expect(hands.every((h) => h && h.seats.length === 3)).toBe(true);
        expect(rec.logs.seat1.find((e) => e.event === 'allPlayersReady').data.mode).toBe('gyb');
        expect(rec.logs['seat1-rejoin'].find((e) => e.event === 'rejoinSuccess').data.gyb).toBeTruthy();
        expect(rec.logs.spectator.find((e) => e.event === 'spectatorJoined').data.gyb).toBeTruthy();
        const end = rec.final.spectator.gameEnd.gyb;
        expect(end.scores).toHaveLength(3);
        expect(hasEvent(rec, 'teamsAnnounced')).toBe(false);
    } else if (kind === 'bots') {
        expect(Object.keys(rec.logs).sort()).toEqual(['seat1', 'seat1-rejoin', 'spectator']);
    } else if (kind === 'presence') {
        expect(Object.keys(rec.final).sort()).toEqual(['seat1-rejoin', 'seat3-rejoin', 'spectator']);
        for (const e of ['playerDisconnected', 'resignationAvailable', 'playerLazyMode', 'playerActiveMode', 'playerResigned']) {
            expect({ e, present: hasEvent(rec, e) }).toEqual({ e, present: true });
        }
    } else {
        // two tables, each with its own tournament snapshot and seq from 1
        const games = new Set(rec.checkpoints.map((c) => c.snapshot.gameId));
        expect(games.size).toBe(2);
        expect(rec.checkpoints.every((c) => c.snapshot.tournament && c.snapshot.tournament.tournamentId)).toBe(true);
        expect(rec.logs.seat1.filter((e) => e.event === 'tournamentGameAssignment')).toHaveLength(2);
    }
    // the clock is off for the legacy recordings: none may carry it
    if (kind !== 'bidclock') expect(hasEvent(rec, 'bidClock')).toBe(false);
    // the draw phase is checkpointed too
    expect(rec.checkpoints.some((c) => c.snapshot.stage === 'DRAWING')).toBe(true);
    const content = serialize(rec);
    const file = path.join(DIR, `${name}.json`);
    if (UPDATE) {
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(file, content);
        return;
    }
    const committed = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (committed !== content) {
        throw new Error(`${path.relative(ROOT, file)} is out of date: run npm run ios:fixtures, then xcodebuild test `
            + '(server event shapes, game-log text, bot decisions or RNG use changed)');
    }
}, 120000);
