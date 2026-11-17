/**
 * Tournament writes (deploy survival PR 4): a whole 4-round tournament
 * (tournamentDriver, real handlers, bots playing the lazy humans' seats)
 * with LIVE_PERSIST write. After every tournament-room emit, once the
 * store has written (a setImmediate later, then until it is idle), the
 * stored liveTournaments doc equals tournamentCodec.serialize(t): every
 * mutator, direct field write and table score change reaches the doc
 * (TournamentState._changed, the game hooks marking their tournament).
 * At the end every table's tombstone is gone (records acknowledged, the
 * tournament doc listing it complete) and, after the results window, the
 * tournament's doc too.
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const { mulberry32 } = require('../../../testUtils/gameDriver');
const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const TournamentState = require('../../TournamentState');
const tournamentCodec = require('../tournamentCodec');
const liveStore = require('../liveStore');
const tournamentHandlers = require('../../../socket/tournamentHandlers');
const { setupTournament, playTournament } = require('../../../testUtils/tournamentDriver');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

let realRandom;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(23);
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    liveStore._resetForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    gameManager._resetForTests();
    botController._resetForTests();
    tournamentHandlers._resetCleanupTimersForTests?.();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const stored = (doc) => (doc ? kit.plain({ v: doc.v, phase: doc.phase, state: doc.state }) : null);
const expected = (t) => {
    const doc = tournamentCodec.serialize(t);
    return doc ? kit.plain({ v: doc.v, phase: doc.phase, state: doc.state }) : null;
};

test('4 rounds: after every tournament emit the stored doc catches up to serialize(t); nothing is left at the end', async () => {
    const store = kit.installStore(mockDb);
    const mismatches = [];
    let checks = 0;
    let waiting = false;
    let ctx = null;

    // One check at a time: a setImmediate after the emit, then again while
    // the store is still writing (a follow-up write), then compare
    const check = () => {
        if (store.pending() > 0) {
            setImmediate(check);
            return;
        }
        waiting = false;
        const t = ctx?.t;
        if (!t || t.retired) return;
        const want = expected(t);
        if (!want) return;
        checks++;
        const got = stored(kit.savedTournament(db(), t.tournamentId));
        if (JSON.stringify(got) !== JSON.stringify(want)) {
            mismatches.push({ phase: t.phase, round: t.currentRound, got: got && got.state.rounds, want: want.state.rounds });
        }
    };
    const broadcast = TournamentState.prototype.broadcast;
    jest.spyOn(TournamentState.prototype, 'broadcast').mockImplementation(function (...args) {
        const r = broadcast.apply(this, args);
        if (!waiting) {
            waiting = true;
            setImmediate(check);
        }
        return r;
    });

    ctx = await setupTournament(6);
    tournamentHandlers.tournamentChat(ctx.sockets[1], ctx.io, { message: 'good luck' });
    await h.flushStore(store);
    expect(stored(kit.savedTournament(db(), ctx.t.tournamentId))).toEqual(expected(ctx.t));
    expect(kit.savedTournament(db(), ctx.t.tournamentId).state.messages.map((m) => m.message)).toEqual(['good luck']);

    // And at each round's start (tables dealt, every table's score in tableScores)
    let roundChecks = 0;
    const { allTables } = await playTournament(ctx, {
        round: async () => {
            await h.flushStore(store);
            expect(stored(kit.savedTournament(db(), ctx.t.tournamentId))).toEqual(expected(ctx.t));
            expect(Object.keys(kit.savedTournament(db(), ctx.t.tournamentId).state.tableScores).length).toBeGreaterThan(0);
            roundChecks++;
        },
    });
    expect(roundChecks).toBe(4);
    await h.flushStore(store);
    expect(ctx.t.phase).toBe('complete');
    expect(allTables.length).toBeGreaterThanOrEqual(8);
    expect(mismatches).toEqual([]);
    // (a check waits while any table is still writing: most land between hands and rounds)
    expect(checks).toBeGreaterThanOrEqual(10);
    // The results window: still saved, complete, with its completedAt
    const done = kit.savedTournament(db(), ctx.t.tournamentId);
    expect(done).toMatchObject({ phase: 'complete', owner: 'boot-A', ownerMode: 'write' });
    expect(done.completedAt).toBe(ctx.t.completedAt);
    expect(done.state.rounds.every((r) => r.completedGames.length === r.games.length)).toBe(true);
    // Every table recorded once, every tombstone gone
    expect(new Set(db().gameRecords.docs.map((r) => r.gameId)).size).toBe(db().gameRecords.docs.length);
    expect(db().liveGames.docs).toEqual([]);

    // After the results window the tournament is deleted, and its doc
    await jest.advanceTimersByTimeAsync(11 * 60 * 1000);
    await h.flushStore(store);
    expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBeFalsy();
    expect(db().liveTournaments.docs).toEqual([]);
}, 300000);

test('a lobby: members, host, chat (players and spectators) are saved from creation; a leave and a host change reach the doc', async () => {
    const store = kit.installStore(mockDb);
    const ctx = await setupTournament(3);
    await h.flushStore(store);
    const doc = () => kit.savedTournament(db(), ctx.t.tournamentId);
    expect(doc().state.players.map((p) => p.username)).toEqual(ctx.usernames);
    expect(doc().state.creatorUsername).toBe(ctx.usernames[0]);

    tournamentHandlers.leaveTournament(ctx.sockets[0], ctx.io);
    await jest.advanceTimersByTimeAsync(0);
    await h.flushStore(store);
    expect(doc().state.players.map((p) => p.username)).toEqual(ctx.usernames.slice(1));
    expect(doc().state.creatorUsername).toBe(ctx.t.creatorUsername);
    expect(doc().state.creatorUsername).not.toBe(ctx.usernames[0]);
    expect(stored(doc())).toEqual(expected(ctx.t));
});

test('each mutator and direct field write reaches the doc on its own (no other change riding along)', async () => {
    const store = kit.installStore(mockDb);
    const ctx = await setupTournament(4);
    const { t, io } = ctx;
    await h.flushStore(store);
    const liveness = require('../../../socket/tournamentLiveness');
    const steps = [
        ['addMessage', () => t.addMessage(ctx.usernames[0], 'hi', false)],
        ['addMessage (spectator)', () => t.addMessage('Wes', 'hello', true)],
        ['scrubChatFrom', () => t.scrubChatFrom('Wes')],
        ['addPlayer', () => t.addPlayer('s-new', 'Newt', 5)],
        ['transferCreator', () => t.transferCreator()],
        ['removePlayer', () => t.removePlayer('s-new')],
        ['reattachPlayerByUsername', () => t.reattachPlayerByUsername(ctx.usernames[1], 's-again')],
        ['beginStart', () => t.beginStart()],
        ['startRound', () => t.startRound(1)],
        ['addGameToRound', () => t.addGameToRound('g-fake-1', [ctx.usernames[0]], 3)],
        ['recordPlayerRoundScore', () => t.recordPlayerRoundScore(ctx.usernames[0], { roundNumber: 1, teamScore: 120 })],
        ['markGameComplete', () => t.markGameComplete('g-fake-1')],
        ['completeRound', () => t.completeRound()],
        ['liveness: the ready deadline (direct write)', () => liveness.armReadyDeadline(io, t)],
        ['ready marks (direct, then a broadcast)', () => {
            for (const sid of t.players.keys()) if (sid !== t.createdBy) t.readyPlayers.add(sid);
            t.broadcast(io, 'tournamentReadyUpdate', liveness.readyUpdatePayload(t));
        }],
        // The idle host's hand-off (tournamentLiveness.handOffHost, from the
        // hostIdle timer): the new host and handedOffThisWait
        ['liveness: the idle host handed off (direct write)', async () => {
            const host = t.createdBy;
            expect(t.handedOffThisWait).toBeFalsy();
            liveness.refreshHostIdle(io, t);
            await jest.advanceTimersByTimeAsync(liveness.hostIdleMs() + 1);
            expect(t.createdBy).not.toBe(host);
            expect(t.handedOffThisWait).toBe(true);
        }],
        ['broadcast after a direct write', () => { t.handedOffThisWait = true; t.broadcast(io, 'tournamentMessage', liveness.systemLine('x')); }],
    ];
    for (const [name, step] of steps) {
        await step();
        await h.flushStore(store);
        expect([name, stored(kit.savedTournament(db(), t.tournamentId))]).toEqual([name, expected(t)]);
        if (name.startsWith('liveness: the idle host')) expect(kit.savedTournament(db(), t.tournamentId).state.handedOffThisWait).toBe(true);
    }
    expect(kit.savedTournament(db(), t.tournamentId).state.readyDeadlineAt).toBe(t.readyDeadlineAt);
    expect(t.readyDeadlineAt).not.toBeNull();
});
