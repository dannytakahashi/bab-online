/**
 * The tournament history (tournamentRecords, owner 2026-11-25): the record
 * written once when a tournament completes (with and without Cut for a
 * buck, the cut's cancel and leave paths, never for a cancelled or
 * abandoned one), its fields, E11000 = already recorded, transient
 * failures retried, a lasting failure logged and never thrown, the
 * records cache invalidated, names a deletion / rename / merge changed
 * meanwhile, the adoption of a complete doc after a restore; the profile
 * fields (tournaments, cutForABuck) through getProfile / getPlayerProfile
 * (every payload checked by the contract guard), a failed read; Lucky Buck
 * through getRecords in every scope.
 */

'use strict';

const { createMemoryDb, enableSort } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    getTournamentRecordsCollection: () => mockDb.current.tournamentRecords,
}));

const gameManager = require('../../game/GameManager');
const tournamentHandlers = require('../tournamentHandlers');
const profileHandlers = require('../profileHandlers');
const cutForABuck = require('../cutForABuck');
const rateLimiter = require('../rateLimiter');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { events, mulberry32, makeSocket } = require('../../testUtils/gameDriver');
const { setupTournament, playTournament, advanceUntil, creatorSocket, newIo, newUser } = require('../../testUtils/tournamentDriver');
const { setupCut, playToCut, toStage, deckOf } = require('../../testUtils/cutDriver');
const { buildTournamentRecord, recentResult, placeOf } = require('../../game/tournamentRecord');

let errorLogs;
let realRandom;
beforeAll(() => { realRandom = Math.random; });

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
    jest.spyOn(console, 'error').mockImplementation(() => {});
    Math.random = mulberry32(7);
    profileHandlers._resetCachesForTests();
    profileHandlers._setStatsRetryDelaysForTests([0, 0]);
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    cutForABuck.setEngineOptionsForTests({});
    tournamentHandlers._resetCleanupTimersForTests();
    profileHandlers._setStatsRetryDelaysForTests();
    gameManager.deletedUsernames.clear();
    enableSort(false);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
    rateLimiter.reset?.();
});

const records = () => mockDb.current.tournamentRecords.all();
async function settleRecord(n = 1) {
    await advanceUntil(() => records().length >= n, 10, 20000);
    // and any in-flight duplicate attempt
    await jest.advanceTimersByTimeAsync(10);
}
async function finishCut(ctx) {
    await advanceUntil(() => ctx.t.phase === 'complete', 1000, 600000);
}

/** A completed tournament, duck-typed as buildTournamentRecord reads it. */
function fakeTournament(over = {}) {
    const scoreboard = over.scoreboard || [
        { username: 'al', totalScore: 300, roundScores: [100, 200] },
        { username: 'bo', totalScore: 300, roundScores: [250, 50] },
        { username: 'cy', totalScore: 120, roundScores: [60, 60] },
        { username: 'quit', totalScore: 400, roundScores: [400] }
    ];
    return {
        tournamentId: over.tournamentId || 'tid-1',
        phase: 'complete',
        name: "al's Tournament",
        creatorUsername: 'al',
        createdAt: Date.parse('2026-11-25T10:00:00Z'),
        completedAt: Date.parse('2026-11-25T11:00:00Z'),
        totalRounds: 2,
        currentRound: 2,
        finalMembers: ['al', 'bo', 'cy'],
        winnersFinal: () => ['al', 'bo'],
        getScoreboard: () => scoreboard,
        players: new Map(),
        ...over
    };
}

describe('the record of a completed tournament', () => {
    test('a Cut for a buck tournament: one record with the standings, the score winners and the cut; the records cache invalidated', async () => {
        const ctx = await setupCut(3);
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('9h', '3s', 'Kd', '5c', 'Qh') });
        await playToCut(ctx);
        // a records page cached before the record
        const viewer = newUser(ctx.io, ctx.log, 'viewer1');
        await profileHandlers.getRecords(viewer, ctx.io, {});
        expect(profileHandlers._peekRecordsCache()).toBeDefined();
        await finishCut(ctx);
        await settleRecord();
        const complete = events(ctx.log, 'tournamentComplete');
        expect(complete).toHaveLength(1);
        const cut = complete[0].data.cutForABuck;
        expect(cut).toEqual({ winner: expect.any(String), participants: ctx.usernames, rounds: expect.any(Number) });
        const [rec] = records();
        expect(rec).toEqual({
            _id: ctx.t.tournamentId,
            v: 1,
            name: ctx.t.name,
            creatorUsername: ctx.usernames[0],
            createdAt: new Date(ctx.t.createdAt),
            completedAt: new Date(ctx.t.completedAt),
            totalRounds: 1,
            roundsPlayed: 1,
            players: ctx.usernames,
            scoreboard: ctx.t.getScoreboard().map((e) => ({ username: e.username, totalScore: e.totalScore, roundScores: e.roundScores })),
            winners: complete[0].data.winners,
            cut
        });
        expect(profileHandlers._peekRecordsCache()).toBeUndefined();
        // again (a restore's adoption, a replay): already recorded, one document
        await expect(tournamentHandlers.recordTournament(ctx.t, cut)).resolves.toBe('duplicate');
        expect(records()).toHaveLength(1);
        expect(errorLogs).toEqual([]);
    }, 120000);

    test('an all-legacy tournament (no cut): a record with cut null', async () => {
        const ctx = await setupTournament(2);
        await playTournament(ctx);
        expect(ctx.t.phase).toBe('complete');
        await settleRecord();
        expect(records()[0]).toMatchObject({ _id: ctx.t.tournamentId, players: ctx.usernames, cut: null, roundsPlayed: ctx.t.totalRounds });
    }, 120000);

    test('the host ends the cut: recorded with cut null', async () => {
        const ctx = await setupCut(2);
        await playToCut(ctx);
        await toStage(ctx, 'drawing');
        await tournamentHandlers.cancelTournament(creatorSocket(ctx), ctx.io);
        await settleRecord();
        expect(records()[0]).toMatchObject({ _id: ctx.t.tournamentId, cut: null, players: ctx.usernames });
    }, 120000);

    test('the last member leaving during the cut: recorded with cut null', async () => {
        const ctx2 = await setupCut(2);
        await playToCut(ctx2);
        await toStage(ctx2, 'gather');
        await tournamentHandlers.leaveTournament(ctx2.sockets[0], ctx2.io);
        await tournamentHandlers.leaveTournament(ctx2.sockets[1], ctx2.io);
        await settleRecord();
        expect(records().find((r) => r._id === ctx2.t.tournamentId)).toMatchObject({ cut: null, players: ctx2.usernames });
    }, 120000);

    test('cancelled before its last round, or everyone left: no record', async () => {
        const ctx = await setupTournament(2);
        tournamentHandlers.setTournamentRounds(creatorSocket(ctx), ctx.io, { totalRounds: 2 });
        const starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(5000);
        await starting;
        expect(ctx.t.phase).toBe('round_active');
        await tournamentHandlers.cancelTournament(creatorSocket(ctx), ctx.io);

        const ctx2 = await setupTournament(2);
        await tournamentHandlers.leaveTournament(ctx2.sockets[0], ctx2.io);
        await tournamentHandlers.leaveTournament(ctx2.sockets[1], ctx2.io);
        await jest.advanceTimersByTimeAsync(60000);
        expect(records()).toEqual([]);
    }, 120000);

    test('a tournament not complete, or with nobody who finished it, is never recorded', async () => {
        await expect(profileHandlers.recordTournament(fakeTournament({ phase: 'between_rounds' }), null)).resolves.toBeNull();
        await expect(profileHandlers.recordTournament(fakeTournament({ finalMembers: [] }), null)).resolves.toBeNull();
        expect(records()).toEqual([]);
    });

    test('a transient failure is retried; a lasting one is logged, never thrown', async () => {
        const coll = mockDb.current.tournamentRecords;
        const real = coll.insertOne.bind(coll);
        let fails = 1;
        jest.spyOn(coll, 'insertOne').mockImplementation(async (doc) => {
            if (fails-- > 0) throw new Error('not primary');
            return real(doc);
        });
        const first = profileHandlers.recordTournament(fakeTournament(), null);
        await jest.advanceTimersByTimeAsync(100);
        await expect(first).resolves.toBe('recorded');
        expect(records()).toHaveLength(1);

        coll.insertOne.mockImplementation(async () => { throw new Error('down'); });
        const second = profileHandlers.recordTournament(fakeTournament({ tournamentId: 'tid-2' }), null);
        await jest.advanceTimersByTimeAsync(100);
        await expect(second).resolves.toBeNull();
        expect(errorLogs).toEqual([{ msg: 'Tournament record failed', meta: { tournamentId: 'tid-2', error: 'down' } }]);
        expect(records()).toHaveLength(1);
    });

    test('no database: nothing recorded, a warning', async () => {
        const db = mockDb.current;
        mockDb.current = { ...db, tournamentRecords: undefined };
        await expect(profileHandlers.recordTournament(fakeTournament(), null)).resolves.toBeNull();
        expect(authLogger.warn).toHaveBeenCalledWith('Tournament not recorded: no database', { tournamentId: 'tid-1' });
        mockDb.current = db;
    });

    test('names changed during the tournament: deleted -> [deleted] (this process, or the name hold), renamed or merged -> the name it has now', async () => {
        gameManager.deletedUsernames.add('cy');
        mockDb.current.users._insert({ username: 'quit', mergedInto: '[deleted]', deletedAt: new Date(), nameHeldUntil: new Date(Date.now() + 1e9) });
        mockDb.current.users._insert({ username: 'bo', mergedInto: 'bob', renamedAt: new Date() });
        mockDb.current.users._insert({ username: 'al', profilePic: 2 });
        const cut = { winner: 'bo', participants: ['al', 'bo', 'cy'], rounds: 3 };
        await profileHandlers.recordTournament(fakeTournament(), cut);
        const [rec] = records();
        expect(rec.players).toEqual(['al', 'bob', '[deleted]']);
        expect(rec.winners).toEqual(['al', 'bob']);
        expect(rec.scoreboard.map((r) => r.username)).toEqual(['al', 'bob', '[deleted]', '[deleted]']);
        expect(rec.cut).toEqual({ winner: 'bob', participants: ['al', 'bob', '[deleted]'], rounds: 3 });
        expect(rec.creatorUsername).toBe('al');
    });

    test('the adoption of a complete doc after a restore records it (idempotent)', async () => {
        const { serialize } = require('../../game/persist/tournamentCodec');
        const { adoptTournament } = require('../../game/persist/restoreTournament');
        const ctx = await setupTournament(2);
        await playTournament(ctx);
        await settleRecord();
        mockDb.current.tournamentRecords.docs.length = 0; // a crash between the finish and the insert
        const doc = serialize(ctx.t);
        expect(doc).toBeTruthy();
        gameManager.deleteTournament(ctx.t.tournamentId);
        const record = jest.spyOn(tournamentHandlers, 'recordTournament');
        const { io } = newIo();
        const { tournament } = adoptTournament(io, { ...doc, _id: ctx.t.tournamentId });
        expect(record).toHaveBeenCalledTimes(1);
        expect(record.mock.calls[0][0]).toBe(tournament);
        await settleRecord();
        expect(records()[0]).toMatchObject({ _id: ctx.t.tournamentId, players: ctx.usernames, cut: null });
    }, 120000);
});

describe('the builder and the profile results (pure)', () => {
    test('place: competition ranking among the players who finished; a leaver is ranked out; null when not in the standings', () => {
        const rec = buildTournamentRecord(fakeTournament(), null);
        expect(rec.scoreboard.map((r) => r.username)).toEqual(['al', 'bo', 'cy', 'quit']);
        expect(placeOf(rec, 'al')).toBe(1);
        expect(placeOf(rec, 'bo')).toBe(1);
        expect(placeOf(rec, 'cy')).toBe(3);
        expect(placeOf(rec, 'quit')).toBeNull();
        expect(placeOf(rec, 'nobody')).toBeNull();
        expect(recentResult(rec, 'cy')).toEqual({
            id: 'tid-1', name: "al's Tournament", completedAt: '2026-11-25T11:00:00.000Z', totalRounds: 2,
            players: 3, place: 3, won: false, winners: ['al', 'bo'], cutWinner: null
        });
        const withCut = buildTournamentRecord(fakeTournament(), { winner: 'cy', participants: ['al', 'bo', 'cy'], rounds: 2 });
        expect(recentResult(withCut, 'al')).toMatchObject({ place: 1, won: true, cutWinner: 'cy' });
    });

    test('a merged player listed twice: one result, the better place', () => {
        const rec = { _id: 'x', name: 'n', completedAt: new Date(0), totalRounds: 1, players: ['al', 'al', 'bo'], winners: ['bo'], scoreboard: [{ username: 'bo', totalScore: 9 }, { username: 'al', totalScore: 5 }, { username: 'al', totalScore: 1 }], cut: null };
        expect(recentResult(rec, 'al')).toMatchObject({ players: 2, place: 2, won: false });
    });
});

describe('the profile: tournaments and cutForABuck', () => {
    const seed = () => {
        const coll = mockDb.current.tournamentRecords;
        const mk = (i, over) => coll._insert({
            _id: `t${i}`, v: 1, name: `Cup ${i}`, creatorUsername: 'al',
            createdAt: new Date(Date.UTC(2026, 10, i, 9)), completedAt: new Date(Date.UTC(2026, 10, i, 10)),
            totalRounds: 4, roundsPlayed: 4, players: ['al', 'bo'], winners: ['bo'],
            scoreboard: [{ username: 'bo', totalScore: 500, roundScores: [] }, { username: 'al', totalScore: 300, roundScores: [] }],
            cut: null, ...over
        });
        mk(1, { winners: ['al'], scoreboard: [{ username: 'al', totalScore: 9, roundScores: [] }, { username: 'bo', totalScore: 1, roundScores: [] }] });
        mk(2, { cut: { winner: 'al', participants: ['al', 'bo'], rounds: 2 } });
        mk(3, { cut: { winner: 'bo', participants: ['al', 'bo'], rounds: 5 } });
        mk(4, {});
        mk(5, { winners: ['al', 'bo'], scoreboard: [{ username: 'al', totalScore: 7, roundScores: [] }, { username: 'bo', totalScore: 7, roundScores: [] }] });
        mk(6, { players: ['bo', 'cy'], winners: ['cy'] });
        mk(7, {});
    };

    test('getProfile and getPlayerProfile carry played / won / the last 5 newest first, and the cut counts, in every scope', async () => {
        enableSort(true);
        seed();
        const { io, log } = newIo();
        const me = newUser(io, log, 'al');
        newUser(io, log, 'bo');
        await profileHandlers.getProfile(me, io);
        const own = events(log, 'profileResponse')[0].data.profile;
        expect(own.tournaments.played).toBe(6);
        expect(own.tournaments.won).toBe(2);
        expect(own.tournaments.recent.map((r) => r.id)).toEqual(['t7', 't5', 't4', 't3', 't2']);
        expect(own.tournaments.recent[1]).toEqual({
            id: 't5', name: 'Cup 5', completedAt: '2026-11-05T10:00:00.000Z', totalRounds: 4, players: 2,
            place: 1, won: true, winners: ['al', 'bo'], cutWinner: null
        });
        expect(own.tournaments.recent[3]).toMatchObject({ id: 't3', place: 2, won: false, cutWinner: 'bo' });
        expect(own.cutForABuck).toEqual({ wins: 1, played: 2 });
        for (const scope of ['bots', 'all']) {
            await profileHandlers.getPlayerProfile(me, io, { username: 'bo', scope });
        }
        const other = events(log, 'playerProfileResponse').map((l) => l.data.profile);
        for (const p of other) {
            expect(p.tournaments).toMatchObject({ played: 7, won: 5 });
            expect(p.cutForABuck).toEqual({ wins: 1, played: 2 });
        }
    });

    test('nothing recorded: zeros; a failed read: zeros and a warning, the profile still answers', async () => {
        const { io, log } = newIo();
        const me = newUser(io, log, 'nobody');
        await profileHandlers.getProfile(me, io);
        expect(events(log, 'profileResponse')[0].data.profile).toMatchObject({
            tournaments: { played: 0, won: 0, recent: [] }, cutForABuck: { wins: 0, played: 0 }
        });
        jest.spyOn(mockDb.current.tournamentRecords, 'countDocuments').mockRejectedValue(new Error('timeout'));
        await profileHandlers.getProfile(me, io);
        const second = events(log, 'profileResponse')[1].data;
        expect(second.success).toBe(true);
        expect(second.profile.tournaments).toEqual({ played: 0, won: 0, recent: [] });
        expect(authLogger.warn).toHaveBeenCalledWith('Tournament history read failed; the profile shows none', { username: 'nobody', error: 'timeout' });
    });
});

describe('Lucky Buck on the Records page', () => {
    test('in every scope and period, from 2 wins; a failed read leaves it out and the page answers', async () => {
        const now = new Date();
        const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1, 12);
        const lastYear = new Date(now.getFullYear() - 1, 5, 1);
        const coll = mockDb.current.tournamentRecords;
        const cut = (id, winner, at) => coll._insert({ _id: id, completedAt: at, players: ['al', 'bo'], winners: ['al'], scoreboard: [], cut: { winner, participants: ['al', 'bo'], rounds: 2 } });
        cut('a', 'al', thisMonth);
        cut('b', 'al', lastYear);
        cut('c', 'bo', thisMonth);
        cut('d', 'bo', thisMonth);
        coll._insert({ _id: 'e', completedAt: thisMonth, players: ['al'], winners: ['al'], scoreboard: [], cut: null });
        // one game of each kind, so every period of every scope has records
        const game = (gameId, extra) => mockDb.current.gameRecords._insert({ gameId, team1Score: 100, team2Score: 50, team1Players: ['al'], team2Players: ['bo'], completedAt: thisMonth, ...extra });
        game('g1', {});
        game('g2', { withBots: true, team1Bots: ['🤖 Mary'], team2Bots: ['🤖 Mike'] });
        game('g3', { completedAt: lastYear });
        const { io, log } = newIo();
        const s = newUser(io, log, 'viewer2');
        for (const scope of ['human', 'bots', 'all']) await profileHandlers.getRecords(s, io, { scope });
        const replies = events(log, 'recordsResponse').map((l) => l.data);
        for (const r of replies) {
            const lucky = (period) => r.records[period]?.superlatives.find((x) => x.id === 'luckyBuck');
            expect(lucky('thisMonth')).toEqual({ id: 'luckyBuck', title: 'Lucky Buck', names: ['bo'], detail: '2 wins in 3 cuts' });
            expect(lucky('allTime')).toEqual({ id: 'luckyBuck', title: 'Lucky Buck', names: ['al', 'bo'], detail: '2 wins in 4 cuts' });
        }
        expect(replies[0].records.thisYear.superlatives.find((x) => x.id === 'luckyBuck')).toMatchObject({ names: ['bo'] });

        profileHandlers._resetCachesForTests();
        jest.spyOn(coll, 'find').mockImplementation(() => { throw new Error('down'); });
        await profileHandlers.getRecords(s, io, { scope: 'human' });
        const failed = events(log, 'recordsResponse').pop().data;
        expect(failed.success).toBe(true);
        expect(failed.records.allTime.superlatives.find((x) => x.id === 'luckyBuck')).toBeUndefined();
    });
});
