/**
 * The over-the-shoulder view across a kill and restore (deploy survival):
 * `game.shoulders` is DERIVED (gameCodec), so a game saved while someone
 * watches a hand comes back with no watch at all, by gameCodec.serialize
 * and through the live store's write path (a LIVE_PERSIST=write store over
 * a liveDb). The adopted table sends no shoulder to anyone (the live emit
 * scan, testUtils/shoulderCheck.js), and the watcher's client re-spectates
 * and re-sends watchHand (docs/claude/spectators.md "Over-the-shoulder
 * view": re-send after every spectatorJoined full state), which works as
 * on a fresh table.
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const liveStore = require('../liveStore');

const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const pacing = require('../../pacing');
const codec = require('../gameCodec');
const gameHandlers = require('../../../socket/gameHandlers');
const lobbyHandlers = require('../../../socket/lobbyHandlers');
const mainRoomHandlers = require('../../../socket/mainRoomHandlers');
const reconnectHandlers = require('../../../socket/reconnectHandlers');
const assistHandlers = require('../../../socket/assistHandlers');
const clientInfo = require('../../../socket/clientInfo');
const shoulderView = require('../../../socket/shoulderView');
const rateLimiter = require('../../../socket/rateLimiter');
const { world } = require('../../../testUtils/contractScenarios');
const { adoptForTest, kickRestored } = require('../../../testUtils/restoreKit');
const { advanceUntil } = require('../../../testUtils/tournamentDriver');
const { mulberry32 } = require('../../../testUtils/gameDriver');
const { watchShoulders } = require('../../../testUtils/shoulderCheck');
const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');

const realRandom = Math.random;
let scan = null;
let currentIo = null;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    assistHandlers._resetForTests();
    process.env.BID_CLOCK = 'off';
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    scan = watchShoulders(() => currentIo, { ownerHsi: 'own' });
});

afterEach(() => {
    scan.stop();
    expect(scan.failures).toEqual([]);
    delete process.env.BID_CLOCK;
    liveStore._resetForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});
afterAll(() => rateLimiter.shutdown());

const CAPS = { client: 'web', version: '1.0.0', caps: ['avatarUrl', 'shoulderView'] };

test.each(['serialize', 'store'])('a watched game saved and adopted (%s): no shoulder survives, a re-sent watchHand works', async (path) => {
    const store = path === 'store' ? kit.installStore(mockDb) : null;
    Math.random = mulberry32(31);
    const w = world('shr');
    currentIo = w.io;
    const names = ['shr_ann', 'shr_bob', 'shr_cat', 'shr_dan'];
    const socks = names.map((n, i) => w.user(`shr-h${i}`, n));
    mainRoomHandlers.createLobby(socks[0], w.io, { name: 'restore table' });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    const pending = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    let game = gameManager.getPlayerGame(socks[0].id);
    await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
    pending.push(...socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 })));
    await advanceUntil(() => game.stage === Phase.BIDDING && !game.resume, 100);
    await Promise.all(pending);

    const fan = w.user('shr-fan', 'shr_fan');
    clientInfo.handle(fan, w.io, CAPS);
    mainRoomHandlers.joinAsSpectator(fan, w.io, { gameId: game.gameId });
    shoulderView.watchHand(fan, w.io, { gameId: game.gameId, position: 2 });
    expect(game.shoulders.get(fan.id)).toBe(2);

    // ---- the process dies; its saved doc is adopted by a fresh one
    const gameId = game.gameId;
    let doc = JSON.parse(JSON.stringify(codec.serialize(game, { tournamentId: null, getBot: () => null })));
    if (store) {
        await h.flushStore(store);
        const stored = kit.savedGame(mockDb.current, gameId);
        expect(kit.comparable(stored)).toEqual(kit.comparable(doc));
        doc = { ...JSON.parse(JSON.stringify(stored)), gameId };
        liveStore._resetForTests();
    }
    expect(JSON.stringify(doc)).not.toMatch(/shoulder/);
    expect(JSON.stringify(doc)).not.toContain(fan.id);
    gameManager.abortGame(gameId);
    gameManager._resetForTests();
    botController._resetForTests();
    assistHandlers._resetForTests();
    for (const s of [...socks, fan]) rateLimiter.clearSocket(s.id);

    game = adoptForTest(doc, { io: w.io });
    expect(game.shoulders).toBeInstanceOf(Map);
    expect(game.shoulders.size).toBe(0);
    expect(game.spectators.size).toBe(0);
    const back = [];
    for (let i = 0; i < 4; i++) {
        const s = w.user(`shr-back${i}`, names[i]);
        await reconnectHandlers.rejoinGame(s, w.io, { gameId, username: names[i] });
        back.push(s);
    }
    kickRestored(w.io, game);

    // the watcher's client reconnects: a new socket, spectates, re-sends watchHand
    const fan2 = w.user('shr-fan2', 'shr_fan');
    clientInfo.handle(fan2, w.io, CAPS);
    const mark = w.log.length;
    mainRoomHandlers.joinAsSpectator(fan2, w.io, { gameId });
    const full = w.log.slice(mark).find((l) => l.to === `self:${fan2.id}` && l.event === 'spectatorJoined');
    expect(full.data.snapshot.viewer).not.toHaveProperty('shoulder');
    shoulderView.watchHand(fan2, w.io, { gameId, position: 2 });
    const reply = w.log.slice(mark).find((l) => l.to === `self:${fan2.id}` && l.event === 'stateSnapshot');
    expect(reply.data.reason).toBe('watchHand');
    expect(reply.data.snapshot.viewer.shoulder.position).toBe(2);
    expect(reply.data.snapshot.viewer.shoulder.hand).toEqual(game.getHand(game.positions[2]).map((c) => ({ suit: c.suit, rank: c.rank })));
    expect([...game.shoulders.entries()]).toEqual([[fan2.id, 2]]);
    expect(scan.counts.snapshotShoulders).toBeGreaterThanOrEqual(2);
}, 60000);
