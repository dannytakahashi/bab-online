/**
 * Tournament lifecycle through the real handlers (create, join, ready,
 * begin, rounds, cancel, leave, disconnect, rejoin, return), with stub
 * sockets, fake timers and the in-memory DB:
 *   - cancel in every phase and inside every await window of the round
 *     start ends the round's games through gameLifecycle.abortGame, sends
 *     abortGame before tournamentCancelled, and leaves nothing behind
 *   - every table of a round starts its draw at the same instant
 *   - full tournaments (bots playing, /lazy humans, a mid-round disconnect
 *     with resign and rejoin) finish with every game resolved exactly once
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
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const gameLifecycle = require('../gameLifecycle');
const GamePhase = require('../../game/GamePhase');
const { botController } = require('../../game/bot');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { events } = require('../../testUtils/gameDriver');
const {
    newIo, kill, newUser, setupTournament, liveTables, creatorSocket, advanceUntil, playTournament, currentSeq,
} = require('../../testUtils/tournamentDriver');

const { Phase } = GamePhase;

// Nothing of a tournament's start may reach anyone after it is cancelled
const START_EVENTS = ['tournamentRoundStart', 'tournamentGameAssignment', 'allPlayersReady', 'startDraw'];
const RESULT_EVENTS = ['tournamentGameComplete', 'tournamentRoundComplete', 'tournamentComplete'];

let errorLogs;

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
});





/** Resolves a DB write gate: matching updateOne calls wait until release(). */
function gateUpdates(match) {
    const users = mockDb.current.users;
    const real = users.updateOne.bind(users);
    let open;
    const gate = new Promise((r) => { open = r; });
    const state = { hits: 0, release: () => open() };
    users.updateOne = async (filter, update) => {
        if (match(filter, update)) {
            state.hits++;
            await gate;
        }
        return real(filter, update);
    };
    return state;
}



/** Begin round 1 and wait until every table is in `stages`. */
async function beginAndReach(ctx, stages = [Phase.BIDDING, Phase.PLAYING]) {
    ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
    await advanceUntil(() => liveTables(ctx.t).length > 0 &&
        liveTables(ctx.t).every((g) => stages.includes(g.stage)), 100, 120000);
    await ctx.starting;
    return liveTables(ctx.t);
}

/**
 * Everything a cancelled tournament may leave: nothing. Checks the
 * tournament maps, every table (aborted through abortGame, retired, no
 * bots / timers / mappings / room members) and the DB pointers.
 */
function expectGone(ctx, tables) {
    const { t, io } = ctx;
    expect(gameManager.getTournamentById(t.tournamentId)).toBeNull();
    expect(t.retired).toBe(true);
    expect([...gameManager.tournamentGames.values()]).not.toContain(t.tournamentId);
    expect([...gameManager.playerTournaments.values()]).not.toContain(t.tournamentId);
    expect(io.rooms.get(t.roomName)?.size || 0).toBe(0);
    for (const g of tables) {
        expect(g.stage).toBe(Phase.ABORTED);
        expect(g.epoch).toBe(1);
        expect(gameManager.getGameById(g.gameId)).toBeNull();
        expect(gameManager.tournamentGames.has(g.gameId)).toBe(false);
        expect([...gameManager.playerGames.values()]).not.toContain(g.gameId);
        expect([...gameManager.spectatorGames.values()]).not.toContain(g.gameId);
        expect(botController.getGameBots(g.gameId)).toEqual([]);
        expect([...botController.pendingActions.keys()].filter((k) => k.startsWith(`${g.gameId}:`))).toEqual([]);
        expect(g.pendingTimerCount).toBe(0);
        expect(io.rooms.get(g.roomName)?.size || 0).toBe(0);
    }
    for (const u of ctx.usernames) {
        const doc = mockDb.current.users.docs.find((d) => d.username === u);
        expect(doc.activeTournamentId).toBeUndefined();
        expect(doc.activeGameId).toBeUndefined();
    }
    // No tournament results for aborted games
    for (const entry of Object.values(t.scoreboard)) {
        expect(entry.roundDetails.filter((d) => tables.some((g) => g.gameId === d.gameId))).toEqual([]);
    }
    expect(errorLogs).toEqual([]);
}

/**
 * Cancel and check the wire: abortGame to every live table (reaching its
 * players and spectators) strictly before the one tournamentCancelled, and
 * nothing of the start or results afterwards.
 */
async function cancelAndCheck(ctx, { settle = 15000, release } = {}) {
    const { io, log, t } = ctx;
    const tables = liveTables(t);
    const roomsBefore = new Map(tables.map((g) => [g.gameId, [...(io.rooms.get(g.roomName) || [])]]));
    const membersBefore = [...(io.rooms.get(t.roomName) || [])];
    const mark = log.length;
    const creator = creatorSocket(ctx);
    const cancelling = tournamentHandlers.cancelTournament(creator, io);
    // Synchronous teardown: the tournament is gone before the first await
    expect(gameManager.getTournamentById(t.tournamentId)).toBeNull();
    if (release) release();
    await cancelling;
    await jest.advanceTimersByTimeAsync(settle);
    if (ctx.starting) await ctx.starting;

    const after = log.slice(mark);
    const cancelled = after.filter((l) => l.event === 'tournamentCancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].to).toBe(t.roomName);
    expect(cancelled[0].members.sort()).toEqual(membersBefore.sort());
    const cancelIdx = after.indexOf(cancelled[0]);
    for (const g of tables) {
        const aborts = after.filter((l) => l.event === 'abortGame' && l.to === g.roomName);
        expect(aborts).toHaveLength(1);
        // CHANGED (snapshot v2 seq, additive): room broadcasts carry seq
        expect(aborts[0].data).toEqual({ reason: 'Tournament cancelled', seq: expect.any(Number) });
        expect(after.indexOf(aborts[0])).toBeLessThan(cancelIdx);
        // Every player (and spectator) in the table's room got it
        expect(aborts[0].members.sort()).toEqual(roomsBefore.get(g.gameId).sort());
    }
    for (const e of [...START_EVENTS, ...RESULT_EVENTS]) {
        expect(after.filter((l) => l.event === e)).toEqual([]);
    }
    expectGone(ctx, tables);
    return { tables, after };
}

/** iOS answers abortGame with returnToTournament: it must land in the main room. */
function expectReturnLandsInMainRoom(ctx, socket) {
    const mark = ctx.log.length;
    tournamentHandlers.returnToTournament(socket, ctx.io);
    const mine = ctx.log.slice(mark).filter((l) => l.to === `self:${socket.id}`).map((l) => l.event);
    expect(mine).toEqual(['tournamentLeft', 'mainRoomJoined']);
}

describe('cancel in every tournament phase', () => {
    test('lobby: tournamentCancelled, nothing else, everyone free', async () => {
        const ctx = await setupTournament(3);
        await cancelAndCheck(ctx);
        expect(gameManager.games.size).toBe(0);
        expectReturnLandsInMainRoom(ctx, ctx.sockets[1]);
        // Everyone can create a new tournament right away
        tournamentHandlers.createTournament(ctx.sockets[2], ctx.io);
        expect(gameManager.getPlayerTournament(ctx.sockets[2].id)).not.toBeNull();
    });

    test('during the activeTournamentId writes (before any round exists)', async () => {
        const ctx = await setupTournament(6);
        const gate = gateUpdates((f, u) => u.$set && 'activeTournamentId' in u.$set);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(0);
        expect(gate.hits).toBe(6);
        expect(ctx.t.phase).toBe('starting');
        await cancelAndCheck(ctx, { release: gate.release });
        expect(gameManager.games.size).toBe(0);
        expect(events(ctx.log, 'tournamentRoundStart')).toHaveLength(0);
    });

    test('during the round announce (no table yet)', async () => {
        const ctx = await setupTournament(6);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(500);
        expect(events(ctx.log, 'tournamentRoundStart')).toHaveLength(1);
        expect(liveTables(ctx.t)).toHaveLength(0);
        await cancelAndCheck(ctx);
        expect(gameManager.games.size).toBe(0);
    });

    test('during the setActiveGame batch (tables created, nothing sent to them yet)', async () => {
        const ctx = await setupTournament(6);
        const gate = gateUpdates((f, u) => u.$set && 'activeGameId' in u.$set);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(1600);
        const tables = liveTables(ctx.t);
        expect(tables).toHaveLength(2);
        expect(gate.hits).toBe(6);
        // All table players are already in their table's room
        for (const g of tables) expect(ctx.io.rooms.get(g.roomName).size).toBeGreaterThan(0);
        expect(events(ctx.log, 'tournamentGameAssignment')).toHaveLength(0);
        // The writes land after the aborts' own clears: the start re-clears
        await cancelAndCheck(ctx, { release: gate.release });
        expectReturnLandsInMainRoom(ctx, ctx.sockets[3]);
    });

    test('during the shared pre-draw countdown', async () => {
        const ctx = await setupTournament(6);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(2500);
        expect(events(ctx.log, 'tournamentGameAssignment')).toHaveLength(6);
        expect(events(ctx.log, 'startDraw')).toHaveLength(0);
        const tables = liveTables(ctx.t);
        expect(tables.every((g) => g.stage === Phase.CREATED)).toBe(true);
        await cancelAndCheck(ctx);
    });

    test('during the draw', async () => {
        const ctx = await setupTournament(6);
        await beginAndReach(ctx, [Phase.DRAWING]);
        await cancelAndCheck(ctx);
    });

    test('mid-round with lazy, disconnected, resigned and /leave seats, spectators watching', async () => {
        const ctx = await setupTournament(8); // two 4-human tables
        const tables = await beginAndReach(ctx);
        expect(tables).toHaveLength(2);
        const [a, b] = tables;
        const sock = (g, pos) => ctx.sockets.find((s) => s.id === g.seat(pos).ownerSocketId);

        // Table A: seat 1 lazy, seat 2 disconnected (grace), seat 3 resigned
        chatHandlers.chatMessage(sock(a, 1), ctx.io, { message: '/lazy' });
        const dc = sock(a, 2);
        await kill(ctx.io, dc);
        const resigned = sock(a, 3);
        await kill(ctx.io, resigned);
        await jest.advanceTimersByTimeAsync(61000);
        await gameHandlers.forceResign(sock(a, 4), ctx.io, { position: 3 });
        // Seat 2 is resignable too by now; leave it there
        expect(a.seat(2).presence).toBe('resignable');
        expect(a.seat(3).controller).toBe('resignBot');
        // Table B: seat 1 /leave'd, a casual user and a tournament spectator watch
        const leaver = sock(b, 1);
        chatHandlers.chatMessage(leaver, ctx.io, { message: '/leave' });
        const watcher = newUser(ctx.io, ctx.log, `watcher${currentSeq()}`);
        tournamentHandlers.spectateTournament(watcher, ctx.io, { tournamentId: ctx.t.tournamentId });
        tournamentHandlers.spectateTournamentGame(watcher, ctx.io, { gameId: b.gameId });
        expect(gameManager.spectatorGames.get(watcher.id)).toBe(b.gameId);
        expect(a.isTerminal() || b.isTerminal()).toBe(false);

        const { after } = await cancelAndCheck(ctx);
        // The watcher got both: abortGame at the table, then the tournament's
        const watcherEvents = after.filter((l) => l.members?.includes(watcher.id)).map((l) => l.event);
        expect(watcherEvents.indexOf('abortGame')).toBeLessThan(watcherEvents.indexOf('tournamentCancelled'));
        expect(after.filter((l) => l.event === 'resignationAvailable')).toEqual([]);
        // Clients' follow-ups land in the main room
        expectReturnLandsInMainRoom(ctx, sock(b, 2) || ctx.sockets.find((s) => s.id !== leaver.id && s.connected));
        expectReturnLandsInMainRoom(ctx, watcher);
        // The disconnected players reconnect: no tournament, no game to rejoin
        const back = newUser(ctx.io, ctx.log, ctx.usernames[0]);
        expect(gameManager.reattachTournamentPlayer(back.id, ctx.usernames[0])).toBeNull();
    });

    test('between rounds', async () => {
        const ctx = await setupTournament(6);
        const tables = await beginAndReach(ctx);
        for (const g of tables) await gameLifecycle.abortGame(ctx.io, g, 'test');
        expect(ctx.t.phase).toBe('between_rounds');
        expect(events(ctx.log, 'tournamentRoundComplete')).toHaveLength(1);
        await cancelAndCheck(ctx);
    });

    test('after the tournament ended (results window)', async () => {
        const ctx = await setupTournament(6);
        for (let round = 1; round <= 4; round++) {
            if (round > 1) {
                for (const s of ctx.sockets) tournamentHandlers.tournamentReady(s, ctx.io);
                ctx.starting = tournamentHandlers.beginNextRound(creatorSocket(ctx), ctx.io);
                await advanceUntil(() => liveTables(ctx.t).length > 0 &&
                    liveTables(ctx.t).every((g) => g.stage === Phase.BIDDING || g.stage === Phase.PLAYING), 100, 120000);
                await ctx.starting;
            } else {
                await beginAndReach(ctx);
            }
            for (const g of liveTables(ctx.t)) await gameLifecycle.abortGame(ctx.io, g, 'test');
        }
        expect(ctx.t.phase).toBe('complete');
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        ctx.starting = null;
        await cancelAndCheck(ctx);
        // The results-window cleanup was dropped with it
        await jest.advanceTimersByTimeAsync(11 * 60 * 1000);
        expect(errorLogs).toEqual([]);
    });

    test('a second cancel and a non-creator cancel are refused', async () => {
        const ctx = await setupTournament(4);
        await tournamentHandlers.cancelTournament(ctx.sockets[1], ctx.io);
        expect(ctx.log.filter((l) => l.to === `self:${ctx.sockets[1].id}` && l.event === 'error').pop().data.message)
            .toBe('Only the creator can cancel the tournament');
        expect(gameManager.getTournamentById(ctx.t.tournamentId)).not.toBeNull();
        await tournamentHandlers.cancelTournament(ctx.sockets[0], ctx.io);
        await tournamentHandlers.cancelTournament(ctx.sockets[0], ctx.io);
        expect(events(ctx.log, 'tournamentCancelled')).toHaveLength(1);
    });

    test('a game that ends normally while the tournament is cancelled records nothing', async () => {
        const ctx = await setupTournament(4); // one 4-human table
        const [g] = await beginAndReach(ctx);
        for (let pos = 1; pos <= 4; pos++) {
            chatHandlers.chatMessage(ctx.sockets.find((s) => s.id === g.seat(pos).ownerSocketId), ctx.io, { message: '/lazy' });
        }
        // Hold the game-end path in its activeGameId clear, cancel meanwhile
        const gate = gateUpdates((f, u) => u.$unset && 'activeGameId' in u.$unset && f.activeGameId === g.gameId);
        await advanceUntil(() => g.stage === Phase.ENDED, 30000, 60 * 60 * 1000);
        expect(gate.hits).toBeGreaterThan(0);
        const mark = ctx.log.length;
        await tournamentHandlers.cancelTournament(creatorSocket(ctx), ctx.io);
        gate.release();
        await jest.advanceTimersByTimeAsync(5000);
        const after = ctx.log.slice(mark).map((l) => l.event);
        for (const e of RESULT_EVENTS) expect(after).not.toContain(e);
        expect(after).not.toContain('abortGame');
        for (const entry of Object.values(ctx.t.scoreboard)) expect(entry.roundDetails).toEqual([]);
        expect(gameManager.tournamentGames.size).toBe(0);
        expect(events(ctx.log, 'gameEnd')).toHaveLength(1);
    });
});

describe('leave and disconnect during the round start', () => {
    test('a member leaving the tournament in the countdown leaves the table; the last one leaving aborts it', async () => {
        const ctx = await setupTournament(2); // one table: 2 humans + 2 bots
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(2000);
        const [g] = liveTables(ctx.t);
        expect(g.stage).toBe(Phase.CREATED);

        await tournamentHandlers.leaveTournament(ctx.sockets[1], ctx.io);
        expect(g.entrant(ctx.sockets[1].id).presence).toBe('left');
        expect(gameManager.playerGames.has(ctx.sockets[1].id)).toBe(false);
        expect(ctx.io.rooms.get(g.roomName).has(ctx.sockets[1].id)).toBe(false);

        // The last member leaves: the tournament is deleted and its table aborted
        const mark = ctx.log.length;
        await tournamentHandlers.leaveTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(10000);
        await ctx.starting;
        expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBeNull();
        expect(g.stage).toBe(Phase.ABORTED);
        const after = ctx.log.slice(mark).map((l) => l.event);
        expect(after).not.toContain('startDraw');
        expect(gameManager.tournamentGames.size).toBe(0);
        expect(gameManager.games.size).toBe(0);
    });

    test.each([
        ['leaveTournament', (ctx, s) => tournamentHandlers.leaveTournament(s, ctx.io)],
        ['/leave', (ctx, s) => chatHandlers.chatMessage(s, ctx.io, { message: '/leave' })],
    ])('%s during the setActiveGame batch: no assignment, no stale pointer', async (_name, leave) => {
        const ctx = await setupTournament(6);
        const leaver = ctx.sockets[1];
        const leaverName = ctx.usernames[1];
        const gate = gateUpdates((f, u) => u.$set && 'activeGameId' in u.$set);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(1600);
        const tables = liveTables(ctx.t);
        expect(tables).toHaveLength(2);
        expect(gate.hits).toBe(6);
        const table = tables.find((g) => g.entrant(leaver.id));

        await leave(ctx, leaver);
        expect(table.entrant(leaver.id).presence).toBe('left');
        const mark = ctx.log.length;
        gate.release();
        await advanceUntil(() => tables.every((g) => g.stage === Phase.BIDDING || g.stage === Phase.PLAYING), 100, 120000);
        await ctx.starting;

        const toLeaver = ctx.log.slice(mark).filter((l) => (l.to === leaver.id || l.members?.includes(leaver.id)) &&
            l.event !== 'lobbiesUpdated');
        expect(toLeaver.map((l) => l.event)).toEqual([]);
        // Everyone else still got their table
        const assigned = events(ctx.log, 'tournamentGameAssignment').map((l) => l.to);
        expect(assigned).toHaveLength(5);
        expect(assigned).not.toContain(leaver.id);
        expect(events(ctx.log, 'allPlayersReady').map((l) => l.to)).not.toContain(leaver.id);
        // The write that landed after the leave's clear is re-cleared;
        // the others keep their table
        const doc = (u) => mockDb.current.users.docs.find((d) => d.username === u);
        expect(doc(leaverName).activeGameId).toBeUndefined();
        for (const u of ctx.usernames.filter((u) => u !== leaverName)) {
            expect(doc(u).activeGameId).toBeDefined();
        }
        // The table goes on with a bot in the leaver's seat
        const pos = table.seatByUsername(leaverName);
        expect(table.seat(pos).controller).not.toBe('human');
        expect(errorLogs).toEqual([]);
    });

    test('everyone disconnecting in the announce deletes the tournament; the start stops', async () => {
        const ctx = await setupTournament(3);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(200);
        for (const s of ctx.sockets) await kill(ctx.io, s);
        expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBeNull();
        await jest.advanceTimersByTimeAsync(10000);
        await ctx.starting;
        expect(gameManager.games.size).toBe(0);
        expect(events(ctx.log, 'tournamentGameAssignment')).toHaveLength(0);
    });

    test('a disconnect in the countdown is seated in grace and the round still starts', async () => {
        const ctx = await setupTournament(4);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(2000);
        const [g] = liveTables(ctx.t);
        await kill(ctx.io, ctx.sockets[2]);
        await advanceUntil(() => g.stage === Phase.BIDDING || g.stage === Phase.PLAYING, 100, 120000);
        await ctx.starting;
        const pos = g.seatByUsername(ctx.usernames[2]);
        expect(['grace', 'resignable']).toContain(g.seat(pos).presence);
        expect(ctx.t.getPlayerByUsername(ctx.usernames[2]).connected).toBe(false);
    });
});

describe('parallel table start', () => {
    test.each([6, 16])('%i players: every table opens its draw at the same instant', async (n) => {
        const ctx = await setupTournament(n);
        // A slow DB: every write takes 20ms
        const users = mockDb.current.users;
        const real = users.updateOne.bind(users);
        users.updateOne = async (f, u) => { await new Promise((r) => setTimeout(r, 20)); return real(f, u); };
        const tables = n === 6 ? 2 : 4; // 6 = 4+0, 2+2 bots; 16 = 4 x 4
        const t0 = Date.now();
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => events(ctx.log, 'startDraw').length === tables, 10, 30000);
        await ctx.starting;
        const draws = events(ctx.log, 'startDraw').map((l) => l.at - t0);
        expect(draws).toHaveLength(tables);
        const skew = Math.max(...draws) - Math.min(...draws);
        expect(skew).toBe(0);
        // 20ms tournament writes + 1.5s announce + 20ms game writes + 2s countdown
        expect(Math.max(...draws)).toBeLessThan(3700);
        // Assignments only after every table exists, all in one go
        const assigns = events(ctx.log, 'tournamentGameAssignment');
        expect(assigns).toHaveLength(n);
        expect(new Set(assigns.map((l) => l.at)).size).toBe(1);
    });
});


describe('full tournaments through the real handlers', () => {
    test('one human and bot fillers: 4 rounds, every game resolved once, final standings', async () => {
        const ctx = await setupTournament(1);
        const { resolved, allTables } = await playTournament(ctx);
        expect(allTables).toHaveLength(4);
        expect(new Set(resolved).size).toBe(4);
        expect(resolved).toHaveLength(4);
        expect(events(ctx.log, 'gameEnd')).toHaveLength(4);
        expect(events(ctx.log, 'abortGame')).toHaveLength(0);
        expect(events(ctx.log, 'tournamentGameComplete')).toHaveLength(4);
        expect(events(ctx.log, 'tournamentRoundComplete')).toHaveLength(3);
        const done = events(ctx.log, 'tournamentComplete');
        expect(done).toHaveLength(1);
        expect(done[0].data.winners).toEqual([ctx.usernames[0]]);
        const entry = ctx.t.scoreboard[ctx.usernames[0]];
        expect(entry.roundScores).toHaveLength(4);
        expect(entry.totalScore).toBe(entry.roundScores.reduce((a, b) => a + b, 0));
        expect(ctx.t.phase).toBe('complete');
        expect(gameManager.tournamentGames.size).toBe(0);
        expect(gameManager.games.size).toBe(0);
        expect(mockDb.current.users.docs.find((d) => d.username === ctx.usernames[0]).activeTournamentId).toBeUndefined();
        for (const g of allTables) {
            expect(g.stage).toBe(Phase.ENDED);
            expect(g.handStats.totalHands).toBe(13);
            expect(g.pendingTimerCount).toBe(0);
        }
        // The results window closes by itself
        await jest.advanceTimersByTimeAsync(11 * 60 * 1000);
        expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBeNull();
        expect(errorLogs).toEqual([]);
    }, 120000);

    test('five humans on two tables each round, all /lazy: scores for every member every round', async () => {
        const ctx = await setupTournament(5);
        const { resolved, allTables } = await playTournament(ctx);
        expect(allTables).toHaveLength(8);
        expect(new Set(resolved).size).toBe(8);
        expect(resolved).toHaveLength(8);
        expect(events(ctx.log, 'gameEnd')).toHaveLength(8);
        expect(events(ctx.log, 'tournamentGameComplete')).toHaveLength(8);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        for (const u of ctx.usernames) {
            const entry = ctx.t.scoreboard[u];
            expect(entry.roundScores).toHaveLength(4);
            expect(entry.roundDetails.map((d) => d.roundNumber)).toEqual([1, 2, 3, 4]);
        }
        // Each round's draws opened together
        const draws = events(ctx.log, 'startDraw');
        for (let i = 0; i < 8; i += 2) expect(draws[i].at).toBe(draws[i + 1].at);
        expect(gameManager.tournamentGames.size).toBe(0);
        expect(errorLogs).toEqual([]);
    }, 180000);

    test('a human disconnects mid-round, is resigned, rejoins and plays on', async () => {
        const ctx = await setupTournament(5);
        let victim = null;
        let back = null;
        const { resolved, allTables } = await playTournament(ctx, {
            async round(round, c, tables) {
                if (round !== 2) return;
                // A human at a table with another human
                const g = tables.find((x) => x.seatList().filter((s) => s.ownerUsername).length >= 2);
                const seat = g.seatList().find((s) => s.ownerUsername && s.controller === 'human');
                victim = seat.ownerUsername;
                const pos = seat.position;
                await kill(c.io, c.sockets.find((s) => s.id === seat.ownerSocketId));
                expect(c.t.getPlayerByUsername(victim).connected).toBe(false);
                await jest.advanceTimersByTimeAsync(61000);
                expect(g.seat(pos).presence).toBe('resignable');
                const mate = g.seatList().find((s) => s.ownerUsername && s.ownerUsername !== victim && s.ownerSocketId);
                await gameHandlers.forceResign(c.sockets.find((s) => s.id === mate.ownerSocketId), c.io, { position: pos });
                expect(g.seat(pos).controller).toBe('resignBot');
                // Back on a new socket: rejoin watches the resigned seat and
                // reattaches the tournament membership
                back = newUser(c.io, c.log, victim);
                c.sockets.push(back);
                await reconnectHandlers.rejoinGame(back, c.io, { gameId: g.gameId, username: victim });
                expect(gameManager.getPlayerTournament(back.id)).toBe(c.t);
                expect(c.t.getPlayerByUsername(victim).connected).toBe(true);
            },
        });
        expect(victim).not.toBeNull();
        expect(new Set(resolved).size).toBe(allTables.length);
        expect(resolved).toHaveLength(allTables.length);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        // The resigned owner is still scored for round 2 and plays rounds 3-4
        expect(ctx.t.scoreboard[victim].roundDetails.map((d) => d.roundNumber)).toEqual([1, 2, 3, 4]);
        expect(gameManager.tournamentGames.size).toBe(0);
        expect(errorLogs).toEqual([]);
    }, 180000);
});

describe('seeded tournament chaos: cancel / leave / disconnect at random times', () => {
    const { mulberry32 } = require('../../testUtils/gameDriver');
    const SEEDS = Math.max(4, Math.floor((Number(process.env.CHAOS_SEEDS) || 200) / 25));

    test(`${SEEDS} seeds end with no live game or tournament mapping left; a cancel leaves no member mapping or DB pointer`, async () => {
        const realRandom = Math.random;
        const stats = { cancelledTables: 0, cancelledInStart: 0 };
        try {
            for (let seed = 1; seed <= SEEDS; seed++) {
                const rand = mulberry32(seed * 7919);
                Math.random = rand;
                const ctx = await setupTournament(2 + Math.floor(rand() * 7));
                const tid = ctx.t.tournamentId;
                ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
                const cancelAt = Math.floor(rand() * 8000);
                for (let ms = 0; ms < 9000; ms += 100) {
                    if (rand() < 0.03) {
                        const s = ctx.sockets[Math.floor(rand() * ctx.sockets.length)];
                        if (s.connected) {
                            const what = rand();
                            if (what < 0.4) await kill(ctx.io, s);
                            else if (what < 0.7) await tournamentHandlers.leaveTournament(s, ctx.io);
                            else chatHandlers.chatMessage(s, ctx.io, { message: rand() < 0.5 ? '/lazy' : '/leave' });
                        }
                    }
                    if (ms === cancelAt - (cancelAt % 100) && gameManager.getTournamentById(tid)) {
                        const creator = ctx.sockets.find((s) => s.id === ctx.t.createdBy && s.connected);
                        if (creator) await tournamentHandlers.cancelTournament(creator, ctx.io);
                    }
                    await jest.advanceTimersByTimeAsync(100);
                }
                await ctx.starting;
                // Whatever survived, cancel it now (or it is gone already)
                if (gameManager.getTournamentById(tid)) {
                    const creator = ctx.sockets.find((s) => s.id === ctx.t.createdBy && s.connected);
                    if (creator) await tournamentHandlers.cancelTournament(creator, ctx.io);
                    else for (const g of liveTables(ctx.t)) await gameLifecycle.abortGame(ctx.io, g, 'test');
                }
                await jest.advanceTimersByTimeAsync(70000);
                const gone = !gameManager.getTournamentById(tid);
                const cancelAborts = ctx.log.filter((l) => l.event === 'abortGame' && l.data?.reason === 'Tournament cancelled');
                if (cancelAborts.length) {
                    stats.cancelledTables++;
                    if (!events(ctx.log, 'startDraw').length) stats.cancelledInStart++;
                }
                if (gone) {
                    const cancelIdx = ctx.log.findIndex((l) => l.event === 'tournamentCancelled');
                    if (cancelIdx >= 0) {
                        const late = ctx.log.slice(cancelIdx).filter((l) => START_EVENTS.includes(l.event) || RESULT_EVENTS.includes(l.event));
                        expect({ seed, late }).toEqual({ seed, late: [] });
                        // A cancel leaves no mapping or DB pointer behind
                        // for any member (abandonment deletes are not
                        // checked: a disconnected member's activeTournamentId
                        // is cleared at its next sign-in)
                        const mapped = ctx.sockets.filter((s) => gameManager.playerGames.has(s.id) ||
                            gameManager.spectatorGames.has(s.id) || gameManager.playerTournaments.has(s.id)).map((s) => s.id);
                        expect({ seed, mapped }).toEqual({ seed, mapped: [] });
                        const pointers = ctx.usernames.map((u) => mockDb.current.users.docs.find((d) => d.username === u))
                            .filter((d) => d.activeTournamentId !== undefined || d.activeGameId !== undefined)
                            .map((d) => ({ u: d.username, t: d.activeTournamentId, g: d.activeGameId }));
                        expect({ seed, pointers }).toEqual({ seed, pointers: [] });
                    }
                    expect({ seed, mapped: [...gameManager.tournamentGames.values()].filter((v) => v === tid) }).toEqual({ seed, mapped: [] });
                }
                const live = [...gameManager.games.values()].filter((g) => !g.isTerminal());
                expect({ seed, live: live.length }).toEqual({ seed, live: 0 });
                expect({ seed, violations: GamePhase.getViolations() }).toEqual({ seed, violations: [] });
                expect({ seed, errors: errorLogs }).toEqual({ seed, errors: [] });
                for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
                jest.clearAllTimers();
            }
            if (process.env.CHAOS_STATS) process.stdout.write(`tournament chaos ${JSON.stringify(stats)}\n`);
            // Coverage: cancels land on live tables, some inside the start
            expect(stats.cancelledTables).toBeGreaterThan(0);
            if (SEEDS >= 20) expect(stats.cancelledInStart).toBeGreaterThan(0);
        } finally {
            Math.random = realRandom;
        }
    }, 300000);
});
