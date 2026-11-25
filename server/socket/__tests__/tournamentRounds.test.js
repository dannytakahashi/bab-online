/**
 * The host picks the number of rounds, 1 to 5 (default 4), in the
 * tournament lobby (2026-11-25): setTournamentRounds through the real
 * handlers with stub sockets, fake timers and the in-memory DB.
 *   - host only, lobby only; 1..5 accepted, anything else refused (Joi and
 *     the state's own check); ready flags kept; the same count sends nothing
 *   - tournamentSettingsUpdated + an unstored system line + lobbiesUpdated
 *   - a host hand-off moves the right
 *   - whole tournaments of 1, 2, 3 and 5 rounds end after exactly that many
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const TournamentState = require('../../game/TournamentState');
const tournamentHandlers = require('../tournamentHandlers');
const { validate } = require('../validators');
const rateLimiter = require('../rateLimiter');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { events, mulberry32 } = require('../../testUtils/gameDriver');
const { setupTournament, playTournament, creatorSocket } = require('../../testUtils/tournamentDriver');

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
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const selfErrors = (ctx, socket) => ctx.log.filter((l) => l.to === `self:${socket.id}` && l.event === 'serverError').map((l) => l.data.message);
const settings = (ctx) => events(ctx.log, 'tournamentSettingsUpdated').map((l) => l.data);
const systemLines = (ctx) => events(ctx.log, 'tournamentMessage').filter((l) => l.data.system === true).map((l) => l.data.message);

describe('TournamentState.setTotalRounds', () => {
    test('1 to 5 in the lobby; anything else, or any other phase, is refused', () => {
        const t = new TournamentState('t-r', 'Cup', 's1', 'ann');
        expect(t.totalRounds).toBe(TournamentState.DEFAULT_ROUNDS);
        expect([TournamentState.MIN_ROUNDS, TournamentState.MAX_ROUNDS, TournamentState.DEFAULT_ROUNDS]).toEqual([1, 5, 4]);
        for (const n of [1, 2, 3, 4, 5]) {
            expect(t.setTotalRounds(n)).toBe(true);
            expect(t.totalRounds).toBe(n);
        }
        for (const bad of [0, 6, -1, 2.5, '3', null, undefined, NaN, Infinity]) {
            expect(t.setTotalRounds(bad)).toBe(false);
            expect(t.totalRounds).toBe(5);
        }
        for (const phase of ['starting', 'round_active', 'between_rounds', 'complete']) {
            t.phase = phase;
            expect(t.setTotalRounds(2)).toBe(false);
            expect(t.totalRounds).toBe(5);
        }
    });
});

describe('the wire: Joi and the rate limit', () => {
    test('Joi takes an integer 1 to 5 only (strict: never the string "3")', () => {
        for (const n of [1, 2, 3, 4, 5]) expect(validate('setTournamentRounds', { totalRounds: n })).toEqual({ totalRounds: n });
        for (const bad of [{ totalRounds: 0 }, { totalRounds: 6 }, { totalRounds: 2.5 }, { totalRounds: '3' }, { totalRounds: null }, {}, null]) {
            expect(() => validate('setTournamentRounds', bad)).toThrow();
        }
        // an extra key is dropped, as for every schema
        expect(validate('setTournamentRounds', { totalRounds: 2, x: 1 })).toEqual({ totalRounds: 2 });
    });

    test('20 changes a minute per socket', () => {
        let allowed = 0;
        for (let i = 0; i < 25; i++) if (rateLimiter.check('s-rounds-rate', 'setTournamentRounds')) allowed++;
        expect(allowed).toBe(20);
    });
});

describe('setTournamentRounds through the handlers', () => {
    test('the host: tournamentSettingsUpdated, a system line (not stored), lobbiesUpdated; ready flags kept', async () => {
        const ctx = await setupTournament(3);
        const host = creatorSocket(ctx);
        const hostName = ctx.usernames[ctx.sockets.indexOf(host)];
        const stored = ctx.t.messages.length;
        const lobbies = events(ctx.log, 'lobbiesUpdated').length;

        tournamentHandlers.setTournamentRounds(host, ctx.io, { totalRounds: 3 });
        expect(ctx.t.totalRounds).toBe(3);
        expect(settings(ctx)).toEqual([{ totalRounds: 3, by: hostName }]);
        expect(events(ctx.log, 'tournamentSettingsUpdated')[0].to).toBe(ctx.t.roomName);
        expect(systemLines(ctx)).toEqual([`${hostName} set the tournament to 3 rounds.`]);
        expect(ctx.t.messages.length).toBe(stored);
        expect(events(ctx.log, 'lobbiesUpdated').length).toBe(lobbies + 1);
        expect(gameManager.getAllTournaments().find((s) => s.id === ctx.t.tournamentId).totalRounds).toBe(3);
        expect(ctx.t.getClientState().totalRounds).toBe(3);
        // Ready flags are kept (iOS 1.2.6 syncs its own only on a rejoin)
        expect(ctx.t.allPlayersReady()).toBe(true);

        tournamentHandlers.setTournamentRounds(host, ctx.io, { totalRounds: 1 });
        expect(systemLines(ctx).at(-1)).toBe(`${hostName} set the tournament to 1 round.`);

        // The same count again: nothing sent
        const before = ctx.log.length;
        tournamentHandlers.setTournamentRounds(host, ctx.io, { totalRounds: 1 });
        expect(ctx.log.length).toBe(before);
        expect(selfErrors(ctx, host)).toEqual([]);
        expect(errorLogs).toEqual([]);
    });

    test('refused: a member who is not the host, someone in no tournament, after Begin, a bad count', async () => {
        const ctx = await setupTournament(2);
        const host = creatorSocket(ctx);
        const member = ctx.sockets.find((s) => s !== host);
        tournamentHandlers.setTournamentRounds(member, ctx.io, { totalRounds: 2 });
        expect(selfErrors(ctx, member)).toEqual(['Only the host can change the number of rounds']);

        const other = await setupTournament(1, { io: ctx.io, log: ctx.log });
        await tournamentHandlers.leaveTournament(other.sockets[0], ctx.io);
        tournamentHandlers.setTournamentRounds(other.sockets[0], ctx.io, { totalRounds: 2 });
        expect(selfErrors(ctx, other.sockets[0])).toEqual(['Not in a tournament']);

        tournamentHandlers.setTournamentRounds(host, ctx.io, { totalRounds: 9 });
        expect(selfErrors(ctx, host)).toEqual(['Rounds must be from 1 to 5']);

        ctx.starting = tournamentHandlers.beginTournament(host, ctx.io);
        tournamentHandlers.setTournamentRounds(host, ctx.io, { totalRounds: 2 });
        expect(selfErrors(ctx, host).at(-1)).toBe('Rounds can only change before the tournament begins');
        expect(ctx.t.totalRounds).toBe(4);
        expect(settings(ctx)).toEqual([]);
        await jest.advanceTimersByTimeAsync(5000);
        await ctx.starting;
        expect(ctx.t.phase).toBe('round_active');
        tournamentHandlers.setTournamentRounds(host, ctx.io, { totalRounds: 2 });
        expect(selfErrors(ctx, host).at(-1)).toBe('Rounds can only change before the tournament begins');
        expect(ctx.t.totalRounds).toBe(4);
    });

    test('a host hand-off moves the right', async () => {
        const ctx = await setupTournament(3);
        const host = creatorSocket(ctx);
        await tournamentHandlers.leaveTournament(host, ctx.io);
        const next = creatorSocket(ctx);
        expect(next).toBeDefined();
        expect(next).not.toBe(host);
        tournamentHandlers.setTournamentRounds(host, ctx.io, { totalRounds: 2 });
        expect(selfErrors(ctx, host)).toEqual(['Not in a tournament']);
        tournamentHandlers.setTournamentRounds(next, ctx.io, { totalRounds: 2 });
        expect(ctx.t.totalRounds).toBe(2);
        expect(settings(ctx)).toEqual([{ totalRounds: 2, by: ctx.usernames[ctx.sockets.indexOf(next)] }]);
    });
});

describe('whole tournaments of 1, 2, 3 and 5 rounds', () => {
    test.each([1, 2, 3, 5])('%i round(s): every event says so, and it ends after exactly that many', async (n) => {
        Math.random = mulberry32(40 + n);
        const ctx = await setupTournament(3);
        tournamentHandlers.setTournamentRounds(creatorSocket(ctx), ctx.io, { totalRounds: n });
        const { resolved } = await playTournament(ctx);

        expect(ctx.t.phase).toBe('complete');
        expect(ctx.t.currentRound).toBe(n);
        expect(ctx.t.rounds).toHaveLength(n);
        expect(resolved).toHaveLength(n);
        expect(events(ctx.log, 'tournamentRoundStart').map((l) => [l.data.roundNumber, l.data.totalRounds]))
            .toEqual(Array.from({ length: n }, (_, i) => [i + 1, n]));
        expect(events(ctx.log, 'tournamentRoundComplete').map((l) => [l.data.currentRound, l.data.totalRounds]))
            .toEqual(Array.from({ length: n - 1 }, (_, i) => [i + 1, n]));
        expect(events(ctx.log, 'tournamentGameComplete').every((l) => l.data.totalRounds === n)).toBe(true);
        const complete = events(ctx.log, 'tournamentComplete');
        expect(complete).toHaveLength(1);
        for (const row of complete[0].data.scoreboard) {
            expect(row.roundScores).toHaveLength(n);
            expect(row.totalScore).toBe(row.roundScores.reduce((a, b) => a + b, 0));
        }
        expect(ctx.t.getClientState()).toMatchObject({ phase: 'complete', currentRound: n, totalRounds: n });

        // No round past the last
        const before = events(ctx.log, 'tournamentRoundStart').length;
        await tournamentHandlers.beginNextRound(creatorSocket(ctx), ctx.io);
        expect(events(ctx.log, 'tournamentRoundStart')).toHaveLength(before);
        expect(errorLogs).toEqual([]);
    }, 180000);
});
