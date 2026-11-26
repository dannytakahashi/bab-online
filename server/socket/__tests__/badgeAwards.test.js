/**
 * Badges, end to end on the server (socket/badgeAwards.js, the record
 * builder and the stats chain in profileHandlers, admin/badgeBackfill.js):
 * a finished game's record carries each human seat's badges, the stats
 * chain awards them once (and the lifetime ones the new totals reach),
 * tells each player who is online and shows badges, and a profile reply
 * lists only what that player earned. Bot games and assisted wins earn
 * nothing. Every emit is checked against the socket contract.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports
}));

const gameManager = require('../../game/GameManager');
const profile = require('../profileHandlers');
const badgeAwards = require('../badgeAwards');
const badges = require('../../game/badges');
const backfill = require('../../admin/badgeBackfill');
const { planMerge, applyMerge } = require('../../admin/accountMerge');
const shutdownMod = require('../../utils/shutdown');
const rateLimiter = require('../rateLimiter');
const { defaultAssist } = require('../../game/assistState');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const { authLogger, logger, gameLogger, socketLogger } = require('../../utils/logger');

const HUMANS = { 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' };
const users = () => mockDb.current.users;
const records = () => mockDb.current.gameRecords;
const userDoc = (name) => users().docs.find((d) => d.username === name);
const badgeIds = (name) => (userDoc(name)?.badges || []).map((b) => b.id);

let log;
let io;
let gameNo = 0;

/**
 * A finished game: Ann/Cat (team 1) against Ben/Dan. `track` edits the
 * badge tracker, `bots` seats native bots, `help` sets counted /help uses.
 */
function finishedGame({ score = { team1: 250, team2: 150 }, bots = [], help = {}, track = () => {}, tricks = [5, 5, 5, 5], sets = [1, 1] } = {}) {
    const seats = [1, 2, 3, 4].map((pos) => (bots.includes(pos)
        ? { position: pos, controller: 'bot', ownerUsername: null }
        : { position: pos, controller: 'human', ownerUsername: HUMANS[pos] }));
    const assist = defaultAssist();
    for (const [pos, n] of Object.entries(help)) Object.assign(assist[pos], { user: HUMANS[pos], help: n, lastHelpKey: `k${n}` });
    const badgeTrack = badges.newTrack();
    track(badgeTrack);
    return {
        gameId: `g-${++gameNo}`,
        score,
        assist,
        badgeTrack,
        seatList: () => seats,
        seat: (pos) => seats[pos - 1],
        getOriginalPlayer: (pos) => ({ username: bots.includes(pos) ? `🤖 Bot${pos}` : HUMANS[pos] }),
        handStats: { totalHands: 13, team1Sets: sets[0], team2Sets: sets[1], team1SetPoints: 20, team2SetPoints: 20 },
        playerStats: Object.fromEntries(tricks.map((t, i) => [i + 1, { totalBids: 5, totalTricks: t, setsCaused: 0, totalHSI: 300 }]))
    };
}

/** A signed-in player's live socket, with or without the cap. */
function online(username, { cap = true } = {}) {
    const socket = makeSocket(`sock-${username}`, log, io);
    socket.data.client = { client: 'web', version: '1', build: null, caps: cap ? ['badges'] : [] };
    gameManager.registerUser(socket.id, username);
    return socket;
}
const awardedTo = (socket) => log.filter((l) => l.to === `self:${socket.id}` && l.event === 'badgesAwarded').map((l) => l.data);

beforeEach(() => {
    log = [];
    io = makeIo(log);
    badgeAwards.setIo(io);
    gameManager.deletedUsernames.clear();
    gameManager.currentUsers = [];
    shutdownMod._resetShutdownStateForTests();
    profile._resetCachesForTests();
    profile._setStatsRetryDelaysForTests([1, 1, 1, 1, 1]);
    mockDb.current = createMemoryDb({ users: Object.values(HUMANS).map((username) => ({ username })) });
    for (const l of [authLogger, logger, gameLogger, socketLogger]) {
        for (const m of ['info', 'debug', 'warn', 'error']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    gameManager.currentUsers = [];
    jest.restoreAllMocks();
    profile._setStatsRetryDelaysForTests();
    shutdownMod._resetShutdownStateForTests();
});
afterAll(() => rateLimiter.shutdown());

describe('the record', () => {
    test('each human seat\'s badges and over-trumped count, by position', () => {
        const r = profile.buildGameEndRecord(finishedGame({
            score: { team1: 510, team2: -30 },
            track: (t) => { t.byPos[2].ot = 3; t.byPos[1].bigBid = 1; }
        }));
        expect(r.statsDeltas.badges).toEqual({
            1: ['five-hundred', 'four-hundred', 'go-big-or-go-home'],
            2: ['felted'],
            3: ['five-hundred', 'four-hundred'],
            4: ['felted']
        });
        expect(r.statsDeltas.overtrumped).toEqual({ 2: 3 });
    });

    test('a game that earned nothing carries neither key', () => {
        const r = profile.buildGameEndRecord(finishedGame());
        expect(r.statsDeltas).not.toHaveProperty('badges');
        expect(r.statsDeltas).not.toHaveProperty('overtrumped');
    });

    test('a bot game earns nothing (the leaderboard\'s rule)', () => {
        const r = profile.buildGameEndRecord(finishedGame({ score: { team1: 510, team2: -30 }, bots: [4], track: (t) => { t.byPos[1].ot = 9; } }));
        expect(r.statsDeltas.bucket).toBe('botStats');
        expect(r.statsDeltas).not.toHaveProperty('badges');
        expect(r.statsDeltas).not.toHaveProperty('overtrumped');
    });

    test('a seat /help moved to the bot stats earns nothing; the other seats still do', () => {
        const r = profile.buildGameEndRecord(finishedGame({ score: { team1: 510, team2: 100 }, help: { 1: 4 }, track: (t) => { t.byPos[1].ot = 2; t.byPos[3].ot = 1; } }));
        expect(r.statsDeltas.bucketByPosition).toEqual({ 1: 'botStats' });
        expect(r.statsDeltas.badges).toEqual({ 3: ['five-hundred', 'four-hundred'] });
        expect(r.statsDeltas.overtrumped).toEqual({ 3: 1 });
    });
});

describe('the award', () => {
    test('a game end awards each seat once, tells who is online with the cap, and a replay awards nothing', async () => {
        const ann = online('Ann');
        const ben = online('Ben', { cap: false });
        const game = finishedGame({ score: { team1: 510, team2: -30 } });
        await profile.recordGameStats(game);

        expect(badgeIds('Ann')).toEqual(['five-hundred', 'four-hundred']);
        expect(badgeIds('Cat')).toEqual(['five-hundred', 'four-hundred']);
        expect(badgeIds('Ben')).toEqual(['felted']);
        expect(userDoc('Ann').badges[0]).toMatchObject({ id: 'five-hundred', gameId: game.gameId });
        expect(userDoc('Ann').badges[0].at).toBeInstanceOf(Date);
        // Ann is told; Ben's client does not show badges; Cat and Dan are offline
        expect(awardedTo(ann)).toEqual([{
            gameId: game.gameId,
            badges: [
                { id: 'five-hundred', name: '500', description: 'Scored 500 points in a game.' },
                { id: 'four-hundred', name: '400', description: 'Scored 400 points in a game.' }
            ]
        }]);
        expect(awardedTo(ben)).toEqual([]);
        expect(log.filter((l) => l.event === 'badgesAwarded')).toHaveLength(1);

        // The same record again (a replay / the pending-stats resume)
        const stored = records().docs.find((d) => d.gameId === game.gameId);
        expect(await badgeAwards.awardForRecord(stored, { users: users(), gameRecords: records() })).toEqual([]);
        expect(badgeIds('Ann')).toEqual(['five-hundred', 'four-hundred']);
    });

    test('a badge already held is not awarded or announced again', async () => {
        const ann = online('Ann');
        await profile.recordGameStats(finishedGame({ score: { team1: 420, team2: 100 } }));
        await profile.recordGameStats(finishedGame({ score: { team1: 520, team2: 100 } }));
        expect(badgeIds('Ann')).toEqual(['four-hundred', 'five-hundred']);
        expect(awardedTo(ann).map((d) => d.badges.map((b) => b.id))).toEqual([['four-hundred'], ['five-hundred']]);
    });

    test('a bot game awards nothing and counts no over-trump', async () => {
        const ann = online('Ann');
        await profile.recordGameStats(finishedGame({ score: { team1: 510, team2: -30 }, bots: [2, 4], track: (t) => { t.byPos[1].ot = 60; } }));
        expect(badgeIds('Ann')).toEqual([]);
        expect(userDoc('Ann').badgeProgress).toBeUndefined();
        expect(awardedTo(ann)).toEqual([]);
    });

    test('Child Labor: the over-trumped count adds up across human games to 50', async () => {
        await profile.recordGameStats(finishedGame({ track: (t) => { t.byPos[1].ot = 30; } }));
        expect(userDoc('Ann').badgeProgress).toEqual({ overtrumped: 30 });
        expect(badgeIds('Ann')).toEqual([]);
        await profile.recordGameStats(finishedGame({ track: (t) => { t.byPos[1].ot = 19; } }));
        expect(badgeIds('Ann')).toEqual([]);
        await profile.recordGameStats(finishedGame({ track: (t) => { t.byPos[1].ot = 1; } }));
        expect(userDoc('Ann').badgeProgress).toEqual({ overtrumped: 50 });
        expect(badgeIds('Ann')).toEqual(['child-labor']);
        expect(badgeIds('Cat')).toEqual([]);
    });

    test('Century: the 100th human game', async () => {
        await users().updateOne({ username: 'Ann' }, { $set: { stats: { gamesPlayed: 98 } } });
        await profile.recordGameStats(finishedGame());
        expect(badgeIds('Ann')).toEqual([]);
        await profile.recordGameStats(finishedGame());
        expect(userDoc('Ann').stats.gamesPlayed).toBe(100);
        expect(badgeIds('Ann')).toEqual(['century']);
        expect(badgeIds('Ben')).toEqual([]);
    });

    test('Chemistry: the 20th human game with the same partner (bot games and other partners do not count)', async () => {
        const base = { completedAt: new Date('2026-10-01T00:00:00Z'), team1Score: 100, team2Score: 90 };
        for (let i = 0; i < 18; i++) await records().insertOne({ ...base, gameId: `old-${i}`, team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Zed'] });
        await records().insertOne({ ...base, gameId: 'old-bots', withBots: true, team1Players: ['Ann', 'Cat'], team2Players: ['Ben'] });
        await records().insertOne({ ...base, gameId: 'old-split', team1Players: ['Ann', 'Ben'], team2Players: ['Cat', 'Dan'] });
        await profile.recordGameStats(finishedGame());
        expect(badgeIds('Ann')).toEqual([]);
        await profile.recordGameStats(finishedGame());
        expect(badgeIds('Ann')).toEqual(['chemistry']);
        expect(badgeIds('Cat')).toEqual(['chemistry']);
        expect(badgeIds('Ben')).toEqual([]);
        expect(await badgeAwards.gamesTogether(records(), 'Ann', 'Cat')).toBe(20);
        expect(await badgeAwards.gamesTogether(records(), 'Ben', 'Dan')).toBe(2);
    });

    test('a merged-away account and a deleted name are never awarded', async () => {
        await users().updateOne({ username: 'Ben' }, { $set: { mergedInto: 'Ann' } });
        const record = { gameId: 'g-x', statsDeltas: { bucket: 'stats', byPosition: {}, names: { 2: 'Ben', 4: '[deleted]' }, badges: { 2: ['felted'], 4: ['felted'] } } };
        expect(await badgeAwards.awardForRecord(record, { users: users(), gameRecords: records() })).toEqual([]);
        expect(badgeIds('Ben')).toEqual([]);
    });
});

describe('durability: a badge earned in a game is never lost', () => {
    /** users.updateOne that throws for a badge $push while `fail(update)` says so. */
    function failBadgeWrites(fail) {
        const coll = users();
        const orig = coll.updateOne.bind(coll);
        const calls = { badge: 0, failed: 0 };
        coll.updateOne = async (filter, update, opts) => {
            if (update?.$push?.badges) {
                calls.badge++;
                if (fail(filter, calls)) {
                    calls.failed++;
                    throw new Error('transient');
                }
            }
            return orig(filter, update, opts);
        };
        return { calls, restore: () => { coll.updateOne = orig; } };
    }
    const stored = (gameId) => records().docs.find((d) => d.gameId === gameId);

    test('a one-time failure of a badge write is retried like the stats', async () => {
        const ann = online('Ann');
        let once = true;
        const inject = failBadgeWrites((filter) => {
            if (filter.username !== 'Ann' || !once) return false;
            once = false;
            return true;
        });
        const game = finishedGame({ score: { team1: 510, team2: 150 } });
        await profile.recordGameStats(game);
        expect(inject.calls.failed).toBe(1);
        expect(badgeIds('Ann')).toEqual(['five-hundred', 'four-hundred']);
        expect(badgeIds('Cat')).toEqual(['five-hundred', 'four-hundred']);
        expect(awardedTo(ann).map((d) => d.badges.map((b) => b.id))).toEqual([['five-hundred', 'four-hundred']]);
        expect(stored(game.gameId).statsPending).toBeUndefined();
        expect(userDoc('Ann').stats.gamesPlayed).toBe(1);
    });

    test('one badge that keeps failing: the others go in, the player stays pending and the boot sweep finishes it', async () => {
        const inject = failBadgeWrites((filter) => filter.username === 'Ann' && filter['badges.id'].$ne === 'four-hundred');
        const game = finishedGame({ score: { team1: 510, team2: 150 } });
        await profile.recordGameStats(game);
        // retried to the end (1 + 5 retries), then given up for this run
        expect(inject.calls.failed).toBe(6);
        // the per-badge catch kept Ann's other badge, Cat got both
        expect(badgeIds('Ann')).toEqual(['five-hundred']);
        expect(badgeIds('Cat')).toEqual(['five-hundred', 'four-hundred']);
        expect(stored(game.gameId).statsPending).toEqual([{ position: 1, username: 'Ann' }]);

        // the next boot: the database answers again
        inject.restore();
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        expect(badgeIds('Ann')).toEqual(['five-hundred', 'four-hundred']);
        expect(stored(game.gameId).statsPending).toBeUndefined();
        // the stats guard kept the re-run from counting twice
        expect(userDoc('Ann').stats.gamesPlayed).toBe(1);
        expect(await profile.resumePendingGameStats()).toEqual({ records: 0, failed: 0 });
    });

    test('a crash after the stats and before the award: the record is still pending, the boot sweep awards once', async () => {
        // the process "dies" inside the award: it never returns
        const hang = jest.spyOn(badgeAwards, 'awardAndNotify').mockImplementation(() => new Promise(() => {}));
        const game = finishedGame({ score: { team1: 510, team2: 150 } });
        profile.recordGameStats(game);
        for (let i = 0; i < 50 && hang.mock.calls.length === 0; i++) await new Promise((r) => setImmediate(r));
        expect(hang).toHaveBeenCalledTimes(1);
        // at the award the stats are in and the record is NOT marked yet
        expect(userDoc('Ann').stats.gamesPlayed).toBe(1);
        expect(stored(game.gameId).statsPending).toHaveLength(4);
        expect(badgeIds('Ann')).toEqual([]);

        // the next process
        hang.mockRestore();
        profile._resetCachesForTests();
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        for (const name of ['Ann', 'Cat']) expect(badgeIds(name)).toEqual(['five-hundred', 'four-hundred']);
        expect(stored(game.gameId).statsPending).toBeUndefined();
        expect(userDoc('Ann').stats.gamesPlayed).toBe(1);
    });

    test('an award that cannot run at all keeps every player pending', async () => {
        // awardAndNotify's own catch (the award threw outside a player's)
        jest.spyOn(badgeAwards, 'awardAndNotify').mockResolvedValueOnce({ awards: [], failed: null });
        const game = finishedGame({ score: { team1: 510, team2: 150 } });
        await profile.recordGameStats(game);
        expect(stored(game.gameId).statsPending).toHaveLength(4);
        expect(await profile.resumePendingGameStats()).toEqual({ records: 1, failed: 0 });
        expect(badgeIds('Ann')).toEqual(['five-hundred', 'four-hundred']);
    });
});

describe('Chemistry counts a game when both partners\' seats are human-bucket', () => {
    const base = { completedAt: new Date('2026-10-01T00:00:00Z'), team1Score: 100, team2Score: 300 };
    const sd = (extra = {}) => ({ statsDeltas: { bucket: 'stats', byPosition: {}, names: { 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' }, ...extra } });

    test('an opponent\'s /help win keeps it; a partner /help moved, a bot game or an old withBots record does not', async () => {
        // the opponents (Ben/Dan) won with Ben's /help: Ann and Cat still played a human game together
        await records().insertOne({ ...base, gameId: 'opp-help', withBots: true, assistedTeams: [2], team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Dan'], ...sd({ bucketByPosition: { 2: 'botStats' } }) });
        // Cat won with /help: her seat went to botStats, so not for the pair
        await records().insertOne({ ...base, gameId: 'own-help', withBots: true, assistedTeams: [1], team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Dan'], ...sd({ bucketByPosition: { 3: 'botStats' } }) });
        await records().insertOne({ ...base, gameId: 'bot-game', withBots: true, team1Players: ['Ann', 'Cat'], team2Players: ['Ben'], ...sd({ bucket: 'botStats' }) });
        await records().insertOne({ ...base, gameId: 'old-bots', withBots: true, team1Players: ['Ann', 'Cat'], team2Players: ['Ben'] });
        await records().insertOne({ ...base, gameId: 'old-human', team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Dan'] });
        expect(await badgeAwards.gamesTogether(records(), 'Ann', 'Cat')).toBe(2);
        // the assisted winners' own pair counts nothing from those two games
        expect(await badgeAwards.gamesTogether(records(), 'Ben', 'Dan')).toBe(2);
    });

    test('the 20th game together can be one the opponents won with /help', async () => {
        for (let i = 0; i < 19; i++) await records().insertOne({ ...base, gameId: `h-${i}`, team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Dan'], ...sd() });
        const game = finishedGame({ score: { team1: 100, team2: 300 }, help: { 2: 4 } });
        const record = profile.buildGameEndRecord(game);
        expect(record.withBots).toBe(true);
        expect(record.statsDeltas.bucketByPosition).toEqual({ 2: 'botStats' });
        await profile.recordGameStats(game);
        expect(badgeIds('Ann')).toEqual(['chemistry']);
        expect(badgeIds('Cat')).toEqual(['chemistry']);
        expect(badgeIds('Ben')).toEqual([]);
    });
});

describe('the toast lists one game\'s badges in the profile\'s (catalog) order', () => {
    test('whatever order the record and the lifetime checks give them', async () => {
        const ann = online('Ann');
        await users().updateOne({ username: 'Ann' }, { $set: { stats: { gamesPlayed: 99 } } });
        // the record lists them out of catalog order; Century (lifetime) comes before go-big-or-go-home in the catalog
        const record = { gameId: 'g-order', completedAt: new Date(), statsDeltas: { bucket: 'stats', byPosition: {}, names: { 1: 'Ann' }, badges: { 1: ['hammer-time', 'felted', 'go-big-or-go-home', 'five-hundred', 'four-hundred'] } } };
        await users().updateOne({ username: 'Ann' }, { $set: { 'stats.gamesPlayed': 100 } });
        await badgeAwards.awardAndNotify(record, { users: users(), gameRecords: records() });
        const order = badges.BADGE_IDS;
        const sent = awardedTo(ann)[0].badges.map((b) => b.id);
        expect(sent).toEqual(['five-hundred', 'four-hundred', 'felted', 'century', 'go-big-or-go-home', 'hammer-time']);
        expect([...sent].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(sent);
        // the profile (same `at`) lists them the same way
        expect(badges.publicBadges(userDoc('Ann').badges).map((b) => b.id)).toEqual(sent);
    });
});

describe('the profile', () => {
    const reply = (socket, event) => log.filter((l) => l.to === `self:${socket.id}` && l.event === event).pop()?.data;

    test('badges on the own and on a player\'s profile, only for a client with the cap, only the earned ones', async () => {
        await users().updateOne({ username: 'Ann' }, { $set: { badges: [{ id: 'felted', at: new Date('2026-11-20T10:00:00Z'), gameId: 'g' }] } });
        const ann = online('Ann');
        await profile.getProfile(ann, io, {});
        expect(reply(ann, 'profileResponse').badges).toEqual([
            { id: 'felted', name: 'Felted', description: 'Ended a game with a negative score.', at: '2026-11-20T10:00:00.000Z' }
        ]);
        const cat = online('Cat');
        await profile.getPlayerProfile(cat, io, { username: 'Ann' });
        expect(reply(cat, 'playerProfileResponse').badges.map((b) => b.id)).toEqual(['felted']);
        await profile.getPlayerProfile(cat, io, { username: 'Ben' });
        expect(reply(cat, 'playerProfileResponse').badges).toEqual([]);

        const legacy = online('Dan', { cap: false });
        await profile.getPlayerProfile(legacy, io, { username: 'Ann' });
        expect(reply(legacy, 'playerProfileResponse')).not.toHaveProperty('badges');
    });
});

describe('the backfill (admin/badgeBackfill.js)', () => {
    const rec = (gameId, completedAt, t1, s1, t2, s2, extra = {}) => ({ gameId, completedAt: new Date(completedAt), team1Players: t1, team1Score: s1, team2Players: t2, team2Score: s2, ...extra });

    test('500, 400 and Felted from the human records, dated by the first game; Century from the stats; nothing twice', async () => {
        await records().insertOne(rec('a', '2026-10-02T00:00:00Z', ['Ann', 'Cat'], 430, ['Ben', 'Dan'], -40));
        await records().insertOne(rec('b', '2026-10-01T00:00:00Z', ['Ann', 'Ben'], 505, ['Cat', 'Dan'], 120));
        await records().insertOne(rec('bots', '2026-09-01T00:00:00Z', ['Dan'], 900, ['Cat'], -500, { withBots: true }));
        await records().insertOne(rec('gone', '2026-09-02T00:00:00Z', ['[deleted]', 'Zed'], 600, ['Cat', 'Dan'], 50));
        await users().updateOne({ username: 'Dan' }, { $set: { stats: { gamesPlayed: 100 } } });
        await users().updateOne({ username: 'Ann' }, { $set: { badges: [{ id: 'four-hundred', at: new Date('2026-01-01T00:00:00Z') }] } });

        const p = await backfill.plan({ users: users(), gameRecords: records() }, { now: new Date('2026-11-25T00:00:00Z') });
        expect(p.records).toBe(3);
        expect(p.skipped).toEqual(['Zed']);
        expect(p.awards.map((a) => `${a.username}:${a.id}`)).toEqual([
            'Ann:five-hundred', 'Ben:felted', 'Ben:five-hundred', 'Ben:four-hundred', 'Cat:four-hundred', 'Dan:century', 'Dan:felted'
        ]);
        // dated by the first game that earned it
        expect(p.awards.find((a) => a.username === 'Ben' && a.id === 'four-hundred')).toMatchObject({ gameId: 'b', at: new Date('2026-10-01T00:00:00Z') });
        // a read-only plan writes nothing
        expect(badgeIds('Ben')).toEqual([]);

        expect(await backfill.apply({ users: users() }, p.awards)).toEqual({ awarded: 7, already: 0 });
        expect(badgeIds('Ann')).toEqual(['four-hundred', 'five-hundred']);
        expect(userDoc('Ann').badges[0].at).toEqual(new Date('2026-01-01T00:00:00Z'));
        expect(badgeIds('Dan').sort()).toEqual(['century', 'felted']);
        // again: nothing left to plan, and applying the old plan gives nothing twice
        expect((await backfill.plan({ users: users(), gameRecords: records() })).awards).toEqual([]);
        expect(await backfill.apply({ users: users() }, p.awards)).toEqual({ awarded: 0, already: 7 });
    });

    test('Chemistry from 20 recorded human games with the same partner', async () => {
        for (let i = 0; i < 20; i++) await records().insertOne(rec(`c-${i}`, `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`, ['Ann', 'Cat'], 100, ['Ben', 'Dan'], 90));
        await records().insertOne(rec('c-swap', '2026-11-01T00:00:00Z', ['Ann', 'Ben'], 100, ['Cat', 'Dan'], 90));
        const p = await backfill.plan({ users: users(), gameRecords: records() });
        expect(p.awards.map((a) => `${a.username}:${a.id}`)).toEqual(['Ann:chemistry', 'Ben:chemistry', 'Cat:chemistry', 'Dan:chemistry']);
        expect(p.awards[0]).toMatchObject({ gameId: 'c-19' });
    });
});

describe('the backfill by the stats\' bucket', () => {
    const rec = (gameId, t1, s1, t2, s2, extra = {}) => ({ gameId, completedAt: new Date('2026-10-01T00:00:00Z'), team1Players: t1, team1Score: s1, team2Players: t2, team2Score: s2, ...extra });
    const sd = (extra = {}) => ({ statsDeltas: { bucket: 'stats', byPosition: {}, names: { 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' }, ...extra } });

    test('an opponent\'s /help win still counts for the other team (score badges and Chemistry); a moved seat and a bot game do not', async () => {
        // Ben won with /help (his seat botStats): Ann and Cat are Felted and played together
        for (let i = 0; i < 20; i++) {
            await records().insertOne(rec(`o-${i}`, ['Ann', 'Cat'], i === 0 ? -20 : 100, ['Ben', 'Dan'], 520, { withBots: true, assistedTeams: [2], ...sd({ bucketByPosition: { 2: 'botStats' } }) }));
        }
        await records().insertOne(rec('bots', ['Ann', 'Cat'], 900, ['Ben'], 10, { withBots: true, ...sd({ bucket: 'botStats' }) }));
        const p = await backfill.plan({ users: users(), gameRecords: records() });
        expect(p.records).toBe(20);
        expect(p.awards.map((a) => `${a.username}:${a.id}`)).toEqual([
            'Ann:chemistry', 'Ann:felted', 'Cat:chemistry', 'Cat:felted',
            // Dan's seat stayed human (his partner Ben was the one moved): his 500s count, Ben's do not; no Chemistry for them
            'Dan:five-hundred', 'Dan:four-hundred'
        ]);
    });
});

describe('an account merge', () => {
    test('the kept account gets the source\'s badges it lacks and its over-trumped count', async () => {
        const db = mockDb.current;
        await users().updateOne({ username: 'Ann' }, { $set: {
            stats: { gamesPlayed: 3 }, badgeProgress: { overtrumped: 10 },
            badges: [{ id: 'felted', at: new Date('2026-11-01T00:00:00Z') }]
        } });
        await users().updateOne({ username: 'Ben' }, { $set: {
            stats: { gamesPlayed: 2 }, badgeProgress: { overtrumped: 7 },
            badges: [{ id: 'felted', at: new Date('2026-10-01T00:00:00Z') }, { id: 'exact-tie', at: new Date('2026-10-02T00:00:00Z'), gameId: 'g-9' }]
        } });
        const plan = await planMerge(db, { target: 'Ann', sources: ['Ben'] });
        expect(plan.errors).toEqual([]);
        await applyMerge(db, plan);
        expect(badgeIds('Ann')).toEqual(['felted', 'exact-tie']);
        expect(userDoc('Ann').badges[0].at).toEqual(new Date('2026-11-01T00:00:00Z'));
        expect(userDoc('Ann').badgeProgress).toEqual({ overtrumped: 17 });
        expect(userDoc('Ben').badges).toBeUndefined();
        expect(userDoc('Ben').badgeProgress).toBeUndefined();
    });
});
