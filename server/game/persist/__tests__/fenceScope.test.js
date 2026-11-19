/**
 * What a lost doc means in LIVE_PERSIST=on (deploy survival PR 5;
 * persist/liveStore.js lost() and the terminal claim): only a doc another
 * instance could have adopted (ownerMode 'on', a casual table) is a fence.
 * A tournament and its tables are written 'write' until PR 6, so nothing
 * adopts them: a lost one (another instance's sweep discarded it after a
 * false death of this one) stops persisting and plays on, and its end
 * still records stats and scores the round, exactly as in write mode.
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const { mulberry32 } = require('../../../testUtils/gameDriver');
const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const liveStore = require('../liveStore');
const adopt = require('../adopt');
const tournamentHandlers = require('../../../socket/tournamentHandlers');
const { setupTournament, liveTables, advanceUntil } = require('../../../testUtils/tournamentDriver');
const chatHandlers = require('../../../socket/chatHandlers');
const profileHandlers = require('../../../socket/profileHandlers');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

let realRandom;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(31);
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    profileHandlers._resetStatsWritesForTests();
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

/** An 'on' store, a 4-human tournament, its one round-1 table saved ('write'). */
async function onTournamentTable() {
    const ctx = await setupTournament(4);
    const store = kit.installOnStore(mockDb, { bootId: 'boot-A', getIo: () => ctx.io, monoNow: h.createMonoClock().now });
    await store.start({ io: ctx.io });
    ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
    await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null && g.stage === Phase.BIDDING), 100, 120000);
    await ctx.starting;
    const [game] = liveTables(ctx.t);
    await h.flushStore(store);
    const saved = kit.savedGame(db(), game.gameId);
    expect(saved).toMatchObject({ owner: 'boot-A', ownerMode: 'write', tournamentId: ctx.t.tournamentId });
    return { ctx, store, game, id: game.gameId };
}

/** What another instance's sweep does to a dead owner's 'write' doc: adopt.js discard (verdict, then the owner/rev compare-and-set delete). */
async function discardAsB(id) {
    const env = kit.savedGame(db(), id);
    expect(adopt.classify(env, { ownerState: 'dead', ownerInst: null, me: 'boot-B', now: Date.now(), readVersions: [env.v] })).toMatchObject({ act: 'discard', why: 'mode' });
    const res = await db().liveGames.deleteOne({ _id: id, owner: env.owner, rev: env.rev });
    expect(res.deletedCount).toBe(1);
}

test("'on': a tournament table whose 'write' doc was discarded elsewhere plays on (not fenced) and stops persisting", async () => {
    const { store, game, id, ctx } = await onTournamentTable();
    await discardAsB(id);
    game.addLogEntry('a change after the discard', null, 'system');
    await h.flushStore(store);
    expect(game.frozen).toBeFalsy();
    expect(gameManager.games.get(id)).toBe(game);
    expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBe(ctx.t);
    expect(store.logs.some((l) => /fenced/.test(l.msg))).toBe(false);
    expect(store.logs.some((l) => /Live doc lost; no longer saved, play goes on/.test(l.msg))).toBe(true);
    // Not re-inserted: the lost doc stays lost
    game.addLogEntry('another change', null, 'system');
    await h.flushStore(store);
    expect(kit.savedGame(db(), id)).toBeNull();
    expect(store.claimable(game)).toBe(false);
});

test("'on': the same table's terminal claim with its doc gone is not 'fenced': the round is scored", async () => {
    const { store, game, id, ctx } = await onTournamentTable();
    // The claim's own update finds nothing (the write before it went through first)
    await discardAsB(id);
    const st = store._state(game);
    const claim = store.claimEnded(game, { record: null, tournamentId: ctx.t.tournamentId });
    // Never written since the discard, so the claim itself meets the gone doc
    expect(st.inserted).toBe(true);
    await expect(claim).resolves.not.toBe('fenced');
    expect(store.logs.some((l) => /Terminal claim fenced/.test(l.msg))).toBe(false);
});

test("'on': a tournament table played to its end after a discard records stats and completes the round", async () => {
    const { store, game, id, ctx } = await onTournamentTable();
    await discardAsB(id);
    for (let step = 0; step < 800 && ctx.t.phase === 'round_active'; step++) {
        if (!game.isTerminal()) {
            for (const seat of game.seatList()) {
                if (seat.controller !== 'human' || seat.presence !== 'connected') continue;
                const s = ctx.sockets.find((x) => x.id === seat.ownerSocketId);
                if (s) chatHandlers.chatMessage(s, ctx.io, { message: '/lazy' });
            }
        }
        await jest.advanceTimersByTimeAsync(5000);
    }
    expect(game.stage).toBe(Phase.ENDED);
    expect(game.frozen).toBeFalsy();
    expect(ctx.t.phase).not.toBe('round_active');
    expect(ctx.t.roundOfGame(id).completedGames).toContain(id);
    await h.flushStore(store);
    expect(db().gameRecords.docs.map((r) => r.gameId)).toContain(id);
}, 120000);

test("'on': a casual table's lost doc is still a fence (another instance may own it)", async () => {
    const io = require('../../../testUtils/gameDriver').makeIo([]);
    const store = kit.installOnStore(mockDb, { bootId: 'boot-A', getIo: () => io, monoNow: h.createMonoClock().now });
    await store.start({ io });
    const { game } = await kit.startGame(io, [], { humans: ['Hal'] });
    await h.flushStore(store);
    expect(kit.savedGame(db(), game.gameId).ownerMode).toBe('on');
    db().liveGames.docs.find((d) => d._id === game.gameId).owner = 'boot-B';
    game.addLogEntry('a change', null, 'system');
    await h.flushStore(store);
    expect(game.frozen).toBe(true);
    expect(gameManager.games.has(game.gameId)).toBe(false);
});
