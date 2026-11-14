/**
 * The leaderboard minimum (owner 2026-11-14): a player gets a ranked row in
 * a scope only from LEADERBOARD_MIN_GAMES (5) games in that scope. Players
 * below it are left out (not listed unranked, so every shipped client is
 * right as is) but still count toward that scope's Population row. Profiles
 * are unaffected.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    getPasswordResetsCollection: () => mockDb.current.passwordResets
}));

const profile = require('../profileHandlers');
const { asyncHandler } = require('../errorHandler');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');

let log;
let io;
let n = 0;
const sock = () => makeSocket(`lm-${++n}`, log, io);
const lastTo = (socket, event) => log.filter(l => l.to === `self:${socket.id}` && l.event === event).pop()?.data;

const stats = (g, w) => ({ wins: w, losses: g - w, draws: 0, gamesPlayed: g, totalPoints: g * 200, totalTricksBid: g * 10, totalTricksTaken: g * 11, totalHands: g * 13, totalSets: g, totalSetPoints: -g * 30, totalFaults: 0, totalHSI: g * 100 });

function seed(users) {
    mockDb.current = createMemoryDb({ users, gameRecords: [] });
}

beforeEach(() => {
    log = [];
    io = makeIo(log);
    profile._resetCachesForTests();
    seed([
        // exactly the minimum: ranked
        { username: 'Ann', profilePic: 2, stats: stats(5, 1) },
        // one short, and a perfect record: not ranked, yet in Population
        { username: 'Ben', profilePic: 3, stats: stats(4, 4) },
        // bot games only
        { username: 'Cat', profilePic: 4, botStats: stats(6, 3) },
        // 3 human + 2 bot: short in each, 5 in all
        { username: 'Dan', profilePic: 5, stats: stats(3, 0), botStats: stats(2, 2) },
        // a merged-away tombstone never counts
        { username: 'Old', mergedInto: 'Ann', mergedAt: new Date(), stats: stats(50, 50), botStats: stats(50, 50) }
    ]);
});

async function board(data) {
    const s = sock();
    if (data === undefined) await profile.getLeaderboard(s, io);
    else await profile.getLeaderboard(s, io, data);
    return lastTo(s, 'leaderboardResponse');
}
const names = (res) => res.leaderboard.map(r => r.username);
const population = (res) => res.leaderboard.find(r => r.isPopulation);
const avg = (...xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

test('the minimum is 5', () => {
    expect(profile.LEADERBOARD_MIN_GAMES).toBe(5);
});

test('human: 5 games is ranked, 4 is not; Population averages every human player', async () => {
    const res = await board();
    expect(res.success).toBe(true);
    // sorted by win rate as before: Population 40 % above Ann 20 %
    expect(names(res)).toEqual(['Population', 'Ann']);
    const pop = population(res);
    // Ann 20 %, Ben 100 %, Dan 0 %: Ben's unranked games still move the average
    expect(pop.winRate).toBeCloseTo(avg(20, 100, 0));
    expect(pop.gamesPlayed).toBe(Math.round(avg(5, 4, 3)));
    // the ranked row is the full row, as before
    expect(res.leaderboard[1]).toMatchObject({ username: 'Ann', gamesPlayed: 5, winRate: 20 });
});

test('each scope counts its own games', async () => {
    const bots = await board({ scope: 'bots' });
    expect(bots.scope).toBe('bots');
    expect(names(bots)).toEqual(['Population', 'Cat']);
    expect(population(bots).winRate).toBeCloseTo(avg(50, 100));

    const all = await board({ scope: 'all' });
    expect(names(all).sort()).toEqual(['Ann', 'Cat', 'Dan', 'Population']);
    expect(all.leaderboard.find(r => r.username === 'Dan').gamesPlayed).toBe(5);
    expect(population(all).gamesPlayed).toBe(Math.round(avg(5, 4, 6, 5)));
});

test('the 5th game puts a player on the board (on the next fill)', async () => {
    expect(names(await board())).not.toContain('Ben');
    await mockDb.current.users.updateOne({ username: 'Ben' }, { $set: { stats: stats(5, 4) } });
    profile.invalidateLeaderboard();
    const res = await board();
    // Ben 80 %, Population 33.3 % (Ann 20, Ben 80, Dan 0), Ann 20 %
    expect(names(res)).toEqual(['Ben', 'Population', 'Ann']);
});

test('nobody at the minimum: only the Population row; nobody with a game: empty', async () => {
    seed([{ username: 'Ann', stats: stats(2, 1) }, { username: 'Ben', stats: stats(1, 0) }]);
    profile._resetCachesForTests();
    const res = await board();
    expect(names(res)).toEqual(['Population']);
    expect(population(res).winRate).toBeCloseTo(avg(50, 0));

    seed([{ username: 'Ann' }]);
    profile._resetCachesForTests();
    expect((await board()).leaderboard).toEqual([]);
});

test('profiles are unaffected: an unranked player still sees their stats', async () => {
    const handler = asyncHandler('getPlayerProfile', profile.getPlayerProfile);
    const s = sock();
    await handler(s, io, { username: 'Ben' });
    expect(lastTo(s, 'playerProfileResponse').profile.stats).toEqual(stats(4, 4));
});

test('the test hook restores the default', async () => {
    profile._setLeaderboardMinGamesForTests(1);
    expect(names(await board()).sort()).toEqual(['Ann', 'Ben', 'Dan', 'Population']);
    profile._setLeaderboardMinGamesForTests();
    expect(names(await board()).sort()).toEqual(['Ann', 'Population']);
});
