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

/** One seat's 12 bucket counters (a `totalBags` override is the seat's statsDeltas.bags entry instead). */
const seat = ({ totalBags: _bags, ...o } = {}) => ({
    gamesPlayed: 1, wins: 1, losses: 0, draws: 0, totalPoints: 300, totalTricksBid: 20, totalTricksTaken: 20,
    totalHands: 13, totalSets: 1, totalSetPoints: 10, totalFaults: 0, totalHSI: 1300, ...o
});
/** statsDeltas.bags for seats {pos: overrides}: 0 unless overridden (undefined: not counted). */
const bagsOf = (seats) => {
    const out = {};
    for (const [pos, o] of Object.entries(seats)) {
        const b = o && 'totalBags' in o ? o.totalBags : 0;
        if (b !== undefined) out[pos] = b;
    }
    return out;
};

let id = 0;
/** A human game of four with a names map (or, legacy, without: no bags either). */
function humanGame(names, completedAt, { overrides = {}, legacy = false, assist, extra = {} } = {}) {
    const byPosition = {};
    names.forEach((name, i) => { byPosition[i + 1] = seat(overrides[name]); });
    const sd = { bucket: 'stats', byPosition };
    if (!legacy) sd.bags = bagsOf(Object.fromEntries(names.map((name, i) => [i + 1, overrides[name]])));
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
        statsDeltas: { bucket: 'botStats', byPosition: { 1: seat(o) }, bags: bagsOf({ 1: o }), names: { 1: name } }
    };
}
const times = (k, f) => Array.from({ length: k }, (_, i) => f(i));

/**
 * The users documents these records would have left (each named seat's
 * byPosition counters summed into its statsDeltas.bucket, as
 * applyPendingStats does): the All Time account titles then agree with
 * the records-based ones.
 */
function usersFrom(gameRecords) {
    const users = new Map();
    for (const g of gameRecords) {
        const sd = g.statsDeltas;
        if (!sd || !sd.byPosition || !sd.names) continue;
        for (const [pos, counters] of Object.entries(sd.byPosition)) {
            const name = sd.names[pos];
            if (!users.has(name)) users.set(name, { username: name, password: 'x' });
            const bucket = users.get(name)[sd.bucket] = users.get(name)[sd.bucket] || {};
            for (const [k, v] of Object.entries(counters)) bucket[k] = (bucket[k] || 0) + v;
        }
    }
    return [...users.values()];
}

beforeEach(() => {
    log = [];
    io = makeIo(log);
    id = 0;
    profile._resetCachesForTests();
    gameManager.deletedUsernames.clear();
    jest.spyOn(authLogger, 'debug').mockImplementation(() => {});
    jest.spyOn(authLogger, 'info').mockImplementation(() => {});
    const earlier = EARLIER_THIS_YEAR();
    const gameRecords = [
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
    ];
    mockDb.current = createMemoryDb({ users: usersFrom(gameRecords), gameRecords });
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
        expect(Object.keys(month)).toEqual(['bagBoy', 'luckyDuck', 'cursed', 'helpFromFriends', 'delusionsOfGrandeur']);
        expect(month.bagBoy).toEqual({ id: 'bagBoy', title: 'Bag Boy', names: ['Ann'], detail: '4.0 bags a game' });
        expect(month.luckyDuck).toEqual({ id: 'luckyDuck', title: 'Lucky Duck', names: ['Cat'], detail: '153.8 avg HSI' });
        expect(month.cursed).toEqual({ id: 'cursed', title: 'Cursed', names: ['Ann', 'Ben', 'Dan'], detail: '100.0 avg HSI' });
        expect(month.helpFromFriends).toEqual({ id: 'helpFromFriends', title: 'A little help from my friends', names: ['Ben'], detail: '15 /help uses' });
        expect(month.delusionsOfGrandeur).toEqual({ id: 'delusionsOfGrandeur', title: 'Delusions of Grandeur', names: ['Ann'], detail: '38% of hands set' });
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

    test('over the soft limit (the real limiter, a fresh entry): the cached records, superlatives included', async () => {
        const s = sock();
        for (let i = 0; i < 10; i++) await records(undefined, s);
        const first = lastTo(s, 'recordsResponse');
        const find = jest.spyOn(mockDb.current.gameRecords, 'find');
        const res = await records(undefined, s);
        expect(find).not.toHaveBeenCalled();
        expect(res.records.thisMonth.superlatives).toEqual(first.records.thisMonth.superlatives);
        expect(res.records.thisMonth.superlatives.length).toBeGreaterThan(0);
    });

    test('over the soft limit with the entry EXPIRED (past 60 s, never invalidated): the stale records, superlatives included, no find', async () => {
        const first = await records();
        expect(profile._peekRecordsCache()).toBeDefined();
        // a game the stale reply must not show yet (inserted behind the handlers' back: no invalidation)
        for (const g of times(5, () => humanGame(['Bo', 'Cy', 'Di', 'Ed'], THIS_MONTH(), { overrides: { Bo: { totalBags: 12 } } }))) await mockDb.current.gameRecords.insertOne(g);
        const realNow = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(realNow + 61 * 1000);
        const over = jest.spyOn(rateLimiter, 'check').mockReturnValue(false);
        const find = jest.spyOn(mockDb.current.gameRecords, 'find');

        const stale = await records();
        expect(find).not.toHaveBeenCalled();
        expect(stale.success).toBe(true);
        expect(stale.records.thisMonth.superlatives).toEqual(first.records.thisMonth.superlatives);
        expect(byId(stale.records.thisMonth.superlatives).bagBoy.names).toEqual(['Ann']);

        // under the limit at the same moment the entry refills: it really was expired
        over.mockRestore();
        const fresh = await records();
        expect(find).toHaveBeenCalled();
        expect(byId(fresh.records.thisMonth.superlatives).bagBoy).toMatchObject({ names: ['Bo'], detail: '12.0 bags a game' });
    });

    test('over the soft limit while a fill is running (nothing cached): that fill\'s records, superlatives included', async () => {
        expect(profile._peekRecordsCache()).toBeUndefined();
        const find = jest.spyOn(mockDb.current.gameRecords, 'find');
        const pending = records(); // starts the fill; not awaited
        const over = jest.spyOn(rateLimiter, 'check').mockReturnValue(false);
        const throttled = await records();
        over.mockRestore();
        const normal = await pending;
        expect(throttled.success).toBe(true);
        expect(throttled.records.thisMonth.superlatives.length).toBeGreaterThan(0);
        expect(throttled.records).toEqual(normal.records);
        // one fill: the three period finds, once
        expect(find).toHaveBeenCalledTimes(3);
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
        // all five tied on HSI too: Cursed would name the Lucky Ducks again, so it is left out
        expect(res.records.thisMonth.superlatives.map((s) => s.id)).toEqual(['bagBoy', 'luckyDuck', 'botFriends', 'delusionsOfGrandeur']);
        // the always-on contract guard (makeIo) saw no violation
        expect(require('../../testUtils/contractCheck').takeViolations()).toEqual([]);
    });
});

describe('All Time account titles from the leaderboard totals (2026-11-24)', () => {
    /** A stats bucket of `games` games of 13 hands with `sets` sets and `hsi` avg HSI. */
    const bucket = (games, sets, hsi = 100) => ({
        gamesPlayed: games, wins: Math.floor(games / 2), losses: games - Math.floor(games / 2), draws: 0, totalPoints: games * 200,
        totalTricksBid: games * 20, totalTricksTaken: games * 20, totalHands: games * 13, totalSets: sets,
        totalSetPoints: sets * 10, totalFaults: 0, totalHSI: games * 13 * hsi
    });
    const legacy = (names, completedAt) => ({ gameId: `l${++id}`, team1Score: 100, team2Score: 90, team1Players: [names[0], names[2]], team2Players: [names[1], names[3]], completedAt });
    async function board(data) {
        const s = sock();
        if (data === undefined) await profile.getLeaderboard(s, io);
        else await profile.getLeaderboard(s, io, data);
        return lastTo(s, 'leaderboardResponse').leaderboard;
    }

    /**
     * Hannah (Danny's report): 40 games this month before the per-seat
     * counters, 2 bad recent ones with them; her lifetime Set % is 9%.
     */
    function hannahDb({ users = [] } = {}) {
        const table = ['Hannah', 'Ben', 'Cat', 'Dan'];
        mockDb.current = createMemoryDb({
            users: [
                { username: 'Hannah', password: 'x', stats: bucket(42, 49, 95), botStats: bucket(3, 30, 150) },
                { username: 'Ben', password: 'x', stats: bucket(42, 60, 105) },
                { username: 'Cat', password: 'x', stats: bucket(42, 20, 100) },
                { username: 'Dan', password: 'x', stats: bucket(42, 40, 100) },
                ...users
            ],
            gameRecords: [
                ...times(40, () => legacy(table, THIS_MONTH())),
                ...times(2, () => humanGame(table, THIS_MONTH(), { overrides: { Hannah: { totalSets: 5 }, Ben: { totalSets: 0 }, Cat: { totalSets: 0 }, Dan: { totalSets: 0 } } }))
            ]
        });
    }

    test('Hannah: no per-seat title this month or this year on 2 counted games; All Time Delusions of Grandeur = her leaderboard Set %', async () => {
        hannahDb();
        const res = await records();
        for (const period of ['thisMonth', 'thisYear']) {
            const named = res.records[period].superlatives.flatMap((x) => x.names);
            expect(named).not.toContain('Hannah');
            // nobody has 5 games with per-seat counters
            expect(res.records[period].superlatives).toEqual([]);
        }
        const all = byId(res.records.allTime.superlatives);
        // Ben: 60 sets in 546 hands = 10.99%
        expect(all.delusionsOfGrandeur).toEqual({ id: 'delusionsOfGrandeur', title: 'Delusions of Grandeur', names: ['Ben'], detail: '11% of hands set' });
        const rows = Object.fromEntries((await board()).map((r) => [r.username, r]));
        expect(all.delusionsOfGrandeur.detail).toBe(`${Math.round(rows.Ben.setRate)}% of hands set`);
        expect(all.luckyDuck).toEqual({ id: 'luckyDuck', title: 'Lucky Duck', names: ['Ben'], detail: `${rows.Ben.avgHSI.toFixed(1)} avg HSI` });
        expect(all.cursed).toEqual({ id: 'cursed', title: 'Cursed', names: ['Hannah'], detail: `${rows.Hannah.avgHSI.toFixed(1)} avg HSI` });

        // the value IS hers too: with Ben gone she wins at her own Set %
        await mockDb.current.users.updateOne({ username: 'Ben' }, { $set: { 'stats.totalSets': 0 } });
        await mockDb.current.users.updateOne({ username: 'Dan' }, { $set: { 'stats.totalSets': 0 } });
        profile.invalidateRecords();
        profile.invalidateLeaderboard();
        const hers = byId((await records()).records.allTime.superlatives).delusionsOfGrandeur;
        const row = (await board()).find((r) => r.username === 'Hannah');
        expect(hers).toEqual({ id: 'delusionsOfGrandeur', title: 'Delusions of Grandeur', names: ['Hannah'], detail: `${Math.round(row.setRate)}% of hands set` });
        expect(hers.detail).toBe('9% of hands set');
    });

    test('per scope, as the leaderboard: human = stats, bots = botStats, all = both summed; eligibility = gamesPlayed in that scope', async () => {
        hannahDb({ users: [
            // 3 + 3 games: only 'all' has 5; a lot of sets
            { username: 'Mia', password: 'x', stats: bucket(3, 30), botStats: bucket(3, 30) },
            // bots only
            { username: 'Bo', password: 'x', botStats: bucket(8, 52, 120) }
        ] });
        // a bot game so the bots / all All Time periods are not null
        await mockDb.current.gameRecords.insertOne(soloGame('Bo', THIS_MONTH()));
        for (const scope of ['human', 'bots', 'all']) {
            const res = await records({ scope });
            const lb = await board({ scope });
            const ranked = lb.filter((r) => !r.isPopulation);
            const best = (key) => ranked.reduce((a, r) => (r[key] > a[key] ? r : a));
            const worst = (key) => ranked.reduce((a, r) => (r[key] < a[key] ? r : a));
            const all = byId(res.records.allTime.superlatives);
            expect(all.delusionsOfGrandeur).toMatchObject({ names: [best('setRate').username], detail: `${Math.round(best('setRate').setRate)}% of hands set` });
            expect(all.luckyDuck).toMatchObject({ names: [best('avgHSI').username], detail: `${best('avgHSI').avgHSI.toFixed(1)} avg HSI` });
            if (ranked.length > 1) expect(all.cursed).toMatchObject({ names: [worst('avgHSI').username] });
            // the candidates are exactly the ranked leaderboard players
            expect(ranked.map((r) => r.username).sort()).toEqual({
                human: ['Ben', 'Cat', 'Dan', 'Hannah'], bots: ['Bo'], all: ['Ben', 'Bo', 'Cat', 'Dan', 'Hannah', 'Mia']
            }[scope]);
        }
        // Mia's 60 sets in 78 hands: all only
        expect(byId((await records({ scope: 'all' })).records.allTime.superlatives).delusionsOfGrandeur).toMatchObject({ names: ['Mia'], detail: '77% of hands set' });
        expect(byId((await records({ scope: 'human' })).records.allTime.superlatives).delusionsOfGrandeur.names).toEqual(['Ben']);
        // bots: Bo alone, Cursed left out (the same value as Lucky Duck)
        const bots = byId((await records({ scope: 'bots' })).records.allTime.superlatives);
        expect(bots.delusionsOfGrandeur).toMatchObject({ names: ['Bo'], detail: '50% of hands set' });
        expect(bots.luckyDuck).toMatchObject({ names: ['Bo'], detail: '120.0 avg HSI' });
        expect(bots.cursed).toBeUndefined();
    });

    test('merged-away and deleted accounts (tombstones) never win, as on the leaderboard', async () => {
        hannahDb({ users: [
            { username: 'OldBen', mergedInto: 'Ben', mergedAt: new Date(), stats: bucket(50, 600, 300) },
            { username: 'Gone', mergedInto: '[deleted]', deletedAt: new Date(), stats: bucket(50, 600, 1) },
            { username: '[deleted]', password: 'x', stats: bucket(50, 600, 1) }
        ] });
        const all = byId((await records()).records.allTime.superlatives);
        const named = Object.values(all).flatMap((x) => x.names);
        for (const nope of ['OldBen', 'Gone', '[deleted]']) expect(named).not.toContain(nope);
        expect(all.delusionsOfGrandeur.names).toEqual(['Ben']);
        expect(all.cursed.names).toEqual(['Hannah']);
        expect((await board()).map((r) => r.username)).not.toContain('OldBen');
    });

    test('ties among accounts: up to 3 names, alphabetical, (+N more)', async () => {
        mockDb.current = createMemoryDb({
            users: ['dora', 'Bob', 'alice', 'Carl', 'Eve'].map((username) => ({ username, password: 'x', stats: bucket(10, 13) })),
            gameRecords: [humanGame(['Bob', 'Carl', 'dora', 'Eve'], LAST_YEAR())]
        });
        const all = byId((await records()).records.allTime.superlatives);
        expect(all.delusionsOfGrandeur).toEqual({ id: 'delusionsOfGrandeur', title: 'Delusions of Grandeur', names: ['alice', 'Bob', 'Carl'], detail: '10% of hands set (+2 more)' });
        expect(all.luckyDuck.detail).toBe('100.0 avg HSI (+2 more)');
        expect(all.cursed).toBeUndefined();
    });

    test('the users read: one narrow, filtered find per fill, never from the cache; a failed read falls back to the records', async () => {
        hannahDb();
        const find = jest.spyOn(mockDb.current.users, 'find');
        await records();
        expect(find).toHaveBeenCalledTimes(1);
        const [filter, options] = find.mock.calls[0];
        expect(filter).toEqual({ 'stats.gamesPlayed': { $gte: 5 }, mergedInto: { $exists: false } });
        expect(options.projection).toEqual({ _id: 0, username: 1, 'stats.gamesPlayed': 1, 'stats.totalHands': 1, 'stats.totalSets': 1, 'stats.totalHSI': 1 });
        await records();
        expect(find).toHaveBeenCalledTimes(1); // the 60 s cache
        profile.invalidateRecords();
        await records({ scope: 'all' });
        expect(find.mock.calls[1][0]).toEqual({ $or: [{ 'stats.gamesPlayed': { $gt: 0 } }, { 'botStats.gamesPlayed': { $gt: 0 } }], mergedInto: { $exists: false } });
        expect(Object.keys(find.mock.calls[1][1].projection)).toHaveLength(10);
        await records({ scope: 'bots' });
        expect(find.mock.calls[2][0]).toEqual({ 'botStats.gamesPlayed': { $gte: 5 }, mergedInto: { $exists: false } });
        find.mockRestore();

        // the read fails: logged, the records page still answers, All Time from the records
        profile.invalidateRecords();
        const error = jest.spyOn(authLogger, 'error').mockImplementation(() => {});
        jest.spyOn(mockDb.current.users, 'find').mockImplementation(() => { throw new Error('boom'); });
        const res = await records();
        expect(res.success).toBe(true);
        expect(error).toHaveBeenCalledWith('Could not read the accounts for the All Time superlatives', expect.objectContaining({ scope: 'human', error: 'boom' }));
        // nobody has 5 games with per-seat counters
        expect(res.records.allTime.superlatives).toEqual([]);
        expect(require('../../testUtils/contractCheck').takeViolations()).toEqual([]);
    });
});
