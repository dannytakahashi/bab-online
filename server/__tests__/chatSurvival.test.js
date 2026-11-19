/**
 * Chat across a restart (deploy survival PR 5, LIVE_PERSIST=on; the plan's
 * 2.8 and the PR 5 "chatSurvival.test.js" bullet), through deployKit (the
 * real store, SIGTERM handoff, crash and adoption over createPersistHarness):
 *   - a player's, a spectator's and the /lazy lines survive a handoff: the
 *     restored game log is the old one plus the one "resumed" line, and
 *     the rejoin snapshot shows them
 *   - a kill loses at most the line not yet written (the last one)
 *   - main-room and lobby chat appear in no collection
 *   - what is saved is the filtered text, never what was typed
 *   - nothing remains once gameEnd's record is acknowledged, or after an
 *     abort
 *   - no chat text in any log line (the stores' loggers and every server
 *     logger)
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
const mockDb = { current: null };
jest.mock('../database', () => require('../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../testUtils/persistHarness');
const kit = require('../testUtils/liveStoreKit');
const { createDeploy } = require('../testUtils/deployKit');
const { makeSocket, mulberry32 } = require('../testUtils/gameDriver');
const gameManager = require('../game/GameManager');
const { botController } = require('../game/bot');
const { Phase } = require('../game/GamePhase');
const liveStore = require('../game/persist/liveStore');
const { RESUMED_LINE } = require('../game/persist/restoreGame');
const shutdown = require('../utils/shutdown');
const profileHandlers = require('../socket/profileHandlers');
const chatHandlers = require('../socket/chatHandlers');
const mainRoomHandlers = require('../socket/mainRoomHandlers');
const lobbyHandlers = require('../socket/lobbyHandlers');
const reconnectHandlers = require('../socket/reconnectHandlers');
const gameLifecycle = require('../socket/gameLifecycle');
const loggers = require('../utils/logger');

const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];
const LOGGERS = ['gameLogger', 'socketLogger', 'authLogger', 'logger', 'dbLogger'];
let realRandom;
let listenersBefore;
let logged;
let deploy;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(61);
    listenersBefore = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    logged = [];
    for (const name of LOGGERS) {
        for (const m of ['error', 'info', 'debug', 'warn']) {
            jest.spyOn(loggers[name], m).mockImplementation((msg, meta) => { logged.push(JSON.stringify([msg, meta ?? null])); });
        }
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
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
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const liveCollections = () => ['liveGames', 'liveTournaments', 'serverInstances'].map((c) => JSON.stringify(db()[c].docs)).join('\n');
const PLAYER_LINE = 'see you after the deploy';
const SPECTATOR_LINE = 'go team go';
const TYPED = 'well shit happens';
const FILTERED = 'well **** happens';
const MAIN_ROOM_LINE = 'anyone up for a game';
const LOBBY_LINE = 'ready when you are';

/** Boot A with a table of Hal and Ivy (bots for the rest), dealt and saved; a spectator watching. */
async function bootWithTable() {
    deploy = createDeploy({ holder: mockDb, db: db() });
    const A = await deploy.boot();
    const ctx = await kit.startGame(A.io, A.log, { humans: ['Hal', 'Ivy'] });
    for (const u of ['Hal', 'Ivy']) await db().users.updateOne({ username: u }, { $set: { activeGameId: ctx.game.gameId } });
    // A spectator is a signed-in account (a sender the adopter cannot find is scrubbed)
    db().users._insert({ username: 'Fan', profilePic: 5 });
    const fan = makeSocket('fan-1', A.log, A.io);
    gameManager.registerUser(fan.id, 'Fan');
    mainRoomHandlers.joinAsSpectator(fan, A.io, { gameId: ctx.game.gameId });
    await h.flushStore(A.store);
    return { A, ...ctx, fan, id: ctx.game.gameId };
}

const texts = (game) => game.gameLog.map((e) => e.message);
const chatTexts = (game) => game.gameLog.filter((e) => e.type === 'chat').map((e) => e.message);

describe('chat survives a restart', () => {
    test("a player's, a spectator's and the /lazy lines survive a handoff; the rejoin snapshot shows them", async () => {
        const { A, game, sockets, fan, id } = await bootWithTable();
        await chatHandlers.chatMessage(sockets[0], A.io, { message: PLAYER_LINE });
        await chatHandlers.chatMessage(fan, A.io, { message: SPECTATOR_LINE });
        await chatHandlers.chatMessage(sockets[1], A.io, { message: '/lazy' });
        const before = texts(game);
        expect(chatTexts(game)).toEqual([`Hal: ${PLAYER_LINE}`, `Fan: ${SPECTATOR_LINE}`]);
        const B = await deploy.restart({ kind: 'handoff' });
        const restored = gameManager.games.get(id);
        expect(restored).toBeTruthy();
        // The old log, then the one "resumed" line (the handoff's own line is never stored)
        expect(texts(restored)).toEqual([...before, RESUMED_LINE]);
        expect(restored.gameLog.filter((e) => e.type === 'chat').map((e) => e.from)).toEqual(['Hal', 'Fan']);
        const hal = makeSocket('hal-2', B.log, B.io);
        gameManager.registerUser(hal.id, 'Hal');
        await reconnectHandlers.rejoinGame(hal, B.io, { gameId: id, username: 'Hal' });
        const carrier = B.log.find((e) => e.to === `self:${hal.id}` && e.event === 'rejoinSuccess');
        expect(carrier).toBeTruthy();
        const shown = JSON.stringify(carrier.data.snapshot.log);
        for (const line of [PLAYER_LINE, SPECTATOR_LINE, RESUMED_LINE]) expect(shown).toContain(line);
        expect(logged.filter((l) => l.includes(PLAYER_LINE) || l.includes(SPECTATOR_LINE))).toEqual([]);
        for (const inst of deploy.harness.instances) {
            expect((inst.store?.logs || []).filter((l) => JSON.stringify(l).includes(PLAYER_LINE))).toEqual([]);
        }
    });

    test('a kill loses at most the line not yet written', async () => {
        const { A, sockets, id } = await bootWithTable();
        await chatHandlers.chatMessage(sockets[0], A.io, { message: 'first line, written' });
        await h.flushStore(A.store);
        // The second line's write never leaves the process
        await chatHandlers.chatMessage(sockets[0], A.io, { message: 'second line, maybe lost' });
        await deploy.restart({ kind: 'kill' });
        const restored = await deploy.waitAdopted(id, { cap: 30000 });
        expect(restored).toBeTruthy();
        const chats = chatTexts(restored);
        expect(chats[0]).toBe('Hal: first line, written');
        expect(chats.length).toBeLessThanOrEqual(2);
        expect(texts(restored).at(-1)).toBe(RESUMED_LINE);
    });

    test('a crash (released) keeps every written line', async () => {
        const { A, game, sockets, id } = await bootWithTable();
        await chatHandlers.chatMessage(sockets[0], A.io, { message: PLAYER_LINE });
        await h.flushStore(A.store);
        const before = texts(game);
        await deploy.restart({ kind: 'throw' });
        expect(deploy.exits).toEqual([1]);
        const restored = await deploy.waitAdopted(id, { cap: 5000 });
        expect(texts(restored)).toEqual([...before, RESUMED_LINE]);
    });

    test('main-room and lobby chat appear in no collection; the saved game text is the filtered text', async () => {
        const { A, sockets, id } = await bootWithTable();
        const m1 = makeSocket('main-1', A.log, A.io);
        gameManager.registerUser(m1.id, 'Mo');
        gameManager.joinMainRoom(m1.id);
        mainRoomHandlers.mainRoomChat(m1, A.io, { message: MAIN_ROOM_LINE });
        const l1 = makeSocket('lob-1', A.log, A.io);
        const l2 = makeSocket('lob-2', A.log, A.io);
        gameManager.registerUser(l1.id, 'Lu');
        gameManager.registerUser(l2.id, 'Lea');
        gameManager.createLobby([l1.id, l2.id]);
        lobbyHandlers.lobbyChat(l1, A.io, { message: LOBBY_LINE });
        expect(A.log.some((e) => e.event === 'mainRoomMessage' && e.data.message === MAIN_ROOM_LINE)).toBe(true);
        expect(A.log.some((e) => e.event === 'lobbyMessage' && e.data.message === LOBBY_LINE)).toBe(true);
        await chatHandlers.chatMessage(sockets[0], A.io, { message: TYPED });
        await h.flushStore(A.store);
        const all = liveCollections();
        expect(all).not.toContain(MAIN_ROOM_LINE);
        expect(all).not.toContain(LOBBY_LINE);
        expect(all).not.toContain(TYPED);
        expect(all).toContain(FILTERED);
        // And across a handoff
        await deploy.restart({ kind: 'handoff' });
        const restored = gameManager.games.get(id);
        expect(chatTexts(restored)).toEqual([`Hal: ${FILTERED}`]);
        await h.flushStore(deploy.store());
        const after = liveCollections();
        for (const line of [MAIN_ROOM_LINE, LOBBY_LINE, TYPED]) expect(after).not.toContain(line);
        expect(logged.filter((l) => l.includes('happens') || l.includes(MAIN_ROOM_LINE) || l.includes(LOBBY_LINE))).toEqual([]);
    });

    test("nothing remains once the restored game's record is acknowledged", async () => {
        const { A, sockets, id } = await bootWithTable();
        await chatHandlers.chatMessage(sockets[0], A.io, { message: PLAYER_LINE });
        await deploy.restart({ kind: 'handoff' });
        const restored = gameManager.games.get(id);
        const B = deploy.current();
        // Both owners come back and go lazy: the bots finish it
        for (const [i, u] of ['Hal', 'Ivy'].entries()) {
            const s = makeSocket(`${u}-b${i}`, B.log, B.io);
            gameManager.registerUser(s.id, u);
            await reconnectHandlers.rejoinGame(s, B.io, { gameId: id, username: u });
            await chatHandlers.chatMessage(s, B.io, { message: '/lazy' });
        }
        await kit.advanceUntil(() => restored.isTerminal(), { step: 1000, cap: 3 * 3600000 });
        await jest.advanceTimersByTimeAsync(30000);
        await h.flushStore(B.store);
        expect(restored.stage).toBe(Phase.ENDED);
        expect(db().gameRecords.docs.filter((r) => r.gameId === id)).toHaveLength(1);
        expect(db().liveGames.docs).toEqual([]);
        expect(liveCollections()).not.toContain(PLAYER_LINE);
        for (const u of ['Hal', 'Ivy']) expect(db().users.docs.find((d) => d.username === u).activeGameId ?? null).toBeNull();
    });

    test('nothing remains after an abort of the restored game', async () => {
        const { A, sockets, id } = await bootWithTable();
        await chatHandlers.chatMessage(sockets[0], A.io, { message: PLAYER_LINE });
        await deploy.restart({ kind: 'handoff' });
        const restored = gameManager.games.get(id);
        const B = deploy.current();
        await gameLifecycle.abortGame(B.io, restored, 'test abort');
        await h.flushStore(B.store);
        await jest.advanceTimersByTimeAsync(1000);
        expect(db().liveGames.docs).toEqual([]);
        expect(liveCollections()).not.toContain(PLAYER_LINE);
        expect(db().gameRecords.docs).toEqual([]);
    });
});
