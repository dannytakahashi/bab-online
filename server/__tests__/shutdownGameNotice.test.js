/**
 * The deploy notice for players at a table (server/utils/shutdown.js
 * noticeGames): before serverShutdown, every live game gets one system line
 * in its game log ("interrupted by a server update"), sent as the existing
 * gameLogEntry room broadcast, which web and iOS 1.2.0 already show. Ended
 * games are skipped, and one broken game never stops the others or the
 * shutdown (exit codes unchanged: shutdownExitCodes.test.js).
 */

const http = require('http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const GameState = require('../game/GameState');
const { Phase } = require('../game/GamePhase');
const { makeIo, events } = require('../testUtils/gameDriver');
const { logger } = require('../utils/logger');
const { noticeGames, GAME_NOTICE, setupGracefulShutdown } = require('../utils/shutdown');

const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];

describe('noticeGames', () => {
    beforeEach(() => {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(logger, m).mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    test('one sequenced gameLogEntry per live game, also kept in its log; ended games skipped', () => {
        const log = [];
        const io = makeIo(log);
        const live = new GameState('g-live');
        const other = new GameState('g-other');
        const ended = new GameState('g-ended');
        ended.terminate(io, Phase.ABORTED);
        log.length = 0;

        expect(noticeGames(io, () => [live, ended, other])).toBe(2);
        const lines = events(log, 'gameLogEntry');
        expect(lines.map((l) => l.to)).toEqual(['game:g-live', 'game:g-other']);
        for (const l of lines) {
            expect(l.data).toEqual({ message: GAME_NOTICE, type: 'system', seq: expect.any(Number) });
        }
        expect(live.getGameLog().at(-1)).toMatchObject({ message: GAME_NOTICE, type: 'system', playerPosition: null });
        expect(ended.getGameLog().some((e) => e.message === GAME_NOTICE)).toBe(false);
        expect(GAME_NOTICE).toBe("This game was interrupted by a server update. It won't count toward stats.");
    });

    test('a game that throws is logged and the rest are still told', () => {
        const log = [];
        const io = makeIo(log);
        const broken = { gameId: 'g-broken', isTerminal: () => false, addLogEntry: () => { throw new Error('half built'); } };
        const fine = new GameState('g-fine');
        expect(noticeGames(io, () => [broken, fine])).toBe(1);
        expect(events(log, 'gameLogEntry').map((l) => l.to)).toEqual(['game:g-fine']);
        expect(logger.error).toHaveBeenCalledWith('Shutdown notice to a game failed', expect.objectContaining({ gameId: 'g-broken' }));
    });
});

describe('the deploy notice over a real Socket.IO server', () => {
    let before;
    let exit;
    let server;
    let io;
    let clients;

    beforeEach(() => {
        before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
        exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(logger, m).mockImplementation(() => {});
        clients = [];
    });

    afterEach(async () => {
        for (const c of clients) c.close();
        io?.close();
        await new Promise((resolve) => server.close(() => resolve()));
        for (const s of SIGNALS) {
            for (const fn of process.listeners(s)) if (!before[s].includes(fn)) process.removeListener(s, fn);
        }
        jest.restoreAllMocks();
    });

    test('a player at a table reads the line, then serverShutdown, then the transport close; the main room only the notice', async () => {
        server = http.createServer();
        io = new Server(server);
        const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
        const game = new GameState('g1');
        // the first socket to connect sits at the table
        let seated = false;
        io.on('connection', (socket) => {
            if (!seated) { seated = true; socket.join(game.roomName); }
        });
        const handlers = setupGracefulShutdown(server, io, { games: () => [game], noticeMs: 200, settleMs: 50 });
        expect(typeof handlers.shutdown).toBe('function');

        const seen = { table: [], room: [] };
        const connect = (who) => new Promise((resolve) => {
            const c = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
            clients.push(c);
            c.on('connect', resolve);
            c.on('gameLogEntry', (d) => seen[who].push(['gameLogEntry', d.message]));
            c.on('serverShutdown', () => seen[who].push(['serverShutdown']));
            c.on('disconnect', (reason) => seen[who].push(['disconnect', reason]));
        });
        await connect('table');
        await connect('room');

        process.emit('SIGTERM');
        await new Promise((resolve) => {
            const poll = () => (exit.mock.calls.length ? resolve() : setTimeout(poll, 20));
            poll();
        });
        expect(exit).toHaveBeenCalledWith(0);
        expect(seen.table).toEqual([['gameLogEntry', GAME_NOTICE], ['serverShutdown'], ['disconnect', 'transport close']]);
        expect(seen.room).toEqual([['serverShutdown'], ['disconnect', 'transport close']]);
    }, 20000);
});
