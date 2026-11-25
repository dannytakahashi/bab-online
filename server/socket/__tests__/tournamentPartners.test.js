/**
 * Partner rotation through the real tournament handlers (owner 2026-11-24;
 * game/tournamentPartners.js): every table's draw seats the round's planned
 * teams (positions 1&3 and 2&4), the wire is the ordinary draw, and over the
 * four rounds no member partners the human of their last played round
 * again; a member who drops sits a round out and comes back with their
 * history.
 */

'use strict';

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const tournamentHandlers = require('../tournamentHandlers');
const chatHandlers = require('../chatHandlers');
const gameLifecycle = require('../gameLifecycle');
const pacing = require('../../game/pacing');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { setupTournament, playTournament, kill, newUser, liveTables } = require('../../testUtils/tournamentDriver');
const { mulberry32 } = require('../../testUtils/gameDriver');

const NOW = 1_800_000_000_000;

let realRandom;
beforeAll(() => { realRandom = Math.random; });

beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    require('../../game/bot').botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const sortTeams = (teams) => teams.map((t) => [...t].sort()).sort((a, b) => a.join().localeCompare(b.join()));

/** The members seated as partners at a table: [[pos 1 & 3], [pos 2 & 4]], members only. */
function seatedTeams(game, members) {
    const name = (pos) => game.getOriginalPlayer(pos)?.username;
    return [[1, 3], [2, 4]].map((ps) => ps.map(name).filter((u) => members.includes(u)));
}

/** The round entry's planned teams, without the bots. */
function plannedTeams(t, game) {
    return t.roundOfGame(game.gameId).games.get(game.gameId).teams.map((team) => team.filter(Boolean));
}

/** Per round: each member's human partner (null: a bot), from the seats. */
function recordRound(rounds, game, members) {
    const round = rounds[rounds.length - 1];
    for (const team of seatedTeams(game, members)) {
        for (const u of team) round.set(u, team.find((v) => v !== u) ?? null);
    }
}

/** No member partners the human of their last played round. */
function expectNoBackToBack(rounds) {
    const last = new Map();
    for (const round of rounds) {
        for (const [u, partner] of round) {
            if (partner) expect(last.get(u)).not.toBe(partner);
        }
        for (const [u, partner] of round) last.set(u, partner);
    }
}

describe('the draw seats the planned teams', () => {
    test.each([
        [3, 1], [4, 2], [5, 3], [6, 4], [8, 5],
    ])('%i members over 4 rounds (seed %i)', async (n, seed) => {
        Math.random = mulberry32(seed);
        const ctx = await setupTournament(n);
        const rounds = [];
        const startDraws = [];
        await playTournament(ctx, {
            round: async (round, c, tables) => {
                rounds.push(new Map());
                for (const g of tables) {
                    expect(sortTeams(seatedTeams(g, ctx.usernames))).toEqual(sortTeams(plannedTeams(ctx.t, g)));
                    recordRound(rounds, g, ctx.usernames);
                    // The draw on the wire: four playerDrew and one teamsAnnounced
                    const room = ctx.log.filter((e) => e.to === g.roomName);
                    expect(room.filter((e) => e.event === 'playerDrew')).toHaveLength(4);
                    const announced = room.filter((e) => e.event === 'teamsAnnounced');
                    startDraws.push(room.filter((e) => e.event === 'startDraw').length);
                    if (announced.length) {
                        const { team1, team2 } = announced[0].data;
                        expect(team1).toEqual([1, 3].map((p) => g.getPlayerByPosition(p).username));
                        expect(team2).toEqual([2, 4].map((p) => g.getPlayerByPosition(p).username));
                    }
                }
            },
        });
        expect(ctx.t.phase).toBe('complete');
        expect(rounds).toHaveLength(4);
        expect(startDraws.every((k) => k === 1)).toBe(true);
        expectNoBackToBack(rounds);
        // Partnerships repeat only where the field forces it (3: once, 4: twice)
        const counts = ctx.t.partnerHistory().counts;
        const repeats = [...counts.values()].reduce((s, k) => s + (k - 1), 0);
        expect(repeats).toBe({ 3: 1, 4: 2 }[n] ?? 0);
        // Every member played every round
        for (const round of rounds) expect(round.size).toBe(n);
    }, 180000);
});

describe('a member who drops sits a round out and comes back with their history', () => {
    test('5 members: one drops in round 1, misses round 2, returns for rounds 3 and 4', async () => {
        Math.random = mulberry32(77);
        const ctx = await setupTournament(5);
        const dropper = ctx.sockets[1];
        const dropperName = ctx.usernames[1];
        const rounds = [];
        await playTournament(ctx, {
            round: async (round, c, tables) => {
                rounds.push(new Map());
                for (const g of tables) {
                    expect(sortTeams(seatedTeams(g, ctx.usernames))).toEqual(sortTeams(plannedTeams(ctx.t, g)));
                    recordRound(rounds, g, ctx.usernames);
                }
                if (round === 1) {
                    chatHandlers.chatMessage(dropper, ctx.io, { message: '/lazy' });
                    await kill(ctx.io, dropper);
                }
                if (round === 2) {
                    expect(rounds[1].has(dropperName)).toBe(false);
                    const back = newUser(ctx.io, ctx.log, dropperName);
                    await tournamentHandlers.joinTournament(back, ctx.io, { tournamentId: ctx.t.tournamentId });
                    expect(ctx.t.getPlayerByUsername(dropperName).connected).not.toBe(false);
                    ctx.sockets.push(back);
                }
            },
        });
        expect(ctx.t.phase).toBe('complete');
        expect(rounds.map((r) => r.has(dropperName))).toEqual([true, false, true, true]);
        expectNoBackToBack(rounds);
        // With 5 members (one pair a round) no partnership ever repeats
        expect([...ctx.t.partnerHistory().counts.values()].every((k) => k === 1)).toBe(true);
        // Round 3: the dropper's last played round was round 1
        const r1 = rounds[0].get(dropperName);
        if (r1) expect(rounds[2].get(dropperName)).not.toBe(r1);
    }, 180000);
});

describe('a table aborted before its draw adds no partnership', () => {
    // A test that acts inside the countdown needs it (BAB_PACING=zero has none)
    const inWindow = (ms) => (ms > 0 ? test : test.skip);
    inWindow(pacing().TABLE_COUNTDOWN_MS)('7 members: the 3-member table aborts in the countdown; its pair stays unpartnered', async () => {
        Math.random = mulberry32(11);
        const ctx = await setupTournament(7);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(2000);
        const tables = liveTables(ctx.t);
        expect(tables).toHaveLength(2);
        const three = tables.find((g) => ctx.t.roundOfGame(g.gameId).games.get(g.gameId).humanPlayers.length === 3);
        const [pair] = plannedTeams(ctx.t, three).filter((team) => team.length === 2);
        expect(three.seatList()).toHaveLength(0);
        await gameLifecycle.abortGame(ctx.io, three, 'test');
        await jest.advanceTimersByTimeAsync(10000);
        await ctx.starting;
        const h = ctx.t.partnerHistory();
        expect(h.counts.has(require('../../game/tournamentPartners').pairKey(...pair))).toBe(false);
        expect(h.last.has(pair[0])).toBe(false);
        // The 4-member table's two pairs count
        expect(h.counts.size).toBe(2);
    }, 60000);
});
