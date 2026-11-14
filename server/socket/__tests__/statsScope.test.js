/**
 * Stats scopes (server/utils/statsScope.js; owner 2026-11-13): human games
 * (users.stats, records without withBots), bot games (users.botStats,
 * withBots records) and all (both). The default and any unknown payload is
 * exactly today's reply; a request that names a scope gets it echoed; every
 * scope has its own cache and every invalidate clears them all; account
 * delete / rename carry botStats like stats.
 */

const bcrypt = require('bcryptjs');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    getPasswordResetsCollection: () => mockDb.current.passwordResets
}));

const gameManager = require('../../game/GameManager');
const profile = require('../profileHandlers');
const auth = require('../authHandlers');
const { asyncHandler } = require('../errorHandler');
const { normalizeScope, sumBuckets, STAT_KEYS } = require('../../utils/statsScope');
const { renameUserDoc, renameEverywhere, finishRename } = require('../../admin/accountRename');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');

let log;
let io;
let n = 0;
const sock = () => makeSocket(`ss-${++n}`, log, io);
const lastTo = (socket, event) => log.filter(l => l.to === `self:${socket.id}` && l.event === event).pop()?.data;

const stats = (g, w, extra = {}) => ({ wins: w, losses: g - w, draws: 0, gamesPlayed: g, totalPoints: g * 200, totalTricksBid: g * 10, totalTricksTaken: g * 11, totalHands: g * 13, totalSets: g, totalSetPoints: -g * 30, totalFaults: 0, totalHSI: g * 100, ...extra });

const MONTH_START = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1, 12); };

beforeEach(async () => {
    log = [];
    io = makeIo(log);
    profile._resetCachesForTests();
    gameManager.deletedUsernames.clear();
    mockDb.current = createMemoryDb({
        users: [
            { username: 'Ann', password: await bcrypt.hash('pw', 4), profilePic: 2, stats: stats(4, 3), botStats: stats(10, 2) },
            { username: 'Ben', profilePic: 3, stats: stats(2, 1) },
            // only bot games
            { username: 'Cat', profilePic: 4, botStats: stats(5, 5) },
            // a legacy sign-up document: 6 keys only
            { username: 'Dan', profilePic: 5, stats: { wins: 1, losses: 0, draws: 0, gamesPlayed: 1, totalPoints: 100, totalTricksBid: 3 } },
            { username: 'OldAnn', mergedInto: 'Ann', mergedAt: new Date(), botStats: stats(99, 99) }
        ],
        gameRecords: [
            { gameId: 'h1', team1Score: 310, team2Score: 120, team1Players: ['Ann', 'Dan'], team2Players: ['Ben', 'Eve'], team1Bags: 2, team2Bags: 1, completedAt: MONTH_START() },
            { gameId: 'b1', withBots: true, team1Score: 900, team2Score: -400, team1Players: ['Cat'], team2Players: [], team1Bots: ['🤖 Mary'], team2Bots: ['🤖 Zach', '🤖 Mike'], team1Bags: 9, team2Bags: -6, completedAt: MONTH_START() },
            { gameId: 'b2', withBots: true, team1Score: 150, team2Score: 200, team1Players: ['Ann', 'Ben'], team2Players: ['Cat'], team1Bots: [], team2Bots: ['🤖 Sharon'], team1Bags: 0, team2Bags: 3, completedAt: MONTH_START() }
        ]
    });
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

async function call(handler, data, socket = sock(), event) {
    if (data === undefined) await handler(socket, io);
    else await handler(socket, io, data);
    return lastTo(socket, event);
}
const leaderboard = (data, s) => call(profile.getLeaderboard, data, s, 'leaderboardResponse');
const records = (data, s) => call(profile.getRecords, data, s, 'recordsResponse');
const row = (res, name) => res.leaderboard.find(r => r.username === name);
const names = (res) => res.leaderboard.map(r => r.username).sort();

/** A finished game for recordGameStats: seats 1..4, `bots` maps position -> persona name. */
function finishedGame({ humans = { 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' }, bots = {}, lazy = [] } = {}) {
    const seats = [1, 2, 3, 4].map((pos) => {
        if (humans[pos]) return { position: pos, controller: lazy.includes(pos) ? 'lazyBot' : 'human', ownerUsername: humans[pos] };
        return { position: pos, controller: 'bot', ownerUsername: null };
    });
    return {
        gameId: `g-${Object.keys(bots).join('') || 'h'}`,
        score: { team1: 420, team2: 150 },
        seatList: () => seats,
        seat: (pos) => seats[pos - 1],
        getOriginalPlayer: (pos) => ({ username: humans[pos] || bots[pos] }),
        getPlayerByPosition: (pos) => ({ username: humans[pos] || bots[pos] }),
        handStats: { totalHands: 13, team1Sets: 1, team2Sets: 3, team1SetPoints: -20, team2SetPoints: -90 },
        playerStats: { 1: { totalBids: 5, totalTricks: 6 }, 2: { totalBids: 4, totalTricks: 3 }, 3: { totalBids: 2, totalTricks: 2 }, 4: { totalBids: 3, totalTricks: 2 } }
    };
}

describe('normalizeScope', () => {
    test('missing, non-object or unknown is human; only a scope key is echoed', () => {
        expect(normalizeScope(undefined)).toEqual({ scope: 'human', echo: false });
        expect(normalizeScope(null)).toEqual({ scope: 'human', echo: false });
        expect(normalizeScope('bots')).toEqual({ scope: 'human', echo: false });
        expect(normalizeScope(['bots'])).toEqual({ scope: 'human', echo: false });
        expect(normalizeScope({})).toEqual({ scope: 'human', echo: false });
        expect(normalizeScope({ scope: 'bots' })).toEqual({ scope: 'bots', echo: true });
        expect(normalizeScope({ scope: 'all' })).toEqual({ scope: 'all', echo: true });
        expect(normalizeScope({ scope: 'human' })).toEqual({ scope: 'human', echo: true });
        expect(normalizeScope({ scope: 'BOTS' })).toEqual({ scope: 'human', echo: true });
        expect(normalizeScope({ scope: { $ne: 1 } })).toEqual({ scope: 'human', echo: true });
        expect(normalizeScope({ scope: undefined })).toEqual({ scope: 'human', echo: true });
    });

    test('sumBuckets adds field by field over the 12 keys (missing = 0)', () => {
        expect(sumBuckets({ wins: 1, gamesPlayed: 2 }, undefined)).toEqual(Object.fromEntries(STAT_KEYS.map(k => [k, k === 'wins' ? 1 : k === 'gamesPlayed' ? 2 : 0])));
        expect(sumBuckets(stats(1, 1), stats(2, 0)).gamesPlayed).toBe(3);
    });
});

describe('default / invalid payloads give today\'s exact reply', () => {
    test('leaderboard: no payload, {}, null, a string and {foo} are all byte-identical and carry no scope', async () => {
        const base = await leaderboard(undefined);
        expect(Object.keys(base)).toEqual(['success', 'leaderboard']);
        for (const data of [{}, null, 'bots', { foo: 1 }, 42]) {
            expect(JSON.stringify(await leaderboard(data))).toBe(JSON.stringify(base));
        }
        // human rows: only stats; Cat (bot games only) has no row; the tombstone never
        expect(names(base)).toEqual(['Ann', 'Ben', 'Dan', 'Population']);
        expect(row(base, 'Ann').gamesPlayed).toBe(4);
    });

    test('an unknown scope is human, echoed as human', async () => {
        const base = await leaderboard(undefined);
        const res = await leaderboard({ scope: 'everything' });
        expect(res.scope).toBe('human');
        const { scope, ...rest } = res;
        expect(JSON.stringify(rest)).toBe(JSON.stringify(base));
        expect(await leaderboard({ scope: 'human' })).toEqual({ ...base, scope: 'human' });
    });

    test('records: no payload equals {} and an unknown payload; only human games, today\'s projection', async () => {
        const find = jest.spyOn(mockDb.current.gameRecords, 'find');
        const base = await records(undefined);
        expect(Object.keys(base)).toEqual(['success', 'records', 'totalGames']);
        expect(base.totalGames).toBe(1);
        expect(base.records.allTime.highestScore).toEqual({ score: 310, players: ['Ann', 'Dan'] });
        expect(find).toHaveBeenCalledTimes(3);
        for (const [filter, opts] of find.mock.calls) {
            expect(filter.withBots).toEqual({ $ne: true });
            expect(opts.projection).toEqual({ _id: 0, team1Score: 1, team2Score: 1, team1Players: 1, team2Players: 1, team1Bags: 1, team2Bags: 1 });
        }
        for (const data of [{}, null, 'all', [1]]) expect(JSON.stringify(await records(data))).toBe(JSON.stringify(base));
    });

    test('profile: no payload is the raw stored stats (a legacy 6-key document stays 6 keys)', async () => {
        const me = sock();
        gameManager.registerUser(me.id, 'Dan');
        const res = await call(profile.getProfile, undefined, me, 'profileResponse');
        expect(Object.keys(res)).toEqual(['success', 'profile']);
        expect(res.profile.stats).toEqual({ wins: 1, losses: 0, draws: 0, gamesPlayed: 1, totalPoints: 100, totalTricksBid: 3 });
        expect(JSON.stringify(await call(profile.getProfile, {}, me, 'profileResponse'))).toBe(JSON.stringify(res));
        expect(await call(profile.getProfile, { scope: 'human' }, me, 'profileResponse')).toEqual({ ...res, scope: 'human' });
    });
});

describe('bots and all scopes', () => {
    test('leaderboard bots: botStats only, players with a bot game; Population over them', async () => {
        const res = await leaderboard({ scope: 'bots' });
        expect(res.scope).toBe('bots');
        expect(names(res)).toEqual(['Ann', 'Cat', 'Population']);
        expect(row(res, 'Ann')).toMatchObject({ gamesPlayed: 10, winRate: 20 });
        expect(row(res, 'Cat')).toMatchObject({ gamesPlayed: 5, winRate: 100 });
        expect(row(res, 'Population')).toMatchObject({ gamesPlayed: Math.round((10 + 5) / 2), winRate: 60 });
        // human board unchanged
        expect(row(await leaderboard({}), 'Ann').gamesPlayed).toBe(4);
    });

    test('leaderboard all: stats + botStats field by field; anyone with a game in either', async () => {
        const res = await leaderboard({ scope: 'all' });
        expect(names(res)).toEqual(['Ann', 'Ben', 'Cat', 'Dan', 'Population']);
        expect(row(res, 'Ann')).toMatchObject({ gamesPlayed: 14, winRate: (5 / 14) * 100, pointsPerGame: 200 });
        expect(row(res, 'Cat')).toMatchObject({ gamesPlayed: 5 });
        expect(row(res, 'Dan')).toMatchObject({ gamesPlayed: 1, bidsPerGame: 3 });
        // the tombstone's leftovers never count
        expect(names(res)).not.toContain('OldAnn');
    });

    test('records bots: only withBots games; players list humans then bots; an all-bot team holds no team record', async () => {
        const res = await records({ scope: 'bots' });
        expect(res.scope).toBe('bots');
        expect(res.totalGames).toBe(2);
        const p = res.records.thisMonth;
        // b1 team1 (Cat + a bot) holds the highest score; b1 team2 (two bots, -400) never holds lowest
        expect(p.highestScore).toEqual({ score: 900, players: ['Cat', '🤖 Mary'] });
        expect(p.lowestScore).toEqual({ score: 150, players: ['Ann', 'Ben'] });
        expect(p.biggestWin).toEqual({ margin: 1300, winnerScore: 900, loserScore: -400, winnerPlayers: ['Cat', '🤖 Mary'], loserPlayers: ['🤖 Zach', '🤖 Mike'] });
        expect(p.mostBags).toEqual({ bags: 9, players: ['Cat', '🤖 Mary'] });
        expect(p.leastBags).toEqual({ bags: 0, players: ['Ann', 'Ben'] });
        for (const period of ['allTime', 'thisYear', 'thisMonth']) {
            for (const r of Object.values(res.records[period])) {
                for (const k of ['players', 'winnerPlayers', 'loserPlayers']) {
                    if (r[k]) expect(r[k].every(x => typeof x === 'string')).toBe(true);
                }
            }
        }
    });

    test('records all: every game; human records unchanged by bot games', async () => {
        const res = await records({ scope: 'all' });
        expect(res.totalGames).toBe(3);
        expect(res.records.allTime.highestScore.score).toBe(900);
        expect(res.records.allTime.lowestScore).toEqual({ score: 120, players: ['Ben', 'Eve'] });
        const human = await records({ scope: 'human' });
        expect(human.totalGames).toBe(1);
        expect(human.records.allTime.highestScore.score).toBe(310);
    });

    test('profile and player profile: bots = botStats (12 keys), all = the sum; Joi keeps scope for getPlayerProfile', async () => {
        const me = sock();
        gameManager.registerUser(me.id, 'Ann');
        const bots = await call(profile.getProfile, { scope: 'bots' }, me, 'profileResponse');
        expect(bots.scope).toBe('bots');
        expect(bots.profile.stats).toEqual(stats(10, 2));
        const all = await call(profile.getProfile, { scope: 'all' }, me, 'profileResponse');
        expect(all.profile.stats).toEqual(sumBuckets(stats(4, 3), stats(10, 2)));

        const handler = asyncHandler('getPlayerProfile', profile.getPlayerProfile);
        const other = sock();
        await handler(other, io, { username: 'Ben', scope: 'bots' });
        const ben = lastTo(other, 'playerProfileResponse');
        expect(ben.scope).toBe('bots');
        expect(ben.profile.stats).toEqual(Object.fromEntries(STAT_KEYS.map(k => [k, 0])));
        await handler(other, io, { username: 'Cat', scope: 'all' });
        expect(lastTo(other, 'playerProfileResponse').profile.stats.gamesPlayed).toBe(5);
        // an unknown scope is not refused by Joi: human, echoed
        await handler(other, io, { username: 'Ann', scope: 'weird' });
        expect(lastTo(other, 'playerProfileResponse')).toMatchObject({ success: true, scope: 'human', profile: { stats: stats(4, 3) } });
        // no scope: today's reply exactly
        await handler(other, io, { username: 'Ann' });
        expect(Object.keys(lastTo(other, 'playerProfileResponse'))).toEqual(['success', 'profile']);
        // a merged name follows to the kept account in the scope asked for
        await handler(other, io, { username: 'OldAnn', scope: 'bots' });
        expect(lastTo(other, 'playerProfileResponse').profile).toMatchObject({ username: 'Ann', stats: stats(10, 2) });
        expect(log.filter(l => l.event === 'error')).toEqual([]);
    });

    test('failures carry no scope', async () => {
        const nobody = sock();
        expect(await call(profile.getProfile, { scope: 'bots' }, nobody, 'profileResponse')).toEqual({ success: false, message: 'User not found' });
        const s = sock();
        await profile.getPlayerProfile(s, io, { username: 'Nobody', scope: 'all' });
        expect(lastTo(s, 'playerProfileResponse')).toEqual({ success: false, message: 'Player not found' });
    });
});

describe('caches per scope', () => {
    test('each scope fills its own cache; a second fetch of each is served without a find', async () => {
        await leaderboard({ scope: 'human' });
        await leaderboard({ scope: 'bots' });
        await leaderboard({ scope: 'all' });
        expect(profile._peekLeaderboardCache('human')).not.toBe(profile._peekLeaderboardCache('bots'));
        const find = jest.spyOn(mockDb.current.users, 'find');
        expect(names(await leaderboard({ scope: 'bots' }))).toEqual(['Ann', 'Cat', 'Population']);
        expect(names(await leaderboard(undefined))).toEqual(['Ann', 'Ben', 'Dan', 'Population']);
        expect(find).not.toHaveBeenCalled();
    });

    test('one invalidate (a recorded bot game) clears every scope; the bot game shows only in bots / all', async () => {
        for (const scope of ['human', 'bots', 'all']) {
            await leaderboard({ scope });
            await records({ scope });
        }
        await profile.recordGameStats(finishedGame({ humans: { 1: 'Ann', 3: 'Ben' }, bots: { 2: '🤖 Mary', 4: '🤖 Zach' } }));
        for (const scope of ['human', 'bots', 'all']) {
            expect(profile._peekLeaderboardCache(scope)).toBeUndefined();
            expect(profile._peekRecordsCache(scope)).toBeUndefined();
        }
        expect(row(await leaderboard({}), 'Ann').gamesPlayed).toBe(4);
        expect(row(await leaderboard({ scope: 'bots' }), 'Ann').gamesPlayed).toBe(11);
        expect(row(await leaderboard({ scope: 'bots' }), 'Ben').gamesPlayed).toBe(1);
        expect(row(await leaderboard({ scope: 'all' }), 'Ann').gamesPlayed).toBe(15);
        expect((await records({})).totalGames).toBe(1);
        expect((await records({ scope: 'bots' })).totalGames).toBe(3);
        expect((await records({ scope: 'all' })).totalGames).toBe(4);
        const doc = mockDb.current.gameRecords.docs.find(d => d.gameId === 'g-24');
        expect(doc).toMatchObject({ withBots: true, team1Players: ['Ann', 'Ben'], team2Players: [], team1Bots: [], team2Bots: ['🤖 Mary', '🤖 Zach'] });
        // no account for a bot
        expect(mockDb.current.users.docs.some(d => d.username.startsWith('🤖'))).toBe(false);
    });

    test('a human game (lazy seat included) changes only the human bucket and human records', async () => {
        await profile.recordGameStats(finishedGame({ lazy: [2] }));
        expect(row(await leaderboard({}), 'Ann').gamesPlayed).toBe(5);
        expect(row(await leaderboard({ scope: 'bots' }), 'Ann').gamesPlayed).toBe(10);
        expect((await records({})).totalGames).toBe(2);
        expect((await records({ scope: 'bots' })).totalGames).toBe(2);
        const doc = mockDb.current.gameRecords.docs.find(d => d.gameId === 'g-h');
        expect(Object.keys(doc).sort()).toEqual(['_id', 'completedAt', 'gameId', 'team1Bags', 'team1Players', 'team1Score', 'team2Bags', 'team2Players', 'team2Score']);
        expect(mockDb.current.users.docs.find(d => d.username === 'Cat').stats.gamesPlayed).toBe(1);
    });

    test('a profile picture change clears every scope', async () => {
        for (const scope of ['human', 'bots', 'all']) await leaderboard({ scope });
        const me = sock();
        gameManager.registerUser(me.id, 'Cat');
        await profile.updateProfilePic(me, io, { profilePic: 77 });
        for (const scope of ['human', 'bots', 'all']) expect(profile._peekLeaderboardCache(scope)).toBeUndefined();
        expect(row(await leaderboard({ scope: 'bots' }), 'Cat').profilePic).toBe(77);
    });

    test('the month rollover clears every records scope', async () => {
        jest.useFakeTimers({ now: new Date(2026, 9, 31, 23, 59, 0), doNotFake: ['setImmediate', 'nextTick'] });
        for (const d of mockDb.current.gameRecords.docs) d.completedAt = new Date(2026, 9, 31, 12, 0, 0);
        const oct = await records({ scope: 'bots' });
        expect(oct.records.thisMonth).not.toBeNull();
        await records({ scope: 'all' });
        jest.setSystemTime(new Date(2026, 10, 1, 0, 0, 30));
        // a human fetch notices the new month first
        expect((await records({})).records.thisMonth).toBeNull();
        expect(profile._peekRecordsCache('bots')).toBeUndefined();
        expect(profile._peekRecordsCache('all')).toBeUndefined();
        const nov = await records({ scope: 'bots' });
        expect(nov.records.thisMonth).toBeNull();
        expect(nov.records.allTime).toEqual(oct.records.allTime);
    });

    test('over the shared limit, a throttled request gets ITS scope\'s cached rows', async () => {
        const s = sock();
        await leaderboard({ scope: 'bots' }, sock());
        await leaderboard({ scope: 'human' }, sock());
        for (let i = 0; i < 10; i++) await leaderboard({ scope: i % 2 ? 'all' : 'human' }, s);
        const find = jest.spyOn(mockDb.current.users, 'find');
        const res = await leaderboard({ scope: 'bots' }, s);
        expect(find).not.toHaveBeenCalled();
        expect(res.scope).toBe('bots');
        expect(names(res)).toEqual(['Ann', 'Cat', 'Population']);
        // a scope never filled: the plain failure (no scope echo)
        profile.invalidateLeaderboard();
        expect(await leaderboard({ scope: 'all' }, s)).toEqual({ success: false, message: 'Too many requests. Please wait a moment.' });
        expect(log.filter(l => l.event === 'error')).toEqual([]);
    });

    test('records over the limit: that scope\'s cached records', async () => {
        const s = sock();
        for (let i = 0; i < 10; i++) await records({ scope: 'all' }, s);
        await records({ scope: 'bots' }, sock());
        const res = await records({ scope: 'bots' }, s);
        expect(res).toMatchObject({ success: true, scope: 'bots', totalGames: 2 });
    });
});

describe('account delete and rename carry botStats', () => {
    test('a deleted account leaves the bots / all boards; its name in a bot game becomes [deleted], the bots stay', async () => {
        for (const scope of ['bots', 'all']) await leaderboard({ scope });
        const me = sock();
        gameManager.registerUser(me.id, 'Ann');
        jest.useFakeTimers();
        await auth.deleteAccount(me, io, { password: 'pw' });
        jest.useRealTimers();
        expect(lastTo(me, 'deleteAccountResponse')).toEqual({ success: true });
        expect(names(await leaderboard({ scope: 'bots' }))).toEqual(['Cat', 'Population']);
        expect(names(await leaderboard({ scope: 'all' }))).not.toContain('Ann');
        const b2 = mockDb.current.gameRecords.docs.find(d => d.gameId === 'b2');
        expect(b2.team1Players).toEqual(['[deleted]', 'Ben']);
        expect(b2.team2Bots).toEqual(['🤖 Sharon']);
        const rec = await records({ scope: 'bots' });
        expect(rec.records.allTime.lowestScore.players).toEqual(['[deleted]', 'Ben']);
    });

    test('a bot game finished after its player deleted the account records [deleted] and credits nobody', async () => {
        gameManager.deletedUsernames.add('Ann');
        await profile.recordGameStats(finishedGame({ humans: { 1: 'Ann' }, bots: { 2: '🤖 Mary', 3: '🤖 Zach', 4: '🤖 Mike' } }));
        const doc = mockDb.current.gameRecords.docs.find(d => d.gameId === 'g-234');
        expect(doc).toMatchObject({ withBots: true, team1Players: ['[deleted]'], team1Bots: ['🤖 Zach'] });
    });

    test('a rename keeps botStats; a bot game\'s humans are renamed, its bots are not', async () => {
        const ann = mockDb.current.users.docs.find(d => d.username === 'Ann');
        const r = await renameUserDoc(mockDb.current, ann, 'Annie');
        expect(r.ok).toBe(true);
        await renameEverywhere(mockDb.current, 'Ann', 'Annie', { selfId: ann._id });
        await finishRename(mockDb.current, ann._id, 'Ann');
        profile.invalidateLeaderboard();
        profile.invalidateRecords();
        const renamed = mockDb.current.users.docs.find(d => d.username === 'Annie');
        expect(renamed.botStats).toEqual(stats(10, 2));
        expect(row(await leaderboard({ scope: 'bots' }), 'Annie').gamesPlayed).toBe(10);
        const b2 = mockDb.current.gameRecords.docs.find(d => d.gameId === 'b2');
        expect(b2.team1Players).toEqual(['Annie', 'Ben']);
        expect(b2.team2Bots).toEqual(['🤖 Sharon']);
        const b1 = mockDb.current.gameRecords.docs.find(d => d.gameId === 'b1');
        expect(b1.team2Bots).toEqual(['🤖 Zach', '🤖 Mike']);
    });
});
