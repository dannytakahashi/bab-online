/**
 * What a lost doc means in LIVE_PERSIST=on (deploy survival PR 5/6;
 * persist/liveStore.js lost() and the terminal claim): a doc another
 * instance could have adopted (ownerMode 'on': since PR 6 casual tables,
 * tournaments and their tables) is a fence. A 'write' doc (write mode)
 * lost elsewhere stops persisting and plays on: nothing adopts it.
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
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

/** An 'on' store, a 4-human tournament, its one round-1 table saved ('on' since PR 6). */
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
    expect(saved).toMatchObject({ owner: 'boot-A', ownerMode: 'on', tournamentId: ctx.t.tournamentId });
    return { ctx, store, game, id: game.gameId };
}

/** Another instance adopted the table's doc (after a false death of this one): its owner changes. */
function adoptedByB(id) {
    const doc = db().liveGames.docs.find((d) => d._id === id);
    expect(doc).toBeTruthy();
    expect(adopt.classify(doc, { ownerState: 'dead', ownerInst: null, me: 'boot-B', now: Date.now(), readVersions: [doc.v] })).toMatchObject({ act: 'tournament', inner: { act: 'adopt' } });
    doc.owner = 'boot-B';
    doc.rev += 1;
}

test("'on' (PR 6): a tournament table's lost doc is a fence (another instance adopts tournament tables now)", async () => {
    const { store, game, id } = await onTournamentTable();
    adoptedByB(id);
    game.addLogEntry('a change after the adoption', null, 'system');
    await h.flushStore(store);
    expect(game.frozen).toBe(true);
    expect(gameManager.games.has(id)).toBe(false);
    expect(store.logs.some((l) => /Live doc fenced/.test(l.msg))).toBe(true);
});

test("'on' (PR 6): the same table's terminal claim with its doc another's answers 'fenced': no score from this copy", async () => {
    const { store, game, id, ctx } = await onTournamentTable();
    adoptedByB(id);
    const claim = store.claimEnded(game, { record: null, tournamentId: ctx.t.tournamentId });
    await expect(claim).resolves.toBe('fenced');
    expect(store.logs.some((l) => /Terminal claim fenced/.test(l.msg))).toBe(true);
});

test("a 'write' doc (write mode) lost elsewhere stops persisting and plays on", async () => {
    const ctx = await setupTournament(4);
    const store = kit.installStore(mockDb, { bootId: 'boot-W', mode: 'write' });
    await store.start({ io: ctx.io });
    ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
    await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null && g.stage === Phase.BIDDING), 100, 120000);
    await ctx.starting;
    const [game] = liveTables(ctx.t);
    await h.flushStore(store);
    expect(kit.savedGame(db(), game.gameId)).toMatchObject({ ownerMode: 'write' });
    await db().liveGames.deleteOne({ _id: game.gameId });
    game.addLogEntry('a change after the delete', null, 'system');
    await h.flushStore(store);
    expect(game.frozen).toBeFalsy();
    expect(gameManager.games.get(game.gameId)).toBe(game);
});

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
