/**
 * Leaderboard / records caches (server/utils/ttlCache.js): they serve a
 * just-finished game, a deletion and a new picture on the next fetch, never
 * cache across an invalidate, and the soft limits answer with the cached
 * page instead of refusing. Search bounds and limits.
 */

const bcrypt = require('bcryptjs');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports
}));

const gameManager = require('../../game/GameManager');
const profile = require('../profileHandlers');
const auth = require('../authHandlers');
const { asyncHandler } = require('../errorHandler');
const { createCache } = require('../../utils/ttlCache');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');

let log;
let io;
let n = 0;
const sock = () => makeSocket(`pc-${++n}`, log, io);
const lastTo = (socket, event) => log.filter(l => l.to === `self:${socket.id}` && l.event === event).pop()?.data;

function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        Object.values(o).forEach(deepFreeze);
    }
    return o;
}

const stats = (g, w) => ({ gamesPlayed: g, wins: w, losses: g - w, totalPoints: g * 200, totalTricksBid: g * 10, totalTricksTaken: g * 11, totalHands: g * 13, totalSets: g, totalSetPoints: -g * 30, totalFaults: 0, totalHSI: g * 100 });

beforeEach(async () => {
    log = [];
    io = makeIo(log);
    profile._resetCachesForTests();
    gameManager.deletedUsernames.clear();
    mockDb.current = createMemoryDb({
        users: [
            { username: 'Ann', password: await bcrypt.hash('pw', 4), profilePic: 2, stats: stats(4, 3) },
            { username: 'Ben', profilePic: 3, stats: stats(2, 1) },
            { username: 'Cat', profilePic: 4, stats: stats(1, 0) },
            { username: 'Dan', profilePic: 5, stats: stats(3, 1) },
            { username: 'OldAnn', mergedInto: 'Ann', mergedAt: new Date() }
        ],
        gameRecords: [
            { gameId: 'r1', team1Score: 310, team2Score: 120, team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Dan'], team1Bags: 2, team2Bags: 1, completedAt: new Date() }
        ]
    });
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

/** Minimal finished 4-human game for recordGameStats. */
function finishedGame(names = ['Ann', 'Ben', 'Cat', 'Dan']) {
    const seats = names.map((u, i) => ({ position: i + 1, controller: 'human', ownerUsername: u }));
    return {
        gameId: 'g-fin',
        score: { team1: 420, team2: 150 },
        seatList: () => seats,
        seat: (pos) => seats[pos - 1],
        getOriginalPlayer: (pos) => ({ username: names[pos - 1] }),
        handStats: { totalHands: 13, team1Sets: 1, team2Sets: 3, team1SetPoints: -20, team2SetPoints: -90 },
        playerStats: { 1: { totalBids: 5, totalTricks: 6 }, 2: { totalBids: 4, totalTricks: 3 }, 3: { totalBids: 2, totalTricks: 2 }, 4: { totalBids: 3, totalTricks: 2 } }
    };
}

async function leaderboard(socket = sock()) {
    await profile.getLeaderboard(socket, io);
    return lastTo(socket, 'leaderboardResponse');
}
async function records(socket = sock()) {
    await profile.getRecords(socket, io);
    return lastTo(socket, 'recordsResponse');
}
const row = (res, name) => res.leaderboard.find(r => r.username === name);

describe('leaderboard cache', () => {
    test('a second fetch is served from the cache (no find)', async () => {
        await leaderboard();
        const find = jest.spyOn(mockDb.current.users, 'find');
        const res = await leaderboard();
        expect(res.success).toBe(true);
        expect(find).not.toHaveBeenCalled();
        expect(res.leaderboard.map(r => r.username)).not.toContain('OldAnn');
    });

    test('a just-recorded game shows on the next fetch', async () => {
        expect(row(await leaderboard(), 'Ann').gamesPlayed).toBe(4);
        await profile.recordGameStats(finishedGame());
        const after = await leaderboard();
        expect(row(after, 'Ann').gamesPlayed).toBe(5);
        expect(row(after, 'Dan').gamesPlayed).toBe(4);
    });

    test('a new picture shows on the next fetch', async () => {
        // V1_REMOVALS #19 B: rows carry customProfilePic null; a custom picture is
        // the reply's avatarUrls, so this runs with the avatar pipeline on
        const store = require('../../avatar/avatarStore');
        store._reset();
        store.configure({ enabled: true });
        try {
            expect((await leaderboard()).avatarUrls).toBeUndefined();
            const me = sock();
            gameManager.registerUser(me.id, 'Ben');
            const fx = require('../../testUtils/avatarFixtures');
            await profile.uploadProfilePic(me, io, { imageData: fx.dataUrl(await fx.avatarPng(64, 2)) });
            const res = await leaderboard();
            expect(row(res, 'Ben').customProfilePic).toBeNull();
            expect(res.avatarUrls).toEqual({ Ben: expect.stringMatching(/^\/avatar\/Ben\?v=[0-9a-f]{16}$/) });
            await profile.updateProfilePic(me, io, { profilePic: 77 });
            expect(row(await leaderboard(), 'Ben').profilePic).toBe(77);
        } finally {
            store._reset();
        }
    });

    test('deleting an account removes its row and anonymizes the records', async () => {
        await leaderboard();
        await records();
        const me = sock();
        gameManager.registerUser(me.id, 'Ann');
        jest.useFakeTimers();
        await auth.deleteAccount(me, io, { password: 'pw' });
        jest.useRealTimers();
        expect(lastTo(me, 'deleteAccountResponse')).toEqual({ success: true });
        const lb = await leaderboard();
        expect(lb.leaderboard.map(r => r.username)).not.toContain('Ann');
        const rec = await records();
        expect(rec.records.allTime.highestScore.players).toEqual(['[deleted]', 'Cat']);
    });

    test('cached rows are never mutated by later requests', async () => {
        const first = await leaderboard();
        deepFreeze(first.leaderboard);
        const again = await leaderboard();
        expect(again.leaderboard).toBe(first.leaderboard);
        const rec = await records();
        deepFreeze(rec.records);
        expect((await records()).records).toBe(rec.records);
    });

    test('the 11th request in 10 s gets success:true with the cached rows and no find', async () => {
        const s = sock();
        for (let i = 0; i < 10; i++) await leaderboard(s);
        const cached = lastTo(s, 'leaderboardResponse').leaderboard;
        profile.invalidateLeaderboard();
        // Another socket refills the cache
        const refilled = (await leaderboard(sock())).leaderboard;
        const find = jest.spyOn(mockDb.current.users, 'find');
        const res = await leaderboard(s);
        expect(res).toEqual({ success: true, leaderboard: refilled });
        expect(res.leaderboard).toEqual(cached);
        expect(find).not.toHaveBeenCalled();
        expect(log.filter(l => l.event === 'serverError')).toEqual([]);
    });

    test('over the limit with nothing cached: the fill in flight, else the plain failure reply', async () => {
        const s = sock();
        for (let i = 0; i < 10; i++) await leaderboard(s);
        profile.invalidateLeaderboard();
        expect(await leaderboard(s)).toEqual({ success: false, message: 'Too many requests. Please wait a moment.' });

        // A fill running for someone else is shared with the throttled socket
        const other = profile.getLeaderboard(sock(), io);
        const throttled = leaderboard(s);
        await other;
        const res = await throttled;
        expect(res.success).toBe(true);
        expect(row(res, 'Ann')).toBeDefined();
    });

    test('an invalidate during an in-flight fill leaves the result uncached', async () => {
        let release;
        const gate = new Promise(r => { release = r; });
        const realFind = mockDb.current.users.find.bind(mockDb.current.users);
        const spy = jest.spyOn(mockDb.current.users, 'find').mockImplementationOnce((...args) => {
            const cursor = realFind(...args);
            return { toArray: async () => { await gate; return cursor.toArray(); } };
        });
        const pending = leaderboard();
        await new Promise(r => setImmediate(r));
        await profile.recordGameStats(finishedGame());
        release();
        await pending;
        // The pre-write read was answered but not kept: the next fetch reads again
        const res = await leaderboard();
        expect(spy).toHaveBeenCalledTimes(2);
        expect(row(res, 'Ann').gamesPlayed).toBe(5);
    });
});

describe('records cache', () => {
    test('invalidated after a game result is recorded', async () => {
        expect((await records()).totalGames).toBe(1);
        await profile.recordGameStats(finishedGame());
        const res = await records();
        expect(res.totalGames).toBe(2);
        expect(res.records.thisMonth.highestScore).toEqual({ score: 420, players: ['Ann', 'Cat'] });
    });

    test('a month rollover invalidates (thisMonth starts empty)', async () => {
        jest.useFakeTimers({ now: new Date(2026, 9, 31, 23, 59, 0), doNotFake: ['setImmediate', 'nextTick'] });
        mockDb.current.gameRecords.docs[0].completedAt = new Date(2026, 9, 31, 12, 0, 0);
        const oct = await records();
        expect(oct.records.thisMonth).not.toBeNull();
        jest.setSystemTime(new Date(2026, 10, 1, 0, 0, 30));
        const find = jest.spyOn(mockDb.current.gameRecords, 'find');
        const nov = await records();
        expect(find).toHaveBeenCalled();
        expect(nov.records.thisMonth).toBeNull();
        expect(nov.records.allTime).toEqual(oct.records.allTime);
    });

    test('the 11th request in 10 s gets the cached records, never error', async () => {
        const s = sock();
        for (let i = 0; i < 10; i++) await records(s);
        const find = jest.spyOn(mockDb.current.gameRecords, 'find');
        const res = await records(s);
        expect(res).toMatchObject({ success: true, totalGames: 1 });
        expect(find).not.toHaveBeenCalled();
        expect(log.filter(l => l.event === 'serverError')).toEqual([]);
    });

    test('the records finds read only the projected fields', async () => {
        const find = jest.spyOn(mockDb.current.gameRecords, 'find');
        await records();
        expect(find).toHaveBeenCalledTimes(3);
        for (const [, opts] of find.mock.calls) {
            expect(opts.projection).toEqual({ _id: 0, team1Score: 1, team2Score: 1, team1Players: 1, team2Players: 1, team1Bags: 1, team2Bags: 1 });
        }
    });
});

describe('player search', () => {
    test('a query longer than any username answers an empty list without a DB read', async () => {
        const find = jest.spyOn(mockDb.current.users, 'find');
        const s = sock();
        await profile.searchPlayers(s, io, { query: 'x'.repeat(60) });
        expect(lastTo(s, 'searchPlayersResponse')).toEqual({ success: true, players: [] });
        expect(find).not.toHaveBeenCalled();
    });

    test('search rows keep their fields', async () => {
        const s = sock();
        await profile.searchPlayers(s, io, { query: 'an' });
        expect(lastTo(s, 'searchPlayersResponse').players).toEqual([
            { username: 'Ann', profilePic: 2, customProfilePic: null, gamesPlayed: 4, wins: 3 },
            { username: 'Dan', profilePic: 5, customProfilePic: null, gamesPlayed: 3, wins: 1 }
        ]);
    });

    test('the 31st search in 10 s gets the existing rateLimit error', async () => {
        const s = sock();
        const handler = asyncHandler('searchPlayers', profile.searchPlayers);
        for (let i = 0; i < 30; i++) await handler(s, io, { query: 'a' });
        expect(log.filter(l => l.to === `self:${s.id}` && l.event === 'searchPlayersResponse')).toHaveLength(30);
        await handler(s, io, { query: 'a' });
        expect(lastTo(s, 'serverError')).toEqual({ code: 'rateLimit', message: 'Too many requests, please slow down', handler: 'searchPlayers' });
    });

    test('getPlayerProfile is limited to 30 per 10 s the same way', async () => {
        const s = sock();
        const handler = asyncHandler('getPlayerProfile', profile.getPlayerProfile);
        for (let i = 0; i < 30; i++) await handler(s, io, { username: 'Ann' });
        await handler(s, io, { username: 'Ann' });
        expect(lastTo(s, 'serverError')).toMatchObject({ code: 'rateLimit', handler: 'getPlayerProfile' });
    });
});

describe('getUserProfilePic randomFallback', () => {
    test('false returns null (no random draw) for missing user, no pic and no username', async () => {
        const rnd = jest.spyOn(Math, 'random');
        await mockDb.current.users.insertOne({ username: 'NoPic' });
        expect(await profile.getUserProfilePic('Nobody', { randomFallback: false })).toBeNull();
        expect(await profile.getUserProfilePic('NoPic', { randomFallback: false })).toBeNull();
        expect(await profile.getUserProfilePic(undefined, { randomFallback: false })).toBeNull();
        expect(rnd).not.toHaveBeenCalled();
        expect(await profile.getUserProfilePic('Ann', { randomFallback: false })).toBe(2);
        const r = await profile.getUserProfilePic('Nobody');
        expect(r).toBeGreaterThanOrEqual(1);
        expect(rnd).toHaveBeenCalledTimes(1);
    });
});

describe('ttlCache', () => {
    test('single-flight, TTL, peek, errors never cached', async () => {
        jest.useFakeTimers({ now: 1000 });
        const cache = createCache({ ttlMs: 60000 });
        let calls = 0;
        const fill = async () => ++calls;
        const [a, b] = await Promise.all([cache.get(fill), cache.get(fill)]);
        expect([a, b, calls]).toEqual([1, 1, 1]);
        jest.setSystemTime(1000 + 59999);
        expect(await cache.get(fill)).toBe(1);
        jest.setSystemTime(1000 + 60000);
        expect(cache.peek()).toBe(1);
        expect(await cache.get(fill)).toBe(2);
        cache.invalidate();
        expect(cache.peek()).toBeUndefined();
        await expect(cache.get(async () => { throw new Error('db down'); })).rejects.toThrow('db down');
        expect(cache.peek()).toBeUndefined();
        expect(cache.inflightPromise()).toBeNull();
        expect(await cache.get(fill)).toBe(3);
    });

    test('invalidate during a fill: the result is returned but not stored, and the next get refills', async () => {
        const cache = createCache({ ttlMs: 60000 });
        let release;
        const first = cache.get(() => new Promise(r => { release = r; }));
        expect(cache.inflightPromise()).toBe(first);
        cache.invalidate();
        expect(cache.inflightPromise()).toBeNull();
        await new Promise(r => setImmediate(r));
        release('stale');
        expect(await first).toBe('stale');
        expect(cache.peek()).toBeUndefined();
        expect(await cache.get(async () => 'fresh')).toBe('fresh');
    });
});
