/**
 * A tournament table's saved doc keeps its tournament after the
 * GameManager.tournamentGames entry goes while the table still lives
 * (GameManager.deleteTournament with no abort: the LIVE_PERSIST=on store's
 * tournament fence on a self-fence re-take, a handoff detach). gameCodec
 * .serialize takes the game's own mark (GameState.tournamentId) before the
 * map, so the next save still says tournamentId, adopt.classify sends the
 * doc down the tournament path (adopted with its tournament, or discarded
 * as 'no tournament' when that tournament's doc is gone: adopt.js
 * tournamentTable), never the casual one, and a table hydrated from it is
 * a tournament table: no hand is ever served from it (the over-the-shoulder
 * view, server/socket/shoulderView.js; the live scan, shoulderCheck.js).
 * Before the fix the doc said tournamentId null and an adopter restored it
 * as a casual table whose hands spectators could watch.
 */

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
const codec = require('../gameCodec');
const persistHooks = require('../hooks');
const tournamentHandlers = require('../../../socket/tournamentHandlers');
const clientInfo = require('../../../socket/clientInfo');
const shoulderView = require('../../../socket/shoulderView');
const { setupTournament, liveTables, advanceUntil, newUser } = require('../../../testUtils/tournamentDriver');
const { adoptForTest } = require('../../../testUtils/restoreKit');
const { watchShoulders } = require('../../../testUtils/shoulderCheck');
const profileHandlers = require('../../../socket/profileHandlers');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

let realRandom;
let scan = null;
let currentIo = null;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(41);
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    scan = watchShoulders(() => currentIo, { ownerHsi: 'own' });
});

afterEach(() => {
    scan.stop();
    expect(scan.failures).toEqual([]);
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

test('the map entry goes, the table lives on: its next save keeps tournamentId, the adopter takes the tournament path, a hydrated copy serves no hand', async () => {
    const ctx = await setupTournament(4);
    currentIo = ctx.io;
    const store = kit.installOnStore(mockDb, { bootId: 'boot-A', getIo: () => ctx.io, monoNow: h.createMonoClock().now });
    await store.start({ io: ctx.io });
    ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
    await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null && g.stage === Phase.BIDDING), 100, 120000);
    await ctx.starting;
    const [game] = liveTables(ctx.t);
    const tid = ctx.t.tournamentId;
    await h.flushStore(store);
    expect(kit.savedGame(db(), game.gameId)).toMatchObject({ ownerMode: 'on', tournamentId: tid });

    // the tournament fence's path: deleteTournament, no abort; the table lives on
    gameManager.deleteTournament(tid);
    expect(gameManager.tournamentGames.has(game.gameId)).toBe(false);
    expect(game.isTerminal()).toBe(false);
    expect(game.tournamentId).toBe(tid);
    persistHooks.gameChanged(game);
    await h.flushStore(store);
    const saved = kit.savedGame(db(), game.gameId);
    expect(saved.tournamentId).toBe(tid);
    // what serialize says directly (no store) agrees; an explicit argument still wins
    expect(codec.serialize(game).tournamentId).toBe(tid);
    expect(codec.serialize(game, { tournamentId: null }).tournamentId).toBeNull();

    // the adopter: a dead owner's doc of a tournament table goes the tournament way, never 'adopt'
    const doc = db().liveGames.docs.find((d) => d._id === game.gameId);
    const verdict = adopt.classify(doc, { ownerState: 'dead', ownerInst: null, me: 'boot-B', now: Date.now(), readVersions: [doc.v] });
    expect(verdict.act).toBe('tournament');

    // a table hydrated from that doc is a tournament table on its own (no map entry needed)
    const plain = JSON.parse(JSON.stringify(codec.serialize(game)));
    liveStore._resetForTests();
    gameManager.abortGame(game.gameId);
    gameManager._resetForTests();
    botController._resetForTests();
    const back = adoptForTest(plain, { io: null });
    gameManager.tournamentGames.delete(back.gameId); // as if its tournament were never adopted
    expect(back.tournamentId).toBe(tid);
    expect(shoulderView.isTournamentTable(back)).toBe(true);
    const fan = newUser(ctx.io, ctx.log, 'std_fan');
    clientInfo.handle(fan, ctx.io, { client: 'web', version: '1', caps: ['avatarUrl', 'shoulderView'] });
    gameManager.addSpectator(ctx.io, back, fan.id, 'std_fan');
    const from = ctx.log.length;
    for (const position of [1, 2, 3, 4]) shoulderView.watchHand(fan, ctx.io, { gameId: back.gameId, position });
    const got = ctx.log.slice(from).filter((l) => l.to === `self:${fan.id}`);
    expect(got.map((l) => [l.event, l.data.reason])).toEqual([1, 2, 3, 4].map(() => ['watchHandRefused', 'tournament']));
    expect(back.shoulders.size).toBe(0);
});
