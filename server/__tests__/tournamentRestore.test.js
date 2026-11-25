/**
 * Tournaments across a restart (deploy survival PR 6, LIVE_PERSIST=on; the
 * plan's PR 6 section), through deployKit: the real store, SIGTERM handoff,
 * crash release and adoption over createPersistHarness (one process at a
 * time; the successor adopts on the reset singletons).
 *
 *   phases: the lobby; every await window of startTournamentRound (the
 *     announce, the setActiveGame batch, the re-clears, the countdown) and
 *     the draw (pre-deal tables: the round rolls back); round_active
 *     mid-hand; a table finished while the other plays; a table ended
 *     during the handoff (its ENDED tombstone scored on the successor);
 *     between rounds; complete
 *   asserts: scoreboard, phase and round equal; reattach by username; the
 *     host grace; handleTournamentGameEnd once per game;
 *     tournamentRoundComplete once per round; the winners the old process
 *     would announce; the 10-minute abandon (and the tables' 5); chat
 *     survives (players' and spectators', the 100 cap, no system line)
 *   plus: lobby pointers, the handoff itself (no tournamentPlayerLeft or
 *     delete at io.close, a start in flight aborts no frozen table,
 *     joinTournament during the flush clears nothing, a failed final write
 *     releases the saved doc as it is with no "continue" line, a refused
 *     serialize takes its tables with it ("ended"), a crash releases
 *     liveTournaments), a member deleted or merged across the restore, a
 *     cancel after the restore
 *   an adoption cut short: a Mongo error on a table's claim, SIGTERM during
 *     the claim (nothing scored or rolled back; the next instance adopts);
 *     a tournament completed after the restore is never cancelled by the
 *     restored abandon
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
const mockDb = { current: null };
jest.mock('../database', () => require('../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../testUtils/persistHarness');
const { createDeploy } = require('../testUtils/deployKit');
const { makeSocket, mulberry32 } = require('../testUtils/gameDriver');
const { setupTournament, liveTables, advanceUntil } = require('../testUtils/tournamentDriver');
const gameManager = require('../game/GameManager');
const { botController } = require('../game/bot');
const { Phase } = require('../game/GamePhase');
const liveStore = require('../game/persist/liveStore');
const restoreTournament = require('../game/persist/restoreTournament');
const { RESTORE_ABANDON_TOURNAMENT_MS } = require('../game/persist/restoreGame');
const shutdown = require('../utils/shutdown');
const profileHandlers = require('../socket/profileHandlers');
const tournamentHandlers = require('../socket/tournamentHandlers');
const reconnectHandlers = require('../socket/reconnectHandlers');
const chatHandlers = require('../socket/chatHandlers');
const authHandlers = require('../socket/authHandlers');
const loggers = require('../utils/logger');
const { issueSession } = require('../utils/sessionTokens');

const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];
const LOGGERS = ['gameLogger', 'socketLogger', 'authLogger', 'logger', 'dbLogger'];
let realRandom;
let listenersBefore;
let deploy;
let ended;
let n = 0;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(67);
    listenersBefore = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const name of LOGGERS) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(loggers[name], m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ended = [];
    const real = gameManager.handleTournamentGameEnd;
    jest.spyOn(gameManager, 'handleTournamentGameEnd').mockImplementation(function (gameId) {
        const r = real.call(this, gameId);
        if (r) ended.push(gameId);
        return r;
    });
    deploy = null;
});

afterEach(() => {
    deploy?.close();
    for (const s of SIGNALS) {
        for (const fn of process.listeners(s)) if (!listenersBefore[s].includes(fn)) process.removeListener(s, fn);
    }
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    shutdown._resetShutdownStateForTests({ abandonRetries: true });
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    gameManager._resetForTests();
    botController._resetForTests();
    tournamentHandlers._resetCleanupTimersForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const ZERO_PACING = require('../game/pacing')().ROUND_ANNOUNCE_MS === 0;
const T = (tid) => gameManager.getTournamentById(tid);
const user = (u) => db().users.docs.find((d) => d.username === u) || null;
const events = (inst, event) => inst.log.filter((e) => e.event === event);
const shape = (t) => ({ phase: t.phase, currentRound: t.currentRound, totalRounds: t.totalRounds, scoreboard: t.getScoreboard(), name: t.name, creator: t.creatorUsername });
const members = (t) => Array.from(t.players.values(), (p) => p.username).sort();

/** Boot A with an n-human tournament (all ready), saved. */
async function bootTournament(count = 5, { totalRounds = null } = {}) {
    deploy = createDeploy({ holder: mockDb, db: db() });
    const A = await deploy.boot();
    const ctx = await setupTournament(count, { io: A.io, log: A.log });
    if (totalRounds) ctx.t.totalRounds = totalRounds;
    await h.flushStore(A.store);
    return { A, ctx, tid: ctx.t.tournamentId };
}

/** Begin round 1 (or the next) on A and run until its tables are dealt. */
async function beginRound(ctx, io, { next = false } = {}) {
    const host = ctx.sockets.find((s) => s.id === ctx.t.createdBy);
    ctx.starting = next ? tournamentHandlers.beginNextRound(host, io) : tournamentHandlers.beginTournament(host, io);
    await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null && g.stage === Phase.BIDDING), 100, 120000);
    await ctx.starting;
    return liveTables(ctx.t);
}

/** A member's new socket on `inst`. */
function back(inst, username) {
    n++;
    const s = makeSocket(`${username}-r${n}`, inst.log, inst.io);
    gameManager.registerUser(s.id, username);
    return s;
}

/** Every human seat of the live tables goes /lazy every 5 s until the round is over. */
async function playOut(t, io, socketsOf, { cap = 800 } = {}) {
    for (let step = 0; step < cap && t.phase === 'round_active'; step++) {
        for (const g of liveTables(t)) {
            for (const seat of g.seatList()) {
                if (seat.controller !== 'human' || seat.presence !== 'connected') continue;
                const s = socketsOf(seat.ownerSocketId);
                if (s) chatHandlers.chatMessage(s, io, { message: '/lazy' });
            }
        }
        await jest.advanceTimersByTimeAsync(5000);
    }
}

/** Every member of `tid` back on `inst` at their table (rejoinGame) or the lobby (joinTournament). */
async function everyoneBack(inst, tid, usernames) {
    const sockets = new Map();
    for (const u of usernames) {
        const s = back(inst, u);
        sockets.set(s.id, s);
        const gameId = user(u)?.activeGameId;
        if (gameId && gameManager.games.get(gameId)) await reconnectHandlers.rejoinGame(s, inst.io, { gameId, username: u });
        else await tournamentHandlers.joinTournament(s, inst.io, { tournamentId: tid });
    }
    return sockets;
}

describe('the lobby', () => {
    test('survives a handoff: members, chat (players and spectators), lobby pointers; ghosts reattach by username; the ones not back are dropped at begin', async () => {
        const { A, ctx, tid } = await bootTournament(4);
        tournamentHandlers.tournamentChat(ctx.sockets[1], A.io, { message: 'gl all' });
        db().users._insert({ username: 'Fan', profilePic: 4 });
        const fan = back(A, 'Fan');
        tournamentHandlers.spectateTournament(fan, A.io, { tournamentId: tid });
        tournamentHandlers.tournamentChat(fan, A.io, { message: 'go go' });
        const before = shape(ctx.t);
        const msgs = ctx.t.messages.map((m) => ({ ...m }));
        expect(msgs.map((m) => m.message)).toEqual(['gl all', 'go go']);
        await h.flushStore(A.store);
        const B = await deploy.restart({ kind: 'handoff' });
        // The old process: the continue line to the tournament room, no tournamentPlayerLeft at io.close
        const room = `tournament:${tid}`;
        expect(events(A, 'tournamentMessage').filter((e) => e.to === room && e.data.system).map((e) => e.data.message))
            .toContain(shutdown.TOURNAMENT_CONTINUE_LINE);
        expect([...A.log, ...A.afterDeath].filter((e) => e.event === 'tournamentPlayerLeft')).toEqual([]);
        const t = T(tid);
        expect(t).toBeTruthy();
        expect(shape(t)).toEqual(before);
        expect(members(t)).toEqual([...ctx.usernames].sort());
        // Chat: both lines, the spectator flag kept, no system line stored
        expect(t.messages).toEqual(msgs);
        expect(t.messages.some((m) => m.system || m.username === 'System')).toBe(false);
        // Every member a ghost, and its pointer written by the flush
        expect([...t.players.values()].every((p) => p.connected === false)).toBe(true);
        for (const u of ctx.usernames) expect(user(u).activeTournamentId).toBe(tid);
        // The synthetic ids are never on the wire
        expect(JSON.stringify(t.getClientState())).not.toContain('restored:');
        // Three come back (the host first), one never does
        const [host, ...rest] = ctx.usernames;
        const hs = back(B, host);
        await tournamentHandlers.joinTournament(hs, B.io, { tournamentId: tid });
        expect(t.createdBy).toBe(hs.id);
        const others = [];
        for (const u of rest.slice(0, 2)) {
            const s = back(B, u);
            await tournamentHandlers.joinTournament(s, B.io, { tournamentId: tid });
            others.push(s);
        }
        expect(t.getConnectedPlayerCount()).toBe(3);
        for (const s of [hs, ...others]) tournamentHandlers.tournamentReady(s, B.io);
        const missing = rest[2];
        tournamentHandlers.beginTournament(hs, B.io);
        await jest.advanceTimersByTimeAsync(0);
        expect(events(B, 'tournamentPlayerLeft').map((e) => e.data.username)).toEqual([missing]);
        expect(members(t)).toEqual([host, ...rest.slice(0, 2)].sort());
        await advanceUntil(() => user(missing).activeTournamentId === undefined, 100, 5000);
        await advanceUntil(() => liveTables(t).length > 0 && liveTables(t).every((g) => g.stage === Phase.BIDDING), 100, 120000);
        expect(t.phase).toBe('round_active');
        expect(t.currentRound).toBe(1);
    });

    test('a restored lobby member who disconnects (a lobby leave) has the pointer cleared; a non-member pointer is cleared at restoreSession; no raw "not accepting players"', async () => {
        const { ctx, tid } = await bootTournament(3);
        const B = await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        const [u1, u2] = ctx.usernames;
        const s1 = back(B, u1);
        await tournamentHandlers.joinTournament(s1, B.io, { tournamentId: tid });
        expect(t.getPlayerByUsername(u1).connected).toBe(true);
        // The lobby leave of a restored member
        B.io.sockets.sockets.delete(s1.id);
        gameManager.handleDisconnect(s1.id);
        expect(t.getPlayerByUsername(u1)).toBeNull();
        await advanceUntil(() => user(u1).activeTournamentId === undefined, 10, 5000);
        // A non-member with a pointer to it: answered as none and cleared at restoreSession
        db().users._insert({ username: 'Stray', profilePic: 2 });
        const stray = user('Stray');
        const session = issueSession(stray);
        Object.assign(stray, session.update.$set, { activeTournamentId: tid });
        const rs = makeSocket('stray-rs', B.log, B.io);
        await authHandlers.restoreSession(rs, B.io, { username: 'Stray', sessionToken: session.token });
        const reply = B.log.filter((e) => e.to === `self:${rs.id}` && e.event === 'restoreSessionResponse').map((e) => e.data);
        expect(reply).toEqual([expect.objectContaining({ success: true })]);
        expect(reply[0].activeTournamentId).toBeUndefined();
        expect(user('Stray').activeTournamentId).toBeUndefined();
        // A member back later reattaches (never the raw refusal)
        const s2 = back(B, u2);
        await tournamentHandlers.joinTournament(s2, B.io, { tournamentId: tid });
        expect(t.getPlayerByUsername(u2).connected).toBe(true);
        expect(events(B, 'serverError').map((e) => e.data.message)).not.toContain('Tournament is not accepting players');
    });
});

describe('a round start in flight at SIGTERM: the round rolls back, no frozen table aborted', () => {
    async function restartIn(window) {
        const { A, ctx, tid } = await bootTournament(5);
        const host = ctx.sockets[0];
        ctx.starting = tournamentHandlers.beginTournament(host, A.io);
        await jest.advanceTimersByTimeAsync(100);
        let release = null;
        if (window === 'announce') {
            expect(ctx.t.getCurrentRound().games.size).toBe(0);
        } else if (window === 'setActiveGame' || window === 'reclears') {
            release = db().faults.stall({ collections: 'users', ops: 'updateOne', instances: A.name });
            await jest.advanceTimersByTimeAsync(1500);
            expect(liveTables(ctx.t).length).toBe(2);
            if (window === 'reclears') {
                // An entrant leaves during the writes: its table's re-clear is
                // the next await (stalled too once the writes are released)
                const leaver = ctx.sockets[4];
                tournamentHandlers.leaveTournament(leaver, A.io);
                await jest.advanceTimersByTimeAsync(0);
                release();
                release = db().faults.stall({ collections: 'users', ops: 'updateOne', instances: A.name });
                await jest.advanceTimersByTimeAsync(0);
            }
        } else if (window === 'countdown') {
            await jest.advanceTimersByTimeAsync(1500);
            expect(events(A, 'allPlayersReady').length).toBeGreaterThan(0);
        } else if (window === 'draw') {
            await jest.advanceTimersByTimeAsync(1500 + 2000 + 50);
            expect(liveTables(ctx.t).every((g) => g.isPreSeating?.() || g.stage === Phase.DRAWING || g.entrants)).toBe(true);
        }
        const tables = liveTables(ctx.t).map((g) => g.gameId);
        await h.flushStore(A.store);
        const B = await deploy.restart({ kind: 'handoff', abandonStalled: true });
        release?.();
        await jest.advanceTimersByTimeAsync(0);
        // A aborted none of its frozen tables
        expect([...A.log, ...A.afterDeath].filter((e) => e.event === 'abortGame')).toEqual([]);
        const t = T(tid);
        expect(t).toBeTruthy();
        expect(t.phase).toBe('lobby');
        expect(t.currentRound).toBe(0);
        expect(t.rounds).toEqual([]);
        // the rolled-back round's planned pairings are gone with it
        expect(t.pairings()).toEqual([]);
        expect(t.pairingsWire()).toBeNull();
        // No table of the rolled-back round anywhere, no pointer to one
        for (const id of tables) {
            expect(gameManager.games.has(id)).toBe(false);
            expect(db().liveGames.docs.find((d) => d._id === id)).toBeUndefined();
        }
        await jest.advanceTimersByTimeAsync(100);
        for (const u of ctx.usernames) expect(tables).not.toContain(user(u).activeGameId);
        // And it starts again on B
        const sockets = await everyoneBack(B, tid, ctx.usernames.slice(0, 4));
        for (const s of sockets.values()) tournamentHandlers.tournamentReady(s, B.io);
        const hs = [...sockets.values()].find((s) => s.id === t.createdBy);
        tournamentHandlers.beginTournament(hs, B.io);
        await advanceUntil(() => liveTables(t).length > 0 && liveTables(t).every((g) => g.stage === Phase.BIDDING), 100, 120000);
        expect(t.currentRound).toBe(1);
        return { A, B, t };
    }

    // BAB_PACING=zero (test:race) has no announce wait to stop in
    const windows = ['announce', 'setActiveGame', 'reclears', 'countdown', 'draw']
        .filter((w) => w !== 'announce' || !ZERO_PACING);
    test.each(windows)('%s', async (window) => {
        await restartIn(window);
    });
});

describe('round_active', () => {
    test('mid-hand: tables adopted (5-minute abandon), members reattach at their tables; the round plays out on B once', async () => {
        const { A, ctx, tid } = await bootTournament(5);
        const tables = await beginRound(ctx, A.io);
        expect(tables).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(3000);
        const before = shape(ctx.t);
        await h.flushStore(A.store);
        const B = await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        expect(shape(t)).toEqual(before);
        for (const g of tables) {
            const restored = gameManager.games.get(g.gameId);
            expect(restored).toBeTruthy();
            expect(gameManager.tournamentGames.get(g.gameId)).toBe(tid);
            expect(restored.restored.abandonMs).toBe(RESTORE_ABANDON_TOURNAMENT_MS);
        }
        const sockets = await everyoneBack(B, tid, ctx.usernames);
        expect(t.getConnectedPlayerCount()).toBe(5);
        await playOut(t, B.io, (sid) => sockets.get(sid));
        expect(t.phase).toBe('between_rounds');
        expect([...ended].sort()).toEqual(tables.map((g) => g.gameId).sort());
        expect(events(B, 'tournamentRoundComplete')).toHaveLength(1);
        expect(events(A, 'tournamentRoundComplete')).toHaveLength(0);
        for (const g of tables) expect(db().gameRecords.docs.filter((r) => r.gameId === g.gameId)).toHaveLength(1);
    }, 120000);

    // BAB_PACING=zero (test:race): both tables finish in the same step
    (ZERO_PACING ? test.skip : test)('one table finished, the other mid-hand: the finished one stays scored once, the other plays on', async () => {
        const { A, ctx, tid } = await bootTournament(5);
        const tables = await beginRound(ctx, A.io);
        await playOutUntil(ctx, A, () => ctx.t.getCurrentRound().completedGames.size === 1, { step: 200 });
        const done = [...ctx.t.getCurrentRound().completedGames];
        const before = shape(ctx.t);
        await h.flushStore(A.store);
        const B = await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        expect(shape(t)).toEqual(before);
        expect(gameManager.games.has(done[0])).toBe(false);
        const sockets = await everyoneBack(B, tid, ctx.usernames);
        await playOut(t, B.io, (sid) => sockets.get(sid));
        expect(t.phase).toBe('between_rounds');
        expect(ended.filter((id) => id === done[0])).toHaveLength(1);
        expect([...ended].sort()).toEqual(tables.map((g) => g.gameId).sort());
        expect(events(B, 'tournamentRoundComplete')).toHaveLength(1);
    }, 120000);

    test('a table ended during the handoff (SIGTERM in the clearActiveGameForAll await): its tombstone is scored on B within one sweep; one gameRecords doc', async () => {
        const { A, ctx, tid } = await bootTournament(5);
        const tables = await beginRound(ctx, A.io);
        // From now on A's users writes hang: a gameEnd waits in clearActiveGameForAll
        db().faults.stall({ collections: 'users', ops: 'updateOne', instances: A.name });
        const endedHere = () => tables.find((g) => g.stage === Phase.ENDED);
        await playOutUntil(ctx, A, () => !!endedHere() && db().liveGames.docs.some((d) => d._id === endedHere().gameId && d.kind === 'ended'), { step: 500 });
        const gone = endedHere().gameId;
        expect(ctx.t.getCurrentRound().completedGames.has(gone)).toBe(false);
        await h.flushStore(A.store);
        const B = await deploy.restart({ kind: 'handoff', abandonStalled: true });
        const t = T(tid);
        expect(t.getCurrentRound().completedGames.has(gone)).toBe(true);
        expect(db().liveGames.docs.find((d) => d._id === gone)).toBeUndefined();
        expect(db().gameRecords.docs.filter((r) => r.gameId === gone)).toHaveLength(1);
        // Its players scored their final scores (not an abort)
        const scored = Object.values(t.scoreboard).flatMap((e) => e.roundDetails).filter((d) => d.gameId === gone);
        expect(scored.length).toBeGreaterThan(0);
        expect(scored.every((d) => !d.aborted)).toBe(true);
        // The other table plays on and the round completes once
        const sockets = await everyoneBack(B, tid, ctx.usernames);
        await playOut(t, B.io, (sid) => sockets.get(sid));
        expect(t.phase).toBe('between_rounds');
        expect(events(B, 'tournamentRoundComplete')).toHaveLength(1);
        void B;
    }, 120000);

    test('a table whose final write failed (its doc deleted, no tombstone): scored on B from the tournament doc\'s tableScores as an abort; the other plays on, the round completes once', async () => {
        const { A, ctx, tid } = await bootTournament(5);
        const tables = await beginRound(ctx, A.io);
        expect(tables).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(3000);
        await h.flushStore(A.store);
        // The first final write (a table's replaceOne) fails: that doc is deleted at the handoff
        db().faults.fail({ collections: 'liveGames', ops: 'replaceOne', instances: A.name, times: 1 });
        const B = await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        const lost = tables.filter((g) => !gameManager.games.has(g.gameId)).map((g) => g.gameId);
        const kept = tables.filter((g) => gameManager.games.has(g.gameId)).map((g) => g.gameId);
        expect(lost).toHaveLength(1);
        expect(kept).toHaveLength(1);
        expect(db().liveGames.docs.find((d) => d._id === lost[0])).toBeUndefined();
        expect(t.phase).toBe('round_active');
        expect(t.getCurrentRound().completedGames.has(lost[0])).toBe(true);
        const rows = Object.values(t.scoreboard).flatMap((e) => e.roundDetails).filter((d) => d.gameId === lost[0]);
        // One row per human seated there (a bot seat scores nobody)
        expect(rows.length).toBe(t.getCurrentRound().games.get(lost[0]).humanPlayers.length);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((d) => d.aborted === true)).toBe(true);
        // Seated rows (position, partner): the saved tableScores, not the pre-deal fallback
        expect(rows.every((d) => Number.isInteger(d.position) && typeof d.partner === 'string')).toBe(true);
        expect(ended).not.toContain(lost[0]);
        const sockets = await everyoneBack(B, tid, ctx.usernames);
        await playOut(t, B.io, (sid) => sockets.get(sid));
        expect(t.phase).toBe('between_rounds');
        expect(ended).toEqual(kept);
        expect(events(B, 'tournamentRoundComplete')).toHaveLength(1);
        expect(db().gameRecords.docs.filter((r) => r.gameId === lost[0])).toHaveLength(0);
    }, 120000);

    test('nobody returns: the tables abort at 5 minutes (running scores), the tournament is torn down at 10 (pointers cleared, doc gone)', async () => {
        const { A, ctx, tid } = await bootTournament(4);
        const [table] = await beginRound(ctx, A.io);
        for (const u of ctx.usernames) expect(user(u).activeTournamentId).toBe(tid);
        await h.flushStore(A.store);
        const B = await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        expect(gameManager.games.has(table.gameId)).toBe(true);
        await jest.advanceTimersByTimeAsync(RESTORE_ABANDON_TOURNAMENT_MS - 1000);
        expect(gameManager.games.has(table.gameId)).toBe(true);
        await jest.advanceTimersByTimeAsync(2000);
        expect(gameManager.games.has(table.gameId)).toBe(false);
        // Scored as an abort, the round complete, the tournament still held
        expect(T(tid)).toBe(t);
        expect(t.phase).toBe('between_rounds');
        expect(Object.values(t.scoreboard).every((e) => e.roundDetails[0]?.aborted === true)).toBe(true);
        await jest.advanceTimersByTimeAsync(restoreTournament.RESTORE_ABANDON_MS - RESTORE_ABANDON_TOURNAMENT_MS - 3000);
        expect(T(tid)).toBe(t);
        await jest.advanceTimersByTimeAsync(3000);
        expect(T(tid)).toBeNull();
        await h.flushStore(B.store);
        expect(db().liveTournaments.docs.find((d) => d._id === tid)).toBeUndefined();
        for (const u of ctx.usernames) expect(user(u).activeTournamentId).toBeUndefined();
        expect(db().gameRecords.docs.filter((r) => r.gameId === table.gameId)).toHaveLength(0);
    }, 120000);
});

describe('an adoption cut short', () => {
    /** bootTournament with deployKit hooks (beforeSweep, beforeHandoff). */
    async function bootWithHooks(count, hooks) {
        deploy = createDeploy({ holder: mockDb, db: db(), hooks });
        const A = await deploy.boot();
        const ctx = await setupTournament(count, { io: A.io, log: A.log });
        await h.flushStore(A.store);
        return { A, ctx, tid: ctx.t.tournamentId };
    }

    test('a Mongo error on one table\'s claim leaves it adoptable: never scored as an abort, adopted by the same sweep', async () => {
        const { A, ctx, tid } = await bootWithHooks(8, {
            beforeSweep: (inst) => {
                if (inst.name === 'i2') db().faults.fail({ collections: 'liveGames', ops: 'findOne', instances: 'i2', times: 1 });
            }
        });
        const tables = await beginRound(ctx, A.io);
        expect(tables).toHaveLength(2);
        await h.flushStore(A.store);
        await deploy.restart({ kind: 'handoff' });
        expect(db().faults.calls.filter((c) => c.instance === 'i2' && c.outcome === 'failed')).toHaveLength(1);
        const t = T(tid);
        expect(t.phase).toBe('round_active');
        for (const g of tables) expect(gameManager.games.has(g.gameId)).toBe(true);
        expect(t.getCurrentRound().completedGames.size).toBe(0);
        expect(Object.values(t.scoreboard).some((e) => e.roundDetails.some((d) => d?.aborted))).toBe(false);
        expect(ended).toEqual([]);
    }, 120000);

    test('SIGTERM while a table is being claimed: no rollback, nothing scored; the next instance adopts the tournament and the table', async () => {
        const { A, ctx, tid } = await bootWithHooks(4, {
            beforeSweep: (inst) => {
                if (inst.name === 'i2') db().faults.stall({ collections: 'liveGames', ops: 'findOne', instances: 'i2' });
            },
            // Inside B's settle: the claim's read goes on, now stopping
            beforeHandoff: (old) => {
                if (old.name === 'i2') setTimeout(() => db().faults.release(), 200);
            }
        });
        const [table] = await beginRound(ctx, A.io);
        await h.flushStore(A.store);
        const toB = deploy.restart({ kind: 'handoff' });
        await advanceUntil(() => db().faults.stalledCount() > 0, 10, 20000);
        const B = deploy.current();
        expect(B.name).toBe('i2');
        expect(T(tid)).toBeTruthy();
        const C = await deploy.restart({ kind: 'handoff' });
        await toB;
        expect(C.name).toBe('i3');
        expect(events(B, 'tournamentRoundComplete')).toEqual([]);
        const t = T(tid);
        expect(t).toBeTruthy();
        expect(t.phase).toBe('round_active');
        expect(gameManager.games.has(table.gameId)).toBe(true);
        expect(t.getCurrentRound().completedGames.size).toBe(0);
        for (const u of table.seatList().map((s) => s.username).filter(Boolean)) {
            if (ctx.usernames.includes(u)) expect(user(u).activeGameId).toBe(table.gameId);
        }
        expect(ended).toEqual([]);
        expect(deploy.harness.deadEmits()).toEqual([]);
    }, 120000);

    test('a tournament completed after the restore is never cancelled by the restored abandon; the results window ends it', async () => {
        const { A, ctx, tid } = await bootTournament(4, { totalRounds: 1 });
        const [table] = await beginRound(ctx, A.io);
        await h.flushStore(A.store);
        const B = await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        expect(gameManager.games.has(table.gameId)).toBe(true);
        // Nobody back: the table aborts at 5 minutes, the last round and the tournament complete
        await jest.advanceTimersByTimeAsync(RESTORE_ABANDON_TOURNAMENT_MS + 1000);
        expect(gameManager.games.has(table.gameId)).toBe(false);
        expect(T(tid)).toBe(t);
        expect(t.phase).toBe('complete');
        expect(events(B, 'tournamentComplete')).toHaveLength(1);
        // The restored window ends: no cancel for a finished tournament
        await jest.advanceTimersByTimeAsync(restoreTournament.RESTORE_ABANDON_MS - RESTORE_ABANDON_TOURNAMENT_MS + 1000);
        expect(events(B, 'tournamentCancelled')).toEqual([]);
        expect(T(tid)).toBe(t);
        // ... the results window (completedAt + 10 min) does
        await jest.advanceTimersByTimeAsync(t.completedAt + 10 * 60000 - Date.now() + 1000);
        expect(T(tid)).toBeNull();
        expect(events(B, 'tournamentCancelled')).toEqual([]);
    }, 120000);
});

/** Lazy humans on A until `pred` (5 s steps by default). */
async function playOutUntil(ctx, A, pred, { step = 5000, cap = 2000 } = {}) {
    for (let i = 0; i < cap && !pred(); i++) {
        for (const g of liveTables(ctx.t)) {
            for (const seat of g.seatList()) {
                if (seat.controller !== 'human' || seat.presence !== 'connected') continue;
                const s = ctx.sockets.find((x) => x.id === seat.ownerSocketId);
                if (s) chatHandlers.chatMessage(s, A.io, { message: '/lazy' });
            }
        }
        await jest.advanceTimersByTimeAsync(step);
    }
    if (!pred()) throw new Error('playOutUntil: never');
}

describe('between rounds', () => {
    async function betweenRounds(count = 4) {
        const { A, ctx, tid } = await bootTournament(count);
        await beginRound(ctx, A.io);
        await playOutUntil(ctx, A, () => ctx.t.phase === 'between_rounds');
        await h.flushStore(A.store);
        return { A, ctx, tid };
    }

    test('scoreboard, phase and round equal; a fresh ready deadline; the host grace keeps a ghost host 60 s, then hands on (tournamentPlayerLeft {newCreator}); round 2 starts on B', async () => {
        const { ctx, tid } = await betweenRounds(4);
        const before = shape(ctx.t);
        const pairingsBefore = ctx.t.pairingsWire();
        expect(pairingsBefore).toHaveLength(1);
        const B = await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        expect(shape(t)).toEqual(before);
        // the round pairings (shown openly, owner 2026-11-25) survive with the saved teams
        expect(t.pairingsWire()).toEqual(pairingsBefore);
        expect(t.getClientState().pairings).toEqual(pairingsBefore);
        expect(t.readyDeadlineAt).toBeGreaterThanOrEqual(Date.now() + 60000);
        expect(t.hasTimer('readyDeadline')).toBe(true);
        const [host, ...rest] = ctx.usernames;
        expect(t.creatorUsername).toBe(host);
        const sockets = [];
        for (const u of rest) {
            const s = back(B, u);
            await tournamentHandlers.joinTournament(s, B.io, { tournamentId: tid });
            sockets.push(s);
        }
        // The ghost host keeps the role through its grace
        expect(t.creatorUsername).toBe(host);
        await jest.advanceTimersByTimeAsync(restoreTournament.HOST_GRACE_MS - 1000);
        expect(t.creatorUsername).toBe(host);
        await jest.advanceTimersByTimeAsync(2000);
        expect(t.creatorUsername).not.toBe(host);
        const left = events(B, 'tournamentPlayerLeft');
        expect(left.map((e) => [e.data.username, e.data.newCreator])).toEqual([[host, t.creatorUsername]]);
        for (const s of sockets) tournamentHandlers.tournamentReady(s, B.io);
        const newHost = sockets.find((s) => s.id === t.createdBy);
        tournamentHandlers.beginNextRound(newHost, B.io);
        await advanceUntil(() => liveTables(t).length > 0 && liveTables(t).every((g) => g.stage === Phase.BIDDING), 100, 120000);
        expect(t.currentRound).toBe(2);
        expect(events(B, 'tournamentRoundComplete')).toHaveLength(0);
    }, 120000);

    test('nobody returns: torn down at 10 minutes, not before', async () => {
        const { ctx, tid } = await betweenRounds(4);
        const B = await deploy.restart({ kind: 'handoff' });
        await jest.advanceTimersByTimeAsync(restoreTournament.RESTORE_ABANDON_MS - 1000);
        expect(T(tid)).toBeTruthy();
        await jest.advanceTimersByTimeAsync(2000);
        expect(T(tid)).toBeNull();
        await h.flushStore(B.store);
        expect(db().liveTournaments.docs).toEqual([]);
        for (const u of ctx.usernames) expect(user(u).activeTournamentId).toBeUndefined();
    }, 120000);

    test('a member deleted and one merged across the restore: removed, their rows kept, never a winner; the deleted one\'s chat lines dropped', async () => {
        const { A, ctx, tid } = await betweenRounds(4);
        const [, gone, merged] = ctx.usernames;
        tournamentHandlers.tournamentChat(ctx.sockets.find((s) => gameManager.getUserBySocketId(s.id)?.username === gone), A.io, { message: 'from the deleted one' });
        tournamentHandlers.tournamentChat(ctx.sockets.find((s) => gameManager.getUserBySocketId(s.id)?.username === merged), A.io, { message: 'from the merged one' });
        await h.flushStore(A.store);
        const before = shape(ctx.t).scoreboard;
        db().users.docs.find((d) => d.username === gone).mergedInto = '[deleted]';
        db().users.docs.find((d) => d.username === merged).mergedInto = 'someoneElse';
        await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        expect(members(t)).not.toContain(gone);
        expect(members(t)).not.toContain(merged);
        expect(t.getScoreboard()).toEqual(before);
        // A deleted sender's lines go; a merged account's stay (as restoreGame's scrub)
        expect(t.messages.map((m) => m.message)).not.toContain('from the deleted one');
        expect(t.messages.map((m) => m.message)).toContain('from the merged one');
        // Give them the best score: still never a winner
        t.scoreboard[gone].totalScore = 10000;
        expect(t.getWinners()).not.toContain(gone);
    }, 120000);

    test('a cancel after the restore clears everything', async () => {
        const { ctx, tid } = await betweenRounds(4);
        const B = await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        const hs = back(B, ctx.usernames[0]);
        await tournamentHandlers.joinTournament(hs, B.io, { tournamentId: tid });
        expect(t.createdBy).toBe(hs.id);
        await tournamentHandlers.cancelTournament(hs, B.io);
        expect(T(tid)).toBeNull();
        await h.flushStore(B.store);
        expect(db().liveTournaments.docs).toEqual([]);
        for (const u of ctx.usernames) expect(user(u).activeTournamentId).toBeUndefined();
        expect(events(B, 'tournamentCancelled')).toHaveLength(1);
    }, 120000);
});

describe('complete', () => {
    test('the results window survives: the same winners; cleaned up at max(completedAt + 10 min - now, 30 s)', async () => {
        const { A, ctx, tid } = await bootTournament(4, { totalRounds: 1 });
        await beginRound(ctx, A.io);
        await playOutUntil(ctx, A, () => ctx.t.phase === 'complete');
        const winners = ctx.t.getWinners();
        const announced = events(A, 'tournamentComplete').map((e) => e.data.winners);
        expect(announced).toEqual([winners]);
        await jest.advanceTimersByTimeAsync(9 * 60000);
        await h.flushStore(A.store);
        await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        expect(t.phase).toBe('complete');
        expect(t.getWinners()).toEqual(winners);
        expect(t.getClientState().winners).toEqual(winners);
        // About a minute of the window was left: at least 30 s, then gone
        await jest.advanceTimersByTimeAsync(29000);
        expect(T(tid)).toBe(t);
        await jest.advanceTimersByTimeAsync(40000);
        expect(T(tid)).toBeNull();
        expect(ended).toHaveLength(1);
    }, 120000);
});

describe('chat', () => {
    test('100 lines kept (players and spectators), the oldest dropped; no system line saved', async () => {
        const { A, ctx, tid } = await bootTournament(4);
        db().users._insert({ username: 'Fan', profilePic: 4 });
        const fan = back(A, 'Fan');
        tournamentHandlers.spectateTournament(fan, A.io, { tournamentId: tid });
        for (let i = 0; i < 110; i++) {
            tournamentHandlers.tournamentChat(i % 2 ? fan : ctx.sockets[i % 4], A.io, { message: `line ${i}` });
        }
        const msgs = ctx.t.messages.map((m) => ({ ...m }));
        expect(msgs).toHaveLength(100);
        await h.flushStore(A.store);
        await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        expect(t.messages).toEqual(msgs);
        expect(t.messages[0].message).toBe('line 10');
        expect(t.messages.filter((m) => m.isSpectator)).toHaveLength(50);
        expect(t.messages.some((m) => m.system)).toBe(false);
    });
});

describe('Cut for a buck (codec v2)', () => {
    const cutForABuck = require('../socket/cutForABuck');
    const { giveCap, deckOf } = require('../testUtils/cutDriver');

    afterEach(() => cutForABuck.setEngineOptionsForTests({}));

    /** A 3-member, 1-round tournament with the cap, played on A into its cut, at `stage`. */
    async function intoCut(stage) {
        const { A, ctx, tid } = await bootTournament(3, { totalRounds: 1 });
        ctx.sockets.forEach((s) => giveCap(s));
        // redraws first (three 7s), so every stage is reachable with 3 alive
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('7s', '7h', '7d', '2s', '9h', 'Kd', '3c', 'Qc'), randomInt: () => 0 });
        await beginRound(ctx, A.io);
        await playOutUntil(ctx, A, () => ctx.t.phase !== 'round_active');
        expect(ctx.t.phase).toBe('cut');
        const drawAt = (slots) => {
            const e = ctx.t.cut.engine;
            e.aliveList().forEach((u, i) => {
                const s = ctx.sockets[ctx.usernames.indexOf(u)];
                if (slots === 'one' && i > 0) return;
                cutForABuck.draw(s, A.io, { round: e.round, slot: i });
            });
        };
        const until = async (pred) => {
            for (let i = 0; i < 400 && !pred(); i++) await jest.advanceTimersByTimeAsync(100);
            expect(pred()).toBe(true);
        };
        if (stage !== 'gather') {
            await until(() => ctx.t.cut.stage === 'drawing');
            if (stage === 'drawing') drawAt('one');
            if (stage === 'reveal' || stage === 'winner') drawAt('all'); // round 1: the 7s tie
            if (stage === 'winner') {
                await until(() => ctx.t.cut.stage === 'drawing');
                drawAt('all'); // 2s, 9h, Kd: the 2 out
                await until(() => ctx.t.cut.stage === 'drawing');
                drawAt('all'); // 3c, Qc: the 3 out, a winner
            }
        }
        expect(ctx.t.cut.stage).toBe(stage);
        await h.flushStore(A.store);
        return { A, ctx, tid };
    }

    test.each([
        ['gather', 'handoff'], ['drawing', 'handoff'], ['reveal', 'handoff'], ['winner', 'handoff'],
        ['gather', 'kill'], ['drawing', 'kill'], ['reveal', 'kill'], ['winner', 'kill'],
    ])('a %s stage survives a %s: one winner, one tournamentComplete, one record', async (stage, kind) => {
        const record = jest.spyOn(tournamentHandlers, 'recordTournament');
        const { A, ctx, tid } = await intoCut(stage);
        const stageBefore = ctx.t.cut.stage;
        const aliveBefore = ctx.t.cut.engine ? ctx.t.cut.engine.aliveList() : null;
        const roundBefore = ctx.t.cut.engine ? ctx.t.cut.engine.round : 0;
        const B = await deploy.restart({ kind });
        // a kill: the successor adopts once the dead holder's heartbeat is stale
        for (let i = 0; i < 120 && !T(tid); i++) await jest.advanceTimersByTimeAsync(500);
        const t = T(tid);
        expect(t).toBeTruthy();
        expect(t.phase).toBe('cut');
        expect(t.cut.stage).toBe(stageBefore === 'gather' ? 'gather' : stageBefore === 'winner' ? 'winner' : 'reveal');
        if (aliveBefore) {
            expect(t.cut.engine.aliveList()).toEqual(aliveBefore);
            t.cut.engine.assertValid();
            // an open round is redrawn as the same round
            expect(t.cut.engine.round).toBe(stageBefore === 'drawing' ? roundBefore - 1 : roundBefore);
            expect(t.cut.engine.pending.size).toBe(0);
        }
        expect(t.finalWinners).toEqual(ctx.t.finalWinners);
        // the members come back with the cap; the first one gets the "continues" line
        const sockets = [];
        for (const u of ctx.usernames) {
            const s = back(B, u);
            giveCap(s);
            await tournamentHandlers.joinTournament(s, B.io, { tournamentId: tid });
            sockets.push(s);
        }
        const continues = events(B, 'tournamentMessage').filter((e) => e.data.message === cutForABuck.RESTORE_LINE);
        expect(continues).toHaveLength(1);
        const joined = events(B, 'tournamentJoined').at(-1).data;
        expect(joined.phase).toBe('cut');
        expect(joined.cut.stage).toBe(t.cut.stage);
        // nothing for 30 s, then it goes on: everyone draws whenever asked
        await jest.advanceTimersByTimeAsync(29000);
        expect(events(B, 'cutForABuckRound')).toHaveLength(0);
        for (let i = 0; i < 400 && t.phase === 'cut'; i++) {
            const e = t.cut?.engine;
            if (t.cut?.stage === 'drawing' && e?.open) {
                for (const u of e.aliveList()) {
                    if (!e.pending.has(u)) cutForABuck.draw(sockets[ctx.usernames.indexOf(u)], B.io, { round: e.round, slot: null });
                }
            }
            await jest.advanceTimersByTimeAsync(500);
        }
        expect(t.phase).toBe('complete');
        const completes = [...events(A, 'tournamentComplete'), ...events(B, 'tournamentComplete')];
        expect(completes).toHaveLength(1);
        expect(completes[0].data.cutForABuck.participants).toEqual(ctx.t.cut?.engine?.participants ?? completes[0].data.cutForABuck.participants);
        expect(events(B, 'cutForABuckWinner').length).toBeGreaterThanOrEqual(1);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record.mock.calls[0][1]).toEqual(completes[0].data.cutForABuck);
    }, 120000);

    test('nobody comes back: the cut runs with ghosts (drawn for) and the tournament completes', async () => {
        const { tid } = await intoCut('drawing');
        const B = await deploy.restart({ kind: 'handoff' });
        const t = T(tid);
        for (let i = 0; i < 400 && t.phase === 'cut'; i++) await jest.advanceTimersByTimeAsync(1000);
        expect(t.phase).toBe('complete');
        expect(events(B, 'tournamentComplete')).toHaveLength(1);
        expect(events(B, 'tournamentComplete')[0].data.cutForABuck.winner).toBeTruthy();
    }, 120000);
});

describe('the handoff itself', () => {
    /** What A's handoff told each table. */
    const toldOf = (inst) => new Map(deploy.outcomes.filter((o) => o.instance === inst.name && o.kind === 'run').flatMap((o) => o.tables.map((x) => [x.gameId, x.outcome])));

    test('a failed final write: the saved doc released as it is (no "continue" line, its tables "unknown"); B adopts it and its tables', async () => {
        const { A, ctx, tid } = await bootTournament(4);
        const [table] = await beginRound(ctx, A.io);
        await h.flushStore(A.store);
        db().faults.fail({ collections: 'liveTournaments', ops: 'replaceOne', instances: A.name });
        await deploy.restart({ kind: 'handoff' });
        expect(events(A, 'tournamentMessage').filter((e) => e.data.message === shutdown.TOURNAMENT_CONTINUE_LINE)).toEqual([]);
        expect(toldOf(A).get(table.gameId)).toBe('unknown');
        const t = T(tid);
        expect(t).toBeTruthy();
        expect(t.phase).toBe('round_active');
        expect(gameManager.games.has(table.gameId)).toBe(true);
        expect(ended).toEqual([]);
    });

    test('a tournament whose serialize refuses is deleted and its tables with it: told "ended", never "continue"', async () => {
        const { A, ctx, tid } = await bootTournament(4);
        const [table] = await beginRound(ctx, A.io);
        await h.flushStore(A.store);
        jest.spyOn(require('../game/persist/tournamentCodec'), 'serialize').mockImplementation(() => { throw new Error('chaos: serialize'); });
        await deploy.restart({ kind: 'handoff' });
        expect(events(A, 'tournamentMessage').filter((e) => e.data.message === shutdown.TOURNAMENT_CONTINUE_LINE)).toEqual([]);
        expect(toldOf(A).get(table.gameId)).toBe('ended');
        expect(T(tid)).toBeNull();
        await jest.advanceTimersByTimeAsync(2000);
        expect(liveTables({ tournamentId: tid })).toEqual([]);
        expect(db().liveGames.docs.filter((d) => d.tournamentId === tid)).toEqual([]);
        expect(db().liveTournaments.docs.filter((d) => d._id === tid)).toEqual([]);
    });

    test('joinTournament during the flush clears nothing and answers no failure', async () => {
        const { A, ctx, tid } = await bootTournament(3);
        const u = ctx.usernames[1];
        let during = null;
        const s = back(A, u);
        const spy = jest.spyOn(gameManager, 'clearActiveTournament');
        await db().users.updateOne({ username: u }, { $set: { activeTournamentId: tid } });
        const run = deploy.restart({ kind: 'handoff' });
        // Inside the shutdown: the tournament is already gone from A's memory
        await advanceUntil(() => shutdown.isShuttingDown() && !gameManager.getTournamentById(tid), 10, 5000);
        during = tournamentHandlers.joinTournament(s, A.io, { tournamentId: tid });
        await run;
        await jest.advanceTimersByTimeAsync(9000);
        await during;
        expect(spy).not.toHaveBeenCalled();
        expect(user(u).activeTournamentId).toBe(tid);
        expect([...A.log, ...A.afterDeath].filter((e) => e.to === `self:${s.id}` && e.event === 'serverError')).toEqual([]);
    });

    test('a crash releases liveTournaments; the ON_FAILURE restart adopts the tournament and its table', async () => {
        const { A, ctx, tid } = await bootTournament(4);
        const [table] = await beginRound(ctx, A.io);
        await h.flushStore(A.store);
        await deploy.restart({ kind: 'throw' });
        expect(deploy.exits).toEqual([1]);
        const doc = db().liveTournaments.docs.find((d) => d._id === tid);
        expect(doc).toBeTruthy();
        expect(doc.owner).not.toBe(A.bootId);
        expect(T(tid)).toBeTruthy();
        expect(gameManager.games.has(table.gameId)).toBe(true);
    });
});
