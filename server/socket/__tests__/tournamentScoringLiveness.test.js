/**
 * Tournament scoring and liveness (owner decisions 2026-11-15), through the
 * real handlers with stub sockets, fake timers and the in-memory DB:
 *   - an aborted table scores the running score; a member who LEFT scores
 *     min(running, 0); recorded once
 *   - a member who misses a round scores that round's lowest
 *   - between rounds, 2 minutes after the round ends the host may begin
 *     with the ready members; the others sit out
 *   - a host idle for 3 minutes while the others are ready hands the role on
 */

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
const liveness = require('../tournamentLiveness');
const { Phase } = require('../../game/GamePhase');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { events } = require('../../testUtils/gameDriver');
const { kill, setupTournament, liveTables, creatorSocket, advanceUntil } = require('../../testUtils/tournamentDriver');

let errorLogs;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
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
});

const sockOf = (ctx, g, pos) => ctx.sockets.find((s) => s.id === g.seat(pos).ownerSocketId);
const teamOf = (pos) => (pos === 1 || pos === 3 ? 'team1' : 'team2');
const roundScore = (ctx, u, round) => ctx.t.scoreboard[u].roundScores[round - 1];
const errorsTo = (ctx, socket, handler) => ctx.log.filter((l) => l.event === 'serverError' && l.to === `self:${socket.id}` && l.data.handler === handler);

/** Begin (round 1 or the next round) and wait until every table is seated. */
async function beginAndSeat(ctx, { next = false, by = creatorSocket(ctx) } = {}) {
    const starting = next ? tournamentHandlers.beginNextRound(by, ctx.io) : tournamentHandlers.beginTournament(by, ctx.io);
    await advanceUntil(() => liveTables(ctx.t).length > 0 &&
        liveTables(ctx.t).every((g) => [Phase.BIDDING, Phase.PLAYING].includes(g.stage)), 100, 120000);
    await starting;
    return liveTables(ctx.t);
}

/** End every live table of the round with the progress watchdog's abort. */
async function stallAbortAll(ctx) {
    for (const g of liveTables(ctx.t)) await gameLifecycle.abortGame(ctx.io, g, 'Game stalled');
}

function readyAll(ctx, except = []) {
    for (const s of ctx.sockets) {
        if (except.includes(s)) continue;
        if (gameManager.getPlayerTournament(s.id) === ctx.t) tournamentHandlers.tournamentReady(s, ctx.io);
    }
}

describe('aborted table scoring', () => {
    // Two humans (+ 2 bots) at one table; both /leave, the table aborts
    // ('All players left'). Each scores min(their team's running score, 0).
    test.each([
        ['both teams behind', { team1: -150, team2: -40 }],
        ['both teams ahead', { team1: 120, team2: 60 }],
        ['one ahead, one behind', { team1: -90, team2: 210 }],
    ])('every human leaves (%s): min(running, 0) each, recorded once', async (_label, score) => {
        const ctx = await setupTournament(2);
        const [g] = await beginAndSeat(ctx);
        g.score = { ...score };
        const humans = g.seatList().filter((s) => s.ownerUsername).map((s) => ({ u: s.ownerUsername, pos: s.position }));
        for (const { pos } of humans) chatHandlers.chatMessage(sockOf(ctx, g, pos), ctx.io, { message: '/leave' });
        await jest.advanceTimersByTimeAsync(100);
        expect(g.stage).toBe(Phase.ABORTED);
        for (const { u, pos } of humans) {
            expect({ u, got: roundScore(ctx, u, 1) }).toEqual({ u, got: Math.min(score[teamOf(pos)], 0) });
            expect(ctx.t.scoreboard[u].roundDetails).toHaveLength(1);
            expect(ctx.t.scoreboard[u].roundDetails[0]).toMatchObject({ aborted: true, left: true, gameId: g.gameId });
        }
        const done = events(ctx.log, 'tournamentGameComplete');
        expect(done).toHaveLength(1);
        expect(done[0].data).toMatchObject({ aborted: true, gameId: g.gameId });
        // The round completes with those scores (and the round count is not 0)
        expect(ctx.t.phase).toBe('between_rounds');
        expect(events(ctx.log, 'tournamentRoundComplete')).toHaveLength(1);
        expect(errorLogs).toEqual([]);
    });

    test('a stall abort with no leaver: everyone (a lazy and a disconnected member too) scores the running score', async () => {
        const ctx = await setupTournament(4);
        const [g] = await beginAndSeat(ctx);
        g.score = { team1: -70, team2: 230 };
        chatHandlers.chatMessage(sockOf(ctx, g, 1), ctx.io, { message: '/lazy' });
        await kill(ctx.io, sockOf(ctx, g, 2));
        await stallAbortAll(ctx);
        for (const s of g.seatList()) {
            expect(roundScore(ctx, s.ownerUsername, 1)).toBe(g.score[teamOf(s.position)]);
            expect(ctx.t.scoreboard[s.ownerUsername].roundDetails[0].left).toBeUndefined();
        }
        expect(errorLogs).toEqual([]);
    });

    test('a leader who /leaves a winning table, then the table stalls: the leaver 0, the stayers their running score', async () => {
        const ctx = await setupTournament(4);
        const [g] = await beginAndSeat(ctx);
        g.score = { team1: 180, team2: -60 };
        const leaverSeat = g.seat(1);
        const leaver = leaverSeat.ownerUsername;
        chatHandlers.chatMessage(sockOf(ctx, g, 1), ctx.io, { message: '/leave' });
        expect(g.seat(1).presence).toBe('gone');
        expect(g.isTerminal()).toBe(false);
        await stallAbortAll(ctx);
        expect(roundScore(ctx, leaver, 1)).toBe(0);
        for (const s of g.seatList().filter((x) => x.position !== 1)) {
            expect(roundScore(ctx, s.ownerUsername, 1)).toBe(g.score[teamOf(s.position)]);
        }
    });

    test('a member who leaves the tournament while seated counts as a leaver (row kept, never a winner)', async () => {
        const ctx = await setupTournament(4);
        const [g] = await beginAndSeat(ctx);
        g.score = { team1: -120, team2: 40 };
        const quitter = sockOf(ctx, g, 1);
        const name = g.seat(1).ownerUsername;
        await tournamentHandlers.leaveTournament(quitter, ctx.io);
        expect(ctx.t.getPlayerByUsername(name)).toBeNull();
        await stallAbortAll(ctx);
        expect(roundScore(ctx, name, 1)).toBe(-120);
        expect(ctx.t.scoreboard[name].roundDetails[0].left).toBe(true);
    });

    test('a cancelled tournament still records nothing for its aborted tables', async () => {
        const ctx = await setupTournament(2);
        const [g] = await beginAndSeat(ctx);
        g.score = { team1: -150, team2: 90 };
        await tournamentHandlers.cancelTournament(creatorSocket(ctx), ctx.io);
        for (const u of ctx.usernames) expect(ctx.t.scoreboard[u].roundScores).toEqual([]);
    });
});

describe('missed rounds score the round\'s lowest', () => {
    test('a member disconnected at the round start sits out and gets the lowest recorded score', async () => {
        const ctx = await setupTournament(5);
        const tables = await beginAndSeat(ctx);
        expect(tables).toHaveLength(2);
        tables[0].score = { team1: -230, team2: 50 };
        tables[1].score = { team1: 10, team2: -40 };
        await stallAbortAll(ctx);
        expect(ctx.t.phase).toBe('between_rounds');

        // Round 2: one member is away; the rest play
        const away = ctx.sockets[4];
        const awayName = ctx.usernames[4];
        await kill(ctx.io, away);
        readyAll(ctx, [away]);
        const round2 = await beginAndSeat(ctx, { next: true });
        expect(round2.flatMap((g) => g.seatList().map((s) => s.ownerUsername))).not.toContain(awayName);
        round2.forEach((g, i) => { g.score = i === 0 ? { team1: 70, team2: -310 } : { team1: 15, team2: 5 }; });
        await stallAbortAll(ctx);
        const recorded2 = ctx.usernames.filter((u) => u !== awayName).map((u) => roundScore(ctx, u, 2));
        expect(roundScore(ctx, awayName, 2)).toBe(Math.min(...recorded2));
        expect(ctx.t.scoreboard[awayName].roundDetails[1]).toMatchObject({ roundNumber: 2, missed: true });
        // Every member has a score for every completed round
        for (const u of ctx.usernames) expect(ctx.t.scoreboard[u].roundScores).toHaveLength(2);
        expect(errorLogs).toEqual([]);
    });

    test('a round where no table recorded a score: the missed member gets 0', () => {
        const TournamentState = require('../../game/TournamentState');
        const t = new TournamentState('tid-none-0000', 'T', 's1', 'a');
        t.addPlayer('s1', 'a', null);
        t.addPlayer('s2', 'b', null);
        t.startRound(1);
        t.completeRound();
        expect(t.scoreboard.a.roundScores).toEqual([0]);
        expect(t.scoreboard.b.roundDetails).toEqual([{ roundNumber: 1, teamScore: 0, missed: true }]);
    });

    test('TournamentState: a leader who sits out the last round no longer wins on a 0', () => {
        const TournamentState = require('../../game/TournamentState');
        const t = new TournamentState('tid-lead-0000', 'T', 'sL', 'leader');
        for (const [sid, u] of [['sL', 'leader'], ['sX', 'x'], ['sY', 'y']]) t.addPlayer(sid, u, null);
        // Three rounds in: leader 150, x 40, y 0
        t.recordPlayerRoundScore('leader', { roundNumber: 1, teamScore: 150 });
        t.recordPlayerRoundScore('x', { roundNumber: 1, teamScore: 40 });
        t.recordPlayerRoundScore('y', { roundNumber: 1, teamScore: 0 });
        for (const r of [2, 3]) for (const u of ['leader', 'x', 'y']) t.recordPlayerRoundScore(u, { roundNumber: r, teamScore: 0 });
        // Round 4: the leader closed the tab; x and y play (opponents)
        t.markPlayerDisconnected('sL');
        t.startRound(4);
        t.addGameToRound('g4', ['x', 'y'], 2);
        t.recordPlayerRoundScore('x', { roundNumber: 4, teamScore: 100 });
        t.recordPlayerRoundScore('y', { roundNumber: 4, teamScore: -200 });
        t.markGameComplete('g4');
        t.completeRound();
        expect(t.scoreboard.leader.roundScores[3]).toBe(-200);
        expect(t.scoreboard.leader.totalScore).toBe(-50);
        // (with a 0 the leader's 150 beat x's 140)
        expect(t.getWinners()).toEqual(['x']);
    });
});

describe('the between-rounds ready deadline', () => {
    async function betweenRounds(n) {
        const ctx = await setupTournament(n);
        await beginAndSeat(ctx);
        await stallAbortAll(ctx);
        expect(ctx.t.phase).toBe('between_rounds');
        return ctx;
    }

    test('Begin is refused until the deadline; after it the host starts with the ready members, the rest sit out and score the lowest', async () => {
        const ctx = await betweenRounds(5);
        const host = creatorSocket(ctx);
        const sitter = ctx.sockets.find((s) => s !== host);
        const sitterName = gameManager.getUserBySocketId(sitter.id).username;
        readyAll(ctx, [sitter]);
        await tournamentHandlers.beginNextRound(host, ctx.io);
        expect(errorsTo(ctx, host, 'beginNextRound').map((l) => l.data.message)).toEqual(['Not all players are ready']);
        expect(ctx.t.phase).toBe('between_rounds');
        expect(ctx.t.getClientState().readyDeadlinePassed).toBe(false);

        const mark = ctx.log.length;
        await jest.advanceTimersByTimeAsync(liveness.READY_DEADLINE_MS);
        const after = ctx.log.slice(mark);
        const update = after.filter((l) => l.event === 'tournamentReadyUpdate');
        expect(update).toHaveLength(1);
        expect(update[0].data).toMatchObject({ allReady: false, readyDeadlinePassed: true });
        expect(after.filter((l) => l.event === 'tournamentMessage').map((l) => l.data)).toEqual([
            expect.objectContaining({ system: true, type: 'system', message: 'Players who are not ready will sit out the next round.' }),
        ]);
        expect(ctx.t.getClientState().readyDeadlinePassed).toBe(true);

        const round2 = await beginAndSeat(ctx, { next: true, by: host });
        expect(ctx.t.currentRound).toBe(2);
        expect(round2.flatMap((g) => g.seatList().map((s) => s.ownerUsername))).not.toContain(sitterName);
        expect(gameManager.playerGames.has(sitter.id)).toBe(false);
        round2.forEach((g) => { g.score = { team1: -80, team2: 30 }; });
        await stallAbortAll(ctx);
        expect(roundScore(ctx, sitterName, 2)).toBe(-80);
        expect(errorLogs).toEqual([]);
    });

    test('past the deadline the host must be ready; a new round wait has its own deadline', async () => {
        const ctx = await betweenRounds(3);
        const host = creatorSocket(ctx);
        const others = ctx.sockets.filter((s) => s !== host);
        tournamentHandlers.tournamentReady(others[0], ctx.io);
        await jest.advanceTimersByTimeAsync(liveness.READY_DEADLINE_MS);
        await tournamentHandlers.beginNextRound(host, ctx.io);
        expect(errorsTo(ctx, host, 'beginNextRound')).toHaveLength(1);
        tournamentHandlers.tournamentReady(host, ctx.io);
        await beginAndSeat(ctx, { next: true, by: host });
        await stallAbortAll(ctx);
        expect(ctx.t.phase).toBe('between_rounds');
        expect(ctx.t.readyDeadlinePassed()).toBe(false);
        tournamentHandlers.tournamentReady(host, ctx.io);
        await tournamentHandlers.beginNextRound(host, ctx.io);
        expect(errorsTo(ctx, host, 'beginNextRound')).toHaveLength(2);
    });
});

describe('idle host hand-off', () => {
    const handOffs = (ctx) => events(ctx.log, 'tournamentPlayerLeft').filter((l) => l.data.reason === 'hostIdle');

    test('lobby: the host idles 3 minutes while every other member is ready; the role moves, announced like a host leaving', async () => {
        const ctx = await setupTournament(3);
        const oldHost = ctx.sockets[0];
        tournamentHandlers.tournamentUnready(oldHost, ctx.io); // the host is the one not ready
        await jest.advanceTimersByTimeAsync(liveness.HOST_IDLE_MS - 1000);
        expect(handOffs(ctx)).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(1000);
        const [h] = handOffs(ctx);
        expect(h.data).toMatchObject({ username: ctx.usernames[0], newCreator: ctx.usernames[1], reason: 'hostIdle' });
        expect(h.to).toBe(ctx.t.roomName);
        expect(ctx.t.createdBy).toBe(ctx.sockets[1].id);
        expect(h.data.players.find((p) => p.username === ctx.usernames[1]).isCreator).toBe(true);
        expect(events(ctx.log, 'tournamentMessage').map((l) => l.data.message))
            .toContain(`${ctx.usernames[0]} was idle, so ${ctx.usernames[1]} is now the host.`);
        // The old host is a plain member now; the new one can begin
        await tournamentHandlers.beginTournament(oldHost, ctx.io);
        expect(errorsTo(ctx, oldHost, 'beginTournament')).toHaveLength(1);
        tournamentHandlers.tournamentReady(oldHost, ctx.io);
        await beginAndSeat(ctx, { by: ctx.sockets[1] });
        expect(ctx.t.phase).toBe('round_active');
        expect(errorLogs).toEqual([]);
    });

    test('no hand-off while another member is not ready, and the host\'s chat or ready restarts the clock', async () => {
        const ctx = await setupTournament(3);
        tournamentHandlers.tournamentUnready(ctx.sockets[2], ctx.io);
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(handOffs(ctx)).toHaveLength(0);
        tournamentHandlers.tournamentReady(ctx.sockets[2], ctx.io);
        await jest.advanceTimersByTimeAsync(liveness.HOST_IDLE_MS - 10000);
        tournamentHandlers.tournamentChat(ctx.sockets[0], ctx.io, { message: 'one sec' });
        await jest.advanceTimersByTimeAsync(liveness.HOST_IDLE_MS - 10000);
        expect(handOffs(ctx)).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(10000);
        expect(handOffs(ctx)).toHaveLength(1);
    });

    test('never mid-round; between rounds past the deadline the role goes to a ready member', async () => {
        const ctx = await setupTournament(4);
        await beginAndSeat(ctx);
        expect(ctx.t.timers.size).toBe(0);
        await jest.advanceTimersByTimeAsync(5000);
        expect(handOffs(ctx)).toHaveLength(0);
        await stallAbortAll(ctx);
        // Between rounds: one member AFK (not ready), the host idle, one ready
        const [host, , ready] = ctx.sockets; // the 2nd and 4th never ready
        expect(creatorSocket(ctx)).toBe(host);
        tournamentHandlers.tournamentReady(ready, ctx.io);
        await jest.advanceTimersByTimeAsync(liveness.READY_DEADLINE_MS);
        expect(handOffs(ctx)).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(liveness.HOST_IDLE_MS);
        const [h] = handOffs(ctx);
        expect(h.data.newCreator).toBe(gameManager.getUserBySocketId(ready.id).username);
        // The new host starts with the ready players
        await beginAndSeat(ctx, { next: true, by: ready });
        expect(ctx.t.currentRound).toBe(2);
        expect(liveTables(ctx.t).flatMap((g) => g.seatList().map((s) => s.ownerUsername)).filter(Boolean))
            .toEqual([gameManager.getUserBySocketId(ready.id).username]);
    });

    test('cancel and abandonment leave no tournament timer behind', async () => {
        const ctx = await setupTournament(3);
        await beginAndSeat(ctx);
        await stallAbortAll(ctx);
        readyAll(ctx, [ctx.sockets[0]]);
        expect(ctx.t.hasTimer('readyDeadline')).toBe(true);
        expect(ctx.t.hasTimer('hostIdle')).toBe(true);
        await tournamentHandlers.cancelTournament(ctx.sockets[0], ctx.io);
        expect(ctx.t.timers.size).toBe(0);
        const mark = ctx.log.length;
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(ctx.log.slice(mark).filter((l) => l.event.startsWith('tournament'))).toEqual([]);

        const ctx2 = await setupTournament(2);
        await beginAndSeat(ctx2);
        await stallAbortAll(ctx2);
        expect(ctx2.t.timers.size).toBeGreaterThan(0);
        for (const s of ctx2.sockets) await kill(ctx2.io, s);
        expect(gameManager.getTournamentById(ctx2.t.tournamentId)).toBeNull();
        expect(ctx2.t.timers.size).toBe(0);
    });
});
