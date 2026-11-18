/**
 * A Mongo outage mid-tournament: every DB call fails the way the driver
 * does once it cannot select a server, i.e. it rejects after
 * SERVER_SELECTION_TIMEOUT_MS (database.js). The fakes sleep that long
 * themselves, so this checks the swallowed-error paths, not that the option
 * reaches MongoClient (database.test.js does). Play must go on: the round start (setActiveGame), the draw screen (saved
 * pictures) and each game end (stats, clearActiveGameForAll) swallow the
 * error and continue about 5 s later, and the tournament finishes.
 * Real handlers, stub sockets, fake timers, the in-memory DB.
 * With LIVE_PERSIST write (deploy survival) the live collections are down
 * too: no game waits on a live write, only the terminal claim at a game's
 * end, bounded (liveStore.CLAIM_MAX_MS), and the store's warnings are
 * rate-limited and name ids only.
 */

const { createMemoryDb, MemoryCollection } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    ...jest.requireActual('../../database'),
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const { SERVER_SELECTION_TIMEOUT_MS } = jest.requireActual('../../database');
const gameManager = require('../../game/GameManager');
const { gameLogger, socketLogger, authLogger, dbLogger, logger } = require('../../utils/logger');
const { events } = require('../../testUtils/gameDriver');
const { setupTournament, playTournament } = require('../../testUtils/tournamentDriver');
const pacing = require('../../game/pacing');

/** What the driver throws when no server answers within the timeout. */
function selectionError() {
    return Object.assign(new Error(`Server selection timed out after ${SERVER_SELECTION_TIMEOUT_MS} ms`),
        { name: 'MongoServerSelectionError' });
}

/**
 * The collection, with every DB call rejecting after the selection
 * timeout; `calls` counts them. Test-only members (docs, _insert) stay.
 */
function down(collection, calls) {
    const fail = async () => {
        calls.n++;
        await new Promise((r) => setTimeout(r, SERVER_SELECTION_TIMEOUT_MS));
        throw selectionError();
    };
    return new Proxy(collection, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function' || String(prop).startsWith('_')) return value;
            if (prop === 'find') {
                const cursor = { project: () => cursor, sort: () => cursor, limit: () => cursor, skip: () => cursor, toArray: fail };
                return () => cursor;
            }
            return fail;
        },
    });
}

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, dbLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    require('../../game/persist/liveStore')._resetForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

test('the selection timeout is 5 s', () => {
    expect(SERVER_SELECTION_TIMEOUT_MS).toBe(5000);
});

test('Mongo down for a whole tournament: every game is played, each DB wait costs about 5 s', async () => {
    const ctx = await setupTournament(1);
    const calls = { n: 0 };
    mockDb.current = {
        users: down(mockDb.current.users, calls),
        gameRecords: down(mockDb.current.gameRecords, calls),
        reports: down(mockDb.current.reports, calls),
    };

    const { resolved, allTables } = await playTournament(ctx);

    expect(calls.n).toBeGreaterThan(0);
    expect(resolved).toHaveLength(4);
    expect(new Set(resolved).size).toBe(4);
    expect(events(ctx.log, 'gameEnd')).toHaveLength(4);
    expect(events(ctx.log, 'abortGame')).toHaveLength(0);
    expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
    expect(ctx.t.phase).toBe('complete');
    for (const g of allTables) expect(g.handStats.totalHands).toBe(13);

    // The draw screen, per table: last draw -> positionUpdate waits on the
    // picture lookups, positionUpdate -> teamsAnnounced on setActiveGame;
    // each is now one selection timeout (the driver default held every
    // table 30 s at each)
    const at = (event) => events(ctx.log, event).map((l) => l.at);
    const lastDraws = [];
    const draws = events(ctx.log, 'playerDrew');
    for (let i = 3; i < draws.length; i += 4) lastDraws.push(draws[i].at);
    const positioned = at('positionUpdate');
    const teams = at('teamsAnnounced');
    expect(lastDraws).toHaveLength(4);
    expect(positioned).toHaveLength(4);
    expect(teams).toHaveLength(4);
    const slack = 1000;
    for (let i = 0; i < 4; i++) {
        const pics = positioned[i] - lastDraws[i];
        expect(pics).toBeGreaterThanOrEqual(SERVER_SELECTION_TIMEOUT_MS);
        expect(pics).toBeLessThanOrEqual(SERVER_SELECTION_TIMEOUT_MS + pacing().DRAW_REVEAL_MS + slack);
        const active = teams[i] - positioned[i];
        expect(active).toBeGreaterThanOrEqual(SERVER_SELECTION_TIMEOUT_MS);
        expect(active).toBeLessThanOrEqual(SERVER_SELECTION_TIMEOUT_MS + pacing().SEATING_TO_TEAMS_MS + slack);
    }

    // Each game end: the round result follows gameEnd after one bounded
    // wait (clearActiveGameForAll's writes fail in parallel)
    const ends = at('gameEnd');
    const results = at('tournamentGameComplete');
    expect(results).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
        expect(results[i] - ends[i]).toBeLessThanOrEqual(SERVER_SELECTION_TIMEOUT_MS + 1000);
    }
}, 120000);

test('LIVE_PERSIST write with Mongo down, the live collections too: every game is played; each game end waits on its claim at most CLAIM_MAX_MS more', async () => {
    const liveStore = require('../../game/persist/liveStore');
    const calls = { n: 0 };
    const liveCalls = { n: 0 };
    const live = {
        liveGames: down(new MemoryCollection(), liveCalls),
        liveTournaments: down(new MemoryCollection(), liveCalls),
        serverInstances: down(new MemoryCollection(), liveCalls),
    };
    const warns = [];
    const store = liveStore.createLiveStore({
        mode: 'write',
        bootId: 'boot-outage',
        getCollections: () => live,
        logger: { info() {}, debug() {}, error: (msg, meta) => warns.push({ msg, meta }), warn: (msg, meta) => warns.push({ msg, meta }) },
    });
    liveStore._setForTests(store);
    const unhandled = [];
    const onUnhandled = (r) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
        const ctx = await setupTournament(1);
        mockDb.current = {
            users: down(mockDb.current.users, calls),
            gameRecords: down(mockDb.current.gameRecords, calls),
            reports: down(mockDb.current.reports, calls),
        };

        const { resolved } = await playTournament(ctx);
        expect(resolved).toHaveLength(4);
        expect(events(ctx.log, 'gameEnd')).toHaveLength(4);
        expect(events(ctx.log, 'abortGame')).toHaveLength(0);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        expect(liveCalls.n).toBeGreaterThan(4);

        const at = (event) => events(ctx.log, event).map((l) => l.at);
        const ends = at('gameEnd');
        const results = at('tournamentGameComplete');
        for (let i = 0; i < 4; i++) {
            // the claim (behind the write in flight: bounded), then the pointer clears
            expect(results[i] - ends[i]).toBeLessThanOrEqual(liveStore.CLAIM_MAX_MS + SERVER_SELECTION_TIMEOUT_MS + 1000);
        }
        // Rate-limited (a line per kind of failure per minute), ids and codes only
        expect(warns.length).toBeGreaterThan(0);
        expect(warns.length).toBeLessThan(liveCalls.n);
        for (const w of warns) {
            for (const k of Object.keys(w.meta || {})) expect(['gameId', 'tournamentId', 'rev', 'error', 'code', 'skipped', 'why', 'timeoutMs']).toContain(k);
        }
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    await Promise.resolve();
    expect(unhandled).toEqual([]);
}, 120000);
