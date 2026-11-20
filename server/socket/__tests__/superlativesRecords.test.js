/**
 * getRecords with superlatives, end to end (2026-11-20): seeded
 * gameRecords in an in-memory DB, the real handler (finds, projection,
 * 60 s per-scope cache, the throttled reply), every emit checked against
 * the socket contract. The titles themselves: server/utils/__tests__/superlatives.test.js.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

jest.setTimeout(30000);

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports
}));

const gameManager = require('../../game/GameManager');
const profile = require('../profileHandlers');
const rateLimiter = require('../rateLimiter');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const { authLogger } = require('../../utils/logger');

let log;
let io;
let n = 0;
const sock = () => makeSocket(`sup-${++n}`, log, io);
const lastTo = (socket, event) => log.filter(l => l.to === `self:${socket.id}` && l.event === event).pop()?.data;
async function records(data, socket = sock()) {
    if (data === undefined) await profile.getRecords(socket, io);
    else await profile.getRecords(socket, io, data);
    return lastTo(socket, 'recordsResponse');
}
const byId = (list) => Object.fromEntries((list || []).map((s) => [s.id, s]));

const now = new Date();
const THIS_MONTH = () => new Date(now.getFullYear(), now.getMonth(), 1, 12);
const LAST_YEAR = () => new Date(now.getFullYear() - 1, 5, 15);
// earlier this year but before this month (null in January: no such day)
const EARLIER_THIS_YEAR = () => (now.getMonth() > 0 ? new Date(now.getFullYear(), 0, 2, 12) : null);

const seat = (o = {}) => ({
    gamesPlayed: 1, wins: 1, losses: 0, draws: 0, totalPoints: 300, totalTricksBid: 20, totalTricksTaken: 20,
    totalHands: 13, totalSets: 1, totalSetPoints: 10, totalFaults: 0, totalHSI: 1300, totalBags: 0, ...o
});

let id = 0;
/** A human game of four with a names map (or, legacy, without). */
function humanGame(names, completedAt, { overrides = {}, legacy = false, assist, extra = {} } = {}) {
    const byPosition = {};
    names.forEach((name, i) => { byPosition[i + 1] = seat(overrides[name]); });
    const sd = { bucket: 'stats', byPosition };
    if (!legacy) sd.names = Object.fromEntries(names.map((name, i) => [i + 1, name]));
    if (assist) sd.assist = assist;
    return {
        gameId: `h${++id}`, team1Score: 300, team2Score: 200, team1Players: [names[0], names[2]], team2Players: [names[1], names[3]],
        team1Bags: 0, team2Bags: 0, completedAt, statsDeltas: sd, ...extra
    };
}
function soloGame(name, completedAt, o = {}) {
    return {
        gameId: `s${++id}`, withBots: true, team1Score: 400, team2Score: 100, team1Players: [name], team2Players: [],
        team1Bots: ['🤖 Zach'], team2Bots: ['🤖 Ivy', '🤖 Mary'], team1Bags: 1, team2Bags: -1, completedAt,
        statsDeltas: { bucket: 'botStats', byPosition: { 1: seat(o) }, names: { 1: name } }
    };
}
const times = (k, f) => Array.from({ length: k }, (_, i) => f(i));

beforeEach(() => {
    log = [];
    io = makeIo(log);
    id = 0;
    profile._resetCachesForTests();
    gameManager.deletedUsernames.clear();
    jest.spyOn(authLogger, 'debug').mockImplementation(() => {});
    jest.spyOn(authLogger, 'info').mockImplementation(() => {});
    const earlier = EARLIER_THIS_YEAR();
    mockDb.current = createMemoryDb({
        users: [],
        gameRecords: [
            // this month: Ann bags, Ben asks for /help, Cat is lucky
            ...times(5, () => humanGame(['Ann', 'Ben', 'Cat', 'Dan'], THIS_MONTH(), {
                overrides: { Ann: { totalBags: 4, totalSets: 5 }, Cat: { totalHSI: 2000 } }, assist: { 2: { help: 3 } }
            })),
            // last year: another table entirely (all time only)
            ...times(6, () => humanGame(['Old', 'Pat', 'Quin', 'Rae'], LAST_YEAR(), { overrides: { Old: { totalBags: 9 } } })),
            // earlier this year (this year, not this month)
            ...(earlier ? times(5, () => humanGame(['Yan', 'Zoe', 'Xia', 'Wes'], earlier, { overrides: { Yan: { totalHSI: 2600 } } })) : []),
            // bot games this month: Eve plays solo; a resigned seat is not solo
            ...times(5, () => soloGame('Eve', THIS_MONTH(), { totalHSI: 650 })),
            ...times(5, () => ({
                gameId: `r${++id}`, withBots: true, team1Score: 250, team2Score: 260, team1Players: ['Fay', 'Gus'], team2Players: [],
                team1Bots: [], team2Bots: ['🤖 Ivy', '🤖 Mary'], team1Bags: 0, team2Bags: 0, completedAt: THIS_MONTH(),
                statsDeltas: { bucket: 'botStats', byPosition: { 1: seat(), 3: seat() }, names: { 1: 'Fay', 3: 'Gus' } }
            })),
            // legacy records before statsDeltas: names only, ignored
            ...times(5, () => ({ gameId: `l${++id}`, team1Score: 100, team2Score: 90, team1Players: ['Hal', 'Ida'], team2Players: ['Jo', 'Kim'], completedAt: THIS_MONTH() }))
        ]
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});
afterAll(() => rateLimiter.shutdown?.());

describe('per period', () => {
    test('human scope: this month\'s titles from this month\'s players; all time adds last year\'s table', async () => {
        const res = await records();
        expect(res.success).toBe(true);
        const month = byId(res.records.thisMonth.superlatives);
        expect(Object.keys(month)).toEqual(['bagBoy', 'luckyDuck', 'cursed', 'helpFromFriends', 'anchor']);
        expect(month.bagBoy).toEqual({ id: 'bagBoy', title: 'Bag Boy', names: ['Ann'], detail: '4.0 bags a game' });
        expect(month.luckyDuck).toEqual({ id: 'luckyDuck', title: 'Lucky Duck', names: ['Cat'], detail: '153.8 avg HSI' });
        expect(month.cursed).toEqual({ id: 'cursed', title: 'Cursed', names: ['Ann', 'Ben', 'Dan'], detail: '100.0 avg HSI' });
        expect(month.helpFromFriends).toEqual({ id: 'helpFromFriends', title: 'A little help from my friends', names: ['Ben'], detail: '15 /help uses' });
        expect(month.anchor).toEqual({ id: 'anchor', title: 'Anchor', names: ['Ann'], detail: '38% of hands set' });
        // no bot game in the human scope: nobody is solo
        expect(month.botFriends).toBeUndefined();
        // never a bot persona, never a player of the legacy (name-less) records
        const named = res.records.allTime.superlatives.flatMap((s) => s.names);
        for (const nope of ['Eve', 'Fay', 'Gus', 'Hal', 'Ida', 'Jo', 'Kim', '🤖 Zach']) expect(named).not.toContain(nope);

        const all = byId(res.records.allTime.superlatives);
        expect(all.bagBoy).toEqual({ id: 'bagBoy', title: 'Bag Boy', names: ['Old'], detail: '9.0 bags a game' });
        const year = byId(res.records.thisYear.superlatives);
        expect(year.bagBoy.names).toEqual(['Ann']);
        if (EARLIER_THIS_YEAR()) {
            expect(year.luckyDuck).toMatchObject({ names: ['Yan'], detail: '200.0 avg HSI' });
            expect(month.luckyDuck.names).toEqual(['Cat']);
            expect(all.luckyDuck.names).toEqual(['Yan']);
        }
        // the team records are unchanged by it
        expect(res.records.thisMonth.highestScore).toEqual({ score: 300, players: ['Ann', 'Cat'] });
    });

    test('a period with no games stays null (no superlatives); one with games but nobody qualified has an empty list', async () => {
        mockDb.current = createMemoryDb({
            users: [],
            gameRecords: times(4, () => humanGame(['Ann', 'Ben', 'Cat', 'Dan'], LAST_YEAR()))
        });
        const res = await records();
        expect(res.records.thisMonth).toBeNull();
        expect(res.records.allTime.superlatives).toEqual([]);
    });
});

describe('per scope (statsScope.js), as the team records', () => {
    test('bots: Some of my best friends are bots for the solo player; the resigned seats are not solo; no human game counts', async () => {
        const res = await records({ scope: 'bots' });
        expect(res.scope).toBe('bots');
        const month = byId(res.records.thisMonth.superlatives);
        expect(month.botFriends).toEqual({ id: 'botFriends', title: 'Some of my best friends are bots', names: ['Eve'], detail: '5 solo games' });
        expect(month.cursed).toEqual({ id: 'cursed', title: 'Cursed', names: ['Eve'], detail: '50.0 avg HSI' });
        expect(month.luckyDuck.names).toEqual(['Fay', 'Gus']);
        const named = res.records.allTime.superlatives.flatMap((s) => s.names);
        for (const nope of ['Ann', 'Ben', 'Cat', 'Dan', 'Old', '🤖 Ivy', '🤖 Mary']) expect(named).not.toContain(nope);
    });

    test('all: human and bot games together', async () => {
        const res = await records({ scope: 'all' });
        const month = byId(res.records.thisMonth.superlatives);
        expect(month.botFriends.names).toEqual(['Eve']);
        expect(month.bagBoy.names).toEqual(['Ann']);
        expect(month.cursed.names).toEqual(['Eve']);
        expect(month.luckyDuck.names).toEqual(['Cat']);
    });

    test('a /help-assisted game (withBots, empty teamNBots) moves to the bot scope with the team records', async () => {
        const assisted = times(5, () => humanGame(['Max', 'Ned', 'Oli', 'Pia'], THIS_MONTH(), {
            assist: { 1: { help: 9 } }, extra: { withBots: true, team1Bots: [], team2Bots: [], assistedTeams: [1] }
        }));
        for (const g of assisted) await mockDb.current.gameRecords.insertOne(g);
        const human = await records({});
        expect(human.records.thisMonth.superlatives.flatMap((s) => s.names)).not.toContain('Max');
        expect(byId(human.records.thisMonth.superlatives).helpFromFriends.names).toEqual(['Ben']);
        const bots = await records({ scope: 'bots' });
        expect(byId(bots.records.thisMonth.superlatives).helpFromFriends).toMatchObject({ names: ['Max'], detail: '45 /help uses' });
        expect(byId(bots.records.thisMonth.superlatives).botFriends.names).toEqual(['Eve']);
    });
});

describe('older records and the read-time rebuild', () => {
    test('a 2026-11-15..20 record (byPosition, no names) counts when its teams match its seats; an ambiguous one is skipped', async () => {
        mockDb.current = createMemoryDb({
            users: [],
            gameRecords: [
                ...times(3, () => humanGame(['Ann', 'Ben', 'Cat', 'Dan'], THIS_MONTH(), { overrides: { Dan: { totalTricksBid: 10, totalTricksTaken: 16, totalBags: undefined } }, legacy: true })),
                ...times(2, () => humanGame(['Ann', 'Ben', 'Cat', 'Dan'], THIS_MONTH(), { overrides: { Dan: { totalBags: 6 } } })),
                // ambiguous: three seats in byPosition, four names
                ...times(5, () => {
                    const g = humanGame(['Ann', 'Ben', 'Cat', 'Dan'], THIS_MONTH(), { overrides: { Ann: { totalBags: 13 } }, legacy: true });
                    delete g.statsDeltas.byPosition[3];
                    return g;
                })
            ]
        });
        const res = await records();
        // Dan: 3 games of max(0, 16 - 10) + 2 of 6 = 6 a game; Ann's ambiguous games never count
        expect(byId(res.records.thisMonth.superlatives).bagBoy).toEqual({ id: 'bagBoy', title: 'Bag Boy', names: ['Dan'], detail: '6.0 bags a game' });
    });
});

describe('cache, throttle and the wire', () => {
    test('served from the 60 s cache (no find); a new game shows after the invalidation', async () => {
        const first = await records();
        const find = jest.spyOn(mockDb.current.gameRecords, 'find');
        const again = await records();
        expect(find).not.toHaveBeenCalled();
        expect(again.records.thisMonth.superlatives).toEqual(first.records.thisMonth.superlatives);
        find.mockRestore();

        for (const g of times(5, () => humanGame(['Bo', 'Cy', 'Di', 'Ed'], THIS_MONTH(), { overrides: { Bo: { totalBags: 12 } } }))) await mockDb.current.gameRecords.insertOne(g);
        expect(byId((await records()).records.thisMonth.superlatives).bagBoy.names).toEqual(['Ann']);
        profile.invalidateRecords();
        expect(byId((await records()).records.thisMonth.superlatives).bagBoy).toMatchObject({ names: ['Bo'], detail: '12.0 bags a game' });
    });

    test('over the soft limit: the cached (stale) records, superlatives included', async () => {
        const s = sock();
        for (let i = 0; i < 10; i++) await records(undefined, s);
        const first = lastTo(s, 'recordsResponse');
        const find = jest.spyOn(mockDb.current.gameRecords, 'find');
        const res = await records(undefined, s);
        expect(find).not.toHaveBeenCalled();
        expect(res.records.thisMonth.superlatives).toEqual(first.records.thisMonth.superlatives);
        expect(res.records.thisMonth.superlatives.length).toBeGreaterThan(0);
    });

    test('every reply passes the contract (recordsSuperlative: id, title, 1-3 names, detail)', async () => {
        // 5 tied for every title: 3 names and "(+2 more)"
        mockDb.current = createMemoryDb({
            users: [],
            gameRecords: ['Ana', 'bo', 'Cy', 'Di', 'Ed'].flatMap((name) => times(5, () => soloGame(name, THIS_MONTH(), { totalBags: 1, totalSets: 2 })))
        });
        const res = await records({ scope: 'all' });
        for (const s of res.records.thisMonth.superlatives) {
            expect(s.names).toEqual(['Ana', 'bo', 'Cy']);
            expect(s.detail).toMatch(/\(\+2 more\)$/);
        }
        expect(res.records.thisMonth.superlatives.map((s) => s.id)).toEqual(['bagBoy', 'luckyDuck', 'cursed', 'botFriends', 'anchor']);
        // the always-on contract guard (makeIo) saw no violation
        expect(require('../../testUtils/contractCheck').takeViolations()).toEqual([]);
    });
});
