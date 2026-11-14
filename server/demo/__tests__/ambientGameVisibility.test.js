/**
 * The ambient bot-vs-bot demo game follows the bot chat's audience (owner,
 * 2026-11-14: "making the bot demo game only appear for test1 (like we did
 * for the bot chats)"): AMBIENT_CHAT_USERS, default test1, `*` everyone (the
 * behavior before), `none` nobody (server/utils/ambientChatUsers.js).
 *
 * Covered: the in-progress lists (mainRoomJoined at all three join points,
 * every lobbiesUpdated, one broadcast unless the lists differ), demand (only
 * the audience starts or keeps a game), spectate / rejoin refusals that read
 * exactly like an unknown game, and a full start -> list -> end cycle in
 * which a non-audience account never receives the game's id in any payload.
 */

const crypto = require('crypto');
const { ambientChatAudience, ambientAudience, seesAmbientChat, seesAmbientGame } = require('../../utils/ambientChatUsers');
// Required once, before any resetModules, so its emits reach the same
// contractCheck instance the contract guard (setupFilesAfterEnv) reads
const driver = require('../../testUtils/gameDriver');

let ambient;
let gameManager;
let mainRoomHandlers;
let lobbyHandlers;
let tournamentHandlers;
let reconnectHandlers;
let gameLifecycle;
let pacing;
let log;
let io;
const savedEnv = process.env.AMBIENT_CHAT_USERS;

beforeEach(() => {
    jest.resetModules();
    ambient = require('../ambientBots');
    gameManager = require('../../game/GameManager');
    mainRoomHandlers = require('../../socket/mainRoomHandlers');
    lobbyHandlers = require('../../socket/lobbyHandlers');
    tournamentHandlers = require('../../socket/tournamentHandlers');
    reconnectHandlers = require('../../socket/reconnectHandlers');
    gameLifecycle = require('../../socket/gameLifecycle');
    pacing = require('../../game/pacing');
    log = [];
    io = driver.makeIo(log);
    delete process.env.AMBIENT_CHAT_USERS;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const { socketLogger, logger, gameLogger } = require('../../utils/logger');
    for (const l of [socketLogger, logger, gameLogger]) for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
});

afterEach(() => {
    ambient.stopAmbientActivity();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    const { botController } = require('../../game/bot');
    for (const id of Array.from(botController.gamesBots?.keys?.() || [])) botController.cleanupGame(id);
    if (savedEnv === undefined) delete process.env.AMBIENT_CHAT_USERS;
    else process.env.AMBIENT_CHAT_USERS = savedEnv;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** A signed-in socket in the main room. */
function enter(id, username) {
    const socket = driver.makeSocket(id, log, io);
    gameManager.registerUser(id, username);
    mainRoomHandlers.joinMainRoom(socket, io);
    return socket;
}

/** A demo game that is past the draw (listed for its audience). */
async function listedDemoGame() {
    const game = ambient.startBotGame(io);
    for (let t = 0; t < 600 && (game.phase === 'drawing' || game.phase === 'waiting'); t++) {
        await jest.advanceTimersByTimeAsync(50);
    }
    expect(game.phase).not.toBe('drawing');
    return game;
}

const ids = (list) => list.map((g) => g.gameId);
const lastTo = (event, to) => log.filter((l) => l.event === event && l.to === to).pop()?.data;
const lastJoined = (id) => lastTo('mainRoomJoined', `self:${id}`);
const lobbiesUpdated = () => log.filter((l) => l.event === 'lobbiesUpdated');
/** Everything a socket could have received: its own emits, its room broadcasts, io-wide ones. */
function reaching(socketId, rooms) {
    return log.filter((l) => l.to === `self:${socketId}` || l.to === socketId || l.to === '*' ||
        (rooms.includes(l.to) && l.except !== socketId));
}

describe('the audience helper', () => {
    test('seesAmbientGame is the chat audience under its general name', () => {
        const envs = [{}, { AMBIENT_CHAT_USERS: '' }, { AMBIENT_CHAT_USERS: 'Reviewer,alice' }, { AMBIENT_CHAT_USERS: '*' }, { AMBIENT_CHAT_USERS: 'none' }];
        for (const env of envs) {
            expect(ambientAudience(env)).toEqual(ambientChatAudience(env));
            for (const name of ['test1', 'TEST1', 'reviewer', 'alice', 'bob', undefined, null]) {
                expect([env, name, seesAmbientGame(name, env)]).toEqual([env, name, seesAmbientChat(name, env)]);
            }
        }
        expect(seesAmbientGame('Test1', {})).toBe(true);
        expect(seesAmbientGame('alice', {})).toBe(false);
    });
});

describe('the in-progress list', () => {
    beforeEach(() => jest.useFakeTimers());

    test('getInProgressGames(viewer): the demo game for test1 (any case) only; includeDemo overrides', async () => {
        const game = await listedDemoGame();
        expect(ids(gameManager.getInProgressGames('test1'))).toEqual([game.gameId]);
        expect(ids(gameManager.getInProgressGames('TeSt1'))).toEqual([game.gameId]);
        expect(gameManager.getInProgressGames('alice')).toEqual([]);
        expect(gameManager.getInProgressGames()).toEqual([]);
        expect(ids(gameManager.getInProgressGames('alice', { includeDemo: true }))).toEqual([game.gameId]);
        expect(gameManager.getInProgressGames('test1', { includeDemo: false })).toEqual([]);
    });

    test('mainRoomJoined at all three join points lists it for test1 only', async () => {
        const game = await listedDemoGame();
        // 1. joinMainRoom
        const alice = enter('s-alice', 'alice');
        const review = enter('s-review', 'test1');
        expect(lastJoined('s-alice').inProgressGames).toEqual([]);
        expect(ids(lastJoined('s-review').inProgressGames)).toEqual([game.gameId]);

        // 2. leaveLobby
        for (const s of [alice, review]) {
            mainRoomHandlers.createLobby(s, io, {});
            lobbyHandlers.leaveLobby(s, io);
        }
        expect(lastJoined('s-alice').inProgressGames).toEqual([]);
        expect(ids(lastJoined('s-review').inProgressGames)).toEqual([game.gameId]);

        // 3. a tournament's sendToMainRoom (leaveTournament)
        for (const s of [alice, review]) {
            tournamentHandlers.createTournament(s, io, {});
            tournamentHandlers.leaveTournament(s, io, {});
        }
        expect(lastJoined('s-alice').inProgressGames).toEqual([]);
        expect(ids(lastJoined('s-review').inProgressGames)).toEqual([game.gameId]);
        // The same keys either way (only the array differs)
        expect(Object.keys(lastJoined('s-alice')).sort()).toEqual(Object.keys(lastJoined('s-review')).sort());
    });

    test('lobbiesUpdated: per socket while the lists differ, the same shape; everyone else as before', async () => {
        const game = await listedDemoGame();
        const alice = enter('s-alice', 'alice');
        enter('s-review', 'test1');
        enter('s-bob', 'bob');
        log.length = 0;

        mainRoomHandlers.createLobby(alice, io, {}); // alice leaves the main room for her lobby
        const sent = lobbiesUpdated();
        expect(sent.map((l) => l.to).sort()).toEqual(['s-bob', 's-review']);
        expect(ids(lastTo('lobbiesUpdated', 's-review').inProgressGames)).toEqual([game.gameId]);
        expect(lastTo('lobbiesUpdated', 's-bob').inProgressGames).toEqual([]);
        expect(lastTo('lobbiesUpdated', 's-bob').lobbies).toEqual(lastTo('lobbiesUpdated', 's-review').lobbies);
        expect(lastTo('lobbiesUpdated', 's-bob').lobbies).toHaveLength(1);
        expect(Object.keys(lastTo('lobbiesUpdated', 's-bob'))).toEqual(['lobbies', 'inProgressGames', 'tournaments']);
        expect(Object.keys(lastTo('lobbiesUpdated', 's-review'))).toEqual(['lobbies', 'inProgressGames', 'tournaments']);
    });

    test('one main-room broadcast when nobody in the room sees the game, and when no demo game is listed', async () => {
        enter('s-alice', 'alice');
        log.length = 0;
        gameLifecycle.emitLobbiesUpdated(io);
        expect(lobbiesUpdated().map((l) => l.to)).toEqual(['mainRoom']);

        const game = await listedDemoGame(); // handleDrawComplete's lobbiesUpdated
        expect(lobbiesUpdated().every((l) => l.to === 'mainRoom')).toBe(true);
        expect(lobbiesUpdated().every((l) => !ids(l.data.inProgressGames).includes(game.gameId))).toBe(true);

        // test1 arrives: from now on the lists differ
        enter('s-review', 'test1');
        log.length = 0;
        expect(gameLifecycle.emitLobbiesUpdated(io)).toEqual(['s-review']);
        expect(lobbiesUpdated().map((l) => l.to).sort()).toEqual(['s-alice', 's-review']);

        // The game ends: one broadcast again
        gameManager.endGame(game.gameId, io);
        log.length = 0;
        expect(gameLifecycle.emitLobbiesUpdated(io)).toBeNull();
        expect(lobbiesUpdated()).toEqual([expect.objectContaining({ to: 'mainRoom', data: expect.objectContaining({ inProgressGames: [] }) })]);
    });

    test('a non-demo game in progress is listed for everyone, the demo game only for test1', async () => {
        // Any other game (here a bot table that is not the demo game, as a
        // lobby filled with bots would be), past the draw
        const human = await listedDemoGame();
        human.isDemo = false;
        const demo = await listedDemoGame();
        enter('s-alice', 'alice');
        enter('s-review', 'test1');
        expect(ids(lastJoined('s-alice').inProgressGames)).toEqual([human.gameId]);
        expect(ids(lastJoined('s-review').inProgressGames).sort()).toEqual([demo.gameId, human.gameId].sort());
        log.length = 0;
        gameLifecycle.emitLobbiesUpdated(io);
        expect(ids(lastTo('lobbiesUpdated', 's-alice').inProgressGames)).toEqual([human.gameId]);
        expect(ids(lastTo('lobbiesUpdated', 's-review').inProgressGames).sort()).toEqual([demo.gameId, human.gameId].sort());
    });

    test('*: everyone sees it, one main-room broadcast as before', async () => {
        process.env.AMBIENT_CHAT_USERS = '*';
        const game = await listedDemoGame();
        enter('s-alice', 'alice');
        enter('s-review', 'test1');
        expect(ids(lastJoined('s-alice').inProgressGames)).toEqual([game.gameId]);
        log.length = 0;
        expect(gameLifecycle.emitLobbiesUpdated(io)).toBeNull();
        expect(lobbiesUpdated()).toHaveLength(1);
        expect(lobbiesUpdated()[0].to).toBe('mainRoom');
        expect(ids(lobbiesUpdated()[0].data.inProgressGames)).toEqual([game.gameId]);
    });

    test('none: nobody sees it, test1 included', async () => {
        process.env.AMBIENT_CHAT_USERS = 'none';
        await listedDemoGame();
        enter('s-review', 'test1');
        expect(lastJoined('s-review').inProgressGames).toEqual([]);
        log.length = 0;
        gameLifecycle.emitLobbiesUpdated(io);
        expect(lobbiesUpdated()).toEqual([expect.objectContaining({ to: 'mainRoom', data: expect.objectContaining({ inProgressGames: [] }) })]);
    });

    test('a named list (case-insensitive): those accounts, not test1', async () => {
        process.env.AMBIENT_CHAT_USERS = 'Reviewer2, carol';
        const game = await listedDemoGame();
        enter('s-review', 'test1');
        enter('s-r2', 'REVIEWER2');
        enter('s-carol', 'Carol');
        expect(lastJoined('s-review').inProgressGames).toEqual([]);
        expect(ids(lastJoined('s-r2').inProgressGames)).toEqual([game.gameId]);
        expect(ids(lastJoined('s-carol').inProgressGames)).toEqual([game.gameId]);
        log.length = 0;
        expect(gameLifecycle.emitLobbiesUpdated(io).sort()).toEqual(['s-carol', 's-r2']);
        expect(lastTo('lobbiesUpdated', 's-review').inProgressGames).toEqual([]);
    });
});

describe('demand: only the audience starts or keeps the game', () => {
    beforeEach(() => jest.useFakeTimers());
    const demoGames = () => [...gameManager.games.values()].filter((g) => g.isDemo && !g.isTerminal());

    test('default: other players in the main room start nothing; test1 entering starts it', async () => {
        ambient.startAmbientActivity(io);
        enter('s-alice', 'alice');
        enter('s-bob', 'BOB');
        await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
        expect(demoGames()).toHaveLength(0);
        expect(ambient.someoneWatching()).toBe(false);
        expect(ambient.inDemand()).toBe(false);

        enter('s-review', 'Test1');
        expect(ambient.someoneWatching()).toBe(true);
        await jest.advanceTimersByTimeAsync(1000);
        expect(demoGames()).toHaveLength(1);
        expect(ids(lastTo('lobbiesUpdated', 's-review')?.inProgressGames || [])).toEqual([demoGames()[0].gameId]);
    });

    test('test1 already in the main room when the activity starts: it starts at once', async () => {
        enter('s-review', 'test1');
        ambient.startAmbientActivity(io);
        await jest.advanceTimersByTimeAsync(1000);
        expect(demoGames()).toHaveLength(1);
    });

    test('test1 leaves: alice alone is no demand; the running game plays out and none follows', async () => {
        ambient.startAmbientActivity(io);
        enter('s-alice', 'alice');
        enter('s-review', 'test1');
        await jest.advanceTimersByTimeAsync(1000);
        const [first] = demoGames();
        gameManager.leaveMainRoom('s-review');
        const P = pacing();
        jest.setSystemTime(Date.now() + P.AMBIENT_IDLE_MS + 60000);
        await jest.advanceTimersByTimeAsync(P.AMBIENT_CHECK_MS * 2);
        expect(ambient.inDemand()).toBe(false);
        expect(first.isTerminal()).toBe(false); // idleness never aborts
        gameManager.endGame(first.gameId, io);
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(demoGames()).toHaveLength(0);
        // alice coming back in wakes nothing
        enter('s-alice2', 'alice');
        await jest.advanceTimersByTimeAsync(60 * 1000);
        expect(demoGames()).toHaveLength(0);
    });

    test('noteMainRoomJoin counts only an audience socket', () => {
        gameManager.registerUser('s-alice', 'alice');
        gameManager.registerUser('s-review', 'test1');
        ambient.noteMainRoomJoin('s-alice');
        expect(ambient.inDemand()).toBe(false);
        ambient.noteMainRoomJoin('s-unknown');
        expect(ambient.inDemand()).toBe(false);
        ambient.noteMainRoomJoin('s-review');
        expect(ambient.inDemand()).toBe(true);
    });

    test('none: not even test1 starts it', async () => {
        process.env.AMBIENT_CHAT_USERS = 'none';
        ambient.startAmbientActivity(io);
        enter('s-review', 'test1');
        enter('s-alice', 'alice');
        await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
        expect(demoGames()).toHaveLength(0);
    });

    test('*: anyone starts it, as before', async () => {
        process.env.AMBIENT_CHAT_USERS = '*';
        ambient.startAmbientActivity(io);
        enter('s-alice', 'alice');
        await jest.advanceTimersByTimeAsync(1000);
        expect(demoGames()).toHaveLength(1);
    });
});

describe('spectating and rejoining: an unknown game for everyone else', () => {
    beforeEach(() => jest.useFakeTimers());
    const replyTo = (id, event) => lastTo(event, `self:${id}`);

    test('joinAsSpectator: alice gets exactly the unknown-game reply; test1 watches', async () => {
        const game = await listedDemoGame();
        const alice = enter('s-alice', 'alice');
        const review = enter('s-review', 'test1');

        log.length = 0;
        mainRoomHandlers.joinAsSpectator(alice, io, { gameId: crypto.randomUUID() });
        const unknown = replyTo('s-alice', 'serverError');
        log.length = 0;
        mainRoomHandlers.joinAsSpectator(alice, io, { gameId: game.gameId });
        const demo = replyTo('s-alice', 'serverError');
        expect(unknown).toBeDefined();
        expect(demo).toEqual(unknown);
        expect(log.map((l) => l.event)).toEqual(['serverError']);
        expect(game.spectators.has('s-alice')).toBe(false);
        expect(gameManager.isInMainRoom('s-alice')).toBe(true);

        log.length = 0;
        mainRoomHandlers.joinAsSpectator(review, io, { gameId: game.gameId });
        expect(replyTo('s-review', 'serverError')).toBeUndefined();
        expect(game.spectators.has('s-review')).toBe(true);
    });

    test('*: alice may watch it again', async () => {
        process.env.AMBIENT_CHAT_USERS = '*';
        const game = await listedDemoGame();
        const alice = enter('s-alice', 'alice');
        mainRoomHandlers.joinAsSpectator(alice, io, { gameId: game.gameId });
        expect(game.spectators.has('s-alice')).toBe(true);
    });

    test('spectateTournamentGame (any game id) refuses it the same way', async () => {
        const game = await listedDemoGame();
        const alice = enter('s-alice', 'alice');
        log.length = 0;
        tournamentHandlers.spectateTournamentGame(alice, io, { gameId: crypto.randomUUID() });
        const unknown = replyTo('s-alice', 'serverError');
        log.length = 0;
        tournamentHandlers.spectateTournamentGame(alice, io, { gameId: game.gameId });
        expect(replyTo('s-alice', 'serverError')).toEqual(unknown);
        expect(game.spectators.has('s-alice')).toBe(false);
    });

    test('rejoinGame: alice hears "no longer exists", as for an unknown id', async () => {
        const game = await listedDemoGame();
        const alice = enter('s-alice', 'alice');
        const review = enter('s-review', 'test1');
        log.length = 0;
        await reconnectHandlers.rejoinGame(alice, io, { gameId: crypto.randomUUID(), username: 'alice' });
        const unknown = replyTo('s-alice', 'rejoinFailed');
        log.length = 0;
        await reconnectHandlers.rejoinGame(alice, io, { gameId: game.gameId, username: 'alice' });
        expect(replyTo('s-alice', 'rejoinFailed')).toEqual(unknown);
        expect(unknown).toEqual({ reason: 'Game no longer exists' });
        // test1 is told it is not a player there, as before
        await reconnectHandlers.rejoinGame(review, io, { gameId: game.gameId, username: 'test1' });
        expect(replyTo('s-review', 'rejoinFailed')).toEqual({ reason: 'Not a player in this game' });
    });
});

describe('a full cycle never shows alice the game', () => {
    test('start -> listed -> lobbies come and go -> spectated by test1 -> ends: no payload to alice carries its id', async () => {
        jest.useFakeTimers();
        pacing.setPacingForTests('zero');
        // Demo games follow one another through the 60 s steps below (about
        // 20,000 bot plays). What the bots play is not this test's subject, so
        // their endgame search is off here: with it on the test needs ~2 min.
        require('../../game/bot/playSearch').SEARCH.maxCards = 0;
        ambient.startAmbientActivity(io);
        const alice = enter('s-alice', 'alice');
        const bob = enter('s-bob', 'bob');
        const review = enter('s-review', 'test1');
        const watcher = enter('s-watch', 'TEST1'); // a second test1 device that will spectate

        let game = null;
        for (let t = 0; t < 200 && !game; t++) {
            await jest.advanceTimersByTimeAsync(50);
            game = [...gameManager.games.values()].find((g) => g.isDemo) || null;
        }
        expect(game).not.toBeNull();
        const gameId = game.gameId;
        for (let t = 0; t < 600 && game.phase === 'drawing'; t++) await jest.advanceTimersByTimeAsync(50);

        // Main-room traffic while it runs: lobbies made and left, a re-join
        mainRoomHandlers.createLobby(bob, io, {});
        lobbyHandlers.leaveLobby(bob, io);
        mainRoomHandlers.joinMainRoom(alice, io);
        mainRoomHandlers.joinAsSpectator(watcher, io, { gameId });
        expect(game.spectators.has('s-watch')).toBe(true);
        mainRoomHandlers.joinAsSpectator(alice, io, { gameId }); // refused
        mainRoomHandlers.createLobby(alice, io, {});
        lobbyHandlers.leaveLobby(alice, io);

        for (let t = 0; t < 120 && gameManager.getGameById(gameId); t++) await jest.advanceTimersByTimeAsync(60000);
        expect(gameManager.getGameById(gameId)).toBeNull();
        expect(log.some((l) => l.event === 'gameEnd' && l.to === `game:${gameId}`)).toBe(true);
        ambient.stopAmbientActivity();

        // test1 saw it (listed, live)
        const reviewSaw = reaching('s-review', ['mainRoom']).filter((l) => JSON.stringify(l.data).includes(gameId));
        expect(reviewSaw.some((l) => l.event === 'lobbiesUpdated')).toBe(true);

        // alice and bob: never, in any payload, from any emit that reached them
        for (const id of ['s-alice', 's-bob']) {
            const got = reaching(id, ['mainRoom']);
            expect(got.length).toBeGreaterThan(5);
            const leaks = got.filter((l) => JSON.stringify(l.data ?? null).includes(gameId));
            expect([id, leaks]).toEqual([id, []]);
        }
        // and no main-room broadcast ever carried it
        expect(log.filter((l) => l.to === 'mainRoom' && JSON.stringify(l.data ?? null).includes(gameId))).toEqual([]);
        void review;
    }, 120000);
});
