/**
 * What a client sees of a deploy (V1_REMOVALS #17, kept 2026-11-11): the
 * real gracefulShutdown (server/utils/shutdown.js, SIGTERM) on a real
 * Socket.IO server. The web client's restart notice relies on three facts
 * checked here: every socket gets `serverShutdown {message}` before it is
 * closed; the close is a TRANSPORT close ('transport close'), not
 * 'io server disconnect' (after which Socket.IO never reconnects); and the
 * client reconnects by itself to the server started again on the same port.
 */

const http = require('http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { logger } = require('../utils/logger');

const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];

function listen(server, port = 0) {
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

function waitFor(predicate, ms = 8000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
            if (predicate()) return resolve();
            if (Date.now() - started > ms) return reject(new Error('timed out'));
            setTimeout(poll, 20);
        };
        poll();
    });
}

describe('gracefulShutdown over a real Socket.IO server', () => {
    let before;
    let exit;
    let servers;
    let clients;

    beforeEach(() => {
        before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
        exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
        for (const m of ['info', 'warn', 'debug']) jest.spyOn(logger, m).mockImplementation(() => {});
        servers = [];
        clients = [];
    });

    afterEach(async () => {
        for (const c of clients) c.close();
        for (const { io, server } of servers) {
            io.close();
            await new Promise((resolve) => server.close(() => resolve()));
        }
        // only the listeners this test added
        for (const s of SIGNALS) {
            for (const fn of process.listeners(s)) if (!before[s].includes(fn)) process.removeListener(s, fn);
        }
        jest.restoreAllMocks();
    });

    function startServer(port) {
        const server = http.createServer();
        const io = new Server(server);
        servers.push({ server, io });
        return listen(server, port).then((p) => ({ server, io, port: p }));
    }

    test('SIGTERM: serverShutdown first, then a transport close; the client reconnects to the restarted server', async () => {
        const first = await startServer();
        let setupGracefulShutdown;
        jest.isolateModules(() => {
            const isolated = require('../utils/logger').logger;
            for (const m of ['info', 'warn', 'debug']) jest.spyOn(isolated, m).mockImplementation(() => {});
            ({ setupGracefulShutdown } = require('../utils/shutdown'));
        });
        setupGracefulShutdown(first.server, first.io);

        const seen = [];
        // A current iOS User-Agent (URLSession's form, 1.2.0 build 6) and a browser: same treatment
        const ua = ['BAB%20Online/6 CFNetwork/1568.100.1 Darwin/24.0.0', 'Mozilla/5.0 (Macintosh) test'];
        for (const userAgent of ua) {
            const c = ioClient(`http://127.0.0.1:${first.port}`, {
                transports: ['websocket'], reconnectionDelay: 100, reconnectionDelayMax: 200,
                extraHeaders: { 'User-Agent': userAgent },
            });
            clients.push(c);
            c.on('connect', () => seen.push([userAgent, 'connect']));
            c.on('serverShutdown', (data) => seen.push([userAgent, 'serverShutdown', data]));
            c.on('disconnect', (reason) => seen.push([userAgent, 'disconnect', reason]));
        }
        await waitFor(() => clients.every((c) => c.connected));

        process.emit('SIGTERM');
        await waitFor(() => seen.filter(([, e]) => e === 'disconnect').length === 2);
        for (const userAgent of ua) {
            const mine = seen.filter(([u]) => u === userAgent).map(([, e, d]) => [e, d]);
            expect(mine).toEqual([
                ['connect', undefined],
                ['serverShutdown', { message: 'Server is restarting, please reconnect shortly' }],
                ['disconnect', 'transport close'],
            ]);
        }
        await waitFor(() => exit.mock.calls.length > 0);
        expect(exit).toHaveBeenCalledWith(0);

        // The new server on the same port: both clients come back by themselves
        await new Promise((resolve) => first.server.close(() => resolve()));
        await startServer(first.port);
        await waitFor(() => clients.every((c) => c.connected));
        for (const userAgent of ua) {
            expect(seen.filter(([u, e]) => u === userAgent && e === 'connect')).toHaveLength(2);
        }
    }, 20000);
});
