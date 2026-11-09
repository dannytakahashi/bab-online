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
 *                          event shapes or the game log needs a re-record)
 */

const fs = require('fs');
const path = require('path');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
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
const { scenarioBots, scenarioHumans } = require('../../testUtils/iosScenarios');

const ROOT = path.join(__dirname, '..', '..', '..');
const DIR = path.resolve(ROOT, process.env.IOS_FIXTURE_DIR || 'iOSClient/BABOnlineTests/Fixtures/events');
const UPDATE = process.env.UPDATE_IOS_FIXTURES === '1';
const realRandom = Math.random;

function setup(seed) {
    require('uuid').__reset();
    jest.useFakeTimers();
    jest.setSystemTime(Date.UTC(2026, 0, 1, 12));
    mockDb.current = createMemoryDb({ users: [] });
    Math.random = mulberry32(seed);
}

function teardown() {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    Math.random = realRandom;
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
    setup(seed);
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

test.each([
    ['events-bots-s12', 'bots', 12],
    ['events-bots-s14', 'bots', 14],
    ['events-humans-s13', 'humans', 13],
])('%s matches the committed iOS fixture (run npm run ios:fixtures)', async (name, kind, seed) => {
    const rec = kind === 'bots' ? (await record(name, scenarioBots, seed)).rec : await recordHumans(name, seed);
    // Sanity: every open viewer reached gameEnd with a final snapshot, and there are checkpoints
    expect(Object.keys(rec.final).length).toBeGreaterThan(0);
    expect(rec.checkpoints.length).toBeGreaterThan(20);
    for (const f of Object.values(rec.final)) expect(f.snapshot.stage).toBe('HAND_RESOLVING');
    if (kind === 'humans') {
        for (const e of ['destroyHands', 'actionRejected', 'restorePlayerState', 'error', 'rejoinSuccess', 'playerLazyMode', 'playerActiveMode', 'playerResigned', 'rainbow']) {
            expect({ e, present: hasEvent(rec, e) }).toEqual({ e, present: true });
        }
    } else {
        expect(Object.keys(rec.logs).sort()).toEqual(['seat1', 'seat1-rejoin', 'spectator']);
    }
    const content = serialize(rec);
    const file = path.join(DIR, `${name}.json`);
    if (UPDATE) {
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(file, content);
        return;
    }
    const committed = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (committed !== content) {
        throw new Error(`${path.relative(ROOT, file)} is out of date: run npm run ios:fixtures (server event shapes or game log text changed)`);
    }
}, 120000);
